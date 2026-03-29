const { supabaseAdmin } = require('../config/supabase');

/**
 * Derive the number of sessions that belong to a package.
 * Attempts the following (in order):
 * 1. Numeric session_count/total_sessions present on the record
 * 2. Parse the first integer from the package_type (e.g. "package_3")
 * 3. Fallback value (defaults to 1)
 *
 * @param {Object} pkg - Package-like payload (can be packages row or client_packages row with nested package)
 * @param {number} fallback - Fallback value when no valid number is found
 * @returns {number}
 */
const deriveSessionCount = (pkg = {}, fallback = 1) => {
  if (!pkg) return fallback;

  const directValue = pkg.session_count ?? pkg.total_sessions ?? pkg?.package?.session_count ?? pkg?.package?.total_sessions;
  const numericValue = Number(directValue);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue;
  }

  const typeSource = pkg.package_type || pkg?.package?.package_type || '';
  const match = String(typeSource).match(/\d+/);
  if (match) {
    const parsed = Number(match[0]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
};

/**
 * Count sessions that consume a slot toward the package quota for this client + catalog package.
 * Matches getClientPackages / bookRemainingSession: completed + active (non-cancelled, non–no-show).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} clientId
 * @param {string} catalogPackageId - packages.id
 * @returns {Promise<{ error: object|null, used: number }>}
 */
const countSessionsTowardClientPackageQuota = async (supabaseAdmin, clientId, catalogPackageId) => {
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select('id, status')
    .eq('client_id', clientId)
    .eq('package_id', catalogPackageId);

  if (error) {
    return { error, used: 0 };
  }

  let used = 0;
  for (const s of sessions || []) {
    if (s.status === 'completed') {
      used++;
    } else if (!['cancelled', 'no_show', 'noshow'].includes(s.status)) {
      used++;
    }
  }
  return { error: null, used };
};

/**
 * Returns ok: false if the client already has session_count sessions booked/completed for this catalog package.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} clientId
 * @param {object} packageRow - row from packages (must include id, session_count / package_type for deriveSessionCount)
 * @returns {Promise<{ ok: boolean, httpStatus?: number, message?: string, used?: number, limit?: number }>}
 */
const assertClientPackageHasAvailableSlot = async (supabaseAdmin, clientId, packageRow) => {
  if (!packageRow || !packageRow.id) {
    return { ok: true };
  }

  const limit = deriveSessionCount(packageRow);
  if (!Number.isFinite(limit) || limit < 1) {
    return { ok: true };
  }

  const { error, used } = await countSessionsTowardClientPackageQuota(
    supabaseAdmin,
    clientId,
    packageRow.id
  );

  if (error) {
    return {
      ok: false,
      httpStatus: 500,
      message: 'Failed to verify package session quota'
    };
  }

  if (used >= limit) {
    return {
      ok: false,
      httpStatus: 400,
      used,
      limit,
      message:
        'This package has no remaining sessions. All sessions for this package have already been booked or completed.'
    };
  }

  return { ok: true, used, limit };
};

/**
 * Ensure that a client_packages record exists for a package purchase.
 * Will skip creation if a record already exists for the supplied session.
 *
 * @param {Object} params
 * @param {string} params.clientId
 * @param {string} params.psychologistId
 * @param {string} params.packageId
 * @param {string} params.sessionId
 * @param {string} [params.purchasedAt]
 * @param {Object} [params.packageData] - Optional package row to avoid refetch
 * @returns {Promise<{created: boolean, data: Object|null, error: object|null}>}
 */
const ensureClientPackageRecord = async ({
  clientId,
  psychologistId,
  packageId,
  sessionId,
  purchasedAt = new Date().toISOString(),
  packageData = null,
  consumedSessions = 1
}) => {
  if (!clientId || !psychologistId || !packageId) {
    return {
      created: false,
      data: null,
      error: new Error('Missing required fields to create client package record')
    };
  }

  try {
    // Avoid duplicate rows for the same first session
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('client_packages')
      .select('id, client_id, package_id, first_session_id')
      .eq('client_id', clientId)
      .eq('package_id', packageId)
      .eq('first_session_id', sessionId || null)
      .maybeSingle();

    if (existingError && existingError.code !== 'PGRST116') {
      return {
        created: false,
        data: null,
        error: existingError
      };
    }

    if (existing) {
      return {
        created: false,
        data: existing,
        error: null
      };
    }

    let effectivePackage = packageData;
    if (!effectivePackage) {
      const { data: fetchedPackage, error: packageFetchError } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('id', packageId)
        .single();

      if (packageFetchError) {
        return {
          created: false,
          data: null,
          error: packageFetchError
        };
      }

      effectivePackage = fetchedPackage;
    }

    const totalSessions = deriveSessionCount(effectivePackage);
    const consumed = Number.isFinite(consumedSessions) && consumedSessions >= 0
      ? consumedSessions
      : 1;
    const remainingSessions = Math.max(totalSessions - consumed, 0);

    const clientPackagePayload = {
      client_id: clientId,
      psychologist_id: psychologistId,
      package_id: packageId,
      package_type: effectivePackage.package_type,
      total_sessions: totalSessions,
      remaining_sessions: remainingSessions,
      total_amount: effectivePackage.price,
      amount_paid: effectivePackage.price,
      status: remainingSessions > 0 ? 'active' : 'completed',
      purchased_at: purchasedAt,
      first_session_id: sessionId || null
    };

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('client_packages')
      .insert([clientPackagePayload])
      .select('*')
      .single();

    if (insertError) {
      return {
        created: false,
        data: null,
        error: insertError
      };
    }

    return {
      created: true,
      data: inserted,
      error: null
    };
  } catch (error) {
    return {
      created: false,
      data: null,
      error
    };
  }
};

module.exports = {
  deriveSessionCount,
  ensureClientPackageRecord,
  countSessionsTowardClientPackageQuota,
  assertClientPackageHasAvailableSlot
};

