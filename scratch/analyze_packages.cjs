/**
 * Analyze wix_bookings to find package tracking patterns.
 * Goal: identify how zero-price (promo code) sessions link to their paid parent session.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  // 1. Get ALL wix_bookings with key fields
  const { data: all, error } = await supabase
    .from('wix_bookings')
    .select('id, wix_booking_id, title, client_full_name, client_email, contact_id, schedule_id, therapist_name, price, currency, status, start_time, session_type, session_count, payload, created_at')
    .order('start_time', { ascending: true });

  if (error) { console.error('Query error:', error.message); return; }
  console.log(`\nTotal wix_bookings: ${all.length}\n`);

  // 2. Separate zero-price vs paid
  const zeroPriceRows = all.filter(r => !r.price || parseFloat(r.price) === 0);
  const paidRows = all.filter(r => r.price && parseFloat(r.price) > 0);

  console.log(`Zero/null price rows: ${zeroPriceRows.length}`);
  console.log(`Paid rows: ${paidRows.length}\n`);

  // 3. Check zero-price rows for linking fields
  console.log('=== ZERO-PRICE ROWS (potential package follow-ups) ===\n');
  for (const row of zeroPriceRows) {
    const p = row.payload || {};
    const isGhost = !p.formInfo && !p.bookingSource && !p.startDate;
    const paymentState = p.paymentDetails?.state || p.paymentState || '—';
    const catalogPrice = p.paymentDetails?.balance?.finalPrice?.amount || p.price?.amount || '—';
    const promoCode = p.paymentDetails?.couponDetails?.couponCode || p.paymentDetails?.discountDescription || '—';
    const pricingPlan = p.pricingPlanInfo ? JSON.stringify(p.pricingPlanInfo) : 'none';

    console.log(`  ${row.client_full_name || '(no name)'}`.padEnd(30) +
      ` | Therapist: ${(row.therapist_name || '—').padEnd(20)}` +
      ` | Date: ${(row.start_time || '—').slice(0, 10)}` +
      ` | Status: ${(row.status || '—').padEnd(12)}` +
      ` | contact_id: ${(row.contact_id || 'NULL').slice(0, 12)}` +
      ` | schedule_id: ${(row.schedule_id || 'NULL').slice(0, 12)}`
    );
    console.log(`    Title: ${row.title || '—'}`);
    console.log(`    PaymentState: ${paymentState} | CatalogPrice: ${catalogPrice} | PromoCode: ${promoCode} | PricingPlan: ${pricingPlan}`);
    console.log(`    Ghost: ${isGhost} | session_type: ${row.session_type || '—'} | session_count: ${row.session_count || '—'}`);
    console.log('');
  }

  // 4. Group by contact_id + schedule_id to find related sessions
  console.log('\n=== POTENTIAL PACKAGE GROUPS (contact_id + schedule_id) ===\n');
  const groups = {};
  for (const row of all) {
    if (!row.contact_id || !row.schedule_id) continue;
    const key = `${row.contact_id}___${row.schedule_id}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }

  // Only show groups that have BOTH paid and zero-price sessions
  let packageGroupCount = 0;
  for (const [key, rows] of Object.entries(groups)) {
    const hasPaid = rows.some(r => r.price && parseFloat(r.price) > 0);
    const hasZero = rows.some(r => !r.price || parseFloat(r.price) === 0);
    if (hasPaid && hasZero) {
      packageGroupCount++;
      const [contactId, scheduleId] = key.split('___');
      console.log(`  GROUP ${packageGroupCount}: contact=${contactId.slice(0, 12)}... schedule=${scheduleId.slice(0, 12)}...`);
      console.log(`  Client: ${rows[0].client_full_name} | Therapist: ${rows[0].therapist_name}`);
      for (const r of rows) {
        const price = r.price ? `₹${r.price}` : '₹0';
        console.log(`    ${(r.start_time || '—').slice(0, 10)} | ${price.padEnd(8)} | ${(r.status || '—').padEnd(12)} | ${r.title || '—'}`);
      }
      console.log('');
    }
  }
  console.log(`Total potential package groups: ${packageGroupCount}`);

  // 5. Also check: group by client_email + therapist_name (broader matching)
  console.log('\n=== BROADER GROUPS (client_email + therapist_name) ===\n');
  const broadGroups = {};
  for (const row of all) {
    if (!row.client_email) continue;
    const key = `${row.client_email.toLowerCase()}___${(row.therapist_name || 'unknown').toLowerCase()}`;
    if (!broadGroups[key]) broadGroups[key] = [];
    broadGroups[key].push(row);
  }

  let broadGroupCount = 0;
  for (const [key, rows] of Object.entries(broadGroups)) {
    const hasPaid = rows.some(r => r.price && parseFloat(r.price) > 0);
    const hasZero = rows.some(r => !r.price || parseFloat(r.price) === 0);
    if (hasPaid && hasZero) {
      broadGroupCount++;
      const [email, therapist] = key.split('___');
      console.log(`  GROUP ${broadGroupCount}: ${email} → ${therapist}`);
      for (const r of rows) {
        const price = r.price ? `₹${r.price}` : '₹0';
        console.log(`    ${(r.start_time || '—').slice(0, 16)} | ${price.padEnd(8)} | ${(r.status || '—').padEnd(12)} | ${(r.session_type || '—').padEnd(12)} | ${r.title || '—'}`);
      }
      console.log('');
    }
  }
  console.log(`Total broader package groups: ${broadGroupCount}`);

  // 6. Check session titles for package clues
  console.log('\n=== TITLE PATTERNS (all rows) ===\n');
  const titleCounts = {};
  for (const row of all) {
    const t = row.title || '(empty)';
    titleCounts[t] = (titleCounts[t] || 0) + 1;
  }
  for (const [title, count] of Object.entries(titleCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}x  ${title}`);
  }
}

main().catch(console.error);
