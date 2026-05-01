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
  if (!b) return 'individual';

  // 0. Pre-detected by Velo enrichBookingItem (uses variant selections + price ratio)
  if (b.bookingType && b.bookingType !== 'individual') return b.bookingType;

  const title = String(b.title || b.rawBookedEntity?.title || '').toLowerCase();
  
  // 1. Explicit Keywords in Title or Variants
  const variantStr = JSON.stringify(b.variantSelections || b.rawFormInfo?.variantSelections || '').toLowerCase();
  const fullText = `${title} ${variantStr}`;

  if (fullText.includes('couple')) return 'couple';
  if (fullText.includes('assessment')) return 'assessment';
  if (fullText.includes('discovery')) return 'discovery';
  if (fullText.includes('pack') || fullText.includes('bundle') || fullText.includes('membership') || fullText.includes('plan')) return 'package';

  // 2. Pricing Plan check
  if (b.pricingPlanInfo) return 'package';

  // 3. Fallback to Price Ratio — lowered to 1.3x to catch couple sessions (e.g. 2299/1499=1.53)
  const catalogRate = parseFloat(b.rawBookedEntity?.rate?.defaultVariedPrice?.amount ?? 0);
  const actualPaid  = parseFloat(b._resolvedPrice ?? b.paymentDetails?.balance?.finalPrice?.amount ?? b.price ?? 0);
  if (catalogRate > 0 && actualPaid > 0 && actualPaid >= catalogRate * 1.3) {
    return 'package';
  }

  return 'individual';
}

/**
 * Estimate number of sessions purchased.
 * Prioritizes text-based extraction (e.g. "Pack of 4") over math.
 */
function sessionCountFromBooking(b) {
  if (!b) return 1;

  // 0. Pre-detected by Velo enrichBookingItem
  if (b.detectedSessionCount && b.detectedSessionCount > 1) return b.detectedSessionCount;

  const title = String(b.title || b.rawBookedEntity?.title || '').toLowerCase();
  const planName = String(b.pricingPlanInfo?.planName || '').toLowerCase();
  const variantStr = JSON.stringify(b.variantSelections || b.rawFormInfo?.variantSelections || '').toLowerCase();
  const combinedText = `${title} ${planName} ${variantStr}`;

  // 1. Try to find a digit in "Pack of X" or "X sessions" pattern
  const match = combinedText.match(/(\d+)\s*sessions?/i) || 
                combinedText.match(/pack\s*of\s*(\d+)/i) ||
                combinedText.match(/(\d+)\s*pack/i) ||
                combinedText.match(/(\d+)\s*bundle/i);
  
  if (match && match[1]) {
    const count = parseInt(match[1], 10);
    if (count > 0) return count;
  }

  // 2. Couple/assessment types are always 1 session per booking
  if (combinedText.includes('couple') || combinedText.includes('assessment') || combinedText.includes('discovery')) {
    return 1;
  }

  // 3. Price-ratio math
  const catalogRate = parseFloat(b?.rawBookedEntity?.rate?.defaultVariedPrice?.amount ?? 0);
  const actualPaid  = parseFloat(b?._resolvedPrice ?? b?.paymentDetails?.balance?.finalPrice?.amount ?? b?.price ?? 0);
  
  if (catalogRate > 0 && actualPaid > 0) {
    const ratio = actualPaid / catalogRate;
    if (ratio >= 1.3) {
      // Common discount patterns with real Koott data:
      // 7499/1999 = 3.75 → 4 sessions | 3499/999 = 3.50 → 4 sessions
      // 2499/749 = 3.33 → 4 sessions  | 2999/999 = 3.00 → 3 sessions
      if (ratio > 3.1 && ratio < 4) return 4;
      if (ratio > 2.1 && ratio < 3.1) return 3;
      const count = Math.round(ratio);
      return count >= 2 ? count : 2;
    }
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
  const paymentState = String(b.paymentDetails?.state || '').toUpperCase();
  const isZeroPayment = paymentState === 'UNDEFINED' || paymentState === 'FREE' || parseFloat(finalPriceAmount || '-1') === 0;

  const resolvedPrice = isZeroPayment ? 0 : (finalPriceAmount != null && parseFloat(finalPriceAmount) > 0 ? finalPriceAmount : (planPrice ?? b.price ?? rate?.amount ?? null));
  const resolvedCurrency = (finalPriceAmount != null && parseFloat(finalPriceAmount) > 0) ? finalPriceCurrency : (planCurrency || b.currency || rate?.currency || null);

  // For type/count detection, inject the resolved price so ratio math uses
  // the actual paid amount rather than the catalog rate stored in b.price.
  const augmented = resolvedPrice != null && parseFloat(resolvedPrice) > 0
    ? { ...b, _resolvedPrice: resolvedPrice }
    : b;

  return {
    wix_booking_id: String(b.id),
    wix_session_id: b.sessionId || null,
    schedule_id: b.scheduleId || null,
    service_id: b.serviceId || null,
    contact_id: b.contactId || b.client?.contactId || null,
    status: normalizeWixStatusToSessionStatus(b.status),
    title: b.title != null ? String(b.title) : null,
    session_type: sessionTypeFromBooking(augmented),
    session_count: sessionCountFromBooking(augmented),
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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

function toIST(isoLike) {
  if (!isoLike) return null;
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS);
}

function isoDate(isoLike) {
  const d = toIST(isoLike);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function isoTime(isoLike) {
  const d = toIST(isoLike);
  if (!d) return null;
  return d.toISOString().slice(11, 19);
}

/** Wix/client booking creation instant (when they paid / placed the booking), not our sync instant. */
function wixBookingCreatedIso(b) {
  if (!b || typeof b !== 'object') return null;
  const candidates = [
    b.createdDate,
    b._createdDate,
    b.createdAt,
    b.rawBookedEntity?.createdDate,
    b.rawBookedEntity?._createdDate,
    b.booking?.createdDate,
  ].filter(Boolean);
  for (const c of candidates) {
    const d = new Date(String(c));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
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
  const paymentState = String(b.paymentDetails?.state || '').toUpperCase();
  const isZeroPayment = paymentState === 'UNDEFINED' || paymentState === 'FREE' || parseFloat(finalPaid || '-1') === 0;

  const amount = isZeroPayment ? 0 : parseAmount(
    (finalPaid != null && parseFloat(finalPaid) > 0) ? finalPaid : (planPriceRaw ?? b.price ?? b.rawBookedEntity?.rate?.defaultVariedPrice?.amount)
  );
  const fromWixInstant = wixBookingCreatedIso(b);
  /** Keep sessions.created_at aligned with Wix booking time when payload provides it */
  const createdAt = fromWixInstant || new Date().toISOString();
  const updatedAt = new Date().toISOString();

  return {
    wix_booking_id: b.id != null ? String(b.id) : null,
    source: 'wix',
    session_type: sessionTypeFromBooking(b) || 'individual',
    session_count: sessionCountFromBooking(b),
    status: normalizeWixStatusToSessionStatus(b.status),
    scheduled_date: isoDate(b.startTime),
    scheduled_time: isoTime(b.startTime),
    original_scheduled_date: isoDate(b.startTime),
    original_scheduled_time: isoTime(b.startTime),
    notes: b.title ? String(b.title) : null,
    price: amount,
    amount,
    wix_payload: b,
    booking_created_at: fromWixInstant || createdAt,
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
  wixBookingCreatedIso,
};
