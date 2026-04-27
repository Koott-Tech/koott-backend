/**
 * Backfill: call Wix eCommerce API for ALL existing wix_bookings to get
 * the exact session type and count from order description lines.
 * 
 * This is a one-time script. After running, all bookings will have accurate
 * session_type and session_count values.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const { fetchSessionInfoFromOrder, parseSessionDescription } = require('../services/wixOrderEnrichmentService');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  // Get all bookings with client data (skip ghost rows)
  const { data: bookings, error } = await supabase
    .from('wix_bookings')
    .select('id, wix_booking_id, client_full_name, therapist_name, price, session_type, session_count')
    .not('client_full_name', 'is', null)
    .order('price', { ascending: false });

  if (error) { console.error(error.message); return; }
  console.log(`Found ${bookings.length} bookings to enrich\n`);

  let enriched = 0;
  let changed = 0;
  let errors = 0;

  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];
    process.stdout.write(`[${i + 1}/${bookings.length}] ${b.client_full_name?.padEnd(22)} ₹${(b.price || '0').toString().padEnd(9)} `);

    try {
      const info = await fetchSessionInfoFromOrder(b.wix_booking_id);
      if (!info) {
        console.log('→ no order found');
        continue;
      }

      enriched++;
      const typeChanged = info.sessionType !== b.session_type;
      const countChanged = info.sessionCount !== b.session_count;

      if (typeChanged || countChanged) {
        changed++;
        console.log(`→ "${info.descriptionLine}" → ${info.sessionType}/${info.sessionCount} (was: ${b.session_type}/${b.session_count}) ⚡`);

        // Update wix_bookings
        await supabase
          .from('wix_bookings')
          .update({ session_type: info.sessionType, session_count: info.sessionCount })
          .eq('wix_booking_id', b.wix_booking_id);

        // Update sessions
        await supabase
          .from('sessions')
          .update({ session_type: info.sessionType, session_count: info.sessionCount })
          .eq('wix_booking_id', b.wix_booking_id);
      } else {
        console.log(`→ "${info.descriptionLine}" → ${info.sessionType}/${info.sessionCount} (unchanged)`);
      }
    } catch (err) {
      errors++;
      console.log(`→ ERROR: ${err.message}`);
    }

    // Small delay to avoid rate limiting
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== BACKFILL COMPLETE ===`);
  console.log(`Total: ${bookings.length} | Enriched: ${enriched} | Changed: ${changed} | Errors: ${errors}`);
}

main().catch(console.error);
