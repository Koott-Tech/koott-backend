/**
 * Recovery Job
 * 
 * Background job that recovers failed session creations.
 * 
 * This job:
 * - Finds payments that succeeded but sessions weren't created
 * - Retries session creation idempotently
 * - Runs every 5 minutes
 * - Logs all recovery attempts
 */

const { supabaseAdmin } = require('../config/supabase');
const { getSlotLockByOrderId, updateSlotLockStatus } = require('../services/slotLockService');
const { createSessionFromSlotLock } = require('../services/sessionCreationService');
const userInteractionLogger = require('../utils/userInteractionLogger');

let advisoryLockUnavailableLogged = false;

/**
 * Acquire distributed lock for recovery job
 * Uses database-based advisory lock to prevent concurrent execution across instances
 * @param {string} lockKey - Lock identifier
 * @param {number} timeoutSeconds - Lock timeout in seconds (default: 300 = 5 minutes) - currently unused, reserved for future TTL implementation
 * @returns {Promise<{acquired: boolean, lockId?: string}>}
 */
const acquireDistributedLock = async (lockKey = 'recovery_job', timeoutSeconds = 300) => {
  // Note: timeoutSeconds parameter is reserved for future TTL/timeout implementation
  // Currently PostgreSQL advisory locks are released when the connection closes or explicitly unlocked
  try {
    // Use PostgreSQL advisory lock (pg_advisory_lock) for distributed locking
    // Lock ID is derived from lockKey hash
    const crypto = require('crypto');
    const lockId = parseInt(crypto.createHash('sha256').update(lockKey).digest('hex').substring(0, 8), 16) % 2147483647;
    
    // Try to acquire lock (non-blocking)
    const { data, error } = await supabaseAdmin.rpc('pg_try_advisory_lock', {
      lock_id: lockId
    });
    
    if (error) {
      const functionNotFound = error.code === '42883' || error.code === 'PGRST202' ||
        (error.message && error.message.includes('Could not find the function'));
      if (functionNotFound) {
        // Function doesn't exist or not exposed by PostgREST - fail-safe: don't allow concurrent runs
        if (!advisoryLockUnavailableLogged) {
          advisoryLockUnavailableLogged = true;
          console.error('❌ CRITICAL: pg_try_advisory_lock not available. Recovery job will not run to prevent concurrent execution. Run supabase-advisory-lock-functions.sql in Supabase SQL Editor to enable distributed locking.');
        }
        return { acquired: false, lockId: null }; // Fail-safe: prevent execution
      }
      console.error('❌ Error acquiring distributed lock:', error);
      return { acquired: false };
    }
    
    // RPC returns boolean indicating if lock was acquired
    const acquired = data === true || data === 'true' || (typeof data === 'object' && data?.acquired === true);
    
    // Do not use setTimeout to auto-unlock; only releaseDistributedLock in the job's finally block should release the lock (avoids releasing a lock held by another instance).
    return { acquired, lockId: acquired ? String(lockId) : null };
  } catch (error) {
    console.error('❌ Exception acquiring distributed lock:', error);
    return { acquired: false };
  }
};

/**
 * Release distributed lock
 * @param {string} lockId - Lock ID returned from acquireDistributedLock
 * @returns {Promise<void>}
 */
const releaseDistributedLock = async (lockId) => {
  if (!lockId) return; // No lock to release (fallback mode)
  
  try {
    await supabaseAdmin.rpc('pg_advisory_unlock', { lock_id: parseInt(lockId) });
  } catch (error) {
    const ignore = error.code === '42883' || error.code === 'PGRST202' ||
      (error.message && error.message.includes('Could not find the function'));
    if (!ignore) {
      console.error('❌ Error releasing distributed lock:', error);
    }
  }
};

/**
 * Run recovery job
 * 
 * Finds slot locks with PAYMENT_SUCCESS status but no session,
 * and attempts to create the session.
 * 
 * @returns {Promise<Object>} { success: boolean, processed: number, errors: number }
 */
const runRecoveryJob = async () => {
  // Acquire distributed lock to prevent concurrent execution
  const lockResult = await acquireDistributedLock('recovery_job', 300); // 5 minute timeout
  
  if (!lockResult.acquired) {
    if (process.env.NODE_ENV !== 'production') {
      console.log('⏸️ Recovery job already running in another instance, skipping');
    }
    return {
      success: true,
      processed: 0,
      errors: 0,
      skipped: true,
      reason: 'Lock already held by another instance'
    };
  }
  
  try {
    // Only log in non-production to reduce log noise
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔄 Starting recovery job...');
    }
    const startTime = Date.now();

    // Find slot locks that have PAYMENT_SUCCESS but no session created
    // Check for locks updated in last 24 hours (to avoid processing very old ones)
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const { data: slotLocks, error: findError } = await supabaseAdmin
      .from('slot_locks')
      .select('id, order_id, psychologist_id, client_id, scheduled_date, scheduled_time, status, updated_at, recovery_attempts')
      .eq('status', 'PAYMENT_SUCCESS')
      .gte('updated_at', twentyFourHoursAgo.toISOString())
      .order('updated_at', { ascending: true })
      .limit(50); // Process max 50 at a time

    if (findError) {
      console.error('❌ Error finding slot locks for recovery:', findError);
      return {
        success: false,
        processed: 0,
        errors: 1,
        error: findError.message
      };
    }

    if (!slotLocks || slotLocks.length === 0) {
      // Only log in non-production to reduce log noise
      if (process.env.NODE_ENV !== 'production') {
        console.log('✅ No slot locks need recovery');
      }
      return {
        success: true,
        processed: 0,
        errors: 0
      };
    }

    console.log(`📋 Found ${slotLocks.length} slot locks needing recovery`);

    let processed = 0;
    let errors = 0;
    const results = [];

    // Process each slot lock
    for (const slotLock of slotLocks) {
      try {
        console.log(`🔄 Processing slot lock: ${slotLock.id} (order: ${slotLock.order_id?.substring(0, 10)}...)`);

        // Verify payment record exists and is successful
        const { data: paymentRecord, error: paymentError } = await supabaseAdmin
          .from('payments')
          .select('id, status, session_id')
          .eq('razorpay_order_id', slotLock.order_id)
          .maybeSingle();

        if (paymentError) {
          console.error(`❌ DB error fetching payment for order ${slotLock.order_id}:`, paymentError);
          errors++;
          results.push({
            slotLockId: slotLock.id,
            orderId: slotLock.order_id,
            status: 'payment_lookup_error',
            error: paymentError.message
          });
          continue;
        }

        if (!paymentRecord) {
          console.warn(`⚠️ Payment record not found for order: ${slotLock.order_id}`);
          // Set slot_lock status to terminal value to prevent infinite retries
          await updateSlotLockStatus(slotLock.order_id, 'RECOVERY_FAILED');
          errors++;
          results.push({
            slotLockId: slotLock.id,
            orderId: slotLock.order_id,
            status: 'payment_not_found'
          });
          continue;
        }

        if (paymentRecord.status !== 'success') {
          console.warn(`⚠️ Payment not successful for order: ${slotLock.order_id}`);
          // Set slot_lock status to terminal value to prevent infinite retries
          await updateSlotLockStatus(slotLock.order_id, 'RECOVERY_FAILED');
          errors++;
          results.push({
            slotLockId: slotLock.id,
            orderId: slotLock.order_id,
            status: 'payment_not_successful'
          });
          continue;
        }

        // Check if session already exists
        if (paymentRecord.session_id) {
          const { data: session, error: sessionError } = await supabaseAdmin
            .from('sessions')
            .select('id')
            .eq('id', paymentRecord.session_id)
            .maybeSingle();

          if (sessionError) {
            console.error(`❌ DB error fetching session ${paymentRecord.session_id}:`, sessionError);
            errors++;
            results.push({
              slotLockId: slotLock.id,
              orderId: slotLock.order_id,
              status: 'session_lookup_error',
              error: sessionError.message
            });
            continue;
          }

          if (session) {
            console.log(`✅ Session already exists: ${session.id}`);
            const updateResult = await updateSlotLockStatus(slotLock.order_id, 'SESSION_CREATED');
            if (!updateResult || updateResult.success === false) {
              console.error(`❌ Failed to update slot lock status for ${slotLock.order_id}:`, updateResult?.error);
              errors++;
              results.push({
                slotLockId: slotLock.id,
                orderId: slotLock.order_id,
                status: 'update_failed',
                error: updateResult?.error || 'Failed to update slot lock status'
              });
              continue;
            }
            processed++;
            results.push({
              slotLockId: slotLock.id,
              orderId: slotLock.order_id,
              status: 'session_already_exists',
              sessionId: session.id
            });
            continue;
          }
        }

        // Attempt to create session
        const sessionResult = await createSessionFromSlotLock(slotLock);

        if (sessionResult.success) {
          console.log(`✅ Session created successfully: ${sessionResult.session?.id}`);
          processed++;
          results.push({
            slotLockId: slotLock.id,
            orderId: slotLock.order_id,
            status: 'session_created',
            sessionId: sessionResult.session?.id
          });

          // Log recovery success
          try {
            await userInteractionLogger.logInteraction({
              userId: slotLock.client_id,
              userRole: 'client',
              action: 'recovery_job_session_created',
              status: 'success',
              details: {
                slotLockId: slotLock.id,
                orderId: slotLock.order_id?.substring(0, 10) + '...',
                sessionId: sessionResult.session?.id
              }
            });
          } catch (logError) {
            console.error('❌ Error logging recovery success:', logError);
            // Don't fail the job due to logging errors
          }
        } else {
          console.error(`❌ Failed to create session: ${sessionResult.error}`);
          errors++;
          
          // Check if error is permanent using structured indicators from createSessionFromSlotLock
          // Only consult sessionResult.isPermanent and sessionResult.code (no substring matching)
          const isPermanentError = sessionResult.isPermanent === true || 
            sessionResult.code === 'VALIDATION_ERROR' ||
            sessionResult.code === 'PERMANENT_FAILURE' ||
            sessionResult.code === 'PAYMENT_NOT_FOUND' ||
            sessionResult.code === 'DOUBLE_BOOKING';

          // Increment retry counter
          const currentAttempts = (slotLock.recovery_attempts || 0) + 1;
          const MAX_RECOVERY_ATTEMPTS = 5; // Maximum retry attempts before marking as failed

          // Update slot lock with retry count and status
          if (isPermanentError || currentAttempts >= MAX_RECOVERY_ATTEMPTS) {
            // Mark as permanently failed
            const { data: updateData, error: updateError } = await supabaseAdmin
              .from('slot_locks')
              .update({
                status: 'RECOVERY_FAILED',
                recovery_attempts: currentAttempts,
                updated_at: new Date().toISOString()
              })
              .eq('id', slotLock.id)
              .select('id')
              .single();
            
            if (updateError) {
              console.error(`❌ Failed to update slot lock ${slotLock.id} status to RECOVERY_FAILED:`, updateError);
              // Log error but continue - don't throw to avoid breaking the job
            } else {
              console.log(`❌ Marked slot lock ${slotLock.id} as RECOVERY_FAILED (permanent error or max attempts reached)`);
            }
          } else {
            // Increment retry counter but keep status as PAYMENT_SUCCESS for retry
            const { data: updateData, error: updateError } = await supabaseAdmin
              .from('slot_locks')
              .update({
                recovery_attempts: currentAttempts,
                updated_at: new Date().toISOString()
              })
              .eq('id', slotLock.id)
              .select('id')
              .single();
            
            if (updateError) {
              console.error(`❌ Failed to update slot lock ${slotLock.id} recovery_attempts:`, updateError);
              // Log error but continue - don't throw to avoid breaking the job
            } else {
              console.log(`⚠️ Incremented recovery attempts for slot lock ${slotLock.id}: ${currentAttempts}/${MAX_RECOVERY_ATTEMPTS}`);
            }
          }

          results.push({
            slotLockId: slotLock.id,
            orderId: slotLock.order_id,
            status: isPermanentError || currentAttempts >= MAX_RECOVERY_ATTEMPTS ? 'recovery_failed' : 'session_creation_failed',
            error: sessionResult.error,
            recoveryAttempts: currentAttempts,
            isPermanent: isPermanentError
          });

          // Log recovery failure
          try {
            await userInteractionLogger.logInteraction({
              userId: slotLock.client_id,
              userRole: 'client',
              action: 'recovery_job_session_failed',
              status: 'failure',
              details: {
                slotLockId: slotLock.id,
                orderId: slotLock.order_id?.substring(0, 10) + '...',
                error: sessionResult.error,
                recoveryAttempts: currentAttempts,
                isPermanent: isPermanentError
              }
            });
          } catch (logError) {
            console.error('❌ Error logging recovery failure:', logError);
            // Don't fail the job due to logging errors
          }
        }
      } catch (error) {
        console.error(`❌ Exception processing slot lock ${slotLock.id}:`, error);
        errors++;
        results.push({
          slotLockId: slotLock.id,
          orderId: slotLock.order_id,
          status: 'exception',
          error: error.message
        });
      }
    }

    const duration = Date.now() - startTime;
    // Only log if there's work done or errors, or in non-production
    if (processed > 0 || errors > 0 || process.env.NODE_ENV !== 'production') {
      console.log(`✅ Recovery job completed: ${processed} processed, ${errors} errors (${duration}ms)`);
    }

    return {
      success: true,
      processed,
      errors,
      results,
      duration
    };
  } catch (error) {
    console.error('❌ Exception in recovery job:', error);
    return {
      success: false,
      processed: 0,
      errors: 1,
      error: error.message
    };
  } finally {
    // Always release distributed lock
    await releaseDistributedLock(lockResult.lockId);
  }
};

let isRecoveryJobRunning = false;
let recoverySchedulerId = null; // Track the interval ID

/**
 * Start recovery job scheduler
 * 
 * Runs recovery job every 5 minutes
 * Idempotent: can be called multiple times safely
 * 
 * @param {number} intervalMinutes - Interval in minutes (default: 5)
 * @returns {Object} { stop: function } - Handle with stop method to stop the scheduler
 */
const startRecoveryScheduler = (intervalMinutes = 5) => {
  // Idempotent: if scheduler is already running, return existing handle
  if (recoverySchedulerId !== null) {
    if (process.env.NODE_ENV !== 'production') {
      console.log('⏰ Recovery job scheduler already running, returning existing handle');
    }
    return {
      stop: () => {
        if (recoverySchedulerId !== null) {
          clearInterval(recoverySchedulerId);
          recoverySchedulerId = null;
          if (process.env.NODE_ENV !== 'production') {
            console.log('⏹️ Recovery job scheduler stopped');
          }
        }
      }
    };
  }

  // Only log startup in non-production
  if (process.env.NODE_ENV !== 'production') {
    console.log(`⏰ Starting recovery job scheduler (every ${intervalMinutes} minutes)`);
  }

  // Run immediately on start
  const runWithGuard = () => {
    if (isRecoveryJobRunning) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('⏸️ Recovery job already running, skipping');
      }
      return;
    }
    isRecoveryJobRunning = true;
    runRecoveryJob()
      .catch(err => {
        console.error('❌ Error in recovery job:', err);
      })
      .finally(() => {
        isRecoveryJobRunning = false;
      });
  };

  runWithGuard();

  // Schedule recurring runs
  const intervalMs = intervalMinutes * 60 * 1000;
  recoverySchedulerId = setInterval(runWithGuard, intervalMs);

  // Return handle with stop method
  return {
    stop: () => {
      if (recoverySchedulerId !== null) {
        clearInterval(recoverySchedulerId);
        recoverySchedulerId = null;
        if (process.env.NODE_ENV !== 'production') {
          console.log('⏹️ Recovery job scheduler stopped');
        }
      }
    }
  };
};

module.exports = {
  runRecoveryJob,
  startRecoveryScheduler
};

