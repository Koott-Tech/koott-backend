const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const meetLinkService = require('./utils/meetLinkService');

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fix() {
  const sessionId = 'b569ee7f-e892-4a63-b12b-865e8480c9a0';
  const { data: session } = await supabaseAdmin.from('sessions')
    .select('*, client:client_id(first_name, last_name, email), psych:psychologist_id(first_name, last_name, email, google_calendar_credentials)')
    .eq('id', sessionId)
    .single();

  if (!session) return console.log("Session not found");

  const clientName = `${session.client.first_name} ${session.client.last_name}`;
  const psychName = `${session.psych.first_name} ${session.psych.last_name}`;

  const meetSessionData = {
    summary: `Koott Session — ${clientName} & ${psychName}`,
    description: `Therapy session\nClient: ${clientName}\nTherapist: ${psychName}`,
    startDate: session.scheduled_date,
    startTime: session.scheduled_time.slice(0, 5),
    endTime: '16:50', // 50 mins after 16:00
    clientEmail: session.client.email,
    psychologistEmail: session.psych.email,
  };

  const creds = session.psych.google_calendar_credentials;
  const userAuth = creds?.access_token ? { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date } : null;

  console.log("Creating new event...");
  const created = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
  
  if (created?.eventId) {
    const link = created.meetLink && !created.meetLink.includes('meet.google.com/new') ? created.meetLink : null;
    console.log("Created successfully. Event ID:", created.eventId, "Meet:", link);
    
    await supabaseAdmin.from('sessions').update({
      google_calendar_event_id: created.eventId,
      meet_link: link
    }).eq('id', sessionId);
    console.log("DB updated!");
  } else {
    console.log("Failed:", created);
  }
}
fix();
