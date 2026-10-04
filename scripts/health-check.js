#!/usr/bin/env node
/**
 * Post-deploy verification. Run from littlecare-backend:  node scripts/health-check.js
 *
 * Checks the four things the October bandwidth work touched, and says PASS/FAIL per item so
 * there is nothing to interpret. Read-only — it writes nothing.
 */
require('dotenv').config();
const { supabaseAdmin: db } = require('../config/supabase');

const SERVICE = process.env.HEALTH_CHECK_URL || 'https://koott-backend.onrender.com';
const ok = (b) => (b ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m');
const warn = (m) => `\x1b[33m${m}\x1b[0m`;

(async () => {
  console.log(`\nChecking ${SERVICE}\n${'─'.repeat(64)}`);

  // 1. Which build is actually live, and is the audit on?
  let health = null;
  try {
    health = await (await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(20000) })).json();
    const upMin = Math.round((health.uptime || 0) / 60);
    console.log(`1. deployed commit      ${health.commit || warn('unknown (build predates /health commit reporting)')}`);
    console.log(`   uptime               ${upMin} min`);
    console.log(`   bandwidth audit      ${health.bandwidthAudit ? 'ON — report every 15 min in the logs' : 'off'}`);
  } catch (e) {
    console.log(`1. service              ${ok(false)} — ${e.message}`);
  }

  // 2. Package links must stay STABLE. The old linker wiped every link each cycle and rebuilt
  //    them one write at a time, so sampling twice caught the count sawtoothing.
  const linkCount = async () => {
    const { count } = await db.from('wix_bookings')
      .select('wix_booking_id', { count: 'exact', head: true })
      .not('package_parent_booking_id', 'is', null);
    return count;
  };
  const a = await linkCount();
  process.stdout.write(`\n2. package links         ${a} — sampling again in 20s to check stability... `);
  await new Promise((r) => setTimeout(r, 20000));
  const b = await linkCount();
  const stable = a === b;
  console.log(`${b}  ${ok(stable)}`);
  if (!stable) console.log(warn('   links are still moving — the old linker may still be deployed'));

  // 3. Google Sheets mirror
  const { count: unsynced } = await db.from('sessions')
    .select('id', { count: 'exact', head: true }).eq('status', 'completed').is('sheet_synced_at', null);
  const { data: last } = await db.from('sessions').select('sheet_synced_at')
    .not('sheet_synced_at', 'is', null).order('sheet_synced_at', { ascending: false }).limit(1);
  const lastSync = last?.[0]?.sheet_synced_at;
  const freshHrs = lastSync ? (Date.now() - Date.parse(lastSync)) / 3600000 : Infinity;
  // A small backlog is normal: sessions completed since the last hourly sweep are waiting
  // their turn, and the sweep takes 40 at a time. What matters is that syncing is HAPPENING.
  const sheetsHealthy = freshHrs < 2 || unsynced === 0;
  console.log(`\n3. sheets unsynced       ${unsynced}${unsynced ? ' (awaiting next hourly sweep)' : ''}  ${ok(sheetsHealthy)}`);
  console.log(`   last successful sync  ${lastSync ? lastSync.slice(0, 19).replace('T', ' ') + ' UTC' : 'never'}`);
  if (!sheetsHealthy) console.log(warn('   nothing synced recently with work pending — check GOOGLE_REFRESH_TOKEN scopes'));
  if (unsynced > 100) console.log(warn(`   backlog of ${unsynced} is large — the sweep only takes 40/hour`));

  // 4. Bookings still arriving from Wix
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: newBookings } = await db.from('wix_bookings')
    .select('wix_booking_id', { count: 'exact', head: true }).gte('created_at', since);
  console.log(`\n4. wix bookings (24h)    ${newBookings}  ${ok(newBookings > 0)}`);

  console.log(`${'─'.repeat(64)}`);
  console.log('Bandwidth itself is on the Render dashboard — Outbound Bandwidth,');
  console.log('"Usage this month". Compare the day-over-day increase.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
