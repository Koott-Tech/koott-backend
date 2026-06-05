/**
 * Backfill commission_history for completed package sessions.
 *
 * What it does:
 *   1. Finds all completed sessions that belong to a package.
 *   2. Deletes existing commission_history rows for those sessions
 *      (skips any already marked payment_status = 'paid' to avoid touching settled payouts).
 *   3. Recalculates commission using the updated logic in commissionCalculationService
 *      (all sessions in a package share one first/followup designation based on whether
 *      the client had any prior paid session before the package was booked).
 *
 * Run:
 *   node scripts/backfill-package-commissions.js [--dry-run]
 *
 * --dry-run  Print what would be processed without writing anything.
 */

const { supabaseAdmin } = require('../config/supabase');
const { calculateAndRecordCommission } = require('../services/commissionCalculationService');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n=== Package Commission Backfill ${DRY_RUN ? '[DRY RUN]' : ''} ===\n`);

  // 1. Fetch all completed package sessions
  const { data: sessions, error: sessErr } = await supabaseAdmin
    .from('sessions')
    .select('id, psychologist_id, client_id, package_id, price, status, scheduled_date')
    .not('package_id', 'is', null)
    .eq('status', 'completed');

  if (sessErr) throw sessErr;
  console.log(`Found ${sessions.length} completed package sessions.`);

  // 2. Fetch existing commission_history rows for these sessions
  const sessionIds = sessions.map(s => s.id);
  const { data: histories, error: histErr } = await supabaseAdmin
    .from('commission_history')
    .select('id, session_id, payment_status')
    .in('session_id', sessionIds);

  if (histErr) throw histErr;

  const paidSessionIds = new Set(
    (histories || []).filter(h => h.payment_status === 'paid').map(h => h.session_id)
  );
  const existingHistoryIds = (histories || []).map(h => h.id);

  const toSkip = sessions.filter(s => paidSessionIds.has(s.id));
  const toProcess = sessions.filter(s => !paidSessionIds.has(s.id));

  console.log(`  Already paid (skipping): ${toSkip.length}`);
  console.log(`  To backfill:             ${toProcess.length}\n`);

  if (DRY_RUN) {
    toProcess.forEach(s => console.log(`  [dry] Would backfill session ${s.id} (package ${s.package_id})`));
    console.log('\nDry run complete — nothing written.');
    return;
  }

  // 3. Delete non-paid commission_history rows for sessions we will reprocess
  const toDeleteIds = (histories || [])
    .filter(h => !paidSessionIds.has(h.session_id))
    .map(h => h.id);

  if (toDeleteIds.length > 0) {
    const { error: delErr } = await supabaseAdmin
      .from('commission_history')
      .delete()
      .in('id', toDeleteIds);
    if (delErr) throw delErr;
    console.log(`Deleted ${toDeleteIds.length} existing commission_history rows.\n`);
  }

  // 4. Recalculate commission for each session
  let success = 0;
  let failed = 0;

  for (const s of toProcess) {
    try {
      await calculateAndRecordCommission(s.id);
      console.log(`  ✅ ${s.id}  package=${s.package_id}  date=${s.scheduled_date}`);
      success++;
    } catch (err) {
      console.error(`  ❌ ${s.id}  ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Done: ${success} recalculated, ${failed} failed ===\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
