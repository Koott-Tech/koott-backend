/**
 * Call Wix REST API directly (same as what Zapier does) to get full booking
 * details including variant selections.
 *
 * Wix REST API: GET https://www.wixapis.com/bookings/v2/bookings/{bookingId}
 * Auth: Authorization header with the IST token
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const bookingId = 'a8ca41f6-c5c4-4f2a-abbf-002343bf77d6'; // anishvalsalan - ₹7499 package

async function main() {
  const apiKey = process.env.WIX_DISCOVER_API_KEY;
  if (!apiKey) { console.error('Missing WIX_DISCOVER_API_KEY'); return; }

  console.log('Token prefix:', apiKey.slice(0, 20) + '...\n');

  // Try multiple API endpoints to find variant data
  const endpoints = [
    {
      name: 'Bookings V2 - Get Booking',
      url: `https://www.wixapis.com/bookings/v2/bookings/${bookingId}`,
    },
    {
      name: 'Bookings V1 - Get Booking',
      url: `https://www.wixapis.com/bookings/v1/bookings/${bookingId}`,
    },
    {
      name: 'eCommerce Orders - by orderId',
      url: `https://www.wixapis.com/ecom/v1/orders/e6958445-280c-4d1f-941b-1eb6ef8091a9`,
    },
  ];

  for (const ep of endpoints) {
    console.log(`\n=== ${ep.name} ===`);
    console.log(`URL: ${ep.url}\n`);
    try {
      const res = await fetch(ep.url, {
        method: 'GET',
        headers: {
          'Authorization': apiKey,
          'wix-site-id': 'bdc65312-ea74-4f9e-bb82-6882a429d42b',
          'Content-Type': 'application/json',
        },
      });
      console.log(`Status: ${res.status} ${res.statusText}`);
      const body = await res.text();
      
      if (res.ok) {
        const json = JSON.parse(body);
        // Pretty print but search for variant/package keywords
        const str = JSON.stringify(json, null, 2);
        
        // Check for variant data
        const lower = str.toLowerCase();
        for (const keyword of ['variant', 'package', 'session', 'selectedvariant', 'customfield', 'custom_form', 'numberOfSessions']) {
          const idx = lower.indexOf(keyword.toLowerCase());
          if (idx >= 0) {
            console.log(`\n⚡ Found "${keyword}" at position ${idx}:`);
            console.log(str.slice(Math.max(0, idx - 100), idx + 200));
          }
        }
        
        // Print full response (truncated)
        console.log('\n--- FULL RESPONSE (first 3000 chars) ---');
        console.log(str.slice(0, 3000));
        if (str.length > 3000) console.log(`\n... (${str.length} total chars)`);
      } else {
        console.log('Error body:', body.slice(0, 500));
      }
    } catch (err) {
      console.log('Fetch error:', err.message);
    }
  }
}

main().catch(console.error);
