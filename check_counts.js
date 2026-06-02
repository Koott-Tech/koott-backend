require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: sessions, error } = await supabase.from('sessions').select('*').neq('session_type', 'free_assessment').neq('status', 'cancelled');
  if (error) console.error(error);
  const wixSessions = (sessions || []).filter(s => s.source === 'wix');
  let hidden = 0;
  for (const s of wixSessions) {
    const wp = s.wix_payload;
    const missingSessionId = !wp || typeof wp !== 'object' || (!wp.sessionId && !wp.id);
    const isUndefinedWix = !s.payment_id && missingSessionId;
    const isPackageChild = Number(s.package_session_number || 1) > 1;
    if (isUndefinedWix || isPackageChild) hidden++;
  }
  const { count: wixCount } = await supabase.from('wix_bookings').select('*', { count: 'exact', head: true });
  console.log('Total sessions:', (sessions || []).length);
  console.log('Hidden wix sessions:', hidden);
  console.log('Visible sessions:', (sessions || []).length - hidden);
  console.log('Wix bookings table count:', wixCount);
}
run();
