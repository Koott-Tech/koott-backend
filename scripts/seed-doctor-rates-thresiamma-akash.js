/**
 * One-time / repeatable: commission + company amounts for therapists from ops sheet:
 * - Thresiamma
 * - Akash Mohan
 *
 * Resolves psychologists by substring match on combined name, aligns package rows by
 * price (nearest), then inserts a NEW active doctor_commissions row (previous active rows
 * deactivated) — same behaviour as PUT /finance/commissions/:id.
 *
 * Run from backend folder:
 *   node scripts/seed-doctor-rates-thresiamma-akash.js
 *
 * Requires .env / Supabase credentials (same as server).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabaseAdmin } = require('../config/supabase');

const TODAY = new Date().toISOString().split('T')[0];

const DEFINITIONS = [
  {
    nameMatch: (full) =>
      full.includes('thresiamma'),
    sheet: {
      /** Single-session price from sheet (client pays); doctor ₹900 → company ₹799 */
      individualSessionPrice: 1699,
      doctorFirstIndividual: 900,
      doctorFollowIndividual: null,
      coupleDoctorPerSession: 1350,
      /** Non-individual package tiers: matched to DB packages by full price ascending */
      packageTiers: [
        { price: 6199, doctorFirst: 3600, doctorFollow: null },
        { price: 7599, doctorFirst: 4050, doctorFollow: null },
      ],
    },
  },
  {
    nameMatch: (full) => full.includes('akash') && full.includes('mohan'),
    sheet: {
      individualSessionPrice: 1999,
      doctorFirstIndividual: 1100,
      doctorFollowIndividual: 1200,
      coupleDoctorPerSession: 1700,
      packageTiers: [
        { price: 7499, doctorFirst: 4700, doctorFollow: 4800 },
        { price: 8499, doctorFirst: 5300, doctorFollow: 5400 },
      ],
    },
  },
];

function fullName(row) {
  return `${String(row.first_name || '').trim()} ${String(row.last_name || '').trim()}`
    .trim()
    .toLowerCase();
}

function nearestTier(pkgPrice, tiers) {
  let best = null;
  let bestDist = Infinity;
  for (const t of tiers) {
    const d = Math.abs(Number(pkgPrice) - t.price);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 150 ? best : null;
}

async function loadPsychologists() {
  const { data, error } = await supabaseAdmin.from('psychologists').select('id, first_name, last_name, email');
  if (error) throw error;
  return data || [];
}

async function fetchPackages(psychologistId) {
  const { data, error } = await supabaseAdmin
    .from('packages')
    .select('id, package_type, price, session_count, name')
    .eq('psychologist_id', psychologistId)
    .order('price', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function deactivatePrevious(psychologistId) {
  const { error } = await supabaseAdmin
    .from('doctor_commissions')
    .update({
      is_active: false,
      effective_to: TODAY,
      updated_at: new Date().toISOString(),
    })
    .eq('psychologist_id', psychologistId)
    .eq('is_active', true);
  if (error && !String(error.message || '').includes('is_active')) {
    console.warn('Deactivate warning:', error.message);
  }

  /** Unique (psychologist_id, effective_from) — remove prior row for today's date before re-inserting (idempotent reruns). */
  await supabaseAdmin
    .from('doctor_commissions')
    .delete()
    .eq('psychologist_id', psychologistId)
    .eq('effective_from', TODAY);
}

async function upsertCommissions(psychologistId, row) {
  const firstPkgCommission = Object.entries(row.commission_amounts).find(
    ([key]) => key !== 'individual' && key !== 'couple'
  );

  const base = {
    psychologist_id: psychologistId,
    effective_from: TODAY,
    is_active: true,
    commission_percentage: 0,
    notes: `Seeded from finance sheet (${TODAY}) — Thresiamma / Akash Mohan`,
    commission_amounts: row.commission_amounts,
    commission_amount_individual: row.commission_amounts.individual,
    commission_amount_package: firstPkgCommission ? firstPkgCommission[1] : null,
    doctor_commission_first_session: row.doctor_commission_first_session,
    doctor_commission_packages: row.doctor_commission_packages,
    updated_at: new Date().toISOString(),
  };
  if (row.doctor_commission_followup != null && row.doctor_commission_followup !== '') {
    base.doctor_commission_followup = row.doctor_commission_followup;
  }

  const { error } = await supabaseAdmin.from('doctor_commissions').insert(base);
  if (error) throw error;
}

async function touchIndividualPrice(psychologistId, price) {
  const { error } = await supabaseAdmin
    .from('psychologists')
    .update({ individual_session_price: price })
    .eq('id', psychologistId);
  if (error) {
    console.warn(`Could not set individual_session_price for ${psychologistId}:`, error.message);
  }
}

function buildCommissionPayload(psychologistId, def, pkgs, psychName) {
  const { sheet } = def;
  const tiers = [...sheet.packageTiers].sort((a, b) => a.price - b.price);

  /** @type Record<string, number> */
  const commission_amounts = {};
  const companyIndividual = sheet.individualSessionPrice - sheet.doctorFirstIndividual;
  commission_amounts.individual = Math.max(0, companyIndividual);

  const doctor_commission_packages = {
    couple_session: sheet.coupleDoctorPerSession,
    cpl_session: sheet.coupleDoctorPerSession,
  };

  const nonIndividualPkgs = pkgs.filter((p) => String(p.package_type || '').toLowerCase() !== 'individual');

  if (tiers.length && nonIndividualPkgs.length !== tiers.length && nonIndividualPkgs.length > 0) {
    console.warn(
      `[${psychName}] Package count (${nonIndividualPkgs.length}) differs from sheet tiers (${tiers.length}). Matching by nearest price.`
    );
  }

  /** When psychologists have no `packages` rows yet, tier rates are saved under guessed types (often package_3 / package_6). Adjust if your DB uses different package_type values and re-run. */
  const GUESSED_PACKAGE_TYPES = ['package_3', 'package_6', 'package_9', 'package_12'];

  if (!nonIndividualPkgs.length && tiers.length) {
    console.warn(
      `[${psychName}] No catalog packages in DB — storing sheet tiers against ${tiers.map((_, i) => GUESSED_PACKAGE_TYPES[i]).join(', ')}. Add/rename packages rows to match package_type OR re-run this script after packages exist.`
    );
    tiers.forEach((tier, idx) => {
      const pkgType = GUESSED_PACKAGE_TYPES[idx] || `tier_${tier.price}`;
      commission_amounts[pkgType] = Math.max(0, tier.price - tier.doctorFirst);
      doctor_commission_packages[`${pkgType}_first_session`] = tier.doctorFirst;
      if (tier.doctorFollow != null && tier.doctorFollow !== '') {
        doctor_commission_packages[`${pkgType}_followup`] = tier.doctorFollow;
      }
      console.log(
        `[${psychName}] ${pkgType} ₹${tier.price} → doctor first ₹${tier.doctorFirst}${tier.doctorFollow != null ? `, follow ₹${tier.doctorFollow}` : ''} (guess — no packages row)`
      );
    });
    return {
      commission_amounts,
      doctor_commission_first_session: sheet.doctorFirstIndividual,
      doctor_commission_followup:
        sheet.doctorFollowIndividual != null ? sheet.doctorFollowIndividual : undefined,
      doctor_commission_packages,
    };
  }

  for (const pkg of nonIndividualPkgs) {
    const price = Number(pkg.price) || 0;
    const tier = nearestTier(price, tiers);
    if (!tier) {
      console.warn(
        `[${psychName}] Skipping package id=${pkg.id} type="${pkg.package_type}" price=${price}: no tier within ₹150`
      );
      continue;
    }
    const pkgType = pkg.package_type || `package_${pkg.session_count}`;
    commission_amounts[pkgType] = Math.max(0, price - tier.doctorFirst);
    const firstKey = `${pkgType}_first_session`;
    const followKey = `${pkgType}_followup`;
    doctor_commission_packages[firstKey] = tier.doctorFirst;
    if (tier.doctorFollow != null && tier.doctorFollow !== '') {
      doctor_commission_packages[followKey] = tier.doctorFollow;
    }

    console.log(
      `[${psychName}] ${pkg.name || pkgType} ₹${price} → doctor first ₹${tier.doctorFirst}${tier.doctorFollow != null ? `, follow ₹${tier.doctorFollow}` : ''} (tier sheet ₹${tier.price})`
    );
  }

  return {
    commission_amounts,
    doctor_commission_first_session: sheet.doctorFirstIndividual,
    doctor_commission_followup:
      sheet.doctorFollowIndividual != null ? sheet.doctorFollowIndividual : undefined,
    doctor_commission_packages,
  };
}

async function processOne(psychologists, def) {
  const found = psychologists.filter((p) => def.nameMatch(fullName(p)));
  if (found.length === 0) {
    console.error('No psychologist matched:', def.sheet);
    return;
  }
  if (found.length > 1) {
    console.warn('Multiple psychologists matched — using first row:', found.map(fullName));
  }
  const p = found[0];
  const psychName = fullName(p);

  const pkgs = await fetchPackages(p.id);
  const payload = buildCommissionPayload(p.id, def, pkgs, psychName);

  await touchIndividualPrice(p.id, def.sheet.individualSessionPrice);

  console.log(`${psychName} (${p.id}): individual company ₹${payload.commission_amounts.individual}, couple doctor ₹${def.sheet.coupleDoctorPerSession}`);

  await deactivatePrevious(p.id);
  await upsertCommissions(p.id, payload);

  console.log(`✔ Inserted active doctor_commissions for ${psychName}`);
}

(async () => {
  try {
    const psychologists = await loadPsychologists();
    for (const def of DEFINITIONS) {
      await processOne(psychologists, def);
    }
    console.log('Done.');
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
