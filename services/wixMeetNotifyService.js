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

// Where delivery-failure alerts are sent.
const NOTIFY_FAILURE_ALERT_EMAIL = process.env.NOTIFY_FAILURE_ALERT_EMAIL || 'abhishekravi063@gmail.com';

// The per-channel marker columns (email_sent_at / whatsapp_sent_at / *_error /
// notification_alert_sent) are added by migration 20260709_notification_channel_markers.sql.
// Until that migration runs, gracefully no-op the marker writes so notifications still work.
// Cached after the first probe so we don't check every call.
let _markersAvailable = null;
async function markersAvailable() {
  if (_markersAvailable !== null) return _markersAvailable;
  const { error } = await supabaseAdmin.from('sessions').select('email_sent_at').limit(1);
  _markersAvailable = !(error && /column .*email_sent_at.* does not exist/i.test(error.message || ''));
  if (!_markersAvailable) {
    console.warn(`${LOG_PREFIX} notification marker columns not found — run migration 20260709_notification_channel_markers.sql to enable per-channel tracking + failure alerts`);
  }
  return _markersAvailable;
}

// Best-effort write of a delivery marker; never throws into the notify flow.
async function writeMarker(sessionId, updates) {
  if (!(await markersAvailable())) return;
  const { error } = await supabaseAdmin.from('sessions').update(updates).eq('id', sessionId);
  if (error) console.warn(`${LOG_PREFIX} marker write failed for ${sessionId}:`, error.message);
}

// Emails a delivery-failure alert to the ops address — once per session (guarded by
// notification_alert_sent so retries don't spam). channel = 'Email' | 'WhatsApp'.
async function alertDeliveryFailure(channel, session, recipient, errorMsg, ctx = {}) {
  try {
    if (!(await markersAvailable())) return; // dedup needs the column; skip until migrated
    const { data: cur } = await supabaseAdmin
      .from('sessions').select('notification_alert_sent').eq('id', session.id).maybeSingle();
    if (cur?.notification_alert_sent) return; // already alerted for this session

    const subject = `⚠️ Koott: ${channel} confirmation FAILED — ${ctx.clientName || 'client'}`;
    const html = `
      <h2>${channel} confirmation did not send</h2>
      <table cellpadding="6" style="border-collapse:collapse">
        <tr><td><b>Channel</b></td><td>${channel}</td></tr>
        <tr><td><b>Recipient</b></td><td>${recipient || '(none on record — wrong/missing contact)'}</td></tr>
        <tr><td><b>Reason</b></td><td>${errorMsg || 'unknown'}</td></tr>
        <tr><td><b>Client</b></td><td>${ctx.clientName || '-'}</td></tr>
        <tr><td><b>Therapist</b></td><td>${ctx.psychologistName || '-'}</td></tr>
        <tr><td><b>Session</b></td><td>${session.scheduled_date} ${session.scheduled_time}</td></tr>
        <tr><td><b>Session ID</b></td><td>${session.id}</td></tr>
        <tr><td><b>Wix booking</b></td><td>${session.wix_booking_id || '-'}</td></tr>
      </table>
      <p>Fix the client's ${channel === 'WhatsApp' ? 'phone number' : 'email'} and it will retry automatically on the next sync.</p>`;
    await emailService.sendEmail({ to: NOTIFY_FAILURE_ALERT_EMAIL, subject, html });
    await supabaseAdmin.from('sessions').update({ notification_alert_sent: true }).eq('id', session.id);
    console.log(`${LOG_PREFIX} 📨 ${channel} failure alert sent to ${NOTIFY_FAILURE_ALERT_EMAIL} for session ${session.id}`);
  } catch (e) {
    console.error(`${LOG_PREFIX} could not send ${channel} failure alert for ${session.id}:`, e.message || e);
  }
}

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
      email,
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
  // Recipient resolution with fallbacks. The linked user email is preferred, but for
  // Wix-only clients it can be missing — fall back to the clients row and finally to the
  // contact info Wix sent on the booking payload, so a confirmation always has a target.
  const wixClient = (session.wix_payload && session.wix_payload.client) || {};
  const clientEmail = clientUserData?.email || clientDetails.email || wixClient.email || null;
  const clientPhone = clientDetails.phone_number || wixClient.phone || null;

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
          google_calendar_id: meetResult.calendarId || null,
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

    // Send the combined confirmation email and HONOUR its delivery result.
    const emailResult = await emailService.sendSessionConfirmation(emailData);
    const clientEmailDelivered = emailResult?.clientEmailSent === true;
    const hadRecipient = !!clientEmail;

    // ── Mark notified ONLY when the client confirmation actually went out ──
    // Previously notified_at was stamped unconditionally, so a swallowed send failure
    // marked the session "done" with nothing delivered. Now: stamp only on real delivery
    // (or when there's genuinely no recipient, to avoid an infinite retry loop). If we had
    // a recipient but the send failed, leave notified_at NULL so a later run retries — the
    // Meet is guarded by google_calendar_event_id, so the retry reuses the existing event.
    if (clientEmailDelivered) {
      await writeMarker(session.id, { email_sent_at: new Date().toISOString(), email_error: null });
      const { error: flagErr } = await supabaseAdmin
        .from('sessions')
        .update({ notified_at: new Date().toISOString() })
        .eq('id', session.id);
      if (flagErr) console.warn(`${LOG_PREFIX} ⚠️ could not set notified_at for session ${session.id}:`, flagErr.message);
      else console.log(`${LOG_PREFIX} ✅ client email delivered → notified_at stamped for ${session.id} (${clientEmail})`);
    } else if (!hadRecipient) {
      // Nothing to send to — record why, alert ops, and stamp notified to avoid infinite retry.
      await writeMarker(session.id, { email_error: 'no-recipient (no email on user/clients/Wix)' });
      await alertDeliveryFailure('Email', session, null, 'No client email on record (user/clients/Wix all empty)', { clientName, psychologistName });
      await supabaseAdmin.from('sessions').update({ notified_at: new Date().toISOString() }).eq('id', session.id);
      console.warn(`${LOG_PREFIX} ⚠️ session ${session.id}: NO client email even after Wix fallback — alerted + stamped notified`);
    } else {
      // Had a recipient but the send failed: record error, alert ops, leave UNNOTIFIED to retry.
      await writeMarker(session.id, { email_error: emailResult?.clientEmailError || 'send failed' });
      await alertDeliveryFailure('Email', session, clientEmail, emailResult?.clientEmailError, { clientName, psychologistName });
      await supabaseAdmin.from('sessions').update({ notified_at: null }).eq('id', session.id);
      console.error(`${LOG_PREFIX} ❌ session ${session.id}: client email NOT delivered to ${clientEmail} (${emailResult?.clientEmailError || 'unknown'}) — left UNNOTIFIED for retry`);
    }

    // Send WhatsApp confirmation — best-effort, never blocks notified_at. Marks whatsapp_sent_at
    // only on real success; on failure records the error and alerts ops.
    if (clientPhone) {
      interaktService.sendBookingConfirmation(clientPhone, {
        clientName: clientName,
        psychologistName: psychologistName,
        date: session.scheduled_date,
        time: session.scheduled_time,
        meetLink: meetLink,
      }).then(async () => {
        await writeMarker(session.id, { whatsapp_sent_at: new Date().toISOString(), whatsapp_error: null });
        console.log(`${LOG_PREFIX} ✅ WhatsApp booking_confirmation_v1 sent to client ${clientPhone.slice(0, 6)}****`);
      }).catch(async err => {
        const msg = err?.message || String(err);
        await writeMarker(session.id, { whatsapp_error: msg });
        await alertDeliveryFailure('WhatsApp', session, clientPhone, msg, { clientName, psychologistName });
        console.warn(`${LOG_PREFIX} ⚠️ Client WhatsApp failed for session ${session.id} (non-blocking):`, msg);
      });
    } else {
      await writeMarker(session.id, { whatsapp_error: 'no-recipient (no phone on clients/Wix)' });
      await alertDeliveryFailure('WhatsApp', session, null, 'No client phone on record (clients/Wix empty)', { clientName, psychologistName });
      console.warn(`${LOG_PREFIX} ⚠️ session ${session.id}: NO client phone — alerted, WhatsApp skipped`);
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

/**
 * Retry sweep for notifications that never completed — independent of the Wix sync's
 * createdAfter window. Without this, a session whose email/WhatsApp failed would only be
 * retried while its booking stays inside the rolling sync window (~hours), then be stuck
 * forever with notified_at NULL and nothing delivered. This re-attempts any still-pending
 * confirmation, bounded so it never rescans history:
 *   - status 'booked'      (confirmed, not pending/cancelled)
 *   - notified_at IS NULL  (not yet delivered)
 *   - future sessions only (no point notifying past ones)
 *   - created in the last 14 days (cap the backlog)
 * processOneSession's atomic claim + google_calendar_event_id guard make this safe to run
 * alongside the normal sync (no duplicate meets, no double emails).
 */
async function processPendingNotifications() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const sinceIso = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select('id, wix_booking_id, client_id, psychologist_id, scheduled_date, scheduled_time, status, session_type, package_id, google_meet_link, google_calendar_event_id, notified_at, wix_payload, source, price, amount')
    .is('notified_at', null)
    .eq('status', 'booked')
    .eq('source', 'wix')
    .gte('scheduled_date', todayIso)
    .gte('created_at', sinceIso)
    .limit(50);

  if (error) {
    console.error(`${LOG_PREFIX} pending-notification sweep fetch failed:`, error.message || error);
    return { processed: 0, errors: 1 };
  }
  if (!sessions?.length) return { processed: 0, errors: 0 };

  console.log(`${LOG_PREFIX} retrying ${sessions.length} pending notification(s)`);
  let processed = 0;
  let errors = 0;
  for (const session of sessions) {
    try {
      await processOneSession(session);
      processed++;
    } catch (err) {
      errors++;
      console.error(`${LOG_PREFIX} pending retry error for session ${session.id}:`, err.message || err);
    }
  }
  return { processed, errors };
}

module.exports = { processNewWixSessions, processOneSession, processPendingNotifications };
