/**
 * Fix Sreelakshmi N's package commissions (₹66.67 → ₹100) for July 2026 onward.
 *
 * Source of truth: "Therapist Price Category.xlsx", sheet "New Pricing &%", row block
 * "Lakshmy" (= Sreelakshmi N). Package commission = whole-package total, split equally
 * by session count.
 *
 * Three defects, all data (the divide logic itself is correct):
 *   1. CONFIG: package_N_first_session stored ₹100 short of the sheet
 *      (200/500/800 instead of 300/600/900) → 200÷3 = ₹66.67 instead of ₹100.
 *   2. SESSIONS: therapist_commission holds an already-divided per-session value (66.67).
 *      The engine divides it AGAIN for packages (66.67÷3 = ₹22), so it must be cleared
 *      to let the (now correct) config drive the amount.
 *   3. commission_history: rows hold the stale ₹66.66, and a settlement job ran TWICE
 *      so every session has 2 rows. Stored rows override the engine, so the dashboard
 *      keeps showing ₹67 until these are de-duplicated and corrected.
 *
 * DRY RUN by default. Pass --apply to write.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { computeSessionDoctorWallet } = require('../utils/sessionCommission');

const APPLY = process.argv.includes('--apply');
const FROM = '2026-07-01';
const TO = '2026-12-31';

// From the Excel sheet (block "Lakshmy")
const EXCEL = {
  package_3_first_session: 300, package_3_followup: 300,
  package_6_first_session: 600, package_6_followup: 600,
  package_9_first_session: 900, package_9_followup: 900,
  couple_session: 0,
  couple_package_3_first_session: 150, couple_package_3_followup: 150,
};

(async () => {
  const { data: ps } = await supabase.from('psychologists').select('id,first_name,last_name').ilike('first_name', 'Sreelakshmi%');
  const p = ps[0];
  const { data: dc } = await supabase.from('doctor_commissions').select('*').eq('psychologist_id', p.id).eq('is_active', true).single();

  // ── 1. CONFIG ────────────────────────────────────────────────────────────
  const pk = { ...(dc.doctor_commission_packages || {}) };
  console.log('=== 1. CONFIG (doctor_commission_packages) ===');
  Object.entries(EXCEL).forEach(([k, v]) => {
    if (Number(pk[k]) !== Number(v)) console.log(`   ${k}: ${pk[k] === undefined ? 'MISSING' : pk[k]} → ${v}`);
    pk[k] = v;
  });
  if (APPLY) {
    const { error } = await supabase.from('doctor_commissions')
      .update({ doctor_commission_packages: pk, updated_at: new Date().toISOString() }).eq('id', dc.id);
    console.log(error ? '   ✗ ' + error.message : '   ✅ config updated');
  }
  const fixedDc = { ...dc, doctor_commission_packages: pk };

  // ── 2. SESSIONS: clear the already-divided therapist_commission on packages ──
  const { data: ss } = await supabase.from('sessions')
    .select('id,scheduled_date,session_type,price,session_count,package_session_number,therapist_commission,package_id,package_group_id,wix_payload')
    .eq('psychologist_id', p.id).gte('scheduled_date', FROM).lte('scheduled_date', TO).order('scheduled_date');
  const pkgSessions = ss.filter((s) => Number(s.session_count) > 1 && s.therapist_commission != null);
  console.log(`\n=== 2. SESSIONS: clear polluted therapist_commission (${pkgSessions.length} package rows) ===`);
  pkgSessions.slice(0, 5).forEach((s) => console.log(`   ${s.scheduled_date}: therapist_commission ${s.therapist_commission} → null`));
  if (APPLY && pkgSessions.length) {
    for (const s of pkgSessions) {
      await supabase.from('sessions').update({ therapist_commission: null }).eq('id', s.id);
    }
    console.log(`   ✅ cleared on ${pkgSessions.length} sessions`);
  }
  // reflect the clear locally so the recompute below is accurate
  ss.forEach((s) => { if (Number(s.session_count) > 1) s.therapist_commission = null; });

  // ── 3. commission_history: de-duplicate + correct ─────────────────────────
  const ids = ss.map((s) => s.id);
  let ch = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('commission_history').select('*').in('session_id', ids.slice(i, i + 100)).order('created_at');
    ch.push(...(data || []));
  }
  const bySession = {};
  ch.forEach((c) => (bySession[c.session_id] = bySession[c.session_id] || []).push(c));

  const dupIds = [];
  Object.values(bySession).forEach((rows) => {
    rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    rows.slice(1).forEach((r) => dupIds.push(r.id));   // keep earliest
  });
  console.log(`\n=== 3. commission_history ===`);
  console.log(`   rows: ${ch.length} | sessions: ${Object.keys(bySession).length} | duplicates to delete: ${dupIds.length}`);
  const notPending = ch.filter((c) => c.payment_status !== 'pending');
  if (notPending.length) { console.error(`   ABORT: ${notPending.length} rows already paid out — not touching settled money.`); process.exit(1); }

  if (APPLY && dupIds.length) {
    for (let i = 0; i < dupIds.length; i += 50) {
      const { error } = await supabase.from('commission_history').delete().in('id', dupIds.slice(i, i + 50));
      if (error) console.error('   ✗ dup delete:', error.message);
    }
    console.log(`   ✅ deleted ${dupIds.length} duplicate rows`);
  }

  // Correct the surviving row for each session
  const sMap = {}; ss.forEach((s) => (sMap[s.id] = s));
  let changed = 0;
  console.log('   corrections (doctor amount):');
  for (const [sid, rows] of Object.entries(bySession)) {
    const keep = rows[0];
    const s = sMap[sid]; if (!s) continue;
    // ONLY package rows. Individual rows are already correct: this therapist's Excel block
    // has individual_first = ₹0 and followup = ₹100, so the stored ₹0 on a client's FIRST
    // session is intentional. (The engine can't reproduce it — `first_session || followup`
    // treats the legitimate 0 as falsy and falls through to 100 — so recomputing individual
    // rows here would wrongly overwrite correct ₹0 values with ₹100.)
    if (!(Number(s.session_count) > 1)) continue;
    const sessionAmount = parseFloat(keep.session_amount ?? s.price ?? 0) || 0;
    const doctor = computeSessionDoctorWallet(s, fixedDc, null);
    const company = sessionAmount - doctor;
    const oldDoctor = Number(keep.session_amount) - Number(keep.commission_amount);
    if (Math.round(oldDoctor) === Math.round(doctor)) continue;
    changed++;
    if (changed <= 8) console.log(`     ${s.scheduled_date} ${s.session_type}/${s.session_count || 1}: ₹${oldDoctor.toFixed(2)} → ₹${doctor}`);
    if (APPLY) {
      const { error } = await supabase.from('commission_history')
        .update({ commission_amount: company, updated_at: new Date().toISOString() }).eq('id', keep.id);
      if (error) console.error('   ✗ update:', error.message);
    }
  }
  console.log(`   rows needing correction: ${changed}`);
  console.log(`\n===== ${APPLY ? 'APPLIED' : 'DRY RUN'} =====`);
  if (!APPLY) console.log('re-run with --apply to write');
})();
