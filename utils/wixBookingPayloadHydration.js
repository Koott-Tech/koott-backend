/**
 * Velo/sync sometimes POSTs therapist-only stubs { id, name, image }. Those must NOT
 * replace a full bookings payload — we merge into the therapist slot and preserve
 * createdDate/startTime/client/payment/etc. from what's already mirrored.
 */

function hasBookingPayloadSemantics(b) {
  if (!b || typeof b !== 'object') return false;
  return !!(
    b.createdDate ||
    b._createdDate ||
    b.createdAt ||
    b.startTime ||
    b.client ||
    b.paymentDetails ||
    b.rawBookedEntity ||
    b.bookedSessionInfo ||
    b.rawBookedEntity?.singleSession
  );
}

function isBareTherapistEnvelope(b) {
  if (!b || typeof b !== 'object') return false;
  if (hasBookingPayloadSemantics(b)) return false;
  const keys = Object.keys(b);
  const allowed = ['id', 'name', 'image', '_id'];
  return keys.length > 0 && keys.length <= 4 && keys.every((k) => allowed.includes(k));
}

function mergeBareTherapistIntoExisting(existingPayload, bareTherapist) {
  if (!existingPayload || typeof existingPayload !== 'object') return existingPayload || bareTherapist;
  if (!isBareTherapistEnvelope(bareTherapist)) return existingPayload;

  const next = { ...existingPayload };

  /** Existing nested therapist object wins for display fields bare might omit */
  next.therapist =
    typeof next.therapist === 'object' && next.therapist
      ? { ...next.therapist, ...bareTherapist }
      : { ...bareTherapist };

  return next;
}

/**
 * Hydrate bookings that arrive as therapist-only envelopes using existing `wix_bookings.payload`.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object[]} bookings
 */
async function hydrateBareTherapistBookings(supabaseAdmin, bookings) {
  const list = Array.isArray(bookings) ? bookings : [];
  if (!list.length) return list;

  const bareIndexes = [];
  const idsNeeded = [];
  list.forEach((b, idx) => {
    if (!b || typeof b !== 'object' || !isBareTherapistEnvelope(b)) return;
    if (b.id == null || String(b.id) === '') return;
    bareIndexes.push(idx);
    idsNeeded.push(String(b.id));
  });

  if (!bareIndexes.length) return list;

  const uniq = [...new Set(idsNeeded)];
  const existingByKey = new Map();

  const chunkSize = 100;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const { data } = await supabaseAdmin.from('wix_bookings').select('wix_booking_id,payload').in('wix_booking_id', chunk);

    for (const r of data || []) {
      const k = r?.wix_booking_id;
      const p = r?.payload;
      if (k != null && p && typeof p === 'object') {
        existingByKey.set(String(k), p);
      }
    }
  }

  const out = [...list];
  let merged = 0;
  let skippedFirstInsert = 0;

  for (const idx of bareIndexes) {
    const b = out[idx];
    const key = String(b.id);
    const existing = existingByKey.get(key);

    if (existing && hasBookingPayloadSemantics(existing)) {
      const combined = mergeBareTherapistIntoExisting(existing, b);
      out[idx] = combined;
      merged += 1;
    } else {
      skippedFirstInsert += 1;
    }
  }

  if (merged > 0) {
    console.log(`[wixBookingHydration] merged ${merged} therapist-only webhook(s) into existing full payloads`);
  }
  if (skippedFirstInsert > 0) {
    console.log(
      `[wixBookingHydration] skipped ${skippedFirstInsert} therapist-only webhook(s): no richer payload stored yet`
    );
  }

  return out;
}

module.exports = {
  hasBookingPayloadSemantics,
  isBareTherapistEnvelope,
  mergeBareTherapistIntoExisting,
  hydrateBareTherapistBookings,
};
