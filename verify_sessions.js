const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  const today = new Date().toISOString().split('T')[0];
  
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select(`
      id, 
      scheduled_date, 
      scheduled_time,
      status, 
      google_calendar_event_id, 
      google_calendar_id,
      google_meet_link,
      psych:psychologist_id(first_name, last_name)
    `)
    .gte('scheduled_date', today)
    .in('status', ['booked', 'scheduled', 'rescheduled', 'confirmed']);
    
  if (error) {
    console.error("Error fetching sessions:", error);
    return;
  }
  
  let validCount = 0;
  const missingData = [];
  
  for (const s of sessions) {
    const psychName = `${s.psych?.first_name || ''} ${s.psych?.last_name || ''}`.trim().toLowerCase();
    
    if (psychName.includes('athullya') || psychName.includes('athulya') || psychName.includes('gayathri')) {
      continue; // skip as requested
    }
    
    // Check if missing ANY of the three required fields
    if (!s.google_calendar_event_id || !s.google_calendar_id || !s.google_meet_link) {
      missingData.push({
        id: s.id,
        psych: psychName,
        date: s.scheduled_date,
        missing_event_id: !s.google_calendar_event_id,
        missing_calendar_id: !s.google_calendar_id,
        missing_meet_link: !s.google_meet_link
      });
    } else {
      validCount++;
    }
  }
  
  console.log(`\nVerified ${validCount} upcoming sessions perfectly intact (have meet link, event ID, and calendar ID).`);
  
  if (missingData.length > 0) {
    console.log(`\n⚠️ Found ${missingData.length} sessions (excluding Athullya/Gayathri) missing some calendar data:`);
    console.table(missingData);
  } else {
    console.log(`\n✅ 100% of all other upcoming sessions have their Google Meet Link, Calendar Event ID, and Calendar ID properly saved!`);
  }
}

run();
