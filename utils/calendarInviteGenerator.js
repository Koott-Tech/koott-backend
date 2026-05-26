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

  // Format dates for iCalendar in IST timezone (YYYYMMDDTHHMMSS)
  const formatICalDateIST = (date) => {
    // Format the date in IST timezone without converting to UTC
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}${month}${day}T${hours}${minutes}${seconds}`;
  };

  const startDate = formatICalDateIST(sessionDateTime);
  const endDate = formatICalDateIST(endDateTime);
  const createdDate = formatICalDateIST(new Date());

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
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Kolkata',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0530',
    'TZOFFSETTO:+0530',
    'TZNAME:IST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${createdDate}`,
    `DTSTART;TZID=Asia/Kolkata:${startDate}`,
    `DTEND;TZID=Asia/Kolkata:${endDate}`,
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

  // Format for Google Calendar in IST (YYYYMMDDTHHMMSS without Z for local time)
  const formatGoogleDateIST = (date) => {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, '');
  };

  const startDate = formatGoogleDateIST(sessionDateTime);
  const endDate = formatGoogleDateIST(endDateTime);

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
