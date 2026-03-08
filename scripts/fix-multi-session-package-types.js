/**
 * One-time fix: update packages with package_type = 'multi_session' to package_N (e.g. package_3, package_6).
 * Run from backend dir: node scripts/fix-multi-session-package-types.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabaseAdmin } = require('../config/supabase');

async function main() {
  const { data: rows, error: fetchError } = await supabaseAdmin
    .from('packages')
    .select('id, package_type, session_count')
    .eq('package_type', 'multi_session');

  if (fetchError) {
    console.error('Fetch error:', fetchError.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log('No packages with package_type "multi_session" found. Nothing to fix.');
    return;
  }

  console.log(`Found ${rows.length} package(s) with package_type "multi_session". Updating to package_N...\n`);

  for (const row of rows) {
    const newType = `package_${row.session_count || 0}`;
    const { error: updateError } = await supabaseAdmin
      .from('packages')
      .update({ package_type: newType })
      .eq('id', row.id);

    if (updateError) {
      console.error(`  Failed to update ${row.id}:`, updateError.message);
    } else {
      console.log(`  Updated id=${row.id} → package_type="${newType}"`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
