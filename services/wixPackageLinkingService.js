/**
 * Wix package linking — group ₹0 follow-up bookings under their parent package booking.
 *
 * Wix doesn't expose package linkage directly, but the data is consistent enough to infer:
 *   - Package booking = high paid amount (session_type='package')
 *   - Follow-up sessions of the same package = ₹0 bookings by the same contact_id + service_id
 *
 * This service finds those follow-ups and stamps them with:
 *   - package_parent_booking_id = the package row's wix_booking_id
 *   - session_index = 2..N (1 is reserved for the package row itself)
 */

const { supabaseAdmin } = require('../config/supabase');

/**
 * Link package sessions for the entire wix_bookings table.
 * Idempotent — safe to run after every sync.
 * Returns { packagesProcessed, childrenLinked }.
 */
async function linkPackageSessions() {
  // 0. Reset existing child links so re-runs produce clean, deterministic state.
  //    (Cheap — only clears ~tens of rows. Children are rebuilt below.)
  await supabaseAdmin
    .from('wix_bookings')
    .update({ package_parent_booking_id: null, session_index: null })
    .not('package_parent_booking_id', 'is', null);

  // 1. Fetch every package row (the anchors)
  const { data: packages, error: pkgErr } = await supabaseAdmin
    .from('wix_bookings')
    .select('wix_booking_id, contact_id, service_id, client_email, session_count, start_time')
    .eq('session_type', 'package')
    .order('start_time', { ascending: true });

  if (pkgErr) {
    console.warn('[wixPackageLinking] failed to fetch packages:', pkgErr.message);
    return { packagesProcessed: 0, childrenLinked: 0 };
  }
  if (!packages?.length) return { packagesProcessed: 0, childrenLinked: 0 };

  // 2. For each package, find ₹0 children and stamp them
  let childrenLinked = 0;

  for (const pkg of packages) {
    if (!pkg.client_email) continue;
    const cap = Math.max(0, (pkg.session_count || 1) - 1); // children = total - 1 (package row counts as #1)

    // Match by client_email (always present) + service_id (same therapist's service).
    // ₹0 child rows often have null contact_id, so contact_id can't be the primary key.
    let q = supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id, start_time, package_parent_booking_id, session_index, price, payload')
      .neq('wix_booking_id', pkg.wix_booking_id)
      .in('price', ['0', '0.00', '0.0', 0])
      .gte('start_time', pkg.start_time || '1970-01-01')
      .ilike('client_email', pkg.client_email)
      .order('start_time', { ascending: true });

    if (pkg.service_id) q = q.eq('service_id', pkg.service_id);

    const { data: rawCandidates, error: childErr } = await q.limit(cap + 20); // fetch extra to account for filtered-out coupon rows

    // Exclude bookings that are ₹0 due to a coupon (not plan-credit children).
    // Real package children have isPlanCreditBooking=true; coupon-free individual
    // sessions have isPlanCreditBooking=false and a couponDetails entry.
    const candidates = (rawCandidates || []).filter(c => {
      const p = c.payload || {};
      // If explicitly marked as NOT a plan credit booking, skip it
      if (p.isPlanCreditBooking === false) return false;
      // If a coupon was applied and it's not a plan credit, skip it
      if (p.paymentDetails?.couponDetails?.couponId && !p.isPlanCreditBooking) return false;
      return true;
    }).slice(0, cap);
    if (childErr) {
      console.warn(`[wixPackageLinking] child query failed for ${pkg.wix_booking_id}:`, childErr.message);
      continue;
    }
    if (!candidates?.length) {
      // Still mark the package row itself with session_index=1
      await supabaseAdmin
        .from('wix_bookings')
        .update({ session_index: 1 })
        .eq('wix_booking_id', pkg.wix_booking_id);
      continue;
    }

    // Stamp each child with parent + index
    const updates = candidates.slice(0, cap).map((c, i) => ({
      wix_booking_id: c.wix_booking_id,
      package_parent_booking_id: pkg.wix_booking_id,
      session_index: i + 2, // 1 is the package row, children start at 2
    }));

    for (const u of updates) {
      const { error: updErr } = await supabaseAdmin
        .from('wix_bookings')
        .update({
          package_parent_booking_id: u.package_parent_booking_id,
          session_index: u.session_index,
          // Copy parent's package size so each child row knows "of N"
          session_count: pkg.session_count || null,
        })
        .eq('wix_booking_id', u.wix_booking_id);
      if (!updErr) childrenLinked++;
    }

    // Mark the package row as session_index = 1
    await supabaseAdmin
      .from('wix_bookings')
      .update({ session_index: 1 })
      .eq('wix_booking_id', pkg.wix_booking_id);
  }

  return { packagesProcessed: packages.length, childrenLinked };
}

module.exports = { linkPackageSessions };
