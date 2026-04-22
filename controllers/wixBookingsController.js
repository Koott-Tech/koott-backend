const { supabaseAdmin } = require('../config/supabase');
const { fetchWixDiscover, extractBookingsList } = require('../utils/wixDiscoverClient');
const { discoverRowToDb, discoverRowToSessionDb } = require('../utils/wixBookingMapper');
const { resolveClientsForBookings } = require('../services/wixClientResolverService');
const { resolvePsychologistsForBookings } = require('../services/wixPsychologistResolverService');

const DEFAULT_WIX_SYNC_LIMIT = Number.parseInt(
  process.env.WIX_DISCOVER_BOOKING_LIMIT || '100',
  10
) || 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Upsert an already-enriched booking object (from Velo webhook) directly.
 * Skips discover re-fetch and avoids the Wix index eventual-consistency gap.
 */
async function upsertEnrichedBookings(rawBookings) {
  const list = Array.isArray(rawBookings) ? rawBookings : rawBookings ? [rawBookings] : [];
  const deduped = dedupeBookings(list);

  let rows = deduped
    .map(discoverRowToDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
  const sessionRows = deduped
    .map(discoverRowToSessionDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));

  if (!rows.length) {
    return { upserted: 0, sessionsUpserted: 0, sessionMirrorSkipped: false };
  }

  rows = await applyMaxPriceGuard(rows);

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
    const { data: sessionData, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .upsert(sessionRows, { onConflict: 'wix_booking_id' })
      .select('id,wix_booking_id');
    if (sessionError) {
      const msg = String(sessionError.message || '');
      const recoverable =
        msg.includes("Could not find the 'source' column") ||
        msg.includes("Could not find the 'wix_booking_id' column") ||
        msg.includes("Could not find the 'wix_payload' column") ||
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
      sessionsUpserted = sessionData?.length ?? sessionRows.length;
    }
  }

  // Resolve/create user+client rows and link them to sessions
  let clientsResolved = 0;
  try {
    const m = await resolveClientsForBookings(list);
    clientsResolved = m.size;
  } catch (err) {
    console.warn('[upsertEnrichedBookings] client resolve non-blocking error:', err.message || err);
  }
  let psychologistsResolved = 0;
  try {
    const m = await resolvePsychologistsForBookings(list);
    psychologistsResolved = m.size;
  } catch (err) {
    console.warn('[upsertEnrichedBookings] psychologist resolve non-blocking error:', err.message || err);
  }

  return {
    upserted: data?.length ?? rows.length,
    sessionsUpserted,
    clientsResolved,
    psychologistsResolved,
    sessionMirrorSkipped,
  };
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
  if (!dedupedBookings.length) {
    return {
      upserted: 0,
      sessionsUpserted: 0,
      extractionTried,
      fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
    };
  }

  let rows = dedupedBookings
    .map(discoverRowToDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
  const sessionRows = dedupedBookings
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

  const { data: sessionData, error: sessionError } = await supabaseAdmin
    .from('sessions')
    .upsert(sessionRows, { onConflict: 'wix_booking_id' })
    .select('id,wix_booking_id,status');

  if (sessionError) {
    const msg = String(sessionError.message || '');
    const missingBridgeColumn =
      msg.includes("Could not find the 'source' column") ||
      msg.includes("Could not find the 'wix_booking_id' column") ||
      msg.includes("Could not find the 'wix_payload' column");
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
    const { dateFrom, dateTo, search } = req.query;
    const fromIdx = (page - 1) * limit;
    const toIdx = fromIdx + limit - 1;

    let q = supabaseAdmin.from('wix_bookings').select('*', { count: 'exact' });

    if (dateFrom) {
      q = q.gte('start_time', `${dateFrom}T00:00:00+05:30`);
    }
    if (dateTo) {
      q = q.lte('start_time', `${dateTo}T23:59:59.999+05:30`);
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

    return res.json({
      success: true,
      data: {
        bookings: dedupedData,
        pagination: {
          page,
          limit,
          total: count ?? 0,
          totalPages: Math.max(1, Math.ceil((count || 0) / limit)),
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
    const limit = Math.min(5000, Math.max(200, parseInt(String(req.query.limit || '2000'), 10) || 2000));
    const { data: rows, error } = await supabaseAdmin
      .from('wix_bookings')
      .select('therapist_name,created_at,payload')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to read wix_bookings' });
    }

    const summary = new Map();
    for (const r of rows || []) {
      const payload = r.payload || {};
      const t = payload.therapist || {};
      const name = String(r.therapist_name || t.name || t.displayName || t.fullName || '').trim();
      const email = String(t.email || '').trim().toLowerCase() || null;
      const phone = String(t.phone || '').trim() || null;
      if (!name && !email) continue;
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

    const data = therapists
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

    return res.json({
      success: true,
      data: {
        therapists: data,
        total: data.length,
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
    const enrichedList = Array.isArray(body.bookings) ? body.bookings : enriched ? [enriched] : [];

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

module.exports = {
  performWixSync,
  upsertEnrichedBookings,
  syncWixBookings,
  listWixBookings,
  listWixTherapists,
  backfillWixClients,
  realtimeSyncFromWix,
};
