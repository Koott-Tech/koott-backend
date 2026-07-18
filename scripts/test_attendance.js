require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function test() {
  console.log("Creating dummy registration...");
  const payload = {
    event_slug: "test-event",
    event_title: "Test Event",
    full_name: "Test Therapist",
    email: "therapist@koott.com",
    country_code: "+91",
    phone: "9999999999",
    attendance_status: "pending"
  };
  
  const { data: insertData, error: insertErr } = await supabaseAdmin
    .from('event_registrations')
    .insert([payload])
    .select('*')
    .single();
    
  if (insertErr) {
    console.error("Insert failed:", insertErr);
    return;
  }
  
  console.log("Registration inserted successfully with ID:", insertData.id);
  console.log("Current attendance:", insertData.attendance_status);
  
  console.log("Updating attendance to 'present'...");
  const { data: updateData, error: updateErr } = await supabaseAdmin
    .from('event_registrations')
    .update({ attendance_status: 'present' })
    .eq('id', insertData.id)
    .select('*')
    .single();
    
  if (updateErr) {
    console.error("Update failed:", updateErr);
    return;
  }
  
  console.log("Update successful! Current attendance:", updateData.attendance_status);
  
  console.log("Cleaning up dummy data...");
  await supabaseAdmin.from('event_registrations').delete().eq('id', insertData.id);
  console.log("Test completely successful!");
}

test().then(() => process.exit(0));
