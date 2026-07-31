/**
 * Fix mislabeled COUPLE PACKAGES so per-session doctor commission computes as
 * couple_package_N instead of (regular package) + (standalone couple).
 *
 * Root cause: a couple package's paid first session is stored as session_type='package'
 * (generic) while the ₹0 follow-ups are session_type='couple' and unlinked. Neither row is
 * ever seen as "couple AND package", so the engine picks the wrong rate.
 *
 * Fix per couple package: set session_type='couple' on ALL members, share one
 * package_group_id, set session_count=N and package_session_number=1..N (price stays on #1).
 *
 * Detection is conservative: only clusters that contain a real paid package anchor
 * (price>0, session_count>1) AND at least one 'couple'-typed member are touched.
 *
 * DRY RUN by default. Pass `--apply` to write.
 *
 *   node scripts/fix-couple-packages.js            # dry run (prints plan + counts)
 *   node scripts/fix-couple-packages.js --apply     # apply the changes
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { computeSessionDoctorWallet } = require('../utils/sessionCommission');

const APPLY = process.argv.includes('--apply');
const MONTH_FROM = '2026-07-01';
const MONTH_TO = '2026-07-31';

const isCoupleType = (s) => String(s.session_type || '').toLowerCase().includes('couple');
const isPackageAnchor = (s) => Number(s.price) > 0 && Number(s.session_count) > 1;

// A couple signal hidden in the Wix payload — catches couple packages whose sessions were
// ALL mislabeled 'package' (so session_type alone gives no hint). Mirrors the mapper.
const hasCouplePayloadSignal = (s) => {
  const p = s.wix_payload || {};
  const txt = [
    p.serviceName, p.title, p.bookingType, p.rawBookedEntity?.title,
    JSON.stringify(p.variantSelections || p.rawFormInfo?.variantSelections || ''),
  ].map(x => String(x || '').toLowerCase()).join(' ');
  return txt.includes('couple') || txt.includes('cpl');
};
const isCouple = (s) => isCoupleType(s) || hasCouplePayloadSignal(s);

const priceEq = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= 2;

(async () => {
  const dcCache = {};
  const getDc = async (pid) => {
    if (dcCache[pid] !== undefined) return dcCache[pid];
    const { data } = await supabase.from('doctor_commissions').select('*').eq('psychologist_id', pid).eq('is_active', true).maybeSingle();
    dcCache[pid] = data || null;
    return dcCache[pid];
  };

  // Ground truth INDIVIDUAL package prices per therapist (packages table: package_N.price).
  const { data: pkgDefs } = await supabase.from('packages').select('psychologist_id,session_count,price,package_type');
  const indivPrice = {}; // indivPrice[pid][count] = price
  (pkgDefs || []).forEach(p => {
    if (/couple/i.test(p.package_type || '')) return; // skip any couple defs
    (indivPrice[p.psychologist_id] = indivPrice[p.psychologist_id] || {})[Number(p.session_count)] = Number(p.price);
  });

  // Derive each therapist's COUPLE package price from their CONFIRMED couple anchors
  // (session_type couple OR payload bookingType/serviceName couple), price>0, count>1.
  // This lets us catch fully-mislabeled couple packages purely by price match.
  const { data: confirmed } = await supabase.from('sessions')
    .select('psychologist_id,price,session_count,session_type,wix_payload')
    .gt('price', 0).gt('session_count', 1).limit(5000);
  const couplePrice = {}; // couplePrice[pid][count] = price
  (confirmed || []).forEach(s => {
    if (!isCouple(s)) return;
    (couplePrice[s.psychologist_id] = couplePrice[s.psychologist_id] || {})[Number(s.session_count)] = Number(s.price);
  });

  // A package anchor is couple if it has a direct signal, OR its price matches this
  // therapist's derived couple price for that size AND does NOT match the individual price.
  const anchorIsCouple = (a) => {
    if (isCouple(a)) return true;
    const cnt = Number(a.session_count);
    const cp = couplePrice[a.psychologist_id]?.[cnt];
    const ip = indivPrice[a.psychologist_id]?.[cnt];
    if (cp != null && priceEq(a.price, cp) && !(ip != null && priceEq(a.price, ip))) return true;
    return false;
  };

  // (client, psych) pairs that have ANY package/couple anchor this month.
  const { data: monthRows } = await supabase.from('sessions')
    .select('client_id,psychologist_id')
    .or('session_type.ilike.%couple%,session_type.ilike.%package%')
    .gte('scheduled_date', MONTH_FROM).lte('scheduled_date', MONTH_TO).gt('session_count', 1);
  const pairs = [...new Set((monthRows || [])
    .filter(s => s.client_id && s.psychologist_id)
    .map(s => s.client_id + '|' + s.psychologist_id))];

  const packages = [];   // each: { pid, cid, members:[...], anchor }
  for (const pair of pairs) {
    const [cid, pid] = pair.split('|');
    const { data: all } = await supabase.from('sessions')
      .select('id,scheduled_date,scheduled_time,session_type,price,session_count,package_group_id,package_id,package_session_number,status,wix_payload,psychologist_id')
      .eq('client_id', cid).eq('psychologist_id', pid).neq('status', 'cancelled')
      .order('scheduled_date', { ascending: true }).order('scheduled_time', { ascending: true });

    // Greedy: walk chronologically; each paid package anchor consumes the next (N-1) ₹0 follow-ups.
    const rows = all || [];
    const consumed = new Set();
    for (let i = 0; i < rows.length; i++) {
      const anchor = rows[i];
      if (consumed.has(anchor.id) || !isPackageAnchor(anchor)) continue;
      const need = Number(anchor.session_count) - 1;
      const members = [anchor];
      for (let j = i + 1; j < rows.length && members.length < need + 1; j++) {
        const f = rows[j];
        if (consumed.has(f.id)) continue;
        // Stop at the next paid package anchor — its ₹0 follow-ups belong to IT, not this one.
        if (isPackageAnchor(f)) break;
        if (Number(f.price) === 0) { members.push(f); }
      }
      members.forEach(m => consumed.add(m.id));
      // Couple package if the ANCHOR is couple (direct signal or price match), or any member is.
      if (anchorIsCouple(anchor) || members.some(isCouple)) {
        packages.push({ pid, cid, anchor, members });
      }
    }
  }

  let sessionsToRetag = 0, sessionsToRelink = 0, packagesFixed = 0, packagesAlreadyOk = 0;
  const therapists = new Set();
  let totalBefore = 0, totalAfter = 0;

  for (const pkg of packages) {
    const dc = await getDc(pkg.pid);
    // Preserve the DECLARED package size — a couple package of 3 with only 2 sessions booked
    // must stay N=3 (dividing commission by 2 would over-credit the doctor).
    const N = Number(pkg.anchor.session_count) > 0 ? Number(pkg.anchor.session_count) : pkg.members.length;
    const groupId = pkg.anchor.package_group_id || pkg.anchor.id;

    // Build the target for each member; skip the whole package if nothing changes.
    const plan = pkg.members.map((m, k) => {
      // Number by position in the reconstructed group (avoids stale numbers from a prior
      // grouping colliding — e.g. two members both carrying package_session_number 2).
      const num = k + 1;
      const target = { session_type: 'couple', session_count: N, package_group_id: groupId, package_session_number: num };
      const changed =
        String(m.session_type || '').toLowerCase() !== 'couple' ||
        Number(m.session_count) !== N ||
        m.package_group_id !== groupId ||
        Number(m.package_session_number) !== num;
      return { m, target, changed, retag: String(m.session_type || '').toLowerCase() !== 'couple' };
    });

    if (!plan.some(p => p.changed)) { packagesAlreadyOk++; continue; }

    packagesFixed++;
    therapists.add(pkg.pid);
    console.log(`\n— therapist ${pkg.pid.slice(0, 8)} · client ${pkg.cid.slice(0, 8)} · ${N}-session couple package · group ${String(groupId).slice(0, 8)}`);
    for (const p of plan) {
      const { m, target } = p;
      const before = computeSessionDoctorWallet(m, dc, null);
      const after = computeSessionDoctorWallet({ ...m, ...target }, dc, null);
      totalBefore += before; totalAfter += after;
      if (p.retag) sessionsToRetag++;
      if (p.changed) sessionsToRelink++;
      console.log(`   #${target.package_session_number} ${m.scheduled_date} ${m.session_type}/${m.session_count} ₹${m.price} → couple/${N} ${p.changed ? '[CHANGE]' : '[ok]'} | doctor ₹${before} → ₹${after}`);
      if (APPLY && p.changed) {
        const { error } = await supabase.from('sessions').update({ ...target, updated_at: new Date().toISOString() }).eq('id', m.id);
        if (error) console.error(`     ✗ update failed: ${error.message}`);
      }
    }
  }

  console.log(`\n===== SUMMARY (${APPLY ? 'APPLIED' : 'DRY RUN'}) =====`);
  console.log(`Couple packages needing fix:      ${packagesFixed}`);
  console.log(`Couple packages already correct:  ${packagesAlreadyOk}`);
  console.log(`Therapists affected:              ${therapists.size}`);
  console.log(`Sessions retagged to 'couple':    ${sessionsToRetag}`);
  console.log(`Sessions relinked (group/count):  ${sessionsToRelink}`);
  console.log(`Doctor commission total  before:  ₹${totalBefore}`);
  console.log(`Doctor commission total  after:   ₹${totalAfter}`);
  console.log(`Net change:                       ₹${totalAfter - totalBefore}`);
  if (!APPLY) console.log(`\n(dry run — re-run with --apply to write)`);
})();
