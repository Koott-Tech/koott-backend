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
  if (!email || !email.trim()) return { clientId: null, isNew: false };

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
      console.error('[wixClientResolver] user insert failed:', createUserError.message || createUserError);
      return { clientId: null, isNew: false };
    }
    userId = newUser.id;
    isNewUser = true;
    console.log(`[wixClientResolver] created user ${normalizedEmail} (${userId})`);

    // Send welcome email with login credentials (fire-and-forget)
    const clientName = [firstName, lastName].filter(Boolean).join(' ') || normalizedEmail;
    emailService.sendWelcomeEmail({
      to: normalizedEmail,
      clientName,
      tempPassword,
      loginUrl: 'https://www.little.care',
    }).catch((err) => {
      console.error(`[wixClientResolver] welcome email failed for ${normalizedEmail}:`, err?.message || err);
    });
  }

  // 3. Find or create the clients row linked to this user
  // Use .limit(1) instead of .maybeSingle() — maybeSingle errors when multiple rows exist
  const { data: existingClients, error: lookupError } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('user_id', userId)
    .limit(1);

  if (existingClients?.length) return { clientId: existingClients[0].id, isNew: isNewUser };

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
      return { clientId: raceClient[0].id, isNew: isNewUser };
    }
    console.error('[wixClientResolver] client insert failed:', createClientError.message || createClientError);
    return { clientId: null, isNew: false };
  }

  console.log(`[wixClientResolver] created client for user ${userId} → client ${newClient.id}`);
  return { clientId: newClient.id, isNew: true };
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

  await Promise.all(
    bookings.map(async (b) => {
      const email = b?.client?.email;
      const wixId = b?.id != null ? String(b.id) : null;
      if (!email || !wixId) return;

      const normalizedEmail = email.trim().toLowerCase();
      
      // Guard: only resolve each email once even in parallel
      if (!resolveCache.has(normalizedEmail)) {
        // Seed with a Promise IMMEDIATELY so concurrent bookings with same email wait for one resolve
        resolveCache.set(normalizedEmail, resolveOrCreateWixClient({
          email,
          firstName: b.client?.firstName || null,
          lastName: b.client?.lastName || null,
          phone: b.client?.phone || null,
        }));
      }

      const result = await resolveCache.get(normalizedEmail);
      // Handle both old format (plain id) and new format ({ clientId, isNew })
      const clientId = result?.clientId ?? result;
      const isNew = result?.isNew ?? false;
      if (clientId) {
        wixIdToClientId.set(wixId, clientId);
        if (isNew) newClientWixIds.add(wixId);
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

  // Attach newClientWixIds to the returned map so callers know which bookings got new accounts
  wixIdToClientId._newClientWixIds = newClientWixIds;

  return wixIdToClientId;
}

module.exports = { resolveOrCreateWixClient, resolveClientsForBookings };
