/**
 * Wix Meet + Notify Service
 *
 * After Wix bookings are synced into the `sessions` table (source='wix'),
 * this service:
 *   1. Creates a Google Meet link using the therapist's email / OAuth creds
 *   2. Saves the Meet link into the sessions row
 *   3. Sends WhatsApp booking confirmation to the client (via Interakt)
 *   4. Sends WhatsApp notification to the psychologist (via Interakt)
 *
 * Replaces the Zapier automation. Uses Interakt for WhatsApp messaging.
 */

const { supabaseAdmin } = require('../config/supabase');
const meetLinkService = require('../utils/meetLinkService');
const { addMinutesToTime } = require('../utils/helpers');
const { resolveSessionDurationMinutes } = require('../utils/sessionMeetDuration');
const interakt = require('../utils/interaktService');
const emailService = require('../utils/emailService');

const LOG_PREFIX = '[wixMeetNotify]';

// Dashboard URL for login links (env override or sensible default)
const DASHBOARD_URL = process.env.FRONTEND_URL || 'https://koott.in';

/**
 * Process newly upserted Wix sessions that don't yet have a Google Meet link.
 *
 * @param {string[]} wixBookingIds – the wix_booking_id values just upserted
 * @returns {Promise<{processed: number, skipped: number, errors: number}>}
 */
async function processNewWixSessions(wixBookingIds) {
  if (!wixBookingIds?.length) {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  // Fetch sessions that were just upserted and still lack a Meet link
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select('id, wix_booking_id, client_id, psychologist_id, scheduled_date, scheduled_time, status, session_type, package_id, google_meet_link, wix_payload, source')
    .in('wix_booking_id', wixBookingIds)
    .is('google_meet_link', null);

  if (error) {
    console.error(`${LOG_PREFIX} failed to fetch sessions:`, error.message || error);
    return { processed: 0, skipped: 0, errors: 1 };
  }

  if (!sessions?.length) {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const session of sessions) {
    try {
      const result = await processOneSession(session);
      if (result === 'processed') processed++;
      else if (result === 'skipped') skipped++;
    } catch (err) {
      errors++;
      console.error(`${LOG_PREFIX} error processing session ${session.id}:`, err.message || err);
    }
  }

  console.log(`${LOG_PREFIX} done — processed: ${processed}, skipped: ${skipped}, errors: ${errors}`);
  return { processed, skipped, errors };
}

/**
 * Process a single Wix session: create Meet link + send notifications.
 * Returns 'processed' | 'skipped'.
 */
async function processOneSession(session) {
  // Skip cancelled sessions
  const status = String(session.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') {
    return 'skipped';
  }

  // Need both client_id and psychologist_id resolved before we can proceed
  if (!session.client_id || !session.psychologist_id) {
    console.warn(`${LOG_PREFIX} session ${session.id}: client_id or psychologist_id not yet resolved, skipping`);
    return 'skipped';
  }

  // Already has a meet link (double-check)
  if (session.google_meet_link) {
    return 'skipped';
  }

  // ── Fetch client details ──────────────────────────────────────────────
  const { data: clientDetails, error: clientError } = await supabaseAdmin
    .from('clients')
    .select(`
      id,
      first_name,
      last_name,
      child_name,
      phone_number,
      user:users(id, email, created_at)
    `)
    .eq('id', session.client_id)
    .single();

  if (clientError || !clientDetails) {
    console.warn(`${LOG_PREFIX} session ${session.id}: could not fetch client ${session.client_id}:`, clientError?.message);
    return 'skipped';
  }

  // ── Fetch psychologist details ────────────────────────────────────────
  const { data: psychologistDetails, error: psychError } = await supabaseAdmin
    .from('psychologists')
    .select('id, first_name, last_name, email, phone, google_calendar_credentials, created_at')
    .eq('id', session.psychologist_id)
    .single();

  if (psychError || !psychologistDetails) {
    console.warn(`${LOG_PREFIX} session ${session.id}: could not fetch psychologist ${session.psychologist_id}:`, psychError?.message);
    return 'skipped';
  }

  // ── Resolve names ─────────────────────────────────────────────────────
  let clientName = clientDetails.child_name;
  if (!clientName || clientName.trim() === '' || clientName.toLowerCase() === 'pending') {
    const firstName = clientDetails.first_name || '';
    const lastName = clientDetails.last_name || '';
    clientName = `${firstName} ${lastName}`.trim() || 'Client';
  }

  const psychologistName = `${psychologistDetails.first_name || ''} ${psychologistDetails.last_name || ''}`.trim() || 'Therapist';

  // Normalize client email (Supabase can return user relation as object or array)
  const clientUserData = Array.isArray(clientDetails.user)
    ? clientDetails.user?.[0]
    : clientDetails.user;
  const clientEmail = clientUserData?.email;

  // Detect newly created client account:
  // If user was created within the last 60 seconds, it's a new account
  const clientUserCreatedAt = clientUserData?.created_at;
  const isNewClientAccount = clientUserCreatedAt
    ? (Date.now() - new Date(clientUserCreatedAt).getTime()) < 60_000
    : false;

  // ── Duration ──────────────────────────────────────────────────────────
  const meetDurationMinutes = resolveSessionDurationMinutes({
    durationMinutes: null,
    sessionDuration: null,
    packageInfo: session.package_id ? { packageType: session.session_type } : null,
  }) || 50;

  const endTime = addMinutesToTime(session.scheduled_time || '00:00', meetDurationMinutes);

  // ── Create Google Meet link ───────────────────────────────────────────
  const meetSessionData = {
    summary: `Therapy Session - ${clientName} with ${psychologistDetails.first_name || 'Therapist'}`,
    description: `Online therapy session between ${clientName} and ${psychologistName}`,
    startDate: session.scheduled_date,
    startTime: session.scheduled_time,
    endTime,
    clientEmail: clientEmail || null,
    psychologistEmail: psychologistDetails.email || null,
  };

  // Use psychologist OAuth credentials if available
  let userAuth = null;
  if (psychologistDetails.google_calendar_credentials) {
    const creds = psychologistDetails.google_calendar_credentials;
    userAuth = {
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expiry_date: creds.expiry_date,
    };
  }

  console.log(`${LOG_PREFIX} creating Meet link for session ${session.id} (wix: ${session.wix_booking_id})`);

  const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);

  // ── Save Meet link to session ─────────────────────────────────────────
  if (meetResult.success && meetResult.meetLink) {
    // Try full update first; fall back to just google_meet_link if extra columns don't exist
    let { error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({
        google_meet_link: meetResult.meetLink,
        google_meet_join_url: meetResult.meetLink,
        google_meet_start_url: meetResult.meetLink,
        google_calendar_event_id: meetResult.eventId || null,
      })
      .eq('id', session.id);

    // Fallback: if columns are missing, just save the meet link
    if (updateError && updateError.message && updateError.message.includes('column')) {
      console.warn(`${LOG_PREFIX} some columns missing, falling back to google_meet_link only`);
      ({ error: updateError } = await supabaseAdmin
        .from('sessions')
        .update({ google_meet_link: meetResult.meetLink })
        .eq('id', session.id));
    }

    if (updateError) {
      console.error(`${LOG_PREFIX} failed to save Meet link for session ${session.id}:`, updateError.message);
      // Still try to send notifications with the link we have
    } else {
      const method = meetResult.method || 'unknown';
      console.log(`${LOG_PREFIX} ✅ Meet link saved for session ${session.id}:`, {
        method,
        meetLink: meetResult.meetLink,
        hasOAuth: !!userAuth,
      });
    }
  } else {
    console.warn(`${LOG_PREFIX} ⚠️ Meet link creation failed for session ${session.id}:`, {
      error: meetResult.error,
      method: meetResult.method,
    });
    // Continue to send WhatsApp even without a real Meet link
  }

  const meetLink = meetResult.meetLink || null;

  // ── Send WhatsApp booking confirmation to client (via Interakt) ────────
  try {
    const clientPhone = clientDetails.phone_number || null;

    if (clientPhone) {
      const waDetails = {
        clientName,
        psychologistName,
        date: session.scheduled_date,
        time: session.scheduled_time,
        meetLink,
      };

      const clientWaResult = await interakt.sendBookingConfirmation(clientPhone, waDetails);
      if (clientWaResult?.success) {
        console.log(`${LOG_PREFIX} ✅ Interakt booking confirmation sent to client for session ${session.id}`);
      } else if (clientWaResult?.skipped) {
        console.log(`${LOG_PREFIX} ℹ️ Client WhatsApp skipped:`, clientWaResult.reason);
      } else {
        console.warn(`${LOG_PREFIX} ⚠️ Client WhatsApp failed:`, clientWaResult?.error || 'Unknown');
      }
    } else {
      console.log(`${LOG_PREFIX} ℹ️ No client phone for session ${session.id}; skipping client WhatsApp`);
    }
  } catch (waErr) {
    console.error(`${LOG_PREFIX} client WhatsApp error for session ${session.id}:`, waErr.message || waErr);
  }

  // ── Send welcome credentials to newly created client (via Interakt) ───
  if (isNewClientAccount && clientEmail) {
    try {
      const clientPhone = clientDetails.phone_number || null;

      if (clientPhone) {
        const localPart = clientEmail.split('@')[0] || 'user';
        const suffix = localPart.slice(0, 4).toLowerCase();
        const tempPassword = `Welcome@${suffix}`;

        const welcomeResult = await interakt.sendWelcomeClient(clientPhone, {
          email: clientEmail,
          tempPassword,
          loginUrl: `${DASHBOARD_URL}/login`,
        });
        if (welcomeResult?.success) {
          console.log(`${LOG_PREFIX} ✅ Interakt welcome credentials sent to client for session ${session.id}`);
        } else {
          console.warn(`${LOG_PREFIX} ⚠️ Client welcome message failed:`, welcomeResult?.error || 'Unknown');
        }
      }
    } catch (welcomeErr) {
      console.error(`${LOG_PREFIX} client welcome WhatsApp error:`, welcomeErr.message || welcomeErr);
    }
  }

  // ── Send WhatsApp session notification to psychologist (via Interakt) ─
  try {
    const psychologistPhone = psychologistDetails.phone || null;

    if (psychologistPhone && meetLink) {
      const notifResult = await interakt.sendSessionNotificationPsychologist(psychologistPhone, {
        clientName,
        date: session.scheduled_date,
        time: session.scheduled_time,
        durationMinutes: meetDurationMinutes,
        meetLink,
      });
      if (notifResult?.success) {
        console.log(`${LOG_PREFIX} ✅ Interakt session notification sent to psychologist for session ${session.id}`);
      } else if (notifResult?.skipped) {
        console.log(`${LOG_PREFIX} ℹ️ Psychologist WhatsApp skipped:`, notifResult.reason);
      } else {
        console.warn(`${LOG_PREFIX} ⚠️ Psychologist WhatsApp failed:`, notifResult?.error || 'Unknown');
      }
    } else {
      if (!psychologistPhone) {
        console.log(`${LOG_PREFIX} ℹ️ No psychologist phone for session ${session.id}; skipping psychologist WhatsApp`);
      }
      if (!meetLink) {
        console.log(`${LOG_PREFIX} ℹ️ No Meet link for session ${session.id}; skipping psychologist WhatsApp`);
      }
    }
  } catch (waErr) {
    console.error(`${LOG_PREFIX} psychologist WhatsApp error for session ${session.id}:`, waErr.message || waErr);
  }

  // ── Send Emails ────────────────────────────────────────────────────────
  try {
    // 1. Send Session Confirmation Email
    const sessionEmailData = {
      clientName,
      psychologistName,
      clientEmail: clientEmail || null,
      psychologistEmail: psychologistDetails.email || null,
      scheduledDate: session.scheduled_date,
      scheduledTime: session.scheduled_time,
      googleMeetLink: meetLink,
      sessionId: session.id,
      price: session.price,
      status: session.status,
      psychologistId: session.psychologist_id,
      clientId: session.client_id,
      session_type: session.session_type,
    };

    // sendSessionConfirmation handles sending to client, psychologist, and admin
    // Welcome email is sent by wixClientResolverService at account-creation time — not here.
    await emailService.sendSessionConfirmation(sessionEmailData);
    console.log(`${LOG_PREFIX} ✅ Session confirmation emails sent for session ${session.id}`);
  } catch (emailErr) {
    console.error(`${LOG_PREFIX} email sending error for session ${session.id}:`, emailErr.message || emailErr);
  }

  // ── Send welcome credentials to newly created psychologist (via Interakt) ─
  const psychCreatedAt = psychologistDetails.created_at;
  const isNewPsychAccount = psychCreatedAt
    ? (Date.now() - new Date(psychCreatedAt).getTime()) < 60_000
    : false;

  if (isNewPsychAccount && psychologistDetails.email && psychologistDetails.phone) {
    try {
      const localPart = psychologistDetails.email.split('@')[0] || 'user';
      const suffix = localPart.slice(0, 4).toLowerCase();
      const tempPassword = `Welcome@${suffix}`;

      const welcomeResult = await interakt.sendWelcomePsychologist(psychologistDetails.phone, {
        email: psychologistDetails.email,
        tempPassword,
        loginUrl: `${DASHBOARD_URL}/psychologist/login`,
      });
      if (welcomeResult?.success) {
        console.log(`${LOG_PREFIX} ✅ Interakt welcome credentials sent to psychologist for session ${session.id}`);
      } else {
        console.warn(`${LOG_PREFIX} ⚠️ Psychologist welcome message failed:`, welcomeResult?.error || 'Unknown');
      }

      // Welcome email sent by wixPsychologistResolverService at account-creation time — not here.
    } catch (welcomeErr) {
      console.error(`${LOG_PREFIX} psychologist welcome WhatsApp error:`, welcomeErr.message || welcomeErr);
    }
  }

  return 'processed';
}

module.exports = { processNewWixSessions };
