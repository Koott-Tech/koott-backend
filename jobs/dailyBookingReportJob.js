const cron = require('node-cron');
const { sendDailyBookingReport, istDate } = require('../services/dailyBookingReportService');

/**
 * Emails operations the daily booking report at midnight IST.
 *
 * The timezone is set explicitly: the server runs on UTC, so a bare '0 0 * * *' would fire at
 * 05:30 IST and the "day just starting" would already be half over.
 *
 * A catch-up run happens on boot because a deploy or restart that spans midnight would
 * otherwise skip that night entirely. sendDailyBookingReport records each date it sends, so
 * the catch-up cannot produce a second email.
 */
const startDailyBookingReportScheduler = () => {
  cron.schedule('0 0 * * *', () => {
    console.log('🕛 Daily booking report — midnight IST run');
    sendDailyBookingReport().catch((err) => console.error('[daily-report] scheduled run threw:', err?.message || err));
  }, { timezone: 'Asia/Kolkata' });

  setTimeout(() => {
    sendDailyBookingReport({ date: istDate() })
      .then((r) => { if (r?.skipped) console.log(`[daily-report] startup check: ${r.skipped}`); })
      .catch((err) => console.error('[daily-report] startup check threw:', err?.message || err));
  }, 90 * 1000);

  console.log('📅 Daily booking report scheduled for 00:00 Asia/Kolkata');
};

module.exports = { startDailyBookingReportScheduler };
