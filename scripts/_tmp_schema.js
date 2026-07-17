require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');
async function check() {
  const { data, error } = await supabaseAdmin.rpc('get_table_schema', { table_name: 'event_pages' });
  console.log(data, error);
}
check().then(() => process.exit(0));
