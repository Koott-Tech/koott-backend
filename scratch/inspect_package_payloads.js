const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectPackagePayloads() {
  try {
    const { data: wixData, error } = await supabase
      .from('wix_bookings')
      .select('wix_booking_id, title, session_count, payload')
      .neq('session_count', 1)
      .not('session_count', 'is', null);
    
    if (error) throw error;

    console.log('\n--- Wix Package Payload Analysis ---');
    wixData.forEach(row => {
      const p = row.payload || {};
      const catalogRate = p.rawBookedEntity?.rate?.defaultVariedPrice?.amount;
      const actualPaid = p.paymentDetails?.balance?.finalPrice?.amount;
      
      console.log(`Booking ID: ${row.wix_booking_id}`);
      console.log(`Title:      ${row.title}`);
      console.log(`Sess Count: ${row.session_count}`);
      console.log(`Catalog Rt: ${catalogRate}`);
      console.log(`Actual Pd:  ${actualPaid}`);
      console.log('---');
    });
    console.log('-------------------------------------\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

inspectPackagePayloads();
