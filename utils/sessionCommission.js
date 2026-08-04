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
 * @param {object}      [opts]              - Optional hints
 * @param {boolean}     [opts.isFirstSession] - true → first-session rate,
 *                                              false → follow-up rate,
 *                                              undefined → legacy fallback
 * @returns {number}        - doctor_wallet in rupees (≥ 0)
 */
function computeSessionDoctorWallet(session, dc, ch, opts) {
  const s = session || {};
  const sessionTypeText = String(s.session_type || '').toLowerCase();
  const payloadText = `${s.wix_payload?.bookingType || ''} ${s.wix_payload?.booking_type || ''} ${s.wix_payload?.session_type || ''}`.toLowerCase();
  const totalSessions = Math.max(1, parseInt(s.session_count, 10) || 1);
  const isCoupleSession = sessionTypeText.includes('couple') ||
    sessionTypeText.includes('cpl') ||
    payloadText.includes('couple') ||
    payloadText.includes('cpl');

  const isPackage = !!(
    (s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined') ||
    totalSessions > 1 ||
    sessionTypeText === 'package' ||
    sessionTypeText.includes('package')
  );

  // ── 1. commission_history (already settled — most authoritative) ─────────
  // commission_history stores per-session amounts (not totals), so no further
  // splitting by totalSessions is needed here.
  if (ch) {
    const sessionAmt = parseFloat(ch.session_amount || s.price || 0);
    const companyAmt = parseFloat(ch.commission_amount || 0);
    const totalDoc = Math.max(0, sessionAmt - companyAmt);
    return Math.round(totalDoc);
  }

  // ── 2. therapist_commission (manually set by admin) ──────────────────────
  // This column stores the PER-SESSION amount, not a whole-package total, so it must NOT be
  // divided by session_count. Verified against live data: of 311 package sessions carrying a
  // value, 273 equal (package_total ÷ N) and ZERO equal the package total.
  // Dividing it again underpaid every package session that has no commission_history row —
  // e.g. a ₹1,000/session 9-pack paid ₹1,000/9 = ₹111, and a ₹100 3-pack paid ₹33.
  const tc = parseFloat(s.therapist_commission);
  if (!isNaN(tc) && tc > 0) {
    return Math.round(tc);
  }

  // ── 3. doctor_commissions rates ──────────────────────────────────────────
  if (!dc) return 0;

  if (isPackage) {
    const pkgPackages = (dc.doctor_commission_packages && typeof dc.doctor_commission_packages === 'object')
      ? dc.doctor_commission_packages : {};

    // Package configs store the doctor's WHOLE-package amount. Split that total
    // equally across completed package sessions, using the caller's first/follow-up hint.
    const packageType = isCoupleSession ? `couple_package_${totalSessions}` : `package_${totalSessions}`;
    const fallbackPackageType = `package_${totalSessions}`;
    const isFirst = opts?.isFirstSession;
    const firstKeys = [
      `${packageType}_first_session`,
      `${fallbackPackageType}_first_session`,
      'doctor_commission_first_session_package'
    ].filter(Boolean);
    const followupKeys = [
      `${packageType}_followup`,
      `${fallbackPackageType}_followup`,
      'doctor_commission_followup_package'
    ].filter(Boolean);
    const orderedKeys = isFirst === true
      ? [...firstKeys, ...followupKeys]
      : (isFirst === false ? [...followupKeys, ...firstKeys] : [...followupKeys, ...firstKeys]);

    let totalPackageCommission = parseFloat(
      orderedKeys.reduce((value, key) => {
        if (value != null) return value;
        return Object.prototype.hasOwnProperty.call(pkgPackages, key) ? pkgPackages[key] : dc[key];
      }, null) ?? 0
    );

    if ((!totalPackageCommission || totalPackageCommission <= 0) && isCoupleSession) {
      const couplePerSession = parseFloat(pkgPackages.couple_session ?? pkgPackages.cpl_session ?? dc.doctor_commission_individual ?? 0);
      if (Number.isFinite(couplePerSession) && couplePerSession > 0) {
        totalPackageCommission = couplePerSession * totalSessions;
      }
    }

    if ((!totalPackageCommission || totalPackageCommission <= 0) && parseFloat(s.price || 0) > 0) {
      const pkgAmts = (dc.commission_amounts && typeof dc.commission_amounts === 'object') ? dc.commission_amounts : {};
      const companyCommission = parseFloat(
        pkgAmts[packageType] ?? pkgAmts[fallbackPackageType] ?? pkgAmts.package ?? dc.commission_amount_package ?? 0
      );
      totalPackageCommission = Math.max(0, parseFloat(s.price) - companyCommission);
    }
    return Math.max(0, Math.round(totalPackageCommission / totalSessions));
  }

  // Non-package: couple session
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

  // When the caller knows whether this is a first or follow-up session, pick
  // the matching rate directly. Otherwise fall back to the legacy chain which
  // prefers first-session (backward-compatible for callers that don't track it).
  const isFirst = opts?.isFirstSession;
  let indRate;
  if (isFirst === true) {
    indRate = parseFloat(dc.doctor_commission_first_session || dc.doctor_commission_followup || 0);
  } else if (isFirst === false) {
    indRate = parseFloat(dc.doctor_commission_followup || dc.doctor_commission_first_session || 0);
  } else {
    // Legacy fallback (isFirstSession not provided)
    indRate = parseFloat(dc.doctor_commission_first_session || dc.doctor_commission_followup || 0);
  }
  if (indRate > 0) return indRate;

  // Fallback: session price − individual company commission
  const pkgAmts = (dc.commission_amounts && typeof dc.commission_amounts === 'object') ? dc.commission_amounts : {};
  const companyInd = parseFloat(pkgAmts.individual ?? dc.commission_amount_individual ?? 0);
  return Math.max(0, sessionAmt - companyInd);
}

module.exports = { computeSessionDoctorWallet };
