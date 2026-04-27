/**
 * Session Creation Service
 * 
 * Provides idempotent session creation from slot locks.
 * This service is called by the Razorpay webhook after payment verification.
 * 
 * Key features:
 * - Fully idempotent (can be called multiple times safely)
 * - Prevents double booking with database constraints
 * - Handles race conditions gracefully
 */

const { supabaseAdmin } = require('../config/supabase');
const { assertClientPackageHasAvailableSlot } = require('./packageService');
const { updateSlotLockStatus } = require('./slotLockService');
const meetLinkService = require('../utils/meetLinkService');
const { getMeetEventDurationMinutes } = require('../utils/sessionMeetDuration');
const emailService = require('../utils/emailService');
const userInteractionLogger = require('../utils/userInteractionLogger');

/**
 * Create session from slot lock (idempotent)
 * 
 * @param {Object} slotLock - Slot lock record
 * @returns {Promise<Object>} { success: boolean, session?: session, error?: string, alreadyExists?: boolean }
 */
const createSessionFromSlotLock = async (slotLock) => {
  try {
    console.log('📅 Creating session from slot lock:', {
      lockId: slotLock.id,
      orderId: slotLock.order_id?.substring(0, 10) + '...',
      status: slotLock.status
    });

    // Check if session already exists for this slot lock
    // We can check by looking for a session with matching details
    const { data: existingSession, error: checkError } = await supabaseAdmin
      .from('sessions')
      .select('id, status, payment_id')
      .eq('psychologist_id', slotLock.psychologist_id)
      .eq('client_id', slotLock.client_id)
      .eq('scheduled_date', slotLock.scheduled_date)
      .eq('scheduled_time', slotLock.scheduled_time)
      .eq('status', 'booked')
      .maybeSingle();

    if (checkError) {
      console.error('❌ Error checking existing session:', checkError);
      return {
        success: false,
        error: 'Failed to check existing session',
        code: 'DB_ERROR',
        isPermanent: false
      };
    }

    if (existingSession) {
      console.log('✅ Session already exists:', {
        sessionId: existingSession.id,
        paymentId: existingSession.payment_id
      });

      // Update slot lock to SESSION_CREATED if not already
      if (slotLock.status !== 'SESSION_CREATED') {
        await updateSlotLockStatus(slotLock.order_id, 'SESSION_CREATED');
      }

      return {
        success: true,
        session: existingSession,
        alreadyExists: true
      };
    }

    // Get payment record to get amount and other details
    const { data: paymentRecord, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('id, amount, package_id, session_type, razorpay_params')
      .eq('razorpay_order_id', slotLock.order_id)
      .maybeSingle();

    if (paymentError) {
      console.error('❌ Error fetching payment record:', paymentError);
      return {
        success: false,
        error: 'Failed to fetch payment record',
        code: 'DB_ERROR',
        isPermanent: false
      };
    }

    if (!paymentRecord) {
      console.error('❌ Payment record not found for order:', slotLock.order_id);
      return {
        success: false,
        error: 'Payment record not found',
        code: 'PAYMENT_NOT_FOUND',
        isPermanent: true
      };
    }

    // Prepare session data
    const sessionData = {
      client_id: slotLock.client_id,
      psychologist_id: slotLock.psychologist_id,
      scheduled_date: slotLock.scheduled_date,
      scheduled_time: slotLock.scheduled_time,
      status: 'booked',
      price: paymentRecord.amount,
      payment_id: paymentRecord.id,
      original_scheduled_date: slotLock.scheduled_date
    };

    // Add package_id if available (not individual session)
    if (paymentRecord.package_id && paymentRecord.package_id !== 'null' && paymentRecord.package_id !== 'undefined' && paymentRecord.package_id !== 'individual') {
      sessionData.package_id = paymentRecord.package_id;
    }

    // Set session_type from payment record, or determine from package_id
    if (paymentRecord.session_type) {
      sessionData.session_type = paymentRecord.session_type;
    } else if (paymentRecord.package_id && paymentRecord.package_id !== 'null' && paymentRecord.package_id !== 'undefined' && paymentRecord.package_id !== 'individual') {
      sessionData.session_type = 'Package Session';
    } else {
      sessionData.session_type = 'Individual Session';
    }

    if (sessionData.package_id) {
      const { data: pkgForQuota, error: pkgQuotaErr } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('id', sessionData.package_id)
        .single();

      if (pkgQuotaErr || !pkgForQuota) {
        console.error('❌ Package not found for quota check (slot lock):', pkgQuotaErr);
        await updateSlotLockStatus(slotLock.order_id, 'FAILED', {
          reason: 'PACKAGE_NOT_FOUND_FOR_QUOTA',
          detail: pkgQuotaErr?.message
        });
        return {
          success: false,
          error: 'Invalid package for this booking',
          code: 'PACKAGE_NOT_FOUND_FOR_QUOTA',
          isPermanent: true
        };
      }

      const quotaCheck = await assertClientPackageHasAvailableSlot(
        supabaseAdmin,
        slotLock.client_id,
        pkgForQuota
      );
      if (!quotaCheck.ok) {
        console.error('❌ Package quota exceeded (slot lock):', quotaCheck);
        await updateSlotLockStatus(slotLock.order_id, 'FAILED', {
          reason: 'PACKAGE_QUOTA_EXCEEDED',
          detail: quotaCheck.message
        });
        return {
          success: false,
          error: quotaCheck.message,
          code: 'PACKAGE_QUOTA_EXCEEDED',
          isPermanent: true
        };
      }
    }

    // Try to create session
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (sessionError) {
      // Check if it's a unique constraint violation (double booking)
      if (sessionError.code === '23505' || sessionError.message?.includes('unique') || sessionError.message?.includes('duplicate')) {
        console.log('⚠️ Double booking detected - slot was just booked by another user');
        
        // Try to fetch the session that was just created
        const { data: conflictingSession, error: conflictError } = await supabaseAdmin
          .from('sessions')
          .select('id, client_id, payment_id')
          .eq('psychologist_id', slotLock.psychologist_id)
          .eq('scheduled_date', slotLock.scheduled_date)
          .eq('scheduled_time', slotLock.scheduled_time)
          .eq('status', 'booked')
          .maybeSingle();

        if (conflictError) {
          console.error('❌ Error checking for conflicting session:', conflictError);
          await updateSlotLockStatus(slotLock.order_id, 'FAILED', {
            reason: 'DB_ERROR',
            detail: conflictError.message
          });
          return {
            success: false,
            error: 'Database error while checking for conflicts',
            code: 'DB_ERROR',
            isPermanent: false
          };
        }

        if (conflictingSession) {
          // Check if it's our session (same client)
          if (conflictingSession.client_id === slotLock.client_id) {
            // It's our session, just created by another request (idempotent)
            console.log('✅ Session created by concurrent request (idempotent)');
            await updateSlotLockStatus(slotLock.order_id, 'SESSION_CREATED');
            return {
              success: true,
              session: conflictingSession,
              alreadyExists: true
            };
          } else {
            // Different client - real double booking
            console.error('❌ Real double booking - different client');
            await updateSlotLockStatus(slotLock.order_id, 'FAILED', {
              reason: 'Double booking - slot taken by another user'
            });
            return {
              success: false,
              error: 'This time slot was just booked by another user',
              conflict: true,
              code: 'DOUBLE_BOOKING',
              isPermanent: true
            };
          }
        }
      }

      // Check for validation errors (permanent failures)
      const isValidationError = sessionError.code === '23514' || // Check constraint violation
        sessionError.message?.toLowerCase().includes('check constraint') ||
        sessionError.message?.toLowerCase().includes('violates check');

      console.error('❌ Error creating session:', sessionError);
      return {
        success: false,
        error: 'Failed to create session',
        details: sessionError.message,
        code: isValidationError ? 'VALIDATION_ERROR' : 'SESSION_CREATION_ERROR',
        isPermanent: isValidationError
      };
    }

    console.log('✅ Session created successfully:', {
      sessionId: session.id,
      clientId: session.client_id,
      psychologistId: session.psychologist_id
    });

    // Update payment record with session_id
    const { error: paymentUpdateError } = await supabaseAdmin
      .from('payments')
      .update({ session_id: session.id })
      .eq('id', paymentRecord.id);
    
    if (paymentUpdateError) {
      console.error('❌ Error updating payment record with session_id:', paymentUpdateError, 'paymentId:', paymentRecord.id, 'sessionId:', session.id);
      // Remediation: enqueue retry or set flag for manual reconciliation (if enqueueRetryJob exists, use it)
      try {
        const { enqueueRetryJob } = require('../jobs/recoveryJob');
        if (typeof enqueueRetryJob === 'function') {
          enqueueRetryJob('payment_session_update', { payment_id: paymentRecord.id, session_id: session.id }).catch(err =>
            console.error('Failed to enqueue payment session update retry:', err)
          );
        }
      } catch (_) {
        // No retry job available; log for manual review
      }
    } else {
      console.log('✅ Payment record updated with session_id:', session.id);
    }

    // Update slot lock to SESSION_CREATED
    await updateSlotLockStatus(slotLock.order_id, 'SESSION_CREATED');

    // Log booking
    await userInteractionLogger.logBooking({
      userId: slotLock.client_id,
      userRole: 'client',
      psychologistId: slotLock.psychologist_id,
      packageId: paymentRecord.package_id,
      scheduledDate: slotLock.scheduled_date,
      scheduledTime: slotLock.scheduled_time,
      sessionId: session.id,
      paymentId: paymentRecord.id,
      status: 'success'
    });

    // Enqueue Meet link creation to job queue (async, non-blocking)
    enqueueMeetLinkCreation({
      slotLock,
      session,
      paymentRecord
    }).catch(err => {
      console.error('❌ Error enqueueing Meet link creation:', err);
      // Don't fail session creation if queue fails
    });

    return {
      success: true,
      session,
      alreadyExists: false
    };
  } catch (error) {
    console.error('❌ Exception in createSessionFromSlotLock:', error);
    // Determine if error is permanent based on error type
    const isPermanent = error.name === 'ValidationError' || 
      error.message?.toLowerCase().includes('validation') ||
      error.message?.toLowerCase().includes('invalid');
    
    return {
      success: false,
      error: error.message || 'Failed to create session',
      code: isPermanent ? 'VALIDATION_ERROR' : 'UNKNOWN_ERROR',
      isPermanent: isPermanent
    };
  }
};

/**
 * Simple in-memory job queue for Meet link creation
 * Processes jobs sequentially to avoid rate limits and ensure reliability
 */
class MeetLinkCreationQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.maxRetries = 3;
    this.retryDelay = 5000; // 5 seconds
  }

  /**
   * Add job to queue
   * @param {Object} jobData - Job data
   */
  async enqueue(jobData) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        ...jobData,
        resolve,
        reject,
        retries: 0
      });
      this.processQueue();
    });
  }

  /**
   * Process queue sequentially
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      
      try {
        await this.processJob(job);
        job.resolve();
      } catch (error) {
        // Retry logic
        if (job.retries < this.maxRetries) {
          job.retries++;
          console.log(`⚠️ Meet link creation failed, retrying (${job.retries}/${this.maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * job.retries));
          this.queue.unshift(job); // Add back to front of queue
        } else {
          console.error('❌ Meet link creation failed after max retries:', error);
          job.reject(error);
        }
      }
    }

    this.processing = false;
  }

  /**
   * Process a single job
   * @param {Object} job - Job to process
   */
  async processJob(job) {
    const { slotLock, session, paymentRecord } = job;

    // Fetch client and psychologist details for Meet link, emails, and WhatsApp
    const { data: clientDetails, error: clientError } = await supabaseAdmin
      .from('clients')
      .select(`
        id,
        first_name,
        last_name,
        child_name,
        phone_number,
        user:users(email)
      `)
      .eq('id', slotLock.client_id)
      .single();

    const { data: psychologistDetails, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email, phone, google_calendar_credentials')
      .eq('id', slotLock.psychologist_id)
      .single();

    if (clientError) {
      console.error('❌ Error fetching client details:', clientError);
      console.error('   Slot lock ID:', slotLock.id, 'Client ID:', slotLock.client_id);
      throw new Error(`Failed to fetch client details: ${clientError.message}`);
    }

    if (psychologistError) {
      console.error('❌ Error fetching psychologist details:', psychologistError);
      console.error('   Slot lock ID:', slotLock.id, 'Psychologist ID:', slotLock.psychologist_id);
      throw new Error(`Failed to fetch psychologist details: ${psychologistError.message}`);
    }

    if (!clientDetails || !psychologistDetails) {
      console.error('❌ Could not fetch client or psychologist details');
      console.error('   Client details:', clientDetails ? 'found' : 'missing');
      console.error('   Psychologist details:', psychologistDetails ? 'found' : 'missing');
      throw new Error('Client or psychologist details not found');
    }

    // Fetch package details if this is a package session
    let packageInfo = null;
    let meetDurationMinutes = 50;
    if (paymentRecord.package_id && paymentRecord.package_id !== 'null' && paymentRecord.package_id !== 'undefined' && paymentRecord.package_id !== 'individual') {
      try {
        const { data: packageData, error: packageError } = await supabaseAdmin
          .from('packages')
          .select('id, package_type, session_count')
          .eq('id', paymentRecord.package_id)
          .single();
        
        if (!packageError && packageData) {
          meetDurationMinutes = getMeetEventDurationMinutes(packageData.package_type);
          // Calculate package progress: count completed sessions for this package
          const { data: packageSessions, error: sessionsError } = await supabaseAdmin
            .from('sessions')
            .select('id, status')
            .eq('package_id', paymentRecord.package_id)
            .eq('client_id', slotLock.client_id);
          
          if (!sessionsError && packageSessions) {
            const totalSessions = packageData.session_count || 0;
            const completedSessions = packageSessions.filter(s => s.status === 'completed').length;
            const remainingSessions = Math.max(totalSessions - completedSessions, 0);
            
            packageInfo = {
              totalSessions: totalSessions,
              completedSessions: completedSessions,
              remainingSessions: remainingSessions,
              packageType: packageData.package_type || 'Package'
            };
            
            console.log('📦 Package info:', packageInfo);
          }
        }
      } catch (packageErr) {
        console.warn('⚠️ Error fetching package details:', packageErr);
      }
    }

    const { addMinutesToTime } = require('../utils/helpers');
    const endTime = addMinutesToTime(slotLock.scheduled_time, meetDurationMinutes);

    // Create Google Meet link
    // Handle client name: prefer child_name, but skip if it's "Pending" or empty
    let clientName = clientDetails.child_name;
    if (!clientName || clientName.trim() === '' || clientName.toLowerCase() === 'pending') {
      // Fall back to first_name + last_name
      const firstName = clientDetails.first_name || '';
      const lastName = clientDetails.last_name || '';
      clientName = `${firstName} ${lastName}`.trim();
      // If still empty, use a default
      if (!clientName) {
        clientName = 'Client';
      }
    }
    const psychologistName = `${psychologistDetails.first_name} ${psychologistDetails.last_name}`;

    // Normalize client email: Supabase can return user relation as object or array
    const clientEmail = Array.isArray(clientDetails.user)
      ? clientDetails.user?.[0]?.email
      : clientDetails.user?.email;

    const meetSessionData = {
      summary: `Therapy Session - ${clientName} with ${psychologistDetails.first_name}`,
      description: `Online therapy session between ${clientName} and ${psychologistName}`,
      startDate: slotLock.scheduled_date,
      startTime: slotLock.scheduled_time,
      endTime: endTime,
      clientEmail: clientEmail || null,
      psychologistEmail: psychologistDetails.email || null
    };

    // Get psychologist OAuth tokens if available
    let userAuth = null;
    if (psychologistDetails.google_calendar_credentials) {
      const credentials = psychologistDetails.google_calendar_credentials;
      userAuth = {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        expiry_date: credentials.expiry_date
      };
    }

    const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);

    if (meetResult.success && meetResult.meetLink) {
      const { error: updateError } = await supabaseAdmin
        .from('sessions')
        .update({ 
          google_meet_link: meetResult.meetLink,
          google_meet_join_url: meetResult.meetLink,
          google_meet_start_url: meetResult.meetLink,
          google_calendar_event_id: meetResult.eventId || null
        })
        .eq('id', session.id);
      
      if (updateError) {
        console.error('❌ Error updating session with meet link:', updateError);
        throw new Error(`Failed to update session with meet link: ${updateError.message}`);
      } else {
        // Log which method was used to create the Meet link
        const method = meetResult.method || 'unknown';
        const isRealLink = method !== 'fallback' && meetResult.meetLink && !meetResult.meetLink.includes('meet.google.com/new');
        const methodDescription = {
          'oauth': '✅ Real Meet link created via OAuth (psychologist calendar)',
          'oauth_calendar': '✅ Real Meet link created via OAuth (psychologist calendar)',
          'calendar_service_account': '✅ Real Meet link created via Service Account (shared calendar)',
          'service_account_limitation': '⚠️ Service account limitation - Meet link may require manual creation',
          'calendar_error': '❌ Calendar API error - using fallback',
          'fallback': '⚠️ Fallback Meet link (manual creation may be required)',
          'unknown': '❓ Meet link created (method unknown)'
        };
        
        console.log('✅ Meet link created and saved to session:', {
          meetLink: meetResult.meetLink,
          method: method,
          isRealLink: isRealLink,
          description: methodDescription[method] || methodDescription['unknown'],
          eventId: meetResult.eventId || null,
          eventLink: meetResult.eventLink || null,
          hasOAuth: !!userAuth,
          hasPsychologistCredentials: !!psychologistDetails.google_calendar_credentials,
          error: meetResult.error || null
        });
      }
    } else {
      console.warn('⚠️ Meet link creation failed or returned fallback:', {
        error: meetResult.error,
        method: meetResult.method,
        meetLink: meetResult.meetLink
      });
      // Don't throw - fallback link is acceptable
    }

    // Generate receipt before sending emails
    let receiptResult = null;
    try {
      const { generateAndStoreReceipt } = require('./receiptService');
      
      // Fetch full payment record with transaction_id and package_id
      const { data: fullPaymentRecord } = await supabaseAdmin
        .from('payments')
        .select('id, amount, transaction_id, completed_at, razorpay_payment_id, package_id')
        .eq('id', paymentRecord.id)
        .single();
      
      console.log('🔍 sessionCreationService - Payment data for receipt:', {
        payment_id: fullPaymentRecord?.id,
        package_id: fullPaymentRecord?.package_id
      });
      
      receiptResult = await generateAndStoreReceipt(
        session,
        { 
          ...fullPaymentRecord, 
          completed_at: fullPaymentRecord?.completed_at || new Date().toISOString() 
        },
        clientDetails,
        psychologistDetails
      );
      
      if (receiptResult && receiptResult.receiptNumber) {
        console.log('✅ Receipt generated successfully:', {
          receiptNumber: receiptResult.receiptNumber,
          pdfGenerated: !!receiptResult.pdfBuffer,
          pdfSize: receiptResult.pdfBuffer?.length || 0
        });
      }
    } catch (receiptError) {
      console.error('❌ Error generating receipt:', receiptError);
      // Continue even if receipt generation fails
    }

    // Send confirmation emails with receipt
    try {
      // Use client_name from receiptDetails if available (first_name + last_name), otherwise use computed clientName
      const emailClientName = receiptResult?.receiptDetails?.client_name || clientName;
      
      const emailResult = await emailService.sendSessionConfirmation({
        clientName: emailClientName,
        psychologistName: psychologistName,
        clientEmail: clientEmail || clientDetails.user?.email,
        psychologistEmail: psychologistDetails.email,
        scheduledDate: slotLock.scheduled_date,
        scheduledTime: slotLock.scheduled_time,
        sessionDate: slotLock.scheduled_date,
        sessionTime: slotLock.scheduled_time,
        googleMeetLink: meetResult.meetLink,
        meetLink: meetResult.meetLink,
        googleCalendarEventId: meetResult.eventId,
        sessionId: session.id,
        price: paymentRecord.amount,
        amount: paymentRecord.amount,
        durationMinutes: meetDurationMinutes,
        status: session.status || 'booked',
        psychologistId: slotLock.psychologist_id,
        clientId: slotLock.client_id,
        packageInfo: packageInfo, // Include package details
        receiptId: receiptResult?.receiptId || null, // Pass receipt ID for reference
        receiptNumber: receiptResult?.receiptNumber || null,
        receiptPdfBuffer: receiptResult?.pdfBuffer || null // Pass PDF buffer to attach to email
      });
      
      if (emailResult) {
        console.log('✅ Confirmation emails sent successfully');
      } else {
        console.warn('⚠️ Email sending returned false - check email service logs');
      }
    } catch (emailError) {
      console.error('❌ Error sending confirmation emails:', emailError);
      // Continue - don't block the process
    }

    // Send WhatsApp notifications to both client and psychologist
    try {
      console.log('📱 Sending WhatsApp notifications...');
      const { sendBookingConfirmation, sendWhatsAppTextWithRetry } = require('../utils/whatsappService');
      
      // Send WhatsApp to client
      const clientPhone = clientDetails.phone_number || null;
      if (clientPhone && meetResult.meetLink) {
        // Only include childName if child_name exists and is not empty/null/'Pending'
        const childName = clientDetails.child_name && 
          clientDetails.child_name.trim() !== '' && 
          clientDetails.child_name.toLowerCase() !== 'pending'
          ? clientDetails.child_name 
          : null;
        
        // Get client name from receiptDetails (first_name + last_name) for receipt filename
        const receiptClientName = receiptResult?.receiptDetails?.client_name || 
                                  `${clientDetails.first_name || ''} ${clientDetails.last_name || ''}`.trim() || null;
        
        const clientDetails_wa = {
          childName: childName,
          date: slotLock.scheduled_date,
          time: slotLock.scheduled_time,
          meetLink: meetResult.meetLink,
          psychologistName: psychologistName,
          durationMinutes: meetDurationMinutes,
          packageInfo: packageInfo, // Include package details
          receiptPdfBuffer: receiptResult?.pdfBuffer || null,
          receiptNumber: receiptResult?.receiptNumber || null,
          clientName: receiptClientName // Client name (first_name + last_name) for receipt filename
        };
        
        const clientWaResult = await sendBookingConfirmation(clientPhone, clientDetails_wa);
        if (clientWaResult?.success) {
          console.log('✅ WhatsApp confirmation sent to client');
        } else if (clientWaResult?.skipped) {
          console.log('ℹ️ Client WhatsApp skipped:', clientWaResult.reason);
        } else {
          console.warn('⚠️ Client WhatsApp send failed:', clientWaResult?.error || 'Unknown error');
        }
      } else {
        console.log('ℹ️ No client phone or meet link; skipping client WhatsApp');
      }

      // Send WhatsApp to psychologist
      const psychologistPhone = psychologistDetails.phone || null;
      if (psychologistPhone && meetResult.meetLink) {
        // Format date and time using the same functions as client messages
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
        
        const formatFriendlyTime = (timeStr) => {
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
        };
        
        const bullet = '•⁠  ⁠';
        const formattedDate = formatBookingDateShort(slotLock.scheduled_date);
        const formattedTime = formatFriendlyTime(slotLock.scheduled_time);
        
        // Package line (only for package sessions)
        let packageLine = '';
        if (packageInfo && packageInfo.totalSessions) {
          const total = packageInfo.totalSessions || 0;
          const completed = packageInfo.completedSessions || 0;
          const remaining = packageInfo.remainingSessions || 0;
          packageLine = `${bullet}Package: ${completed}/${total} sessions completed, ${remaining} remaining\n`;
        }
        
        const psychologistMessage =
          `Hey 👋\n\n` +
          `New session booked with Koott.\n\n` +
          `${bullet}Client: ${clientName}\n` +
          packageLine +
          `${bullet}Date: ${formattedDate}\n` +
          `${bullet}Time: ${formattedTime} (IST)\n` +
          `${bullet}Duration: ${meetDurationMinutes} min\n\n` +
          `Join link:\n${meetResult.meetLink}\n\n` +
          `Please be ready 5 mins early.\n\n` +
          `For help: +91 95390 07766\n\n` +
          `— Koott 💜`;
        
        const psychologistWaResult = await sendWhatsAppTextWithRetry(psychologistPhone, psychologistMessage);
        if (psychologistWaResult?.success) {
          console.log('✅ WhatsApp notification sent to psychologist');
        } else if (psychologistWaResult?.skipped) {
          console.log('ℹ️ Psychologist WhatsApp skipped:', psychologistWaResult.reason);
        } else {
          console.warn('⚠️ Psychologist WhatsApp send failed:', psychologistWaResult?.error || 'Unknown error');
        }
      } else {
        console.log('ℹ️ No psychologist phone or meet link; skipping psychologist WhatsApp');
      }
    } catch (whatsappError) {
      console.error('❌ Error sending WhatsApp notifications:', whatsappError);
      // Continue - don't block the process
    }
  }
}

// Singleton instance
const meetLinkQueue = new MeetLinkCreationQueue();

/**
 * Enqueue Meet link creation (wrapper function)
 * @param {Object} params - Parameters for Meet link creation
 * @param {Object} params.slotLock - Slot lock record
 * @param {Object} params.session - Session record
 * @param {Object} params.paymentRecord - Payment record
 * @returns {Promise} Promise that resolves when enqueued
 */
const enqueueMeetLinkCreation = ({ slotLock, session, paymentRecord }) => {
  return meetLinkQueue.enqueue({ slotLock, session, paymentRecord });
};

module.exports = {
  createSessionFromSlotLock,
  enqueueMeetLinkCreation
};


