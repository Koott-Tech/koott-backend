require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function test() {
  const { data, error } = await supabaseAdmin.from('event_registrations').insert([
    { event_slug: 'test', full_name: 'test', email: 'test@test.com' }
  ]).select('*');
  console.log(data, error);
}

test().then(() => process.exit(0));
