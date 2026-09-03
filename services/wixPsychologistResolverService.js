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

// Strip leading honorific titles (Dr/Mr/Mrs/Ms/Miss/Prof/Doctor) so the SAME person
// matches whether or not the title is present. Titles being baked into names \u2014 and
// split inconsistently ("Dr." vs "Dr. Gayathri" as first_name) \u2014 is what created
// duplicate psychologist profiles.
function stripTitles(value) {
  let s = normalizeName(value);
  // remove one or more leading titles, e.g. "Dr. Prof. Jane" \u2192 "Jane"
  while (true) {
    const next = s.replace(/^(dr|mr|mrs|ms|miss|prof|doctor)\.?\s+/i, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

// Title-insensitive, lowercased, WHITESPACE-STRIPPED full name used as the canonical match
// key. Removing all spaces means initials variants collapse to the same key — e.g.
// "Rajina RS" and "Rajina R S" both become "rajinars" — so a differently-spaced Wix name
// still matches the existing profile instead of silently creating a duplicate.
function nameMatchKey(value) {
  return stripTitles(value).toLowerCase().replace(/\s+/g, '');
}
function normalizedFullName(firstName, lastName) {
  return nameMatchKey([firstName, lastName].filter(Boolean).join(' '));
}
function psychologistNameMatches(row, targetFullName) {
  if (!targetFullName) return true;
  return normalizedFullName(row?.first_name, row?.last_name) === targetFullName;
}

function therapistFromBooking(booking) {
  const t = booking?.therapist;
  if (!t) {
    return { name: booking?.title || null, email: null, phone: null, image: null };
  }
  if (typeof t === 'string') {
    return { name: t, email: null, phone: null, image: null, staffId: null };
  }
  return {
    name: t.name || t.displayName || t.fullName || booking?.title || null,
    email: t.email || null,
    phone: t.phone || null,
    image: t.image || null,
    staffId: t.staffId || booking?.staffId || booking?.staff?.staffId || null,
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

  const { firstName, lastName } = splitName(rawName);
  const targetFullName = nameMatchKey(rawName); // title- and whitespace-insensitive key

  // 1. Try resolving by Wix Staff ID. If Wix also sent a therapist name, guard against
  // stale/bad staff-id mappings by requiring the matched row's name to agree.
  if (therapist.staffId) {
    const { data: existingByStaffId } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name')
      .eq('wix_staff_id', therapist.staffId)
      .limit(1);
    const staffMatch = existingByStaffId?.[0] || null;
    if (staffMatch?.id && psychologistNameMatches(staffMatch, targetFullName)) {
      return { psychologistId: staffMatch.id, isNew: false };
    }
    if (staffMatch?.id) {
      console.warn(
        `[wixPsychologistResolver] ignoring wix_staff_id ${therapist.staffId} because it maps to ` +
        `"${[staffMatch.first_name, staffMatch.last_name].filter(Boolean).join(' ')}" but Wix booking says "${rawName}"`
      );
    }
  }

  // 1.5. Try resolving by email (most unique fallback)
  if (rawEmail) {
    const { data: existingByEmail } = await supabaseAdmin
      .from('psychologists')
      .select('id')
      .ilike('email', rawEmail)
      .limit(1);
    if (existingByEmail?.[0]?.id) return { psychologistId: existingByEmail[0].id, isNew: false };
  }

  // 2. Try resolving by name (fallback).
  // Compare the TITLE-STRIPPED full name against ALL psychologists rather than an exact
  // first_name query — the previous `ilike('first_name', firstName)` missed the existing
  // profile whenever the name was stored/split differently (e.g. "Dr. Gayathri" vs "Dr."),
  // which silently created duplicates. The table is small, so a full scan is cheap.
  if (targetFullName) {
    const { data: allPsychs } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email, google_calendar_credentials, wix_staff_id');
    const matches = (allPsychs || []).filter((row) =>
      normalizedFullName(row.first_name, row.last_name) === targetFullName
    );
    if (matches.length) {
      // If a duplicate already exists, prefer the most complete profile (has email,
      // then a live Google Calendar) so bookings land on the real, calendar-synced one.
      matches.sort((a, b) =>
        ((b.email ? 1 : 0) - (a.email ? 1 : 0)) ||
        ((b.google_calendar_credentials?.access_token ? 1 : 0) - (a.google_calendar_credentials?.access_token ? 1 : 0))
      );
      return { psychologistId: matches[0].id, isNew: false };
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
    wix_staff_id: therapist.staffId || null,
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
    // Fetch again just in case (e.g. a concurrent insert) — match on title-stripped full name.
    const { data: retryCheck } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name');

    if (retryCheck?.length) {
      const exactMatch = retryCheck.find((row) =>
        normalizedFullName(row.first_name, row.last_name) === targetFullName
      );
      if (exactMatch?.id) return { psychologistId: exactMatch.id, isNew: false };
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
  // Exported so read-only views (e.g. the admin Wix-therapists list) match therapists by the
  // SAME rule the booking sync uses. A view that matched on the raw name reported "Dr. X" as
  // unlinked while the sync had linked it correctly all along.
  nameMatchKey,
};
