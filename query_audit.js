const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data } = await supabaseAdmin.from('wix_webhook_logs').select('*').ilike('payload', '%b6aa6447-ccf3-4822-925a-41c8247ed34c%').order('created_at', { ascending: false }).limit(5);
  console.log("Webhook logs:", JSON.stringify(data, null, 2));
}
check();
