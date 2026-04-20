const { performWixSync } = require('../controllers/wixBookingsController');

let timer = null;
let isRunning = false;

function getIntervalMs() {
  const sec = Number.parseInt(String(process.env.WIX_SYNC_INTERVAL_SECONDS || '60'), 10);
  const saneSeconds = Number.isFinite(sec) ? Math.min(3600, Math.max(15, sec)) : 60;
  return saneSeconds * 1000;
}

async function runOnce(source = 'interval') {
  if (isRunning) return;
  isRunning = true;
  try {
    const result = await performWixSync();
    console.log(`[wixRealtimeSyncService] ${source}: synced ${result.upserted} booking(s)`);
  } catch (e) {
    if (e.code === 'WIX_CONFIG_MISSING') {
      console.warn('[wixRealtimeSyncService] skipped: Wix env not configured');
    } else {
      console.error('[wixRealtimeSyncService] sync failed:', e.message || e);
    }
  } finally {
    isRunning = false;
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
