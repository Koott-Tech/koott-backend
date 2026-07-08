require('dotenv').config();
const { supabaseAdmin } = require('./config/supabase');

async function test() {
  const { data: wixBooking } = await supabaseAdmin
    .from('wix_bookings')
    .select('*')
    .eq('wix_booking_id', '5750fb5a-4479-42f2-9564-620c21455216')
    .single();

  console.log('Wix Booking:', wixBooking);
}
test();
