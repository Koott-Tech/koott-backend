const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data: psych } = await supabaseAdmin.from('psychologists').select('google_calendar_credentials').ilike('first_name', '%Shuhaima%').maybeSingle();
  if (!psych || !psych.google_calendar_credentials) {
    console.log("No credentials for Shuhaima");
    return;
  }
  
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials(psych.google_calendar_credentials);
  
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
  try {
    const res = await calendar.events.get({
      calendarId: 'primary',
      eventId: 'igtm81mhr4gtafu07fgif1a73k',
    });
    console.log("Event details from Google Calendar:", JSON.stringify({
      id: res.data.id,
      status: res.data.status,
      summary: res.data.summary,
      start: res.data.start,
      end: res.data.end
    }, null, 2));
  } catch(e) {
    console.log("Error fetching event:", e.message);
  }
}
check();
