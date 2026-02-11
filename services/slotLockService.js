/**
 * Slot Lock Service
 * 
 * Provides atomic slot locking to prevent double bookings during payment process.
 * 
 * Flow:
 * 1. User clicks "Pay" -> holdSlot() creates lock with 5min expiry
 * 2. Payment succeeds -> webhook updates lock to PAYMENT_SUCCESS
 * 3. Session created -> lock updated to SESSION_CREATED
 * 4. Expired locks -> automatically released by cleanup job
 */

const { supabaseAdmin } = require('../config/supabase');
const { errorResponse } = require('../utils/helpers');

const SLOT_HOLD_DURATION_MINUTES = 5; // 5 minutes to complete payment
const SLOT_EXTENDED_DURATION_MINUTES = 15; // Extended duration after payment initiation (total 15 min)
const MAX_RETRIES = 3; // Maximum retries to prevent infinite loops

/**
 * Hold a slot for booking (called before payment initiation)
 * 
 * @param {Object} params
 * @param {string} params.psychologistId - Psychologist ID
 * @param {string} params.clientId - Client ID
 * @param {string} params.scheduledDate - Date in YYYY-MM-DD format
 * @param {string} params.scheduledTime - Time in HH:MM:SS format
 * @param {string} params.orderId - Razorpay order_id
 * @returns {Promise<Object>} { success: boolean, data?: slotLock, error?: string }
 */
const holdSlot = async ({ psychologistId, clientId, scheduledDate, scheduledTime, orderId }, retryCount = 0) => {
  try {
    // Prevent infinite retry loops
    if (retryCount > MAX_RETRIES) {
      console.error('❌ Max retries exceeded for slot lock - aborting to prevent infinite loop');
      return {
        success: false,
        error: 'Failed to reserve slot after multiple attempts. Please try again.'
      };
    }

    console.log('🔒 Attempting to hold slot:', {
      psychologistId,
      scheduledDate,
      scheduledTime,
      orderId: orderId?.substring(0, 10) + '...',
      retryCount
    });

    // Calculate expiry time (5 minutes from now)
    const slotExpiresAt = new Date();
    slotExpiresAt.setMinutes(slotExpiresAt.getMinutes() + SLOT_HOLD_DURATION_MINUTES);

    // Check if slot is already locked by another active booking
    // Only check active statuses - exclude FAILED and EXPIRED locks
    const { data: existingLocks, error: checkError } = await supabaseAdmin
      .from('slot_locks')
      .select('id, status, order_id, slot_expires_at, client_id')
      .eq('psychologist_id', psychologistId)
      .eq('scheduled_date', scheduledDate)
      .eq('scheduled_time', scheduledTime)
      .in('status', ['SLOT_HELD', 'PAYMENT_PENDING', 'PAYMENT_SUCCESS', 'SESSION_CREATED']);

    if (checkError) {
      console.error('❌ Error checking existing locks:', checkError);
      return {
        success: false,
        error: 'Failed to check slot availability'
      };
    }

    // Filter out expired locks and failed locks (they should be cleaned up, but check anyway)
    const now = new Date();
    const activeLocks = (existingLocks || []).filter(lock => {
      // Exclude FAILED and EXPIRED locks
      if (lock.status === 'FAILED' || lock.status === 'EXPIRED') {
        return false;
      }
      // Check expiry time
      const expiresAt = new Date(lock.slot_expires_at);
      return expiresAt > now;
    });

    if (activeLocks.length > 0) {
      const activeLock = activeLocks[0];
      console.log('⚠️ Slot already locked:', {
        lockId: activeLock.id,
        status: activeLock.status,
        orderId: activeLock.order_id?.substring(0, 10) + '...',
        expiresAt: activeLock.slot_expires_at,
        isExpired: new Date(activeLock.slot_expires_at) <= now
      });

      // If it's the same client and order, allow (idempotent retry)
      if (activeLock.client_id === clientId && activeLock.order_id === orderId) {
        console.log('✅ Same client and order - allowing idempotent retry');
        return {
          success: true,
          data: activeLock,
          isExisting: true
        };
      }

      return {
        success: false,
        error: 'This time slot is already booked by another user. Please select another time.',
        conflict: true
      };
    }

    // Create new slot lock
    const { data: slotLock, error: insertError } = await supabaseAdmin
      .from('slot_locks')
      .insert([{
        psychologist_id: psychologistId,
        client_id: clientId,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        order_id: orderId,
        status: 'SLOT_HELD',
        slot_expires_at: slotExpiresAt.toISOString()
      }])
      .select()
      .single();

    if (insertError) {
      // Check if it's a unique constraint violation (race condition)
      if (insertError.code === '23505' || insertError.message?.includes('unique')) {
        console.log('⚠️ Race condition detected - slot was just locked by another request');
        
        // Re-check existing locks to see if it's a different order or same order (idempotent)
        const { data: raceConditionLocks, error: recheckError } = await supabaseAdmin
          .from('slot_locks')
          .select('id, status, order_id, slot_expires_at, client_id')
          .eq('psychologist_id', psychologistId)
          .eq('scheduled_date', scheduledDate)
          .eq('scheduled_time', scheduledTime)
          .in('status', ['SLOT_HELD', 'PAYMENT_PENDING', 'PAYMENT_SUCCESS', 'SESSION_CREATED']);

        if (!recheckError && raceConditionLocks && raceConditionLocks.length > 0) {
          const raceLock = raceConditionLocks[0];
          const raceLockExpiresAt = new Date(raceLock.slot_expires_at);
          
          // Check if lock is still active
          if (raceLockExpiresAt > now) {
            // If it's the same client and order, allow (idempotent retry)
            if (raceLock.client_id === clientId && raceLock.order_id === orderId) {
              console.log('✅ Same client and order after race condition - allowing idempotent retry');
              return {
                success: true,
                data: raceLock,
                isExisting: true
              };
            } else {
              // Different order - real conflict
              console.log('❌ Slot locked by different order after race condition');
              return {
                success: false,
                error: 'This time slot is already booked by another user. Please select another time.',
                conflict: true
              };
            }
          }
        }
        
        // If no active lock found, retry with backoff (with retry limit)
        if (retryCount < MAX_RETRIES) {
          // Small delay before retry to allow transaction to commit
          await new Promise(resolve => setTimeout(resolve, 50 * (retryCount + 1)));
          return holdSlot({ psychologistId, clientId, scheduledDate, scheduledTime, orderId }, retryCount + 1);
        } else {
          console.error('❌ Max retries reached after race condition');
          return {
            success: false,
            error: 'Failed to reserve slot after multiple attempts. Please try again.',
            conflict: true
          };
        }
      }

      console.error('❌ Error creating slot lock:', insertError);
      return {
        success: false,
        error: 'Failed to reserve slot'
      };
    }

    console.log('✅ Slot held successfully:', {
      lockId: slotLock.id,
      expiresAt: slotLock.slot_expires_at
    });

    return {
      success: true,
      data: slotLock
    };
  } catch (error) {
    console.error('❌ Exception in holdSlot:', error);
    return {
      success: false,
      error: error.message || 'Failed to hold slot'
    };
  }
};

/**
 * Extend slot lock expiry (called when payment is initiated to prevent expiry during payment)
 * 
 * @param {string} orderId - Razorpay order_id
 * @param {number} extendByMinutes - Minutes to extend (default: 10)
 * @returns {Promise<Object>} { success: boolean, data?: slotLock, error?: string }
 */
const extendSlotLock = async (orderId, extendByMinutes = 10) => {
  try {
    console.log('⏰ Extending slot lock:', {
      orderId: orderId?.substring(0, 10) + '...',
      extendByMinutes
    });

    const { data: slotLock, error: fetchError } = await supabaseAdmin
      .from('slot_locks')
      .select('id, slot_expires_at, status')
      .eq('order_id', orderId)
      .single();

    if (fetchError || !slotLock) {
      console.warn('⚠️ Slot lock not found for extension:', fetchError);
      return {
        success: false,
        error: 'Slot lock not found',
        notFound: true
      };
    }

    // Only extend if lock is still active
    if (['FAILED', 'EXPIRED', 'SESSION_CREATED'].includes(slotLock.status)) {
      console.log(`ℹ️ Slot lock already in final state: ${slotLock.status}`);
      return {
        success: true,
        data: slotLock,
        alreadyFinal: true
      };
    }

    // Calculate new expiry time - use max of current time and currentExpiry to handle expired locks
    const currentExpiry = new Date(slotLock.slot_expires_at);
    const now = new Date();
    const baseExpiry = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(baseExpiry);
    newExpiry.setMinutes(newExpiry.getMinutes() + extendByMinutes);

    const { data: updatedLock, error: updateError } = await supabaseAdmin
      .from('slot_locks')
      .update({
        slot_expires_at: newExpiry.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('order_id', orderId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error extending slot lock:', updateError);
      return {
        success: false,
        error: 'Failed to extend slot lock'
      };
    }

    console.log('✅ Slot lock extended:', {
      lockId: updatedLock.id,
      oldExpiry: slotLock.slot_expires_at,
      newExpiry: updatedLock.slot_expires_at
    });

    return {
      success: true,
      data: updatedLock
    };
  } catch (error) {
    console.error('❌ Exception in extendSlotLock:', error);
    return {
      success: false,
      error: error.message || 'Failed to extend slot lock'
    };
  }
};

/**
 * Check if payment order matches an expired lock (allows session creation if payment succeeded)
 * 
 * @param {string} orderId - Razorpay order_id
 * @param {string} clientId - Client ID
 * @returns {Promise<Object>} { success: boolean, matches: boolean, lock?: slotLock }
 */
const checkPaymentOrderMatchesLock = async (orderId, clientId) => {
  try {
    const { data: slotLock, error } = await supabaseAdmin
      .from('slot_locks')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (error || !slotLock) {
      return {
        success: true,
        matches: false
      };
    }

    // Check if it's the same client and order (even if expired)
    const matches = slotLock.client_id === clientId && slotLock.order_id === orderId;

    return {
      success: true,
      matches,
      lock: slotLock
    };
  } catch (error) {
    console.error('❌ Exception in checkPaymentOrderMatchesLock:', error);
    return {
      success: false,
      error: error.message || 'Failed to check payment order lock'
    };
  }
};

/**
 * Update slot lock status (called by webhook after payment verification)
 * 
 * @param {string} orderId - Razorpay order_id
 * @param {string} status - New status (PAYMENT_PENDING, PAYMENT_SUCCESS, SESSION_CREATED, FAILED)
 * @param {Object} paymentData - Optional payment details
 * @returns {Promise<Object>} { success: boolean, data?: slotLock, error?: string }
 */
const updateSlotLockStatus = async (orderId, status, paymentData = {}) => {
  try {
    console.log('🔄 Updating slot lock status:', {
      orderId: orderId?.substring(0, 10) + '...',
      status,
      hasPaymentId: !!paymentData.paymentId
    });

    const updateData = {
      status,
      updated_at: new Date().toISOString()
    };

    if (paymentData.paymentId) {
      updateData.payment_id = paymentData.paymentId;
    }

    if (paymentData.signature) {
      updateData.signature = paymentData.signature;
    }

    const { data: slotLock, error: updateError } = await supabaseAdmin
      .from('slot_locks')
      .update(updateData)
      .eq('order_id', orderId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error updating slot lock:', updateError);
      return {
        success: false,
        error: 'Failed to update slot lock status'
      };
    }

    if (!slotLock) {
      return {
        success: false,
        error: 'Slot lock not found'
      };
    }

    console.log('✅ Slot lock status updated:', {
      lockId: slotLock.id,
      newStatus: slotLock.status
    });

    return {
      success: true,
      data: slotLock
    };
  } catch (error) {
    console.error('❌ Exception in updateSlotLockStatus:', error);
    return {
      success: false,
      error: error.message || 'Failed to update slot lock'
    };
  }
};

/**
 * Get slot lock by order ID
 * 
 * @param {string} orderId - Razorpay order_id
 * @returns {Promise<Object>} { success: boolean, data?: slotLock, error?: string }
 */
const getSlotLockByOrderId = async (orderId) => {
  try {
    const { data: slotLock, error } = await supabaseAdmin
      .from('slot_locks')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found
        return {
          success: false,
          error: 'Slot lock not found',
          notFound: true
        };
      }
      console.error('❌ Error fetching slot lock:', error);
      return {
        success: false,
        error: 'Failed to fetch slot lock'
      };
    }

    return {
      success: true,
      data: slotLock
    };
  } catch (error) {
    console.error('❌ Exception in getSlotLockByOrderId:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch slot lock'
    };
  }
};

/**
 * Release a slot lock by order ID (for failed/cancelled bookings)
 * 
 * @param {string} orderId - Razorpay order_id
 * @returns {Promise<Object>} { success: boolean, released: boolean, error?: string }
 */
const releaseSlotLock = async (orderId) => {
  try {
    if (!orderId) {
      return {
        success: false,
        error: 'Order ID is required'
      };
    }

    console.log('🔓 Releasing slot lock for order:', orderId?.substring(0, 10) + '...');

    // Check if lock exists and is in a releasable state
    const { data: slotLock, error: fetchError } = await supabaseAdmin
      .from('slot_locks')
      .select('id, status')
      .eq('order_id', orderId)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        // Not found - already released or never existed
        console.log('ℹ️ Slot lock not found (may already be released)');
        return {
          success: true,
          released: false,
          notFound: true
        };
      }
      console.error('❌ Error fetching slot lock:', fetchError);
      return {
        success: false,
        error: 'Failed to fetch slot lock'
      };
    }

    // Only release if not already in final states
    if (['SESSION_CREATED', 'EXPIRED', 'FAILED'].includes(slotLock.status)) {
      console.log(`ℹ️ Slot lock already in final state: ${slotLock.status}`);
      return {
        success: true,
        released: false,
        alreadyFinal: true
      };
    }

    // Release the lock
    const { error: updateError } = await supabaseAdmin
      .from('slot_locks')
      .update({
        status: 'FAILED',
        updated_at: new Date().toISOString()
      })
      .eq('order_id', orderId);

    if (updateError) {
      console.error('❌ Error releasing slot lock:', updateError);
      return {
        success: false,
        error: 'Failed to release slot lock'
      };
    }

    console.log('✅ Slot lock released successfully');
    return {
      success: true,
      released: true
    };
  } catch (error) {
    console.error('❌ Exception in releaseSlotLock:', error);
    return {
      success: false,
      error: error.message || 'Failed to release slot lock'
    };
  }
};

/**
 * Release expired slot locks (called by cleanup job)
 * Also releases failed payments that haven't been cleaned up
 * 
 * @returns {Promise<Object>} { success: boolean, released: number, error?: string }
 */
const releaseExpiredSlots = async () => {
  try {
    const now = new Date().toISOString();

    // Find expired slots that are still in SLOT_HELD or PAYMENT_PENDING status
    const { data: expiredLocks, error: findError } = await supabaseAdmin
      .from('slot_locks')
      .select('id, order_id, status')
      .in('status', ['SLOT_HELD', 'PAYMENT_PENDING'])
      .lt('slot_expires_at', now);

    if (findError) {
      console.error('❌ Error finding expired slots:', findError);
      return {
        success: false,
        error: 'Failed to find expired slots'
      };
    }

    // Also find slot locks with failed payments (status = 'pending' in payments table but lock still active)
    // Check for locks older than 15 minutes with no successful payment
    const fifteenMinutesAgo = new Date();
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);
    
    // Find old locks that might have failed payments
    const { data: oldLocks, error: oldLocksError } = await supabaseAdmin
      .from('slot_locks')
      .select('id, order_id, status, created_at')
      .in('status', ['SLOT_HELD', 'PAYMENT_PENDING'])
      .lt('created_at', fifteenMinutesAgo.toISOString());
    
    // Check which of these old locks have failed payments
    const failedPaymentLocks = [];
    if (oldLocks && !oldLocksError && oldLocks.length > 0) {
      // Batch query: collect all order IDs and query once
      const orderIds = oldLocks
        .map(lock => lock.order_id)
        .filter(Boolean); // Remove null/undefined
      
      if (orderIds.length > 0) {
        // Single batched query for all payments
        const { data: payments, error: paymentsError } = await supabaseAdmin
          .from('payments')
          .select('razorpay_order_id, status')
          .in('razorpay_order_id', orderIds);
        
        if (paymentsError) {
          console.error('❌ Error fetching payments for old locks:', paymentsError);
        } else {
          // Build map from razorpay_order_id to payment status
          const paymentMap = new Map();
          (payments || []).forEach(payment => {
            paymentMap.set(payment.razorpay_order_id, payment);
          });
          
          // Iterate oldLocks and check payment status from map
          for (const lock of oldLocks) {
            if (lock.order_id) {
              const payment = paymentMap.get(lock.order_id);
              // If payment is failed or doesn't exist, mark lock for release
              if (!payment || payment.status === 'failed') {
                failedPaymentLocks.push(lock);
              }
            }
          }
        }
      }
    }

    // Also check for pending payments with expired locks (user cancelled/exited payment)
    const pendingPaymentLocks = [];
    if (expiredLocks && expiredLocks.length > 0) {
      // Batch query: collect all order IDs and query once
      const orderIds = expiredLocks
        .map(lock => lock.order_id)
        .filter(Boolean); // Remove null/undefined
      
      if (orderIds.length > 0) {
        // Single batched query for all payments
        const { data: payments, error: paymentsError } = await supabaseAdmin
          .from('payments')
          .select('id, status, razorpay_order_id')
          .in('razorpay_order_id', orderIds);
        
        if (paymentsError) {
          console.error('❌ Error fetching payments for expired locks:', paymentsError);
        } else {
          // Build map from razorpay_order_id to payment
          const paymentMap = new Map();
          (payments || []).forEach(payment => {
            paymentMap.set(payment.razorpay_order_id, payment);
          });
          
          // Iterate expiredLocks and check payment status from map
          for (const lock of expiredLocks) {
            if (lock.order_id) {
              const payment = paymentMap.get(lock.order_id);
              // If payment is still pending, it means user cancelled/exited without completing
              if (payment && payment.status === 'pending') {
                pendingPaymentLocks.push(lock);
              }
            }
          }
        }
      }
    }

    // Combine all sets of locks to release
    const locksToRelease = [];
    const lockIds = new Set();
    
    if (expiredLocks) {
      expiredLocks.forEach(lock => {
        if (!lockIds.has(lock.id)) {
          lockIds.add(lock.id);
          locksToRelease.push(lock);
        }
      });
    }

    if (failedPaymentLocks) {
      failedPaymentLocks.forEach(lock => {
        if (!lockIds.has(lock.id)) {
          lockIds.add(lock.id);
          locksToRelease.push(lock);
        }
      });
    }

    if (locksToRelease.length === 0) {
      return {
        success: true,
        released: 0,
        paymentsUpdated: 0
      };
    }

    // Update expired/failed slots to EXPIRED status
    const { error: updateError } = await supabaseAdmin
      .from('slot_locks')
      .update({
        status: 'EXPIRED',
        updated_at: now
      })
      .in('id', locksToRelease.map(lock => lock.id));

    if (updateError) {
      console.error('❌ Error releasing expired slots:', updateError);
      return {
        success: false,
        error: 'Failed to release expired slots'
      };
    }

    // Mark associated pending payments as 'failed' (user cancelled/exited)
    let paymentsUpdated = 0;
    if (pendingPaymentLocks.length > 0) {
      const orderIds = pendingPaymentLocks.map(lock => lock.order_id).filter(Boolean);
      
      if (orderIds.length > 0) {
        const { error: paymentUpdateError, count } = await supabaseAdmin
          .from('payments')
          .update({
            status: 'failed',
            completed_at: now
          })
          .in('razorpay_order_id', orderIds)
          .eq('status', 'pending')
          .select('id', { count: 'exact', head: true });

        if (paymentUpdateError) {
          console.error('❌ Error updating pending payments to failed:', paymentUpdateError);
        } else {
          paymentsUpdated = count || 0;
          if (paymentsUpdated > 0) {
            console.log(`✅ Marked ${paymentsUpdated} abandoned pending payments as 'failed'`);
          }
        }
      }
    }

    console.log(`✅ Released ${locksToRelease.length} expired/failed slot locks`);
    return {
      success: true,
      released: locksToRelease.length,
      paymentsUpdated: paymentsUpdated
    };
  } catch (error) {
    console.error('❌ Exception in releaseExpiredSlots:', error);
    return {
      success: false,
      error: error.message || 'Failed to release expired slots'
    };
  }
};

/**
 * Cleanup old pending payments that have no active slot locks
 * This handles cases where payments were abandoned but slot locks were already cleaned up
 * 
 * @returns {Promise<Object>} { success: boolean, updated: number, error?: string }
 */
const cleanupAbandonedPendingPayments = async () => {
  try {
    // Find pending payments older than 10 minutes (slot lock expiry is 5 minutes, so 10 is safe)
    const tenMinutesAgo = new Date();
    tenMinutesAgo.setMinutes(tenMinutesAgo.getMinutes() - 10);
    
    const { data: oldPendingPayments, error: findError } = await supabaseAdmin
      .from('payments')
      .select('id, razorpay_order_id, created_at')
      .eq('status', 'pending')
      .lt('created_at', tenMinutesAgo.toISOString())
      .limit(100); // Limit to avoid too many queries

    if (findError) {
      console.error('❌ Error finding old pending payments:', findError);
      return {
        success: false,
        error: 'Failed to find old pending payments'
      };
    }

    if (!oldPendingPayments || oldPendingPayments.length === 0) {
      return {
        success: true,
        updated: 0
      };
    }

    // Batch lookup: collect order IDs and fetch matching slot_locks in one query
    const orderIds = oldPendingPayments.map(p => p.razorpay_order_id).filter(Boolean);
    const abandonedPayments = [];
    if (orderIds.length > 0) {
      const { data: matchingLocks } = await supabaseAdmin
        .from('slot_locks')
        .select('order_id')
        .in('order_id', orderIds)
        .in('status', ['SLOT_HELD', 'PAYMENT_PENDING']);
      const lockedOrderIds = new Set((matchingLocks || []).map(l => l.order_id));
      for (const orderId of orderIds) {
        if (!lockedOrderIds.has(orderId)) {
          abandonedPayments.push(orderId);
        }
      }
    }

    if (abandonedPayments.length === 0) {
      return {
        success: true,
        updated: 0
      };
    }

    // Mark abandoned payments as failed
    const now = new Date().toISOString();
    const { error: updateError, count } = await supabaseAdmin
      .from('payments')
      .update({
        status: 'failed',
        completed_at: now
      })
      .in('razorpay_order_id', abandonedPayments)
      .eq('status', 'pending')
      .select('id', { count: 'exact', head: true });

    if (updateError) {
      console.error('❌ Error updating abandoned payments:', updateError);
      return {
        success: false,
        error: 'Failed to update abandoned payments'
      };
    }

    const updated = count || 0;
    if (updated > 0) {
      console.log(`✅ Marked ${updated} abandoned pending payments as 'failed'`);
    }

    return {
      success: true,
      updated: updated
    };
  } catch (error) {
    console.error('❌ Exception in cleanupAbandonedPendingPayments:', error);
    return {
      success: false,
      error: error.message || 'Failed to cleanup abandoned payments'
    };
  }
};

module.exports = {
  holdSlot,
  updateSlotLockStatus,
  getSlotLockByOrderId,
  releaseSlotLock,
  releaseExpiredSlots,
  cleanupAbandonedPendingPayments,
  extendSlotLock,
  checkPaymentOrderMatchesLock,
  SLOT_HOLD_DURATION_MINUTES
};

