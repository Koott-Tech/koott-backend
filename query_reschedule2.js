const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data: sByDate, error } = await supabaseAdmin.from('sessions')
    .select('id, scheduled_date, scheduled_time, status, google_calendar_event_id, client:client_id(first_name, last_name, email)')
    .eq('scheduled_date', '2026-07-09');
  
  console.log("Sessions on Jul 9:", JSON.stringify(sByDate, null, 2));
  
  const { data: c } = await supabaseAdmin.from('clients').select('id, first_name, last_name, email').ilike('email', '%priya16m%');
  console.log("Clients:", c);
  
  if (c && c.length) {
    const { data: s } = await supabaseAdmin.from('sessions').select('*').in('client_id', c.map(x => x.id));
    console.log("Sessions for this client:", s.map(x => ({id: x.id, date: x.scheduled_date, time: x.scheduled_time, wix: x.wix_booking_id, status: x.status, calendar_id: x.google_calendar_event_id})));
  }
}
check();
