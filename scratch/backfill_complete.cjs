/**
 * Backfill: update ALL wix_bookings with order IDs, session types, and run the package linker.
 * Run this after adding wix_order_id, wix_order_number, package_group_id columns.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const { fetchSessionInfoFromOrder } = require('../services/wixOrderEnrichmentService');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  // Step 1: Verify columns exist
  console.log('=== Step 1: Verify columns ===');
  const { error: e1 } = await supabase.from('wix_bookings').select('wix_order_id, wix_order_number, package_group_id').limit(1);
  if (e1) {
    console.error('Missing columns! Run the SQL migrations first:', e1.message);
    return;
  }
  console.log('All columns exist ✅\n');

  // Step 2: Fetch all bookings (skip ghost rows)
  const { data: bookings, error } = await supabase
    .from('wix_bookings')
    .select('id, wix_booking_id, client_full_name, therapist_name, price, session_type, session_count, wix_order_id')
    .not('client_full_name', 'is', null)
    .order('price', { ascending: false });

  if (error) { console.error(error.message); return; }
  console.log(`=== Step 2: Enrich ${bookings.length} bookings ===\n`);

  let enriched = 0, changed = 0;

  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];
    // Skip if already has order ID
    if (b.wix_order_id) {
      process.stdout.write(`[${i + 1}/${bookings.length}] ${b.client_full_name?.padEnd(22)} already has order → skip\n`);
      continue;
    }

    const info = await fetchSessionInfoFromOrder(b.wix_booking_id);
    if (!info) {
      process.stdout.write(`[${i + 1}/${bookings.length}] ${b.client_full_name?.padEnd(22)} no order\n`);
      continue;
    }

    enriched++;
    const update = {
      session_type: info.sessionType,
      session_count: info.sessionCount,
    };
    if (info.orderId) update.wix_order_id = info.orderId;
    if (info.orderNumber) update.wix_order_number = info.orderNumber;

    const typeChanged = info.sessionType !== b.session_type;
    const countChanged = info.sessionCount !== b.session_count;
    if (typeChanged || countChanged || info.orderId) changed++;

    await supabase.from('wix_bookings').update(update).eq('wix_booking_id', b.wix_booking_id);
    await supabase.from('sessions').update({ session_type: info.sessionType, session_count: info.sessionCount }).eq('wix_booking_id', b.wix_booking_id);

    console.log(`[${i + 1}/${bookings.length}] ${b.client_full_name?.padEnd(22)} → order #${info.orderNumber} | ${info.sessionType}/${info.sessionCount} | "${info.descriptionLine}"`);

    if (i % 5 === 4) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nEnriched: ${enriched} | Changed: ${changed}\n`);

  // Step 3: Run package linker
  console.log('=== Step 3: Run package linker ===');
  const { retroactivelyLinkAllPackageSessions } = require('../services/wixPackageLinkerService');
  const linkResult = await retroactivelyLinkAllPackageSessions();
  console.log('Linker result:', linkResult);

  // Step 4: Show final summary
  console.log('\n=== Step 4: Final Summary ===\n');
  const { data: summary } = await supabase
    .from('wix_bookings')
    .select('session_type, session_count, price, client_full_name, therapist_name, wix_order_id, wix_order_number, package_group_id')
    .not('client_full_name', 'is', null)
    .not('session_type', 'eq', 'individual')
    .order('session_type');

  console.log('NON-INDIVIDUAL BOOKINGS:');
  for (const r of (summary || [])) {
    console.log(
      `  ${(r.session_type || '').padEnd(10)} count=${String(r.session_count || 1).padEnd(3)} ₹${(r.price || '0').toString().padEnd(9)} ` +
      `${(r.client_full_name || '').padEnd(22)} ${(r.therapist_name || '').padEnd(22)} ` +
      `order=#${r.wix_order_number || '—'} ${r.package_group_id ? '🔗linked' : ''}`
    );
  }

  // Show linked package sessions
  const { data: linked } = await supabase
    .from('sessions')
    .select('id, wix_booking_id, client_id, psychologist_id, price, session_type, package_group_id, scheduled_date')
    .not('package_group_id', 'is', null)
    .order('package_group_id');

  console.log(`\nLINKED PACKAGE SESSIONS: ${linked?.length || 0}`);
  for (const s of (linked || [])) {
    console.log(`  ${s.scheduled_date} | ₹${s.price || 0} | group=${s.package_group_id?.slice(0, 8)} | ${s.session_type}`);
  }
}

main().catch(console.error);
