const { supabaseAdmin } = require('../config/supabase');

function splitName(fullName) {
  const raw = String(fullName || '').trim();
  if (!raw) return { firstName: null, lastName: null };
  const parts = raw.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function therapistFromBooking(booking) {
  const t = booking?.therapist;
  if (!t) {
    return { name: booking?.title || null, email: null, phone: null, image: null };
  }
  if (typeof t === 'string') {
    return { name: t, email: null, phone: null, image: null };
  }
  return {
    name: t.name || t.displayName || t.fullName || booking?.title || null,
    email: t.email || null,
    phone: t.phone || null,
    image: t.image || null,
  };
}

async function resolveOrCreateWixPsychologist(booking) {
  const therapist = therapistFromBooking(booking);
  const rawName = String(therapist.name || '').trim();
  const rawEmail = String(therapist.email || '').trim().toLowerCase();
  const rawPhone = String(therapist.phone || '').trim();

  if (!rawName && !rawEmail) return null;

  if (rawEmail) {
    const { data: existingByEmail } = await supabaseAdmin
      .from('psychologists')
      .select('id')
      .ilike('email', rawEmail)
      .maybeSingle();
    if (existingByEmail?.id) return existingByEmail.id;
  }

  const { firstName, lastName } = splitName(rawName);
  if (firstName && lastName) {
    const { data: existingByName } = await supabaseAdmin
      .from('psychologists')
      .select('id')
      .ilike('first_name', firstName)
      .ilike('last_name', lastName)
      .maybeSingle();
    if (existingByName?.id) return existingByName.id;
  }

  const insertPayload = {
    email: rawEmail || null,
    first_name: firstName,
    last_name: lastName,
    phone: rawPhone || null,
    profile_picture_url: therapist.image || null,
    designation: 'Psychologist',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await supabaseAdmin
    .from('psychologists')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error) {
    // Handle race where another process inserted the same email simultaneously.
    if (rawEmail) {
      const { data: retryByEmail } = await supabaseAdmin
        .from('psychologists')
        .select('id')
        .ilike('email', rawEmail)
        .maybeSingle();
      if (retryByEmail?.id) return retryByEmail.id;
    }
    console.warn('[wixPsychologistResolver] insert failed:', error.message || error);
    return null;
  }

  return inserted.id;
}

async function resolvePsychologistsForBookings(bookings) {
  if (!Array.isArray(bookings) || !bookings.length) return new Map();

  const wixIdToPsychologistId = new Map();
  for (const booking of bookings) {
    const wixBookingId = booking?.id != null ? String(booking.id) : null;
    if (!wixBookingId) continue;
    const psychologistId = await resolveOrCreateWixPsychologist(booking);
    if (!psychologistId) continue;
    wixIdToPsychologistId.set(wixBookingId, psychologistId);
  }

  for (const [wixBookingId, psychologistId] of wixIdToPsychologistId.entries()) {
    const { error } = await supabaseAdmin
      .from('sessions')
      .update({ psychologist_id: psychologistId })
      .eq('wix_booking_id', wixBookingId)
      .is('psychologist_id', null);
    if (error) {
      console.warn(
        `[wixPsychologistResolver] failed to update sessions.psychologist_id for ${wixBookingId}:`,
        error.message || error
      );
    }
  }

  return wixIdToPsychologistId;
}

module.exports = {
  resolveOrCreateWixPsychologist,
  resolvePsychologistsForBookings,
};
