/**
 * Google Calendar / Meet event length in minutes from `packages.package_type`.
 * Child specialist `cs_*` types follow the product sheet; default remains 50 (therapy slots).
 */
function getMeetEventDurationMinutes(packageType) {
  if (!packageType || typeof packageType !== 'string') return 50;

  const pt = packageType.trim();

  if (pt.startsWith('cs_init_')) {
    if (pt.endsWith('_parent')) return 60;
    if (pt.endsWith('_child')) return 90;
    if (pt.endsWith('_family')) return 120;
  }

  if (pt.startsWith('cs_fu_')) {
    const m = /^cs_fu_[^_]+_(parent|child|family)$/.exec(pt);
    if (m) {
      if (m[1] === 'parent' || m[1] === 'child') return 60;
      if (m[1] === 'family') return 90;
    }
  }

  return 50;
}

/** Human-readable length for receipts / UI (matches frontend booking copy). */
function formatDurationHuman(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return null;
  if (m === 90) return '1.5 hrs';
  if (m % 60 === 0) {
    const h = m / 60;
    if (h === 1) return '1 hr';
    if (h === Math.floor(h)) return `${h} hrs`;
    return `${h} hrs`;
  }
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (rem === 0) return h === 1 ? '1 hr' : `${h} hrs`;
    return `${h} hr ${rem} min`;
  }
  return `${m} min`;
}

/**
 * Pick minutes for emails/WhatsApp/.ics when optional fields are present.
 * Precedence: explicit durationMinutes → parsed sessionDuration string → packageInfo.packageType → default 50.
 */
function resolveSessionDurationMinutes(payload = {}) {
  const { durationMinutes, sessionDuration, packageInfo } = payload;
  if (typeof durationMinutes === 'number' && Number.isFinite(durationMinutes) && durationMinutes > 0) {
    return Math.round(durationMinutes);
  }
  if (typeof sessionDuration === 'string') {
    const m = sessionDuration.match(/(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  if (packageInfo?.packageType && typeof packageInfo.packageType === 'string') {
    return getMeetEventDurationMinutes(packageInfo.packageType);
  }
  return 50;
}

module.exports = { getMeetEventDurationMinutes, resolveSessionDurationMinutes, formatDurationHuman };
