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

const LOG_PREFIX = '[wixMeetNotify]';


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
  // TEMPORARY: disable auto Google Meet scheduling for Wix-created bookings.
  const DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING = true;

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

  if (DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING) {
    console.log(`${LOG_PREFIX} Google Meet auto-scheduling temporarily disabled for session ${session.id}`);
  } else {
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
  }

  // TEMPORARY: Disable all auto booking notifications for Wix-created sessions.
  // (email + WhatsApp to client/psychologist)
  console.log(`${LOG_PREFIX} notifications temporarily disabled for session ${session.id}`);

  return 'processed';
}

module.exports = { processNewWixSessions };
