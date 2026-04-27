const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkAyanaDuplicates() {
  try {
    console.log('🔍 Checking records for Ayana Wilson...');
    const { data, error } = await supabase
      .from('wix_bookings')
      .select('*')
      .eq('client_email', 'ayanawilson9072@gmail.com');

    if (error) throw error;

    console.log(`\n--- AYANA WILSON RECORDS (${data.length} found) ---`);
    data.forEach(row => {
      console.log(`ID: ${row.id} | WixID: ${row.wix_booking_id} | Title: ${row.title} | Time: ${row.start_time} | Price: ${row.price}`);
    });
    console.log('--------------------------------------------------\n');

  } catch (error) {
    console.error('Check failed:', error.message);
  }
}

checkAyanaDuplicates();
