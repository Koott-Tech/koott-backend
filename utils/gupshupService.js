const https = require('https');
const { URL } = require('url');

/**
 * WhatsApp Business messaging via Gupshup API
 * Requires env vars:
 * - GUPSHUP_API_KEY: Your Gupshup API key
 * - GUPSHUP_APP_NAME: Your Gupshup app name
 * - GUPSHUP_SOURCE: Your Gupshup source number (optional)
 */

// Send WhatsApp text message via Gupshup
async function sendWhatsAppText(toPhoneE164, message) {
  return new Promise((resolve) => {
    try {
      const apiKey = process.env.GUPSHUP_API_KEY;
      const appName = process.env.GUPSHUP_APP_NAME;
      const source = process.env.GUPSHUP_SOURCE || 'whatsapp';

      if (!apiKey || !appName) {
        console.warn('Gupshup env not configured; skipping send.');
        return resolve({ success: false, skipped: true, reason: 'missing_env' });
      }

      // Format phone number (remove + if present)
      const phoneNumber = toPhoneE164.replace(/^\+/, '');

      const url = new URL('https://api.gupshup.io/wa/api/v1/msg');
      
      const postData = JSON.stringify({
        channel: 'whatsapp',
        source: source,
        destination: phoneNumber,
        'src.name': appName,
        message: {
          type: 'text',
          text: message
        }
      });

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'apikey': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const jsonData = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log('✅ Gupshup message sent successfully');
              resolve({ success: true, data: jsonData });
            } else {
              console.error('❌ Gupshup send error:', jsonData);
              resolve({ success: false, error: jsonData });
            }
          } catch (parseErr) {
            console.error('❌ Gupshup response parse error:', parseErr);
            resolve({ success: false, error: { message: 'Invalid response', data } });
          }
        });
      });

      req.on('error', (err) => {
        console.error('❌ Gupshup request error:', err);
        resolve({ success: false, error: err });
      });

      req.write(postData);
      req.end();
    } catch (err) {
      console.error('❌ Gupshup send exception:', err);
      resolve({ success: false, error: err });
    }
  });
}

// Enhanced send function with retry logic (simplified for Gupshup)
async function sendWhatsAppTextWithRetry(toPhoneE164, message, retryCount = 0) {
  const result = await sendWhatsAppText(toPhoneE164, message);
  
  // Simple retry logic for Gupshup (no token refresh needed)
  if (!result.success && retryCount < 2) {
    console.log(`🔄 Retrying Gupshup message (attempt ${retryCount + 1})...`);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    return await sendWhatsAppTextWithRetry(toPhoneE164, message, retryCount + 1);
  }
  
  return result;
}

// Build booking confirmation message
function buildBookingMessage({ childName, date, time, meetLink }) {
  const who = childName ? `${childName}'s` : 'your';
  return (
    `🎉 *Your ${who} therapy session is booked!*\n\n` +
    `📅 *Date:* ${date}\n` +
    `⏰ *Time:* ${time}\n` +
    `🔗 *Join via Google Meet:* ${meetLink}\n\n` +
    `We look forward to seeing you! 😊\n\n` +
    `_Powered by Koott Child Therapy_`
  );
}

// Send booking confirmation via Gupshup
async function sendBookingConfirmation(toPhoneE164, details) {
  const message = buildBookingMessage(details);
  return await sendWhatsAppTextWithRetry(toPhoneE164, message);
}

// Send template message via Gupshup (for structured messages)
async function sendTemplateMessage(toPhoneE164, templateName, parameters = []) {
  return new Promise((resolve) => {
    try {
      const apiKey = process.env.GUPSHUP_API_KEY;
      const appName = process.env.GUPSHUP_APP_NAME;
      const source = process.env.GUPSHUP_SOURCE || 'whatsapp';

      if (!apiKey || !appName) {
        console.warn('Gupshup env not configured; skipping template send.');
        return resolve({ success: false, skipped: true, reason: 'missing_env' });
      }

      const phoneNumber = toPhoneE164.replace(/^\+/, '');
      const url = new URL('https://api.gupshup.io/wa/api/v1/template/msg');

      const postData = JSON.stringify({
        channel: 'whatsapp',
        source: source,
        destination: phoneNumber,
        'src.name': appName,
        template: {
          name: templateName,
          language: 'en',
          components: parameters.map(param => ({
            type: 'text',
            text: param
          }))
        }
      });

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'apikey': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const jsonData = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log('✅ Gupshup template message sent successfully');
              resolve({ success: true, data: jsonData });
            } else {
              console.error('❌ Gupshup template send error:', jsonData);
              resolve({ success: false, error: jsonData });
            }
          } catch (parseErr) {
            console.error('❌ Gupshup template response parse error:', parseErr);
            resolve({ success: false, error: { message: 'Invalid response', data } });
          }
        });
      });

      req.on('error', (err) => {
        console.error('❌ Gupshup template request error:', err);
        resolve({ success: false, error: err });
      });

      req.write(postData);
      req.end();
    } catch (err) {
      console.error('❌ Gupshup template send exception:', err);
      resolve({ success: false, error: err });
    }
  });
}

module.exports = {
  sendWhatsAppText,
  sendWhatsAppTextWithRetry,
  sendBookingConfirmation,
  sendTemplateMessage,
};
