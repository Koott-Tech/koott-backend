const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkAmounts() {
  try {
    console.log('🔍 Checking amounts in wix_bookings...');
    const { data, error } = await supabase
      .from('wix_bookings')
      .select('title, price, currency')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    console.log('\n--- AMOUNT VERIFICATION ---');
    data.forEach(row => {
      console.log(`${row.title.padEnd(25)} | Price: ${row.price} ${row.currency}`);
    });
    console.log('---------------------------\n');

  } catch (error) {
    console.error('Check failed:', error.message);
  }
}

checkAmounts();
