/**
 * Payment Status Controller
 * 
 * Endpoint for checking payment and session status.
 * 
 * This endpoint:
 * - Does NOT create sessions (webhook does that)
 * - Returns current status
 * - Used by frontend to poll for session creation
 * - Performs optional reconciliation writes (updates payment.session_id when session is found)
 * - Idempotent except for optional reconciliation writes
 */

const { supabaseAdmin } = require('../config/supabase');
const { getSlotLockByOrderId } = require('../services/slotLockService');
const { getRazorpayInstance, getRazorpayConfig, verifyPaymentSignature: verifyRazorpaySignature } = require('../config/razorpay');
const { processPaymentCaptured } = require('./razorpayWebhookController');

/**
 * Get booking status by order ID
 * 
 * Returns:
 * - Slot lock status
 * - Payment status
 * - Session details (if created)
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
const getBookingStatusByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Order ID is required'
      });
    }

    // Validate orderId format - must be non-guessable (UUID or cryptographically random string)
    // Razorpay order IDs are typically 14 characters alphanumeric, but we'll accept any reasonable format
    // Reject obviously predictable patterns
    if (orderId.length < 10 || /^[0-9]+$/.test(orderId)) {
      // Sequential numeric IDs are predictable - reject them
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID format'
      });
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('🔍 Checking booking status for order:', orderId?.substring(0, 10) + '...');
    }

    // Get payment record first (always check this)
    const { data: paymentRecord, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('id, status, amount, session_id, created_at, completed_at, psychologist_id, client_id, razorpay_params')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    if (paymentError) {
      console.error('Error fetching payment record:', paymentError);
      return res.status(500).json({
        success: false,
        message: 'Database error while fetching payment',
        status: 'ERROR'
      });
    }

    if (!paymentRecord) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        status: 'NOT_FOUND'
      });
    }

    // Try to get slot lock (may not exist if using old flow or migration not run)
    const slotLockResult = await getSlotLockByOrderId(orderId);
    const slotLock = slotLockResult.success ? slotLockResult.data : null;

    // If slot lock exists, use it; otherwise fall back to payment record
    // This provides backward compatibility during transition
    if (!slotLock) {
      console.log('⚠️ Slot lock not found, using payment record (legacy mode)');
      
      // Get session if exists
      let session = null;
      if (paymentRecord.session_id) {
        const { data: sessionData } = await supabaseAdmin
          .from('sessions')
          .select('id, status, scheduled_date, scheduled_time, google_meet_link, session_type, package_id')
          .eq('id', paymentRecord.session_id)
          .maybeSingle();
        
        session = sessionData;
      }

      // Determine status from payment record
      let overallStatus = paymentRecord.status?.toUpperCase() || 'PENDING';
      let message = '';

      if (paymentRecord.status === 'success' && session) {
        overallStatus = 'COMPLETED';
        message = 'Booking confirmed!';
      } else if (paymentRecord.status === 'success' && !session) {
        overallStatus = 'PAYMENT_SUCCESS';
        message = 'Payment successful, creating session...';
      } else if (paymentRecord.status === 'pending') {
        overallStatus = 'PAYMENT_PENDING';
        message = 'Payment in progress...';
      } else if (paymentRecord.status === 'failed') {
        overallStatus = 'FAILED';
        message = 'Payment failed. Please try again.';
      } else {
        message = 'Processing...';
      }

      return res.status(200).json({
        success: true,
        data: {
          orderId: orderId,
          status: overallStatus,
          slotLockStatus: null, // No slot lock
          message,
          payment: {
            id: paymentRecord.id,
            status: paymentRecord.status,
            amount: paymentRecord.amount
          },
          session: session ? {
            id: session.id,
            status: session.status,
            scheduledDate: session.scheduled_date,
            scheduledTime: session.scheduled_time,
            meetLink: session.google_meet_link || null,
            session_type: session.session_type || null,
            package_id: session.package_id || null
          } : null,
          slotDetails: paymentRecord.razorpay_params?.notes ? {
            psychologistId: paymentRecord.psychologist_id,
            scheduledDate: paymentRecord.razorpay_params.notes?.scheduledDate,
            scheduledTime: paymentRecord.razorpay_params.notes?.scheduledTime
          } : null
        },
        legacy: true // Flag to indicate using legacy mode
      });
    }

    // Slot lock exists - use new flow
    const slotLockData = slotLock;

    // Get session if exists - check both payment record and slot lock status
    let session = null;
    
    // First try to get from payment record
    if (paymentRecord?.session_id) {
      const { data: sessionData, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .select('id, status, scheduled_date, scheduled_time, google_meet_link, session_type, package_id')
        .eq('id', paymentRecord.session_id)
        .maybeSingle();
      
      if (sessionError) {
        console.warn('⚠️ Error fetching session by payment.session_id:', sessionError);
      }
      
      session = sessionData;
    }
    
    // If not found in payment record but slot lock is SESSION_CREATED, try to find by slot details
    if (!session && slotLock.status === 'SESSION_CREATED') {
      console.log('🔍 Session not in payment record, searching by slot details...');
      const { data: sessionData, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .select('id, status, scheduled_date, scheduled_time, google_meet_link, session_type, package_id')
        .eq('psychologist_id', slotLock.psychologist_id)
        .eq('client_id', slotLock.client_id)
        .eq('scheduled_date', slotLock.scheduled_date)
        .eq('scheduled_time', slotLock.scheduled_time)
        .eq('status', 'booked')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (sessionError) {
        console.warn('⚠️ Error fetching session by slot details:', sessionError);
      }
      
      if (sessionData) {
        session = sessionData;
        console.log('✅ Found session by slot details, updating payment record...');
        // Update payment record with session_id for future queries (reconciliation side-effect)
        const { error: updatePayErr } = await supabaseAdmin
          .from('payments')
          .update({ session_id: sessionData.id })
          .eq('razorpay_order_id', orderId);
        if (updatePayErr) {
          console.warn('⚠️ Failed to update payment.session_id:', updatePayErr.message);
        }
      } else {
        console.warn('⚠️ Session not found even though slot lock is SESSION_CREATED');
      }
    }
    
    // If session exists but no meet link, and it was just created, the meet link might still be processing
    // This is expected - meet links are created asynchronously
    const meetLinkStatus = session?.google_meet_link 
      ? 'available' 
      : session 
        ? 'processing' // Session exists but meet link not yet created (async process)
        : 'none';
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('📊 Session lookup result:', {
        hasSession: !!session,
        sessionId: session?.id || null,
        paymentSessionId: paymentRecord?.session_id || null,
        slotLockStatus: slotLock?.status || null,
        sessionStatus: session?.status || null,
        meetLinkStatus: meetLinkStatus,
        hasMeetLink: !!session?.google_meet_link,
        meetLink: session?.google_meet_link ? session.google_meet_link.substring(0, 30) + '...' : null
      });
    }

    // CRITICAL: If slot is SLOT_HELD and payment is pending for > 30 seconds,
    // check Razorpay directly (webhook might not have fired in test mode)
    if (slotLock.status === 'SLOT_HELD' && paymentRecord.status === 'pending') {
      // Verify paymentRecord.created_at exists and is valid before computing age
      if (paymentRecord.created_at && !isNaN(new Date(paymentRecord.created_at).getTime())) {
        const paymentAge = Date.now() - new Date(paymentRecord.created_at).getTime();
        if (paymentAge > 30000) { // 30 seconds
          console.log('🔍 Payment pending for >30s, checking Razorpay status...');
          
          try {
            const razorpay = getRazorpayInstance();
            const razorpayPayments = await razorpay.orders.fetchPayments(orderId);
            if (razorpayPayments && razorpayPayments.items && razorpayPayments.items.length > 0) {
              // Filter for captured payments and pick the most recent one
              const capturedPayments = razorpayPayments.items
                .filter(item => item.status === 'captured')
                .sort((a, b) => {
                  // Sort by created_at descending (most recent first), fallback to id comparison
                  const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
                  const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
                  return bTime - aTime || (b.id > a.id ? 1 : -1);
                });
              
              if (capturedPayments.length > 0) {
                const razorpayPayment = capturedPayments[0];
                console.log('✅ Payment captured in Razorpay, processing manually...');
                // Use payment.id as idempotency key (processPaymentCaptured checks by razorpay_payment_id)
                await processPaymentCaptured({
                  payment: {
                    entity: {
                      id: razorpayPayment.id,
                      order_id: orderId,
                      amount: razorpayPayment.amount,
                      currency: razorpayPayment.currency,
                      status: razorpayPayment.status
                    }
                  }
                }, razorpayPayment.id, true);
              } else {
                // Check if any payment is authorized but not captured
                const authorizedPayments = razorpayPayments.items.filter(item => item.status === 'authorized');
                if (authorizedPayments.length > 0) {
                  console.log('ℹ️ Payment authorized but not captured; manual capture required');
                }
              }
            }
          } catch (razorpayError) {
            console.warn('⚠️ Could not check Razorpay status:', razorpayError.message);
            // Continue with normal flow
          }
        }
      } else {
        console.warn('⚠️ Payment record missing or invalid created_at, skipping Razorpay check');
      }
    }

    // Determine overall status
    let overallStatus = slotLock.status;
    let message = '';

    switch (slotLock.status) {
      case 'SLOT_HELD':
        message = 'Slot reserved, waiting for payment...';
        break;
      case 'PAYMENT_PENDING':
        message = 'Payment in progress...';
        break;
      case 'PAYMENT_SUCCESS':
        message = 'Payment successful, creating session...';
        break;
      case 'SESSION_CREATED':
        overallStatus = 'COMPLETED';
        message = 'Booking confirmed!';
        break;
      case 'FAILED':
        message = 'Payment failed. Please try again.';
        break;
      case 'EXPIRED':
        message = 'Slot reservation expired. Please book again.';
        break;
      default:
        message = 'Processing...';
    }

    // If status is COMPLETED but session is null, use slot details as fallback and mark incomplete
    const sessionResponse = session ? {
      id: session.id,
      status: session.status,
      scheduledDate: session.scheduled_date,
      scheduledTime: session.scheduled_time,
      meetLink: session.google_meet_link || null,
      session_type: session.session_type || null,
      package_id: session.package_id || null
    } : (overallStatus === 'COMPLETED' ? (() => {
      console.warn('⚠️ Missing session for completed booking (orderId:', slotLock.order_id, ') — data inconsistency');
      return {
        id: null,
        status: 'incomplete',
        incomplete: true,
        scheduledDate: slotLock.scheduled_date,
        scheduledTime: slotLock.scheduled_time,
        meetLink: null,
        session_type: null,
        package_id: null
      };
    })() : null);

    return res.status(200).json({
      success: true,
      data: {
        orderId: slotLock.order_id,
        status: overallStatus,
        slotLockStatus: slotLock.status,
        message,
        payment: paymentRecord ? {
          id: paymentRecord.id,
          status: paymentRecord.status,
          amount: paymentRecord.amount
        } : null,
        session: sessionResponse,
        slotDetails: {
          psychologistId: slotLock.psychologist_id,
          scheduledDate: slotLock.scheduled_date,
          scheduledTime: slotLock.scheduled_time
        }
      }
    });
  } catch (error) {
    console.error('❌ Error getting booking status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get booking status'
    });
  }
};

/**
 * Verify payment signature (optional verification from frontend)
 * 
 * This is a lightweight verification that doesn't create sessions.
 * Sessions are created by webhook.
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
const verifyPaymentSignature = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing payment verification details'
      });
    }

    // Get slot lock to verify order exists; fallback to payments table (legacy)
    let slotLock = null;
    const slotLockResult = await getSlotLockByOrderId(razorpay_order_id);
    if (slotLockResult.success && slotLockResult.data) {
      slotLock = slotLockResult.data;
    } else {
      const { data: paymentRecord } = await supabaseAdmin
        .from('payments')
        .select('id, razorpay_order_id, status')
        .eq('razorpay_order_id', razorpay_order_id)
        .maybeSingle();
      if (!paymentRecord) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }
      // Map legacy payment status to canonical slot status for consistent API
      const statusMap = { pending: 'PAYMENT_PENDING', success: 'SESSION_CREATED', failed: 'FAILED', authorized: 'PAYMENT_PENDING' };
      const normalizedStatus = statusMap[String(paymentRecord.status).toLowerCase()] || 'PAYMENT_PENDING';
      slotLock = { order_id: razorpay_order_id, status: normalizedStatus };
    }

    // Verify signature (optional - webhook is source of truth)
    const config = getRazorpayConfig();
    const isValid = verifyRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      config.keySecret
    );

    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }

    // Return status (don't create session - webhook does that)
    return res.status(200).json({
      success: true,
      message: 'Payment signature verified',
      orderId: razorpay_order_id,
      status: slotLock?.status ?? null
    });
  } catch (error) {
    console.error('❌ Error verifying payment signature:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify payment signature'
    });
  }
};

module.exports = {
  getBookingStatusByOrderId,
  verifyPaymentSignature
};


