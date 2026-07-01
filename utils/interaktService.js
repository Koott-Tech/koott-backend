/**
 * Interakt WhatsApp Service
 *
 * Sends WhatsApp messages via the Interakt API using pre-approved templates.
 * Replaces WASenderApi for outbound notifications.
 *
 * Requires env vars:
 *   - INTERAKT_API_KEY: Your Interakt API key (from Dashboard → Settings → Developer Settings)
 *
 * API Reference:
 *   - Endpoint: POST https://api.interakt.ai/v1/public/message/
 *   - Auth: Authorization: Basic <API_KEY>
 *   - Content-Type: application/json
 *
 * IMPORTANT: Outbound messages (booking confirmations, welcome messages) MUST use
 * pre-approved WhatsApp templates. Free-text messages only work within the 24-hour
 * customer service window (i.e., only after the customer has messaged you first).
 */

const https = require('https');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const LOG_PREFIX = '[interakt]';

/**
 * Parse a phone number into { countryCode, phoneNumber } for the Interakt API.
 * Uses Google's libphonenumber for accurate country code detection across all countries.
 * Falls back to India (+91) for bare 10-digit numbers (no country code prefix).
 *
 * @param {string} phone - e.g. "+919876543210", "9876543210", "+61412345678"
 * @returns {{ countryCode: string, phoneNumber: string } | null}
 */
function parsePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;

  const cleaned = phone.trim().replace(/[\s\-().]/g, '');
  if (!cleaned) return null;

  // Bare 10-digit number with no + — treat as Indian local number
  if (/^\d{10}$/.test(cleaned)) {
    return { countryCode: '+91', phoneNumber: cleaned };
  }

  // Ensure E.164 format for the parser (needs leading +)
  const e164 = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;

  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || !parsed.isValid()) return null;

  return {
    countryCode: `+${parsed.countryCallingCode}`,
    phoneNumber: parsed.nationalNumber,
  };
}

/**
 * Send a template message via Interakt API.
 *
 * @param {string} toPhone - Recipient phone number (any format)
 * @param {string} templateName - Template code name (from Interakt dashboard)
 * @param {string} languageCode - Template language code (default: 'en')
 * @param {Object} options
 * @param {string[]} [options.bodyValues] - Values for body variables (in order)
 * @param {string[]} [options.headerValues] - Values for header variables
 * @param {Object} [options.buttonValues] - Button dynamic URLs { "0": ["url"], ... }
 * @param {string} [options.callbackData] - Optional callback data
 * @returns {Promise<{ success: boolean, data?: Object, error?: any, skipped?: boolean, reason?: string }>}
 */
async function sendTemplateMessage(toPhone, templateName, languageCode = 'en', options = {}) {
  return new Promise((resolve) => {
    try {
      const apiKey = (process.env.INTERAKT_API_KEY || '').trim();

      if (!apiKey) {
        console.warn(`${LOG_PREFIX} INTERAKT_API_KEY not configured; skipping send.`);
        return resolve({ success: false, skipped: true, reason: 'missing_env' });
      }

      const parsed = parsePhone(toPhone);
      if (!parsed) {
        console.warn(`${LOG_PREFIX} invalid phone number: ${toPhone}`);
        return resolve({ success: false, skipped: true, reason: 'invalid_phone' });
      }

      const payload = {
        countryCode: parsed.countryCode,
        phoneNumber: parsed.phoneNumber,
        type: 'Template',
        template: {
          name: templateName,
          languageCode,
        },
      };

      if (options.bodyValues?.length) {
        payload.template.bodyValues = options.bodyValues;
      }
      if (options.headerValues?.length) {
        payload.template.headerValues = options.headerValues;
      }
      if (options.buttonValues && Object.keys(options.buttonValues).length) {
        payload.template.buttonValues = options.buttonValues;
      }
      if (options.callbackData) {
        payload.callbackData = options.callbackData;
      }

      const postData = JSON.stringify(payload);

      console.log(`${LOG_PREFIX} sending template "${templateName}" to ${parsed.countryCode}${parsed.phoneNumber.slice(0, 4)}****`);

      const reqOptions = {
        hostname: 'api.interakt.ai',
        port: 443,
        path: '/v1/public/message/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          Authorization: `Basic ${apiKey}`,
        },
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data || '{}');
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`${LOG_PREFIX} ✅ template "${templateName}" sent successfully`);
              resolve({ success: true, data: json });
            } else {
              console.error(`${LOG_PREFIX} ❌ API error (${res.statusCode}):`, json);
              resolve({ success: false, error: json });
            }
          } catch (parseErr) {
            console.error(`${LOG_PREFIX} ❌ response parse error:`, parseErr.message);
            resolve({ success: false, error: { message: 'Invalid response', raw: data } });
          }
        });
      });

      req.on('error', (err) => {
        console.error(`${LOG_PREFIX} ❌ request error:`, err.message);
        resolve({ success: false, error: err });
      });

      req.write(postData);
      req.end();
    } catch (err) {
      console.error(`${LOG_PREFIX} ❌ exception:`, err.message);
      resolve({ success: false, error: err });
    }
  });
}

/**
 * Send a template message with retry logic.
 */
async function sendTemplateWithRetry(toPhone, templateName, languageCode = 'en', options = {}, retryCount = 0, maxRetries = 2) {
  const result = await sendTemplateMessage(toPhone, templateName, languageCode, options);

  if (!result.success && !result.skipped && retryCount < maxRetries) {
    const delay = (retryCount + 1) * 1000;
    console.log(`${LOG_PREFIX} 🔄 retry ${retryCount + 1}/${maxRetries} after ${delay}ms...`);
    await new Promise((r) => setTimeout(r, delay));
    return sendTemplateWithRetry(toPhone, templateName, languageCode, options, retryCount + 1, maxRetries);
  }

  return result;
}

// ─── Convenience wrappers for Wix booking flow ─────────────────────────────

// Template names — update these to match your actual Interakt template code names.
// You must create and get these templates approved in Meta Business Manager,
// then sync them to your Interakt dashboard.
const TEMPLATES = {
  BOOKING_CONFIRMATION: process.env.INTERAKT_TPL_BOOKING_CONFIRMATION || 'booking_confirmation_v1',
  SESSION_NOTIFICATION_PSYCHOLOGIST: process.env.INTERAKT_TPL_SESSION_NOTIFICATION || 'therapistconfirmation',
  RESCHEDULED_LINK_SHARING: process.env.INTERAKT_TPL_RESCHEDULED || 'rescheduled_link_sharing',
  SESSION_FOLLOW_UP: process.env.INTERAKT_TPL_SESSION_FOLLOW_UP || 'session_follow_up_v2',
  SESSION_REMINDER: process.env.INTERAKT_TPL_SESSION_REMINDER || 'sessionreminderautomatic',
};

/**
 * Send booking confirmation to client.
 *
 * Template: booking_confirmation_v1
 * Expected template body variables (in order):
 *   {{1}} = client name
 *   {{2}} = therapist name
 *   {{3}} = date (e.g. "Mon, 12 Jan 2026")
 *   {{4}} = time (e.g. "10:00 AM")
 *   {{5}} = meet link
 */
async function sendBookingConfirmation(toPhone, details) {
  const { psychologistName, date, time, meetLink, clientName } = details || {};

  // Format date
  let formattedDate = date || '';
  try {
    if (date) {
      const d = new Date(`${date}T00:00:00+05:30`);
      formattedDate = d.toLocaleDateString('en-IN', {
        weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
      });
    }
  } catch { /* keep raw */ }

  // Format time
  let formattedTime = time || '';
  try {
    if (time) {
      const [h, m] = time.split(':');
      const hours = parseInt(h, 10);
      const minutes = parseInt(m || '0', 10);
      const period = hours >= 12 ? 'PM' : 'AM';
      const displayH = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
      formattedTime = `${displayH}:${minutes.toString().padStart(2, '0')} ${period}`;
    }
  } catch { /* keep raw */ }

  const specialist = (psychologistName || '').trim() || 'our specialist';
  const client = (clientName || '').trim();
  const link = meetLink || 'Link will be shared shortly';

  return sendTemplateWithRetry(toPhone, TEMPLATES.BOOKING_CONFIRMATION, 'en', {
    bodyValues: [client, specialist, formattedDate, formattedTime, link],
    callbackData: 'wix_booking_confirmation',
  });
}

/**
 * Send session notification to therapist.
 *
 * Template: therapistconfirmation
 * Body:
 *   Hi {{1}},
 *   A new session has been booked with you.
 *   Client: {{2}}
 *   When: {{3}} at {{4}}
 *   Join here: {{5}}
 *   Thank you,
 *   Koott Care
 *
 * Variables (5):
 *   {{1}} = therapist name
 *   {{2}} = client name
 *   {{3}} = date  (e.g. "Mon, 03 Jun 2026")
 *   {{4}} = time  (e.g. "11:00 PM")
 *   {{5}} = meet link
 *
 * @param {string} toPhone
 * @param {object} details
 *   - therapistName, clientName, date (YYYY-MM-DD), time (HH:MM), meetLink
 *   (durationMinutes accepted for backward compat — ignored, this template has no duration variable)
 */
async function sendSessionNotificationPsychologist(toPhone, details) {
  const { therapistName, clientName, date, time, meetLink } = details || {};

  // Format date
  let formattedDate = date || '';
  try {
    if (date) {
      const d = new Date(`${date}T00:00:00+05:30`);
      formattedDate = d.toLocaleDateString('en-IN', {
        weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
      });
    }
  } catch { /* keep raw */ }

  // Format time
  let formattedTime = time || '';
  try {
    if (time) {
      const [h, m] = time.split(':');
      const hours = parseInt(h, 10);
      const minutes = parseInt(m || '0', 10);
      const period = hours >= 12 ? 'PM' : 'AM';
      const displayH = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
      formattedTime = `${displayH}:${minutes.toString().padStart(2, '0')} ${period}`;
    }
  } catch { /* keep raw */ }

  const link = meetLink || 'Link will be shared shortly';

  return sendTemplateWithRetry(toPhone, TEMPLATES.SESSION_NOTIFICATION_PSYCHOLOGIST, 'en', {
    bodyValues: [
      (therapistName || '').trim() || 'there',
      (clientName || '').trim() || 'your client',
      formattedDate,
      formattedTime,
      link,
    ],
    callbackData: 'session_notification_therapist',
  });
}

/**
 * Send reschedule notification.
 *
 * Template: rescheduled_link_sharing
 * Expected template body variables (in order):
 *   {{1}} = recipient name (client or therapist receiving the message)
 *   {{2}} = other party name (therapist if client receives; client if therapist receives)
 *   {{3}} = new date  (e.g. "Mon, 12 Jan 2026")
 *   {{4}} = new time  (e.g. "10:00 AM")
 *   {{5}} = meet link
 *
 * @param {string} toPhone
 * @param {object} details
 *   - recipientName, otherPartyName, date (YYYY-MM-DD), time (HH:MM), meetLink
 */
async function sendRescheduleNotification(toPhone, details) {
  const { recipientName, otherPartyName, date, time, meetLink } = details || {};

  // Format date
  let formattedDate = date || '';
  try {
    if (date) {
      const d = new Date(`${date}T00:00:00+05:30`);
      formattedDate = d.toLocaleDateString('en-IN', {
        weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
      });
    }
  } catch { /* keep raw */ }

  // Format time
  let formattedTime = time || '';
  try {
    if (time) {
      const [h, m] = time.split(':');
      const hours = parseInt(h, 10);
      const minutes = parseInt(m || '0', 10);
      const period = hours >= 12 ? 'PM' : 'AM';
      const displayH = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
      formattedTime = `${displayH}:${minutes.toString().padStart(2, '0')} ${period}`;
    }
  } catch { /* keep raw */ }

  const link = meetLink || 'Link will be shared shortly';

  return sendTemplateWithRetry(toPhone, TEMPLATES.RESCHEDULED_LINK_SHARING, 'en', {
    bodyValues: [
      (recipientName || '').trim() || 'there',
      (otherPartyName || '').trim() || 'our team',
      formattedDate,
      formattedTime,
      link,
    ],
    callbackData: 'session_reschedule',
  });
}

/**
 * Send session completion follow-up to client.
 *
 * Template: session_follow_up_v2
 * Body:
 *   Hi {{1}},
 *   Your Koott session with {{2}} was completed on {{3}}
 *   Therapist note: {{4}}
 *   Feedback: https://www.koott.in/feedback
 *   If you require any assistance or follow-up, please reply to this message.
 *   Koott Care
 *
 * Variables (in order):
 *   {{1}} = client name
 *   {{2}} = therapist name
 *   {{3}} = completion date (e.g. "Mon, 12 Jan 2026")
 *   {{4}} = therapist note (summary)
 */
async function sendSessionFollowUp(toPhone, details) {
  const { clientName, psychologistName, completedAt, therapistNote } = details || {};

  // Format completion date
  let formattedDate = '';
  try {
    const src = completedAt || new Date().toISOString();
    const d = new Date(src.length === 10 ? `${src}T00:00:00+05:30` : src);
    formattedDate = d.toLocaleDateString('en-IN', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
  } catch {
    formattedDate = String(completedAt || '').slice(0, 10);
  }

  // Trim and bound therapist note (WhatsApp template variables can't have line breaks)
  let note = String(therapistNote || '').replace(/\s+/g, ' ').trim();
  if (!note) note = 'No additional notes from your therapist for this session.';
  if (note.length > 250) note = note.slice(0, 247) + '...';

  return sendTemplateWithRetry(toPhone, TEMPLATES.SESSION_FOLLOW_UP, 'en', {
    bodyValues: [
      (clientName || '').trim() || 'there',
      (psychologistName || '').trim() || 'your therapist',
      formattedDate,
      note,
    ],
    callbackData: 'session_completed_followup',
  });
}

/**
 * Send session reminder.
 *
 * Template: sessionreminderautomatic
 * Variables (in order, 4 total):
 *   {{1}} = client name
 *   {{2}} = scheduled time (e.g. "3:00 PM")
 *   {{3}} = therapist name
 *   {{4}} = meet link (join here)
 *
 * @param {string} toPhone
 * @param {object} details
 *   - clientName, scheduledTime, psychologistName, meetLink
 */
async function sendSessionReminder(toPhone, details) {
  const { clientName, scheduledTime, psychologistName, meetLink } = details || {};
  const link = meetLink || 'Link will be shared shortly';
  return sendTemplateWithRetry(toPhone, TEMPLATES.SESSION_REMINDER, 'en', {
    bodyValues: [
      (clientName || '').trim() || 'there',
      (scheduledTime || '').trim() || '',
      (psychologistName || '').trim() || 'our team',
      link,
    ],
    callbackData: 'session_reminder',
  });
}

module.exports = {
  parsePhone,
  sendTemplateMessage,
  sendTemplateWithRetry,
  sendBookingConfirmation,
  sendSessionNotificationPsychologist,
  sendRescheduleNotification,
  sendSessionFollowUp,
  sendSessionReminder,
  TEMPLATES,
};
