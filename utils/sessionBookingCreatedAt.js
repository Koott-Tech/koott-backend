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
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function pickFromWixPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const nested =
    payload.rawBookedEntity?.createdDate ??
    payload.rawBookedEntity?._createdDate ??
    payload.rawBookedEntity?.createdAt ??
    payload.booking?.createdDate ??
    payload.booking?.createdAt;
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

/** YYYY-MM-DD for `isoInstant` in a given IANA zone (Asia/Kolkata = Wix site list for LC India). */
function getCalendarYmdInTimeZone(iso, timeZone = 'Asia/Kolkata') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).slice(0, 10);
  } catch {
    return '';
  }
}

/** IST calendar booking day — aligns with Wix Admin “today” for India site. */
function getSessionBookingCreatedIstDateString(sessionRow) {
  const iso = getSessionBookingCreatedAtIso(sessionRow);
  return getCalendarYmdInTimeZone(iso, 'Asia/Kolkata');
}

/** Legacy UTC booking day — prefer {@link getSessionBookingCreatedIstDateString} for Wix parity. */
function getSessionBookingCreatedUtcDateString(sessionRow) {
  const iso = getSessionBookingCreatedAtIso(sessionRow);
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
}

/**
 * Stable key so one client checkout/booking counts once on the finance dashboard.
 * Packages / Wix Booking may create multiple DB session rows sharing the same payment or Wix `sessionId`.
 *
 * Rows from Wix (`source === 'wix'`) with a payload but missing `sessionId` are omitted (empty key);
 * those do not appear in Wix Admin order/booking totals and inflated our counts vs Wix.
 */
function getFinanceBookingDedupeKey(sessionRow) {
  if (!sessionRow || typeof sessionRow !== 'object') return '';
  const pid = sessionRow.payment_id;
  if (pid != null && String(pid).trim() !== '') return `payment:${String(pid).trim()}`;

  const src = String(sessionRow.source || '').toLowerCase();
  const wp = sessionRow.wix_payload;
  if (src === 'wix') {
    if (wp && typeof wp === 'object') {
      const sid = wp.sessionId;
      if (sid != null && String(sid).trim() !== '') {
        return `wixBooking:${String(sid).trim()}`;
      }
    }
    // Fall back to wix_booking_id or row id so the booking is still counted
    const wbid = sessionRow.wix_booking_id;
    if (wbid != null && String(wbid).trim() !== '') return `wixRow:${String(wbid).trim()}`;
    if (sessionRow.id != null && String(sessionRow.id).trim() !== '') return `row:${String(sessionRow.id)}`;
    return '';
  }

  if (wp && typeof wp === 'object' && wp.sessionId != null && String(wp.sessionId).trim() !== '') {
    return `wixBooking:${String(wp.sessionId).trim()}`;
  }
  if (sessionRow.id != null && String(sessionRow.id).trim() !== '') {
    return `row:${String(sessionRow.id)}`;
  }
  return '';
}

function countDistinctFinanceBookings(sessionRows) {
  const keys = new Set();
  if (!sessionRows || !Array.isArray(sessionRows)) return 0;
  for (let i = 0; i < sessionRows.length; i++) {
    const k = getFinanceBookingDedupeKey(sessionRows[i]);
    if (k) keys.add(k);
  }
  return keys.size;
}

/**
 * Recognized revenue for a session row — aligns with Wix Stores “Sales” when `sessions.price` lags
 * the paid amount on `wix_payload.paymentDetails.balance.finalPrice.amount` / `amountReceived`.
 */
function getSessionFinanceRevenueAmount(sessionRow) {
  if (!sessionRow || typeof sessionRow !== 'object') return 0;
  const db = parseFloat(sessionRow.price) || 0;
  const wp = sessionRow.wix_payload;
  const src = String(sessionRow.source || '').toLowerCase();
  if (wp && typeof wp === 'object') {
    const fp = wp.paymentDetails?.balance?.finalPrice?.amount;
    const fpNum = fp != null ? parseFloat(fp) : NaN;
    if (Number.isFinite(fpNum) && fpNum >= 0) {
      // For Wix-sourced rows use the actual Wix payment amount; only fall back to db price
      // if Wix payload has no price, to avoid inflating revenue from stale sessions.price values
      return src === 'wix' ? fpNum : Math.max(fpNum, db);
    }
    const ar = wp.paymentDetails?.balance?.amountReceived;
    const arNum = ar != null ? parseFloat(ar) : NaN;
    if (Number.isFinite(arNum) && arNum >= 0) {
      return src === 'wix' ? arNum : Math.max(arNum, db);
    }
  }
  return db;
}

module.exports = {
  parseIsoFlexible,
  pickFromWixPayload,
  getSessionBookingCreatedAtIso,
  getCalendarYmdInTimeZone,
  getSessionBookingCreatedIstDateString,
  getSessionBookingCreatedUtcDateString,
  getFinanceBookingDedupeKey,
  countDistinctFinanceBookings,
  getSessionFinanceRevenueAmount,
};
