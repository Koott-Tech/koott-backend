/**
 * Canonical "when the client booked": Wix payloads expose createdDate / _createdDate / createdAt.
 * Persisted column `booking_created_at` is preferred once migrations ran; derive from payload as fallback.
 */
function parseIsoFlexible(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function pickFromWixPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const nested =
    payload.rawBookedEntity?.createdDate ??
    payload.rawBookedEntity?._createdDate ??
    payload.booking?.createdDate;
  const direct =
    payload.createdDate ??
    payload._createdDate ??
    payload.createdAt ??
    nested;
  return parseIsoFlexible(direct);
}

/** @returns {string|null} ISO timestamp */
function getSessionBookingCreatedAtIso(sessionRow) {
  if (!sessionRow || typeof sessionRow !== 'object') return null;

  const col = parseIsoFlexible(sessionRow.booking_created_at);
  if (col) return col;

  if (
    sessionRow.source === 'wix' ||
    sessionRow.wix_booking_id ||
    (sessionRow.wix_payload && typeof sessionRow.wix_payload === 'object')
  ) {
    const fromPayload = pickFromWixPayload(sessionRow.wix_payload);
    if (fromPayload) return fromPayload;
  }

  return parseIsoFlexible(sessionRow.created_at);
}

module.exports = {
  parseIsoFlexible,
  pickFromWixPayload,
  getSessionBookingCreatedAtIso,
};
