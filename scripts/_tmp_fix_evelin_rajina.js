const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const meetLinkService = require('../utils/meetLinkService');
const emailService = require('../utils/emailService');
const interaktService = require('../utils/interaktService');
const { addMinutesToTime } = require('../utils/helpers');
const {
  buildKoottSessionTitle, buildKoottSessionDescription, getClientDisplayName, getPsychologistDisplayName,
} = require('../utils/sessionTitleFormatter');

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SESSION_ID = '8af86588-cf30-4ed2-ac0e-536e6aa8920f';
const GOOD_PSYCH = 'e4597bc1-d03d-417c-94bf-4561ba15bcba'; // Rajina R S — has email + calendar
const DATE = '2026-07-03';
const TIME = '17:00';
const DURATION = 50;

(async () => {
  const { error: reErr } = await supabase.from('sessions')
    .update({ psychologist_id: GOOD_PSYCH, locally_modified: true, updated_at: new Date().toISOString() })
    .eq('id', SESSION_ID);
  console.log('Reassign psychologist:', reErr ? 'FAILED: '+reErr.message : 'OK → Rajina R S');

  const { data: session } = await supabase.from('sessions').select('client_id').eq('id', SESSION_ID).single();
  const { data: client } = await supabase.from('clients').select('first_name,last_name,child_name,phone_number,user:users(email)').eq('id', session.client_id).single();
  const { data: psych } = await supabase.from('psychologists').select('first_name,last_name,email,phone,google_calendar_credentials').eq('id', GOOD_PSYCH).single();

  const clientEmail = Array.isArray(client.user) ? client.user[0]?.email : client.user?.email;
  const clientName = getClientDisplayName(client, 'Client');
  const psychologistName = getPsychologistDisplayName(psych);
  const creds = psych.google_calendar_credentials;
  const userAuth = creds?.access_token ? { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date } : null;

  let meetLink = null, eventId = null, calendarLink = null;
  try {
    const meetResult = await meetLinkService.generateSessionMeetLink({
      summary: buildKoottSessionTitle({ clientName, psychologistName }),
      description: buildKoottSessionDescription({ clientName, psychologistName, clientPhone: client.phone_number }),
      startDate: DATE, startTime: TIME, endTime: addMinutesToTime(TIME, DURATION),
      clientEmail: clientEmail || undefined, psychologistEmail: psych.email || undefined,
    }, userAuth);
    if (meetResult?.eventId) eventId = meetResult.eventId;
    calendarLink = meetResult?.eventLink || meetResult?.calendarLink || null;
    if (meetResult?.meetLink && !meetResult.meetLink.includes('meet.google.com/new')) meetLink = meetResult.meetLink;
    console.log('Calendar event:', eventId ? 'created ('+eventId+')' : 'NO event', '| meet:', meetLink || '(none)');
  } catch (e) { console.error('Meet creation failed:', e.message); }

  if (eventId || meetLink) {
    await supabase.from('sessions').update({
      google_calendar_event_id: eventId, google_meet_link: meetLink, google_meet_join_url: meetLink,
      google_meet_start_url: meetLink, google_calendar_link: calendarLink, updated_at: new Date().toISOString(),
    }).eq('id', SESSION_ID);
  }

  try {
    await emailService.sendSessionConfirmation({
      clientName, psychologistName, sessionDate: DATE, sessionTime: `${TIME}:00`,
      sessionDuration: `${DURATION} minutes`, clientEmail: clientEmail || undefined,
      psychologistEmail: psych.email || undefined, googleMeetLink: meetLink, meetLink,
      googleCalendarEventId: eventId, sessionId: SESSION_ID, amount: 999, price: 999,
      status: 'booked', psychologistId: GOOD_PSYCH, clientId: session.client_id,
    });
    console.log('Email (client + therapist): sent');
  } catch (e) { console.error('Email failed:', e.message); }

  try {
    if (client.phone_number) {
      const r = await interaktService.sendBookingConfirmation(client.phone_number, { clientName, psychologistName, date: DATE, time: `${TIME}:00`, meetLink });
      console.log('WhatsApp client:', r?.success ? 'sent' : (r?.error||r?.reason));
    }
    if (psych.phone) {
      const r = await interaktService.sendSessionNotificationPsychologist(psych.phone, { therapistName: psychologistName, clientName, date: DATE, time: `${TIME}:00`, meetLink });
      console.log('WhatsApp therapist:', r?.success ? 'sent' : (r?.error||r?.reason));
    }
  } catch (e) { console.error('WhatsApp failed:', e.message); }

  const { data: final } = await supabase.from('sessions').select('psychologist_id, google_meet_link, google_calendar_event_id').eq('id', SESSION_ID).single();
  console.log('\nFinal:', JSON.stringify(final, null, 2));
})();
