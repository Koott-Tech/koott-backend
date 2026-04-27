const { createClient } = require('@supabase/supabase-js');
const { sessionTypeFromBooking, sessionCountFromBooking, discoverRowToDb } = require('../utils/wixBookingMapper');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function updateExistingBookings() {
  try {
    console.log('🔄 Fetching all Wix bookings for re-processing...');
    const { data: bookings, error } = await supabase
      .from('wix_bookings')
      .select('id, wix_booking_id, payload');

    if (error) throw error;

    console.log(`📊 Found ${bookings.length} bookings to update.`);

    let updatedCount = 0;
    for (const row of bookings) {
      const payload = row.payload;
      
      // Use the full mapper to get all corrected fields including price
      const mapped = discoverRowToDb(payload);
      
      if (!mapped) continue;

      const { error: updateError } = await supabase
        .from('wix_bookings')
        .update({
          session_type: mapped.session_type,
          session_count: mapped.session_count,
          price: mapped.price,
          updated_at: new Date().toISOString()
        })
        .eq('id', row.id);

      if (updateError) {
        console.error(`❌ Failed to update ${row.wix_booking_id}:`, updateError.message);
      } else {
        updatedCount++;
      }
    }

    console.log(`✅ Successfully updated ${updatedCount} bookings with full new logic (Types + Prices).`);

  } catch (error) {
    console.error('Update failed:', error.message);
  }
}

updateExistingBookings();
