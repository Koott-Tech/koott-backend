/**
 * Verify the updated discoverRowToDb with _resolvedPrice augmentation.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const { discoverRowToDb } = require('../utils/wixBookingMapper');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const { data, error } = await supabase
    .from('wix_bookings')
    .select('title, client_full_name, therapist_name, price, session_type, session_count, payload')
    .not('client_full_name', 'is', null)
    .order('price', { ascending: false });

  if (error) { console.error(error.message); return; }

  console.log('=== PACKAGE DETECTION via discoverRowToDb (with _resolvedPrice) ===\n');
  console.log('Price'.padEnd(10) + 'OldType'.padEnd(14) + 'NewType'.padEnd(14) + 'OldCount'.padEnd(10) + 'NewCount'.padEnd(10) + 'Client'.padEnd(22) + 'Therapist');
  console.log('-'.repeat(105));

  for (const row of data) {
    const mapped = discoverRowToDb(row.payload);
    if (!mapped) continue;
    const changed = mapped.session_type !== row.session_type || mapped.session_count !== row.session_count;
    if (mapped.session_type !== 'individual' || changed) {
      const marker = changed ? ' ⚡ CHANGED' : '';
      console.log(
        `₹${(row.price || '0').toString().padEnd(9)}` +
        `${(row.session_type || '—').padEnd(14)}` +
        `${mapped.session_type.padEnd(14)}` +
        `${String(row.session_count || 1).padEnd(10)}` +
        `${String(mapped.session_count).padEnd(10)}` +
        `${(row.client_full_name || '—').padEnd(22)}` +
        `${row.therapist_name || '—'}` +
        marker
      );
    }
  }
}

main().catch(console.error);
