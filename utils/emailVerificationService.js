const { supabaseAdmin } = require('../config/supabase');
const emailService = require('./emailService');
const { successResponse, errorResponse } = require('./helpers');

class EmailVerificationService {
  constructor() {
    this.OTP_LENGTH = 6;
    this.OTP_EXPIRY_MINUTES = 15;
    this.MAX_ATTEMPTS = 5;
  }

  /**
   * Generate a random 6-digit OTP
   * @returns {string} 6-digit OTP
   */
  generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Send OTP to email for verification
   * @param {string} email - Email address
   * @param {string} verificationType - Type of verification (registration, password_reset, email_change)
   * @param {string} userRole - Role of user (client, psychologist, admin)
   * @returns {Promise<Object>} Success/error response
   */
  /**
   * Mask email address for logging
   * @param {string} email - Email address
   * @returns {string} Masked email
   */
  maskEmail(email) {
    if (!email || typeof email !== 'string') {
      return '***@***';
    }
    const [localPart, domain] = email.split('@');
    if (!localPart || !domain) {
      return '***@***';
    }
    const maskedLocal = localPart.length > 2
      ? localPart[0] + '*'.repeat(Math.min(localPart.length - 2, 5)) + localPart[localPart.length - 1]
      : '*'.repeat(localPart.length);
    return `${maskedLocal}@${domain}`;
  }

  async sendOTP(email, verificationType = 'registration', userRole = 'client') {
    try {
      const maskedEmail = this.maskEmail(email);
      console.log(`📧 Sending OTP to ${maskedEmail} for ${verificationType} verification`);

      // Check if there's an active verification for this email
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: existingVerification } = await supabaseAdmin
        .from('email_verifications')
        .select('*')
        .eq('email', email)
        .eq('is_verified', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (existingVerification) {
        // Check if user has exceeded max attempts
        if (existingVerification.attempts >= this.MAX_ATTEMPTS) {
          return {
            success: false,
            message: 'Maximum verification attempts exceeded. Please try again later.',
            error: 'MAX_ATTEMPTS_EXCEEDED'
          };
        }

        // Use existing OTP if still valid
        const otp = existingVerification.otp;
        console.log(`🔄 Using existing OTP for ${email}`);
        
        // Send email with existing OTP
        await this.sendOTPEmail(email, otp, verificationType, userRole);
        
        return {
          success: true,
          message: 'OTP sent successfully',
          data: { email, expiresAt: existingVerification.expires_at }
        };
      }

      // Generate new OTP
      const otp = this.generateOTP();
      const expiresAt = new Date(Date.now() + this.OTP_EXPIRY_MINUTES * 60 * 1000);

      // Clean up any expired verifications for this email
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      await supabaseAdmin
        .from('email_verifications')
        .delete()
        .eq('email', email)
        .eq('is_verified', false)
        .lt('expires_at', new Date().toISOString());

      // Also clean up any other unverified verifications for this email to ensure uniqueness
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      await supabaseAdmin
        .from('email_verifications')
        .delete()
        .eq('email', email)
        .eq('is_verified', false);

      // Store new verification record
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: verification, error: verificationError } = await supabaseAdmin
        .from('email_verifications')
        .insert([{
          email,
          otp,
          verification_type: verificationType,
          user_role: userRole,
          expires_at: expiresAt.toISOString()
        }])
        .select('*')
        .single();

      if (verificationError) {
        console.error('Error storing verification:', verificationError);
        throw new Error('Failed to store verification record');
      }

      // Send OTP email
      await this.sendOTPEmail(email, otp, verificationType, userRole);

      console.log(`✅ OTP sent successfully to ${email}`);
      
      return {
        success: true,
        message: 'OTP sent successfully',
        data: { 
          email, 
          expiresAt: verification.expires_at,
          attempts: verification.attempts
        }
      };

    } catch (error) {
      console.error('Error sending OTP:', error);
      return {
        success: false,
        message: 'Failed to send OTP',
        error: error.message
      };
    }
  }

  /**
   * Send OTP email using the email service
   * @param {string} email - Email address
   * @param {string} otp - OTP code
   * @param {string} verificationType - Type of verification
   * @param {string} userRole - User role
   */
  async sendOTPEmail(email, otp, verificationType, userRole) {
    try {
      const subject = this.getEmailSubject(verificationType);
      const htmlContent = this.getEmailHTML(email, otp, verificationType, userRole);
      const textContent = this.getEmailText(email, otp, verificationType, userRole);

      await emailService.sendEmail({
        to: email,
        subject: subject,
        html: htmlContent,
        text: textContent
      });

      console.log(`📧 OTP email sent to ${email}`);
    } catch (error) {
      console.error('Error sending OTP email:', error);
      throw error;
    }
  }

  /**
   * Verify OTP code
   * @param {string} email - Email address
   * @param {string} otp - OTP code to verify
   * @param {string} verificationType - Type of verification
   * @returns {Promise<Object>} Verification result
   */
  async verifyOTP(email, otp, verificationType = 'registration') {
    try {
      console.log(`🔍 Verifying OTP for ${this.maskEmail(email)}`);

      // Find active verification record
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: verification, error: verificationError } = await supabaseAdmin
        .from('email_verifications')
        .select('*')
        .eq('email', email)
        .eq('verification_type', verificationType)
        .eq('is_verified', false)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (verificationError || !verification) {
        return {
          success: false,
          message: 'Invalid or expired OTP',
          error: 'INVALID_OTP'
        };
      }

      // Check if max attempts exceeded
      if (verification.attempts >= this.MAX_ATTEMPTS) {
        return {
          success: false,
          message: 'Maximum verification attempts exceeded',
          error: 'MAX_ATTEMPTS_EXCEEDED'
        };
      }

      // Increment attempts
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      await supabaseAdmin
        .from('email_verifications')
        .update({ attempts: verification.attempts + 1 })
        .eq('id', verification.id);

      // Verify OTP
      if (verification.otp !== otp) {
        return {
          success: false,
          message: 'Invalid OTP code',
          error: 'INVALID_OTP',
          attemptsLeft: this.MAX_ATTEMPTS - (verification.attempts + 1)
        };
      }

      // Mark as verified
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { error: updateError } = await supabaseAdmin
        .from('email_verifications')
        .update({ 
          is_verified: true,
          verified_at: new Date().toISOString()
        })
        .eq('id', verification.id);

      if (updateError) {
        console.error('Error updating verification:', updateError);
        throw new Error('Failed to update verification status');
      }

      console.log(`✅ Email verified successfully for ${email}`);

      return {
        success: true,
        message: 'Email verified successfully',
        data: { 
          email, 
          verifiedAt: new Date().toISOString(),
          verificationType
        }
      };

    } catch (error) {
      console.error('Error verifying OTP:', error);
      return {
        success: false,
        message: 'Failed to verify OTP',
        error: error.message
      };
    }
  }

  /**
   * Check if email is verified
   * @param {string} email - Email address
   * @param {string} verificationType - Type of verification
   * @returns {Promise<boolean>} Verification status
   */
  async isEmailVerified(email, verificationType = 'registration') {
    try {
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: verification } = await supabaseAdmin
        .from('email_verifications')
        .select('is_verified')
        .eq('email', email)
        .eq('verification_type', verificationType)
        .eq('is_verified', true)
        .single();

      return !!verification;
    } catch (error) {
      console.error('Error checking email verification:', error);
      return false;
    }
  }

  /**
   * Get email subject based on verification type
   * @param {string} verificationType - Type of verification
   * @returns {string} Email subject
   */
  getEmailSubject(verificationType) {
    const subjects = {
      'registration': 'Verify Your Email - Koott Account',
      'password_reset': 'Reset Your Password - Koott',
      'email_change': 'Verify Your New Email - Koott'
    };
    return subjects[verificationType] || 'Email Verification - Koott';
  }

  /**
   * Get HTML email content
   * @param {string} email - Email address
   * @param {string} otp - OTP code
   * @param {string} verificationType - Type of verification
   * @param {string} userRole - User role
   * @returns {string} HTML content
   */
  getEmailHTML(email, otp, verificationType, userRole) {
    const platformName = 'Koott';
    const verificationMessage = this.getVerificationMessage(verificationType, userRole);
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Email Verification - ${platformName}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
          .otp-box { background: #4F46E5; color: white; font-size: 32px; font-weight: bold; text-align: center; padding: 20px; margin: 20px 0; border-radius: 8px; letter-spacing: 8px; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .warning { background: #FEF3C7; border: 1px solid #F59E0B; padding: 15px; border-radius: 8px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${platformName}</h1>
            <p>Child Therapy Platform</p>
          </div>
          <div class="content">
            <h2>Email Verification Required</h2>
            <p>Hello,</p>
            <p>${verificationMessage}</p>
            
            <p>Please use the following verification code:</p>
            <div class="otp-box">${otp}</div>
            
            <div class="warning">
              <strong>Important:</strong>
              <ul>
                <li>This code will expire in 15 minutes</li>
                <li>You have 5 attempts to enter the correct code</li>
                <li>Do not share this code with anyone</li>
              </ul>
            </div>
            
            <p>If you didn't request this verification, please ignore this email.</p>
            
            <p>Best regards,<br>The ${platformName} Team</p>
          </div>
          <div class="footer">
            <p>This is an automated message. Please do not reply to this email.</p>
            <p>&copy; 2024 ${platformName}. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Get plain text email content
   * @param {string} email - Email address
   * @param {string} otp - OTP code
   * @param {string} verificationType - Type of verification
   * @param {string} userRole - User role
   * @returns {string} Plain text content
   */
  getEmailText(email, otp, verificationType, userRole) {
    const verificationMessage = this.getVerificationMessage(verificationType, userRole);
    
    return `
Koott - Child Therapy Platform

Email Verification Required

Hello,

${verificationMessage}

Please use the following verification code: ${otp}

Important:
- This code will expire in 15 minutes
- You have 5 attempts to enter the correct code
- Do not share this code with anyone

If you didn't request this verification, please ignore this email.

Best regards,
The Koott Team

---
This is an automated message. Please do not reply to this email.
© 2024 Koott. All rights reserved.
    `;
  }

  /**
   * Get verification message based on type and role
   * @param {string} verificationType - Type of verification
   * @param {string} userRole - User role
   * @returns {string} Verification message
   */
  getVerificationMessage(verificationType, userRole) {
    const roleText = userRole === 'psychologist' ? 'psychologist' : 'client';
    
    const messages = {
      'registration': `Thank you for registering as a ${roleText} on Koott. To complete your registration and start using our platform, please verify your email address.`,
      'password_reset': `You have requested to reset your password for your Koott account. Please verify your email to proceed with password reset.`,
      'email_change': `You have requested to change your email address for your Koott account. Please verify your new email address to complete the change.`
    };
    
    return messages[verificationType] || 'Please verify your email address to continue using Koott.';
  }

  /**
   * Clean up expired verifications (should be called periodically)
   * @returns {Promise<number>} Number of cleaned up records
   */
  async cleanupExpiredVerifications() {
    try {
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data, error } = await supabaseAdmin
        .from('email_verifications')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .select('id');

      if (error) {
        console.error('Error cleaning up expired verifications:', error);
        return 0;
      }

      console.log(`🧹 Cleaned up ${data?.length || 0} expired verification records`);
      return data?.length || 0;
    } catch (error) {
      console.error('Error in cleanup:', error);
      return 0;
    }
  }
}

module.exports = new EmailVerificationService();
