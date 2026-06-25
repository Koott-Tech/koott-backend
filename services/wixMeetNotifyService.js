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
const emailService = require('../utils/emailService');
const interaktService = require('../utils/interaktService');
const {
  buildKoottSessionDescription,
  buildKoottSessionTitle,
  getClientDisplayName,
  getPsychologistDisplayName,
} = require('../utils/sessionTitleFormatter');

const LOG_PREFIX = '[wixMeetNotify]';

/**
 * Process newly upserted Wix sessions that don't yet have a Google Meet link.
 *
 * @param {string[]} wixBookingIds – the wix_booking_id values just upserted
 * @param {Map} tempPasswordMap – Map of wix_booking_id to temporary password
 * @returns {Promise<{processed: number, skipped: number, errors: number}>}
 */
async function processNewWixSessions(wixBookingIds, tempPasswordMap = new Map()) {
  if (!wixBookingIds?.length) {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  // Fetch sessions that were just upserted and haven't been fully notified yet.
  // notified_at IS NULL is the authoritative "not yet done" flag — covers the case
  // where GMeet saved but email/WhatsApp crashed before notifications went out.
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select('id, wix_booking_id, client_id, psychologist_id, scheduled_date, scheduled_time, status, session_type, package_id, google_meet_link, google_calendar_event_id, notified_at, wix_payload, source, price, amount')
    .in('wix_booking_id', wixBookingIds)
    .is('notified_at', null)
    .eq('status', 'booked'); // Only notify confirmed bookings — not 'pending' (pre-payment / UNDEFINED from Wix)

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
      const tempPassword = tempPasswordMap.get(session.wix_booking_id) || null;
      const result = await processOneSession(session, tempPassword);
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
async function processOneSession(session, tempPassword = null) {
  // TEMPORARY: disable auto Google Meet scheduling for Wix-created bookings.
  const DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING = false;

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

  // Already fully processed
  if (session.notified_at) {
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
  const clientName = getClientDisplayName(clientDetails, 'Client');
  const psychologistName = getPsychologistDisplayName(psychologistDetails, 'Therapist');

  // Normalize client email (Supabase can return user relation as object or array)
  const clientUserData = Array.isArray(clientDetails.user)
    ? clientDetails.user?.[0]
    : clientDetails.user;
  const clientEmail = clientUserData?.email;
  const clientPhone = clientDetails.phone_number;

  // ── Duration ──────────────────────────────────────────────────────────
  // 1. Compute from actual Wix start/end times — ground truth for every session type.
  //    Wix creates 80-min slots for couple, 50-min for individual, etc.
  // 2. Fall back to session_type defaults if Wix times are missing.
  let meetDurationMinutes = 50;
  const wp = session.wix_payload || {};
  const wixStart = wp.startTime || wp.rawBookedEntity?.singleSession?.start || null;
  const wixEnd   = wp.endTime   || wp.rawBookedEntity?.singleSession?.end   || null;
  if (wixStart && wixEnd) {
    const computed = Math.round((new Date(wixEnd) - new Date(wixStart)) / 60000);
    if (computed > 0) meetDurationMinutes = computed;
  } else {
    // Session-type defaults when Wix times are unavailable
    const typeDefaults = { couple: 80, assessment: 30, discovery: 30, individual: 50 };
    meetDurationMinutes = typeDefaults[session.session_type] || resolveSessionDurationMinutes({
      packageInfo: session.package_id ? { packageType: session.session_type } : null,
    }) || 50;
  }

  const endTime = addMinutesToTime(session.scheduled_time || '00:00', meetDurationMinutes);

  // ── Create Google Meet link ───────────────────────────────────────────
  // oauth_email = the Google account the therapist authorised (may differ from psychologists.email)
  // calendarOwnerEmail tells meetLinkService which account NOT to double-add as attendee.
  const oauthEmail = psychologistDetails.google_calendar_credentials?.oauth_email || null;

  const meetSessionData = {
    summary: buildKoottSessionTitle({ clientName, psychologistName }),
    description: buildKoottSessionDescription({
      clientName,
      psychologistName,
      clientPhone,
    }),
    startDate: session.scheduled_date,
    startTime: session.scheduled_time,
    endTime,
    clientEmail: clientEmail || null,
    psychologistEmail: psychologistDetails.email || null,
    // If the OAuth account differs from the notification email, tell meetLinkService
    // to treat the OAuth account as the calendar owner so the notification email
    // gets added as a proper attendee and receives the calendar invite.
    calendarOwnerEmail: oauthEmail || psychologistDetails.email || null,
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

  // ── ATOMIC CLAIM ──────────────────────────────────────────────────────
  // processNewWixSessions runs from several triggers (realtime sync, interval sync,
  // enrichment). Two near-simultaneous runs both fetched this session with
  // notified_at = null and each created its own Google Meet event → the client got
  // TWO calendar invites / Meet links. Claim the session atomically here (after all
  // the "skip" checks so a transient fetch error can't leave it stuck): conditionally
  // stamp notified_at only if still null; if another run already claimed it, skip.
  // (Meet creation below is also guarded by google_calendar_event_id, so a retry
  // never duplicates the event.)
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('sessions')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', session.id)
    .is('notified_at', null)
    .select('id')
    .maybeSingle();
  if (claimErr || !claimed) {
    console.log(`${LOG_PREFIX} session ${session.id} already claimed/processed by a concurrent run — skipping`);
    return 'skipped';
  }

  let meetResult = { success: false, meetLink: null };
  const masterFallback = process.env.MASTER_FALLBACK_MEET_LINK || 'https://meet.google.com/ovr-qpsi-mwr';
  let finalMeetLink = session.google_meet_link || masterFallback;

  if (DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING) {
    console.log(`${LOG_PREFIX} Google Meet auto-scheduling temporarily disabled for session ${session.id}`);
  } else if (session.google_calendar_event_id) {
    // IDEMPOTENT: a calendar event already exists for this session — reuse its link,
    // never create a second one (prevents duplicate Meet links to the client).
    finalMeetLink = session.google_meet_link || finalMeetLink;
    console.log(`${LOG_PREFIX} session ${session.id} already has calendar event ${session.google_calendar_event_id} — skipping Meet creation`);
  } else {
    console.log(`${LOG_PREFIX} Processing session ${session.id} for ${clientEmail}...`);

    meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);

    // ── Save Meet link to session ─────────────────────────────────────────
    finalMeetLink = meetResult.meetLink || session.google_meet_link || masterFallback;

    // Try full update first; fall back to just google_meet_link if extra columns don't exist
    let { error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({
        google_meet_link: finalMeetLink,
        google_meet_join_url: finalMeetLink,
        google_meet_start_url: finalMeetLink,
        google_calendar_event_id: meetResult.eventId || null,
      })
      .eq('id', session.id);

    if (updateError && updateError.message && updateError.message.includes('column')) {
      ({ error: updateError } = await supabaseAdmin
        .from('sessions')
        .update({ google_meet_link: finalMeetLink })
        .eq('id', session.id));
    }

    if (!updateError) {
      console.log(`${LOG_PREFIX} ✅ Session updated for ${session.id} (Link: ${finalMeetLink === masterFallback ? 'MASTER FALLBACK' : 'Real Meet'})`);
    }
  }

  // ── Send Notifications ───────────────────────────────────────────────
  try {
    const meetLink = finalMeetLink;
    
    if (!meetLink) {
      console.log(`${LOG_PREFIX} Skipping notifications for ${session.id} - No meet link available.`);
      return 'processed';
    }

    const emailData = {
      sessionId: session.id,
      clientName: clientName,
      psychologistName: psychologistName,
      clientEmail: clientEmail,
      psychologistEmail: psychologistDetails.email,
      sessionDate: session.scheduled_date,
      sessionTime: session.scheduled_time,
      durationMinutes: meetDurationMinutes,
      meetLink: meetLink,
      price: session.price ?? session.amount,
      status: session.status,
      psychologistId: session.psychologist_id,
      clientId: session.client_id,
      tempPassword: tempPassword,
    };

    // Send the combined confirmation email
    await emailService.sendSessionConfirmation(emailData);
    console.log(`${LOG_PREFIX} ✅ Combined confirmation email sent to ${clientEmail}`);

    // ── Mark fully processed — interval sync will skip this session from now on ──
    // Stamped immediately after email succeeds. WhatsApp is fire-and-forget below.
    const { error: flagErr } = await supabaseAdmin
      .from('sessions')
      .update({ notified_at: new Date().toISOString() })
      .eq('id', session.id);

    if (flagErr) {
      console.warn(`${LOG_PREFIX} ⚠️ could not set notified_at for session ${session.id}:`, flagErr.message);
    } else {
      console.log(`${LOG_PREFIX} ✅ notified_at stamped for session ${session.id}`);
    }

    // Send WhatsApp confirmation — best-effort, never blocks notified_at
    if (clientPhone) {
      interaktService.sendBookingConfirmation(clientPhone, {
        clientName: clientName,
        psychologistName: psychologistName,
        date: session.scheduled_date,
        time: session.scheduled_time,
        meetLink: meetLink,
      }).then(() => {
        console.log(`${LOG_PREFIX} ✅ WhatsApp booking_confirmation_v1 sent to client ${clientPhone.slice(0, 6)}****`);
      }).catch(err => {
        console.warn(`${LOG_PREFIX} ⚠️ Client WhatsApp failed for session ${session.id} (non-blocking):`, err.message || err);
      });
    }

    // Send WhatsApp notification to therapist — best-effort
    const therapistPhone = psychologistDetails.phone || null;
    if (therapistPhone) {
      interaktService.sendSessionNotificationPsychologist(therapistPhone, {
        therapistName: psychologistName,
        clientName: clientName,
        date: session.scheduled_date,
        time: session.scheduled_time,
        meetLink: meetLink,
      }).then(() => {
        console.log(`${LOG_PREFIX} ✅ WhatsApp therapistconfirmation sent to therapist ${therapistPhone.slice(0, 6)}****`);
      }).catch(err => {
        console.warn(`${LOG_PREFIX} ⚠️ Therapist WhatsApp failed for session ${session.id} (non-blocking):`, err.message || err);
      });
    } else {
      console.log(`${LOG_PREFIX} ℹ️ No therapist phone for session ${session.id} — skipping therapist WhatsApp`);
    }

  } catch (notifyErr) {
    console.error(`${LOG_PREFIX} ❌ notification error for session ${session.id}:`, notifyErr.message || notifyErr);
    // Release the claim so a later sync retries notifications. Safe to retry now:
    // Meet creation is guarded by google_calendar_event_id, so the retry reuses the
    // existing event instead of creating a duplicate.
    await supabaseAdmin.from('sessions').update({ notified_at: null }).eq('id', session.id)
      .then(() => {}, () => {});
  }

  return 'processed';
}

module.exports = { processNewWixSessions, processOneSession };
