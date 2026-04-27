const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectAyanaZero() {
  try {
    const { data, error } = await supabase
      .from('wix_bookings')
      .select('wix_booking_id, payload')
      .eq('wix_booking_id', 'd7f6bf95-17c0-4f0c-94d3-1b5219151b2b')
      .single();

    if (error) throw error;

    console.log('\n--- PAYLOAD INSPECTION FOR 0-RS BOOKING ---');
    const b = data.payload;
    console.log(`Final Price Amount: ${b.paymentDetails?.balance?.finalPrice?.amount}`);
    console.log(`Catalog Rate:       ${b.rawBookedEntity?.rate?.defaultVariedPrice?.amount}`);
    console.log(`Price Field:        ${b.price}`);
    console.log('---');
    console.log(JSON.stringify(b.paymentDetails, null, 2));
    console.log('-------------------------------------------\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

inspectAyanaZero();
