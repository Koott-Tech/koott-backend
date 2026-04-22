/**
 * For each Wix booking, find or create a matching user+client row in Supabase.
 * Match key: email (case-insensitive). Never creates duplicates.
 * After resolving, updates the sessions row to set client_id.
 */

const { supabaseAdmin } = require('../config/supabase');
const { hashPassword } = require('../utils/helpers');

function isMissingColumnError(err, columnName) {
  const msg = String(err?.message || '');
  return msg.includes(`Could not find the '${columnName}' column`);
}

/**
 * Resolve or create user+client for one Wix booking.
 * Returns clients.id or null (if no email available).
 */
async function resolveOrCreateWixClient({ email, firstName, lastName, phone }) {
  if (!email || !email.trim()) return null;

  const normalizedEmail = email.trim().toLowerCase();

  // 1. Look up existing user by email
  const { data: existingUser } = await supabaseAdmin
    .from('users')
    .select('id')
    .ilike('email', normalizedEmail)
    .maybeSingle();

  let userId;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    // 2. Create a new user with a temp password (Wix-sourced client)
    const tempPassword = `WixClient@${Math.random().toString(36).slice(-10)}`;
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
      console.error('[wixClientResolver] user insert failed:', createUserError.message || createUserError);
      return null;
    }
    userId = newUser.id;
    console.log(`[wixClientResolver] created user ${normalizedEmail} (${userId})`);
  }

  // 3. Find or create the clients row linked to this user
  const { data: existingClient } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existingClient) return existingClient.id;

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

  if (createClientError) {
    console.error('[wixClientResolver] client insert failed:', createClientError.message || createClientError);
    return null;
  }

  console.log(`[wixClientResolver] created client for user ${userId} → client ${newClient.id}`);
  return newClient.id;
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
  const emailToClientId = new Map();
  const wixIdToClientId = new Map();

  await Promise.all(
    bookings.map(async (b) => {
      const email = b?.client?.email;
      const wixId = b?.id != null ? String(b.id) : null;
      if (!email || !wixId) return;

      const normalizedEmail = email.trim().toLowerCase();
      // Guard: only resolve each email once even in parallel
      if (!emailToClientId.has(normalizedEmail)) {
        // Seed with a Promise so concurrent bookings with same email wait for one resolve
        const promise = resolveOrCreateWixClient({
          email,
          firstName: b.client?.firstName || null,
          lastName: b.client?.lastName || null,
          phone: b.client?.phone || null,
        });
        emailToClientId.set(normalizedEmail, promise);
      }

      const clientId = await emailToClientId.get(normalizedEmail);
      if (clientId) wixIdToClientId.set(wixId, clientId);
    })
  );

  // Resolve any Promises still in the map
  for (const [email, maybePromise] of emailToClientId) {
    if (maybePromise && typeof maybePromise.then === 'function') {
      emailToClientId.set(email, await maybePromise);
    }
  }

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

  return wixIdToClientId;
}

module.exports = { resolveOrCreateWixClient, resolveClientsForBookings };
