require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function checkUserDuplicates() {
  console.log('🔍 Checking for duplicate users in public.users table...\n');
  
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, role, created_at');

  if (error) {
    console.error('Error fetching users:', error);
    return;
  }

  const emailGroups = {};
  data.forEach(u => {
    const email = (u.email || 'no-email').toLowerCase();
    if (!emailGroups[email]) emailGroups[email] = [];
    emailGroups[email].push(u);
  });

  const duplicateEmails = Object.entries(emailGroups).filter(([e, list]) => list.length > 1);
  
  console.log(`📊 User Statistics:`);
  console.log(`   - Total user rows:   ${data.length}`);
  console.log(`   - Unique emails:     ${Object.keys(emailGroups).length}`);
  console.log(`   - Duplicated emails: ${duplicateEmails.length}\n`);

  if (duplicateEmails.length > 0) {
    console.log('📑 Duplicate Users:');
    duplicateEmails.forEach(([email, list]) => {
      console.log(`   - ${email}: ${list.length} rows`);
    });
  } else {
    console.log('✅ No duplicate emails in public.users table.');
  }
}

checkUserDuplicates();
