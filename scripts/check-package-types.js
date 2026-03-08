/**
 * Check package_type values in the packages table.
 * Run from backend dir: node scripts/check-package-types.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabaseAdmin } = require('../config/supabase');

async function main() {
  console.log('Querying packages table for id, package_type, session_count, name...\n');

  const { data: packages, error } = await supabaseAdmin
    .from('packages')
    .select('id, package_type, session_count, name')
    .order('id');

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  if (!packages || packages.length === 0) {
    console.log('No packages found.');
    return;
  }

  console.log(`Found ${packages.length} package(s):\n`);
  const byType = {};
  packages.forEach((p) => {
    const t = p.package_type || '(null)';
    byType[t] = (byType[t] || 0) + 1;
    console.log(`  id: ${p.id}, package_type: "${p.package_type}", session_count: ${p.session_count}, name: ${p.name || '—'}`);
  });

  console.log('\n--- Summary by package_type ---');
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`  "${type}": ${count}`);
  });

  if (byType['multi_session']) {
    console.log('\n⚠️  "multi_session" is stored in DB. It is set in adminController.js when updating psychologist packages (sessions > 1).');
    console.log('   To show "Package" in the UI, the frontend maps multi_session → Package. To store "package_N" in DB instead, change adminController.js updatePsychologist package_type logic.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
