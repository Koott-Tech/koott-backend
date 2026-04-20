const { supabaseAdmin } = require('../config/supabase');
const { fetchWixDiscover, extractBookingsList } = require('../utils/wixDiscoverClient');
const { discoverRowToDb } = require('../utils/wixBookingMapper');

async function performWixSync() {
  const r = await fetchWixDiscover({
    limit: process.env.WIX_DISCOVER_BOOKING_LIMIT,
  });
  if (!r.ok) {
    const err = new Error(r.json?.error || r.json?.message || `Wix discover failed (HTTP ${r.status})`);
    err.httpStatus = r.status;
    throw err;
  }

  const { bookings, extractionTried } = extractBookingsList(r.json);
  if (!bookings.length) {
    return {
      upserted: 0,
      extractionTried,
      fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
    };
  }

  const rows = bookings.map(discoverRowToDb).map((row) =>
    Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))
  );
  const { data, error } = await supabaseAdmin
    .from('wix_bookings')
    .upsert(rows, { onConflict: 'wix_booking_id' })
    .select('wix_booking_id');

  if (error) {
    const err = new Error(error.message || 'Supabase upsert failed');
    err.code = error.code;
    throw err;
  }

  return {
    upserted: data?.length ?? rows.length,
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

    q = q.order('start_time', { ascending: false, nullsFirst: false }).range(fromIdx, toIdx);

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

    return res.json({
      success: true,
      data: {
        bookings: data || [],
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

    const result = await performWixSync();
    return res.json({
      success: true,
      message: `Realtime sync saved ${result.upserted} booking(s)`,
      data: result,
    });
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
  syncWixBookings,
  listWixBookings,
  realtimeSyncFromWix,
};
