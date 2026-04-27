/**
 * Check the specific package booking that just came in,
 * and inspect its variant selections in the payload.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  // 1. Find the new package booking by booking ID or email
  const { data, error } = await supabase
    .from('wix_bookings')
    .select('*')
    .or('client_email.eq.anishvalsalan@gmail.com,wix_booking_id.eq.a8ca41f6-c5c4-4f2a-abbf-002343bf77d6')
    .order('created_at', { ascending: false });

  if (error) { console.error(error.message); return; }

  if (!data.length) {
    console.log('Booking not synced yet. Checking ALL Aswathy Sampath bookings...');
    const { data: d2 } = await supabase
      .from('wix_bookings')
      .select('*')
      .ilike('therapist_name', '%aswathy sampath%')
      .order('created_at', { ascending: false });
    
    if (d2?.length) {
      for (const r of d2) {
        console.log(`\n₹${r.price} | ${r.client_full_name} | ${r.start_time}`);
        inspectPayload(r.payload);
      }
    }
    return;
  }

  console.log(`Found ${data.length} bookings for anishvalsalan@gmail.com:\n`);
  for (const r of data) {
    console.log(`=== ₹${r.price} | ${r.client_full_name} | ${r.therapist_name} | ${r.start_time} ===`);
    inspectPayload(r.payload);
  }

  // 2. Also check ALL bookings that have price > 3000 (likely packages)
  console.log('\n\n=== ALL HIGH-PRICE BOOKINGS (₹3000+) — likely packages ===\n');
  const { data: highPrice } = await supabase
    .from('wix_bookings')
    .select('title, client_full_name, client_email, therapist_name, price, start_time, payload')
    .gte('price', '2499')
    .order('price', { ascending: false });

  for (const r of (highPrice || [])) {
    const p = r.payload || {};
    const variants = p.variantSelections || p.rawFormInfo?.variantSelections || p.formInfo?.variantSelections || null;
    const tags = p.tags || [];
    console.log(`  ₹${r.price} | ${(r.client_full_name || '—').padEnd(20)} | ${(r.therapist_name || '—').padEnd(22)} | tags: ${JSON.stringify(tags)} | variants: ${JSON.stringify(variants) || 'NONE'}`);
  }
}

function inspectPayload(p) {
  if (!p) { console.log('  (no payload)'); return; }
  
  // Print ALL top-level keys
  console.log(`  Top-level keys: ${Object.keys(p).join(', ')}`);
  
  // Variant selections — THE KEY FIELD
  const variants = p.variantSelections || p.rawFormInfo?.variantSelections || p.formInfo?.variantSelections;
  console.log(`  variantSelections: ${JSON.stringify(variants, null, 2) || 'NONE'}`);
  
  // Check for variant in any nested location
  const payloadStr = JSON.stringify(p);
  const variantIdx = payloadStr.toLowerCase().indexOf('variant');
  if (variantIdx >= 0) {
    console.log(`  "variant" found at position ${variantIdx}:`);
    console.log(`    ...${payloadStr.slice(Math.max(0, variantIdx - 20), variantIdx + 200)}...`);
  }
  
  // Tags
  console.log(`  tags: ${JSON.stringify(p.tags)}`);
  
  // Title and service info
  console.log(`  title: "${p.title}"`);
  console.log(`  serviceId: ${p.serviceId}`);
  console.log(`  bookedEntity.title: "${p.rawBookedEntity?.title || p.bookedEntity?.title || '—'}"`);
  
  // Price info
  console.log(`  paymentState: ${p.paymentDetails?.state}`);
  console.log(`  finalPrice: ${p.paymentDetails?.balance?.finalPrice?.amount}`);
  console.log(`  catalogRate: ${p.rawBookedEntity?.rate?.defaultVariedPrice?.amount}`);
  
  // Pricing plan
  console.log(`  pricingPlanInfo: ${JSON.stringify(p.pricingPlanInfo) || 'NONE'}`);
  
  // Form info
  if (p.formInfo) console.log(`  formInfo: ${JSON.stringify(p.formInfo).slice(0, 300)}`);
  if (p.rawFormInfo) console.log(`  rawFormInfo: ${JSON.stringify(p.rawFormInfo).slice(0, 300)}`);
  
  // Check for any "pack" or "session" text anywhere
  const lower = payloadStr.toLowerCase();
  for (const keyword of ['package', 'pack of', 'sessions', 'bundle', 'couple']) {
    const idx = lower.indexOf(keyword);
    if (idx >= 0) {
      console.log(`  ⚡ "${keyword}" found: ...${payloadStr.slice(Math.max(0, idx - 30), idx + 60)}...`);
    }
  }
}

main().catch(console.error);
