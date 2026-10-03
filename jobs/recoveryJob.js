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

const LOCK_TABLE = 'job_locks';
const INSTANCE_ID = `${process.env.RENDER_INSTANCE_ID || process.pid}@${Date.now().toString(36)}`;
let lockTableMissingLogged = false;

/**
 * Claim a lease lock for a job.
 *
 * Previously this called an RPC `pg_try_advisory_lock` that does not exist in this project,
 * so the lock could never be acquired and runRecoveryJob returned early EVERY time — the
 * recovery job has effectively been switched off. See migration 20261003110000_job_locks.sql
 * for why a lease row is used instead of a Postgres advisory lock (PostgREST pools
 * connections, so advisory locks can be orphaned and block the job forever).
 *
 * The claim is one conditional UPDATE, which Postgres applies atomically: exactly one caller
 * can match `locked_until < now()` and get a row back.
 *
 * @param {string} lockKey
 * @param {number} timeoutSeconds how long the lease is held before it self-expires
 * @returns {Promise<{acquired: boolean, lockId?: string}>}
 */
const acquireDistributedLock = async (lockKey = 'recovery_job', timeoutSeconds = 300) => {
  try {
    const nowIso = new Date().toISOString();
    const untilIso = new Date(Date.now() + timeoutSeconds * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from(LOCK_TABLE)
      .update({ locked_until: untilIso, locked_by: INSTANCE_ID, updated_at: nowIso })
      .eq('job_name', lockKey)
      .lt('locked_until', nowIso)
      .select('job_name');

    if (error) {
      const tableMissing = error.code === '42P01' || error.code === 'PGRST205' ||
        (error.message && /could not find the table|does not exist/i.test(error.message));
      if (tableMissing) {
        // Migration not applied yet. Fall back to the in-process guard in
        // startRecoveryScheduler, which is correct for a single instance.
        //
        // This deliberately fails OPEN where the old code failed closed: failing closed is
        // what disabled the job, and a paid booking with no session row is a worse outcome
        // than the small chance of two instances overlapping during a deploy (createSession
        // FromSlotLock re-checks for an existing session before creating one).
        if (!lockTableMissingLogged) {
          lockTableMissingLogged = true;
          console.warn(
            `⚠️ ${LOCK_TABLE} is missing — running the recovery job with in-process locking only. Apply supabase/migrations/20261003110000_job_locks.sql for cross-instance safety.`
          );
        }
        return { acquired: true, lockId: null };
      }
      console.error('❌ Error acquiring job lock:', error);
      return { acquired: false };
    }

    // Empty result = the conditional UPDATE matched nothing = someone else holds the lease.
    const acquired = Array.isArray(data) && data.length > 0;
    return { acquired, lockId: acquired ? lockKey : null };
  } catch (error) {
    console.error('❌ Exception acquiring job lock:', error);
    return { acquired: false };
  }
};

/**
 * Release the lease by expiring it immediately, so the next tick can claim it rather than
 * waiting out the full timeout.
 * @param {string|null} lockId
 */
const releaseDistributedLock = async (lockId) => {
  if (!lockId) return; // fallback mode — nothing was claimed

  try {
    const nowIso = new Date().toISOString();
    // Expire one second in the PAST, not at `now`: a claim uses `locked_until < now()`, and a
    // release stamped with the current instant is not strictly less than a claim made in the
    // same millisecond, which would make the next tick skip for no reason.
    const expiredIso = new Date(Date.now() - 1000).toISOString();
    const { error } = await supabaseAdmin
      .from(LOCK_TABLE)
      .update({ locked_until: expiredIso, updated_at: nowIso })
      .eq('job_name', lockId)
      // Only clear OUR lease: if ours already expired and another instance claimed it,
      // this matches nothing and we leave their lock alone.
      .eq('locked_by', INSTANCE_ID);
    if (error) console.error('❌ Error releasing job lock:', error);
  } catch (error) {
    console.error('❌ Exception releasing job lock:', error);
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

