require('dotenv').config();
const { supabaseAdmin } = require('./config/supabase');

async function inspectSessions() {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('*')
    .limit(1);

  if (error) {
    console.error(error);
  } else {
    console.log('Columns:', Object.keys(data[0]));
    console.log('Sample Row:', data[0]);
  }
  process.exit();
}

inspectSessions();
