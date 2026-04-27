require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function debug() {
  const firstName = 'Prijitha';
  console.log(`🧪 Debugging lookup for ${firstName}`);
  
  let query = supabaseAdmin
    .from('psychologists')
    .select('id, first_name, last_name')
    .ilike('first_name', firstName);
    
  query = query.is('last_name', null);
  
  const { data, error } = await query;
  console.log('Error:', error);
  console.log('Results:', data);
}

debug();
