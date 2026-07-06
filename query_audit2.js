const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function check() {
  const { data: s } = await supabaseAdmin.from('sessions').select('id, updated_at, wix_booking_id').eq('id', 'b569ee7f-e892-4a63-b12b-865e8480c9a0');
  console.log("Session:", s);
  
  const { data: b } = await supabaseAdmin.from('wix_bookings').select('id, synced_at').eq('id', 'b6aa6447-ccf3-4822-925a-41c8247ed34c');
  console.log("Wix booking:", b);
}
check();
