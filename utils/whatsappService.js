const https = require('https');
const { URL } = require('url');
const { supabaseAdmin } = require('../config/supabase');

/**
 * WhatsApp messaging via WASenderApi
 * Requires env vars:
 * - WASENDER_API_KEY: Your WASenderApi API key
 */

/**
 * Normalize phone number to ensure it has country code
 * Handles various formats and adds default country code if missing
 * @param {string} phoneNumber - Phone number in any format
 * @param {string} defaultCountryCode - Default country code (default: '+91')
 * @returns {string|null} - Normalized phone number with country code or null if invalid
 */
function normalizePhoneNumber(phoneNumber, defaultCountryCode = '+91') {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return null;
  }

  // Remove all whitespace
  let cleaned = phoneNumber.trim();

  // If empty or just the country code itself, return null
  if (!cleaned || cleaned === defaultCountryCode || cleaned === defaultCountryCode.replace('+', '')) {
    return null;
  }

  // If already starts with +, validate it
  if (cleaned.startsWith('+')) {
    // For Indian numbers (+91), validate that it has exactly 10 digits after country code
    if (cleaned.startsWith('+91')) {
      const digitsAfterCountryCode = cleaned.substring(3);
      if (digitsAfterCountryCode.length !== 10) {
        console.warn(`⚠️ Invalid Indian phone number format: ${cleaned} (expected 10 digits after +91, got ${digitsAfterCountryCode.length})`);
        // Still return it - let WhatsApp API reject it with a clearer error
      }
    }
    return cleaned;
  }

  // If starts with country code without + (e.g., "91...")
  if (cleaned.startsWith('91') && cleaned.length > 10) {
    return '+' + cleaned;
  }

  // If starts with 0 (common in India), remove it and add country code
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }

  // If it's a 10-digit number (Indian mobile), add default country code
  if (/^\d{10}$/.test(cleaned)) {
    return defaultCountryCode + cleaned;
  }

  // If it's already a valid international number without +, add +
  if (/^\d{10,15}$/.test(cleaned)) {
    // If it looks like it might already have country code (11+ digits)
    if (cleaned.length >= 11) {
      // Check if it starts with a known country code
      if (cleaned.startsWith('91') && cleaned.length === 12) {
        return '+' + cleaned;
      }
    }
    // For 10 digits, assume it needs country code
    if (cleaned.length === 10) {
      return defaultCountryCode + cleaned;
    }
  }

  // If we can't normalize it, return null
  return null;
}

/**
 * Format phone number to E.164 format if needed.
 * WASenderApi accepts numbers with leading + and country code.
 * @param {string} phoneE164 - Phone number in any common format
 * @returns {string|null} - Normalized E.164 (+<country><number>) or null if invalid
 */
function formatPhoneNumber(phoneE164) {
  if (!phoneE164) return null;
  
  // First normalize to ensure country code exists
  const normalized = normalizePhoneNumber(phoneE164);
  if (!normalized) return null;
  
  // Basic validation for E.164: leading + and 8-15 digits
  const cleaned = normalized.replace(/\s/g, '');
  if (!/^\+\d{8,15}$/.test(cleaned)) {
    console.warn(`⚠️ Phone number not in valid E.164 format: ${cleaned}`);
    return null;
  }

  return cleaned;
}

/**
 * Send WhatsApp text message via WASenderApi
 * @param {string} toPhoneE164 - Phone number in E.164 format (e.g., +919876543210)
 * @param {string} message - Message text to send
 * @returns {Promise<Object>} - { success: boolean, data?: Object, error?: Object, skipped?: boolean, reason?: string }
 */
async function sendWhatsAppText(toPhoneE164, message) {
  return new Promise((resolve) => {
    try {
      const apiKey = process.env.WASENDER_API_KEY;

      if (!apiKey) {
        console.warn('WASenderApi env (WASENDER_API_KEY) not configured; skipping send.');
        return resolve({ success: false, skipped: true, reason: 'missing_env' });
      }

      // Normalize phone number for WASenderApi (E.164 with +)
      const formattedPhone = formatPhoneNumber(toPhoneE164);
      if (!formattedPhone) {
        console.warn('Invalid or incomplete phone number format:', toPhoneE164);
        return resolve({ success: false, skipped: true, reason: 'invalid_phone' });
      }

      console.log(`📱 Formatting phone: ${toPhoneE164} -> ${formattedPhone}`);

      // WASenderApi endpoint
      const apiUrl = 'https://wasenderapi.com/api/send-message';
      const url = new URL(apiUrl);
      
      // Build request body
      const postData = JSON.stringify({
        to: formattedPhone,
        text: message
      });

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          Authorization: `Bearer ${apiKey}`
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const jsonData = JSON.parse(data || '{}');

            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log('✅ WhatsApp message sent via WASenderApi:', jsonData);
              resolve({ success: true, data: jsonData });
            } else {
              // Provide more helpful error messages
              const errorMessage = jsonData.message || 'Unknown error';
              if (errorMessage.includes('JID does not exist') || errorMessage.includes('does not exist on WhatsApp')) {
                console.error(`❌ WASenderApi error: Phone number ${formattedPhone} is not registered with WhatsApp or is invalid. Please verify the phone number in the database.`, jsonData);
              } else {
                console.error('❌ WASenderApi error:', jsonData);
              }
              resolve({ success: false, error: jsonData });
            }
          } catch (parseErr) {
            console.error('❌ WASenderApi response parse error:', parseErr, 'Raw data:', data);
            resolve({ success: false, error: { message: 'Invalid response', data } });
          }
        });
      });

      req.on('error', (err) => {
        console.error('❌ WASenderApi request error:', err);
        resolve({ success: false, error: err });
      });

      req.write(postData);
      req.end();
    } catch (err) {
      console.error('❌ WASenderApi send exception:', err);
      resolve({ success: false, error: err });
    }
  });
}

/**
 * Send WhatsApp message with retry logic
 * @param {string} toPhoneE164 - Phone number in E.164 format
 * @param {string} message - Message text to send
 * @param {number} retryCount - Current retry attempt (internal use)
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<Object>} - { success: boolean, ... }
 */
async function sendWhatsAppTextWithRetry(toPhoneE164, message, retryCount = 0, maxRetries = 2) {
  const result = await sendWhatsAppText(toPhoneE164, message);
  
  // If failed and we haven't exceeded max retries, retry
  if (!result.success && !result.skipped && retryCount < maxRetries) {
    const delay = (retryCount + 1) * 1000; // Exponential backoff: 1s, 2s
    console.log(`🔄 Retrying WhatsApp send (attempt ${retryCount + 1}/${maxRetries}) after ${delay}ms...`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return await sendWhatsAppTextWithRetry(toPhoneE164, message, retryCount + 1, maxRetries);
  }
  
  return result;
}

// Helper: format date string (YYYY-MM-DD) to friendly format in IST
function formatFriendlyDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(`${dateStr}T00:00:00+05:30`);
    return d.toLocaleDateString('en-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'Asia/Kolkata'
    });
  } catch {
    return dateStr;
  }
}

// Helper: format time string (HH:mm or HH:mm:ss) to h:mm AM/PM IST
function formatFriendlyTime(timeStr) {
  if (!timeStr) return '';
  try {
    // Time is already in IST format (HH:MM), just format it directly without timezone conversion
    const [h, m] = timeStr.split(':');
    const hours = parseInt(h, 10);
    const minutes = parseInt(m || '0', 10);
    
    // Convert to 12-hour format with AM/PM
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const displayMinutes = minutes.toString().padStart(2, '0');
    
    return `${displayHours}:${displayMinutes} ${period}`;
  } catch {
    return timeStr;
  }
}

/**
 * Build main booking confirmation message
 * @param {Object} details - { childName, date, time, meetLink, psychologistName?, isFreeAssessment?, packageInfo? }
 * @returns {string} Formatted message
 */
function buildBookingMessage({ childName, date, time, meetLink, psychologistName = null, isFreeAssessment = false, packageInfo = null }) {
  const friendlyDate = formatFriendlyDate(date);
  const friendlyTime = formatFriendlyTime(time);
  const sessionType = isFreeAssessment ? 'Free Assessment' : 'Therapy Session';

  // Only include child line if childName is provided and not empty/null/'Pending'
  const hasChildName = childName && 
    childName.trim() !== '' && 
    childName.toLowerCase() !== 'pending';
  
  const childLine = hasChildName ? `👧 Child: ${childName}\n\n` : '';

  // Psychologist name line (if provided) - no Dr. prefix
  const psychologistLine = psychologistName && psychologistName.trim() 
    ? `👨‍⚕️ Therapist: ${psychologistName.trim()}\n\n` 
    : '';

  // Package information line
  let packageLine = '';
  if (packageInfo && packageInfo.totalSessions) {
    const completed = packageInfo.completedSessions || 0;
    const remaining = packageInfo.remainingSessions || 0;
    packageLine = `📦 Package Session: ${completed}/${packageInfo.totalSessions} completed, ${remaining} remaining\n\n`;
  }

  // Build join meet button/link - formatted as clickable link
  const joinMeetButton = meetLink 
    ? `\n\n🔗 *Join Meet:*\n${meetLink}\n\n` 
    : '';

  return (
    `🧸 ${sessionType} Confirmed!\n\n` +
    `Session details:\n\n` +
    childLine +
    psychologistLine +
    (packageLine || '') +
    `📅 Date: ${friendlyDate || date}\n\n` +
    `⏰ Time: ${friendlyTime || time} (IST)\n\n` +
    joinMeetButton +
    `We look forward to seeing you. 💜`
  );
}

/**
 * Send booking confirmation WhatsApp messages (multi-part)
 * @param {string} toPhoneE164 - Phone number in E.164 format
 * @param {Object} details - { childName, date, time, meetLink, psychologistName?, receiptUrl?, isFreeAssessment?, packageInfo? }
 * @returns {Promise<Object>} - { success: boolean, ... }
 */
async function sendBookingConfirmation(toPhoneE164, details) {
  const {
    childName,
    date,
    time,
    meetLink,
    psychologistName,
    receiptUrl, // Legacy support - for old receipts stored in storage
    receiptPdfBuffer, // New: PDF buffer (will be discarded after sending)
    receiptNumber, // Receipt number for reference
    clientName, // Client name (first_name + last_name) for receipt filename
    isFreeAssessment = false,
    packageInfo = null
  } = details || {};

  // New requirement: send a single WhatsApp confirmation message in a clean format
  // and include a "For receipt: Click here" link (if we can generate one).

  // NOTE: childName is intentionally not used in this WhatsApp template (per request).
  void childName;

  // Receipt link requirement: always send users to the production receipts page
  // (no expiring signed links in WhatsApp).
  const frontendUrl = (
    process.env.FRONTEND_URL ||
    process.env.RAZORPAY_SUCCESS_URL?.replace(/\/payment-success.*$/, '') ||
    'https://www.little.care'
  ).replace(/\/$/, '');
  const receiptLink = `${frontendUrl}/profile/receipts`;

  // Keep these for backwards compatibility (not used in this template now)
  void receiptUrl;
  void receiptPdfBuffer;
  void receiptNumber;
  void clientName;

  // 2) Format date as: "Mon, 12 Jan 2026"
  const formatBookingDateShort = (dateStr) => {
    if (!dateStr) return '';
    try {
      const d = new Date(`${dateStr}T00:00:00+05:30`);
      return d.toLocaleDateString('en-IN', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
    } catch {
      return dateStr;
    }
  };

  const bullet = '•⁠  ⁠';
  const specialist = (psychologistName && psychologistName.trim()) ? psychologistName.trim() : 'our specialist';
  const formattedDate = formatBookingDateShort(date);
  const formattedTime = formatFriendlyTime(time);

  // Package line (only for package sessions): "1 of 3 sessions booked, 2 left"
  let packageLine = '';
  if (!isFreeAssessment && packageInfo && packageInfo.totalSessions) {
    const total = packageInfo.totalSessions || 0;
    const completed = packageInfo.completedSessions || 0;
    const booked = Math.min(total, completed + 1);
    const left = Math.max(total - booked, 0);
    packageLine = `${bullet}Package: ${booked} of ${total} sessions booked, ${left} left\n`;
  }

  const joinBlock = meetLink
    ? `Join link:\n${meetLink}\n\n`
    : `Due to some issue Google Meet didn't get created. Please contact our support.\n\n`;
  const receiptBlock = `For receipt: Click here\n${receiptLink}\n\n`;

  const specialistLine = isFreeAssessment
    ? `${bullet}Little Care Specialist\n`
    : `${bullet}Specialist: ${specialist}\n`;

  // Duration line: 50 min for paid sessions, not shown for free assessment
  const durationLine = !isFreeAssessment ? `${bullet}Duration: 50 min\n` : '';

  // Format message - same structure for all session types
  const message =
    `Hey 👋\n\n` +
    `Your session with Little Care is confirmed.\n` +
    specialistLine +
    packageLine +
    `${bullet}Date: ${formattedDate}\n` +
    `${bullet}Time: ${formattedTime} (IST)\n` +
    durationLine +
    `\n` +
    joinBlock +
    `Please be ready 10 mins early with good internet, a quiet space, and a charged device.\n\n` +
    `For help: +91 95390 07766\n` +
    receiptBlock +
    `— Little Care 💜`;

  // Send exactly one message (clean + link-friendly)
  return await sendWhatsAppTextWithRetry(toPhoneE164, message);
}

/**
 * Format date as: "19 Jan-26" (DD MMM-YY format)
 * @param {string} dateStr - Date string (YYYY-MM-DD)
 * @returns {string} Formatted date
 */
function formatRescheduleDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(`${dateStr}T00:00:00+05:30`);
    const day = d.getDate().toString().padStart(2, '0');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[d.getMonth()];
    const year = d.getFullYear().toString().slice(-2);
    return `${day} ${month}-${year}`;
  } catch {
    return dateStr;
  }
}

/**
 * Format time as: "9:00 PM" (12-hour format)
 * @param {string} timeStr - Time string (HH:MM)
 * @returns {string} Formatted time
 */
function formatRescheduleTime(timeStr) {
  if (!timeStr) return '';
  try {
    const [h, m] = timeStr.split(':');
    const hours = parseInt(h, 10);
    const minutes = parseInt(m || '0', 10);
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const displayMinutes = minutes.toString().padStart(2, '0');
    return `${displayHours}:${displayMinutes} ${period}`;
  } catch {
    return timeStr;
  }
}

/**
 * Send reschedule confirmation WhatsApp message
 * @param {string} toPhoneE164 - Phone number in E.164 format
 * @param {Object} details - { oldDate, oldTime, newDate, newTime, newMeetLink? }
 * @returns {Promise<Object>} - { success: boolean, ... }
 */
async function sendRescheduleConfirmation(toPhoneE164, details) {
  const {
    oldDate,
    oldTime,
    newDate,
    newTime,
    newMeetLink
  } = details || {};

  const bullet = '•⁠  ⁠';
  const oldFormatted = `${formatRescheduleDate(oldDate)}, ${formatRescheduleTime(oldTime)}`;
  const newFormatted = `${formatRescheduleDate(newDate)}, ${formatRescheduleTime(newTime)}`;
  
  const newLinkBlock = newMeetLink ? `${bullet}New link: ${newMeetLink}\n\n` : '';

  const message =
    `Hey, Your session has been rescheduled.\n\n` +
    `${bullet}Old: ${oldFormatted}\n` +
    `${bullet}New: ${newFormatted}\n` +
    newLinkBlock +
    `We're looking forward to seeing you at the new time.\n\n` +
    `— Little Care 💜`;

  return await sendWhatsAppTextWithRetry(toPhoneE164, message);
}

/**
 * Format date as: "22 Jan 2026" (DD MMM YYYY format)
 * @param {string} dateStr - Date string (YYYY-MM-DD)
 * @returns {string} Formatted date
 */
function formatNoShowDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(`${dateStr}T00:00:00+05:30`);
    const day = d.getDate().toString().padStart(2, '0');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[d.getMonth()];
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
  } catch {
    return dateStr;
  }
}

/**
 * Format time as: "9:00 AM" (12-hour format)
 * @param {string} timeStr - Time string (HH:MM)
 * @returns {string} Formatted time
 */
function formatNoShowTime(timeStr) {
  if (!timeStr) return '';
  try {
    const [h, m] = timeStr.split(':');
    const hours = parseInt(h, 10);
    const minutes = parseInt(m || '0', 10);
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const displayMinutes = minutes.toString().padStart(2, '0');
    return `${displayHours}:${displayMinutes} ${period}`;
  } catch {
    return timeStr;
  }
}

/**
 * Format phone number for display (removes + and formats as "91 99999999")
 * @param {string} phoneE164 - Phone number in E.164 format
 * @returns {string} Formatted phone number
 */
function formatPhoneForDisplay(phoneE164) {
  if (!phoneE164) return '';
  // Remove + and spaces, then format as "91 99999999"
  const cleaned = phoneE164.replace(/[+\s]/g, '');
  if (cleaned.startsWith('91') && cleaned.length === 12) {
    return `91 ${cleaned.slice(2)}`;
  }
  return cleaned;
}

/**
 * Send no-show notification WhatsApp message
 * @param {string} toPhoneE164 - Phone number in E.164 format
 * @param {Object} details - { psychologistName, date, time, supportPhone? }
 * @returns {Promise<Object>} - { success: boolean, ... }
 */
async function sendNoShowNotification(toPhoneE164, details) {
  const {
    psychologistName,
    date,
    time,
    supportPhone
  } = details || {};

  const formattedDate = formatNoShowDate(date);
  const formattedTime = formatNoShowTime(time);
  const supportPhoneDisplay = supportPhone 
    ? formatPhoneForDisplay(supportPhone)
    : '91 95390 07766'; // Default support number

  const message =
    `Hey,\n\n` +
    `Your session with ${psychologistName || 'our specialist'} on ${formattedDate} at ${formattedTime} was missed.\n` +
    `If you need support our Little Care team is here to help, ${supportPhoneDisplay}\n\n` +
    `— Little Care 💜`;

  return await sendWhatsAppTextWithRetry(toPhoneE164, message);
}

/**
 * Send session completion WhatsApp message with feedback and booking links
 * @param {string} toPhoneE164 - Phone number in E.164 format
 * @param {Object} details - { psychologistName, bookingLink, feedbackLink, packageInfo? }
 * @param {Object} packageInfo - { completedSessions, totalSessions } (optional, for package sessions)
 * @returns {Promise<Object>} - { success: boolean, ... }
 */
async function sendSessionCompletionNotification(toPhoneE164, details) {
  const {
    psychologistName,
    bookingLink,
    feedbackLink,
    packageInfo
  } = details || {};

  const specialist = psychologistName && psychologistName.trim() 
    ? psychologistName.trim() 
    : 'our specialist';

  const bookingLinkText = bookingLink || 'https://www.little.care/psychologists';
  const feedbackLinkText = feedbackLink || 'https://www.little.care/profile/reports';

  // Check if this is a package session and use appropriate template
  if (packageInfo && packageInfo.totalSessions && packageInfo.completedSessions !== undefined) {
    const completedSessions = packageInfo.completedSessions;
    const totalSessions = packageInfo.totalSessions;
    
    const message =
      `Hey,\n\n` +
      `You've completed ${completedSessions}/${totalSessions} sessions with ${specialist}.\n` +
      `It's time to book your next session: ${bookingLinkText}\n\n` +
      `We'd love your feedback on your last session:\n` +
      `How was it? Reply with 1–5 (1 = Poor, 5 = Excellent) or click here: ${feedbackLinkText}\n\n` +
      `— Little Care 💜`;

    return await sendWhatsAppTextWithRetry(toPhoneE164, message);
  }

  // Regular session completion template (non-package)
  const message =
    `Hey,\n\n` +
    `We hope your session with ${specialist} went well.\n\n` +
    `Would you like to book a follow-up session?\n` +
    `You can reply here or book directly:\n` +
    `${bookingLinkText}\n\n` +
    `We'd love your feedback:\n` +
    `How was your session? Reply with 1–5 (1 = Poor, 5 = Excellent) or click here:\n` +
    `${feedbackLinkText}\n\n` +
    `— Little Care 💜`;

  return await sendWhatsAppTextWithRetry(toPhoneE164, message);
}

module.exports = {
  sendWhatsAppText,
  sendWhatsAppTextWithRetry,
  sendBookingConfirmation,
  sendRescheduleConfirmation,
  sendNoShowNotification,
  sendSessionCompletionNotification,
  formatPhoneNumber,
  normalizePhoneNumber, // Export for testing if needed
  formatFriendlyTime, // Export for manual booking
};
