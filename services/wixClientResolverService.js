/**
 * For each Wix booking, find or create a matching user+client row in Supabase.
 * Match key: email (case-insensitive). Never creates duplicates.
 * After resolving, updates the sessions row to set client_id.
 */

const { supabaseAdmin } = require('../config/supabase');
const { hashPassword } = require('../utils/helpers');
const emailService = require('../utils/emailService');

function isMissingColumnError(err, columnName) {
  const msg = String(err?.message || '');
  return msg.includes(`Could not find the '${columnName}' column`);
}

/**
 * Resolve or create user+client for one Wix booking.
 * Returns clients.id or null (if no email available).
 */
async function resolveOrCreateWixClient({ email, firstName, lastName, phone }) {
  if (!email || !email.trim()) return { clientId: null, isNew: false, tempPassword: null };

  const normalizedEmail = email.trim().toLowerCase();

  // 1. Look up existing user by email
  const { data: existingUser } = await supabaseAdmin
    .from('users')
    .select('id')
    .ilike('email', normalizedEmail)
    .limit(1);

  let userId;
  let isNewUser = false;
  if (existingUser?.[0]) {
    userId = existingUser[0].id;
  } else {
    // 2. Create a new user with a deterministic temp password (Wix-sourced client)
    //    Pattern: Welcome@<first 4 chars of email local part> — easy to communicate via WhatsApp
    const localPart = normalizedEmail.split('@')[0] || 'user';
    const suffix = localPart.slice(0, 4).toLowerCase();
    const tempPassword = `Welcome@${suffix}`;
    const passwordHash = await hashPassword(tempPassword);

    const { data: newUser, error: createUserError } = await supabaseAdmin
      .from('users')
      .insert({
        email: normalizedEmail,
        role: 'client',
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (createUserError) {
      // Race-safe fallback: if another process inserted this user concurrently,
      // resolve by email and continue instead of failing client mapping.
      const msg = String(createUserError.message || '').toLowerCase();
      if (createUserError.code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
        const { data: raceUser } = await supabaseAdmin
          .from('users')
          .select('id')
          .ilike('email', normalizedEmail)
          .limit(1);
        if (raceUser?.[0]?.id) {
          userId = raceUser[0].id;
        }
      }
    }

    if (createUserError && !userId) {
      console.error('[wixClientResolver] user insert failed:', createUserError.message || createUserError);
      return { clientId: null, isNew: false };
    }
    if (!userId) {
      userId = newUser.id;
      isNewUser = true;
      console.log(`[wixClientResolver] created user ${normalizedEmail} (${userId})`);
      // We will send the welcome details combined with the booking email later
    }
  }

  // Define tempPassword here if it was a new user so we can return it
  const localPart = normalizedEmail.split('@')[0] || 'user';
  const suffix = localPart.slice(0, 4).toLowerCase();
  const tempPassword = isNewUser ? `Welcome@${suffix}` : null;

  // 3. Find or create the clients row linked to this user
  // Use .limit(1) instead of .maybeSingle() — maybeSingle errors when multiple rows exist
  const { data: existingClients, error: lookupError } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('user_id', userId)
    .limit(1);

  if (existingClients?.length) {
    const clientId = existingClients[0].id;
    // Backfill name if missing — Wix sends fullName which wasn't split on first creation
    // Also update phone number if the new booking has a different one
    const { data: existing } = await supabaseAdmin
      .from('clients')
      .select('first_name, last_name, phone_number')
      .eq('id', clientId)
      .single();
      
    if (existing) {
      const updates = {};
      if (!existing.first_name && !existing.last_name && (firstName || lastName)) {
        updates.first_name = firstName || null;
        updates.last_name = lastName || null;
      }
      // Update phone number if it's provided and different
      if (phone && phone !== existing.phone_number) {
        updates.phone_number = phone;
      }
      
      if (Object.keys(updates).length > 0) {
        await supabaseAdmin
          .from('clients')
          .update(updates)
          .eq('id', clientId);
      }
    }
    
    return { clientId, isNew: isNewUser, tempPassword };
  }

  const baseInsert = {
    user_id: userId,
    first_name: firstName || null,
    last_name: lastName || null,
    phone_number: phone || null,
  };

  let { data: newClient, error: createClientError } = await supabaseAdmin
    .from('clients')
    .insert({
      ...baseInsert,
      free_assessment_count: 0,
      free_assessment_available: true,
    })
    .select('id')
    .single();

  // Fallback for projects where free_assessment_* columns were not bootstrapped.
  if (
    createClientError &&
    (isMissingColumnError(createClientError, 'free_assessment_available') ||
      isMissingColumnError(createClientError, 'free_assessment_count'))
  ) {
    ({ data: newClient, error: createClientError } = await supabaseAdmin
      .from('clients')
      .insert(baseInsert)
      .select('id')
      .single());
  }

  // Race condition: another sync cycle may have inserted the same user_id concurrently
  if (createClientError) {
    // Check if a row was created by another process
    const { data: raceClient } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .limit(1);
    if (raceClient?.length) {
      return { clientId: raceClient[0].id, isNew: isNewUser, tempPassword };
    }
    console.error('[wixClientResolver] client insert failed:', createClientError.message || createClientError);
    return { clientId: null, isNew: false };
  }

  console.log(`[wixClientResolver] created client for user ${userId} → client ${newClient.id}`);
  return { clientId: newClient.id, isNew: true, tempPassword };
}

/**
 * Process a list of enriched Wix booking objects:
 * - Resolve/create user+client for each unique email
 * - Update sessions.client_id where it is still null
 * Returns a map of wix_booking_id → client_id.
 */
async function resolveClientsForBookings(bookings) {
  if (!bookings?.length) return new Map();

  // De-duplicate by email so we only hit DB once per unique client
  const wixIdToClientId = new Map();
  const newClientWixIds = new Set();
  const resolveCache = new Map(); // email -> Promise
  const wixIdToTempPassword = new Map(); // wix_booking_id -> tempPassword

  await Promise.all(
    bookings.map(async (b) => {
      // Support both nested Wix format (webhook: b.client.email) and flat mapped format (interval sync: b.client_email)
      const email = b?.client?.email || b?.client_email;
      const wixId = b?.id != null ? String(b.id) : (b?.wix_booking_id != null ? String(b.wix_booking_id) : null);
      if (!email || !wixId) return;

      const normalizedEmail = email.trim().toLowerCase();

      // Guard: only resolve each email once even in parallel
      if (!resolveCache.has(normalizedEmail)) {
        // Seed with a Promise IMMEDIATELY so concurrent bookings with same email wait for one resolve
        // Wix sometimes sends fullName instead of firstName/lastName separately
        // Also support flat mapped format: b.client_first_name, b.client_last_name, b.client_full_name
        let firstName = b.client?.firstName || b.client_first_name || null;
        let lastName  = b.client?.lastName  || b.client_last_name  || null;
        const fullName = b.client?.fullName || b.client_full_name || null;
        if (!firstName && !lastName && fullName) {
          const parts = fullName.trim().split(/\s+/);
          firstName = parts[0] || null;
          lastName  = parts.length > 1 ? parts.slice(1).join(' ') : null;
        }
        resolveCache.set(normalizedEmail, resolveOrCreateWixClient({
          email,
          firstName,
          lastName,
          phone: b.client?.phone || b.client_phone || null,
        }));
      }

      const result = await resolveCache.get(normalizedEmail);
      // Handle both old format (plain id) and new format ({ clientId, isNew, tempPassword })
      const clientId = result?.clientId ?? result;
      const isNew = result?.isNew ?? false;
      const tempPass = result?.tempPassword ?? null;
      
      if (clientId) {
        wixIdToClientId.set(wixId, clientId);
        if (isNew) {
          newClientWixIds.add(wixId);
          if (tempPass) wixIdToTempPassword.set(wixId, tempPass);
        }
      }
    })
  );


  // Update sessions rows: set client_id where still null
  for (const [wixBookingId, clientId] of wixIdToClientId) {
    const { error } = await supabaseAdmin
      .from('sessions')
      .update({ client_id: clientId })
      .eq('wix_booking_id', wixBookingId)
      .is('client_id', null);

    if (error) {
      console.warn(
        `[wixClientResolver] failed to update sessions.client_id for ${wixBookingId}:`,
        error.message || error
      );
    }
  }

  // Attach metadata to the returned map
  wixIdToClientId._newClientWixIds = newClientWixIds;
  wixIdToClientId._wixIdToTempPassword = wixIdToTempPassword;

  return wixIdToClientId;
}

module.exports = { resolveOrCreateWixClient, resolveClientsForBookings };
