/**
 * Reconcile sessions.session_type/session_count from wix_bookings for Wix-backed rows.
 *
 * Run from backend dir:
 *   node scripts/reconcile-wix-session-classification.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabaseAdmin } = require('../config/supabase');

async function main() {
  const { data: wixRows, error: wixErr } = await supabaseAdmin
    .from('wix_bookings')
    .select('wix_booking_id, session_type, session_count, wix_order_number, status')
    .not('wix_booking_id', 'is', null)
    .neq('status', 'deleted');

  if (wixErr) {
    console.error('Failed to load wix_bookings:', wixErr.message);
    process.exit(1);
  }

  const { data: sessionRows, error: sessErr } = await supabaseAdmin
    .from('sessions')
    .select('id, wix_booking_id, session_type, session_count, source')
    .eq('source', 'wix')
    .not('wix_booking_id', 'is', null);

  if (sessErr) {
    console.error('Failed to load sessions:', sessErr.message);
    process.exit(1);
  }

  const byBookingId = new Map((wixRows || []).map((r) => [String(r.wix_booking_id), r]));
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const session of sessionRows || []) {
    const bookingId = String(session.wix_booking_id || '');
    const wb = byBookingId.get(bookingId);
    if (!wb) continue;

    const nextType = wb.session_type || session.session_type;
    const nextCount = wb.session_count || session.session_count || 1;
    const changed =
      String(session.session_type || '') !== String(nextType || '') ||
      Number(session.session_count || 1) !== Number(nextCount || 1);

    if (!changed) {
      unchanged++;
      continue;
    }

    const { error: updateErr } = await supabaseAdmin
      .from('sessions')
      .update({
        session_type: nextType,
        session_count: nextCount,
      })
      .eq('id', session.id);

    if (updateErr) {
      failed++;
      console.error(`Failed ${session.id} (${bookingId}):`, updateErr.message);
      continue;
    }

    updated++;
    console.log(`Updated session ${session.id} (${bookingId}) -> ${nextType}/${nextCount}`);
  }

  console.log('\nReconcile complete.');
  console.log(`  Updated:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Failed:    ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
