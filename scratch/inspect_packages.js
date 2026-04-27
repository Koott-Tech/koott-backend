const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectPackages() {
  try {
    const { data: wixData, error } = await supabase
      .from('wix_bookings')
      .select('title, session_count, client_full_name');
    
    if (error) throw error;

    console.log('\n--- Wix Package Inspection ---');
    wixData.forEach(row => {
      const title = (row.title || '').toLowerCase();
      if (row.session_count > 1 || title.includes('package') || title.includes('session')) {
        console.log(`Client: ${row.client_full_name.padEnd(25)} | Title: ${row.title.padEnd(30)} | Count: ${row.session_count}`);
      }
    });
    console.log('----------------------------\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

inspectPackages();
