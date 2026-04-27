const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkWixSchema() {
  const { data: row, error: rowError } = await supabase.from('wix_bookings').select('*').limit(1);
  if (rowError) {
    console.error(rowError);
  } else if (row && row.length > 0) {
    console.log('Columns in wix_bookings table:', Object.keys(row[0]));
  } else {
    console.log('No rows in wix_bookings table.');
  }
}

checkWixSchema();
