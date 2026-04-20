const {
  fetchWixDiscover,
  extractBookingsList,
  buildFieldCatalog,
  summarizeBookingHuman,
  summarizeSections,
} = require('../utils/wixDiscoverClient');

/**
 * GET /admin/wix/discover-inspect
 * Admin-only: calls Wix `/_functions/discover` and returns payload shape + field catalog for bookings.
 */
async function discoverInspect(req, res) {
  try {
    const includeRaw =
      req.query.includeRaw === '1' ||
      req.query.includeRaw === 'true' ||
      req.query.full === '1';

    const { ok, status, endpoint, json } = await fetchWixDiscover({
      limit: process.env.WIX_DISCOVER_BOOKING_LIMIT,
    });

    if (!ok) {
      return res.status(status >= 400 && status < 600 ? status : 502).json({
        success: false,
        error: json?.error || json?.message || `Wix discover returned HTTP ${status}`,
        data: {
          endpoint,
          httpStatus: status,
          body: json,
        },
      });
    }

    const { bookings, extractionTried } = extractBookingsList(json);
    const fieldCatalog = buildFieldCatalog(bookings);
    const bookingSummaries = bookings.map((b, i) => ({
      index: i,
      human: summarizeBookingHuman(b),
    }));

    const discoverTopKeys = json && typeof json === 'object' ? Object.keys(json) : [];
    const sectionKeys =
      json?.sections && typeof json.sections === 'object' ? Object.keys(json.sections) : [];
    const bookingsSectionShape =
      json?.sections?.bookings && typeof json.sections.bookings === 'object'
        ? Object.keys(json.sections.bookings)
        : [];

    return res.json({
      success: true,
      data: {
        endpoint,
        fetchedAt: json?.fetchedAt || new Date().toISOString(),
        discoverTopKeys,
        sectionKeys,
        bookingsSectionShape,
        sectionsSummary: summarizeSections(json),
        bookings: {
          count: bookings.length,
          extractionTried,
          summaries: bookingSummaries,
          /** First few full objects for deep inspection in UI */
          samplesDetailed: bookings.slice(0, 5),
        },
        fieldCatalog,
        ...(includeRaw ? { discoverRaw: json } : {}),
      },
    });
  } catch (e) {
    if (e.code === 'WIX_CONFIG_MISSING') {
      return res.status(503).json({
        success: false,
        error: e.message,
        data: { code: 'WIX_CONFIG_MISSING' },
      });
    }
    if (e.name === 'AbortError') {
      return res.status(504).json({
        success: false,
        error: 'Wix discover request timed out',
      });
    }
    console.error('[wixDiscoverInspect]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

module.exports = {
  discoverInspect,
};
