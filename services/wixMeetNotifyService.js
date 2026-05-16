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

  // Fetch sessions that were just upserted and still lack a Meet link
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select('id, wix_booking_id, client_id, psychologist_id, scheduled_date, scheduled_time, status, session_type, package_id, google_meet_link, wix_payload, source, price, amount')
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
  const clientPhone = clientDetails.phone_number;


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

  let meetResult = { success: false, meetLink: null };

  if (DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING) {
    console.log(`${LOG_PREFIX} Google Meet auto-scheduling temporarily disabled for session ${session.id}`);
  } else {
    // --- SAFE TESTING FILTER ---
    // Only process bookings for your test email to avoid overlapping with Zapier for real clients.
    const testEmail = 'abhishekravi063@gmail.com';
    const currentClientEmail = session.wix_payload?.contactDetails?.email || session.wix_payload?.email || clientEmail;

    if (currentClientEmail !== testEmail) {
      console.log(`${LOG_PREFIX} Skipping session ${session.id} - Not a test email (${currentClientEmail}).`);
      return 'skipped';
    }
    // ----------------------------

    console.log(`${LOG_PREFIX} Processing TEST session for ${currentClientEmail}...`);

    meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);

    // ── Save Meet link to session ─────────────────────────────────────────
    const masterFallback = process.env.MASTER_FALLBACK_MEET_LINK || 'https://meet.google.com/ovr-qpsi-mwr';
    const finalMeetLink = meetResult.meetLink || session.google_meet_link || masterFallback;

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
    const meetLink = meetResult.meetLink || session.google_meet_link || process.env.MASTER_FALLBACK_MEET_LINK;
    
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

    // Send WhatsApp confirmation
    const whatsappDetails = {
      clientName: clientName,
      psychologistName: psychologistName,
      date: session.scheduled_date,
      time: session.scheduled_time,
      meetLink: meetResult.meetLink || session.google_meet_link,
    };
    
    if (clientPhone) {
      await interaktService.sendBookingConfirmation(clientPhone, whatsappDetails);
      console.log(`${LOG_PREFIX} ✅ WhatsApp confirmation sent to ${clientPhone}`);
    }

  } catch (notifyErr) {
    console.error(`${LOG_PREFIX} ❌ notification error for session ${session.id}:`, notifyErr.message || notifyErr);
  }

  return 'processed';
}

module.exports = { processNewWixSessions };
