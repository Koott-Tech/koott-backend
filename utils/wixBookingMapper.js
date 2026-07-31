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

  // 0. Wix service tags — most reliable when admin sets them in dashboard.
  const tags = Array.isArray(b.tags) ? b.tags.map(t => String(t).toLowerCase()) : [];
  if (tags.includes('assessment')) return 'assessment';
  if (tags.includes('discovery'))  return 'discovery';
  // Note: 'couple' and 'package' tags are checked AFTER duration so a couple-package
  // is correctly typed as 'couple' (with session_count > 1) rather than 'package'.
  const hasExplicitIndividualTag = tags.includes('individual');
  const hasCoupleTag   = tags.includes('couple');
  const hasPackageTag  = tags.includes('package') || tags.includes('pack') || tags.includes('bundle') || tags.includes('membership');

  // Couple signals gathered from EVERY field up front. A couple PACKAGE must be typed
  // 'couple' (with session_count > 1) so per-session commission computes as couple_package_N
  // — not the generic 'package' rate. Without this, a couple package whose duration isn't
  // > 75 min falls into the bookingType==='package' branch below and is mislabeled 'package',
  // and its ₹0 follow-ups end up as standalone 'couple' — breaking the doctor's commission.
  const _bookingTypeEarly = String(b.bookingType || '').toLowerCase().trim();
  const _serviceNameLc = String(b.serviceName || '').toLowerCase();
  const _titleLc = String(b.title || b.rawBookedEntity?.title || '').toLowerCase();
  const _variantLc = JSON.stringify(b.variantSelections || b.rawFormInfo?.variantSelections || '').toLowerCase();
  const hasCoupleSignal = hasCoupleTag
    || _bookingTypeEarly === 'couple'
    || _serviceNameLc.includes('couple')
    || _titleLc.includes('couple')
    || _variantLc.includes('couple');

  // 1. Duration — runs first because it is the ground truth for couple vs individual.
  //    A 110-min session tagged INDIVIDUAL is still a couple session.
  const durMin = b.sessionDurationMin != null
    ? Number(b.sessionDurationMin)
    : (() => {
        const s = b.startTime || b.rawBookedEntity?.singleSession?.start;
        const e = b.endTime   || b.rawBookedEntity?.singleSession?.end;
        if (!s || !e) return null;
        const m = Math.round((new Date(e) - new Date(s)) / 60000);
        return m > 0 ? m : null;
      })();

  if (durMin != null && durMin > 75) return 'couple';

  // 1.5. Velo-enriched bookingType from Wix discover payload, when present.
  // Keep this after duration so couple sessions still win on actual slot length.
  const bookingType = String(b.bookingType || '').toLowerCase().trim();
  if (bookingType === 'assessment') return 'assessment';
  if (bookingType === 'discovery') return 'discovery';
  if (bookingType === 'package') {
    // Only commit to 'package' when there is evidence of a multi-session series.
    // A single-session plan-credit booking has bookingType='package' from Velo but is
    // effectively individual (session_count=1, no planSessionNumber, no creditsAvailable).
    const count = sessionCountFromBooking(b);
    const hasPsn = b.planSessionNumber != null;
    // A couple package: keep it 'couple' (session_count>1 preserves its package nature).
    if (count > 1 || hasPsn) return hasCoupleSignal ? 'couple' : 'package';
    // Fall through — will be caught by isPlanCredit → individual below
  }
  if (bookingType === 'couple') return 'couple';

  // 2. Now apply couple/package tags (duration didn't fire, so session is ≤75 min)
  if (hasCoupleTag)  return 'couple';
  if (hasPackageTag) return hasCoupleSignal ? 'couple' : 'package';
  // Explicit INDIVIDUAL tag wins over plan-credit signals (moved up so it fires before step 3)
  if (hasExplicitIndividualTag) return 'individual';

  // 3. Pricing plan / subscription signals — only 'package' when session count > 1.
  //    Single-session plan-credit bookings (inPerson + UNDEFINED) must stay 'individual'.
  const _vendor = (
    b.paymentDetails?.wixPayMultipleDetails?.[0]?.paymentVendorName ||
    b.paymentVendorName || ''
  ).toLowerCase();
  const _pState = (b.paymentState || b.paymentDetails?.state || '').toUpperCase();
  const isPlanCredit = !!(b.pricingPlanInfo || b.subscriptionId || b.isPlanCreditBooking ||
    (_vendor === 'inperson' && _pState === 'UNDEFINED'));

  if (isPlanCredit) {
    const count = sessionCountFromBooking(b);
    return count > 1 ? (hasCoupleSignal ? 'couple' : 'package') : 'individual';
  }

  // 4. Short + free → discovery
  if (durMin != null && durMin < 45) {
    const price = parseFloat(b._resolvedPrice ?? b.price ?? b.rawBookedEntity?.rate?.defaultVariedPrice?.amount ?? 1);
    if (price === 0) return 'discovery';
  }

  // 5. Explicit INDIVIDUAL tag
  if (hasExplicitIndividualTag) return 'individual';

  // 6. Service name keywords
  const serviceName = String(b.serviceName || '').toLowerCase();
  if (serviceName.includes('couple'))     return 'couple';
  if (serviceName.includes('assessment')) return 'assessment';
  if (serviceName.includes('discovery'))  return 'discovery';
  if (serviceName.includes('pack') || serviceName.includes('bundle')) return 'package';

  // 7. Title / variant keywords (older data without serviceName/tags)
  const title = String(b.title || b.rawBookedEntity?.title || '').toLowerCase();
  const variantStr = JSON.stringify(b.variantSelections || b.rawFormInfo?.variantSelections || '').toLowerCase();
  const fullText = `${title} ${variantStr}`;

  if (fullText.includes('couple'))     return 'couple';
  if (fullText.includes('assessment')) return 'assessment';
  if (fullText.includes('discovery'))  return 'discovery';
  if (fullText.includes('pack') || fullText.includes('bundle') || fullText.includes('membership')) return 'package';

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
  if (b.creditsAvailable && Number(b.creditsAvailable) > 1) return Number(b.creditsAvailable);

  const title = String(b.title || b.rawBookedEntity?.title || '').toLowerCase();
  const planName = String(b.pricingPlanInfo?.planName || b.planName || '').toLowerCase();
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

function therapistStaffIdFromBooking(b) {
  if (!b) return null;
  if (b.therapist && b.therapist.staffId) return b.therapist.staffId;
  if (b.staff && b.staff.staffId) return b.staff.staffId;
  if (b.staffId) return String(b.staffId);
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
  // Plan-credit bookings: paid via Wix Pricing Plan credits — no direct charge captured.
  // Velo sets b.isPlanCreditBooking=true; also detect via two raw payment patterns:
  //   Pattern A: wixPayMultipleDetails[0].paymentVendorName === "inPerson" + UNDEFINED state
  //   Pattern B: empty wixPayMultipleDetails + empty balance + CONFIRMED + UNDEFINED state
  const _vendor = (b.paymentDetails?.wixPayMultipleDetails?.[0]?.paymentVendorName || '').toLowerCase();
  const _hasEmptyBalance = !b.paymentDetails?.balance?.finalPrice?.amount;
  const _status = String(b.status || '').toUpperCase();
  const isPlanCreditBooking =
    b.isPlanCreditBooking === true ||
    (paymentState === 'UNDEFINED' && !b.pricingPlanInfo && (
      _vendor === 'inperson' ||
      (!_vendor && _hasEmptyBalance && (!b.amountReceived || parseFloat(b.amountReceived) === 0) && _status === 'CONFIRMED')
    ));
  const isZeroPayment = !isPlanCreditBooking && (paymentState === 'UNDEFINED' || paymentState === 'FREE' || parseFloat(finalPriceAmount || '-1') === 0);

  // For plan-credit bookings use the raw session rate (b.price or rate.amount) as the price
  // since finalPriceAmount will be 0 (no direct charge — plan credits were consumed).
  const resolvedPrice = isZeroPayment
    ? 0
    : isPlanCreditBooking
      ? (b.price ?? rate?.amount ?? planPrice ?? null)
      : (finalPriceAmount != null && parseFloat(finalPriceAmount) > 0 ? finalPriceAmount : (planPrice ?? b.price ?? rate?.amount ?? null));
  const resolvedCurrency = (finalPriceAmount != null && parseFloat(finalPriceAmount) > 0) ? finalPriceCurrency : (planCurrency || b.currency || rate?.currency || null);

  // For type/count detection, inject resolved price AND isPlanCreditBooking so
  // sessionTypeFromBooking can detect Pattern B plan-credit bookings correctly.
  const augmented = {
    ...(resolvedPrice != null && parseFloat(resolvedPrice) > 0 ? { ...b, _resolvedPrice: resolvedPrice } : b),
    isPlanCreditBooking,  // always inject — overrides Velo's false with backend's true when Pattern B
  };
  const createdAt = wixBookingCreatedIso(b) || new Date().toISOString();
  const updatedAt = new Date().toISOString();

  return {
    wix_booking_id: String(b.id),
    wix_session_id: b.sessionId || b.id || null,
    schedule_id: b.scheduleId || null,
    service_id: b.serviceId || null,
    contact_id: b.contactId || b.client?.contactId || null,
    status: normalizeWixStatusToSessionStatus(b.status),
    title: b.title != null ? String(b.title) : null,
    session_type: sessionTypeFromBooking(augmented),
    session_count: sessionCountFromBooking(augmented),
    package_session_number: b.planSessionNumber != null ? Number(b.planSessionNumber) : null,
    package_group_id: b.subscriptionId || null,
    therapist_name: therapistNameFromBooking(b),
    wix_staff_id: therapistStaffIdFromBooking(b),
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
    created_at: createdAt,
    updated_at: updatedAt,
    synced_at: updatedAt,
  };
}

function normalizeWixStatusToSessionStatus(status) {
  const s = String(status ?? '').trim().toLowerCase();
  // Wix sends UNDEFINED when a booking is created but payment is not yet completed (pre-checkout).
  // Treat these as 'pending' — notifications should NOT fire until status upgrades to confirmed/booked.
  if (!s || s === 'undefined' || s === 'null') return 'pending';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('complete')) return 'completed';
  if (s.includes('no_show') || s.includes('noshow')) return 'no_show';
  // PENDING_APPROVAL = waiting for host approval — not yet confirmed, don't notify
  if (s.includes('pending_approval') || s.includes('waiting')) return 'pending';
  if (s.includes('book') || s.includes('confirm') || s.includes('approve')) return 'booked';
  // Generic "pending" (pre-payment) — don't treat as booked
  if (s.includes('pending')) return 'pending';
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
  const _sv = (b.paymentDetails?.wixPayMultipleDetails?.[0]?.paymentVendorName || '').toLowerCase();
  const _sb = !b.paymentDetails?.balance?.finalPrice?.amount;
  const _ss = String(b.status || '').toUpperCase();
  const isPlanCreditBooking =
    b.isPlanCreditBooking === true ||
    (paymentState === 'UNDEFINED' && !b.pricingPlanInfo && (
      _sv === 'inperson' ||
      (!_sv && _sb && (!b.amountReceived || parseFloat(b.amountReceived) === 0) && _ss === 'CONFIRMED')
    ));
  const isZeroPayment = !isPlanCreditBooking && (paymentState === 'UNDEFINED' || paymentState === 'FREE' || parseFloat(finalPaid || '-1') === 0);

  const amount = isZeroPayment ? 0 : parseAmount(
    isPlanCreditBooking
      ? (b.price ?? b.rawBookedEntity?.rate?.defaultVariedPrice?.amount ?? planPriceRaw)
      : (finalPaid != null && parseFloat(finalPaid) > 0) ? finalPaid : (planPriceRaw ?? b.price ?? b.rawBookedEntity?.rate?.defaultVariedPrice?.amount)
  );
  const fromWixInstant = wixBookingCreatedIso(b);
  /** Keep sessions.created_at aligned with Wix booking time when payload provides it */
  const createdAt = fromWixInstant || new Date().toISOString();
  const updatedAt = new Date().toISOString();

  // Package / plan tracking — populated when booking is via Wix Pricing Plan
  // Inject backend-detected isPlanCreditBooking so sessionTypeFromBooking sees it.
  const bWithPlanFlag = { ...b, isPlanCreditBooking };
  const planSessionNumber = b.planSessionNumber != null ? Number(b.planSessionNumber) : null;
  const sessionCount = sessionCountFromBooking(bWithPlanFlag);
  const packageGroupId = b.subscriptionId || null;

  return {
    wix_booking_id: b.id != null ? String(b.id) : null,
    source: 'wix',
    session_type: sessionTypeFromBooking(bWithPlanFlag) || 'individual',
    session_count: sessionCount,
    package_session_number: planSessionNumber || null,
    package_group_id: packageGroupId,
    status: normalizeWixStatusToSessionStatus(b.status),
    scheduled_date: isoDate(b.startTime),
    scheduled_time: isoTime(b.startTime),
    original_scheduled_date: isoDate(b.startTime),
    original_scheduled_time: isoTime(b.startTime),
    notes: b.title ? String(b.title) : null,
    price: amount,
    amount,
    wix_payload: b,
    booking_created_at: fromWixInstant || null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

module.exports = {
  discoverRowToDb,
  discoverRowToSessionDb,
  normalizeWixStatusToSessionStatus,
  therapistNameFromBooking,
  therapistStaffIdFromBooking,
  sessionTypeFromBooking,
  sessionCountFromBooking,
  wixBookingCreatedIso,
};
