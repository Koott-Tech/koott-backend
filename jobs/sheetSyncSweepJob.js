/**
 * Catches completed sessions that never made it into their therapist's Google Sheet.
 *
 * completeSession writes to the sheet fire-and-forget, on purpose: a Google outage must not
 * turn a successful completion into an error the therapist sees. The cost of that choice is
 * that a failed write is silent — and `sheet_synced_at` was added to make it recoverable.
 * Nothing consumed it until now, so every miss stayed missed: on 3 Sept eleven therapists
 * completed 40 sessions and not one reached a sheet, which only surfaced because someone
 * happened to look.
 *
 * This sweep closes that loop. It also covers the window between a completion and a deploy,
 * and any period where the Google token is wrong — once the cause is fixed, the backlog
 * drains on its own instead of needing a manual backfill.
 */
const { supabaseAdmin } = require('../config/supabase');
const { syncSessionToSheet } = require('../services/sessionSheetSyncService');

const LOG_PREFIX = '[sheetSweep]';

// Sheets allows roughly 60 writes/minute per user and one session costs several calls, so the
// sweep is paced and capped rather than firing everything it finds. Whatever is left over is
// picked up by the next run — a backlog drains over a few passes instead of tripping a 429.
const PAUSE_MS = Number(process.env.SHEET_SWEEP_PAUSE_MS || 1300);
const MAX_PER_RUN = Number(process.env.SHEET_SWEEP_MAX_PER_RUN || 40);
// Far enough back to cover a long outage, short enough that the first run after deploy does
// not try to re-mirror the entire history (that is what scripts/backfill-all-sheets.js is for).
const LOOKBACK_DAYS = Number(process.env.SHEET_SWEEP_LOOKBACK_DAYS || 45);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSheetSyncSweep() {
  const started = Date.now();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: pending, error } = await supabaseAdmin
    .from('sessions')
    .select('id, scheduled_date, psychologist_id')
    .eq('status', 'completed')
    .is('sheet_synced_at', null)
    .gte('scheduled_date', since)
    .order('scheduled_date', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    console.error(`${LOG_PREFIX} could not list unsynced sessions:`, error.message);
    return { synced: 0, failed: 0, remaining: null, error };
  }
  if (!pending || pending.length === 0) {
    console.log(`${LOG_PREFIX} ✅ nothing pending (completed sessions since ${since})`);
    return { synced: 0, failed: 0, remaining: 0, error: null };
  }

  console.log(`${LOG_PREFIX} ${pending.length} completed session(s) missing from their sheet — syncing`);
  let synced = 0;
  let failed = 0;
  for (const s of pending) {
    try {
      const r = await syncSessionToSheet(s.id);
      if (r?.ok) {
        synced += 1;
      } else {
        failed += 1;
        console.warn(`${LOG_PREFIX} skipped ${s.id}: ${r?.reason || 'unknown reason'}`);
      }
    } catch (e) {
      failed += 1;
      console.error(`${LOG_PREFIX} failed ${s.id}: ${e?.message || e}`);
    }
    await sleep(PAUSE_MS);
  }

  // Report what is still outstanding so a persistent failure (bad token, revoked access) is
  // visible as a backlog that never shrinks, rather than as a quiet per-session warning.
  const { count: remaining } = await supabaseAdmin
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed')
    .is('sheet_synced_at', null)
    .gte('scheduled_date', since);

  const line = `${LOG_PREFIX} synced ${synced}, failed ${failed}, ${remaining ?? '?'} still pending (${Math.round((Date.now() - started) / 1000)}s)`;
  if (failed > 0) console.error(line);
  else console.log(line);
  return { synced, failed, remaining: remaining ?? null, error: null };
}

/** Run every `intervalMinutes`, plus once a couple of minutes after boot. Returns a stop function. */
function startSheetSyncSweepScheduler(intervalMinutes = 60) {
  const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;
  console.log(`${LOG_PREFIX} scheduler started — every ${intervalMinutes} min`);
  const timer = setInterval(() => {
    runSheetSyncSweep().catch((err) => console.error(`${LOG_PREFIX} scheduled run failed:`, err));
  }, intervalMs);
  // Delayed so the boot-time syncs and the Wix sweep get the connection first.
  const kickoff = setTimeout(() => {
    runSheetSyncSweep().catch((err) => console.error(`${LOG_PREFIX} initial run failed:`, err));
  }, 2 * 60 * 1000);
  return () => { clearInterval(timer); clearTimeout(kickoff); };
}

module.exports = { runSheetSyncSweep, startSheetSyncSweepScheduler };
