/**
 * Reset all Wix bookings + Koott sessions + clients + client users.
 * Therapists, admins, and psychologist accounts are PRESERVED.
 *
 * Run: SUPABASE_URL=https://... node scripts/reset-wix-and-clients.cjs --confirm
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const CONFIRM = process.argv.includes('--confirm');

async function countTable(table, filter) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count } = await q;
  return count ?? 0;
}

async function deleteAll(table, filter) {
  let q = supabase.from(table).delete();
  if (filter) q = filter(q);
  else q = q.not('id', 'is', null); // delete all (Supabase requires a WHERE)
  const { error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
}

async function main() {
  console.log('=== Pre-reset counts ===');
  const before = {
    wix_bookings: await countTable('wix_bookings'),
    sessions: await countTable('sessions'),
    assessment_sessions: await countTable('assessment_sessions').catch(() => 0),
    clients: await countTable('clients'),
    psychologists: await countTable('psychologists'),
    users_total: await countTable('users'),
    users_clients: await countTable('users', q => q.eq('role', 'client')),
    users_therapists: await countTable('users', q => q.eq('role', 'psychologist')),
    users_admins: await countTable('users', q => q.eq('role', 'admin')),
  };
  console.table(before);

  if (!CONFIRM) {
    console.log('\n⚠️  Dry run only. Add --confirm to actually delete.');
    return;
  }

  console.log('\n=== Deleting (in dependency order) ===');

  // 1. wix_bookings — no FK dependents on other tables we're keeping
  await deleteAll('wix_bookings', q => q.not('wix_booking_id', 'is', null));
  console.log('✓ wix_bookings cleared');

  // 2. assessment_sessions — references clients/psychologists
  try {
    await deleteAll('assessment_sessions', q => q.not('id', 'is', null));
    console.log('✓ assessment_sessions cleared');
  } catch (e) { console.warn('  assessment_sessions:', e.message); }

  // 3. sessions — references clients/psychologists
  await deleteAll('sessions', q => q.not('id', 'is', null));
  console.log('✓ sessions cleared');

  // 4. packages (purchased package records linking client+psychologist)
  try {
    await deleteAll('packages', q => q.not('id', 'is', null));
    console.log('✓ packages cleared');
  } catch (e) { console.warn('  packages:', e.message); }

  // 5. clients
  await deleteAll('clients', q => q.not('id', 'is', null));
  console.log('✓ clients cleared');

  // 6. users WHERE role = 'client'  (therapists + admins preserved)
  await deleteAll('users', q => q.eq('role', 'client'));
  console.log('✓ users (role=client) cleared');

  console.log('\n=== Post-reset counts ===');
  const after = {
    wix_bookings: await countTable('wix_bookings'),
    sessions: await countTable('sessions'),
    assessment_sessions: await countTable('assessment_sessions').catch(() => 0),
    clients: await countTable('clients'),
    psychologists: await countTable('psychologists'),
    users_total: await countTable('users'),
    users_clients: await countTable('users', q => q.eq('role', 'client')),
    users_therapists: await countTable('users', q => q.eq('role', 'psychologist')),
    users_admins: await countTable('users', q => q.eq('role', 'admin')),
  };
  console.table(after);
}

main().catch(e => { console.error(e); process.exit(1); });
