const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SESSION1_ID = 'ad5db6ee-b7a1-496a-9268-26c82e57f95c'; // package session 1/3, completed
const WIX1_BOOKING_ID = '595b3177-ac94-4b89-9765-b3e1075785be';

const SESSION2_ID = '195d6c40-d1df-446b-be6a-f3263f4e1ae8'; // mistaken individual, becomes session 2/3
const WIX2_BOOKING_ID = '8469f73e-48c9-4cab-a970-785f9f6cc465';

const PACKAGE_GROUP_ID = 'd9dd3192-1426-4933-89da-d7980f4634d8';

(async () => {
  // 1. Link session 1 (already completed) into the package group as #1
  const { error: s1Err } = await supabase
    .from('sessions')
    .update({ package_group_id: PACKAGE_GROUP_ID, package_session_number: 1 })
    .eq('id', SESSION1_ID);
  console.log('session 1 update:', s1Err ? 'FAILED: ' + s1Err.message : 'OK');

  const { error: wb1Err } = await supabase
    .from('wix_bookings')
    .update({ package_group_id: PACKAGE_GROUP_ID, package_session_number: 1 })
    .eq('wix_booking_id', WIX1_BOOKING_ID);
  console.log('wix_bookings 1 update:', wb1Err ? 'FAILED: ' + wb1Err.message : 'OK');

  // 2. Reclassify the mistaken individual booking as package session 2/3.
  //    Same date/time, same google_meet_link/calendar_event_id — no new calendar event,
  //    no notifications. Price set to 0 (follow-up session, already paid for in session 1).
  const { error: s2Err } = await supabase
    .from('sessions')
    .update({
      session_type: 'package',
      session_count: 3,
      package_session_number: 2,
      package_group_id: PACKAGE_GROUP_ID,
      price: 0,
      amount: 0,
      locally_modified: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', SESSION2_ID);
  console.log('session 2 update:', s2Err ? 'FAILED: ' + s2Err.message : 'OK');

  const { error: wb2Err } = await supabase
    .from('wix_bookings')
    .update({
      session_type: 'package',
      session_count: 3,
      package_session_number: 2,
      package_group_id: PACKAGE_GROUP_ID,
      price: '0',
      locally_modified: true,
      synced_at: new Date().toISOString(),
    })
    .eq('wix_booking_id', WIX2_BOOKING_ID);
  console.log('wix_bookings 2 update:', wb2Err ? 'FAILED: ' + wb2Err.message : 'OK');

  // 3. Verify final state
  const { data: final1 } = await supabase.from('sessions').select('id, session_type, package_group_id, package_session_number, session_count, price, scheduled_date, scheduled_time, google_meet_link').eq('id', SESSION1_ID).single();
  const { data: final2 } = await supabase.from('sessions').select('id, session_type, package_group_id, package_session_number, session_count, price, scheduled_date, scheduled_time, google_meet_link').eq('id', SESSION2_ID).single();
  console.log('\nFinal session 1 (1/3):', JSON.stringify(final1, null, 2));
  console.log('\nFinal session 2 (2/3):', JSON.stringify(final2, null, 2));
})();
