/**
 * Security Logs Cleanup Job
 * 
 * Automatically deletes security logs older than the retention period.
 * Runs weekly to keep the database clean.
 * 
 * This job:
 * - Deletes logs older than retention period (default 90 days)
 * - Runs weekly (every 7 days)
 * - Logs cleanup statistics
 */

const { supabaseAdmin } = require('../config/supabase');

/**
 * Run cleanup job
 * 
 * Deletes security logs older than retention period (default 90 days)
 * 
 * @returns {Promise<Object>} { success: boolean, deleted: number, error?: string }
 */
const runSecurityLogsCleanup = async () => {
  try {
    console.log('🧹 Starting security logs cleanup job...');
    const startTime = Date.now();

    // Configurable retention (default 90 days for audits)
    // NOTE: 90 days may not meet regulatory requirements (e.g., GDPR, HIPAA, SOX).
    // Retention defaults must be reviewed with compliance/legal team.
    // Common compliance thresholds: GDPR (varies), HIPAA (6 years), SOX (7 years).
    // SECURITY_LOG_RETENTION_DAYS should be set based on your organization's legal/compliance requirements.
    const retentionDays = parseInt(process.env.SECURITY_LOG_RETENTION_DAYS, 10);
    // Increased maximum to 3650 days (10 years) to meet HIPAA/SOX compliance requirements
    // Common compliance thresholds: GDPR (varies), HIPAA (6 years), SOX (7 years)
    const validRetention = Number.isFinite(retentionDays) && retentionDays >= 1 && retentionDays <= 3650
      ? retentionDays
      : 90;
    if (retentionDays !== validRetention) {
      if (Number.isFinite(retentionDays)) {
        console.warn(`⚠️ Invalid SECURITY_LOG_RETENTION_DAYS (${retentionDays}), using default ${validRetention}`);
      } else {
        console.log(`ℹ️ SECURITY_LOG_RETENTION_DAYS not set, using default ${validRetention} days`);
      }
    }
    
    // Warn if retention is below common compliance thresholds (1 year)
    if (validRetention < 365) {
      console.warn(`⚠️ SECURITY_LOG_RETENTION_DAYS is set to ${validRetention} days, which may not meet regulatory requirements. Please review with compliance/legal team. Current value: ${validRetention} days.`);
    }
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - validRetention);
    const cutoffDateStr = cutoffDate.toISOString();

    // Perform batched deletes to avoid OOM/timeouts with large datasets
    let totalDeleted = 0;
    const batchSize = 1000;
    let hasMore = true;

    while (hasMore) {
      // Select only IDs older than cutoff with small limit
      const { data: idsToDelete, error: selectError } = await supabaseAdmin
        .from('security_logs')
        .select('id')
        .lt('timestamp', cutoffDateStr)
        .limit(batchSize);

      if (selectError) {
        // Table may not exist (e.g. project uses audit_logs instead); skip cleanup without failing
        if (selectError.code === 'PGRST205' || selectError.code === '42P01' || (selectError.message && selectError.message.includes("security_logs") && selectError.message.includes("not found"))) {
          console.log('ℹ️ security_logs table not found, skipping cleanup (table may not be created or use audit_logs).');
          return { success: true, deleted: 0 };
        }
        console.error('❌ Error selecting security logs for deletion:', selectError);
        return {
          success: false,
          deleted: totalDeleted,
          error: selectError.message
        };
      }

      if (!idsToDelete || idsToDelete.length === 0) {
        hasMore = false;
        break;
      }

      // Delete by IDs using IN clause
      const ids = idsToDelete.map(row => row.id);
      const { error: deleteError } = await supabaseAdmin
        .from('security_logs')
        .delete()
        .in('id', ids);

      if (deleteError) {
        console.error('❌ Error deleting batch of security logs:', deleteError);
        return {
          success: false,
          deleted: totalDeleted,
          error: deleteError.message
        };
      }

      totalDeleted += ids.length;
      hasMore = ids.length === batchSize; // Continue if we got a full batch
    }

    const actualDeleted = totalDeleted;

    if (actualDeleted === 0) {
      console.log(`✅ No security logs to clean up (all logs are within ${validRetention} day(s))`);
      return {
        success: true,
        deleted: 0
      };
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Security logs cleanup completed: Deleted ${actualDeleted} log(s) (${duration}ms)`);

    return {
      success: true,
      deleted: actualDeleted,
      duration
    };
  } catch (error) {
    console.error('❌ Exception in security logs cleanup job:', error);
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
 * @returns {number} Interval ID for clearInterval (graceful shutdown)
 */
const startSecurityLogsCleanupScheduler = (intervalDays = 7) => {
  // Validate intervalDays parameter (min 1, max 24 to avoid setInterval overflow)
  const validatedIntervalDays = Number.isFinite(intervalDays) && intervalDays >= 1 && intervalDays <= 24 && Number.isInteger(intervalDays)
    ? intervalDays
    : 7;
  
  if (intervalDays !== validatedIntervalDays) {
    console.warn(`⚠️ Invalid intervalDays (${intervalDays}), using default ${validatedIntervalDays}`);
  }

  console.log(`⏰ Starting security logs cleanup scheduler (every ${validatedIntervalDays} days)`);

  // Run immediately on start
  runSecurityLogsCleanup().catch(err => {
    console.error('❌ Error in initial security logs cleanup run:', err);
  });

  // Schedule recurring runs (weekly)
  const intervalMs = validatedIntervalDays * 24 * 60 * 60 * 1000;
  const intervalId = setInterval(() => {
    runSecurityLogsCleanup().catch(err => {
      console.error('❌ Error in scheduled security logs cleanup:', err);
    });
  }, intervalMs);

  return intervalId;
};

module.exports = {
  runSecurityLogsCleanup,
  startSecurityLogsCleanupScheduler
};

