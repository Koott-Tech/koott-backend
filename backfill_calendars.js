const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  const today = new Date().toISOString().split('T')[0];
  
  // Fetch upcoming sessions
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select(`
      id, 
      scheduled_date, 
      scheduled_time,
      status, 
      google_calendar_event_id, 
      google_calendar_id,
      client:client_id(first_name, last_name),
      psych:psychologist_id(id, first_name, last_name, email, google_calendar_credentials)
    `)
    .gte('scheduled_date', today)
    .in('status', ['booked', 'scheduled', 'rescheduled', 'confirmed']);
    
  if (error) {
    console.error("Error fetching sessions:", error);
    return;
  }
  
  console.log(`Found ${sessions.length} upcoming sessions.`);
  
  let backfilled = 0;
  const missingEvents = [];
  
  for (const s of sessions) {
    const psychName = `${s.psych?.first_name || ''} ${s.psych?.last_name || ''}`.trim().toLowerCase();
    const isExcluded = psychName.includes('athulya') || psychName.includes('gayathri');
    
    // Check for missing calendar events
    if (!s.google_calendar_event_id && !isExcluded) {
      missingEvents.push({
        id: s.id,
        date: s.scheduled_date,
        time: s.scheduled_time,
        psych: psychName,
        client: `${s.client?.first_name || ''} ${s.client?.last_name || ''}`.trim()
      });
    }
    
    // Backfill google_calendar_id if we have credentials
    if (s.google_calendar_event_id && !s.google_calendar_id && s.psych?.email) {
      const creds = s.psych.google_calendar_credentials;
      const calendarId = creds?.oauth_email || s.psych.email;
      
      await supabaseAdmin
        .from('sessions')
        .update({ google_calendar_id: calendarId })
        .eq('id', s.id);
        
      backfilled++;
    }
  }
  
  console.log(`Backfilled google_calendar_id for ${backfilled} sessions.`);
  
  if (missingEvents.length > 0) {
    console.log(`\n⚠️ Found ${missingEvents.length} upcoming sessions MISSING a calendar event:`);
    console.table(missingEvents);
  } else {
    console.log('\n✅ All other upcoming sessions have a Google Calendar event saved!');
  }
}

run();
