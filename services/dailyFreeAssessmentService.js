const cron = require('node-cron');
const freeAssessmentAvailabilityService = require('../utils/freeAssessmentAvailabilityService');

class DailyFreeAssessmentService {
  constructor() {
    this.isRunning = false;
    this.dailyFreeAssessmentTask = null; // Store cron task reference
  }

  /**
   * Start the daily free assessment availability service
   * Runs every day at 12:00 AM to add the next day (3 weeks from today)
   */
  start() {
    console.log('🔄 Starting Daily Free Assessment Availability Service...');
    
    // Run every day at 12:00 AM (midnight)
    // Cron format: '0 0 * * *' = minute 0, hour 0, every day, every month, every day of week
    this.dailyFreeAssessmentTask = cron.schedule('0 0 * * *', async () => {
      if (this.isRunning) {
        console.log('⏭️  Daily free assessment availability update already running, skipping...');
        return;
      }
      
      this.isRunning = true;
      console.log('🕛 Running daily free assessment availability update (12:00 AM)...');
      
      try {
        // Step 1: Clean up past date config records
        console.log('\n🧹 Running daily cleanup of past free assessment date configs...');
        const cleanupResult = await freeAssessmentAvailabilityService.cleanupPastAvailability();
        if (cleanupResult.success) {
          console.log(`✅ Cleanup completed: ${cleanupResult.message}`);
          console.log(`   - Deleted: ${cleanupResult.deleted || 0} past records`);
        } else {
          console.error(`❌ Cleanup failed: ${cleanupResult.message}`);
        }

        // Step 2: Add next day availability (3 weeks from today)
        const result = await freeAssessmentAvailabilityService.addNextDayAvailability();
        if (result.success) {
          console.log(`✅ Daily free assessment availability update completed: ${result.message}`);
          console.log(`   - Updated: ${result.updated || 0} date configs`);
          console.log(`   - Skipped: ${result.skipped || 0} date configs`);
        } else {
          console.error(`❌ Daily free assessment availability update failed: ${result.message}`);
        }
      } catch (error) {
        console.error('❌ Error in daily free assessment availability update:', error);
      } finally {
        this.isRunning = false;
      }
    }, {
      timezone: 'UTC' // Ensure consistent execution across environments
    });

    // Also run immediately on startup (for testing/initial setup)
    // Reuse the same guarded job flow to avoid race conditions; capture timer id so stop() can cancel it
    const timeoutId = setTimeout(async () => {
      // Check if already running (cron might have started)
      if (this.isRunning) {
        console.log('⏭️  Daily free assessment availability update already running, skipping initial run...');
        return;
      }

      // Compute time until UTC midnight to match cron timezone ('UTC')
      const now = new Date();
      const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
      const msUntilMidnight = utcMidnight.getTime() - now.getTime();
      
      // Skip initial run if within 60 seconds of UTC midnight to avoid overlap with cron
      if (msUntilMidnight < 60000) {
        console.log('⏭️  Skipping initial run - too close to scheduled cron (within 60s)');
        return;
      }

      console.log('🔄 Running initial free assessment availability check...');
      this.isRunning = true;
      
      try {
        // Run cleanup then add next day (same as cron flow)
        const cleanupResult = await freeAssessmentAvailabilityService.cleanupPastAvailability();
        if (cleanupResult.success) {
          console.log(`✅ Initial cleanup completed: ${cleanupResult.message}`);
        } else {
          console.error(`❌ Initial cleanup failed: ${cleanupResult.message}`);
        }

        const result = await freeAssessmentAvailabilityService.addNextDayAvailability();
        if (result.success) {
          console.log(`✅ Initial free assessment availability check completed: ${result.message}`);
        } else {
          console.log(`⚠️  Initial free assessment availability check: ${result.message}`);
        }
      } catch (error) {
        console.error('❌ Error in initial free assessment availability check:', error);
      } finally {
        this.isRunning = false;
        this.initialTimeout = null; // Clear timeout ID when executed
      }
    }, 10000); // Wait 10 seconds after startup
    
    this.initialTimeout = timeoutId; // Store timeout ID for cancellation
  }

  /**
   * Stop the service (for testing or graceful shutdown)
   */
  stop() {
    console.log('🛑 Stopping Daily Free Assessment Availability Service...');
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.dailyFreeAssessmentTask) {
      this.dailyFreeAssessmentTask.stop();
      this.dailyFreeAssessmentTask = null;
    }
    this.isRunning = false;
  }
}

module.exports = new DailyFreeAssessmentService();
























