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
/**
 * Zero-price child candidates, fetched once for the whole run.
 *
 * This used to be one SELECT per package inside the loop. With 1,372 package rows that was
 * ~1,372 round-trips every sync cycle — and the sync runs on a timer — to rebuild the same
 * few dozen links. It was the single largest consumer of outbound bandwidth on the service.
 * One pass over the ~950 zero-price rows gives the same information.
 *
 * `payload` is NOT selected: the two flags the filter needs are extracted server-side, which
 * keeps this to a few hundred KB instead of pulling a raw Wix blob per row.
 */
async function fetchZeroPriceCandidates() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .select(
        'wix_booking_id, start_time, client_email, service_id, package_parent_booking_id, session_index, session_count, ' +
        'is_plan_credit:payload->>isPlanCreditBooking, coupon_id:payload->paymentDetails->couponDetails->>couponId'
      )
      .in('price', ['0', '0.00', '0.0', 0])
      .order('start_time', { ascending: true })
      .range(offset, offset + 999);
    if (error) return { rows: null, error };
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { rows, error: null };
}

/** `payload->>isPlanCreditBooking` comes back as the string 'true'/'false', or null. */
const isPlanCredit = (c) => c.is_plan_credit === 'true' || c.is_plan_credit === true;
const notPlanCredit = (c) => c.is_plan_credit === 'false' || c.is_plan_credit === false;

async function linkPackageSessions() {
  // 1. Fetch every package row (the anchors).
  //
  // Paged: PostgREST caps a response at 1000 rows and this query had no range, so with 1372
  // package rows the oldest 372 were silently never processed — their children were never
  // linked and nothing reported a problem.
  const packages = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error: pkgErr } = await supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id, contact_id, service_id, client_email, session_count, start_time, session_index')
      .eq('session_type', 'package')
      .order('start_time', { ascending: true })
      .range(offset, offset + 999);
    if (pkgErr) {
      console.warn('[wixPackageLinking] failed to fetch packages:', pkgErr.message);
      return { packagesProcessed: 0, childrenLinked: 0 };
    }
    packages.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  if (!packages.length) return { packagesProcessed: 0, childrenLinked: 0 };

  const { rows: zeroPriced, error: candErr } = await fetchZeroPriceCandidates();
  if (candErr) {
    console.warn('[wixPackageLinking] failed to fetch child candidates:', candErr.message);
    return { packagesProcessed: 0, childrenLinked: 0 };
  }

  // Index candidates by client so each package scans only its own client's rows.
  const byClient = new Map();
  for (const c of zeroPriced) {
    const key = String(c.client_email || '').toLowerCase();
    if (!key) continue;
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(c);
  }

  // 2. For each package, find its ₹0 children and stamp them.
  let childrenLinked = 0;
  // Children are claimed on a first-come basis in start_time order. Because packages are
  // processed OLDEST FIRST, an older package would otherwise greedily swallow ₹0 sessions that
  // belong to a package the client bought later (Wix gives us no direct package linkage, so
  // membership is inferred). Tracking what's already claimed stops one package stealing
  // another's sessions — the cause of "3/3 complete" when only session 1 of each had run.
  const claimedChildren = new Set();
  // Desired end state, computed first so the writes below can be limited to actual changes.
  const desired = new Map(); // wix_booking_id -> { parent, index, session_count }

  for (const pkg of packages) {
    if (!pkg.client_email) continue;
    const cap = Math.max(0, (pkg.session_count || 1) - 1); // children = total - 1 (package row counts as #1)

    // The next package purchase by ANY client acts as an upper bound only when it belongs to the
    // same client+service; computed per-package below from this client's own later packages.
    const nextPkgStart = packages
      .filter((p) => p.wix_booking_id !== pkg.wix_booking_id
        && String(p.client_email || '').toLowerCase() === String(pkg.client_email || '').toLowerCase()
        && (!pkg.service_id || p.service_id === pkg.service_id)
        && p.start_time && pkg.start_time && p.start_time > pkg.start_time)
      .map((p) => p.start_time)
      .sort()[0] || null;

    // Same predicates the per-package query used: match on client_email (always present) plus
    // service_id (same therapist's service), at or after the package's own start.
    // ₹0 child rows often have null contact_id, so contact_id can't be the primary key.
    const candidates = (byClient.get(String(pkg.client_email || '').toLowerCase()) || []).filter((c) => {
      if (c.wix_booking_id === pkg.wix_booking_id) return false;
      if (!c.start_time || c.start_time < (pkg.start_time || '1970-01-01')) return false;
      if (pkg.service_id && c.service_id !== pkg.service_id) return false;
      // Exclude bookings that are ₹0 due to a coupon (not plan-credit children).
      // Real package children have isPlanCreditBooking=true; coupon-free individual
      // sessions have isPlanCreditBooking=false and a couponDetails entry.
      if (notPlanCredit(c)) return false;
      if (c.coupon_id && !isPlanCredit(c)) return false;
      // Already claimed by an earlier package in this same run — never double-assign.
      if (claimedChildren.has(c.wix_booking_id)) return false;
      // Don't reach past the client's NEXT package purchase; those sessions are its credits.
      if (nextPkgStart && c.start_time >= nextPkgStart) return false;
      return true;
    }).slice(0, cap);

    // The package row itself is always session 1.
    desired.set(pkg.wix_booking_id, { parent: undefined, index: 1, session_count: undefined });

    candidates.forEach((c, i) => {
      claimedChildren.add(c.wix_booking_id);
      desired.set(c.wix_booking_id, {
        parent: pkg.wix_booking_id,
        index: i + 2, // 1 is the package row, children start at 2
        session_count: pkg.session_count || null,
      });
    });
  }

  // 3. Write only what actually differs.
  //
  // The previous version cleared every child link and re-stamped every package on every run,
  // so a cycle that changed nothing still issued ~1,400 writes. The assignment is almost always
  // identical to last cycle, so comparing first makes the steady state nearly free.
  const current = new Map();
  zeroPriced.forEach((c) => current.set(c.wix_booking_id, c));
  packages.forEach((p) => { if (!current.has(p.wix_booking_id)) current.set(p.wix_booking_id, p); });

  for (const [id, want] of desired) {
    const have = current.get(id);
    if (!have) continue;
    const patch = {};
    if (want.parent !== undefined && have.package_parent_booking_id !== want.parent) {
      patch.package_parent_booking_id = want.parent;
    }
    if (have.session_index !== want.index) patch.session_index = want.index;
    if (want.session_count !== undefined && have.session_count !== want.session_count) {
      patch.session_count = want.session_count;
    }
    if (!Object.keys(patch).length) continue;

    const { error: updErr } = await supabaseAdmin
      .from('wix_bookings')
      .update(patch)
      .eq('wix_booking_id', id);
    if (!updErr && patch.package_parent_booking_id) childrenLinked++;
  }

  // Deliberately NOT clearing links this run did not re-derive.
  //
  // The previous version opened with a blanket reset of every package_parent_booking_id, then
  // rebuilt them one UPDATE at a time. Sampling production during a cycle shows the effect:
  // the count drops to 0 and climbs back one row at a time, so for most of each cycle package
  // children read as unlinked — and finance reads that. Other code paths (admin manual package
  // creation, wixPackageLinkerService) also create links, and the reset destroyed those too.
  //
  // Only ever adding and correcting leaves the data strictly more stable than before. A link
  // that genuinely needs removing is a separate concern from this job's purpose.

  return { packagesProcessed: packages.length, childrenLinked };
}

module.exports = { linkPackageSessions };
