/**
 * Audit Logs Cleanup Job
 * 
 * Automatically deletes audit logs older than 1 week.
 * Runs weekly to keep the database clean.
 * 
 * This job:
 * - Deletes logs older than 7 days
 * - Runs weekly (every 7 days)
 * - Logs cleanup statistics
 */

const { supabaseAdmin } = require('../config/supabase');

/**
 * Run cleanup job
 * 
 * Deletes audit logs older than 1 week (7 days)
 * 
 * @returns {Promise<Object>} { success: boolean, deleted: number, error?: string }
 */
const runAuditLogsCleanup = async () => {
  try {
    console.log('🧹 Starting audit logs cleanup job...');
    const startTime = Date.now();

    // Calculate cutoff date (7 days ago)
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const cutoffDate = oneWeekAgo.toISOString();

    // First, count how many logs will be deleted
    const { count, error: countError } = await supabaseAdmin
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .lt('timestamp', cutoffDate);

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
      console.log('✅ No audit logs to clean up (all logs are within 1 week)');
      return {
        success: true,
        deleted: 0
      };
    }

    console.log(`📋 Found ${logsToDelete} audit log(s) older than 1 week`);

    // Batched deletion to avoid long transactions/timeouts
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const { data: deletedRows, error: deleteError } = await supabaseAdmin
        .from('audit_logs')
        .delete()
        .lt('timestamp', cutoffDate)
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