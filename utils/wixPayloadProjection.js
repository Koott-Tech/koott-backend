/**
 * Narrow projection of `sessions.wix_payload` for bulk finance queries.
 *
 * `wix_payload` is a ~2.4KB JSONB blob per row (see the note in
 * sessionController.getSessions). Bulk finance scans page over the whole year —
 * several thousand rows — so selecting the full blob pulls tens of MB from
 * Supabase into this service on every dashboard load, of which only a handful
 * of scalars are ever read.
 *
 * Every consumer that runs on a bulk finance row set is covered here:
 *   utils/sessionBookingCreatedAt.getSessionBookingCreatedAtIso
 *     → createdDate | _createdDate | createdAt
 *       | rawBookedEntity.{createdDate,_createdDate,createdAt}
 *       | booking.{createdDate,createdAt}
 *   utils/sessionBookingCreatedAt.getFinanceBookingDedupeKey
 *     → sessionId
 *   utils/sessionBookingCreatedAt.getSessionFinanceRevenueAmount
 *     → paymentDetails.balance.finalPrice.amount
 *     → paymentDetails.balance.amountReceived
 *   utils/sessionCommission + services/commissionCalculationService
 *     → bookingType | booking_type | session_type
 *
 * PostgREST extracts these server-side via `->`/`->>`, so the blob never leaves
 * Postgres. rehydrateWixPayload() then rebuilds a minimal object under the
 * original `wix_payload` key, so no downstream consumer has to change.
 *
 * If a field is ever added to a bulk consumer, add it in BOTH places below.
 */

/** Aliases are prefixed so they cannot collide with a real sessions column. */
const PROJECTION = [
  ['wpx_session_id', 'wix_payload->>sessionId'],
  ['wpx_booking_type', 'wix_payload->>bookingType'],
  ['wpx_booking_type_snake', 'wix_payload->>booking_type'],
  ['wpx_session_type', 'wix_payload->>session_type'],
  ['wpx_created_date', 'wix_payload->>createdDate'],
  ['wpx_created_date_us', 'wix_payload->>_createdDate'],
  ['wpx_created_at', 'wix_payload->>createdAt'],
  ['wpx_raw_created_date', 'wix_payload->rawBookedEntity->>createdDate'],
  ['wpx_raw_created_date_us', 'wix_payload->rawBookedEntity->>_createdDate'],
  ['wpx_raw_created_at', 'wix_payload->rawBookedEntity->>createdAt'],
  ['wpx_bk_created_date', 'wix_payload->booking->>createdDate'],
  ['wpx_bk_created_at', 'wix_payload->booking->>createdAt'],
  ['wpx_final_price', 'wix_payload->paymentDetails->balance->finalPrice->>amount'],
  ['wpx_amount_received', 'wix_payload->paymentDetails->balance->>amountReceived'],
];

/**
 * Comma-terminated select fragment, drop-in replacement for `wix_payload` in a
 * bulk `.select(...)`. Terminated with a comma to match the surrounding style
 * of appendBookingTimeSelectFragment.
 */
const WIX_PAYLOAD_FINANCE_SELECT = PROJECTION.map(([alias, path]) => `${alias}:${path}`).join(',');

/** Drop a key only if it has a usable value, so `?.` chains behave as before. */
function put(target, key, value) {
  if (value !== null && value !== undefined && value !== '') target[key] = value;
}

/**
 * Rebuild a minimal `wix_payload` from the projected aliases and strip them.
 * Mutates and returns the same array for cheapness on multi-thousand-row sets.
 *
 * A row with no Wix data at all gets `wix_payload = null`, matching what the
 * full column would have returned for a non-Wix session.
 */
function rehydrateWixPayload(rows) {
  if (!Array.isArray(rows)) return rows;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    // Already carries a real payload (a fallback query ran) — leave it alone.
    if (row.wix_payload && typeof row.wix_payload === 'object') continue;

    const payload = {};
    put(payload, 'sessionId', row.wpx_session_id);
    put(payload, 'bookingType', row.wpx_booking_type);
    put(payload, 'booking_type', row.wpx_booking_type_snake);
    put(payload, 'session_type', row.wpx_session_type);
    put(payload, 'createdDate', row.wpx_created_date);
    put(payload, '_createdDate', row.wpx_created_date_us);
    put(payload, 'createdAt', row.wpx_created_at);

    const raw = {};
    put(raw, 'createdDate', row.wpx_raw_created_date);
    put(raw, '_createdDate', row.wpx_raw_created_date_us);
    put(raw, 'createdAt', row.wpx_raw_created_at);
    if (Object.keys(raw).length) payload.rawBookedEntity = raw;

    const bk = {};
    put(bk, 'createdDate', row.wpx_bk_created_date);
    put(bk, 'createdAt', row.wpx_bk_created_at);
    if (Object.keys(bk).length) payload.booking = bk;

    const balance = {};
    put(balance, 'amountReceived', row.wpx_amount_received);
    if (row.wpx_final_price !== null && row.wpx_final_price !== undefined && row.wpx_final_price !== '') {
      balance.finalPrice = { amount: row.wpx_final_price };
    }
    if (Object.keys(balance).length) payload.paymentDetails = { balance };

    row.wix_payload = Object.keys(payload).length ? payload : null;

    for (const [alias] of PROJECTION) delete row[alias];
  }

  return rows;
}

module.exports = {
  WIX_PAYLOAD_FINANCE_SELECT,
  rehydrateWixPayload,
  PROJECTION,
};
