/**
 * Calendar Invite Generator
 * Generates .ics (iCalendar) files for session bookings
 */

const crypto = require('crypto');
const { buildKoottSessionTitle } = require('./sessionTitleFormatter');

/**
 * Generate a calendar invite (.ics) file content
 * @param {Object} sessionData - Session details
 * @returns {string} - iCalendar file content
 */
function generateCalendarInvite(sessionData) {
  const {
    sessionId,
    clientName,
    psychologistName,
    sessionDate,
    sessionTime,
    meetLink,
    clientEmail,
    psychologistEmail,
    price,
    duration = 50 // Paid session: 50 minutes
  } = sessionData;

  // Parse date and time in IST (UTC+5:30)
  const sessionDateTime = new Date(`${sessionDate}T${sessionTime}+05:30`);
  const endDateTime = new Date(sessionDateTime.getTime() + (duration * 60000));

  /**
   * iCalendar UTC form: YYYYMMDDTHHMMSSZ.
   *
   * sessionDateTime already holds the correct absolute instant (parsed from the IST wall
   * clock above), so emitting it in UTC lets every calendar app convert it to the VIEWER's
   * own timezone: 3:00 pm for a client in India, 1:30 pm in Dubai, 9:30 am in London. One
   * invite, correct everywhere — no per-client timezone handling needed on our side.
   *
   * The previous version built the string from date.getFullYear()/getHours(), which are
   * SERVER-local fields, and then tagged it `TZID=Asia/Kolkata`. On Render (UTC) that wrote
   * the UTC clock under an IST label, so every invite landed exactly 5h30m early.
   */
  const formatICalDateUTC = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const startDate = formatICalDateUTC(sessionDateTime);
  const endDate = formatICalDateUTC(endDateTime);
  const createdDate = formatICalDateUTC(new Date());

  // When no Meet link yet, avoid showing "undefined" — use a clear placeholder
  const meetText = meetLink && String(meetLink).trim() ? meetLink : 'Join link will be shared separately';
  const locationText = meetLink && String(meetLink).trim() ? meetLink : 'Online session - Koott';

  // Generate unique UID
  const uid = `session-${sessionId}-${crypto.randomUUID()}@koott.com`;

  // Calendar invite content with IST timezone
  const sessionTitle = buildKoottSessionTitle({ clientName, psychologistName });
  const icalContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Koott//Therapy Sessions//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${createdDate}`,
    `DTSTART:${startDate}`,
    `DTEND:${endDate}`,
    `SUMMARY:${sessionTitle}`,
    `DESCRIPTION:Online therapy session scheduled through Koott.\\n\\n` +
    `Client: ${clientName}\\n` +
    `Psychologist: ${psychologistName}\\n\\n` +
    `Join the session via Google Meet:\\n${meetText}\\n\\n` +
    `Please join the meeting 5 minutes before the scheduled time.`,
    `LOCATION:${locationText}`,
    `ORGANIZER;CN=${psychologistName}:mailto:${psychologistEmail}`,
    `ATTENDEE;CN=${clientName};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${clientEmail}`,
    `ATTENDEE;CN=${psychologistName};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${psychologistEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'DESCRIPTION:Therapy session reminder',
    'ACTION:DISPLAY',
    'END:VALARM',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'DESCRIPTION:Therapy session reminder - 1 hour',
    'ACTION:EMAIL',
    `ATTENDEE:mailto:${clientEmail}`,
    `ATTENDEE:mailto:${psychologistEmail}`,
    'SUMMARY:Therapy Session Reminder',
    'DESCRIPTION:Your therapy session starts in 1 hour.',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  return icalContent;
}

/**
 * Create calendar invite for multiple recipients
 * @param {Object} sessionData - Session details
 * @returns {Object} - Calendar invites for client and psychologist
 */
function createCalendarInvites(sessionData) {
  const baseInvite = generateCalendarInvite(sessionData);
  
  return {
    client: {
      filename: `therapy-session-${sessionData.sessionId}-client.ics`,
      content: baseInvite,
      contentType: 'text/calendar; charset=utf-8'
    },
    psychologist: {
      filename: `therapy-session-${sessionData.sessionId}-psychologist.ics`,
      content: baseInvite,
      contentType: 'text/calendar; charset=utf-8'
    },
    combined: {
      filename: `therapy-session-${sessionData.sessionId}.ics`,
      content: baseInvite,
      contentType: 'text/calendar; charset=utf-8'
    }
  };
}

/**
 * Generate Google Calendar add link
 * @param {Object} sessionData - Session details
 * @returns {string} - Google Calendar add URL
 */
function generateGoogleCalendarLink(sessionData) {
  const {
    clientName,
    psychologistName,
    sessionDate,
    sessionTime,
    meetLink,
    duration = 50
  } = sessionData;

  // Parse date and time in IST (UTC+5:30)
  const sessionDateTime = new Date(`${sessionDate}T${sessionTime}+05:30`);
  const endDateTime = new Date(sessionDateTime.getTime() + (duration * 60000));

  // Google reads a bare YYYYMMDDTHHMMSS as the VIEWER's local time, so stripping the "Z"
  // handed it the UTC clock to display as-is — 5h30m early for an Indian client. Keeping the
  // Z marks the value as UTC, and Google renders it in whatever timezone the viewer's
  // calendar is set to, which is what we want for overseas clients.
  const formatGoogleDateUTC = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const startDate = formatGoogleDateUTC(sessionDateTime);
  const endDate = formatGoogleDateUTC(endDateTime);

  const meetText = meetLink && String(meetLink).trim() ? meetLink : 'Join link will be shared separately';
  const title = encodeURIComponent(buildKoottSessionTitle({ clientName, psychologistName }));
  const details = encodeURIComponent(
    `Online therapy session\n\nJoin via Google Meet: ${meetText}\n\nPlease join 5 minutes early.`
  );
  const location = encodeURIComponent(meetLink && String(meetLink).trim() ? meetLink : 'Online session - Koott');

  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${startDate}/${endDate}&details=${details}&location=${location}`;
}

/**
 * Generate Outlook calendar add link
 * @param {Object} sessionData - Session details
 * @returns {string} - Outlook calendar add URL
 */
function generateOutlookCalendarLink(sessionData) {
  const {
    clientName,
    psychologistName,
    sessionDate,
    sessionTime,
    meetLink,
    duration = 50
  } = sessionData;

  // Parse date and time in IST (UTC+5:30)
  const sessionDateTime = new Date(`${sessionDate}T${sessionTime}+05:30`);
  const endDateTime = new Date(sessionDateTime.getTime() + (duration * 60000));

  const meetText = meetLink && String(meetLink).trim() ? meetLink : 'Join link will be shared separately';
  const title = encodeURIComponent(buildKoottSessionTitle({ clientName, psychologistName }));
  const body = encodeURIComponent(
    `Online therapy session\n\nJoin via Google Meet: ${meetText}\n\nPlease join 5 minutes early.`
  );
  const location = encodeURIComponent(meetLink && String(meetLink).trim() ? meetLink : 'Online session - Koott');

  // Use IST time for Outlook
  const startDate = sessionDateTime.toISOString();
  const endDate = endDateTime.toISOString();

  return `https://outlook.live.com/calendar/0/deeplink/compose?subject=${title}&body=${body}&location=${location}&startdt=${startDate}&enddt=${endDate}`;
}

module.exports = {
  generateCalendarInvite,
  createCalendarInvites,
  generateGoogleCalendarLink,
  generateOutlookCalendarLink
};
