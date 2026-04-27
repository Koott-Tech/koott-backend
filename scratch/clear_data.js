const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function clearData() {
  console.log('🚀 [CLEANUP] Starting destructive cleanup...');
  
  try {
    // 1. Delete Sessions
    console.log('🗑️ Deleting all records from "sessions"...');
    const { error: err1 } = await supabase.from('sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all
    if (err1) console.error('Error deleting sessions:', err1.message);
    else console.log('✅ Sessions cleared.');

    // 2. Delete Packages
    console.log('🗑️ Deleting all records from "packages"...');
    const { error: err2 } = await supabase.from('packages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (err2) console.error('Error deleting packages:', err2.message);
    else console.log('✅ Packages cleared.');

    // 3. Delete Wix Bookings
    console.log('🗑️ Deleting all records from "wix_bookings"...');
    const { error: err3 } = await supabase.from('wix_bookings').delete().neq('id', 0);
    if (err3) console.error('Error deleting wix_bookings:', err3.message);
    else console.log('✅ Wix Bookings cleared.');

    // 4. Delete Clients
    console.log('🗑️ Deleting all records from "clients"...');
    const { error: err4 } = await supabase.from('clients').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (err4) console.error('Error deleting clients:', err4.message);
    else console.log('✅ Clients cleared.');

    // 5. Delete Users (only clients)
    console.log('🗑️ Deleting users with role "client"...');
    const { error: err5 } = await supabase.from('users').delete().eq('role', 'client');
    if (err5) console.error('Error deleting client users:', err5.message);
    else console.log('✅ Client users cleared.');

    console.log('\n✨ [CLEANUP] Finished. Therapist data and psychologist profiles remain intact.');
    
  } catch (error) {
    console.error('Fatal cleanup error:', error.message);
  }
}

clearData();
