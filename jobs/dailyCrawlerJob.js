const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const EmailService = require('../utils/emailService');
const { regenerateSessionMeet } = require('../services/wixMeetNotifyService');

// First per-channel marker ever written — the moment 20260709_notification_channel_markers.sql
// landed. A session notified before this has null email_sent_at / whatsapp_sent_at by
// construction, not by failure, so those nulls must not be read as "never sent".
const CHANNEL_MARKERS_LIVE_AT = Date.parse('2026-07-09T00:00:00Z');

const startDailyCrawlerScheduler = () => {
  // Schedule to run at 12:00 AM every day in IST
  cron.schedule('0 0 * * *', async () => {
    console.log('🕒 Running Daily Missing Links Crawler...');
    
    try {
      // Get today's date in YYYY-MM-DD
      // Note: Because it runs at midnight IST, the local date in Asia/Kolkata is exactly "today"
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
      const today = formatter.format(new Date());

      const { data: sessions, error } = await supabaseAdmin
        .from('sessions')
        // email_sent_at / whatsapp_sent_at (+ their *_error columns) are written by
        // wixMeetNotifyService but nothing ever read them, so a client who never received
        // their Meet link by email or WhatsApp was never flagged. Now checked alongside the
        // calendar event.
        .select('id, client_id, psychologist_id, scheduled_time, status, google_calendar_event_id, google_meet_link, notified_at, email_sent_at, whatsapp_sent_at, email_error, whatsapp_error')
        .eq('scheduled_date', today)
        // Only ACTIVE bookings actually need a Meet link. Excludes cancelled, refunded,
        // on_hold, no_show, completed, deleted — those legitimately have none, so flagging
        // them produced false-positive alerts. 'pending' IS included: real sessions carry
        // that status (it is set on some transfers) and they still need all three.
        .in('status', ['booked', 'pending', 'scheduled', 'confirmed', 'rescheduled', 'reschedule_requested']);

      if (error) {
        console.error('Error fetching sessions for crawler:', error);
        return;
      }

      const initiallyMissing = sessions.filter(
        (s) => !s.google_meet_link || !s.google_calendar_event_id
      );

      console.log(`Crawler checked ${sessions.length} sessions for ${today}. Found ${initiallyMissing.length} with missing links — attempting auto-repair.`);

      // ── AUTO-REPAIR ──────────────────────────────────────────────────────
      // For each session missing its calendar event, try to (re)create the Google Calendar
      // event + Meet link silently (no client/therapist notifications). Only the sessions
      // that STILL fail after this repair attempt are escalated in the alert email — so ops
      // isn't paged for issues the system already fixed itself.
      const calendarStillBroken = new Map(); // sessionId -> repair failure reason
      for (const sess of initiallyMissing) {
        try {
          const result = await regenerateSessionMeet(sess.id);
          if (result.success && result.eventId) {
            console.log(`  ✅ repaired session ${sess.id} → event ${result.eventId}`);
            sess.google_calendar_event_id = result.eventId;
            sess.google_meet_link = result.meetLink || sess.google_meet_link;
            continue; // fixed — don't alert
          }
          // Re-read to confirm current state, then escalate with the repair failure reason.
          const { data: fresh } = await supabaseAdmin
            .from('sessions')
            .select('google_calendar_event_id, google_meet_link')
            .eq('id', sess.id).maybeSingle();
          if (fresh?.google_calendar_event_id && fresh?.google_meet_link) {
            Object.assign(sess, fresh);
            continue; // repaired by another path
          }
          Object.assign(sess, fresh || {});
          calendarStillBroken.set(sess.id, result.error || 'unknown');
          console.warn(`  ❌ could not repair session ${sess.id}: ${result.error}`);
        } catch (repairErr) {
          calendarStillBroken.set(sess.id, repairErr.message || String(repairErr));
          console.error(`  ❌ repair threw for session ${sess.id}:`, repairErr.message || repairErr);
        }
      }

      console.log(`Auto-repair done. ${initiallyMissing.length - calendarStillBroken.size} fixed, ${calendarStillBroken.size} still failing.`);

      // ── COLLECT ALL THREE PROBLEMS ───────────────────────────────────────
      // Calendar/Meet is auto-repaired above; email and WhatsApp are only REPORTED. Silently
      // re-sending would fire real messages at clients, which must be a human decision.
      const missingSessions = [];
      for (const sess of sessions) {
        const problems = [];
        const reasons = [];
        if (!sess.google_meet_link || !sess.google_calendar_event_id) {
          const bits = [];
          if (!sess.google_meet_link) bits.push('Meet Link');
          if (!sess.google_calendar_event_id) bits.push('Event ID');
          problems.push(bits.join(' + '));
          reasons.push(`calendar: ${calendarStillBroken.get(sess.id) || 'missing'}`);
        }
        // A session notified BEFORE the per-channel marker columns existed has notified_at set
        // and email_sent_at / whatsapp_sent_at null — not because nothing was delivered, but
        // because there was nowhere to record it. Reading those nulls as "never sent" reported
        // long-delivered sessions as failures: a 19 June booking was flagged on the morning of
        // its rescheduled 9 September session, three months after the client was notified.
        //
        // The first marker ever written is 2026-07-09T05:05Z, the day that migration shipped.
        // Before it, notified_at is the only record of delivery, so trust it.
        const notifiedAt = sess.notified_at ? Date.parse(sess.notified_at) : null;
        const markersUnavailable = notifiedAt != null && notifiedAt < CHANNEL_MARKERS_LIVE_AT;

        if (!sess.email_sent_at && !markersUnavailable) {
          problems.push('Email');
          reasons.push(`email: ${sess.email_error || (sess.notified_at ? 'no email marker' : 'never sent')}`);
        }
        if (!sess.whatsapp_sent_at && !markersUnavailable) {
          problems.push('WhatsApp');
          reasons.push(`whatsapp: ${sess.whatsapp_error || (sess.notified_at ? 'no whatsapp marker' : 'never sent')}`);
        }
        if (problems.length) missingSessions.push({ ...sess, problems, reasons });
      }

      console.log(`Problems found: ${missingSessions.length} session(s) — ` +
        `calendar ${missingSessions.filter((s) => !s.google_meet_link || !s.google_calendar_event_id).length}, ` +
        `email ${missingSessions.filter((s) => s.problems.includes('Email')).length}, ` +
        `whatsapp ${missingSessions.filter((s) => s.problems.includes('WhatsApp')).length}`);

      if (missingSessions.length > 0) {
        let htmlBody = `
          <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 20px;">
            <h2 style="color: #d9534f; border-bottom: 2px solid #eee; padding-bottom: 10px;">Today's Session Checks — Problems Found</h2>
            <p><strong>Date:</strong> ${today}</p>
            <p>Checked <strong>${sessions.length}</strong> active session(s) scheduled today for three things: <strong>Calendar event + Meet link</strong>, <strong>confirmation email sent</strong>, and <strong>WhatsApp sent</strong>.</p>
            <p>Calendar events are auto-repaired where possible. Email and WhatsApp are <strong>reported only, not re-sent</strong> — resending is a manual decision.</p>
            <p>The following <strong>${missingSessions.length}</strong> session(s) need attention:</p>
            <ul style="font-size: 14px; color: #555;">
              <li>Calendar / Meet missing: <strong>${missingSessions.filter((s) => !s.google_meet_link || !s.google_calendar_event_id).length}</strong></li>
              <li>Email not sent: <strong>${missingSessions.filter((s) => s.problems.includes('Email')).length}</strong></li>
              <li>WhatsApp not sent: <strong>${missingSessions.filter((s) => s.problems.includes('WhatsApp')).length}</strong></li>
            </ul>
            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
              <thead>
                <tr style="background-color: #f8f9fa;">
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Time</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Client</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Email</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Phone</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Therapist</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Missing</th>
                  <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Reason</th>
                </tr>
              </thead>
              <tbody>
        `;

        for (const sess of missingSessions) {
          const { data: psych } = await supabaseAdmin.from('psychologists').select('first_name, last_name').eq('id', sess.psychologist_id).maybeSingle();
          // client_id references the CLIENTS table (not users) — the old users lookup always
          // returned null → "Unknown". Resolve the real name/phone from clients.
          const { data: client } = sess.client_id
            ? await supabaseAdmin.from('clients').select('first_name, last_name, phone_number, user_id').eq('id', sess.client_id).maybeSingle()
            : { data: null };
          // Email lives on the linked users row (clients.email is usually empty).
          let clientEmail = '—';
          if (client?.user_id) {
            const { data: u } = await supabaseAdmin.from('users').select('email').eq('id', client.user_id).maybeSingle();
            clientEmail = u?.email || '—';
          }

          const psychName = psych ? `${psych.first_name} ${psych.last_name || ''}`.trim() : 'Unknown';
          const clientName = client
            ? (`${client.first_name || ''} ${client.last_name || ''}`.trim() || 'Unknown')
            : 'Unknown';
          const clientPhone = client?.phone_number || '—';

          const missingItems = sess.problems;

          htmlBody += `
                <tr>
                  <td style="padding: 10px; border: 1px solid #ddd;">${sess.scheduled_time}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${clientName}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${clientEmail}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${clientPhone}</td>
                  <td style="padding: 10px; border: 1px solid #ddd;">${psychName}</td>
                  <td style="padding: 10px; border: 1px solid #ddd; color: #d9534f;">${missingItems.join(', ')}</td>
                  <td style="padding: 10px; border: 1px solid #ddd; color: #777;">${(sess.reasons || []).join('<br>') || '—'}</td>
                </tr>
          `;
        }

        htmlBody += `
              </tbody>
            </table>
            <p style="margin-top: 20px; font-size: 12px; color: #777;">This is an automated alert generated by the Koott System.</p>
          </div>
        `;

        // Both recipients. Overridable without a deploy via CRAWLER_ALERT_RECIPIENTS
        // (comma-separated) — the address used to be a single hardcoded one.
        const alertRecipients = (process.env.CRAWLER_ALERT_RECIPIENTS ||
          'abhishekravi063@gmail.com,koottfordeveloper@gmail.com')
          .split(',').map((a) => a.trim()).filter(Boolean);

        const counts = [
          `${missingSessions.filter((s) => !s.google_meet_link || !s.google_calendar_event_id).length} calendar`,
          `${missingSessions.filter((s) => s.problems.includes('Email')).length} email`,
          `${missingSessions.filter((s) => s.problems.includes('WhatsApp')).length} whatsapp`,
        ].join(', ');

        await EmailService.sendEmail({
          to: alertRecipients.join(', '),
          subject: `⚠️ URGENT: ${missingSessions.length} sessions need attention today (${today}) — ${counts}`,
          html: htmlBody,
          text: `${missingSessions.length} session(s) scheduled today have problems (${counts}). See the HTML version for details.`
        });

        console.log(`✅ Daily alert email sent to ${alertRecipients.join(', ')}`);
      }
    } catch (err) {
      console.error('Error in daily missing links crawler:', err);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });
};

module.exports = {
  startDailyCrawlerScheduler,
};
