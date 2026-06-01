const { supabaseAdmin } = require('../config/supabase');
const meetLinkService = require('../utils/meetLinkService');
const emailService = require('../utils/emailService');
const interaktService = require('../utils/interaktService');
const { getClientDisplayName } = require('../utils/sessionTitleFormatter');
const {
  formatDate,
  formatTime,
  addMinutesToTime
} = require('../utils/helpers');

/**
 * Fetch assessment session with related entities.
 * @param {string|number} sessionId
 * @returns {Promise<{ session: Object|null, error?: any }>}
 */
async function fetchAssessmentSession(sessionId) {
  const { data, error } = await supabaseAdmin
    .from('assessment_sessions')
    .select(`
      *,
      assessment:assessments(hero_title, seo_title),
      client:clients(
        id,
        first_name,
        last_name,
        child_name,
        phone_number,
        user:users(email)
      ),
      psychologist:psychologists(
        id,
        first_name,
        last_name,
        email,
        phone
      )
    `)
    .eq('id', sessionId)
    .single();

  return { session: data, error };
}

function buildDisplayName(firstName, lastName) {
  return `${firstName || ''} ${lastName || ''}`.trim();
}

/**
 * Ensure Meet link is stored on the assessment session row.
 * @param {number|string} sessionId
 * @param {Object} meetData
 */
async function persistMeetDetails(sessionId, meetData) {
  if (!meetData) return;

  const payload = {
    google_meet_link: meetData.meetLink || null,
    google_calendar_event_id: meetData.eventId || null,
    google_calendar_link: meetData.calendarLink || null,
    google_meet_method: meetData.method || null,
    updated_at: new Date().toISOString()
  };

  try {
    await supabaseAdmin
      .from('assessment_sessions')
      .update(payload)
      .eq('id', sessionId);
  } catch (error) {
    console.warn('⚠️ Failed to persist assessment session Meet details:', error?.message || error);
  }
}

/**
 * Send email notifications for assessment session booking.
 */
async function sendAssessmentEmails({ session, clientName, psychologistName, meetLink }) {
  const clientEmail = session.client?.user?.email || null;
  const psychologistEmail = session.psychologist?.email || null;

  if (!clientEmail && !psychologistEmail) {
    console.log('ℹ️ Skipping assessment emails - no recipient emails found');
    return;
  }

  try {
    await emailService.sendSessionConfirmation({
      clientEmail: clientEmail || 'client@placeholder.com',
      psychologistEmail: psychologistEmail || 'psychologist@placeholder.com',
      clientName,
      psychologistName,
      sessionId: session.id,
      scheduledDate: session.scheduled_date,
      scheduledTime: session.scheduled_time,
      meetLink,
      googleCalendarEventId: session.google_calendar_event_id,
      price: session.amount || 0
    });
    console.log('✅ Assessment session emails dispatched');
  } catch (error) {
    console.error('❌ Failed to send assessment session emails:', error?.message || error);
  }
}

/**
 * Send WhatsApp notifications for assessment session booking.
 */
async function sendAssessmentWhatsapps({ session, clientName, meetLink }) {
  if (!meetLink) {
    console.log('ℹ️ Skipping WhatsApp notifications - missing Meet link');
    return;
  }

  const clientPhone = session.client?.phone_number || null;
  const psychologistPhone = session.psychologist?.phone || null;
  const scheduledDate = session.scheduled_date;
  const scheduledTime = session.scheduled_time;

  const psychologistName = session.psychologist?.first_name && session.psychologist?.last_name
    ? `${session.psychologist.first_name} ${session.psychologist.last_name}`.trim()
    : 'our specialist';

  // Client → booking_confirmation_v1
  if (clientPhone) {
    try {
      const r = await interaktService.sendBookingConfirmation(clientPhone, {
        clientName: getClientDisplayName(session.client, clientName || 'Client'),
        psychologistName,
        date: scheduledDate, time: scheduledTime, meetLink,
      });
      if (r?.success) console.log('✅ booking_confirmation_v1 sent to client (assessment)');
      else console.warn('⚠️ booking_confirmation_v1 (assessment) failed:', r?.error || r?.reason);
    } catch (error) {
      console.error('❌ Failed to send client WhatsApp for assessment session:', error?.message || error);
    }
  } else {
    console.log('ℹ️ No client phone found; skipping client WhatsApp');
  }

  // Therapist → therapistconfirmation
  if (psychologistPhone) {
    try {
      const r = await interaktService.sendSessionNotificationPsychologist(psychologistPhone, {
        therapistName: psychologistName,
        clientName, date: scheduledDate, time: scheduledTime,
        meetLink,
      });
      if (r?.success) console.log('✅ therapistconfirmation sent to therapist (assessment)');
      else console.warn('⚠️ therapistconfirmation (assessment) failed:', r?.error || r?.reason);
    } catch (error) {
      console.error('❌ Failed to send psychologist WhatsApp for assessment session:', error?.message || error);
    }
  } else {
    console.log('ℹ️ No psychologist phone found; skipping psychologist WhatsApp');
  }
}

/**
 * Finalize assessment session booking by creating a Meet link and sending notifications.
 * Safe to call multiple times; Meet creation and notifications are best-effort.
 * @param {number|string} sessionId
 * @param {Object} options
 * @returns {Promise<{ session: Object|null, meetData: Object|null }>}
 */
async function finalizeAssessmentSessionBooking(sessionId, options = {}) {
  const result = { session: null, meetData: null };

  const { session, error } = await fetchAssessmentSession(sessionId);
  if (error || !session) {
    console.error('❌ Assessment session fetch failed:', error?.message || error);
    return result;
  }

  // Ensure session has schedule info
  if (!session.scheduled_date || !session.scheduled_time) {
    console.warn('⚠️ Assessment session missing schedule details; skipping Meet creation.');
    result.session = session;
    return result;
  }

  const scheduledDate = formatDate(session.scheduled_date);
  const scheduledTime = formatTime(session.scheduled_time);
  const endTime = addMinutesToTime(
    scheduledTime,
    typeof options.durationMinutes === 'number' ? options.durationMinutes : 50
  );

  const clientName = getClientDisplayName(session.client, 'Client');
  const psychologistName = buildDisplayName(
    session.psychologist?.first_name,
    session.psychologist?.last_name
  ) || 'Psychologist';
  const assessmentName = session.assessment?.hero_title ||
    session.assessment?.seo_title ||
    'Assessment Session';

  let meetData = null;
  try {
    meetData = await meetLinkService.generateSessionMeetLink({
      id: session.id,
      summary: options.summary || `${assessmentName} - ${clientName}`,
      description: options.description || `Assessment session for ${clientName} with ${psychologistName}.`,
      startDate: scheduledDate,
      startTime: scheduledTime,
      endTime
    }, options.userAuth || null);
  } catch (error) {
    console.error('❌ Failed to generate assessment Google Meet link:', error?.message || error);
  }

  const meetLink = meetData?.meetLink || 'https://meet.google.com/new?hs=122&authuser=0';

  await persistMeetDetails(session.id, meetData || { meetLink });

  // Email + WhatsApp (best effort)
  await sendAssessmentEmails({ session, clientName, psychologistName, meetLink });
  await sendAssessmentWhatsapps({ session, clientName, meetLink });

  result.session = {
    ...session,
    google_meet_link: meetLink,
    google_calendar_event_id: meetData?.eventId || null,
    google_calendar_link: meetData?.calendarLink || null,
    google_meet_method: meetData?.method || null
  };
  result.meetData = meetData;
  return result;
}

module.exports = {
  finalizeAssessmentSessionBooking
};

