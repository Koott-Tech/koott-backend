require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const dateFrom = '2026-06-01';
  const dateTo = '2026-06-30';
  
  // This mirrors getAllSessions
  const { data: sessions } = await supabase.from('sessions')
    .select('*')
    .neq('session_type', 'free_assessment')
    .neq('status', 'cancelled')
    .gte('booking_created_at', `${dateFrom}T00:00:00+05:30`)
    .lte('booking_created_at', `${dateTo}T23:59:59.999+05:30`);
    
  const wixSessions = (sessions || []).filter(s => s.source === 'wix');
  let hidden = 0;
  for (const s of wixSessions) {
    const wp = s.wix_payload;
    const missingSessionId = !wp || typeof wp !== 'object' || (!wp.sessionId && !wp.id);
    const isUndefinedWix = !s.payment_id && missingSessionId;
    const isPackageChild = Number(s.package_session_number || 1) > 1;
    if (isUndefinedWix || isPackageChild) hidden++;
  }
  
  console.log('Bookings Page Total:', (sessions || []).length - hidden);
}
run();
