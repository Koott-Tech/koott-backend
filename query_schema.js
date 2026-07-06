const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data: cols } = await supabaseAdmin.from('sessions').select('*').limit(1);
  if (cols && cols.length > 0) {
    console.log(Object.keys(cols[0]).filter(k => k.includes('calendar') || k.includes('google')));
  } else {
    console.log("No data");
  }
}
check();
