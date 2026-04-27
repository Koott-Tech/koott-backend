const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function listColumns() {
  try {
    const { data, error } = await supabase
      .from('wix_bookings')
      .select('*')
      .limit(1);

    if (error) throw error;

    if (data && data.length > 0) {
      console.log('\n--- wix_bookings Columns ---');
      console.log(Object.keys(data[0]).join(', '));
      console.log('---------------------------\n');
    } else {
      console.log('No data in wix_bookings');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

listColumns();
