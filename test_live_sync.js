const { createClient } = require('@supabase/supabase-js');
const { sessionTypeFromBooking, sessionCountFromBooking } = require('./utils/wixBookingMapper');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function testAgainstLiveSync() {
  try {
    console.log('🔍 Fetching latest synced Wix bookings...');
    const { data, error } = await supabase
      .from('wix_bookings')
      .select('wix_booking_id, title, payload')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    console.log('\n--- LIVE SYNC DETECTION TEST (New Logic) ---');
    console.log(`${'Client/Title'.padEnd(30)} | ${'Detected Type'.padEnd(15)} | ${'Count'}`);
    console.log('-'.repeat(60));

    data.forEach(row => {
      const type = sessionTypeFromBooking(row.payload);
      const count = sessionCountFromBooking(row.payload);
      
      // Print results
      console.log(`${row.title.substring(0, 30).padEnd(30)} | ${type.padEnd(15)} | ${count}`);
    });

    console.log('--------------------------------------------\n');

  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

testAgainstLiveSync();
