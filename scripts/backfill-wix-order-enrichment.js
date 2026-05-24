/**
 * Backfill Wix order enrichment for existing rows in wix_bookings / sessions.
 *
 * Re-runs Wix eCommerce order parsing against historical bookings and updates:
 *   - wix_bookings.session_type
 *   - wix_bookings.session_count
 *   - wix_bookings.wix_order_id
 *   - wix_bookings.wix_order_number
 *   - sessions.session_type
 *   - sessions.session_count
 *
 * Run from backend dir:
 *   node scripts/backfill-wix-order-enrichment.js
 *   node scripts/backfill-wix-order-enrichment.js --limit=25
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabaseAdmin } = require('../config/supabase');
const { fetchSessionInfoBatch } = require('../services/wixOrderEnrichmentService');

function parseLimitArg(argv) {
  const raw = argv.find((arg) => arg.startsWith('--limit='));
  if (!raw) return null;
  const n = parseInt(raw.split('=')[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  const limit = parseLimitArg(process.argv.slice(2));

  let query = supabaseAdmin
    .from('wix_bookings')
    .select('wix_booking_id, client_full_name, client_email, session_type, session_count, wix_order_number, status, created_at')
    .not('wix_booking_id', 'is', null)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false });

  if (limit) query = query.limit(limit);

  const { data: rows, error } = await query;
  if (error) {
    console.error('Failed to load wix_bookings:', error.message);
    process.exit(1);
  }

  if (!rows?.length) {
    console.log('No wix_bookings rows found for backfill.');
    return;
  }

  const bookingIds = rows.map((r) => String(r.wix_booking_id)).filter(Boolean);
  console.log(`Loaded ${bookingIds.length} Wix booking row(s). Fetching order enrichment...`);

  const infoMap = await fetchSessionInfoBatch(bookingIds);
  if (!infoMap.size) {
    console.log('No order enrichment data found. Nothing to update.');
    return;
  }

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of rows) {
    const bookingId = String(row.wix_booking_id);
    const info = infoMap.get(bookingId);
    if (!info) continue;

    const nextType = info.sessionType || row.session_type;
    const nextCount = info.sessionCount || row.session_count || 1;
    const nextOrderNumber = info.orderNumber || row.wix_order_number || null;

    const changed =
      row.session_type !== nextType ||
      Number(row.session_count || 1) !== Number(nextCount || 1) ||
      String(row.wix_order_number || '') !== String(nextOrderNumber || '');

    if (!changed) {
      unchanged++;
      continue;
    }

    try {
      const wbUpdate = {
        session_type: nextType,
        session_count: nextCount,
      };
      if (info.orderId) wbUpdate.wix_order_id = info.orderId;
      if (info.orderNumber) wbUpdate.wix_order_number = info.orderNumber;

      const { error: wbErr } = await supabaseAdmin
        .from('wix_bookings')
        .update(wbUpdate)
        .eq('wix_booking_id', bookingId);
      if (wbErr) throw wbErr;

      const { error: sessErr } = await supabaseAdmin
        .from('sessions')
        .update({
          session_type: nextType,
          session_count: nextCount,
        })
        .eq('wix_booking_id', bookingId);
      if (sessErr && !String(sessErr.message || '').includes('0 rows')) throw sessErr;

      updated++;
      console.log(
        `Updated ${bookingId} | ${row.client_full_name || row.client_email || 'Unknown'} | ${row.session_type}/${row.session_count} -> ${nextType}/${nextCount} | order #${info.orderNumber || 'n/a'}`
      );
    } catch (updateErr) {
      failed++;
      console.error(`Failed updating ${bookingId}:`, updateErr.message || updateErr);
    }
  }

  console.log('\nBackfill complete.');
  console.log(`  Updated:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Enriched:  ${infoMap.size}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
