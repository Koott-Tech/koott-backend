/**
 * One-off merge: remove the empty duplicate "Nisha P Joy" psychologist profile.
 *
 * Keeps  59c5adbb-40b0-4606-b1c7-517b773c4d46 (email + phone + calendar, 34 sessions)
 * Deletes bfbfeba2-d9a6-42d2-b442-39d6f5138180 (empty orphan, created 2026-07-27:
 *         0 sessions, 0 commissions, 0 config, only 2 redundant availability rows)
 *
 * Safe: the duplicate has no sessions/commissions/config, and the canonical profile
 * already has proper availability for the same dates (17–18 Aug) the dup's rows cover.
 *
 * Run:  node scripts/merge-nisha-duplicate.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DUP = 'bfbfeba2-d9a6-42d2-b442-39d6f5138180';
const CANON = '59c5adbb-40b0-4606-b1c7-517b773c4d46';

(async () => {
  // Guard: refuse to run if the duplicate somehow has sessions/commissions now.
  const [{ count: sc }, { count: chc }] = await Promise.all([
    supabase.from('sessions').select('*', { count: 'exact', head: true }).eq('psychologist_id', DUP),
    supabase.from('commission_history').select('*', { count: 'exact', head: true }).eq('psychologist_id', DUP),
  ]);
  if (sc > 0 || chc > 0) {
    console.error(`ABORT: duplicate now has ${sc} sessions / ${chc} commissions — do NOT delete. Re-assess.`);
    process.exit(1);
  }

  const { error: avErr, count: avCount } = await supabase
    .from('availability').delete({ count: 'exact' }).eq('psychologist_id', DUP);
  console.log('availability delete:', avErr ? `ERR ${avErr.message}` : `removed ${avCount} row(s)`);
  if (avErr) process.exit(1);

  const { error: pErr, count: pCount } = await supabase
    .from('psychologists').delete({ count: 'exact' }).eq('id', DUP);
  console.log('psychologist delete:', pErr ? `ERR ${pErr.message}` : `removed ${pCount} row(s)`);
  if (pErr) process.exit(1);

  const { data: remaining } = await supabase
    .from('psychologists').select('id, first_name, last_name, email, phone').ilike('first_name', '%Nisha%');
  console.log('remaining Nisha records:', JSON.stringify(remaining, null, 1));
  console.log('✅ merge complete — canonical', CANON, 'retained.');
})();
