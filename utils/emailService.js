const nodemailer = require('nodemailer');
const { resolveSessionDurationMinutes } = require('./sessionMeetDuration');

// Public site base for email assets and links (override with SITE_URL or PUBLIC_APP_URL)
const PRODUCTION_SITE_URL = (
  process.env.SITE_URL ||
  process.env.PUBLIC_APP_URL ||
  'https://www.koott.in'
).replace(/\/+$/, '');

// Hosted email header images — served from Vercel frontend public folder
const CLIENT_EMAIL_HEADER_URL = process.env.CLIENT_EMAIL_HEADER_URL || 'https://koott-frontend-keth.vercel.app/BookingConfirmationKoott.webp';
const THERAPIST_EMAIL_HEADER_URL = process.env.THERAPIST_EMAIL_HEADER_URL || 'https://koott-frontend-keth.vercel.app/NewKoottBooking.webp';

// Dark mode styles injected into every session confirmation email <head>
const DARK_MODE_STYLES = `
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <style>
    @media (prefers-color-scheme: dark) {
      .email-bg   { background-color: #121212 !important; }
      .email-card { background-color: #1e1e1e !important; }
      .content-td { background-color: #1e1e1e !important; }
      .greeting   { color: #f3f4f6 !important; }
      .body-text  { color: #d1d5db !important; }
      .detail-text { color: #d1d5db !important; }
      .detail-link { color: #4ade80 !important; }
      .btn-pill   { border-color: #4ade80 !important; color: #4ade80 !important; }
      /* Reminder / preparation gradient box */
      .reminder-box   { background-color: #14532d !important; background-image: none !important; }
      .reminder-title { color: #bbf7d0 !important; }
      .reminder-list  { color: #bbf7d0 !important; }
      /* Calendar already-added info box */
      .cal-info-box { background-color: #1e1b4b !important; border-color: #4338ca !important; }
      .cal-info-text { color: #c7d2fe !important; }
      /* Meet link fallback warning */
      .warn-box  { background-color: #422006 !important; border-color: #b45309 !important; }
      .warn-text { color: #fde68a !important; }
    }
  </style>
`;

// Shared helper: Format time string (HH:MM:SS or HH:MM) to 12-hour format (h:mm AM/PM IST)
// Time is already stored in IST format, so no timezone conversion needed
function formatTimeFromString(timeStr) {
  if (!timeStr) return 'N/A';
  try {
    // Handle formats: "18:00:00" or "18:00"
    const timeParts = timeStr.split(':');
    const hours = parseInt(timeParts[0], 10);
    const minutes = timeParts[1] || '00';
    
    if (isNaN(hours) || hours < 0 || hours > 23) {
      return timeStr;
    }
    
    // Convert to 12-hour format
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const displayMinutes = minutes.padStart(2, '0');
    
    return `${displayHours}:${displayMinutes} ${period}`;
  } catch {
    return timeStr;
  }
}

class EmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  /**
   * Add standard email headers and reply-to for better deliverability
   * @param {Object} mailOptions - The mail options object
   * @returns {Object} Enhanced mail options with headers
   */
  addEmailHeaders(mailOptions) {
    return {
      ...mailOptions,
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'hey@koott.com',
      headers: {
        'Message-ID': `<${Date.now()}-${Math.random().toString(36).substring(7)}@koott.com>`,
        'X-Mailer': 'Koott Platform',
        'List-Unsubscribe': process.env.EMAIL_UNSUBSCRIBE_URL || `<mailto:unsubscribe@koott.com>`,
        ...(mailOptions.headers || {})
      }
    };
  }

  async initializeTransporter() {
    try {
      const emailUser = process.env.EMAIL_USER;
      const emailPassword = process.env.EMAIL_PASSWORD;
      const emailService = process.env.EMAIL_SERVICE || 'gmail';
      const smtpHost = process.env.SMTP_HOST;
      const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : null;
      const smtpSecure = process.env.SMTP_SECURE === 'true';

      // Check if it's a Google Workspace account (domain is not @gmail.com)
      const isGoogleWorkspace = emailUser && !emailUser.endsWith('@gmail.com') && emailUser.includes('@');
      const workspaceDomain = isGoogleWorkspace ? emailUser.split('@')[1] : null;

      if (!emailUser || !emailPassword) {
        throw new Error('EMAIL_USER and EMAIL_PASSWORD must be set in environment variables');
      }

      // Configure email transporter
      let transporterConfig;

      if (smtpHost) {
        // Custom SMTP configuration (for Google Workspace or other providers)
        transporterConfig = {
          host: smtpHost,
          port: smtpPort || 587,
          secure: smtpSecure || false, // true for 465, false for other ports
          auth: {
            user: emailUser,
            pass: emailPassword
          },
          tls: {
            rejectUnauthorized: false // For self-signed certificates (use with caution)
          }
        };
        
        if (isGoogleWorkspace) {
          console.log(`📧 Configuring email for Google Workspace: ${workspaceDomain}`);
          console.log(`   SMTP Host: ${smtpHost}`);
          console.log(`   SMTP Port: ${smtpPort || 587}`);
        }
      } else if (isGoogleWorkspace) {
        // Google Workspace with default Gmail SMTP settings
        transporterConfig = {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false, // true for 465, false for other ports
          auth: {
            user: emailUser,
            pass: emailPassword
          },
          tls: {
            rejectUnauthorized: false
          }
        };
        console.log(`📧 Configuring email for Google Workspace: ${workspaceDomain}`);
        console.log(`   Using default Gmail SMTP (smtp.gmail.com:587)`);
        console.log(`   Note: You may need to use an App Password if 2FA is enabled`);
      } else {
        // Regular Gmail account
        transporterConfig = {
          service: 'gmail',
          auth: {
            user: emailUser,
            pass: emailPassword
          }
        };
        console.log(`📧 Configuring email for Gmail account`);
      }

      this.transporter = nodemailer.createTransport(transporterConfig);

      // Verify connection
      await this.transporter.verify();
      console.log('✅ Email service initialized successfully');
      
      if (isGoogleWorkspace) {
        console.log(`   ✅ Google Workspace account verified: ${emailUser}`);
      }
    } catch (error) {
      if (error.code === 'EAUTH') {
        console.error('❌ Email service authentication failed:');
        const emailUser = process.env.EMAIL_USER || 'not set';
        const isWorkspace = emailUser && !emailUser.endsWith('@gmail.com') && emailUser.includes('@');
        
        if (isWorkspace) {
          console.error(`   Google Workspace account: ${emailUser}`);
          console.error('   For Google Workspace:');
          console.error('   1. Ensure 2-Step Verification is enabled');
          console.error('   2. Generate an App Password at: https://myaccount.google.com/apppasswords');
          console.error('   3. Use the App Password (16 characters) as EMAIL_PASSWORD');
          console.error('   4. Or configure custom SMTP with SMTP_HOST, SMTP_PORT in .env');
        } else {
          console.error('   Gmail credentials are invalid or missing.');
          console.error('   For Gmail with 2FA, you MUST use an App Password (not your regular password).');
          console.error('   Generate one at: https://myaccount.google.com/apppasswords');
        }
        console.error('   Set EMAIL_USER and EMAIL_PASSWORD in your .env file.');
      } else {
        console.error('❌ Email service initialization failed:', error.message);
      }
      // Continue without email service - emails will fail silently
      this.transporter = null;
    }
  }

  async sendSessionConfirmation(sessionData) {
    try {
      console.log('📧 Email Service - Starting session confirmation email...');
      console.log('📧 Email Service - Session data:', {
        sessionId: sessionData?.sessionId || sessionData?.id || sessionData?.session_id,
        date: sessionData?.sessionDate || sessionData?.scheduledDate || sessionData?.scheduled_date,
        time: sessionData?.sessionTime || sessionData?.scheduledTime || sessionData?.scheduled_time,
        status: sessionData?.status,
        psychologistId: sessionData?.psychologistId || sessionData?.psychologist_id,
        clientId: sessionData?.clientId || sessionData?.client_id
      });
      
      const {
        clientName,
        psychologistName,
        clientEmail,
        psychologistEmail,
        scheduledDate,
        scheduledTime,
        googleMeetLink,
        sessionId,
        sessionDate,
        sessionTime,
        meetLink,
        price,
        amount, // Also accept 'amount' as alias for 'price'
        status,
        psychologistId,
        clientId,
        packageInfo, // Package information: { totalSessions, completedSessions, remainingSessions, packageType }
        receiptId, // Receipt ID for generating download URL
        receiptPdfBuffer, // PDF buffer to attach to email
        googleCalendarEventId: googleCalendarEventIdRaw,
        google_calendar_event_id,
        tempPassword // New account password if applicable
      } = sessionData;

      const googleCalendarEventId = googleCalendarEventIdRaw || google_calendar_event_id;
      // When Calendar API already created the event + sent invites, skip .ics + "Add to calendar" links
      // so users do not get duplicate events on top of the official Google invite.
      const calendarFromGoogleApi = Boolean(googleCalendarEventId);

      // Use consistent date/time format
      const finalSessionDate = sessionDate || scheduledDate;
      const finalSessionTime = sessionTime || scheduledTime;
      const finalMeetLink = meetLink || googleMeetLink;
      // Use nullish coalescing to properly handle 0 as a valid price (for already-paid package sessions)
      const finalPrice = price ?? amount; // Use 'price' if provided (including 0), otherwise use 'amount'
      // Format price for display (convert to number if string, then format with commas)
      const formattedPrice = finalPrice ? (typeof finalPrice === 'number' ? finalPrice.toLocaleString('en-IN') : Number(finalPrice).toLocaleString('en-IN')) : null;
      
      console.log('📧 Email Service - Final values:', {
        clientName,
        psychologistName,
        clientEmail,
        psychologistEmail,
        finalSessionDate,
        finalSessionTime,
        finalMeetLink,
        sessionId,
        price: finalPrice,
        status,
        psychologistId,
        clientId
      });
      
      // Check if transporter is available
      if (!this.transporter) {
        console.error('📧 Email Service - Transporter not initialized');
        throw new Error('Email service not properly initialized');
      }
      
      // Format date (without year) - for display in email
      const sessionDateObj = new Date(`${finalSessionDate}T00:00:00`);
      const formattedDate = sessionDateObj.toLocaleDateString('en-IN', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
      
      // Format date as "Mon, 12 Jan 2026" for email template
      const formattedDateShort = sessionDateObj.toLocaleDateString('en-IN', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
      
      // Format time directly (no timezone conversion - time is already in IST)
      const formattedTime = formatTimeFromString(finalSessionTime);

      const durationMinutes = resolveSessionDurationMinutes(sessionData);

      // Generate calendar invites
      const { createCalendarInvites, generateGoogleCalendarLink, generateOutlookCalendarLink } = require('./calendarInviteGenerator');
      
      const calendarData = {
        sessionId: sessionId || 'unknown',
        clientName,
        psychologistName,
        sessionDate: finalSessionDate,
        sessionTime: finalSessionTime,
        meetLink: finalMeetLink,
        clientEmail,
        psychologistEmail,
        price: finalPrice || 0,
        duration: durationMinutes
      };

      let calendarInvites = { client: null, psychologist: null };
      let googleCalendarLink = null;
      let outlookCalendarLink = null;
      if (!calendarFromGoogleApi) {
        calendarInvites = createCalendarInvites(calendarData);
        googleCalendarLink = generateGoogleCalendarLink(calendarData);
        outlookCalendarLink = generateOutlookCalendarLink(calendarData);
      }

      // Generate receipt filename for attachment
      let receiptFileName = 'Receipt.pdf';
      if (receiptPdfBuffer && clientName) {
        const sanitizedName = clientName
          .trim()
          .replace(/\s+/g, '-')
          .replace(/[^a-zA-Z0-9\-_]/g, '')
          .substring(0, 50);
        receiptFileName = `${sanitizedName || 'Receipt'}.pdf`;
      } else if (receiptPdfBuffer && sessionData.receiptNumber) {
        receiptFileName = `Receipt-${sessionData.receiptNumber}.pdf`;
      }

      // Send email to client
      if (clientEmail && !clientEmail.includes('placeholder')) {
        console.log('📧 Sending email to client:', clientEmail);
        await this.sendClientConfirmation({
          to: clientEmail,
          clientName,
          psychologistName,
          scheduledDate: formattedDateShort, // Use short format for email template
          scheduledTime: formattedTime,
          googleMeetLink: finalMeetLink,
          calendarInvite: calendarInvites.client,
          googleCalendarLink,
          outlookCalendarLink,
          price: finalPrice || 0,
          receiptPdfBuffer: receiptPdfBuffer || null, // Receipt PDF buffer to attach (not used anymore)
          receiptFileName: receiptFileName, // Receipt filename for attachment (not used anymore)
          packageInfo: packageInfo || null, // Package information
          durationMinutes,
          tempPassword: tempPassword || null // Pass it through
        });
      } else {
        console.log('⚠️ Skipping client email (placeholder or missing):', clientEmail);
      }

      // Send email to psychologist
      if (psychologistEmail && !psychologistEmail.includes('placeholder')) {
        console.log('📧 Sending email to psychologist:', psychologistEmail);
        await this.sendPsychologistConfirmation({
          to: psychologistEmail,
          clientName,
          psychologistName,
          scheduledDate: formattedDate,
          scheduledTime: formattedTime,
          googleMeetLink: finalMeetLink,
          sessionId,
          calendarInvite: calendarInvites.psychologist,
          googleCalendarLink,
          outlookCalendarLink,
          calendarFromGoogleApi,
          price: finalPrice || 0,
          packageInfo: packageInfo || null, // Package information
          durationMinutes
        });
      } else {
        console.log('⚠️ Skipping psychologist email (placeholder or missing):', psychologistEmail);
      }

      // Send email to company admin
      const adminRecipients = process.env.COMPANY_ADMIN_EMAIL;
      if (adminRecipients) {
        await this.sendAdminNotification({
          to: adminRecipients,
          clientName,
          psychologistName,
          scheduledDate: formattedDate,
          scheduledTime: formattedTime,
          sessionId: sessionId || sessionData?.sessionId || sessionData?.id || sessionData?.session_id,
          clientId: clientId || sessionData?.clientId || sessionData?.client_id,
          packageId: packageInfo?.packageId || packageInfo?.id || sessionData?.packageId || sessionData?.package_id,
          packageInfo: packageInfo || null,
          price: finalPrice ?? sessionData?.price ?? sessionData?.amount
        });
      }

      return true;
    } catch (error) {
      console.error('Error sending session confirmation emails:', error);
      return false;
    }
  }

  async sendClientConfirmation(emailData) {
    const { 
      to, 
      clientName, 
      psychologistName, 
      scheduledDate, 
      scheduledTime, 
      googleMeetLink, 
      calendarInvite,
      googleCalendarLink,
      outlookCalendarLink,
      price,
      receiptPdfBuffer,
      receiptFileName,
      packageInfo,
      durationMinutes = 50,
      tempPassword = null
    } = emailData;

    // TEMPORARY: credential block disabled during website redesign — set to true when ready to re-enable
    const showCredentials = false; // TODO: change to !!tempPassword when redesign is done

    // Get logo URL - use favicon for email compatibility
    const frontendUrl = PRODUCTION_SITE_URL;
    const logoUrl = `${PRODUCTION_SITE_URL}/logo.png`;
    
    // Contact information
    const contactEmail = 'hey@koott.com';
    const contactPhone = '+91-9539007766';

    // Extract first name from clientName (empty string if unknown — greeting will just say "Hey,")
    const firstName = clientName ? clientName.split(' ')[0] : '';

    // scheduledDate is already in short format "Mon, 12 Jan 2026" from sendSessionConfirmation
    const formattedDateShort = scheduledDate;
    
    // Package line for display
    let packageLine = '';
    if (packageInfo && packageInfo.totalSessions) {
      const total = packageInfo.totalSessions || 0;
      const completed = packageInfo.completedSessions || 0;
      const booked = Math.min(total, completed + 1);
      const left = Math.max(total - booked, 0);
      packageLine = `• Specialist: ${psychologistName} (Session ${booked} of ${total})<br>`;
    } else {
      packageLine = `• Specialist: ${psychologistName}<br>`;
    }

    // Format price for display
    const formattedPrice = price ? (typeof price === 'number' ? price.toLocaleString('en-IN') : Number(price).toLocaleString('en-IN')) : null;

    // Receipt link (always show, no PDF attachment)
    const receiptLink = `${frontendUrl}/profile/receipts`;

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
      to: to,
      subject: `Koott Booking Confirmed | ${psychologistName.replace(/^Dr\.?\s*/i, '').trim()} | ${scheduledDate.replace(/,?\s*\d{4}$/, '').trim()}`,
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          ${DARK_MODE_STYLES}
        </head>
        <body class="email-bg" style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #ffffff;">
          <table role="presentation" class="email-bg" style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
            <tr>
              <td align="center" style="padding: 20px 10px;">
                <table role="presentation" class="email-card" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);">
                  <!-- Header Image -->
                  <tr>
                    <td style="padding: 0;">
                      <img src="${CLIENT_EMAIL_HEADER_URL}" alt="Koott" style="width: 100%; max-width: 600px; height: auto; display: block;">
                    </td>
                  </tr>

                  <!-- Main Content -->
                  <tr>
                    <td class="content-td" style="padding: 40px 30px; background-color: #ffffff;">
                      <h2 class="greeting" style="color: #1a202c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Hey${firstName ? ` ${firstName}` : ''},</h2>

                      <p class="body-text" style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
                        Your session with <strong>Koott</strong> is scheduled.
                      </p>

                      ${showCredentials && tempPassword ? `
                      <!-- Account Credentials Section -->
                      <div class="reminder-box" style="background-color: #f3fff3; background-image: linear-gradient(to bottom, #f3fff3, #d4ffd4); padding: 30px; border-radius: 12px; margin-bottom: 30px;">
                        <h3 class="reminder-title" style="color: #064e3b; margin: 0 0 10px 0; font-size: 16px; font-weight: 700;">Your Account is Ready!</h3>
                        <p class="reminder-title" style="color: #064e3b; font-size: 14px; margin: 0 0 15px 0;">We have created an account for you to manage your sessions.</p>
                        <div style="background: rgba(255, 255, 255, 0.6); padding: 15px; border-radius: 8px;">
                          <p class="reminder-title" style="margin: 0; font-size: 14px; color: #064e3b;"><strong>Email:</strong> ${to}</p>
                          <p class="reminder-title" style="margin: 5px 0 0 0; font-size: 14px; color: #064e3b;"><strong>Password:</strong> ${tempPassword}</p>
                        </div>
                        <p class="reminder-title" style="color: #15803d; font-size: 12px; margin: 10px 0 0 0;">You can change your password after logging in.</p>
                      </div>
                      ` : ''}

                      <p class="body-text" style="color: #4a5568; font-size: 16px; font-weight: 500; margin: 0 0 20px 0;">Here are the details:</p>

                      <!-- Session Details -->
                      <div class="detail-text" style="color: #4a5568; font-size: 16px; line-height: 2; margin: 0 0 30px 0;">
                        ${packageLine}
                        • Date: ${formattedDateShort}<br>
                        • Time: ${scheduledTime} (IST)<br>
                        • Duration: ${durationMinutes} min<br>
                        ${formattedPrice ? `• Price: ₹${formattedPrice}` : ''}
                      </div>

                      ${googleMeetLink ? `
                      <!-- Join Session Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <a href="${googleMeetLink}" target="_blank" style="display: inline-block; background-color: #189e4f; color: #ffffff; padding: 16px 40px; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 18px; margin-bottom: 20px;">
                              Join Your Session
                            </a>
                            <p class="body-text" style="color: #4a5568; font-size: 15px; margin: 0; line-height: 1.5;">
                              Or join using this link: <a href="${googleMeetLink}" class="detail-link" style="color: #189e4f; text-decoration: none;">${googleMeetLink}</a>
                            </p>
                          </td>
                        </tr>
                      </table>
                      ` : ''}

                      <!-- Calendar & WhatsApp Buttons -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 40px 0;">
                        <tr>
                          <td>
                            ${googleCalendarLink ? `
                            <a href="${googleCalendarLink}" target="_blank" class="btn-pill" style="display: inline-block; border: 1.5px solid #189e4f; color: #189e4f; padding: 12px 24px; text-decoration: none; border-radius: 100px; font-weight: 600; font-size: 14px; margin-right: 12px; margin-bottom: 12px;">
                              <img src="https://img.icons8.com/ios-filled/100/189e4f/calendar.png" alt="" style="width: 18px; height: 18px; vertical-align: middle; margin-right: 8px;"> Add to Google Calendar
                            </a>
                            ` : ''}
                            <a href="https://wa.me/918606040400" target="_blank" class="btn-pill" style="display: inline-block; border: 1.5px solid #189e4f; color: #189e4f; padding: 12px 24px; text-decoration: none; border-radius: 100px; font-weight: 600; font-size: 14px; margin-bottom: 12px;">
                              <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/120px-WhatsApp.svg.png" alt="" style="width: 18px; height: 18px; vertical-align: middle; margin-right: 8px;"> WhatsApp Us
                            </a>
                          </td>
                        </tr>
                      </table>

                      <!-- Reminders -->
                      <div class="reminder-box" style="background-color: #f3fff3; background-image: linear-gradient(to bottom, #f3fff3, #d4ffd4); padding: 30px; border-radius: 12px; margin-bottom: 40px;">
                        <h3 class="reminder-title" style="color: #064e3b; margin: 0 0 20px 0; font-size: 20px; font-weight: 700;">Reminders</h3>
                        <ul class="reminder-list" style="color: #064e3b; font-size: 15px; line-height: 1.8; margin: 0; padding-left: 20px;">
                          <li style="margin-bottom: 8px;">Please join the session 10 minutes before the scheduled time</li>
                          <li style="margin-bottom: 8px;">Ensure you have a stable internet connection</li>
                          <li style="margin-bottom: 8px;">Find a quiet, private space for your session</li>
                          <li>Have any relevant documents or notes ready</li>
                        </ul>
                      </div>
                    </td>
                  </tr>

                  <!-- Footer -->
                  <tr>
                    <td style="background-color: #012f23; padding: 40px 30px; color: #ffffff;">
                      <p style="margin: 0 0 15px 0; font-size: 14px; line-height: 1.6; color: #e5e7eb;">We're looking forward to seeing you at the scheduled time.</p>
                      <p style="margin: 0 0 25px 0; font-size: 14px; line-height: 1.6; color: #e5e7eb;">
                        If you have any questions, don't hesitate to get in touch with us at<br>
                        <a href="mailto:care@koott.in" style="color: #ffffff; text-decoration: none;">care@koott.in</a>, via WhatsApp or call us at +91 8606040400
                      </p>
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td style="font-size: 14px; color: #9ca3af;">കൂട്ടിനുണ്ട് കൂട്ട്</td>
                          <td align="right" style="font-size: 14px; color: #9ca3af;">Koott Care Pvt. Ltd.</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      attachments: calendarInvite ? [{
        filename: calendarInvite.filename,
        content: calendarInvite.content,
        contentType: calendarInvite.contentType,
        contentDisposition: 'attachment'
      }] : []
    };

    return this.transporter.sendMail(mailOptions);
  }

  async sendPsychologistConfirmation(emailData) {
    const {
      to,
      clientName,
      psychologistName,
      scheduledDate,
      scheduledTime,
      googleMeetLink,
      sessionId,
      calendarInvite,
      googleCalendarLink,
      outlookCalendarLink,
      calendarFromGoogleApi = false,
      packageInfo,
      durationMinutes = 50
    } = emailData;

    const firstName = psychologistName ? psychologistName.replace(/^Dr\.?\s*/i, '').split(' ')[0] : 'there';

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
      to: to,
      subject: `Koott Booking Confirmed${clientName ? ` | ${clientName}` : ''} | ${scheduledDate.replace(/,?\s*\d{4}$/, '').trim()}`,
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          ${DARK_MODE_STYLES}
        </head>
        <body class="email-bg" style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #ffffff;">
          <table role="presentation" class="email-bg" style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
            <tr>
              <td align="center" style="padding: 20px 10px;">
                <table role="presentation" class="email-card" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);">
                  <!-- Header Image -->
                  <tr>
                    <td style="padding: 0;">
                      <img src="${THERAPIST_EMAIL_HEADER_URL}" alt="Koott" style="width: 100%; max-width: 600px; height: auto; display: block;">
                    </td>
                  </tr>

                  <!-- Main Content -->
                  <tr>
                    <td class="content-td" style="padding: 40px 30px; background-color: #ffffff;">
                      <h2 class="greeting" style="color: #1a202c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Hey${firstName ? ` ${firstName}` : ''},</h2>

                      <p class="body-text" style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
                        A new session has been scheduled with you on <strong>Koott</strong>.
                      </p>

                      <p class="body-text" style="color: #4a5568; font-size: 16px; font-weight: 500; margin: 0 0 20px 0;">Here are the details:</p>

                      <!-- Session Details -->
                      <div class="detail-text" style="color: #4a5568; font-size: 16px; line-height: 2; margin: 0 0 30px 0;">
                        • Client: ${clientName}<br>
                        • Date: ${scheduledDate}<br>
                        • Time: ${scheduledTime} (IST)<br>
                        • Duration: ${durationMinutes} min<br>
                        ${packageInfo && packageInfo.totalSessions ? `• Session: ${Math.min((packageInfo.completedSessions || 0) + 1, packageInfo.totalSessions)} of ${packageInfo.totalSessions} (package)<br>` : ''}
                      </div>

                      ${googleMeetLink ? `
                      <!-- Join Session -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <a href="${googleMeetLink}" target="_blank" style="display: inline-block; background-color: #189e4f; color: #ffffff; padding: 16px 40px; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 18px; margin-bottom: 20px;">
                              Join Your Session
                            </a>
                            <p class="body-text" style="color: #4a5568; font-size: 15px; margin: 0; line-height: 1.5;">
                              Or join using this link: <a href="${googleMeetLink}" class="detail-link" style="color: #189e4f; text-decoration: none;">${googleMeetLink}</a>
                            </p>
                          </td>
                        </tr>
                      </table>
                      ` : `
                      <!-- Meet link not created -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td class="warn-box" style="padding: 16px; background: #fef3c7; border-radius: 8px; border: 1px solid #f59e0b;">
                            <p class="warn-text" style="color: #92400e; font-size: 14px; margin: 0;">
                              Google Meet link could not be created. Please contact our support at care@koott.in.
                            </p>
                          </td>
                        </tr>
                      </table>
                      `}

                      <!-- Calendar Buttons (no WhatsApp) -->
                      ${calendarFromGoogleApi ? `
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 40px 0;">
                        <tr>
                          <td class="cal-info-box" style="padding: 14px 16px; background: #eef2ff; border-radius: 8px; border: 1px solid #c7d2fe;">
                            <p class="cal-info-text" style="color: #3730a3; font-size: 14px; margin: 0; line-height: 1.5;">
                              <strong>Calendar:</strong> This session is already on your Google Calendar (you are the host). Use the Join button above — do not add the event again from this email.
                            </p>
                          </td>
                        </tr>
                      </table>
                      ` : googleCalendarLink ? `
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 40px 0;">
                        <tr>
                          <td>
                            <a href="${googleCalendarLink}" target="_blank" class="btn-pill" style="display: inline-block; border: 1.5px solid #189e4f; color: #189e4f; padding: 12px 24px; text-decoration: none; border-radius: 100px; font-weight: 600; font-size: 14px; margin-bottom: 12px;">
                              <img src="https://img.icons8.com/ios-filled/100/189e4f/calendar.png" alt="" style="width: 18px; height: 18px; vertical-align: middle; margin-right: 8px;"> Add to Google Calendar
                            </a>
                          </td>
                        </tr>
                      </table>
                      ` : ''}

                      <!-- Reminders -->
                      <div class="reminder-box" style="background-color: #f3fff3; background-image: linear-gradient(to bottom, #f3fff3, #d4ffd4); padding: 30px; border-radius: 12px; margin-bottom: 40px;">
                        <h3 class="reminder-title" style="color: #064e3b; margin: 0 0 20px 0; font-size: 20px; font-weight: 700;">Session Preparation</h3>
                        <ul class="reminder-list" style="color: #064e3b; font-size: 15px; line-height: 1.8; margin: 0; padding-left: 20px;">
                          <li style="margin-bottom: 8px;">Review client information and previous session notes</li>
                          <li style="margin-bottom: 8px;">Prepare any relevant materials or resources</li>
                          <li style="margin-bottom: 8px;">Ensure your workspace is professional and private</li>
                          <li>Test your audio and video equipment before the session</li>
                        </ul>
                      </div>
                    </td>
                  </tr>

                  <!-- Footer -->
                  <tr>
                    <td style="background-color: #012f23; padding: 40px 30px; color: #ffffff;">
                      <p style="margin: 0 0 15px 0; font-size: 14px; line-height: 1.6; color: #e5e7eb;">Please be available 5 minutes before the scheduled time.</p>
                      <p style="margin: 0 0 25px 0; font-size: 14px; line-height: 1.6; color: #e5e7eb;">
                        If you have any questions, don't hesitate to get in touch with us at<br>
                        <a href="mailto:care@koott.in" style="color: #ffffff; text-decoration: none;">care@koott.in</a>, via WhatsApp or call us at +91 8606040400
                      </p>
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td style="font-size: 14px; color: #9ca3af;">കൂട്ടിനുണ്ട് കൂട്ട്</td>
                          <td align="right" style="font-size: 14px; color: #9ca3af;">Koott Care Pvt. Ltd.</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      attachments: calendarInvite ? [{
        filename: calendarInvite.filename,
        content: calendarInvite.content,
        contentType: calendarInvite.contentType
      }] : []
    };

    return this.transporter.sendMail(mailOptions);
  }

  async sendAdminNotification(emailData) {
    const { to, clientName, psychologistName, scheduledDate, scheduledTime, sessionId, clientId, packageId, packageInfo, price, isFreeAssessment, assessmentNumber } = emailData;
    const contactEmail = 'hey@koott.com';
    const contactPhone = '+91-9539007766';

    // Session type and price for admin (free assessment, single, or package)
    let sessionTypeLabel;
    let priceLabel;
    let subject;
    let introMessage;
    if (isFreeAssessment) {
      sessionTypeLabel = assessmentNumber ? `Free assessment – Assessment ${assessmentNumber} of 3` : 'Free assessment';
      priceLabel = 'Free';
      subject = `New Free Assessment Booked - ${scheduledDate} at ${scheduledTime}`;
      introMessage = 'A new free assessment session has been booked on the platform. Here are the details:';
    } else {
      const totalSessions = packageInfo?.totalSessions || 0;
      const isPackage = totalSessions > 1;
      const completedSessions = packageInfo?.completedSessions ?? 0;
      const currentSessionNumber = totalSessions ? Math.min((completedSessions || 0) + 1, totalSessions) : 1;
      sessionTypeLabel = isPackage
        ? `Package – Session ${currentSessionNumber} of ${totalSessions}`
        : 'Single session';
      const priceNum = price != null && price !== '' ? Number(price) : null;
      priceLabel = priceNum != null && !Number.isNaN(priceNum) ? `₹${Number(priceNum).toLocaleString('en-IN')}` : '—';
      subject = `New Session Booked - ${scheduledDate} at ${scheduledTime}`;
      introMessage = 'A new therapy session has been booked on the platform. Here are the details:';
    }

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
      to: to,
      subject,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
            <tr>
              <td style="padding: 20px 10px;">
                <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header with Logo -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">New Session Booked</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 30px 20px;">
                      <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Admin Notification</h2>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">${introMessage}</p>
                      
                      <!-- Session Details Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #3d985c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Session Details</h3>
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Session type:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${sessionTypeLabel}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Price:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${priceLabel}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Date:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${scheduledDate}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Time:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${scheduledTime} (IST)</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Client:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${clientName}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Therapist:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${psychologistName}</td>
                              </tr>
                              ${sessionId ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Session ID:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-family: monospace;">${sessionId}</td>
                              </tr>
                              ` : ''}
                              ${clientId ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Client ID:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-family: monospace;">${clientId}</td>
                              </tr>
                              ` : ''}
                              ${packageId ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Package ID:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-family: monospace;">${packageId}</td>
                              </tr>
                              ` : ''}
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Action Required -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Action Required</h3>
                            <ul style="color: #4a5568; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
                              <li>Verify session details in the admin panel</li>
                              <li>Ensure therapist availability is confirmed</li>
                              <li>Check if any special accommodations are needed</li>
                              <li>Monitor session completion and follow-up</li>
                            </ul>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Footer Text -->
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">This session has been automatically added to the Google Calendar and all parties have been notified.</p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3d985c;">Koott Platform</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is an automated notification from the Koott therapy platform.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    };

    return this.transporter.sendMail(mailOptions);
  }

  /**
   * Send reschedule request notification to admin
   * Called when a client requests reschedule that requires admin approval (within 24h or 2nd+ reschedule)
   */
  async sendRescheduleRequestNotification(emailData) {
    const {
      to,
      clientName,
      psychologistName,
      fromDate,
      fromTime,
      toDate,
      toTime,
      sessionId,
      clientId,
      psychologistId,
      reasonText
    } = emailData;

    const contactEmail = 'hey@koott.com';
    const contactPhone = '+91-9539007766';

    // Format date for display (e.g. "Mon, 12 Jan 2026")
    const formatDateShort = (dateStr) => {
      if (!dateStr) return 'N/A';
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

    const formattedFromDate = formatDateShort(fromDate);
    const formattedToDate = formatDateShort(toDate);
    const formattedFromTime = formatTimeFromString(fromTime);
    const formattedToTime = formatTimeFromString(toTime);

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
      to: to,
      subject: `Reschedule Request - ${clientName} (${formattedFromDate} → ${formattedToDate})`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
            <tr>
              <td style="padding: 20px 10px;">
                <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header with Logo -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Reschedule Request</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 30px 20px;">
                      <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Admin Notification</h2>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">A client has requested to reschedule their session. This request requires admin approval. Please review and take action in the admin dashboard.</p>
                      
                      <!-- Reschedule Details Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #3d985c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Reschedule Details</h3>
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Client:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${clientName}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Therapist:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${psychologistName}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">From:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${formattedFromDate} at ${formattedFromTime}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">To:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${formattedToDate} at ${formattedToTime}</td>
                              </tr>
                              ${sessionId ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Session ID:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-family: monospace;">${sessionId}</td>
                              </tr>
                              ` : ''}
                              ${clientId ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Client ID:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-family: monospace;">${clientId}</td>
                              </tr>
                              ` : ''}
                              ${psychologistId ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Psychologist ID:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-family: monospace;">${psychologistId}</td>
                              </tr>
                              ` : ''}
                              ${reasonText ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Reason:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${reasonText}</td>
                              </tr>
                              ` : ''}
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Action Required -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Action Required</h3>
                            <ul style="color: #4a5568; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
                              <li>Log in to the admin dashboard</li>
                              <li>Go to Rescheduling page to review this request</li>
                              <li>Approve or decline the reschedule request</li>
                              <li>Client and therapist will be notified of your decision</li>
                            </ul>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Footer Text -->
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">This is an automated notification. Please take action as soon as possible.</p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3d985c;">Koott Platform</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is an automated notification from the Koott therapy platform.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    };

    return this.transporter.sendMail(mailOptions);
  }

  /**
   * Send new user registration notification to admin
   * Called when a new user (client or psychologist) creates an account
   */
  async sendNewUserRegistrationNotification(emailData) {
    const {
      to,
      email,
      role,
      firstName,
      lastName,
      phone,
      childName,
      childAge,
      userId,
      clientId,
      createdAt
    } = emailData;

    const contactEmail = 'hey@koott.com';
    const contactPhone = '+91-9539007766';

    const roleLabel = role === 'client' ? 'Client' : role === 'psychologist' ? 'Psychologist' : role || 'User';
    // Build display name: first+last, then child name (for client), then email so admin always sees an identifier
    let fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (!fullName && role === 'client' && childName) fullName = `Child: ${childName}`;
    if (!fullName) fullName = email || '—';

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
      to: to,
      subject: `New ${roleLabel} Registered - ${fullName || email}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
            <tr>
              <td style="padding: 20px 10px;">
                <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header with Logo -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">New User Registered</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 30px 20px;">
                      <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Admin Notification</h2>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">A new ${roleLabel.toLowerCase()} has created an account on the platform. Here are the details:</p>
                      
                      <!-- User Details Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #3d985c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">User Details</h3>
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Role:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${roleLabel}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Email:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${email || '—'}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Name:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${fullName}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Phone:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${phone || '—'}</td>
                              </tr>
                              ${role === 'client' && (childName || childAge) ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Child Name:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${childName || '—'}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Child Age:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${childAge != null ? childAge + ' years' : '—'}</td>
                              </tr>
                              ` : ''}
                              ${userId ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">User ID:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-family: monospace;">${userId}</td>
                              </tr>
                              ` : ''}
                              ${clientId ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Client ID:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-family: monospace;">${clientId}</td>
                              </tr>
                              ` : ''}
                              ${createdAt ? `
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Registered at:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${new Date(createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</td>
                              </tr>
                              ` : ''}
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Footer Text -->
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">You can view and manage users in the admin dashboard.</p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3d985c;">Koott Platform</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is an automated notification from the Koott therapy platform.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    };

    return this.transporter.sendMail(mailOptions);
  }

  async sendRescheduleNotification(sessionData, oldDate, oldTime) {
    try {
      const {
        clientName,
        psychologistName,
        clientEmail,
        psychologistEmail,
        scheduledDate,
        scheduledTime,
        sessionId,
        meetLink,
        isFreeAssessment = false,
        durationMinutes: rescheduleDurationFromPayload
      } = sessionData;

      // Format dates as "Mon, 12 Jan 2026" for email
      const formatDateShort = (dateStr) => {
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

      const formattedOldDate = formatDateShort(oldDate);
      const formattedNewDate = formatDateShort(scheduledDate);
      
      // Format time to 12-hour format with IST
      const formatTimeForEmail = (timeStr) => {
        if (!timeStr) return '';
        try {
          const [h, m] = timeStr.split(':');
          const hours = parseInt(h, 10);
          const minutes = parseInt(m || '0', 10);
          const period = hours >= 12 ? 'PM' : 'AM';
          const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
          const displayMinutes = minutes.toString().padStart(2, '0');
          return `${displayHours}:${displayMinutes} ${period} (IST)`;
        } catch {
          return timeStr;
        }
      };

      const formattedOldTime = formatTimeForEmail(oldTime);
      const formattedNewTime = formatTimeForEmail(scheduledTime);

      // Generate calendar links for the new session
      let googleCalendarLink = null;
      let outlookCalendarLink = null;
      const rescheduleCalendarMinutes = isFreeAssessment
        ? 20
        : typeof rescheduleDurationFromPayload === 'number' &&
            Number.isFinite(rescheduleDurationFromPayload) &&
            rescheduleDurationFromPayload > 0
          ? Math.round(rescheduleDurationFromPayload)
          : 50;

      if (meetLink && scheduledDate && scheduledTime) {
        try {
          const { generateGoogleCalendarLink, generateOutlookCalendarLink } = require('./calendarInviteGenerator');
          const calendarData = {
            clientName: clientName || 'Client',
            psychologistName: psychologistName || 'Specialist',
            sessionDate: scheduledDate,
            sessionTime: scheduledTime,
            meetLink: meetLink,
            duration: rescheduleCalendarMinutes
          };
          googleCalendarLink = generateGoogleCalendarLink(calendarData);
          outlookCalendarLink = generateOutlookCalendarLink(calendarData);
        } catch (calendarError) {
          console.warn('⚠️ Failed to generate calendar links for reschedule email:', calendarError);
          // Continue without calendar links
        }
      }

      // Send reschedule notifications
      if (clientEmail) {
        await this.sendRescheduleEmail({
          to: clientEmail,
          name: clientName,
          oldDate: formattedOldDate,
          oldTime: formattedOldTime,
          newDate: formattedNewDate,
          newTime: formattedNewTime,
          sessionId,
          meetLink,
          type: 'client',
          isFreeAssessment,
          googleCalendarLink,
          outlookCalendarLink,
          psychologistName
        });
      }

      if (psychologistEmail) {
        await this.sendRescheduleEmail({
          to: psychologistEmail,
          name: psychologistName,
          oldDate: formattedOldDate,
          oldTime: formattedOldTime,
          newDate: formattedNewDate,
          newTime: formattedNewTime,
          sessionId,
          meetLink,
          type: 'psychologist',
          isFreeAssessment,
          googleCalendarLink,
          outlookCalendarLink,
          psychologistName
        });
      }

      return true;
    } catch (error) {
      console.error('Error sending reschedule notifications:', error);
      return false;
    }
  }

  async sendRescheduleEmail(emailData) {
    const { to, name, oldDate, oldTime, newDate, newTime, sessionId, meetLink, type, isFreeAssessment = false, googleCalendarLink, outlookCalendarLink, psychologistName } = emailData;
    const sessionType = isFreeAssessment ? 'free assessment' : 'therapy session';
    const sessionTypeTitle = isFreeAssessment ? 'Free Assessment' : 'Therapy Session';

    const contactEmail = 'hey@koott.com';
    const contactPhone = '+91-9539007766';

    // Get logo URL - use favicon for email compatibility
    const frontendUrl = PRODUCTION_SITE_URL;
    const logoUrl = `${PRODUCTION_SITE_URL}/logo.png`;

    // Extract first name from name (empty string if unknown — greeting will just say "Hey,")
    const firstName = name ? name.split(' ')[0] : '';

    // Format dates as "Mon, 12 Jan 2026"
    const formatDateShort = (dateStr) => {
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

    // Format time to 12-hour format with IST
    const formatTimeForEmail = (timeStr) => {
      if (!timeStr) return '';
      try {
        const [h, m] = timeStr.split(':');
        const hours = parseInt(h, 10);
        const minutes = parseInt(m || '0', 10);
        const period = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
        const displayMinutes = minutes.toString().padStart(2, '0');
        return `${displayHours}:${displayMinutes} ${period} (IST)`;
      } catch {
        return timeStr;
      }
    };

    const formattedOldDate = formatDateShort(oldDate);
    const formattedNewDate = formatDateShort(newDate);
    const formattedOldTime = formatTimeForEmail(oldTime);
    const formattedNewTime = formatTimeForEmail(newTime);

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
      to: to,
      subject: `Session Rescheduled - ${newDate} at ${newTime}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
            <tr>
              <td style="padding: 20px 10px;">
                <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header with Logo -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${logoUrl}" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Session Rescheduled</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 40px 30px;">
                      <p style="color: #1a202c; margin: 0 0 20px 0; font-size: 18px; font-weight: 500;">Hey${firstName ? ` ${firstName}` : ''},</p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
                        Your session with <span style="font-style: italic; color: #3d985c; font-weight: 600;">Koott</span> has been rescheduled.
                      </p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">Here are the updated details:</p>
                      
                      <!-- Session Details -->
                      <div style="color: #4a5568; font-size: 15px; line-height: 1.8; margin: 0 0 30px 0;">
                        •⁠  ⁠Old: ${formattedOldDate}, ${formattedOldTime}<br>
                        •⁠  ⁠New: ${formattedNewDate}, ${formattedNewTime}<br>
                        ${psychologistName ? `•⁠  ⁠Specialist: ${psychologistName}<br>` : ''}
                      </div>
                      
                      ${meetLink ? `
                      <!-- Join Session Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center;">
                            <a href="${meetLink}" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 15px;">
                              Join Your Session
                            </a>
                            <p style="color: #4a5568; font-size: 13px; margin: 15px 0 0 0; word-break: break-all;">
                              Or copy this link: <a href="${meetLink}" style="color: #3d985c; text-decoration: underline;">${meetLink}</a>
                            </p>
                          </td>
                        </tr>
                      </table>
                      ` : `
                      <!-- Meet link not created - Support message -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center; background: #fef3c7; border-radius: 8px; border: 1px solid #f59e0b;">
                            <p style="color: #92400e; font-size: 14px; margin: 0; padding: 16px;">
                              Due to some issue Google Meet didn't get created. Please contact our support.
                            </p>
                          </td>
                        </tr>
                      </table>
                      `}
                      
                      ${googleCalendarLink || outlookCalendarLink ? `
                      <!-- Add to Calendar Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center;">
                            ${googleCalendarLink ? `
                            <a href="${googleCalendarLink}" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: 600; font-size: 14px;">
                              Add to Google Calendar
                            </a>
                            ` : ''}
                            ${outlookCalendarLink ? `
                            <a href="${outlookCalendarLink}" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: 600; font-size: 14px;">
                              Add to Outlook
                            </a>
                            ` : ''}
                          </td>
                        </tr>
                      </table>
                      ` : ''}
                      
                      <!-- Important Reminders -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Reminders</h3>
                            <ul style="color: #4a5568; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
                              <li>Please join the session 10 minutes before the scheduled time</li>
                              <li>Ensure you have a stable internet connection</li>
                              <li>Find a quiet, private space for your session</li>
                              <li>Have any relevant documents or notes ready</li>
                            </ul>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Footer Text -->
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0; text-align: center;">We're looking forward to seeing you on the scheduled time</p>
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; text-align: center;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or ${contactPhone}</p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3d985c;">The <span style="font-style: italic; color: #3d985c;">Koott</span> Team</strong>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    };

    return this.transporter.sendMail(mailOptions);
  }

  async sendFreeAssessmentConfirmation(assessmentData) {
    try {
      const {
        clientName,
        psychologistName,
        assessmentDate,
        assessmentTime,
        assessmentNumber,
        clientEmail,
        psychologistEmail,
        googleMeetLink,
        assessmentId,
        clientId
      } = assessmentData;

      // Parse date and time in IST (UTC+5:30)
      // Format date (without year)
      const assessmentDateObj = new Date(`${assessmentDate}T00:00:00`);
      const formattedDate = assessmentDateObj.toLocaleDateString('en-IN', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
      // Format time directly (no timezone conversion - time is already in IST)
      const formattedTime = formatTimeFromString(assessmentTime);

      // Send email to client
      if (clientEmail && !clientEmail.includes('placeholder')) {
        console.log('📧 Sending free assessment confirmation to client:', clientEmail);
        await this.sendClientFreeAssessmentConfirmation({
          to: clientEmail,
          clientName,
          psychologistName,
          assessmentDate: formattedDate,
          assessmentTime: formattedTime,
          assessmentNumber,
          googleMeetLink
        });
      }

      // Send email to psychologist
      if (psychologistEmail && !psychologistEmail.includes('placeholder')) {
        console.log('📧 Sending free assessment notification to psychologist:', psychologistEmail);
        await this.sendPsychologistFreeAssessmentNotification({
          to: psychologistEmail,
          clientName,
          psychologistName,
          assessmentDate: formattedDate,
          assessmentTime: formattedTime,
          assessmentNumber,
          googleMeetLink
        });
      }

      // Send same admin email to COMPANY_ADMIN_EMAIL and meet.koott@gmail.com
      const adminEmail = process.env.COMPANY_ADMIN_EMAIL;
      const meetKoottEmail = 'meet.koott@gmail.com';
      const adminRecipients = [adminEmail, meetKoottEmail].filter(Boolean).join(', ');
      if (adminRecipients) {
        await this.sendAdminNotification({
          to: adminRecipients,
          clientName,
          psychologistName,
          scheduledDate: formattedDate,
          scheduledTime: formattedTime,
          sessionId: assessmentId || null,
          clientId: clientId || null,
          packageId: null,
          packageInfo: null,
          price: null,
          isFreeAssessment: true,
          assessmentNumber: assessmentNumber || null
        });
      }

      return true;
    } catch (error) {
      console.error('Error sending free assessment confirmation:', error);
      return false;
    }
  }

  async sendClientFreeAssessmentConfirmation(emailData) {
    const { to, clientName, psychologistName, assessmentDate, assessmentTime, assessmentNumber, googleMeetLink } = emailData;
    const contactEmail = 'hey@koott.com';
    const contactPhone = '+91-9539007766';
    const totalAssessments = 3;
    const remainingAssessments = totalAssessments - assessmentNumber;

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
      to: to,
      subject: `Free Assessment Confirmed - ${assessmentDate} at ${assessmentTime}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
            <tr>
              <td style="padding: 20px 10px;">
                <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header with Logo -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Free Assessment Confirmed!</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 30px 20px;">
                      <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Hello ${clientName},</h2>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">Your free assessment session has been successfully scheduled. Here are the details:</p>
                      
                      <!-- Assessment Details Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #3d985c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Assessment Details</h3>
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Assessment Number:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${assessmentNumber} of ${totalAssessments}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Date:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${assessmentDate}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Time:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${assessmentTime}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Duration:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">20 minutes</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Therapist:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${psychologistName}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Type:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">Free Assessment Session</td>
                              </tr>
                              <tr>
                                <td colspan="2" style="padding: 15px 0 8px 0;">
                                  <p style="margin: 0; color: #3d985c; font-weight: 600; font-size: 14px;">You have ${remainingAssessments} free assessment${remainingAssessments !== 1 ? 's' : ''} remaining</p>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      ${googleMeetLink ? `
                      <!-- Google Meet Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Join Your Session</h3>
                            <p style="color: #4a5568; font-size: 14px; margin: 0 0 20px 0;">Click the button below to join your Google Meet session:</p>
                            <a href="${googleMeetLink}" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 15px;">
                              Join Google Meet
                            </a>
                            <p style="color: #4a5568; font-size: 12px; margin: 15px 0 0 0; word-break: break-all;">
                              Or copy this link: <a href="${googleMeetLink}" style="color: #3d985c; text-decoration: underline;">${googleMeetLink}</a>
                            </p>
                          </td>
                        </tr>
                      </table>
                      ` : `
                      <!-- Meet link not created - Support message -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center; background: #fef3c7; border-radius: 8px; border: 1px solid #f59e0b;">
                            <p style="color: #92400e; font-size: 14px; margin: 0; padding: 16px;">
                              Due to some issue Google Meet didn't get created. Please contact our support.
                            </p>
                          </td>
                        </tr>
                      </table>
                      `}
                      
                      <!-- Important Reminders -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Important Reminders</h3>
                            <ul style="color: #4a5568; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
                              <li>Please join the session 5 minutes before the scheduled time</li>
                              <li>Ensure you have a stable internet connection</li>
                              <li>Find a quiet, private space for your session</li>
                              <li>This is a free assessment session - no payment required</li>
                            </ul>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Footer Text -->
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">We look forward to meeting you and supporting you on your wellness journey!</p>
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a></p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3d985c;">The Koott Team</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is your free assessment session. No payment is required.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      text: `
Free Assessment Confirmed!

Hello ${clientName},

Your free assessment session has been successfully booked!

Assessment Details:
- Assessment Number: ${assessmentNumber} of ${totalAssessments}
- Date: ${assessmentDate}
- Time: ${assessmentTime}
- Duration: 20 minutes
- Therapist: ${psychologistName}
- Type: Free Assessment Session

Join Your Session:
Your session will be conducted online via Google Meet.

Meeting Link: ${googleMeetLink || 'Will be provided closer to session time'}

Important Notes:
- Please join the meeting 5 minutes before your scheduled time
- Ensure you have a stable internet connection
- Find a quiet, private space for your session
- This is a free assessment session - no payment required
- You have ${remainingAssessments} free assessment${remainingAssessments !== 1 ? 's' : ''} remaining

If you need to cancel or reschedule, please contact us at least 24 hours in advance at hey@koott.com or +91-9539007766.

We look forward to meeting you!

Best regards,
The Koott Team
      `
    };

    return this.transporter.sendMail(mailOptions);
  }

  async sendPsychologistFreeAssessmentNotification(emailData) {
    const { to, clientName, psychologistName, assessmentDate, assessmentTime, assessmentNumber, googleMeetLink } = emailData;
    const contactEmail = 'hey@koott.com';
    const contactPhone = '+91-9539007766';

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
      to: to,
      subject: `Free Assessment Scheduled - ${assessmentDate} at ${assessmentTime}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
            <tr>
              <td style="padding: 20px 10px;">
                <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header with Logo -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Free Assessment Scheduled</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 30px 20px;">
                      <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Hello ${psychologistName},</h2>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">A free assessment session has been scheduled with you. Here are the details:</p>
                      
                      <!-- Assessment Details Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #3d985c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Assessment Details</h3>
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Client Name:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${clientName}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Assessment Number:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${assessmentNumber} of 3</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Date:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${assessmentDate}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Time:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${assessmentTime}${assessmentTime && !assessmentTime.includes('(IST)') ? ' (IST)' : ''}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Duration:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">20 minutes</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Type:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">Free Assessment Session</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      ${googleMeetLink ? `
                      <!-- Google Meet Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Join Your Session</h3>
                            <p style="color: #4a5568; font-size: 14px; margin: 0 0 20px 0;">Click the button below to join your Google Meet session:</p>
                            <a href="${googleMeetLink}" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 15px;">
                              Join Google Meet
                            </a>
                            <p style="color: #4a5568; font-size: 12px; margin: 15px 0 0 0; word-break: break-all;">
                              Or copy this link: <a href="${googleMeetLink}" style="color: #3d985c; text-decoration: underline;">${googleMeetLink}</a>
                            </p>
                          </td>
                        </tr>
                      </table>
                      ` : `
                      <!-- Meet link not created - Support message -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center; background: #fef3c7; border-radius: 8px; border: 1px solid #f59e0b;">
                            <p style="color: #92400e; font-size: 14px; margin: 0; padding: 16px;">
                              Due to some issue Google Meet didn't get created. Please contact our support.
                            </p>
                          </td>
                        </tr>
                      </table>
                      `}
                      
                      <!-- Important Reminders -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Important Notes</h3>
                            <ul style="color: #4a5568; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
                              <li>This is a free assessment session - no payment involved</li>
                              <li>Please join the meeting 5 minutes before the scheduled time</li>
                              <li>Focus on understanding the client's needs and concerns</li>
                              <li>Provide recommendations for future therapy sessions if appropriate</li>
                              <li>Session duration is 20 minutes</li>
                            </ul>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Footer Text -->
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">Please ensure you're available at the scheduled time.</p>
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a></p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3d985c;">The Koott Team</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is a free assessment session. Please provide quality care.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    };

    return this.transporter.sendMail(mailOptions);
  }

  // Send session completion notification to client
  // Generic email sending function
  async sendEmail({ to, subject, html, text }) {
    try {
      if (!this.transporter) {
        throw new Error('Email service not initialized');
      }

      const mailOptions = {
        from: {
          name: 'Koott',
          address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
        },
        replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
        to: to,
        subject: subject,
        html: html,
        text: text
      };

      return await this.transporter.sendMail(this.addEmailHeaders(mailOptions));
    } catch (error) {
      console.error('Error sending email:', error);
      throw error;
    }
  }

  async sendCancellationNotification({
    to,
    clientName,
    psychologistName,
    sessionDate,
    sessionTime,
    sessionId,
    isPsychologist = false
  }) {
    try {
      // Format date (without year)
      const sessionDateObj = new Date(`${sessionDate}T00:00:00`);
      const formattedDate = sessionDateObj.toLocaleDateString('en-IN', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
      // Format time directly (no timezone conversion - time is already in IST)
      const formattedTime = formatTimeFromString(sessionTime);

      const recipientName = isPsychologist ? psychologistName : clientName;
      const otherParty = isPsychologist ? clientName : psychologistName;
      const contactEmail = 'hey@koott.com';
      const contactPhone = '+91-9539007766';

      const mailOptions = {
        from: {
          name: 'Koott',
          address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
        },
        replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
        to: to,
        subject: 'Session Cancelled',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
            <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
              <tr>
                <td style="padding: 20px 10px;">
                  <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <!-- Header with Logo -->
                    <tr>
                      <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                          <tr>
                            <td align="center" style="padding-bottom: 15px;">
                              <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                            </td>
                          </tr>
                          <tr>
                            <td align="center">
                              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Session Cancelled</h1>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                    <!-- Main Content -->
                    <tr>
                      <td style="padding: 30px 20px;">
                        <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Hello ${recipientName},</h2>
                        
                        <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">Your therapy session with <strong>${otherParty}</strong> has been cancelled.</p>
                        
                        <!-- Cancelled Session Details -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0;">
                              <h3 style="color: #3d985c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Cancelled Session Details</h3>
                              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Date:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${formattedDate}</td>
                                </tr>
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Time:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${formattedTime}</td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                        </table>
                        
                        ${!isPsychologist ? `
                        <!-- Reschedule Section -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0;">
                              <p style="color: #234e52; font-size: 14px; line-height: 1.8; margin: 0; padding: 15px; background-color: #e6fffa; border-left: 4px solid #81e6d9; border-radius: 4px;">
                                <strong>📅 Need to reschedule?</strong><br>
                                You can book a new session anytime from your profile dashboard.
                              </p>
                            </td>
                          </tr>
                        </table>
                        
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0; text-align: center;">
                              <a href="${PRODUCTION_SITE_URL}/profile" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
                                Book New Session
                              </a>
                            </td>
                          </tr>
                        </table>
                        ` : ''}
                        
                        <!-- Footer Text -->
                        <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a></p>
                        
                        <p style="color: #2d3748; font-size: 15px; margin: 0;">
                          Best regards,<br>
                          <strong style="color: #3d985c;">The Koott Team</strong>
                        </p>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                        <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                          This is an automated message. Please do not reply to this email.<br>
                          If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a>
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
          </html>
        `
      };

      return await this.transporter.sendMail(mailOptions);
    } catch (error) {
      console.error('Error sending cancellation notification:', error);
      throw error;
    }
  }

  async sendNoShowNotification({
    to,
    clientName,
    psychologistName,
    sessionDate,
    sessionTime,
    sessionId
  }) {
    try {
      // Format date (without year)
      const sessionDateObj = new Date(`${sessionDate}T00:00:00`);
      const formattedDate = sessionDateObj.toLocaleDateString('en-IN', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
      // Format time directly (no timezone conversion - time is already in IST)
      const formattedTime = formatTimeFromString(sessionTime);
      const contactEmail = 'hey@koott.com';
      const contactPhone = '+91-9539007766';

      const mailOptions = {
        from: {
          name: 'Koott',
          address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
        },
        replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
        to: to,
        subject: 'No-Show Notice - Session Missed',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
            <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
              <tr>
                <td style="padding: 20px 10px;">
                  <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <!-- Header with Logo -->
                    <tr>
                      <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                          <tr>
                            <td align="center" style="padding-bottom: 15px;">
                              <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                            </td>
                          </tr>
                          <tr>
                            <td align="center">
                              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">⚠️ No-Show Notice</h1>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                    <!-- Main Content -->
                    <tr>
                      <td style="padding: 30px 20px;">
                        <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Hello ${clientName},</h2>
                        
                        <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">We noticed that you didn't attend your scheduled therapy session with <strong>${psychologistName}</strong>.</p>
                        
                        <!-- Missed Session Details -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0;">
                              <h3 style="color: #3d985c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Missed Session Details</h3>
                              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Date:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${formattedDate}</td>
                                </tr>
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Time:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${formattedTime}</td>
                                </tr>
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Psychologist:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${psychologistName}</td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                        </table>
                        
                        <!-- Need Help Section -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0;">
                              <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">📞 Need Help?</h3>
                              <p style="color: #856404; font-size: 14px; line-height: 1.8; margin: 0 0 10px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                                <strong>Let us know the reason or contact our team to reschedule:</strong>
                              </p>
                              <ul style="color: #856404; font-size: 14px; line-height: 1.8; margin: 10px 0 0 0; padding-left: 20px;">
                                <li>📧 Email: <a href="mailto:${contactEmail}" style="color: #856404; text-decoration: none;">${contactEmail}</a></li>
                                <li>📱 WhatsApp: <a href="https://wa.me/919539007766" style="color: #856404; text-decoration: none;">${contactPhone}</a></li>
                                <li>💬 Book a new session from your profile</li>
                              </ul>
                            </td>
                          </tr>
                        </table>
                        
                        <!-- Reschedule Button -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0; text-align: center;">
                              <a href="${PRODUCTION_SITE_URL}/profile" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
                                Reschedule Session
                              </a>
                            </td>
                          </tr>
                        </table>
                        
                        <!-- Footer Text -->
                        <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">We're here to help you reschedule or address any concerns. Don't hesitate to reach out!</p>
                        
                        <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a></p>
                        
                        <p style="color: #2d3748; font-size: 15px; margin: 0;">
                          Best regards,<br>
                          <strong style="color: #3d985c;">The Koott Team</strong>
                        </p>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                        <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                          This is an automated message. Please do not reply to this email.<br>
                          If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a>
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
          </html>
        `
      };

      return await this.transporter.sendMail(mailOptions);
    } catch (error) {
      console.error('Error sending no-show notification:', error);
      throw error;
    }
  }

  async sendSessionCompletionNotification({
    clientName,
    childName,
    psychologistName,
    sessionDate,
    sessionTime,
    clientEmail
  }) {
    try {
      const contactEmail = 'hey@koott.com';
      const contactPhone = '+91-9539007766';

      const mailOptions = {
        from: {
          name: 'Koott',
          address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
        },
        replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'care@koott.in',
        to: clientEmail,
        subject: 'Session Completed - Summary & Report Available',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
            <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
              <tr>
                <td style="padding: 20px 10px;">
                  <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <!-- Header with Logo -->
                    <tr>
                      <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                          <tr>
                            <td align="center" style="padding-bottom: 15px;">
                              <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                            </td>
                          </tr>
                          <tr>
                            <td align="center">
                              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Session Completed</h1>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                    <!-- Main Content -->
                    <tr>
                      <td style="padding: 30px 20px;">
                        <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Hello ${clientName},</h2>
                        
                        <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">Great news! Your therapy session with <strong>${psychologistName}</strong> has been completed.</p>
                        
                        <!-- Session Details -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0;">
                              <h3 style="color: #3d985c; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Session Details</h3>
                              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Child:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${childName}</td>
                                </tr>
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Date:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${sessionDate}</td>
                                </tr>
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Time:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${sessionTime}</td>
                                </tr>
                                <tr>
                                  <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Psychologist:</strong></td>
                                  <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${psychologistName}</td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                        </table>
                        
                        <!-- Footer Text -->
                        <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">Your psychologist has provided a detailed summary and report of the session. You can now view these in your profile.</p>
                        
                        <!-- View Report Button -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0; text-align: center;">
                              <a href="${PRODUCTION_SITE_URL}/profile" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
                                View Session Summary & Report
                              </a>
                            </td>
                          </tr>
                        </table>
                        
                        <!-- What You'll Find -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                          <tr>
                            <td style="padding: 0 0 20px 0;">
                              <p style="color: #234e52; font-size: 14px; line-height: 1.8; margin: 0; padding: 15px; background-color: #e6fffa; border-left: 4px solid #81e6d9; border-radius: 4px;">
                                <strong>📋 What you'll find:</strong><br>
                                • Session summary with key points<br>
                                • Detailed report with findings and recommendations<br>
                                • Next steps for continued care
                              </p>
                            </td>
                          </tr>
                        </table>
                        
                        <!-- Footer Text -->
                        <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions about the session or need to schedule a follow-up, please contact us at <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a></p>
                        
                        <p style="color: #2d3748; font-size: 15px; margin: 0;">
                          Best regards,<br>
                          <strong style="color: #3d985c;">The Koott Team</strong>
                        </p>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                        <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                          This is an automated message. Please do not reply to this email.<br>
                          If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3d985c; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3d985c; text-decoration: none;">${contactPhone}</a>
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
          </html>
        `
      };

      return this.transporter.sendMail(mailOptions);
    } catch (error) {
      console.error('Error sending session completion notification:', error);
      throw error;
    }
  }

  async sendEventRegistrationConfirmation({ to, fullName, eventTitle, sessionJoinUrl }) {
    if (!this.transporter) {
      console.warn('Email service not available - skipping event registration email');
      return { ok: false, skipped: true };
    }

    const safeName = String(fullName || 'there');
    const safeTitle = String(eventTitle || 'your event');
    const safeJoin = String(sessionJoinUrl || '').trim();
    const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER || process.env.COMPANY_ADMIN_EMAIL;

    if (!fromEmail || !to) {
      console.warn('Missing sender or recipient for event registration email');
      return { ok: false, skipped: true };
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
          <tr>
            <td style="padding: 20px 10px;">
              <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                      <tr>
                        <td align="center" style="padding-bottom: 15px;">
                          <img src="${PRODUCTION_SITE_URL}/logo.png" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                        </td>
                      </tr>
                      <tr>
                        <td align="center">
                          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Registration Confirmed</h1>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding: 30px 20px;">
                    <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Hi ${safeName},</h2>
                    <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                      Thanks for registering for <strong>${safeTitle}</strong>. Your spot is reserved.
                    </p>

                    <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 24px 0;">
                      <tr>
                        <td style="padding: 16px; background: #f8f5ff; border: 1px solid #e9ddff; border-radius: 10px;">
                          <p style="margin: 0 0 8px 0; color: #3d985c; font-size: 15px; font-weight: 700;">Event</p>
                          <p style="margin: 0; color: #2d3748; font-size: 15px;">${safeTitle}</p>
                        </td>
                      </tr>
                    </table>

                    ${
                      safeJoin
                        ? `
                    <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 24px 0;">
                      <tr>
                        <td style="padding: 0 0 12px 0;">
                          <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.6;">
                            Your session join link:
                          </p>
                        </td>
                      </tr>
                      <tr>
                        <td style="text-align: center;">
                          <a href="${safeJoin}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
                            Join Session
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top: 12px;">
                          <p style="margin: 0; color: #718096; font-size: 13px; word-break: break-all;">${safeJoin}</p>
                        </td>
                      </tr>
                    </table>
                        `
                        : `
                    <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 24px 0;">
                      We will share your session link shortly.
                    </p>
                        `
                    }

                    <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0;">
                      You will also receive the same details on WhatsApp.
                    </p>
                    <p style="color: #2d3748; font-size: 15px; margin: 18px 0 0 0;">
                      — <strong style="color: #3d985c;">The Koott Team</strong>
                    </p>
                  </td>
                </tr>

                <tr>
                  <td style="background: #f7fafc; padding: 22px 24px; text-align: center; border-top: 1px solid #e2e8f0;">
                    <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                      This is an automated message. Please do not reply to this email.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const mailOptions = this.addEmailHeaders({
      from: fromEmail,
      to,
      subject: `You're registered — ${safeTitle}`,
      html
    });

    await this.transporter.sendMail(mailOptions);
    return { ok: true };
  }

  /**
   * Send welcome email to new clients with their temporary credentials.
   * @param {{ to: string, clientName: string, tempPassword: string, loginUrl: string }} emailData
   */
  async sendWelcomeEmail(emailData) {
    const { to, clientName, tempPassword, loginUrl } = emailData;
    
    const logoUrl = `${PRODUCTION_SITE_URL}/logo.png`;
    const firstName = clientName ? clientName.split(' ')[0] : '';

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: 'hey@koott.com',
      to: to,
      subject: 'Welcome to Koott - Your Account Details',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
            <tr>
              <td style="padding: 20px 10px;">
                <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header with Logo -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${logoUrl}" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Welcome to Koott</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 40px 30px;">
                      <p style="color: #1a202c; margin: 0 0 20px 0; font-size: 18px; font-weight: 500;">Hey${firstName ? ` ${firstName}` : ''},</p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
                        We're thrilled to have you join <span style="font-style: italic; color: #3d985c; font-weight: 600;">Koott</span>. Your account has been created successfully.
                      </p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">You can access your dashboard using the credentials below:</p>
                      
                      <!-- Credentials Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <tr>
                          <td style="padding: 24px;">
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 14px; width: 100px;">Email:</td>
                                <td style="padding: 8px 0; color: #1e293b; font-size: 15px; font-weight: 600;">${to}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Password:</td>
                                <td style="padding: 8px 0; color: #1e293b; font-size: 15px; font-weight: 600; font-family: monospace; letter-spacing: 0.5px;">${tempPassword}</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Login Button -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="text-align: center;">
                            <a href="${loginUrl}" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                              Log In to Your Dashboard
                            </a>
                          </td>
                        </tr>
                      </table>

                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 30px 0; font-style: italic;">
                        Note: For security reasons, we recommend changing your password after your first login.
                      </p>
                      
                      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 0 0 30px 0;" />

                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
                        At Koott, we're committed to providing the best support for your child's well-being. Our platform allows you to:
                      </p>
                      
                      <ul style="color: #4a5568; font-size: 14px; line-height: 1.8; margin: 0 0 30px 0; padding-left: 20px;">
                        <li>Book and manage therapy sessions</li>
                        <li>Access session summaries and reports</li>
                        <li>Communicate with your specialists</li>
                        <li>Track your progress over time</li>
                      </ul>
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:hey@koott.com" style="color: #3d985c; text-decoration: none;">hey@koott.com</a> or +91-9539007766</p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3d985c;">The <span style="font-style: italic; color: #3d985c;">Koott</span> Team</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 12px; margin: 0; line-height: 1.6;">
                        © ${new Date().getFullYear()} Koott. All rights reserved.<br>
                        This is an automated message. Please do not reply to this email.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    };

    const finalMailOptions = this.addEmailHeaders(mailOptions);
    return this.transporter.sendMail(finalMailOptions);
  }

  /**
   * Send welcome email to new psychologists with their temporary credentials.
   * @param {{ to: string, psychologistName: string, tempPassword: string, loginUrl: string }} emailData
   */
  async sendWelcomePsychologistEmail(emailData) {
    const { to, psychologistName, tempPassword, loginUrl } = emailData;
    
    const logoUrl = `${PRODUCTION_SITE_URL}/logo.png`;
    const firstName = psychologistName ? psychologistName.split(' ')[0] : 'Specialist';

    const mailOptions = {
      from: {
        name: 'Koott',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'care@koott.in'
      },
      replyTo: 'hey@koott.com',
      to: to,
      subject: 'Welcome to the Koott Team - Your Therapist Dashboard',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f7fa;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f7fa;">
            <tr>
              <td style="padding: 20px 10px;">
                <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header with Logo -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #3d985c 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${logoUrl}" alt="Koott" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Welcome to the Team</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 40px 30px;">
                      <p style="color: #1a202c; margin: 0 0 20px 0; font-size: 18px; font-weight: 500;">Hello Dr. ${firstName},</p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
                        We are delighted to have you on board with <span style="font-style: italic; color: #3d985c; font-weight: 600;">Koott</span>. Your therapist account has been set up, and you can now access your dedicated dashboard.
                      </p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">Your dashboard credentials:</p>
                      
                      <!-- Credentials Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0; background-color: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <tr>
                          <td style="padding: 24px;">
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 14px; width: 100px;">Login Email:</td>
                                <td style="padding: 8px 0; color: #1e293b; font-size: 15px; font-weight: 600;">${to}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Temp Password:</td>
                                <td style="padding: 8px 0; color: #1e293b; font-size: 15px; font-weight: 600; font-family: monospace; letter-spacing: 0.5px;">${tempPassword}</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Login Button -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="text-align: center;">
                            <a href="${loginUrl}" target="_blank" style="display: inline-block; background: #3d985c; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                              Log In to Therapist Dashboard
                            </a>
                          </td>
                        </tr>
                      </table>

                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 30px 0; font-style: italic;">
                        Please change your password immediately after your first login for security purposes.
                      </p>
                      
                      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 0 0 30px 0;" />

                      <h3 style="color: #1a202c; font-size: 18px; font-weight: 600; margin: 0 0 15px 0;">Getting Started</h3>
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
                        As a specialist on our platform, you can:
                      </p>
                      
                      <ul style="color: #4a5568; font-size: 14px; line-height: 1.8; margin: 0 0 30px 0; padding-left: 20px;">
                        <li>Manage your session schedule and availability</li>
                        <li>Access client history and intake forms</li>
                        <li>Conduct secure online therapy sessions via Google Meet</li>
                        <li>Record session summaries and track progress</li>
                      </ul>
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you need any technical assistance, please reach out to our support team at <a href="mailto:hey@koott.com" style="color: #3d985c; text-decoration: none;">hey@koott.com</a>.</p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Welcome to the family!<br>
                        <strong style="color: #3d985c;">The Koott Operations Team</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 12px; margin: 0; line-height: 1.6;">
                        © ${new Date().getFullYear()} Koott. All rights reserved.<br>
                        Confidential Specialist Communication.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    };

    const finalMailOptions = this.addEmailHeaders(mailOptions);
    return this.transporter.sendMail(finalMailOptions);
  }
}

module.exports = new EmailService();