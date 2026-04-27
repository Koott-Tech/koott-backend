const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkAyanaDetails() {
  try {
    const { data, error } = await supabase
      .from('wix_bookings')
      .select('wix_booking_id, title, status, start_time, price, payload')
      .eq('client_email', 'ayanawilson9072@gmail.com');

    if (error) throw error;

    console.log('\n--- AYANA WILSON DETAILED CHECK ---');
    data.forEach(row => {
      console.log(`WixID: ${row.wix_booking_id}`);
      console.log(`Title: ${row.title} | Status: ${row.status}`);
      console.log(`Time:  ${row.start_time} | Price: ${row.price}`);
      console.log(`Order ID: ${row.payload?.paymentDetails?.wixPayMultipleDetails?.[0]?.orderId || 'N/A'}`);
      console.log('---');
    });
    console.log('-----------------------------------\n');

  } catch (error) {
    console.error('Check failed:', error.message);
  }
}

checkAyanaDetails();
