require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function test() {
  const { data, error } = await supabaseAdmin.from('event_registrations').select('*').limit(1);
  console.log(data, error);
}

test().then(() => process.exit(0));
