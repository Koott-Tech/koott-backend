const { supabaseAdmin } = require('../config/supabase');
const { getBookingTimeColumnKey } = require('../utils/sessionsBookingTimeColumn');
const { fetchWixDiscover, extractBookingsList } = require('../utils/wixDiscoverClient');
const { discoverRowToDb, discoverRowToSessionDb } = require('../utils/wixBookingMapper');
const { resolveClientsForBookings } = require('../services/wixClientResolverService');
const { linkPackageSessions: linkWixBookingsPackages } = require('../services/wixPackageLinkingService');
const { resolvePsychologistsForBookings } = require('../services/wixPsychologistResolverService');
const { processNewWixSessions } = require('../services/wixMeetNotifyService');
const { linkPackageSessions } = require('../services/wixPackageLinkerService');
const { fetchSessionInfoBatch } = require('../services/wixOrderEnrichmentService');
const { hydrateBareTherapistBookings } = require('../utils/wixBookingPayloadHydration');

const DEFAULT_WIX_SYNC_LIMIT = Number.parseInt(
  process.env.WIX_DISCOVER_BOOKING_LIMIT || '100',
  10
) || 100;

async function sessionRowsForSchema(sessionRows) {
  const btc = await getBookingTimeColumnKey(supabaseAdmin);
  if (btc === 'booking_created_at') return sessionRows;
  return sessionRows.map(({ booking_created_at: _omit, ...r }) => r);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Used to classify psychologist rows that never show up as a therapist on mirrored Wix rows. */
function bookingDisplayNameProbablySamePsychologist(bookingDisplayNameRaw, psychologist) {
  const raw = String(bookingDisplayNameRaw || '')
    .toLowerCase()
    .replace(/^dr\.?\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return false;
  const fn = String(psychologist.first_name || '')
    .trim()
    .toLowerCase();
  const ln = String(psychologist.last_name || '')
    .trim()
    .toLowerCase();
  const tokens = [fn, ln].filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => (t.length <= 2 ? raw.includes(t) : raw.includes(t)));
}

/**
 * Fetch wix_booking_ids that have been locally modified (edited/deleted by admin).
 * These rows must be excluded from Wix sync upserts so local edits are never overwritten.
 */
async function getLocallyModifiedWixIds() {
  try {
    // Check wix_bookings table
    const { data: wixData, error: wixError } = await supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id')
      .eq('locally_modified', true);
    
    // Check sessions table
    const { data: sessionData, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('wix_booking_id')
      .eq('locally_modified', true)
      .not('wix_booking_id', 'is', null);

    const ids = new Set();
    
    if (!wixError && wixData) {
      wixData.forEach(r => { if (r.wix_booking_id) ids.add(r.wix_booking_id); });
    }
    
    if (!sessionError && sessionData) {
      sessionData.forEach(r => { if (r.wix_booking_id) ids.add(r.wix_booking_id); });
    }

    return ids;
  } catch (err) {
    console.warn('[getLocallyModifiedWixIds] error:', err.message || err);
    return new Set();
  }
}

/**
 * Upsert an already-enriched booking object (from Velo webhook) directly.
 * Skips discover re-fetch and avoids the Wix index eventual-consistency gap.
 */
async function upsertEnrichedBookings(rawBookings) {
  const list = Array.isArray(rawBookings) ? rawBookings : rawBookings ? [rawBookings] : [];
  const deduped = dedupeBookings(list);
  const dedupedHydrated = await hydrateBareTherapistBookings(supabaseAdmin, deduped);

  let rows = dedupedHydrated
    .map(discoverRowToDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
  const sessionRows = dedupedHydrated
    .map(discoverRowToSessionDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));

  if (!rows.length) {
    return { upserted: 0, sessionsUpserted: 0, sessionMirrorSkipped: false };
  }

  rows = await applyMaxPriceGuard(rows);

  // Sync protection: skip locally-modified bookings so admin edits are never overwritten
  const locallyModifiedIds = await getLocallyModifiedWixIds();
  if (locallyModifiedIds.size) {
    rows = rows.filter((r) => !locallyModifiedIds.has(r.wix_booking_id));
  }
  if (!rows.length) {
    return { upserted: 0, sessionsUpserted: 0, sessionMirrorSkipped: false };
  }

  const { data, error } = await supabaseAdmin
    .from('wix_bookings')
    .upsert(rows, { onConflict: 'wix_booking_id' })
    .select('wix_booking_id');

  if (error) {
    const err = new Error(error.message || 'Supabase upsert failed');
    err.code = error.code;
    throw err;
  }

  let sessionsUpserted = 0;
  let sessionMirrorSkipped = false;
  if (sessionRows.length) {
    // Sync protection for sessions table
    let filteredSessionRows = sessionRows;
    if (locallyModifiedIds.size) {
      filteredSessionRows = sessionRows.filter(r => !locallyModifiedIds.has(r.wix_booking_id));
    }

    if (filteredSessionRows.length > 0) {
      const upsertSessions = await sessionRowsForSchema(filteredSessionRows);
      const { data: sessionData, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .upsert(upsertSessions, { onConflict: 'wix_booking_id' })
        .select('id,wix_booking_id');
      if (sessionError) {
        require('fs').appendFileSync('scratch/log.txt', `[${new Date().toISOString()}] Sessions upsert FAILED: ${sessionError.message}\n`);
        const msg = String(sessionError.message || '');
        const recoverable =
          msg.includes("Could not find the 'source' column") ||
          msg.includes("Could not find the 'wix_booking_id' column") ||
          msg.includes("Could not find the 'wix_payload' column") ||
          msg.includes("Could not find the 'booking_created_at' column") ||
          msg.includes('no unique or exclusion constraint matching the ON CONFLICT specification');
        if (recoverable) {
          sessionMirrorSkipped = true;
          console.warn('[upsertEnrichedBookings] sessions mirror skipped (run bridge migration)');
        } else {
          const err = new Error(sessionError.message || 'Sessions upsert failed');
          err.code = sessionError.code;
          throw err;
        }
      } else {
        sessionsUpserted = sessionData?.length ?? filteredSessionRows.length;
      }
    }
  }

  // Resolve/create user+client rows and link them to sessions
  let clientsResolved = 0;
  try {
    const m = await resolveClientsForBookings(dedupedHydrated);
    clientsResolved = m.size;
  } catch (err) {
    console.warn('[upsertEnrichedBookings] client resolve non-blocking error:', err.message || err);
  }
  let psychologistsResolved = 0;
  try {
    const m = await resolvePsychologistsForBookings(dedupedHydrated);
    psychologistsResolved = m.size;
  } catch (err) {
    console.warn('[upsertEnrichedBookings] psychologist resolve non-blocking error:', err.message || err);
  }

  // Link ₹0 follow-up sessions under their parent package booking (wix_bookings table)
  try {
    const r = await linkWixBookingsPackages();
    if (r.childrenLinked > 0) {
      console.log(`[upsertEnrichedBookings] linked ${r.childrenLinked} package children across ${r.packagesProcessed} packages`);
    }
  } catch (err) {
    console.warn('[upsertEnrichedBookings] package linking non-blocking error:', err.message || err);
  }

  const wixBookingIds = dedupedHydrated.map((b) => b.id != null ? String(b.id) : null).filter(Boolean);

  // Enrich bookings with exact session type/count from Wix eCommerce Order API
  // (same data Zapier receives — e.g. "Individual 4-Session Pack")
  if (wixBookingIds.length) {
    enrichBookingsFromOrders(wixBookingIds).catch((err) => {
      console.warn('[upsertEnrichedBookings] order enrichment non-blocking error:', err.message || err);
    });
  }

  // Link zero-price promo sessions to their parent paid package session
  if (wixBookingIds.length) {
    linkPackageSessions(wixBookingIds).catch((err) => {
      console.warn('[upsertEnrichedBookings] package linker non-blocking error:', err.message || err);
    });
  }

  // Fire-and-forget: create Google Meet links + send WhatsApp for new Wix sessions
  if (wixBookingIds.length) {
    processNewWixSessions(wixBookingIds).catch((err) => {
      console.warn('[upsertEnrichedBookings] meet+notify non-blocking error:', err.message || err);
    });
  }

  return {
    upserted: data?.length ?? rows.length,
    sessionsUpserted,
    clientsResolved,
    psychologistsResolved,
    sessionMirrorSkipped,
  };
}

/**
 * Post-upsert enrichment: call Wix eCommerce Orders API to get the exact
 * session type and count from order description lines (e.g. "Individual 4-Session Pack").
 * Updates both wix_bookings and sessions tables with the correct values.
 */
async function enrichBookingsFromOrders(wixBookingIds) {
  if (!wixBookingIds.length) return;

  const infoMap = await fetchSessionInfoBatch(wixBookingIds);
  if (!infoMap.size) return;

  let updated = 0;
  for (const [bookingId, info] of infoMap) {
    try {
      // Update wix_bookings with session type, count, and order ID
      const wbUpdate = {
        session_type: info.sessionType,
        session_count: info.sessionCount,
      };
      if (info.orderId) wbUpdate.wix_order_id = info.orderId;
      if (info.orderNumber) wbUpdate.wix_order_number = info.orderNumber;

      const { error: wbErr } = await supabaseAdmin
        .from('wix_bookings')
        .update(wbUpdate)
        .eq('wix_booking_id', bookingId);

      if (wbErr) {
        console.warn(`[enrichBookingsFromOrders] wix_bookings update failed for ${bookingId}:`, wbErr.message);
        continue;
      }

      // Update sessions table too
      const { error: sessErr } = await supabaseAdmin
        .from('sessions')
        .update({
          session_type: info.sessionType,
          session_count: info.sessionCount,
        })
        .eq('wix_booking_id', bookingId);

      if (sessErr && !sessErr.message?.includes('0 rows')) {
        console.warn(`[enrichBookingsFromOrders] sessions update failed for ${bookingId}:`, sessErr.message);
      }

      updated++;
      console.log(
        `[enrichBookingsFromOrders] ${bookingId} → ${info.sessionType} (${info.sessionCount} sessions) from "${info.descriptionLine}"`
      );
    } catch (err) {
      console.warn(`[enrichBookingsFromOrders] error for ${bookingId}:`, err.message || err);
    }
  }

  if (updated) {
    console.log(`[enrichBookingsFromOrders] enriched ${updated}/${wixBookingIds.length} bookings from eCommerce API`);
  }
}
function bookingDedupKey(b) {
  const schedule = b?.scheduleId || '';
  const session = b?.sessionId || '';
  const start = b?.startTime || '';
  const email = b?.client?.email || '';
  const contact = b?.contactId || b?.client?.contactId || '';
  const title = b?.title || '';
  // Use a stable natural key so Wix duplicate rows collapse to one canonical booking.
  return `${schedule}|${session}|${start}|${email}|${contact}|${title}`.toLowerCase();
}

function statusRank(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s || s === 'undefined' || s === 'null') return 0;
  if (s.includes('cancel')) return 1;
  if (s.includes('book') || s.includes('pending')) return 2;
  if (s.includes('confirm')) return 3;
  if (s.includes('complete')) return 4;
  return 2;
}

function bookingTimestamp(b) {
  const raw = b?.createdDate || b?.startTime;
  const t = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function dedupeBookings(bookings) {
  const byKey = new Map();
  for (const booking of bookings) {
    const key = bookingDedupKey(booking);
    if (!key.replace(/\|/g, '')) {
      byKey.set(`id:${booking?.id || Math.random()}`, booking);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, booking);
      continue;
    }
    const existingRank = statusRank(existing?.status);
    const currentRank = statusRank(booking?.status);
    const existingTs = bookingTimestamp(existing);
    const currentTs = bookingTimestamp(booking);
    if (currentRank > existingRank || (currentRank === existingRank && currentTs >= existingTs)) {
      byKey.set(key, booking);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Protect rows whose price/session_type was previously resolved correctly.
 * Wix payment API returns inconsistent data — sometimes `paymentDetails` is empty
 * for the same booking on subsequent fetches. This guard ensures we never
 * downgrade a price that was previously set higher (e.g. 8699 → 1999).
 */
async function applyMaxPriceGuard(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.wix_booking_id).filter(Boolean);
  const { data: existing } = await supabaseAdmin
    .from('wix_bookings')
    .select('wix_booking_id, price, session_type, session_count')
    .in('wix_booking_id', ids);

  if (!existing?.length) return rows;
  const existingMap = new Map(existing.map((e) => [e.wix_booking_id, e]));

  return rows.map((row) => {
    const prev = existingMap.get(row.wix_booking_id);
    if (!prev) return row;

    const newPrice  = parseFloat(row.price ?? 0);
    const prevPrice = parseFloat(prev.price ?? 0);

    // Keep whichever price is higher
    if (prevPrice > newPrice && prevPrice > 0) {
      row = { ...row, price: prev.price, currency: row.currency || prev.currency };
    }

    // Keep the better session_type: package > individual > null
    const typeRank = { package: 2, individual: 1 };
    const newRank  = typeRank[row.session_type]  ?? 0;
    const prevRank = typeRank[prev.session_type] ?? 0;
    if (prevRank > newRank) {
      row = { ...row, session_type: prev.session_type, session_count: prev.session_count ?? row.session_count };
    }

    return row;
  });
}

async function performWixSync() {
  const r = await fetchWixDiscover({
    limit: process.env.WIX_DISCOVER_BOOKING_LIMIT || DEFAULT_WIX_SYNC_LIMIT,
  });
  if (!r.ok) {
    const err = new Error(r.json?.error || r.json?.message || `Wix discover failed (HTTP ${r.status})`);
    err.httpStatus = r.status;
    throw err;
  }

  const { bookings, extractionTried } = extractBookingsList(r.json);
  const dedupedBookings = dedupeBookings(bookings);
  const dedupedHydratedBookings = await hydrateBareTherapistBookings(supabaseAdmin, dedupedBookings);
  if (!dedupedHydratedBookings.length) {
    return {
      upserted: 0,
      sessionsUpserted: 0,
      extractionTried,
      fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
    };
  }

  let rows = dedupedHydratedBookings
    .map(discoverRowToDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
  const sessionRows = dedupedHydratedBookings
    .map(discoverRowToSessionDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
  if (!rows.length) {
    return {
      upserted: 0,
      sessionsUpserted: 0,
      extractionTried,
      fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
    };
  }

  // Never overwrite a previously-correct higher price with Wix's inconsistent lower value
  rows = await applyMaxPriceGuard(rows);

  // Sync protection: skip locally-modified bookings
  const locallyModifiedIds = await getLocallyModifiedWixIds();
  if (locallyModifiedIds.size) {
    const before = rows.length;
    rows = rows.filter((r) => !locallyModifiedIds.has(r.wix_booking_id));
    if (rows.length < before) {
      console.log(`[performWixSync] skipped ${before - rows.length} locally-modified booking(s)`);
    }
  }
  if (!rows.length) {
    return {
      upserted: 0,
      sessionsUpserted: 0,
      extractionTried,
      fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
    };
  }

  const { data, error } = await supabaseAdmin
    .from('wix_bookings')
    .upsert(rows, { onConflict: 'wix_booking_id' })
    .select('wix_booking_id');

  if (error) {
    const err = new Error(error.message || 'Supabase upsert failed');
    err.code = error.code;
    throw err;
  }

  let clientsResolved = 0;
  try {
    const wixIdToClientId = await resolveClientsForBookings(dedupedBookings);
    clientsResolved = wixIdToClientId.size;
  } catch (clientResolveError) {
    console.warn(
      '[performWixSync] client auto-provision skipped:',
      clientResolveError?.message || clientResolveError
    );
  }
  let psychologistsResolved = 0;
  try {
    const wixIdToPsychologistId = await resolvePsychologistsForBookings(dedupedBookings);
    psychologistsResolved = wixIdToPsychologistId.size;
  } catch (psychResolveError) {
    console.warn(
      '[performWixSync] psychologist auto-provision skipped:',
      psychResolveError?.message || psychResolveError
    );
  }

  let filteredSessionRows = sessionRows;
  if (locallyModifiedIds.size) {
    filteredSessionRows = sessionRows.filter(r => !locallyModifiedIds.has(r.wix_booking_id));
  }

  let sessionData = null;
  let sessionError = null;

  if (filteredSessionRows.length > 0) {
    const upsertSessions = await sessionRowsForSchema(filteredSessionRows);
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .upsert(upsertSessions, { onConflict: 'wix_booking_id' })
      .select('id,wix_booking_id,status');
    sessionData = data;
    sessionError = error;
  }

  if (sessionError) {
    const msg = String(sessionError.message || '');
    const missingBridgeColumn =
      msg.includes("Could not find the 'source' column") ||
      msg.includes("Could not find the 'wix_booking_id' column") ||
      msg.includes("Could not find the 'wix_payload' column") ||
      msg.includes("Could not find the 'booking_created_at' column");
    const missingConflictConstraint =
      msg.includes('no unique or exclusion constraint matching the ON CONFLICT specification');

    if (missingBridgeColumn || missingConflictConstraint) {
      console.warn(
        '[performWixSync] sessions mirror skipped: run sessions wix bridge migration (missing columns or unique index on wix_booking_id)'
      );
      return {
        upserted: data?.length ?? rows.length,
        sessionsUpserted: 0,
        clientsResolved,
        psychologistsResolved,
        sessionMirrorSkipped: true,
        extractionTried,
        fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
      };
    }

    const err = new Error(sessionError.message || 'Sessions upsert failed');
    err.code = sessionError.code;
    throw err;
  }

  // Resolve/create user+client rows and link sessions
  try {
    await resolveClientsForBookings(dedupedBookings);
  } catch (err) {
    console.warn('[performWixSync] client resolve non-blocking error:', err.message || err);
  }

  // Link ₹0 follow-up sessions under their parent package booking (wix_bookings table)
  try {
    const r = await linkWixBookingsPackages();
    if (r.childrenLinked > 0) {
      console.log(`[performWixSync] linked ${r.childrenLinked} package children across ${r.packagesProcessed} packages`);
    }
  } catch (err) {
    console.warn('[performWixSync] package linking non-blocking error:', err.message || err);
  }

  // Fire-and-forget: create Google Meet links + send WhatsApp for new Wix sessions
  const wixBookingIds = dedupedBookings.map((b) => b.id != null ? String(b.id) : null).filter(Boolean);
  if (wixBookingIds.length) {
    processNewWixSessions(wixBookingIds).catch((err) => {
      console.warn('[performWixSync] meet+notify non-blocking error:', err.message || err);
    });
  }

  return {
    upserted: data?.length ?? rows.length,
    sessionsUpserted: sessionData?.length ?? sessionRows.length,
    clientsResolved,
    psychologistsResolved,
    sessionMirrorSkipped: false,
    extractionTried,
    fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
  };
}

/**
 * POST /admin/wix/sync
 * Fetch live discover payload and upsert all booking rows into `wix_bookings`.
 */
async function syncWixBookings(req, res) {
  try {
    const result = await performWixSync();

    return res.json({
      success: true,
      message: `Synced ${result.upserted} Wix booking(s)`,
      data: {
        upserted: result.upserted,
        sessionsUpserted: result.sessionsUpserted,
        clientsResolved: result.clientsResolved,
        psychologistsResolved: result.psychologistsResolved,
        sessionMirrorSkipped: Boolean(result.sessionMirrorSkipped),
        extractionTried: result.extractionTried,
        fetchedAt: result.fetchedAt,
      },
    });
  } catch (e) {
    if (e.code === 'WIX_CONFIG_MISSING') {
      return res.status(503).json({ success: false, error: e.message });
    }
    if (e.code === '42P01') {
      return res.status(500).json({
        success: false,
        error: e.message,
        hint: 'Table wix_bookings missing — run the migration in supabase/migrations/20260420120000_wix_bookings.sql',
      });
    }
    if (e.httpStatus) {
      return res.status(e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : 502).json({
        success: false,
        error: e.message,
      });
    }
    console.error('[syncWixBookings]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * GET /admin/wix/bookings?page=1&limit=10&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&search=
 * List mirrored rows from Supabase (IST date boundaries when dates provided).
 */
async function listWixBookings(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10));
    const { dateFrom, dateTo, search, session_type } = req.query;
    const fromIdx = (page - 1) * limit;
    const toIdx = fromIdx + limit - 1;

    let q = supabaseAdmin.from('wix_bookings').select('*', { count: 'exact' });

    if (session_type && session_type !== 'all') {
      q = q.eq('session_type', session_type);
    }

    // Filter by created_at (when the booking was made), not start_time (when the session happens)
    if (dateFrom) {
      q = q.gte('created_at', `${dateFrom}T00:00:00+05:30`);
    }
    if (dateTo) {
      q = q.lte('created_at', `${dateTo}T23:59:59.999+05:30`);
    }

    const term = typeof search === 'string' ? search.trim().replace(/,/g, '') : '';
    if (term) {
      const esc = term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%${esc}%`;
      q = q.or(
        `client_email.ilike.${pattern},client_full_name.ilike.${pattern},client_first_name.ilike.${pattern},therapist_name.ilike.${pattern},title.ilike.${pattern}`
      );
    }

    // Newest Wix bookings on top. `created_at` is the row insert time (stable
    // across re-upserts), so it reflects when we first saw the booking.
    // `synced_at` is re-written on every poll and would collapse to ~same
    // timestamp for all rows — do not use it for ordering.
    q = q
      .order('created_at', { ascending: false, nullsFirst: false })
      .order('start_time', { ascending: false, nullsFirst: false })
      .range(fromIdx, toIdx);

    const { data, error, count } = await q;

    if (error) {
      console.error('[listWixBookings]', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to list wix_bookings',
        hint:
          error.code === '42P01'
            ? 'Table wix_bookings missing — run the migration in supabase/migrations/20260420120000_wix_bookings.sql'
            : undefined,
      });
    }

    const dedupedData = dedupeBookings((data || []).map((row) => ({
      id: row.wix_booking_id,
      status: row.status,
      createdDate: row.payload?.createdDate || row.created_at,
      startTime: row.start_time,
      scheduleId: row.schedule_id,
      sessionId: row.wix_session_id,
      title: row.title,
      contactId: row.contact_id,
      client: { email: row.client_email, contactId: row.contact_id },
      __row: row,
    }))).map((x) => x.__row || x);

    // Compute total *sessions* (a Package of 3 = 3 sessions, children of a package = 0)
    // by aggregating session_count and package linkage across the same date range.
    let totalSessions = count ?? 0;
    try {
      let aggQ = supabaseAdmin
        .from('wix_bookings')
        .select('session_type, session_count, package_parent_booking_id');
      if (session_type && session_type !== 'all') aggQ = aggQ.eq('session_type', session_type);
      if (dateFrom) aggQ = aggQ.gte('created_at', `${dateFrom}T00:00:00+05:30`);
      if (dateTo)   aggQ = aggQ.lte('created_at', `${dateTo}T23:59:59.999+05:30`);
      const { data: rowsForCount } = await aggQ;
      if (Array.isArray(rowsForCount)) {
        totalSessions = rowsForCount.reduce((sum, r) => {
          if (r.package_parent_booking_id) return sum;            // child of a package — already counted under parent
          if (r.session_type === 'package') return sum + (r.session_count || 1);
          return sum + 1;
        }, 0);
      }
    } catch { /* fall back to count */ }

    return res.json({
      success: true,
      data: {
        bookings: dedupedData,
        pagination: {
          page,
          limit,
          total: count ?? 0,
          totalPages: Math.max(1, Math.ceil((count || 0) / limit)),
          totalSessions,
        },
      },
    });
  } catch (e) {
    console.error('[listWixBookings]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * GET /admin/wix/orphans
 * Detect suspicious bookings:
 *   1. ₹0 rows that should be linked to a package but aren't
 *   2. Duplicate bookings (same client + same start_time)
 *   3. Children whose parent package no longer exists
 *   4. Packages with more children than session_count - 1
 */
async function listWixOrphans(req, res) {
  try {
    const { data: all } = await supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id, client_email, client_full_name, therapist_name, price, currency, session_type, session_count, session_index, package_parent_booking_id, start_time, status, contact_id, service_id, payload')
      .order('start_time', { ascending: true });

    const rows = all || [];
    const packages = rows.filter(r => r.session_type === 'package');
    const orphans = [];

    // 1. Eligible ₹0 rows that aren't linked
    rows.forEach(r => {
      if (r.package_parent_booking_id) return;
      if (r.session_type === 'package') return;
      if (parseFloat(r.price ?? 0) > 0) return;
      const matchPkg = packages.find(p =>
        p.client_email?.toLowerCase() === r.client_email?.toLowerCase() &&
        (r.start_time || '') >= (p.start_time || '')
      );
      if (matchPkg) {
        orphans.push({
          ...r,
          orphanReason: 'eligible-but-unlinked',
          orphanDetail: `Free session that matches ${matchPkg.client_email}'s Package of ${matchPkg.session_count}, but linker did not pick it up (cap reached, or sync timing).`,
        });
      }
    });

    // 2. Duplicate bookings (same client_email + same start_time within 1 minute)
    const byKey = {};
    rows.forEach(r => {
      const k = `${(r.client_email||'').toLowerCase()}|${r.start_time?.slice(0,16) || ''}`;
      if (!k.replace('|','')) return;
      (byKey[k] = byKey[k] || []).push(r);
    });
    Object.values(byKey).forEach(group => {
      if (group.length > 1) {
        // Skip the first (the "primary"); rest are duplicates
        group.slice(1).forEach(r => orphans.push({
          ...r,
          orphanReason: 'duplicate-booking',
          orphanDetail: `Same client + same start time as another booking. Wix appears to have created a duplicate.`,
        }));
      }
    });

    // 3. Children whose parent doesn't exist
    const pkgIds = new Set(packages.map(p => p.wix_booking_id));
    rows.forEach(r => {
      if (r.package_parent_booking_id && !pkgIds.has(r.package_parent_booking_id)) {
        orphans.push({
          ...r,
          orphanReason: 'dangling-child',
          orphanDetail: `Linked to parent ${r.package_parent_booking_id} which doesn't exist.`,
        });
      }
    });

    // 4. Packages with too many children
    packages.forEach(p => {
      const childCount = rows.filter(r => r.package_parent_booking_id === p.wix_booking_id).length;
      const cap = (p.session_count || 1) - 1;
      if (childCount > cap) {
        orphans.push({
          ...p,
          orphanReason: 'package-overflow',
          orphanDetail: `Package of ${p.session_count} but has ${childCount} children (max should be ${cap}).`,
        });
      }
    });

    // Dedup by wix_booking_id keeping first reason
    const seen = new Set();
    const dedupedOrphans = orphans.filter(o => {
      if (seen.has(o.wix_booking_id)) return false;
      seen.add(o.wix_booking_id);
      return true;
    });

    return res.json({
      success: true,
      data: {
        orphans: dedupedOrphans,
        summary: {
          total: dedupedOrphans.length,
          eligibleButUnlinked: dedupedOrphans.filter(o => o.orphanReason === 'eligible-but-unlinked').length,
          duplicateBookings: dedupedOrphans.filter(o => o.orphanReason === 'duplicate-booking').length,
          danglingChildren: dedupedOrphans.filter(o => o.orphanReason === 'dangling-child').length,
          packageOverflow: dedupedOrphans.filter(o => o.orphanReason === 'package-overflow').length,
        },
      },
    });
  } catch (e) {
    console.error('[listWixOrphans]', e);
    return res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * POST /admin/wix/backfill-clients
 * One-time backfill: create/resolve users+clients from existing wix_bookings rows.
 */
async function backfillWixClients(req, res) {
  try {
    const limit = Math.min(5000, Math.max(100, parseInt(String(req.body?.limit || '2000'), 10) || 2000));
    const { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .select(
        'wix_booking_id,client_email,client_first_name,client_last_name,client_phone,title,start_time,status,contact_id'
      )
      .not('client_email', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to read wix_bookings' });
    }

    const bookings = (data || [])
      .filter((r) => r.client_email)
      .map((r) => ({
        id: r.wix_booking_id,
        status: r.status,
        title: r.title,
        startTime: r.start_time,
        contactId: r.contact_id,
        client: {
          email: r.client_email,
          firstName: r.client_first_name,
          lastName: r.client_last_name,
          phone: r.client_phone,
          contactId: r.contact_id,
        },
      }));

    const wixIdToClientId = await resolveClientsForBookings(bookings);
    return res.json({
      success: true,
      message: `Backfilled ${wixIdToClientId.size} Wix client account(s)`,
      data: {
        scanned: bookings.length,
        resolved: wixIdToClientId.size,
      },
    });
  } catch (e) {
    console.error('[backfillWixClients]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * GET /admin/wix/therapists
 * List therapists discovered from wix_bookings and matched psychologist rows.
 */
async function listWixTherapists(req, res) {
  try {
    const pageSize = Math.min(2000, Math.max(200, parseInt(String(req.query.page_size || '2000'), 10) || 2000));
    const maxBookingsParsed = req.query.max_bookings != null ? parseInt(String(req.query.max_bookings), 10) : NaN;
    const maxBookings =
      Number.isFinite(maxBookingsParsed) && maxBookingsParsed > 0
        ? Math.min(500000, maxBookingsParsed)
        : null;

    const summary = new Map();
    let bookingsScanned = 0;
    let bookingRowsWithNoTherapistIdentity = 0;
    let offset = 0;

    while (true) {
      const remainingBudget =
        maxBookings == null ? pageSize : Math.min(pageSize, maxBookings - bookingsScanned);
      if (remainingBudget <= 0) break;

      const pageEnd = offset + remainingBudget - 1;

      const { data: rows, error } = await supabaseAdmin
        .from('wix_bookings')
        .select('therapist_name,created_at,payload')
        .order('id', { ascending: true })
        .range(offset, pageEnd);

      if (error) {
        return res.status(500).json({ success: false, error: error.message || 'Failed to read wix_bookings' });
      }

      const batch = rows || [];
      if (batch.length === 0) break;

      for (const r of batch) {
        const payload = r.payload || {};
        const t = payload.therapist || {};
        const name = String(r.therapist_name || t.name || t.displayName || t.fullName || '').trim();
        const email = String(t.email || '').trim().toLowerCase() || null;
        const phone = String(t.phone || '').trim() || null;
        if (!name && !email) {
          bookingRowsWithNoTherapistIdentity += 1;
          continue;
        }
        const key = `${name.toLowerCase()}|${email || ''}`;
        const existing = summary.get(key);
        if (!existing) {
          summary.set(key, {
            name: name || null,
            email,
            phone,
            bookingsCount: 1,
            latestBookingAt: r.created_at || null,
            psychologist: null,
          });
        } else {
          existing.bookingsCount += 1;
          if ((r.created_at || '') > (existing.latestBookingAt || '')) {
            existing.latestBookingAt = r.created_at;
          }
        }
      }

      bookingsScanned += batch.length;
      offset += batch.length;

      if (batch.length < remainingBudget) break;
      if (maxBookings != null && bookingsScanned >= maxBookings) break;
    }

    const therapists = Array.from(summary.values());
    const staffEmailByName = new Map();
    try {
      const discover = await fetchWixDiscover({
        limit: process.env.WIX_DISCOVER_BOOKING_LIMIT || DEFAULT_WIX_SYNC_LIMIT,
      });
      const staffSample = discover?.json?.sections?.staff?.sample;
      if (Array.isArray(staffSample)) {
        for (const s of staffSample) {
          const n = String(s?.name || '').trim().toLowerCase();
          const e = String(s?.email || '').trim().toLowerCase();
          if (n && e) staffEmailByName.set(n, e);
        }
      }
    } catch (_e) {
      // Non-blocking; list should still work from mirrored data.
    }
    const { count: psychologistTableCount, error: psychCountErr } = await supabaseAdmin
      .from('psychologists')
      .select('*', { count: 'exact', head: true });
    if (psychCountErr) {
      console.warn('[listWixTherapists] psychologist count:', psychCountErr.message || psychCountErr);
    }

    const { data: psychologists } = await supabaseAdmin
      .from('psychologists')
      .select('id,email,first_name,last_name,phone,designation,profile_picture_url,created_at')
      .limit(5000);

    const psychByEmail = new Map();
    const psychByName = new Map();
    for (const p of psychologists || []) {
      const email = String(p.email || '').trim().toLowerCase();
      if (email) psychByEmail.set(email, p);
      const nameKey = `${String(p.first_name || '').trim().toLowerCase()} ${String(p.last_name || '').trim().toLowerCase()}`.trim();
      if (nameKey) psychByName.set(nameKey, p);
    }

    const mapped = therapists
      .map((t) => {
        const nameKey = String(t.name || '').trim().toLowerCase();
        const inferredEmail = t.email || staffEmailByName.get(nameKey) || null;
        const matched = (inferredEmail && psychByEmail.get(inferredEmail)) || psychByName.get(nameKey) || null;
        return {
          ...t,
          email: inferredEmail || t.email || matched?.email || null,
          psychologist: matched
            ? {
                id: matched.id,
                email: matched.email,
                phone: matched.phone,
                firstName: matched.first_name,
                lastName: matched.last_name,
                designation: matched.designation,
                profilePictureUrl: matched.profile_picture_url,
                createdAt: matched.created_at,
              }
            : null,
        };
      })
      .sort((a, b) => (b.latestBookingAt || '').localeCompare(a.latestBookingAt || ''));

    // Final dedupe pass:
    // 1) If linked to psychologist, dedupe by psychologist.id
    // 2) Else dedupe by normalized name
    const dedupedMap = new Map();
    for (const row of mapped) {
      const linkedPsychId = row?.psychologist?.id || null;
      const normalizedName = String(row?.name || '').trim().toLowerCase();
      const key = linkedPsychId ? `psych:${linkedPsychId}` : `name:${normalizedName}`;

      if (!dedupedMap.has(key)) {
        dedupedMap.set(key, { ...row });
        continue;
      }

      const existing = dedupedMap.get(key);
      existing.bookingsCount = (existing.bookingsCount || 0) + (row.bookingsCount || 0);
      if ((row.latestBookingAt || '') > (existing.latestBookingAt || '')) {
        existing.latestBookingAt = row.latestBookingAt;
      }
      // Prefer rows that have richer contact fields
      if (!existing.email && row.email) existing.email = row.email;
      if (!existing.phone && row.phone) existing.phone = row.phone;
      if (!existing.psychologist && row.psychologist) existing.psychologist = row.psychologist;
    }

    const data = Array.from(dedupedMap.values()).sort((a, b) =>
      (b.latestBookingAt || '').localeCompare(a.latestBookingAt || '')
    );

    const psychologistIdsLinkedFromBookingList = new Set(
      data.map((row) => row.psychologist?.id).filter(Boolean)
    );
    const bookingTherapistEmails = new Set(
      therapists.map((t) => String(t.email || '').trim().toLowerCase()).filter(Boolean)
    );
    const bookingTherapistNamesLower = therapists
      .map((t) => String(t.name || '').trim().toLowerCase())
      .filter(Boolean);

    const psychologistPresentInMirrorBookingFields = (p) => {
      const em = String(p.email || '').trim().toLowerCase();
      if (em && bookingTherapistEmails.has(em)) return true;
      const nameKey =
        `${String(p.first_name || '').trim().toLowerCase()} ${String(p.last_name || '').trim().toLowerCase()}`.trim();
      if (nameKey.length >= 4 && bookingTherapistNamesLower.includes(nameKey)) return true;
      return bookingTherapistNamesLower.some((bn) =>
        bookingDisplayNameProbablySamePsychologist(bn, p)
      );
    };

    /** Profiles that never appear linked (still may show UNLINKED on this page if their name/email appears on rows). */
    const psychologistsWithoutGreenProfileLinkFromMirror = (psychologists || []).filter(
      (p) => !psychologistIdsLinkedFromBookingList.has(p.id)
    );

    /** Best-effort “never appears as therapist on mirrored Wix rows” vs “might be an UNLINKED card above”. */
    const psychologistsProbablyMissingFromBookingMirror = (psychologists || []).filter((p) => {
      if (psychologistIdsLinkedFromBookingList.has(p.id)) return false;
      return !psychologistPresentInMirrorBookingFields(p);
    });

    const psychologistsUnlinkedButPresentOnBookingList = psychologistsWithoutGreenProfileLinkFromMirror.filter((p) =>
      psychologistPresentInMirrorBookingFields(p)
    ).length;

    const truncationWarning =
      psychologistTableCount != null &&
      (psychologists || []).length < psychologistTableCount;

    return res.json({
      success: true,
      data: {
        therapists: data,
        total: data.length,
        meta: {
          bookingsScanned,
          bookingRowsWithNoTherapistIdentity,
          distinctTherapistIdentitiesAfterDedupe: data.length,
          psychologistProfilesLinkedMatched: psychologistIdsLinkedFromBookingList.size,
          psychologistsTableCount:
            psychologistTableCount == null ? null : Number(psychologistTableCount),
          psychologistsLoadedForMatching: (psychologists || []).length,
          psychologistsUnlinkedShowingOnPageEstimated: psychologistsUnlinkedButPresentOnBookingList,
          psychologistsProbablyMissingFromSyncedWixBookings: psychologistsProbablyMissingFromBookingMirror.length,
          samplePsychologistsProbablyMissingFromMirror: psychologistsProbablyMissingFromBookingMirror.slice(0, 20).map(
            (p) => ({
              id: p.id,
              displayName:
                `${p.first_name || ''} ${p.last_name || ''}`.trim() ||
                (p.email ? p.email.split('@')[0] : 'Unknown'),
              email: p.email || null,
            })
          ),
          psychMatchListMayBeIncomplete: truncationWarning || false,
          maxBookingsCap: maxBookings,
          scanCompletesWholeMirror: maxBookings == null,
        },
      },
    });
  } catch (e) {
    console.error('[listWixTherapists]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * POST /integrations/wix/realtime-sync
 * Secure webhook-style endpoint for Wix events; triggers immediate discover sync.
 * Header: x-wix-webhook-key: <WIX_WEBHOOK_SECRET>
 */
async function realtimeSyncFromWix(req, res) {
  try {
    const expected = process.env.WIX_WEBHOOK_SECRET || process.env.WIX_DISCOVER_API_KEY || '';
    const given = req.headers['x-wix-webhook-key'] || req.headers['X-Wix-Webhook-Key'];

    if (!expected) {
      return res.status(503).json({ success: false, error: 'WIX_WEBHOOK_SECRET is not configured' });
    }
    if (!given || given !== expected) {
      return res.status(401).json({ success: false, error: 'Unauthorized webhook request' });
    }

    const body = req.body || {};
    const eventType = body.eventType || 'unknown';
    const enriched = body.booking || null;
    const rawEventPayload = body.eventPayload || null;
    const enrichedList = Array.isArray(body.bookings) ? body.bookings : enriched ? [enriched] : [];

    // Merge variant/package data from the raw Wix event (same data Zapier receives)
    // into the enriched booking so the mapper can detect package types.
    if (rawEventPayload && enrichedList.length) {
      const rawVariants =
        rawEventPayload.selectedVariants ||
        rawEventPayload.bookedEntity?.selectedVariants ||
        rawEventPayload.formInfo?.variantSelections ||
        rawEventPayload.variantSelections ||
        null;
      if (rawVariants) {
        for (const eb of enrichedList) {
          if (!eb.variantSelections) eb.variantSelections = rawVariants;
        }
        console.log(`[realtimeSyncFromWix] merged variant data from raw event:`, JSON.stringify(rawVariants).slice(0, 200));
      }
    }

    let directUpsert = { upserted: 0, sessionsUpserted: 0 };
    if (enrichedList.length) {
      try {
        directUpsert = await upsertEnrichedBookings(enrichedList);
        console.log(
          `[realtimeSyncFromWix] ${eventType}: direct upsert ${directUpsert.upserted} booking(s)`
        );
      } catch (err) {
        console.error('[realtimeSyncFromWix] direct upsert failed:', err.message || err);
      }
    }

    // Respond fast to Wix; reconcile in background to survive Wix index lag.
    res.json({
      success: true,
      message: `Realtime sync accepted (${eventType})`,
      data: { direct: directUpsert, reconcile: 'scheduled' },
    });

    // Fire-and-forget reconciliation: discover may lag by a few seconds after
    // booking.created, so pull twice with a short backoff to catch stragglers.
    (async () => {
      const delays = [3000, 15000];
      for (const d of delays) {
        try {
          await sleep(d);
          const r = await performWixSync();
          console.log(
            `[realtimeSyncFromWix] reconcile(+${d}ms): synced ${r.upserted} booking(s)`
          );
        } catch (err) {
          if (err.code !== 'WIX_CONFIG_MISSING') {
            console.error(`[realtimeSyncFromWix] reconcile(+${d}ms) failed:`, err.message || err);
          }
        }
      }
    })().catch(() => {});
    return;
  } catch (e) {
    console.error('[realtimeSyncFromWix]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * GET /admin/wix/bookings/:id
 * Return a single wix_bookings row by Supabase id (not wix_booking_id).
 */
async function getWixBookingDetails(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }
    return res.json({ success: true, data: { booking: data } });
  } catch (e) {
    console.error('[getWixBookingDetails]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * PATCH /admin/wix/bookings/:id
 * Edit a wix_bookings row. Sets locally_modified = true so Wix sync won't overwrite.
 */
async function editWixBooking(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body || {};

    // Sanitise: only allow editing known columns
    const allowed = ['status', 'title', 'start_time', 'end_time', 'notes', 'price', 'currency', 'therapist_name'];
    const safeUpdates = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) safeUpdates[key] = updates[key];
    }
    safeUpdates.locally_modified = true;
    safeUpdates.synced_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .update(safeUpdates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    // Mirror to sessions if exists
    if (data.wix_booking_id) {
      const sessionUpdates = { locally_modified: true };
      if (safeUpdates.status) sessionUpdates.status = safeUpdates.status;
      if (safeUpdates.title) sessionUpdates.notes = safeUpdates.title;
      if (safeUpdates.session_type) sessionUpdates.session_type = safeUpdates.session_type;
      if (safeUpdates.price) {
        sessionUpdates.price = safeUpdates.price;
        sessionUpdates.amount = safeUpdates.price;
      }
      if (safeUpdates.start_time) {
        sessionUpdates.scheduled_date = safeUpdates.start_time.split('T')[0];
        sessionUpdates.scheduled_time = safeUpdates.start_time.split('T')[1]?.split('.')[0];
      }
      await supabaseAdmin.from('sessions').update(sessionUpdates).eq('wix_booking_id', data.wix_booking_id);
    }

    return res.json({ success: true, message: 'Wix booking updated', data: { booking: data } });
  } catch (e) {
    console.error('[editWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * DELETE /admin/wix/bookings/:id
 * Soft-delete: sets status='deleted' + locally_modified=true so sync won't re-create.
 */
async function deleteWixBooking(req, res) {
  try {
    const { id } = req.params;
    const updates = { status: 'deleted', locally_modified: true, synced_at: new Date().toISOString() };

    let { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .update(updates)
      .eq('id', id)
      .select('id, wix_booking_id')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    if (!data) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }

    // Mirror to sessions
    if (data.wix_booking_id) {
      await supabaseAdmin
        .from('sessions')
        .update({ status: 'cancelled', locally_modified: true })
        .eq('wix_booking_id', data.wix_booking_id);
    }

    return res.json({ success: true, message: 'Wix booking deleted', data: { booking: data } });
  } catch (e) {
    console.error('[deleteWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * PATCH /admin/wix/bookings/:id/complete
 * Mark a Wix booking as completed + locally_modified=true.
 */
async function completeWixBooking(req, res) {
  try {
    const { id } = req.params;
    const updates = { status: 'completed', locally_modified: true, synced_at: new Date().toISOString() };

    let { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    if (!data) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }

    // Mirror to sessions
    if (data.wix_booking_id) {
      await supabaseAdmin
        .from('sessions')
        .update({ status: 'completed', locally_modified: true })
        .eq('wix_booking_id', data.wix_booking_id);
    }

    return res.json({ success: true, message: 'Wix booking marked as completed', data: { booking: data } });
  } catch (e) {
    console.error('[completeWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * PATCH /admin/wix/bookings/:id/no-show
 * Mark a Wix booking as no-show + locally_modified=true.
 */
async function noShowWixBooking(req, res) {
  try {
    const { id } = req.params;
    const updates = { status: 'no_show', locally_modified: true, synced_at: new Date().toISOString() };

    let { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'Wix booking not found' });

    // Mirror to sessions
    if (data.wix_booking_id) {
      await supabaseAdmin
        .from('sessions')
        .update({ status: 'no_show', locally_modified: true })
        .eq('wix_booking_id', data.wix_booking_id);
    }

    return res.json({ success: true, message: 'Wix booking marked as no-show', data: { booking: data } });
  } catch (e) {
    console.error('[noShowWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

module.exports = {
  performWixSync,
  upsertEnrichedBookings,
  syncWixBookings,
  listWixBookings,
  listWixOrphans,
  listWixTherapists,
  backfillWixClients,
  realtimeSyncFromWix,
  getWixBookingDetails,
  editWixBooking,
  deleteWixBooking,
  completeWixBooking,
  noShowWixBooking,
};
