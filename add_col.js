const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data, error } = await supabaseAdmin.rpc('exec_sql', { 
    sql: 'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS google_calendar_id TEXT;' 
  });
  console.log("RPC exec_sql:", error || "Success");
}
check();
