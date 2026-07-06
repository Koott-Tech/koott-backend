const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data, error } = await supabaseAdmin
    .from('wix_bookings')
    .select('id, client_full_name, start_time, end_time, status')
    .ilike('client_full_name', '%Priyanka Mathew%');
    
  console.log("Wix Bookings:", JSON.stringify(data, null, 2));

  const { data: sData, error: sErr } = await supabaseAdmin
    .from('sessions')
    .select('id, wix_booking_id, scheduled_date, scheduled_time, status, google_calendar_event_id, meet_link')
    .eq('client_id', (await supabaseAdmin.from('users').select('id').ilike('first_name', 'Priyanka').maybeSingle()).data?.id || 'none')
    
  // just search by wix booking ids if found
  if (data && data.length > 0) {
    const { data: s2 } = await supabaseAdmin.from('sessions').select('*').in('wix_booking_id', data.map(d => d.id));
    console.log("Sessions by Wix IDs:", JSON.stringify(s2, null, 2));
  }
}
check();
