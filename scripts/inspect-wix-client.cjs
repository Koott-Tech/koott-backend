/**
 * Inspect the raw Wix payload for a specific client email.
 * Run from littlecare-backend/:
 *   node scripts/inspect-wix-client.cjs abiyabijuthomas@gmail.com
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const email = process.argv[2] || 'abiyabijuthomas@gmail.com';

async function main() {
  const { data, error } = await supabase
    .from('wix_bookings')
    .select('wix_booking_id, title, status, price, currency, session_type, tags, start_time, payload')
    .ilike('client_email', email);

  if (error) { console.error('Error:', error.message); process.exit(1); }
  if (!data?.length) { console.log('No rows found for', email); process.exit(0); }

  for (const row of data) {
    console.log('\n=== Booking:', row.wix_booking_id, '===');
    console.log('title:', row.title);
    console.log('status:', row.status);
    console.log('price (stored):', row.price, row.currency);
    console.log('session_type (stored):', row.session_type);
    console.log('tags:', JSON.stringify(row.tags));
    console.log('start_time:', row.start_time);

    const p = row.payload || {};
    console.log('\n-- Key payload fields --');
    console.log('payload.price:', p.price);
    console.log('payload.currency:', p.currency);
    console.log('payload.pricingPlanInfo:', JSON.stringify(p.pricingPlanInfo, null, 2));
    console.log('payload.paymentDetails:', JSON.stringify(p.paymentDetails, null, 2));
    console.log('payload.rawBookedEntity.rate:', JSON.stringify(p.rawBookedEntity?.rate, null, 2));
    console.log('payload.rawBookedEntity.type:', p.rawBookedEntity?.type);
    console.log('payload.rawBookedEntity.tags:', JSON.stringify(p.rawBookedEntity?.tags));
    console.log('payload.tags:', JSON.stringify(p.tags));
    console.log('payload.status:', p.status);
  }
}

main().catch(console.error);
