const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkDependencies() {
  try {
    // Check tables to clear
    const tables = ['sessions', 'packages', 'wix_bookings', 'clients', 'users', 'feedback', 'notes', 'payments'];
    
    console.log('\n--- Record Counts Before Deletion ---');
    for (const table of tables) {
      try {
        const query = supabase.from(table).select('*', { count: 'exact', head: true });
        if (table === 'users') {
          query.eq('role', 'client');
        }
        const { count, error } = await query;
        if (!error) {
          console.log(`${table.padEnd(15)}: ${count} records`);
        } else {
          // Table might not exist or other error
          if (error.code !== '42P01') { // 42P01 is "relation does not exist"
             console.log(`${table.padEnd(15)}: Error - ${error.message}`);
          }
        }
      } catch (e) {}
    }
    console.log('------------------------------------\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkDependencies();
