const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function clearWix() {
  console.log('🗑️ Deleting all records from "wix_bookings"...');
  // Use a non-existent UUID or just delete all rows by using a filter that matches all (or use RPC if available, but filter works)
  // neq with a random UUID will match all rows.
  const { error } = await supabase
    .from('wix_bookings')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
    
  if (error) console.error('Error deleting wix_bookings:', error.message);
  else console.log('✅ Wix Bookings cleared.');
}

clearWix();
