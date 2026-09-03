#!/usr/bin/env node
/**
 * Backfill every therapist's completed sessions into their Google Sheet.
 *
 * Runs the per-therapist logic in sequence rather than in parallel: the Sheets API limits a
 * user to roughly 60 writes/minute, and fanning 32 therapists out concurrently would trip it.
 * Safe to re-run — rows are keyed on session id and overwritten in place.
 */
require('dotenv').config();
const { execFileSync } = require('child_process');
const { supabaseAdmin: db } = require('../config/supabase');

const FROM = process.argv[2] || '2026-08-01';
const TO = process.argv[3] || '2026-12-31';

(async () => {
  const { data: ps } = await db.from('psychologists').select('id, first_name, last_name').order('first_name');
  let done = 0, skipped = 0, failed = 0, rows = 0;

  for (const p of ps) {
    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim().replace(/\s+/g, ' ');
    const { count } = await db.from('sessions').select('id', { count: 'exact', head: true })
      .eq('psychologist_id', p.id).eq('status', 'completed')
      .gte('scheduled_date', FROM).lte('scheduled_date', TO);
    if (!count) { skipped++; console.log(`  --      ${name} (no completed sessions)`); continue; }
    // Sheets allows ~60 writes/minute per user and each therapist costs several. Without a
    // pause the run trips the quota partway through and silently leaves therapists unwritten,
    // which happened on three separate attempts. Pause between therapists, and back off and
    // retry once when Google says quota rather than losing the row set.
    let attempt = 0;
    for (;;) {
      try {
        const out = execFileSync('node',
          [`${__dirname}/backfill-therapist-sheet.js`, p.id, FROM, TO],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const wrote = [...out.matchAll(/(\d+) rows written/g)].reduce((a, m) => a + Number(m[1]), 0);
        rows += wrote; done++;
        console.log(`  ok      ${name.padEnd(28)} ${wrote} rows`);
        break;
      } catch (e) {
        const msg = String(e.stderr || e.message).trim().split('\n').pop();
        if (/Quota exceeded/i.test(msg) && attempt < 2) {
          attempt += 1;
          console.log(`  wait    ${name.padEnd(28)} quota — backing off 65s (attempt ${attempt})`);
          await new Promise((r) => setTimeout(r, 65000));
          continue;
        }
        failed++;
        console.log(`  FAILED  ${name.padEnd(28)} ${msg}`);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, Number(process.env.SHEET_BULK_PAUSE_MS || 2500)));
  }
  console.log(`\n${done} therapists written, ${skipped} skipped, ${failed} failed, ${rows} rows total`);
})().catch(e => { console.error(e.message); process.exit(1); });
