/**
 * Map one normalized discover booking row → Supabase `wix_bookings` insert/upsert shape.
 * Payload matches live koott.in discover `sections.bookings.sample` items.
 */

/**
 * Extract the session/booking type from a Wix booking object.
 * Wix can expose this via tags, bookedEntity.type, or a known keyword in the title.
 * Returns a normalised lowercase string like "individual", "package", "class", or null.
 */
function sessionTypeFromBooking(b) {
  if (!b) return null;

  // 1. Explicit pricingPlanInfo → Wix Pricing Plan (package) booking
  if (b.pricingPlanInfo) return 'package';

  // 2. Price ratio: if the client paid ≥ 2× the per-session catalog rate
  //    it means multiple sessions were bundled → treat as package.
  //    Catalog rate lives in rawBookedEntity.rate.defaultVariedPrice.amount.
  const catalogRate = parseFloat(b.rawBookedEntity?.rate?.defaultVariedPrice?.amount ?? 0);
  const actualPaid  = parseFloat(b.paymentDetails?.balance?.finalPrice?.amount ?? 0);
  if (catalogRate > 0 && actualPaid > 0 && actualPaid >= catalogRate * 2) {
    return 'package';
  }

  // 3. Explicit bookingType from Velo enrichment
  if (b.bookingType) {
    const bt = String(b.bookingType).toLowerCase();
    if (bt === 'package' || bt.includes('pack') || bt.includes('plan')) return 'package';
  }

  // 4. Tags (Wix INDIVIDUAL = private/one-on-one; COURSE = multi-session course)
  const tags = Array.isArray(b.tags) ? b.tags : [];
  for (const tag of tags) {
    const t = String(tag || '').toLowerCase();
    if (t === 'course' || t.includes('pack') || t.includes('bundle') || t.includes('membership')) return 'package';
    if (t.includes('class') || t.includes('group') || t.includes('workshop')) return 'class';
  }

  // 5. Service title keywords
  const title = String(b.title || b.rawBookedEntity?.title || '').toLowerCase();
  if (title.includes('pack') || title.includes('bundle') || title.includes('membership') || title.includes('course')) return 'package';
  if (title.includes('class') || title.includes('group') || title.includes('workshop')) return 'class';

  // Default: individual (private one-on-one session)
  return 'individual';
}

/**
 * Estimate number of sessions purchased.
 * Only meaningful for package bookings (actualPaid >= 2× catalogRate).
 * Returns the rounded count for packages, 1 for individuals, null when data missing.
 */
function sessionCountFromBooking(b) {
  const catalogRate = parseFloat(b?.rawBookedEntity?.rate?.defaultVariedPrice?.amount ?? 0);
  const actualPaid  = parseFloat(b?.paymentDetails?.balance?.finalPrice?.amount ?? 0);
  if (catalogRate <= 0 || actualPaid <= 0) return null;
  // Only compute multi-session count when it clearly qualifies as a package
  if (actualPaid >= catalogRate * 2) {
    const count = Math.round(actualPaid / catalogRate);
    return count >= 2 ? count : null;
  }
  return 1;
}

function therapistNameFromBooking(b) {
  if (!b) return null;
  if (typeof b.therapist === 'string') return b.therapist;
  if (b.therapist && typeof b.therapist === 'object') {
    return (
      b.therapist.name ||
      b.therapist.displayName ||
      b.therapist.fullName ||
      null
    );
  }
  return null;
}

function discoverRowToDb(booking) {
  const b = booking;
  if (!b || b.id == null || b.id === '' || b.id === 'null' || b.id === 'undefined') {
    return null;
  }
  const first = b.client?.firstName ?? null;
  const last = b.client?.lastName ?? null;
  const full =
    b.client?.fullName ||
    [first, last].filter(Boolean).join(' ').trim() ||
    null;

  const rate = b.rawBookedEntity?.rate?.defaultVariedPrice;
  const finalPriceAmount   = b.paymentDetails?.balance?.finalPrice?.amount ?? null;
  const finalPriceCurrency = b.paymentDetails?.balance?.finalPrice?.currency ?? null;
  const planPrice =
    b.pricingPlanInfo?.priceDetails?.price ??
    b.pricingPlanInfo?.price?.value ??
    b.pricingPlanInfo?.totalPrice ??
    null;
  const planCurrency =
    b.pricingPlanInfo?.priceDetails?.currency ??
    b.pricingPlanInfo?.price?.currency ??
    null;
  // Priority: actual charged (finalPrice) > pricing plan > catalog rate > payload price
  const useFinal = finalPriceAmount != null && parseFloat(finalPriceAmount) > 0;
  const resolvedPrice    = useFinal ? finalPriceAmount : (planPrice ?? b.price ?? rate?.amount ?? null);
  const resolvedCurrency = useFinal ? finalPriceCurrency : (planCurrency || b.currency || rate?.currency || null);

  return {
    wix_booking_id: String(b.id),
    wix_session_id: b.sessionId || null,
    schedule_id: b.scheduleId || null,
    service_id: b.serviceId || null,
    contact_id: b.contactId || b.client?.contactId || null,
    status: normalizeWixStatusToSessionStatus(b.status),
    title: b.title != null ? String(b.title) : null,
    session_type: sessionTypeFromBooking(b),
    session_count: sessionCountFromBooking(b),
    therapist_name: therapistNameFromBooking(b),
    tags: Array.isArray(b.tags) ? b.tags : b.tags != null ? b.tags : null,
    start_time: b.startTime || null,
    end_time: b.endTime || null,
    client_first_name: first,
    client_last_name: last,
    client_full_name: full,
    client_email: b.client?.email || null,
    client_phone: b.client?.phone || null,
    price: resolvedPrice != null ? String(resolvedPrice) : null,
    currency: resolvedCurrency || null,
    location: b.location != null ? String(b.location) : null,
    payload: b,
    updated_at: new Date().toISOString(),
    synced_at: new Date().toISOString(),
  };
}

function normalizeWixStatusToSessionStatus(status) {
  const s = String(status ?? '').trim().toLowerCase();
  // Treat blank, literal "undefined", or "null" as the default
  if (!s || s === 'undefined' || s === 'null') return 'booked';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('complete')) return 'completed';
  if (s.includes('no_show') || s.includes('noshow')) return 'no_show';
  if (s.includes('book') || s.includes('confirm') || s.includes('pending') || s.includes('approve')) return 'booked';
  return s;
}

function parseAmount(value) {
  if (value == null || value === '') return null;
  const n = Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function isoDate(isoLike) {
  if (!isoLike) return null;
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isoTime(isoLike) {
  if (!isoLike) return null;
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(11, 19);
}

function discoverRowToSessionDb(booking) {
  const b = booking || {};
  if (!b || b.id == null || b.id === '' || b.id === 'null' || b.id === 'undefined') {
    return null;
  }
  const finalPaid = b.paymentDetails?.balance?.finalPrice?.amount ?? null;
  const planPriceRaw =
    b.pricingPlanInfo?.priceDetails?.price ??
    b.pricingPlanInfo?.price?.value ??
    b.pricingPlanInfo?.totalPrice ??
    null;
  const useFinalPaid = finalPaid != null && parseFloat(finalPaid) > 0;
  const amount = parseAmount(
    useFinalPaid ? finalPaid : (planPriceRaw ?? b.price ?? b.rawBookedEntity?.rate?.defaultVariedPrice?.amount)
  );
  const createdAt = b.createdDate || new Date().toISOString();
  const updatedAt = new Date().toISOString();

  return {
    wix_booking_id: b.id != null ? String(b.id) : null,
    source: 'wix',
    session_type: sessionTypeFromBooking(b) || 'individual',
    status: normalizeWixStatusToSessionStatus(b.status),
    scheduled_date: isoDate(b.startTime),
    scheduled_time: isoTime(b.startTime),
    original_scheduled_date: isoDate(b.startTime),
    original_scheduled_time: isoTime(b.startTime),
    notes: b.title ? String(b.title) : null,
    price: amount,
    amount,
    wix_payload: b,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

module.exports = {
  discoverRowToDb,
  discoverRowToSessionDb,
  normalizeWixStatusToSessionStatus,
  therapistNameFromBooking,
  sessionTypeFromBooking,
  sessionCountFromBooking,
};
