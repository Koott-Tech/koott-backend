const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkRow() {
  const { data, error } = await supabase
    .from('wix_bookings')
    .select('price, session_type, session_count')
    .eq('wix_booking_id', 'd7f6bf95-17c0-4f0c-94d3-1b5219151b2b')
    .single();

  if (error) console.error(error);
  else console.log('Database Row:', data);
}

checkRow();
