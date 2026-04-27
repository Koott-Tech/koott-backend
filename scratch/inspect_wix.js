const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectWix() {
  try {
    const { data, error } = await supabase
      .from('wix_bookings')
      .select('title, session_type, session_count, price')
      .limit(50);

    if (error) throw error;

    console.log('\n--- Wix Bookings Sample ---');
    data.forEach(row => {
      console.log(`Title: ${row.title.padEnd(40)} | Type: ${row.session_type.padEnd(15)} | Count: ${row.session_count} | Price: ${row.price}`);
    });
    console.log('---------------------------\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

inspectWix();
