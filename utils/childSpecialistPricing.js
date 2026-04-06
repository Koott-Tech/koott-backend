/**
 * Child specialist pricing: stored in psychologists.child_specialist_pricing (jsonb)
 * Synced to packages rows (package_type cs_*) for booking / payments / client_packages.
 */

const TIER_KEYS = ['1', '3', '6', '9', '12plus'];

const VARIANT_DEFS = [
  { key: 'parent_only', suffix: 'parent', shortLabel: 'Parent only' },
  { key: 'child_only', suffix: 'child', shortLabel: 'Child only' },
  { key: 'family', suffix: 'family', shortLabel: 'Family' },
];

/** Default prices from product sheet (excluding promotional code) */
const DEFAULT_CHILD_SPECIALIST_PRICING = {
  initial: {
    parent_only: { durationLabel: '1 hr', durationMinutes: 60, price: 1699 },
    child_only: { durationLabel: '1.5 hr', durationMinutes: 90, price: 1899 },
    family: { durationLabel: '2 hr', durationMinutes: 120, price: 2399 },
  },
  followUpPackages: {
    '1': {
      parent_only: { durationLabel: '1 hr', durationMinutes: 60, price: 1599 },
      child_only: { durationLabel: '1 hr', durationMinutes: 60, price: 1599 },
      family: { durationLabel: '1.5 hr', durationMinutes: 90, price: 1899 },
    },
    '3': {
      parent_only: { durationLabel: '1 hr', durationMinutes: 60, price: 4588 },
      child_only: { durationLabel: '1 hr', durationMinutes: 60, price: 4588 },
      family: { durationLabel: '1.5 hr', durationMinutes: 90, price: 5188 },
    },
    '6': {
      parent_only: { durationLabel: '1 hr', durationMinutes: 60, price: 8988 },
      child_only: { durationLabel: '1 hr', durationMinutes: 60, price: 8988 },
      family: { durationLabel: '1.5 hr', durationMinutes: 90, price: 10188 },
    },
    '9': {
      parent_only: { durationLabel: '1 hr', durationMinutes: 60, price: 13288 },
      child_only: { durationLabel: '1 hr', durationMinutes: 60, price: 13288 },
      family: { durationLabel: '1.5 hr', durationMinutes: 90, price: 15088 },
    },
    '12plus': {
      parent_only: { durationLabel: '1 hr', durationMinutes: 60, price: 17388 },
      child_only: { durationLabel: '1 hr', durationMinutes: 60, price: 17388 },
      family: { durationLabel: '1.5 hr', durationMinutes: 90, price: 19788 },
    },
  },
};

function sessionCountForTier(tierKey) {
  if (tierKey === '12plus') return 12;
  const n = parseInt(tierKey, 10);
  return Number.isFinite(n) ? n : 1;
}

function minInitialPrice(pricing) {
  if (!pricing?.initial) return null;
  let min = null;
  for (const { key } of VARIANT_DEFS) {
    const p = pricing.initial[key]?.price;
    if (p != null && p !== '') {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0 && (min === null || n < min)) min = n;
    }
  }
  return min;
}

/**
 * Normalize partial admin payload into full structure (defaults merged).
 */
function normalizeChildSpecialistPricing(input) {
  const base = JSON.parse(JSON.stringify(DEFAULT_CHILD_SPECIALIST_PRICING));
  if (!input || typeof input !== 'object') return base;

  if (input.initial && typeof input.initial === 'object') {
    for (const { key } of VARIANT_DEFS) {
      if (input.initial[key] && typeof input.initial[key] === 'object') {
        base.initial[key] = {
          ...base.initial[key],
          ...input.initial[key],
          price:
            input.initial[key].price != null && input.initial[key].price !== ''
              ? Number(input.initial[key].price)
              : base.initial[key].price,
        };
      }
    }
  }

  if (input.followUpPackages && typeof input.followUpPackages === 'object') {
    for (const tier of TIER_KEYS) {
      if (!input.followUpPackages[tier]) continue;
      base.followUpPackages[tier] = base.followUpPackages[tier] || {};
      for (const { key } of VARIANT_DEFS) {
        const cell = input.followUpPackages[tier][key];
        if (cell && typeof cell === 'object') {
          base.followUpPackages[tier][key] = {
            ...(base.followUpPackages[tier][key] || {}),
            ...cell,
            price:
              cell.price != null && cell.price !== '' ? Number(cell.price) : base.followUpPackages[tier][key]?.price,
          };
        }
      }
    }
  }

  return base;
}

function validateChildSpecialistPricing(pricing) {
  const errors = [];
  if (!pricing?.initial) {
    errors.push('initial section missing');
    return errors;
  }
  for (const { key, shortLabel } of VARIANT_DEFS) {
    const p = pricing.initial[key]?.price;
    if (!Number.isFinite(Number(p)) || Number(p) <= 0) {
      errors.push(`initial ${shortLabel}: invalid price`);
    }
  }
  for (const tier of TIER_KEYS) {
    const tierObj = pricing.followUpPackages?.[tier];
    if (!tierObj) {
      errors.push(`follow-up tier ${tier} missing`);
      continue;
    }
    for (const { key, shortLabel } of VARIANT_DEFS) {
      const p = tierObj[key]?.price;
      if (!Number.isFinite(Number(p)) || Number(p) <= 0) {
        errors.push(`follow-up ${tier} ${shortLabel}: invalid price`);
      }
    }
  }
  return errors;
}

/**
 * Build rows for packages table (psychologist_id set by caller).
 */
function buildChildSpecialistPackageRows(pricing, psychologistId) {
  const rows = [];
  for (const { key, suffix, shortLabel } of VARIANT_DEFS) {
    const o = pricing.initial[key];
    if (!o || !Number.isFinite(Number(o.price)) || Number(o.price) <= 0) continue;
    const dur = o.durationLabel || '';
    rows.push({
      psychologist_id: psychologistId,
      package_type: `cs_init_${suffix}`,
      name: `Initial session — ${shortLabel}${dur ? ` (${dur})` : ''}`,
      description: `Child specialist initial session — ${shortLabel}`,
      session_count: 1,
      price: Number(o.price),
      discount_percentage: 0,
    });
  }

  for (const tier of TIER_KEYS) {
    const tierObj = pricing.followUpPackages?.[tier];
    if (!tierObj) continue;
    const sessionCount = sessionCountForTier(tier);
    const tierLabel = tier === '12plus' ? '12' : tier;
    for (const { key, suffix, shortLabel } of VARIANT_DEFS) {
      const o = tierObj[key];
      if (!o || !Number.isFinite(Number(o.price)) || Number(o.price) <= 0) continue;
      const dur = o.durationLabel || '';
      rows.push({
        psychologist_id: psychologistId,
        package_type: `cs_fu_${tier}_${suffix}`,
        name: `Follow-up package (${tierLabel} sessions) — ${shortLabel}${dur ? ` (${dur})` : ''}`,
        description: `Child specialist follow-up package — ${tierLabel} sessions, ${shortLabel}`,
        session_count: sessionCount,
        price: Number(o.price),
        discount_percentage: 0,
      });
    }
  }

  return rows;
}

function isChildSpecialistPackageType(packageType) {
  return typeof packageType === 'string' && packageType.startsWith('cs_');
}

/**
 * Remove synced child-specialist rows before re-insert (shared shape with admin).
 */
async function deleteSyncedChildSpecialistPackages(supabaseAdmin, psychologistId) {
  const { data: pkgs } = await supabaseAdmin
    .from('packages')
    .select('id, package_type')
    .eq('psychologist_id', psychologistId);
  const ids = (pkgs || [])
    .filter((p) => p.package_type && String(p.package_type).startsWith('cs_'))
    .map((p) => p.id);
  if (ids.length === 0) return;
  await supabaseAdmin.from('packages').delete().in('id', ids);
}

/**
 * Matches public site / admin edit: child specialist if category set, or structured pricing.initial
 * when category is not explicitly better_parent (legacy / partially migrated rows).
 */
function isChildSpecialistEffective(psych) {
  if (!psych) return false;
  if (psych.specialist_category === 'child_specialist') return true;
  if (psych.specialist_category === 'better_parent') return false;
  const init = psych.child_specialist_pricing?.initial;
  return !!(init && typeof init === 'object');
}

/**
 * If psychologist is child_specialist but cs_init_* packages are missing (admin never synced),
 * build rows from child_specialist_pricing and insert so public booking works.
 */
async function ensureChildSpecialistPackagesSynced(supabaseAdmin, psychologistId) {
  const { data: psych, error: psychErr } = await supabaseAdmin
    .from('psychologists')
    .select('id, specialist_category, child_specialist_pricing')
    .eq('id', psychologistId)
    .single();

  if (psychErr || !psych) {
    return { synced: false, reason: 'psychologist_not_found' };
  }
  if (!isChildSpecialistEffective(psych) || !psych.child_specialist_pricing) {
    return { synced: false, reason: 'not_child_specialist' };
  }

  const { data: existing } = await supabaseAdmin
    .from('packages')
    .select('package_type')
    .eq('psychologist_id', psychologistId);

  const hasCsInit = (existing || []).some((p) =>
    String(p.package_type || '').startsWith('cs_init_')
  );
  if (hasCsInit) {
    return { synced: false, reason: 'already_synced' };
  }

  const norm = normalizeChildSpecialistPricing(psych.child_specialist_pricing);
  const rows = buildChildSpecialistPackageRows(norm, psychologistId);
  if (!rows.length) {
    console.warn('[ensureChildSpecialistPackagesSynced] no rows built from pricing JSON', {
      psychologistId,
    });
    return { synced: false, reason: 'no_rows_built' };
  }

  const errs = validateChildSpecialistPricing(norm);
  if (errs.length > 0) {
    // Still sync rows we can build so public booking works; admin JSON may be partial or legacy-shaped
    console.warn(
      '[ensureChildSpecialistPackagesSynced] pricing validation warnings; inserting built package rows anyway:',
      errs
    );
  }

  await supabaseAdmin
    .from('packages')
    .delete()
    .eq('psychologist_id', psychologistId)
    .eq('package_type', 'individual');

  await deleteSyncedChildSpecialistPackages(supabaseAdmin, psychologistId);

  const { error: insErr } = await supabaseAdmin.from('packages').insert(rows);
  if (insErr) {
    console.error('[ensureChildSpecialistPackagesSynced] insert failed:', insErr);
    return { synced: false, reason: 'insert_failed', error: insErr };
  }

  const minP = minInitialPrice(norm);
  if (minP != null) {
    await supabaseAdmin
      .from('psychologists')
      .update({ individual_session_price: minP, updated_at: new Date().toISOString() })
      .eq('id', psychologistId);
  }

  return { synced: true };
}

module.exports = {
  TIER_KEYS,
  VARIANT_DEFS,
  DEFAULT_CHILD_SPECIALIST_PRICING,
  normalizeChildSpecialistPricing,
  validateChildSpecialistPricing,
  buildChildSpecialistPackageRows,
  minInitialPrice,
  sessionCountForTier,
  isChildSpecialistPackageType,
  deleteSyncedChildSpecialistPackages,
  isChildSpecialistEffective,
  ensureChildSpecialistPackagesSynced,
};
