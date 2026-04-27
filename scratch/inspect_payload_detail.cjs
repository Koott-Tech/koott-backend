/**
 * Deep-inspect the payload of bookings for the 3 known package groups,
 * plus check ALL distinct titles/service names to find package keywords.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const { data: all, error } = await supabase
    .from('wix_bookings')
    .select('id, wix_booking_id, title, client_full_name, client_email, therapist_name, price, status, start_time, session_type, session_count, payload')
    .order('start_time', { ascending: true });

  if (error) { console.error(error.message); return; }

  // 1. Check ALL distinct titles for "package" keyword
  console.log('=== ALL DISTINCT TITLES ===\n');
  const titles = new Map();
  for (const r of all) {
    const t = r.title || '(empty)';
    if (!titles.has(t)) titles.set(t, { count: 0, prices: [], emails: [] });
    const entry = titles.get(t);
    entry.count++;
    entry.prices.push(r.price || '0');
    if (r.client_email && !entry.emails.includes(r.client_email)) entry.emails.push(r.client_email);
  }
  for (const [title, info] of [...titles.entries()].sort((a,b) => b[1].count - a[1].count)) {
    const hasPackageKeyword = /pack|bundle|couple|assessment/i.test(title);
    console.log(`  ${String(info.count).padStart(3)}x  ${title.padEnd(35)} prices: [${info.prices.join(', ')}] ${hasPackageKeyword ? '⚡ KEYWORD MATCH' : ''}`);
  }

  // 2. Deep inspect the 3 known package groups
  console.log('\n=== DEEP INSPECT: Known package groups ===\n');
  const groups = [
    { email: 'devikasugathan007@gmail.com', therapist: 'dr. aswathy balan' },
    { email: 'rosmigema@gmail.com', therapist: 'dr. thaniya k leela' },
    { email: 'kabeeromanoor32@gmail.com', therapist: 'sinu mehana' },
  ];

  for (const g of groups) {
    const rows = all.filter(r => 
      r.client_email?.toLowerCase() === g.email && 
      r.therapist_name?.toLowerCase() === g.therapist
    );
    console.log(`--- ${g.email} → ${g.therapist} (${rows.length} bookings) ---`);
    for (const r of rows) {
      const p = r.payload || {};
      console.log(`  Price: ₹${r.price || 0} | Date: ${(r.start_time || '—').slice(0, 16)} | Title: "${r.title}"`);
      console.log(`    payload.title: "${p.title || '—'}"`);
      console.log(`    payload.serviceId: ${p.serviceId || '—'}`);
      console.log(`    payload.bookedEntity.title: "${p.rawBookedEntity?.title || p.bookedEntity?.title || '—'}"`);
      console.log(`    payload.status: ${p.status || '—'}`);
      console.log(`    paymentState: ${p.paymentDetails?.state || '—'}`);
      console.log(`    catalogPrice: ${p.rawBookedEntity?.rate?.defaultVariedPrice?.amount || p.paymentDetails?.balance?.finalPrice?.amount || '—'}`);
      console.log(`    pricingPlanInfo: ${p.pricingPlanInfo ? JSON.stringify(p.pricingPlanInfo) : 'NONE'}`);
      console.log(`    tags: ${JSON.stringify(p.tags || [])}`);
      // Check for variant selections or custom form fields
      console.log(`    variantSelections: ${JSON.stringify(p.variantSelections || p.rawFormInfo?.variantSelections || 'NONE')}`);
      console.log(`    formInfo keys: ${p.formInfo ? Object.keys(p.formInfo).join(', ') : 'NONE'}`);
      if (p.formInfo?.customFormFields) {
        console.log(`    customFormFields: ${JSON.stringify(p.formInfo.customFormFields).slice(0, 200)}`);
      }
      console.log('');
    }
  }

  // 3. Check if any paid session (>₹1000) has "package" in ANY payload field
  console.log('\n=== SCAN: Paid sessions with "package" anywhere in payload ===\n');
  let found = 0;
  for (const r of all) {
    if (!r.price || parseFloat(r.price) <= 0) continue;
    const payloadStr = JSON.stringify(r.payload || {}).toLowerCase();
    if (payloadStr.includes('package') || payloadStr.includes('pack of') || payloadStr.includes('bundle')) {
      found++;
      console.log(`  ₹${r.price} | ${r.client_full_name} | ${r.therapist_name} | "${r.title}"`);
      // Find where "package" appears
      const idx = payloadStr.indexOf('package');
      if (idx >= 0) console.log(`    context: ...${payloadStr.slice(Math.max(0, idx-50), idx+80)}...`);
    }
  }
  if (!found) console.log('  (none found)');

  // 4. Check couple sessions - user mentioned first Zapier example is couple
  console.log('\n=== SCAN: "couple" anywhere in payload ===\n');
  let coupleFound = 0;
  for (const r of all) {
    const payloadStr = JSON.stringify(r.payload || {}).toLowerCase();
    if (payloadStr.includes('couple')) {
      coupleFound++;
      console.log(`  ₹${r.price || 0} | ${r.client_full_name} | ${r.therapist_name} | "${r.title}"`);
      const idx = payloadStr.indexOf('couple');
      if (idx >= 0) console.log(`    context: ...${payloadStr.slice(Math.max(0, idx-50), idx+80)}...`);
    }
  }
  if (!coupleFound) console.log('  (none found)');
}

main().catch(console.error);
