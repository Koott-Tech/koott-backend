/**
 * wixOrderEnrichmentService.js
 *
 * Calls the Wix eCommerce Orders API (same data Zapier receives) to extract
 * the exact session type and count from the order's description lines.
 *
 * Example description lines from Wix:
 *   "50 min (Individual Session)"         → type: individual, count: 1
 *   "1 hr 20 min (Couple Session)"        → type: couple, count: 1
 *   "50 min (Individual 4-Session Pack)"  → type: package, count: 4
 *   "50 min (Individual 3-Session Pack)"  → type: package, count: 3
 */

const WIX_SITE_ID = 'bdc65312-ea74-4f9e-bb82-6882a429d42b';
const ECOM_SEARCH_URL = 'https://www.wixapis.com/ecom/v1/orders/search';

/**
 * Parse a Wix description line like "50 min (Individual 4-Session Pack)"
 * into { sessionType, sessionCount }.
 *
 * Returns null if the line doesn't match known patterns.
 */
function parseSessionDescription(descLine) {
  if (!descLine) return null;
  const str = descLine.toLowerCase();

  // Pattern: "... (Couple Session)"
  if (str.includes('couple')) {
    return { sessionType: 'couple', sessionCount: 1 };
  }

  // Pattern: "... (Individual N-Session Pack)"
  const packMatch = str.match(/(\d+)\s*-?\s*session\s*pack/i);
  if (packMatch) {
    return { sessionType: 'package', sessionCount: parseInt(packMatch[1], 10) };
  }

  // Pattern: "... (Individual Session)"
  if (str.includes('individual session') || str.includes('individual')) {
    return { sessionType: 'individual', sessionCount: 1 };
  }

  // Pattern: "... (Assessment Session)" or similar
  if (str.includes('assessment')) {
    return { sessionType: 'assessment', sessionCount: 1 };
  }

  return null;
}

/**
 * Fetch eCommerce order for a given wix_booking_id and extract session info.
 *
 * The Wix eCommerce catalogReference.catalogItemId matches our wix_booking_id.
 *
 * @param {string} wixBookingId - The booking ID from wix_bookings table
 * @returns {{ sessionType: string, sessionCount: number, descriptionLine: string, orderId: string } | null}
 */
async function fetchSessionInfoFromOrder(wixBookingId) {
  const apiKey = process.env.WIX_DISCOVER_API_KEY;
  if (!apiKey) {
    console.warn('[wixOrderEnrichment] WIX_DISCOVER_API_KEY not set');
    return null;
  }

  try {
    // Search eCommerce orders where the line item's catalogItemId matches the booking ID
    const res = await fetch(ECOM_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'wix-site-id': WIX_SITE_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        search: {
          filter: {
            'lineItems.catalogReference.catalogItemId': { '$eq': wixBookingId },
          },
          paging: { limit: 1 },
        },
      }),
    });

    if (!res.ok) {
      console.warn(`[wixOrderEnrichment] eCommerce API returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    const order = data.orders?.[0];
    if (!order) {
      console.log(`[wixOrderEnrichment] No order found for booking ${wixBookingId}`);
      return null;
    }

    // Find the line item matching our booking
    const lineItem = order.lineItems?.find(
      (li) => li.catalogReference?.catalogItemId === wixBookingId
    ) || order.lineItems?.[0];

    if (!lineItem) return null;

    // Parse description lines — the session type is in lines like "50 min (Individual 4-Session Pack)"
    for (const dl of (lineItem.descriptionLines || [])) {
      const text = dl.plainText?.original || dl.plainTextValue?.original || '';
      const parsed = parseSessionDescription(text);
      if (parsed) {
        return {
          ...parsed,
          descriptionLine: text,
          orderId: order.id,
          orderNumber: order.number,
        };
      }
    }

    console.log(`[wixOrderEnrichment] No matching description line for booking ${wixBookingId}`);
    return null;
  } catch (err) {
    console.error(`[wixOrderEnrichment] Error fetching order for ${wixBookingId}:`, err.message || err);
    return null;
  }
}

/**
 * Batch-fetch session info for multiple booking IDs.
 *
 * @param {string[]} wixBookingIds
 * @returns {Map<string, { sessionType, sessionCount, descriptionLine, orderId }>}
 */
async function fetchSessionInfoBatch(wixBookingIds) {
  const results = new Map();

  // Process in small batches to avoid rate limiting
  const BATCH_SIZE = 5;
  for (let i = 0; i < wixBookingIds.length; i += BATCH_SIZE) {
    const batch = wixBookingIds.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (id) => {
      const info = await fetchSessionInfoFromOrder(id);
      if (info) results.set(id, info);
    });
    await Promise.all(promises);

    // Small delay between batches to be nice to the API
    if (i + BATCH_SIZE < wixBookingIds.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}

module.exports = {
  parseSessionDescription,
  fetchSessionInfoFromOrder,
  fetchSessionInfoBatch,
};
