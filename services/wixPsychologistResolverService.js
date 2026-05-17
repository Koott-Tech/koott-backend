const { supabaseAdmin } = require('../config/supabase');
const { hashPassword } = require('../utils/helpers');
const emailService = require('../utils/emailService');

function splitName(fullName) {
  const raw = normalizeName(fullName);
  if (!raw) return { firstName: null, lastName: null };
  const parts = raw.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function normalizeName(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedFullName(firstName, lastName) {
  return normalizeName([firstName, lastName].filter(Boolean).join(' ')).toLowerCase();
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

/**
 * Resolve or create a psychologist row for a Wix booking.
 * When creating a new row, also sets a password_hash so the therapist
 * can log into the psychologist dashboard.
 *
 * @returns {{ psychologistId: string|null, isNew: boolean }}
 */
/**
 * Resolve or create a psychologist row for a Wix booking.
 * When creating a new row, also sets a password_hash so the therapist
 * can log into the psychologist dashboard.
 *
 * @returns {{ psychologistId: string|null, isNew: boolean }}
 */
async function resolveOrCreateWixPsychologist(booking) {
  const therapist = therapistFromBooking(booking);
  const rawName = normalizeName(therapist.name || '');
  const rawEmail = String(therapist.email || '').trim().toLowerCase();
  const rawPhone = String(therapist.phone || '').trim();

  if (!rawName && !rawEmail) return { psychologistId: null, isNew: false };

  // 1. Try resolving by email (most unique)
  if (rawEmail) {
    const { data: existingByEmail } = await supabaseAdmin
      .from('psychologists')
      .select('id')
      .ilike('email', rawEmail)
      .limit(1);
    if (existingByEmail?.[0]?.id) return { psychologistId: existingByEmail[0].id, isNew: false };
  }

  // 2. Try resolving by name (fallback)
  const { firstName, lastName } = splitName(rawName);
  if (firstName) {
    const targetFullName = normalizedFullName(firstName, lastName);
    let query = supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name')
      .ilike('first_name', firstName);

    const { data: existingByName } = await query.limit(50);
    if (existingByName?.length) {
      const exactMatch = existingByName.find((row) =>
        normalizedFullName(row.first_name, row.last_name) === targetFullName
      );
      if (exactMatch?.id) return { psychologistId: exactMatch.id, isNew: false };
      if (lastName) {
        const byLast = existingByName.find((row) =>
          String(row.last_name || '').trim().toLowerCase() === String(lastName || '').trim().toLowerCase()
        );
        if (byLast?.id) return { psychologistId: byLast.id, isNew: false };
      }
      if (!lastName && existingByName[0]?.id) return { psychologistId: existingByName[0].id, isNew: false };
    }
  }

  // Build a deterministic temp password
  let passwordHash = null;
  let tempPassword = null;
  if (rawEmail) {
    tempPassword = 'Koott@#2026';
    passwordHash = await hashPassword(tempPassword);
  }

  const insertPayload = {
    email: rawEmail || null,
    first_name: firstName,
    last_name: lastName || null,
    phone: rawPhone || null,
    profile_picture_url: therapist.image || null,
    designation: 'Psychologist',
    password_hash: passwordHash,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await supabaseAdmin
    .from('psychologists')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error) {
    // Fetch again just in case
    const { data: retryCheck } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name')
      .ilike('first_name', firstName)
      .limit(50);

    if (retryCheck?.length) {
      const targetFullName = normalizedFullName(firstName, lastName);
      const exactMatch = retryCheck.find((row) =>
        normalizedFullName(row.first_name, row.last_name) === targetFullName
      );
      if (exactMatch?.id) return { psychologistId: exactMatch.id, isNew: false };
      if (retryCheck[0]?.id) return { psychologistId: retryCheck[0].id, isNew: false };
    }
    
    console.warn('[wixPsychologistResolver] insert failed:', error.message || error);
    return { psychologistId: null, isNew: false };
  }

  // Send welcome email with login credentials (fire-and-forget)
  if (rawEmail && tempPassword) {
    const psychologistName = [firstName, insertPayload.last_name].filter(Boolean).join(' ') || rawEmail;
    emailService.sendWelcomePsychologistEmail({
      to: rawEmail,
      psychologistName,
      tempPassword,
      loginUrl: process.env.CLIENT_SITE_URL || 'https://www.koott.in',
    }).catch((err) => {
      console.error(`[wixPsychologistResolver] welcome email failed for ${rawEmail}:`, err?.message || err);
    });
  }

  return { psychologistId: inserted.id, isNew: true };
}


async function resolvePsychologistsForBookings(bookings) {
  if (!Array.isArray(bookings) || !bookings.length) return new Map();

  const wixIdToPsychologistId = new Map();
  const newPsychologistWixIds = new Set();
  const resolveCache = new Map(); // name+email -> Promise

  await Promise.all(bookings.map(async (booking) => {
    const wixBookingId = booking?.id != null ? String(booking.id) : null;
    if (!wixBookingId) return;

    const therapist = therapistFromBooking(booking);
    const cacheKey = `${therapist.name || ''}|${therapist.email || ''}`.toLowerCase().trim();

    if (!resolveCache.has(cacheKey)) {
      resolveCache.set(cacheKey, resolveOrCreateWixPsychologist(booking));
    }

    const result = await resolveCache.get(cacheKey);
    const psychologistId = result?.psychologistId ?? result;
    const isNew = result?.isNew ?? false;
    
    if (psychologistId) {
      wixIdToPsychologistId.set(wixBookingId, psychologistId);
      if (isNew) newPsychologistWixIds.add(wixBookingId);
    }
  }));

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

  wixIdToPsychologistId._newPsychologistWixIds = newPsychologistWixIds;
  return wixIdToPsychologistId;
}

module.exports = {
  resolveOrCreateWixPsychologist,
  resolvePsychologistsForBookings,
};
