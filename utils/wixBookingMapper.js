/**
 * Map one normalized discover booking row → Supabase `wix_bookings` insert/upsert shape.
 * Payload matches live koott.in discover `sections.bookings.sample` items.
 */

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
  const first = b.client?.firstName ?? null;
  const last = b.client?.lastName ?? null;
  const full =
    b.client?.fullName ||
    [first, last].filter(Boolean).join(' ').trim() ||
    null;

  const rate = b.rawBookedEntity?.rate?.defaultVariedPrice;

  return {
    wix_booking_id: String(b.id),
    wix_session_id: b.sessionId || null,
    schedule_id: b.scheduleId || null,
    service_id: b.serviceId || null,
    contact_id: b.contactId || b.client?.contactId || null,
    status: b.status != null ? String(b.status) : null,
    title: b.title != null ? String(b.title) : null,
    therapist_name: therapistNameFromBooking(b),
    tags: Array.isArray(b.tags) ? b.tags : b.tags != null ? b.tags : null,
    start_time: b.startTime || null,
    end_time: b.endTime || null,
    client_first_name: first,
    client_last_name: last,
    client_full_name: full,
    client_email: b.client?.email || null,
    client_phone: b.client?.phone || null,
    price: b.price != null ? String(b.price) : rate?.amount != null ? String(rate.amount) : null,
    currency: b.currency || rate?.currency || null,
    location: b.location != null ? String(b.location) : null,
    payload: b,
    updated_at: new Date().toISOString(),
    synced_at: new Date().toISOString(),
  };
}

module.exports = {
  discoverRowToDb,
  therapistNameFromBooking,
};
