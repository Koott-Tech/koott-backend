const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSchema() {
  const { data, error } = await supabase.rpc('get_table_schema', { table_name: 'sessions' });
  if (error) {
    // Fallback: just try to select one row and check keys
    const { data: row, error: rowError } = await supabase.from('sessions').select('*').limit(1);
    if (rowError) {
      console.error(rowError);
    } else if (row && row.length > 0) {
      console.log('Columns in sessions table:', Object.keys(row[0]));
    } else {
      console.log('No rows in sessions table, cannot infer columns.');
    }
  } else {
    console.log('Schema:', data);
  }
}

checkSchema();
