/**
 * Daily booking report — the midnight email to operations.
 *
 * Two tabs, grouped by therapist:
 *   • Daily bookings      — slots still going ahead on the IST day just starting.
 *   • Yesterday's sessions — every slot SCHEDULED on the previous IST day, whatever became of
 *     it, with a Status column and a "held" count per therapist.
 *
 * Yesterday's tab deliberately selects by scheduled_date, not completion_date: a therapist who
 * marks the 21st's session complete on the 22nd would otherwise move that session onto the
 * 22nd's tab while the 22nd's own unmarked slots went missing entirely (22 Sept showed 35 rows,
 * 6 of them from the 21st, and left out 25 of its own 40 slots).
 *
 * This used to live in scripts/daily-bookings as a scheduled task inside a desktop app, which
 * meant it only ran while that computer was awake — the night of 24 Sept it simply never ran,
 * and not even a failure alert went out. It now runs on the server beside the other crawlers.
 */
const ExcelJS = require('exceljs');
const { supabaseAdmin } = require('../config/supabase');

const RECIPIENT = process.env.DAILY_REPORT_RECIPIENT || 'simsar280108@gmail.com';
const ALERT_RECIPIENT = 'koottfordeveloper@gmail.com';
// Statuses that mean "this slot is still going ahead" — a cancelled slot must not be presented
// as an upcoming session on the day's tab.
const ACTIVE = ['booked', 'rescheduled', 'reschedule_requested', 'confirmed', 'scheduled', 'upcoming'];

const istDate = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
const previousDay = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/** Every row of a query, 500 at a time (PostgREST caps a single response). */
async function allRows(build) {
  const rows = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await build().range(start, start + 499);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

const statusLabel = (status) => {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 'Completed';
  if (['no_show', 'no-show', 'noshow'].includes(s)) return 'No show';
  if (['cancelled', 'canceled'].includes(s)) return 'Cancelled';
  if (s === 'rescheduled') return 'Rescheduled';
  if (s === 'refunded') return 'Refunded';
  if (!s) return 'Not recorded';
  return `Not marked (${s.replace(/_/g, ' ')})`;
};
const isHeld = (slot) => String(slot.status || '').toLowerCase() === 'completed';

/** Minutes a session runs for: the booking's own times, else the Wix mirror, else unknown. */
function durationOf(session, mirrorByBookingId) {
  const p = session.wix_payload || {};
  const explicit = Number(p.sessionDurationMin);
  if (explicit > 0 && explicit <= 600) return explicit;
  const fromPayload = (Date.parse(p.endTime) - Date.parse(p.startTime)) / 60000;
  if (fromPayload > 0 && fromPayload <= 600) return fromPayload;
  const mirror = session.wix_booking_id ? mirrorByBookingId.get(session.wix_booking_id) : null;
  const fromMirror = mirror ? (Date.parse(mirror.end_time) - Date.parse(mirror.start_time)) / 60000 : 0;
  return fromMirror > 0 && fromMirror <= 600 ? fromMirror : null;
}

async function gatherReport(date = istDate()) {
  const yesterday = previousDay(date);
  const SELECT = 'id, psychologist_id, scheduled_date, scheduled_time, session_type, status, wix_payload, wix_booking_id';

  const [today, yesterdaySlots, therapists] = await Promise.all([
    allRows(() => supabaseAdmin.from('sessions').select(SELECT).eq('scheduled_date', date).in('status', ACTIVE).order('id')),
    allRows(() => supabaseAdmin.from('sessions').select(SELECT).eq('scheduled_date', yesterday).order('id')),
    allRows(() => supabaseAdmin.from('psychologists').select('id, first_name, last_name').order('id')),
  ]);

  const bookingIds = [...new Set([...today, ...yesterdaySlots].map((s) => s.wix_booking_id).filter(Boolean))];
  const mirrorByBookingId = new Map();
  for (let i = 0; i < bookingIds.length; i += 200) {
    const { data } = await supabaseAdmin.from('wix_bookings')
      .select('wix_booking_id, start_time, end_time').in('wix_booking_id', bookingIds.slice(i, i + 200));
    (data || []).forEach((m) => mirrorByBookingId.set(m.wix_booking_id, m));
  }

  const nameOf = new Map(therapists.map((t) => [t.id, `${t.first_name || ''} ${t.last_name || ''}`.trim().replace(/\s+/g, ' ')]));
  const group = (sessions) => {
    const byTherapist = new Map();
    for (const s of sessions) {
      // A booking whose therapist is not matched yet used to abort the whole report, so no
      // email went out at all. List it instead.
      const key = s.psychologist_id || '__unassigned__';
      const name = nameOf.get(s.psychologist_id) || 'Unassigned (therapist not matched)';
      if (!byTherapist.has(key)) byTherapist.set(key, { name, slots: [] });
      byTherapist.get(key).slots.push({
        time: s.scheduled_time,
        type: s.session_type,
        minutes: durationOf(s, mirrorByBookingId),
        status: s.status,
      });
    }
    return [...byTherapist.values()]
      .map((g) => ({ ...g, slots: g.slots.sort((a, b) => String(a.time).localeCompare(String(b.time))) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    date,
    yesterday,
    generatedAt: new Date().toISOString(),
    todayTotal: today.length,
    yesterdayTotal: yesterdaySlots.length,
    yesterdayHeld: yesterdaySlots.filter(isHeld).length,
    todayGroups: group(today),
    yesterdayGroups: group(yesterdaySlots),
  };
}

function buildWorkbook(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Koott';
  const fmtTime = (t) => (t ? String(t).slice(0, 5) : 'Not recorded');
  const fmtMinutes = (m) => (!m ? 'Not recorded' : m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`);

  for (const past of [false, true]) {
    const sheet = wb.addWorksheet(past ? "Yesterday's sessions" : 'Daily bookings', { views: [{ showGridLines: false }] });
    const groups = past ? report.yesterdayGroups : report.todayGroups;
    const total = past ? report.yesterdayTotal : report.todayTotal;
    const columns = past ? 4 : 3;
    sheet.columns = past
      ? [{ width: 36 }, { width: 16 }, { width: 18 }, { width: 22 }]
      : [{ width: 36 }, { width: 16 }, { width: 18 }];

    sheet.getCell('A2').value = past ? "Yesterday's booked slots" : 'Daily booked slots';
    sheet.getCell('A2').font = { name: 'Arial', size: 16, bold: true };
    sheet.getCell('A3').value = `${past ? report.yesterday : report.date} · All times IST`;
    sheet.getCell('A4').value = past
      ? `${total} slots across ${groups.length} therapists — ${report.yesterdayHeld} marked completed, ${total - report.yesterdayHeld} not marked`
      : `${total} bookings across ${groups.length} therapists`;
    for (const ref of ['A3', 'A4']) sheet.getCell(ref).font = { name: 'Arial', size: 11 };

    let row = 6;
    if (!groups.length) {
      sheet.getCell(`A${row}`).value = past ? 'No slots were scheduled on this date.' : 'No booked slots recorded.';
      sheet.getCell(`A${row}`).font = { name: 'Arial', size: 11 };
      row += 2;
    }
    for (const g of groups) {
      const held = g.slots.filter(isHeld).length;
      sheet.getCell(`A${row}`).value = g.name;
      sheet.getCell(row, columns).value = past ? `${held} of ${g.slots.length} held` : `${g.slots.length} booked slot${g.slots.length === 1 ? '' : 's'}`;
      for (let c = 1; c <= columns; c++) {
        const cell = sheet.getCell(row, c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF244C43' } };
        cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      }
      sheet.getRow(row).height = 24;
      row += 1;

      const headers = past ? ['Time (IST)', 'Duration', 'Session type', 'Status'] : ['Time (IST)', 'Duration', 'Session type'];
      headers.forEach((h, i) => {
        const cell = sheet.getCell(row, i + 1);
        cell.value = h;
        cell.font = { name: 'Arial', size: 11, bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EFEB' } };
      });
      row += 1;

      for (const slot of g.slots) {
        const values = [fmtTime(slot.time), fmtMinutes(slot.minutes), slot.type ? slot.type.charAt(0).toUpperCase() + slot.type.slice(1) : 'Not recorded'];
        if (past) values.push(statusLabel(slot.status));
        values.forEach((v, i) => {
          const cell = sheet.getCell(row, i + 1);
          cell.value = v;
          cell.font = { name: 'Arial', size: 11 };
        });
        row += 1;
      }
      row += 1;
    }
    sheet.getCell(`A${row}`).value = 'Source: Koott live booking records';
    sheet.getCell(`A${row}`).font = { name: 'Arial', size: 10, italic: true };
    if (past) {
      row += 1;
      sheet.getCell(`A${row}`).value = 'Every slot scheduled on this date with what it was marked as. A session marked completed on this date but scheduled earlier belongs to its own date, not this one.';
      sheet.getCell(`A${row}`).font = { name: 'Arial', size: 10, italic: true };
    }
  }
  return wb;
}

function buildEmail(report) {
  const lines = [
    `Booked for ${report.date}: ${report.todayTotal} slots across ${report.todayGroups.length} therapists.`,
    `Scheduled on ${report.yesterday}: ${report.yesterdayTotal} slots across ${report.yesterdayGroups.length} therapists — ${report.yesterdayHeld} marked completed.`,
    'Full therapist and slot details are in the attached Excel (2 tabs). All times IST.',
  ];
  return {
    to: RECIPIENT,
    subject: `Koott daily report — ${report.date} (IST)`,
    text: lines.join('\n\n'),
    html: `<div style="font-family:Arial,sans-serif;color:#24352f"><h2>Koott daily report</h2>${lines.map((l) => `<p>${l}</p>`).join('')}</div>`,
  };
}

/** Per-date send record, so a restart or a manual run cannot email the same report twice. */
const SENT_ACTION = 'daily_booking_report_sent';
async function alreadySent(date) {
  const { data } = await supabaseAdmin.from('audit_logs')
    .select('id').eq('action', SENT_ACTION).eq('resource_id', date).limit(1);
  return !!(data && data.length);
}

async function sendDailyBookingReport({ date = istDate(), force = false, dryRun = false } = {}) {
  const emailService = require('../utils/emailService');
  try {
    if (!force && !dryRun && await alreadySent(date)) {
      console.log(`[daily-report] ${date} already sent — skipping`);
      return { ok: true, skipped: 'already sent', date };
    }
    const report = await gatherReport(date);
    const wb = buildWorkbook(report);
    const buffer = await wb.xlsx.writeBuffer();
    if (dryRun) {
      console.log(`[daily-report] dry run for ${date}: ${report.todayTotal} bookings, ${report.yesterdayTotal} slots yesterday (${report.yesterdayHeld} held)`);
      return { ok: true, dryRun: true, report, buffer };
    }

    const filename = `koott-daily-report-${report.date}.xlsx`;
    const result = await emailService.sendCustomEmail({
      ...buildEmail(report),
      attachments: [{ filename, content: Buffer.from(buffer) }],
    });
    if (!result?.accepted?.includes(RECIPIENT) || result?.rejected?.length) {
      throw new Error(`the mail server did not accept ${RECIPIENT}`);
    }
    await supabaseAdmin.from('audit_logs').insert([{
      action: SENT_ACTION, resource: 'daily_booking_report', resource_id: date,
      details: { to: RECIPIENT, messageId: result.messageId, bookings: report.todayTotal, yesterdaySlots: report.yesterdayTotal, yesterdayHeld: report.yesterdayHeld },
    }]);
    console.log(`[daily-report] ${date} sent to ${RECIPIENT} (${report.todayTotal} bookings, ${report.yesterdayTotal} slots yesterday)`);
    return { ok: true, date, messageId: result.messageId, report };
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[daily-report] ${date} FAILED: ${message}`);
    // A silent failure is the worst outcome: operations simply gets no email and nobody knows.
    try {
      await emailService.sendCustomEmail({
        to: ALERT_RECIPIENT,
        subject: `Koott daily report FAILED — ${date} (IST)`,
        text: `The daily booking report for ${date} (IST) was not sent.\n\nError: ${message}\n\nIt can be re-sent from the server once the cause is fixed.`,
        html: `<div style="font-family:Arial,sans-serif"><h2>Daily report failed</h2><p>The daily booking report for ${date} (IST) was not sent.</p><p><b>Error:</b> ${message}</p></div>`,
      });
    } catch (alertErr) {
      console.error('[daily-report] could not send the failure alert:', alertErr?.message || alertErr);
    }
    return { ok: false, date, error: message };
  }
}

module.exports = { sendDailyBookingReport, gatherReport, buildWorkbook, buildEmail, istDate, RECIPIENT, ALERT_RECIPIENT };
