require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');
const { resolveOrCreateWixClient } = require('../services/wixClientResolverService');

async function debug() {
  const email = 'nishashaji92@gmail.com';
  console.log(`🧪 Debugging resolveOrCreateWixClient for ${email}`);
  
  // 1. Check user
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id')
    .ilike('email', email)
    .single();
    
  console.log('User found:', user?.id);
  
  // 2. Check clients directly
  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, user_id, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
    
  console.log(`Direct DB check: Found ${clients?.length} client rows for this user.`);
  if (clients?.length > 0) {
    console.log('Latest client ID:', clients[0].id);
  }

  // 3. Call the service
  console.log('Calling service...');
  const result = await resolveOrCreateWixClient({
    email,
    firstName: 'Nisha',
    lastName: 'Shaji'
  });
  
  console.log('Service result:', result);
}

debug();
