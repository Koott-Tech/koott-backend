require('dotenv').config();
const { supabaseAdmin } = require('./config/supabase');
const { hashPassword } = require('./utils/helpers');

async function updateAllPsychologistPasswords() {
  try {
    const newPassword = 'Koott@#2026';
    console.log(`Hashing new password: ${newPassword}...`);
    const hashedPassword = await hashPassword(newPassword);

    console.log('Updating all psychologist accounts in the database...');
    
    // Update all psychologists
    const { data, error } = await supabaseAdmin
      .from('psychologists')
      .update({ password_hash: hashedPassword })
      // We don't use .eq() so it updates all rows, but Supabase might require a filter or explicitly allowing all updates. 
      // Supabase JS client requires a filter for updates unless we use a filter that matches all.
      .neq('id', '00000000-0000-0000-0000-000000000000') // Dummy filter that matches all valid UUIDs
      .select('email');

    if (error) {
      throw error;
    }

    console.log(`✅ Successfully updated passwords for ${data.length} doctors!`);
    console.log('Affected emails:');
    data.forEach(d => console.log(`- ${d.email}`));
    
  } catch (err) {
    console.error('❌ Error updating passwords:', err.message || err);
  }
}

updateAllPsychologistPasswords();
