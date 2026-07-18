require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function test() {
  const { data, error } = await supabaseAdmin.from('event_registrations').select('*').limit(1);
  if (error) {
    console.error(error);
  } else if (data && data.length > 0) {
    console.log("Columns:", Object.keys(data[0]));
  } else {
    console.log("Table is empty, no columns to show.");
  }
}

test().then(() => process.exit(0));
