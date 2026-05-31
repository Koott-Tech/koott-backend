/**
 * Single source of truth for doctor_wallet (per-session doctor commission) calculation.
 *
 * Package rule: total package commission is split EQUALLY across all sessions.
 *   e.g. package of 3 with total doctor commission ₹600 → ₹200 per session.
 *   Sessions #2, #3 have price=0 but still earn their share when completed.
 *
 * Priority order:
 *   1. commission_history row (most authoritative — already settled)
 *   2. therapist_commission field (manually overridden by admin)
 *   3. doctor_commissions rates (auto-calculated)
 */

/**
 * @param {object} session  - The session row (must include session_type, price,
 *                            package_id, session_count, package_session_number,
 *                            therapist_commission, id)
 * @param {object|null} dc  - The doctor_commissions row for this psychologist
 * @param {object|null} ch  - The commission_history row for this session (or null)
 * @returns {number}        - doctor_wallet in rupees (≥ 0)
 */
function computeSessionDoctorWallet(session, dc, ch) {
  const s = session || {};

  const isPackage = !!(
    (s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined') ||
    s.session_type === 'package' ||
    (typeof s.session_type === 'string' && s.session_type.toLowerCase().includes('package'))
  );

  const totalSessions = Math.max(1, parseInt(s.session_count, 10) || 1);

  // ── 1. commission_history (already settled — most authoritative) ─────────
  if (ch) {
    const sessionAmt = parseFloat(ch.session_amount || s.price || 0);
    const companyAmt = parseFloat(ch.commission_amount || 0);
    const totalDoc = Math.max(0, sessionAmt - companyAmt);
    return isPackage ? totalDoc / totalSessions : totalDoc;
  }

  // ── 2. therapist_commission (manually set by admin) ──────────────────────
  const tc = parseFloat(s.therapist_commission);
  if (!isNaN(tc) && tc > 0) {
    return isPackage ? tc / totalSessions : tc;
  }

  // ── 3. doctor_commissions rates ──────────────────────────────────────────
  if (!dc) return 0;

  if (isPackage) {
    // Get total package doctor commission from doctor_commission_packages
    // e.g. doctor_commission_packages.package_3_first_session = 600 (total for whole package)
    const pkgPackages = (dc.doctor_commission_packages && typeof dc.doctor_commission_packages === 'object')
      ? dc.doctor_commission_packages : {};
    const pkgKey = `package_${totalSessions}_first_session`;
    let totalPackageCommission = parseFloat(pkgPackages[pkgKey] || dc.doctor_commission_first_session_package || 0);

    // Fallback: derive from (package_price − company_commission) using session #1's price
    if ((!totalPackageCommission || totalPackageCommission <= 0) && parseFloat(s.price || 0) > 0) {
      const pkgAmts = (dc.commission_amounts && typeof dc.commission_amounts === 'object') ? dc.commission_amounts : {};
      const companyCommission = parseFloat(
        pkgAmts[`package_${totalSessions}`] ?? pkgAmts.package ?? dc.commission_amount_package ?? 0
      );
      totalPackageCommission = Math.max(0, parseFloat(s.price) - companyCommission);
    }

    // Per-session share = total ÷ session_count
    return Math.max(0, totalPackageCommission / totalSessions);
  }

  // Non-package: couple session
  const isCoupleSession =
    typeof s.session_type === 'string' &&
    (s.session_type.toLowerCase().includes('couple') || s.session_type.toLowerCase().includes('cpl'));

  if (isCoupleSession) {
    const pkgPackages = (dc.doctor_commission_packages && typeof dc.doctor_commission_packages === 'object')
      ? dc.doctor_commission_packages : {};
    const coupleRate = parseFloat(
      pkgPackages.couple_session ?? pkgPackages.cpl_session ?? dc.doctor_commission_individual ?? 0
    );
    if (coupleRate > 0) return coupleRate;
  }

  // Non-package individual: must have positive price
  const sessionAmt = parseFloat(s.price || 0);
  if (sessionAmt <= 0) return 0;

  const indRate = parseFloat(dc.doctor_commission_first_session || dc.doctor_commission_followup || 0);
  if (indRate > 0) return indRate;

  // Fallback: session price − individual company commission
  const pkgAmts = (dc.commission_amounts && typeof dc.commission_amounts === 'object') ? dc.commission_amounts : {};
  const companyInd = parseFloat(pkgAmts.individual ?? dc.commission_amount_individual ?? 0);
  return Math.max(0, sessionAmt - companyInd);
}

module.exports = { computeSessionDoctorWallet };
