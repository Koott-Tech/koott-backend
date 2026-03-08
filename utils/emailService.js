const nodemailer = require('nodemailer');

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
      replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || 'support@littlecare.com',
      headers: {
        'Message-ID': `<${Date.now()}-${Math.random().toString(36).substring(7)}@little.care>`,
        'X-Mailer': 'LittleCare Platform',
        'List-Unsubscribe': process.env.EMAIL_UNSUBSCRIBE_URL || `<mailto:unsubscribe@littlecare.com>`,
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
        receiptPdfBuffer // PDF buffer to attach to email
      } = sessionData;

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

      // Removed verbose logging - time is formatted directly from stored value

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
        price: finalPrice || 0
      };

      const calendarInvites = createCalendarInvites(calendarData);
      const googleCalendarLink = generateGoogleCalendarLink(calendarData);
      const outlookCalendarLink = generateOutlookCalendarLink(calendarData);

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
          packageInfo: packageInfo || null // Package information
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
          price: finalPrice || 0,
          packageInfo: packageInfo || null // Package information
        });
      } else {
        console.log('⚠️ Skipping psychologist email (placeholder or missing):', psychologistEmail);
      }

      // Send email to company admin and meet.littlecare@gmail.com (same content)
      const adminEmail = process.env.COMPANY_ADMIN_EMAIL;
      const meetLittleCareEmail = 'meet.littlecare@gmail.com';
      const adminRecipients = [adminEmail, meetLittleCareEmail].filter(Boolean).join(', ');
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
      packageInfo
    } = emailData;

    // Get logo URL - use favicon for email compatibility
    // Use www.little.care as the base URL for logo (publicly accessible)
    const frontendUrl = process.env.FRONTEND_URL || process.env.RAZORPAY_SUCCESS_URL?.replace(/\/payment-success.*$/, '') || 'https://www.little.care';
    const logoUrl = `https://www.little.care/favicon.png`;
    
    // Contact information
    const contactEmail = 'hey@little.care';
    const contactPhone = '+91-9539007766';

    // Extract first name from clientName
    const firstName = clientName ? clientName.split(' ')[0] : 'there';

    // scheduledDate is already in short format "Mon, 12 Jan 2026" from sendSessionConfirmation
    const formattedDateShort = scheduledDate;
    
    // Package line for display
    let packageLine = '';
    if (packageInfo && packageInfo.totalSessions) {
      const total = packageInfo.totalSessions || 0;
      const completed = packageInfo.completedSessions || 0;
      const booked = Math.min(total, completed + 1);
      const left = Math.max(total - booked, 0);
      packageLine = `•⁠  ⁠Package: ${booked} of ${total} sessions booked, ${left} left<br>`;
    }

    // Format price for display
    const formattedPrice = price ? (typeof price === 'number' ? price.toLocaleString('en-IN') : Number(price).toLocaleString('en-IN')) : null;

    // Receipt link (always show, no PDF attachment)
    const receiptLink = `${frontendUrl}/profile/receipts`;

    const mailOptions = {
      from: {
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care',
      to: to,
      subject: `Session Confirmed - ${scheduledDate} at ${scheduledTime}`,
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
                    <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${logoUrl}" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Session Confirmed</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 40px 30px;">
                      <p style="color: #1a202c; margin: 0 0 20px 0; font-size: 18px; font-weight: 500;">Hey ${firstName},</p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
                        Your session with <span style="font-style: italic; color: #3f2e73; font-weight: 600;">Little Care</span> is scheduled.
                      </p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">Here are the details:</p>
                      
                      <!-- Session Details -->
                      <div style="color: #4a5568; font-size: 15px; line-height: 1.8; margin: 0 0 30px 0;">
                        •⁠  ⁠Specialist: ${psychologistName}<br>
                        ${packageLine}
                        •⁠  ⁠Date: ${formattedDateShort}<br>
                        •⁠  ⁠Time: ${scheduledTime} (IST)<br>
                        •⁠  ⁠Duration: 50 min<br>
                        ${formattedPrice ? `•⁠  ⁠Price: ₹${formattedPrice}<br>` : ''}
                      </div>
                      
                      ${googleMeetLink ? `
                      <!-- Join Session Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center;">
                            <a href="${googleMeetLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 15px;">
                              Join Your Session
                            </a>
                            <p style="color: #4a5568; font-size: 13px; margin: 15px 0 0 0; word-break: break-all;">
                              Or copy this link: <a href="${googleMeetLink}" style="color: #3f2e73; text-decoration: underline;">${googleMeetLink}</a>
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
                            <a href="${googleCalendarLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: 600; font-size: 14px;">
                              Add to Google Calendar
                            </a>
                            ` : ''}
                            ${outlookCalendarLink ? `
                            <a href="${outlookCalendarLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: 600; font-size: 14px;">
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
                      
                      <!-- Receipt Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center;">
                            <p style="color: #4a5568; font-size: 15px; margin: 0;">
                              Your payment receipt is ready for download, <a href="${receiptLink}" style="color: #3f2e73; text-decoration: underline; font-weight: 600;">Click Here</a>
                            </p>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Footer Text -->
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0; text-align: center;">We're looking forward to seeing you on the scheduled time</p>
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; text-align: center;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or ${contactPhone}</p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3f2e73;">The <span style="font-style: italic; color: #3f2e73;">Little Care</span> Team</strong>
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
      attachments: [
        ...(calendarInvite ? [{
          filename: calendarInvite.filename,
          content: calendarInvite.content,
          contentType: calendarInvite.contentType
        }] : [])
        // NO PDF attachment - receipt is available via link
      ]
    };

    // Override replyTo and ensure from address is noreply
    const finalMailOptions = {
      ...mailOptions,
      from: {
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care'
    };
    
    return this.transporter.sendMail(finalMailOptions);
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
      price,
      packageInfo
    } = emailData;
    
    // Format price for display (convert to number if string, then format with commas)
    const formattedPrice = price ? (typeof price === 'number' ? price.toLocaleString('en-IN') : Number(price).toLocaleString('en-IN')) : null;

    const contactEmail = 'hey@little.care';
    const contactPhone = '+91-9539007766';

    const mailOptions = {
      from: {
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care',
      to: to,
      subject: `New Session Scheduled - ${scheduledDate} at ${scheduledTime}`,
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
                    <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">New Session Scheduled</h1>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 30px 20px;">
                      <h2 style="color: #1a202c; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">Hello ${psychologistName},</h2>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">A new therapy session has been scheduled with you. Here are the details:</p>
                      
                      <!-- Session Details Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Session Details</h3>
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Date:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${scheduledDate}</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Time:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${scheduledTime} (IST)</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Duration:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">50 min</td>
                              </tr>
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Client:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${clientName}</td>
                              </tr>
                              ${packageInfo && packageInfo.totalSessions ? `
                              <tr>
                                <td colspan="2" style="padding: 15px 0 8px 0;">
                                  <p style="margin: 0; color: #3f2e73; font-weight: 600; font-size: 14px;">📦 Package Session</p>
                                  <p style="margin: 5px 0 0 0; color: #4a5568; font-size: 13px;">
                                    <strong>Progress:</strong> ${packageInfo.completedSessions || 0}/${packageInfo.totalSessions} sessions completed, ${packageInfo.remainingSessions || 0} remaining
                                  </p>
                                </td>
                              </tr>
                              ` : ''}
                              <tr>
                                <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong style="color: #2d3748;">Session Fee:</strong></td>
                                <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right; font-weight: 600;">${formattedPrice ? `₹${formattedPrice}` : 'TBD'}</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      ${googleCalendarLink || outlookCalendarLink ? `
                      <!-- Calendar Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">📅 Add to Your Calendar</h3>
                            <p style="color: #4a5568; font-size: 14px; margin: 0 0 20px 0;">Add this session to your calendar:</p>
                            <div style="text-align: center;">
                              ${googleCalendarLink ? `
                              <a href="${googleCalendarLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: 600; font-size: 14px;">
                                📅 Google Calendar
                              </a>
                              ` : ''}
                              ${outlookCalendarLink ? `
                              <a href="${outlookCalendarLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: 600; font-size: 14px;">
                                📅 Outlook
                              </a>
                              ` : ''}
                            </div>
                          </td>
                        </tr>
                      </table>
                      ` : ''}
                      
                      ${googleMeetLink ? `
                      <!-- Google Meet Section -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                        <tr>
                          <td style="padding: 0 0 20px 0; text-align: center;">
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Join Your Session</h3>
                            <p style="color: #4a5568; font-size: 14px; margin: 0 0 20px 0;">Click the button below to join your Google Meet session:</p>
                            <a href="${googleMeetLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 15px;">
                              Join Google Meet
                            </a>
                            <p style="color: #4a5568; font-size: 12px; margin: 15px 0 0 0; word-break: break-all;">
                              Or copy this link: <a href="${googleMeetLink}" style="color: #3f2e73; text-decoration: underline;">${googleMeetLink}</a>
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
                            <h3 style="color: #2d3748; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Session Preparation</h3>
                            <ul style="color: #4a5568; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
                              <li>Review client information and previous session notes</li>
                              <li>Prepare any relevant materials or resources</li>
                              <li>Ensure your workspace is professional and private</li>
                              <li>Test your audio and video equipment</li>
                            </ul>
                          </td>
                        </tr>
                      </table>
                      
                      <!-- Footer Text -->
                      <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">Please ensure you're available 5 minutes before the scheduled time to start the session.</p>
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a></p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3f2e73;">The Little Care Team</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This email confirms your scheduled therapy session. Please ensure you're prepared and on time.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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
      attachments: calendarInvite ? [
        {
          filename: calendarInvite.filename,
          content: calendarInvite.content,
          contentType: calendarInvite.contentType
        }
      ] : []
    };

    return this.transporter.sendMail(mailOptions);
  }

  async sendAdminNotification(emailData) {
    const { to, clientName, psychologistName, scheduledDate, scheduledTime, sessionId, clientId, packageId, packageInfo, price, isFreeAssessment, assessmentNumber } = emailData;
    const contactEmail = 'hey@little.care';
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
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care',
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
                    <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                            <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Session Details</h3>
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
                        <strong style="color: #3f2e73;">Little Care Platform</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is an automated notification from the Little Care therapy platform.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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
   * Send reschedule request notification to admin and meet.littlecare@gmail.com
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

    const contactEmail = 'hey@little.care';
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
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care',
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
                    <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                            <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Reschedule Details</h3>
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
                        <strong style="color: #3f2e73;">Little Care Platform</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is an automated notification from the Little Care therapy platform.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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
   * Send new user registration notification to admin and meet.littlecare@gmail.com
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

    const contactEmail = 'hey@little.care';
    const contactPhone = '+91-9539007766';

    const roleLabel = role === 'client' ? 'Client' : role === 'psychologist' ? 'Psychologist' : role || 'User';
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || '—';

    const mailOptions = {
      from: {
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care',
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
                    <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                            <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">User Details</h3>
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
                        <strong style="color: #3f2e73;">Little Care Platform</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is an automated notification from the Little Care therapy platform.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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
        isFreeAssessment = false
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
      if (meetLink && scheduledDate && scheduledTime) {
        try {
          const { generateGoogleCalendarLink, generateOutlookCalendarLink } = require('./calendarInviteGenerator');
          const calendarData = {
            clientName: clientName || 'Client',
            psychologistName: psychologistName || 'Specialist',
            sessionDate: scheduledDate,
            sessionTime: scheduledTime,
            meetLink: meetLink,
            duration: 50 // Paid session: 50 minutes
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

    const contactEmail = 'hey@little.care';
    const contactPhone = '+91-9539007766';

    // Get logo URL - use favicon for email compatibility
    const frontendUrl = process.env.FRONTEND_URL || process.env.RAZORPAY_SUCCESS_URL?.replace(/\/payment-success.*$/, '') || 'https://www.little.care';
    const logoUrl = `https://www.little.care/favicon.png`;

    // Extract first name from name
    const firstName = name ? name.split(' ')[0] : 'there';

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
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care',
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
                    <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="${logoUrl}" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                      <p style="color: #1a202c; margin: 0 0 20px 0; font-size: 18px; font-weight: 500;">Hey ${firstName},</p>
                      
                      <p style="color: #4a5568; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
                        Your session with <span style="font-style: italic; color: #3f2e73; font-weight: 600;">Little Care</span> has been rescheduled.
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
                            <a href="${meetLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 15px;">
                              Join Your Session
                            </a>
                            <p style="color: #4a5568; font-size: 13px; margin: 15px 0 0 0; word-break: break-all;">
                              Or copy this link: <a href="${meetLink}" style="color: #3f2e73; text-decoration: underline;">${meetLink}</a>
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
                            <a href="${googleCalendarLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: 600; font-size: 14px;">
                              Add to Google Calendar
                            </a>
                            ` : ''}
                            ${outlookCalendarLink ? `
                            <a href="${outlookCalendarLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: 600; font-size: 14px;">
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
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; text-align: center;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or ${contactPhone}</p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3f2e73;">The <span style="font-style: italic; color: #3f2e73;">Little Care</span> Team</strong>
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

      // Send same admin email to COMPANY_ADMIN_EMAIL and meet.littlecare@gmail.com
      const adminEmail = process.env.COMPANY_ADMIN_EMAIL;
      const meetLittleCareEmail = 'meet.littlecare@gmail.com';
      const adminRecipients = [adminEmail, meetLittleCareEmail].filter(Boolean).join(', ');
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
    const contactEmail = 'hey@little.care';
    const contactPhone = '+91-9539007766';
    const totalAssessments = 3;
    const remainingAssessments = totalAssessments - assessmentNumber;

    const mailOptions = {
      from: {
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care',
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
                    <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                            <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Assessment Details</h3>
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
                                  <p style="margin: 0; color: #3f2e73; font-weight: 600; font-size: 14px;">You have ${remainingAssessments} free assessment${remainingAssessments !== 1 ? 's' : ''} remaining</p>
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
                            <a href="${googleMeetLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 15px;">
                              Join Google Meet
                            </a>
                            <p style="color: #4a5568; font-size: 12px; margin: 15px 0 0 0; word-break: break-all;">
                              Or copy this link: <a href="${googleMeetLink}" style="color: #3f2e73; text-decoration: underline;">${googleMeetLink}</a>
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
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a></p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3f2e73;">The Little Care Team</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is your free assessment session. No payment is required.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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

If you need to cancel or reschedule, please contact us at least 24 hours in advance at hey@little.care or +91-9539007766.

We look forward to meeting you!

Best regards,
The Little Care Team
      `
    };

    return this.transporter.sendMail(mailOptions);
  }

  async sendPsychologistFreeAssessmentNotification(emailData) {
    const { to, clientName, psychologistName, assessmentDate, assessmentTime, assessmentNumber, googleMeetLink } = emailData;
    const contactEmail = 'hey@little.care';
    const contactPhone = '+91-9539007766';

    const mailOptions = {
      from: {
        name: 'LittleCare',
        address: 'noreply@little.care'
      },
      replyTo: 'noreply@little.care',
      sender: 'noreply@little.care',
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
                    <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                        <tr>
                          <td align="center" style="padding-bottom: 15px;">
                            <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                            <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Assessment Details</h3>
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
                            <a href="${googleMeetLink}" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-bottom: 15px;">
                              Join Google Meet
                            </a>
                            <p style="color: #4a5568; font-size: 12px; margin: 15px 0 0 0; word-break: break-all;">
                              Or copy this link: <a href="${googleMeetLink}" style="color: #3f2e73; text-decoration: underline;">${googleMeetLink}</a>
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
                      
                      <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a></p>
                      
                      <p style="color: #2d3748; font-size: 15px; margin: 0;">
                        Best regards,<br>
                        <strong style="color: #3f2e73;">The Little Care Team</strong>
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                      <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                        This is a free assessment session. Please provide quality care.<br>
                        If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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
          name: 'LittleCare',
          address: 'noreply@little.care'
        },
        replyTo: 'noreply@little.care',
        sender: 'noreply@little.care',
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
      const contactEmail = 'hey@little.care';
      const contactPhone = '+91-9539007766';

      const mailOptions = {
        from: {
          name: 'LittleCare',
          address: 'noreply@little.care'
        },
        replyTo: 'noreply@little.care',
        sender: 'noreply@little.care',
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
                      <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                          <tr>
                            <td align="center" style="padding-bottom: 15px;">
                              <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                              <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Cancelled Session Details</h3>
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
                              <a href="${process.env.FRONTEND_URL || 'https://littlecare.vercel.app'}/profile" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
                                Book New Session
                              </a>
                            </td>
                          </tr>
                        </table>
                        ` : ''}
                        
                        <!-- Footer Text -->
                        <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a></p>
                        
                        <p style="color: #2d3748; font-size: 15px; margin: 0;">
                          Best regards,<br>
                          <strong style="color: #3f2e73;">The Little Care Team</strong>
                        </p>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                        <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                          This is an automated message. Please do not reply to this email.<br>
                          If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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
      const contactEmail = 'hey@little.care';
      const contactPhone = '+91-9539007766';

      const mailOptions = {
        from: {
          name: 'LittleCare',
          address: 'noreply@little.care'
        },
        replyTo: 'noreply@little.care',
        sender: 'noreply@little.care',
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
                      <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                          <tr>
                            <td align="center" style="padding-bottom: 15px;">
                              <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                              <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Missed Session Details</h3>
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
                              <a href="${process.env.FRONTEND_URL || 'https://littlecare.vercel.app'}/profile" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
                                Reschedule Session
                              </a>
                            </td>
                          </tr>
                        </table>
                        
                        <!-- Footer Text -->
                        <p style="color: #4a5568; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">We're here to help you reschedule or address any concerns. Don't hesitate to reach out!</p>
                        
                        <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions, please contact us at <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a></p>
                        
                        <p style="color: #2d3748; font-size: 15px; margin: 0;">
                          Best regards,<br>
                          <strong style="color: #3f2e73;">The Little Care Team</strong>
                        </p>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                        <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                          This is an automated message. Please do not reply to this email.<br>
                          If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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
      const contactEmail = 'hey@little.care';
      const contactPhone = '+91-9539007766';

      const mailOptions = {
        from: {
          name: 'LittleCare',
          address: 'noreply@little.care'
        },
        replyTo: 'noreply@little.care',
        sender: 'noreply@little.care',
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
                      <td style="background: linear-gradient(135deg, #3f2e73 0%, #5a4a8a 100%); padding: 30px 40px; text-align: center;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
                          <tr>
                            <td align="center" style="padding-bottom: 15px;">
                              <img src="https://www.little.care/favicon.png" alt="Little Care" width="60" height="60" border="0" style="display: block; max-width: 60px; width: 60px; height: auto; margin: 0 auto;" />
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
                              <h3 style="color: #3f2e73; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Session Details</h3>
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
                              <a href="${process.env.FRONTEND_URL || 'https://littlecare.vercel.app'}/profile" target="_blank" style="display: inline-block; background: #3f2e73; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
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
                        <p style="color: #4a5568; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">If you have any questions about the session or need to schedule a follow-up, please contact us at <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a></p>
                        
                        <p style="color: #2d3748; font-size: 15px; margin: 0;">
                          Best regards,<br>
                          <strong style="color: #3f2e73;">The Little Care Team</strong>
                        </p>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="background: #f7fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0;">
                        <p style="color: #718096; font-size: 13px; margin: 0; line-height: 1.6;">
                          This is an automated message. Please do not reply to this email.<br>
                          If you have any questions, please contact <a href="mailto:${contactEmail}" style="color: #3f2e73; text-decoration: none;">${contactEmail}</a> or <a href="https://wa.me/919539007766" style="color: #3f2e73; text-decoration: none;">${contactPhone}</a>
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
}

module.exports = new EmailService();