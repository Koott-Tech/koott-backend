const { performWixSync } = require('../controllers/wixBookingsController');

let timer = null;
let isRunning = false;
let runStartedAt = 0;
let blockedTickCount = 0;

function getIntervalMs() {
  const sec = Number.parseInt(String(process.env.WIX_SYNC_INTERVAL_SECONDS || '60'), 10);
  const saneSeconds = Number.isFinite(sec) ? Math.min(3600, Math.max(15, sec)) : 60;
  return saneSeconds * 1000;
}

async function runOnce(source = 'interval') {
  const intervalMs = getIntervalMs();
  const stuckThresholdMs = intervalMs * 2;

  if (isRunning) {
    const runningForMs = Date.now() - runStartedAt;
    blockedTickCount += 1;
    console.warn(
      `[wixRealtimeSyncService] ${source}: skipped — previous run in-flight for ${Math.round(
        runningForMs / 1000
      )}s (blocked ticks: ${blockedTickCount})`
    );
    // Watchdog: if the prior run has been "running" for >2x interval, assume it
    // crashed without clearing the lock and force-reset so we don't stall forever.
    if (runningForMs > stuckThresholdMs) {
      console.error(
        `[wixRealtimeSyncService] watchdog: force-resetting stuck lock after ${Math.round(
          runningForMs / 1000
        )}s`
      );
      isRunning = false;
      blockedTickCount = 0;
    } else {
      return;
    }
  }

  isRunning = true;
  runStartedAt = Date.now();
  blockedTickCount = 0;
  try {
    const result = await performWixSync();
    const tookMs = Date.now() - runStartedAt;
    console.log(
      `[wixRealtimeSyncService] ${source}: synced ${result.upserted} booking(s) in ${tookMs}ms`
    );
  } catch (e) {
    if (e.code === 'WIX_CONFIG_MISSING') {
      console.warn('[wixRealtimeSyncService] skipped: Wix env not configured');
    } else {
      console.error('[wixRealtimeSyncService] sync failed:', e.message || e);
    }
  } finally {
    isRunning = false;
    runStartedAt = 0;
  }
}

function start() {
  const shouldStart = String(process.env.WIX_SYNC_AUTOSTART || 'true').toLowerCase() !== 'false';
  if (!shouldStart) {
    console.log('[wixRealtimeSyncService] autostart disabled');
    return;
  }
  if (timer) return;

  const intervalMs = getIntervalMs();
  console.log(`[wixRealtimeSyncService] started (interval ${intervalMs / 1000}s)`);
  runOnce('startup').catch(() => {});
  timer = setInterval(() => {
    runOnce('interval').catch(() => {});
  }, intervalMs);
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  runOnce,
};
