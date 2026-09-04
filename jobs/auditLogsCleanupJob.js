/**
 * Audit Logs Cleanup Job
 * 
 * Automatically deletes audit logs older than 1 week.
 * Runs weekly to keep the database clean.
 * 
 * This job:
 * - Deletes logs past AUDIT_LOG_RETENTION_DAYS (default 30), except booking-change
 *   actions which are kept for AUDIT_LOG_PROTECTED_RETENTION_DAYS (default 365)
 * - Runs weekly (every 7 days)
 * - Logs cleanup statistics
 */

const { supabaseAdmin } = require('../config/supabase');

/**
 * Run cleanup job
 * 
 * Deletes audit logs past retention, keeping booking-change actions far longer.
 * 
 * @returns {Promise<Object>} { success: boolean, deleted: number, error?: string }
 */
/**
 * Actions that answer "who changed this booking, and to what".
 *
 * Everything used to be deleted after 7 days. When a 4 Sept booking turned up with its
 * calendar an hour ahead of its session row, the change had happened on 17 Aug — eighteen
 * days earlier — and the record was gone, so the cause could not be established at all.
 * Cheap rows, and they are the only ones anyone ever goes looking for after the fact.
 */
const PROTECTED_ACTIONS = [
  'WIX_BOOKING_RESCHEDULED',
  'WIX_BOOKING_TRANSFERRED',
  'WIX_BOOKING_EDITED',
  'SESSION_UPDATED',
  'SESSION_RESCHEDULED',
  'SESSION_DELETED',
  'SESSION_CANCELLED',
];

const RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS || 30);
const PROTECTED_RETENTION_DAYS = Number(process.env.AUDIT_LOG_PROTECTED_RETENTION_DAYS || 365);

const runAuditLogsCleanup = async () => {
  try {
    console.log('🧹 Starting audit logs cleanup job...');
    const startTime = Date.now();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffDate = cutoff.toISOString();

    // Booking-change entries survive far longer than the rest: they are the audit trail for
    // a slot that can be lost, and questions about them arrive weeks late.
    const protectedCutoff = new Date();
    protectedCutoff.setDate(protectedCutoff.getDate() - PROTECTED_RETENTION_DAYS);
    const protectedCutoffDate = protectedCutoff.toISOString();
    const protectedList = `(${PROTECTED_ACTIONS.join(',')})`;

    console.log(`🧹 retention: ${RETENTION_DAYS}d general, ${PROTECTED_RETENTION_DAYS}d for ${PROTECTED_ACTIONS.length} protected action(s)`);

    // First, count how many logs will be deleted
    const { count, error: countError } = await supabaseAdmin
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .or(`and(timestamp.lt.${cutoffDate},action.not.in.${protectedList}),and(timestamp.lt.${protectedCutoffDate},action.in.${protectedList})`);

    if (countError) {
      console.error('❌ Error counting audit logs:', countError);
      return {
        success: false,
        deleted: 0,
        error: countError.message
      };
    }

    const logsToDelete = count || 0;

    if (logsToDelete === 0) {
      console.log(`✅ No audit logs to clean up (all within retention)`);
      return {
        success: true,
        deleted: 0
      };
    }

    console.log(`📋 Found ${logsToDelete} audit log(s) past retention`);

    // Batched deletion to avoid long transactions/timeouts
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const { data: deletedRows, error: deleteError } = await supabaseAdmin
        .from('audit_logs')
        .delete()
        .or(`and(timestamp.lt.${cutoffDate},action.not.in.${protectedList}),and(timestamp.lt.${protectedCutoffDate},action.in.${protectedList})`)
        .limit(BATCH_SIZE)
        .select('id');

      if (deleteError) {
        console.error('❌ Error deleting audit logs:', deleteError);
        return {
          success: false,
          deleted: totalDeleted,
          error: deleteError.message
        };
      }

      const deletedCount = deletedRows?.length || 0;
      totalDeleted += deletedCount;
      hasMore = deletedCount === BATCH_SIZE; // If we got a full batch, there might be more
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Audit logs cleanup completed: Deleted ${totalDeleted} log(s) (${duration}ms)`);

    return {
      success: true,
      deleted: totalDeleted,
      duration
    };
  } catch (error) {
    console.error('❌ Exception in audit logs cleanup job:', error);
    return {
      success: false,
      deleted: 0,
      error: error.message
    };
  }
};

/**
 * Start cleanup job scheduler
 * 
 * Runs cleanup job weekly (every 7 days)
 * 
 * @param {number} intervalDays - Interval in days (default: 7)
 * @returns {Function} Stop function to cancel the scheduler
 */
const startAuditLogsCleanupScheduler = (intervalDays = 7) => {
  console.log(`⏰ Starting audit logs cleanup scheduler (every ${intervalDays} days)`);

  let intervalId = null;
  let inFlightPromise = null;

  // Run immediately on start
  inFlightPromise = runAuditLogsCleanup().catch(err => {
    console.error('❌ Error in initial audit logs cleanup run:', err);
  });

  // Schedule recurring runs (weekly)
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  intervalId = setInterval(() => {
    inFlightPromise = runAuditLogsCleanup().catch(err => {
      console.error('❌ Error in scheduled audit logs cleanup:', err);
    });
  }, intervalMs);

  // Return stop function
  return function stopAuditLogsCleanup() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    // Note: inFlightPromise will complete naturally, we don't cancel it
  };
};

module.exports = {
  runAuditLogsCleanup,
  startAuditLogsCleanupScheduler
};

// Export stop function separately for convenience
module.exports.stopAuditLogsCleanupScheduler = function(stopFn) {
  if (stopFn && typeof stopFn === 'function') {
    stopFn();
  }
};