const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

const wixId = process.argv[2];

async function deepInspect() {
  if (!wixId) {
    console.error('Please provide a Wix Booking ID');
    return;
  }
  try {
    const { data, error } = await supabase
      .from('wix_bookings')
      .select('payload')
      .eq('wix_booking_id', wixId)
      .single();

    if (error) throw error;

    console.log(`\n--- Deep Inspection of Booking ${wixId} ---`);
    console.log(JSON.stringify(data.payload, null, 2));
    console.log('-------------------------------------------\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

deepInspect();
