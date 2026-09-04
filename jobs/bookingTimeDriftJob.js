/**
 * Booking time drift check.
 *
 * A Wix booking's time lives in two places: `wix_bookings.start_time` (what the mirror and the
 * therapist's Google Calendar reflect) and `sessions.scheduled_date`/`scheduled_time` (what
 * every internal screen reads). Reschedule and transfer are supposed to move both together.
 *
 * When only one of them moves, nothing errors and nothing looks wrong:
 *   - admin/finance show one time, the therapist's and client's calendars show another
 *   - Wix decides availability by reading the therapist's Google Calendar, so the slot the
 *     calendar moved to is now blocked and unsellable while the paid slot sits elsewhere —
 *     two hours held, one sold
 *
 * That happened to a 4 Sept booking that read 10:00 in the mirror and on Google while the
 * session kept 09:00. It was only noticed on the morning of the session. The write paths are
 * now guarded, but a check that fails loudly is what turns "noticed by accident" into
 * "noticed the same minute" — and it catches drift from any future path too, not just the
 * two that are guarded today.
 */
const { supabaseAdmin } = require('../config/supabase');
const emailService = require('../utils/emailService');

const LOG_PREFIX = '[bookingDrift]';
// Same shape as the crawler job's recipients: a hardcoded default so the alert works with no
// deploy-time config, still overridable via env when it needs to go somewhere else.
const ALERT_EMAIL = process.env.BOOKING_DRIFT_ALERT_EMAIL || 'koottfordeveloper@gmail.com';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Mirror rows in these states are not live bookings, so a time difference is meaningless.
const DEAD_MIRROR_STATUS = new Set(['cancelled', 'deleted', 'on_hold']);
// Only sessions that can still be attended matter — a completed one cannot lose a slot.
const LIVE_SESSION_STATUS = new Set(['booked', 'rescheduled', 'reschedule_requested', 'pending']);

/** Alerted session ids, so a repeating scan doesn't re-send the same mail every run. */
const alerted = new Set();

const istWallClock = (iso) =>
  new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

/** PostgREST caps every response at 1000 rows — page, or the scan silently covers a third of the table. */
async function fetchAllPages(build) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await build().range(offset, offset + 999);
    if (error) return { data: out, error };
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: out, error: null };
}

/**
 * Find live bookings whose mirror time disagrees with their session time.
 * @returns {Promise<{ drift: Array, scanned: number, error: Error|null }>}
 */
async function findBookingTimeDrift() {
  const { data: mirrors, error: mErr } = await fetchAllPages(() =>
    supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id, start_time, status, client_email, therapist_name')
      .order('id', { ascending: true })
  );
  if (mErr) return { drift: [], scanned: 0, error: mErr };

  const live = (mirrors || []).filter(
    (m) => m.wix_booking_id && m.start_time && !DEAD_MIRROR_STATUS.has(String(m.status || '').toLowerCase())
  );

  // Chunked: a single .in() with thousands of ids overflows the PostgREST GET URL and comes
  // back as "Bad Request" — which, if the error were ignored, would read as "no drift found".
  const ids = live.map((m) => m.wix_booking_id);
  const sessions = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('id, wix_booking_id, scheduled_date, scheduled_time, status, psychologist_id')
      .in('wix_booking_id', ids.slice(i, i + 100));
    if (error) return { drift: [], scanned: 0, error };
    sessions.push(...(data || []));
  }
  const byBooking = {};
  sessions.forEach((s) => { if (s.wix_booking_id) byBooking[s.wix_booking_id] = s; });

  const todayIst = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const drift = [];
  for (const m of live) {
    const s = byBooking[m.wix_booking_id];
    if (!s) continue;
    if (!LIVE_SESSION_STATUS.has(String(s.status || '').toLowerCase())) continue;
    // Past sessions can no longer cost a slot; reporting them would bury the actionable ones.
    if (!s.scheduled_date || s.scheduled_date < todayIst) continue;

    const mirrorTime = istWallClock(m.start_time);
    const sessionTime = `${s.scheduled_date} ${String(s.scheduled_time || '').slice(0, 5)}`;
    if (mirrorTime === sessionTime) continue;

    drift.push({
      session_id: s.id,
      wix_booking_id: m.wix_booking_id,
      client_email: m.client_email || null,
      therapist: m.therapist_name || null,
      calendar_time: mirrorTime,   // what the therapist's and client's calendars show
      dashboard_time: sessionTime, // what admin/finance show
      session_status: s.status,
    });
  }

  return { drift, scanned: live.length, error: null };
}

async function alertOnDrift(drift) {
  const fresh = drift.filter((d) => !alerted.has(d.session_id));
  if (!fresh.length) return;
  try {
    const rows = fresh
      .map(
        (d) => `<tr>
          <td style="padding:6px 10px;border:1px solid #ddd">${d.client_email || '—'}</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${d.therapist || '—'}</td>
          <td style="padding:6px 10px;border:1px solid #ddd"><b>${d.calendar_time}</b></td>
          <td style="padding:6px 10px;border:1px solid #ddd"><b>${d.dashboard_time}</b></td>
          <td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px">${d.session_id}</td>
        </tr>`
      )
      .join('');
    await emailService.sendEmail({
      to: ALERT_EMAIL,
      subject: `⚠️ ${fresh.length} booking(s) show a different time on the calendar than in the dashboard`,
      html: `<p>These upcoming bookings disagree with themselves. The calendar time is what the
             therapist and client will act on; the dashboard time is what staff see.</p>
             <p><b>While they disagree, the calendar slot is blocked in Google and Wix will not
             sell it — so an hour is being held that nobody paid for.</b></p>
             <table style="border-collapse:collapse;font-size:14px">
               <tr>
                 <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Client</th>
                 <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Therapist</th>
                 <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Calendar says</th>
                 <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Dashboard says</th>
                 <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Session id</th>
               </tr>${rows}
             </table>`,
    });
    fresh.forEach((d) => alerted.add(d.session_id));
    console.log(`${LOG_PREFIX} 📨 drift alert sent to ${ALERT_EMAIL} for ${fresh.length} booking(s)`);
  } catch (e) {
    console.error(`${LOG_PREFIX} could not send drift alert:`, e.message || e);
  }
}

async function runBookingTimeDriftCheck({ alert = true } = {}) {
  const started = Date.now();
  const { drift, scanned, error } = await findBookingTimeDrift();
  if (error) {
    console.error(`${LOG_PREFIX} scan failed:`, error.message || error);
    return { drift: [], scanned: 0, error };
  }
  if (!drift.length) {
    console.log(`${LOG_PREFIX} ✅ ${scanned} live booking(s) checked, no time drift (${Date.now() - started}ms)`);
    return { drift, scanned, error: null };
  }
  console.error(`${LOG_PREFIX} 🚨 ${drift.length} booking(s) disagree with their own calendar:`);
  drift.forEach((d) =>
    console.error(
      `${LOG_PREFIX}    calendar=${d.calendar_time} dashboard=${d.dashboard_time} ` +
        `therapist=${d.therapist} client=${d.client_email} session=${d.session_id}`
    )
  );
  if (alert) await alertOnDrift(drift);
  return { drift, scanned, error: null };
}

/** Run every `intervalMinutes`, plus once shortly after boot. Returns a stop function. */
function startBookingTimeDriftScheduler(intervalMinutes = 30) {
  const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;
  console.log(`${LOG_PREFIX} scheduler started — every ${intervalMinutes} min`);
  const timer = setInterval(() => {
    runBookingTimeDriftCheck().catch((err) => console.error(`${LOG_PREFIX} scheduled run failed:`, err));
  }, intervalMs);
  // Delayed so it doesn't compete with the sync jobs that also run at boot.
  const kickoff = setTimeout(() => {
    runBookingTimeDriftCheck().catch((err) => console.error(`${LOG_PREFIX} initial run failed:`, err));
  }, 60 * 1000);
  return () => { clearInterval(timer); clearTimeout(kickoff); };
}

module.exports = { findBookingTimeDrift, runBookingTimeDriftCheck, startBookingTimeDriftScheduler };
