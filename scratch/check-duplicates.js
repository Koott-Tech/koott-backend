require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function checkDuplicates() {
  console.log('🔍 Fetching clients and users to identify duplicates...\n');
  
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id, user_id, first_name, last_name, phone_number, created_at, user:users(email)');

  if (error) {
    console.error('Error fetching clients:', error);
    return;
  }

  // Group by user_id primarily, fallback to email or phone
  const groups = {};
  data.forEach(c => {
    const email = c.user?.email || 'no-email';
    const key = c.user_id || email || c.phone_number;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  });

  const duplicateGroups = Object.entries(groups).filter(([k, list]) => list.length > 1);
  
  console.log(`📊 Statistics:`);
  console.log(`   - Total client rows: ${data.length}`);
  console.log(`   - Unique clients:    ${Object.keys(groups).length}`);
  console.log(`   - Duplicated keys:   ${duplicateGroups.length}\n`);

  if (duplicateGroups.length > 0) {
    console.log('📑 Detailed Duplicate List (Top 20):');
    console.log(''.padEnd(80, '─'));
    console.log(`${'Email/ID'.padEnd(40)} | ${'Name'.padEnd(20)} | ${'Count'}`);
    console.log(''.padEnd(80, '─'));

    duplicateGroups
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 20)
      .forEach(([key, list]) => {
        const first = list[0];
        const email = first.user?.email || (key.length > 20 ? key.slice(0, 8) + '...' : key);
        const name = `${first.first_name || ''} ${first.last_name || ''}`.trim() || 'No Name';
        console.log(`${email.padEnd(40)} | ${name.padEnd(20)} | ${list.length}`);
      });
    console.log(''.padEnd(80, '─'));
  } else {
    console.log('✅ No duplicates found!');
  }
}

checkDuplicates();
