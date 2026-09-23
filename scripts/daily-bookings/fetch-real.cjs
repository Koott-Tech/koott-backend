const fs = require('node:fs');
const path = require('node:path');
const backend = path.resolve(__dirname, '../..');
const outputDir = process.env.REPORT_OUTPUT_DIR || path.join(backend, '.daily-booking-reports');
require(path.join(backend, 'node_modules/dotenv')).config({ path: path.join(backend, '.env') });
const { supabaseAdmin: db } = require(path.join(backend, 'config/supabase'));
async function all(query) {
  const rows = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await query().range(start, start + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}
const UNASSIGNED = '__unassigned__';

async function main() {
  const date = process.env.REPORT_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid report date');
  const completedDate = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  // Yesterday's tab is yesterday's OWN slots and what became of each one. It used to select by
  // completion_date, so a therapist marking a 21st session complete on the 22nd put that session
  // on the 22nd's tab while the 22nd's own unmarked slots were missing entirely.
  const [sessions, therapists, completed] = await Promise.all([
    all(() => db.from('sessions').select('id,psychologist_id,scheduled_time,session_type,status,wix_payload,wix_booking_id').eq('scheduled_date', date).in('status', ['booked', 'rescheduled', 'reschedule_requested', 'confirmed', 'scheduled', 'upcoming']).order('id')),
    all(() => db.from('psychologists').select('id,first_name,last_name').order('id')),
    all(() => db.from('sessions').select('id,psychologist_id,scheduled_date,scheduled_time,session_type,status,wix_payload,wix_booking_id,completion_date').eq('scheduled_date', completedDate).order('id')),
  ]);
  const groups = therapists.map(t => ({ id: t.id, name: `${t.first_name || ''} ${t.last_name || ''}`.trim(), slots: [] }));
  const completedGroups = groups.map(g => ({ ...g, slots: [] }));
  for (const [records, targetGroups] of [[sessions, groups], [completed, completedGroups]]) {
    for (const s of records) {
      let g = targetGroups.find(g => g.id === s.psychologist_id);
      // A Wix booking whose therapist has not been matched yet used to throw here, which killed
      // the whole report — no email at all. List it instead.
      if (!g) {
        g = targetGroups.find(x => x.id === UNASSIGNED);
        if (!g) { g = { id: UNASSIGNED, name: 'Unassigned (therapist not matched)', slots: [] }; targetGroups.push(g); }
      }
      const p = s.wix_payload || {};
      const explicit = Number(p.sessionDurationMin);
      const difference = (Date.parse(p.endTime) - Date.parse(p.startTime)) / 60000;
      let minutes = explicit > 0 && explicit <= 600 ? explicit : difference > 0 && difference <= 600 ? difference : null;
      if (!minutes && s.wix_booking_id) {
        const { data: mirror, error } = await db.from('wix_bookings').select('start_time,end_time').eq('wix_booking_id', s.wix_booking_id).maybeSingle();
        if (error) throw error;
        const d = (Date.parse(mirror?.end_time) - Date.parse(mirror?.start_time)) / 60000;
        if (d > 0 && d <= 600) minutes = d;
      }
      g.slots.push({ time: s.scheduled_time, type: s.session_type, minutes, status: s.status, completionDate: s.completion_date || null, scheduledDate: s.scheduled_date || (records === sessions ? date : null) });
    }
    targetGroups.sort((a,b) => a.name.localeCompare(b.name));
    for (const g of targetGroups) g.slots.sort((a,b) => `${a.scheduledDate} ${a.time || ''}`.localeCompare(`${b.scheduledDate} ${b.time || ''}`));
  }
  const heldStatus = (st) => String(st || '').toLowerCase() === 'completed';
  const report = {
    date, completedDate, fetchedAt: new Date().toISOString(),
    total: sessions.length, completedTotal: completed.length,
    completedHeld: completed.filter(s => heldStatus(s.status)).length,
    groups, completedGroups,
  };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'real-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ date, completedDate, bookings: sessions.length, yesterdaySlots: completed.length, yesterdayHeld: report.completedHeld, therapists: groups.length }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
