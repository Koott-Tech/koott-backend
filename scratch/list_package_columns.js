const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function listColumns() {
  try {
    const { data, error } = await supabase
      .from('packages')
      .select('*')
      .limit(1);

    if (error) throw error;

    if (data && data.length > 0) {
      console.log('\n--- packages Columns ---');
      console.log(Object.keys(data[0]).join(', '));
      console.log('---------------------------\n');
    } else {
      console.log('No data in packages table, trying to get schema via RPC or just guessing common columns');
      // Fallback: check sessions table for package_id
      const { data: sessionData } = await supabase.from('sessions').select('*').limit(1);
      if (sessionData && sessionData[0]) {
         console.log('sessions table columns:', Object.keys(sessionData[0]).join(', '));
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

listColumns();
