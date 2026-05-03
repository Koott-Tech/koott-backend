require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');
const { getSessionBookingCreatedIstDateString } = require('../utils/sessionBookingCreatedAt');

(async () => {
  const assessmentPsychId = process.env.ASSESSMENT_PSYCHOLOGIST_ID || '00000000-0000-0000-0000-000000000000';
  const { data: psychologists } = await supabaseAdmin.from('psychologists').select('id').neq('id', assessmentPsychId);
  const allPsychIds = psychologists?.map((p) => p.id).filter(Boolean) || [];

  let sessions = null;
  let err = null;
  ({ data: sessions, error: err } = await supabaseAdmin
    .from('sessions')
    .select(
      'id, psychologist_id, client_id, status, payment_id, session_type, package_id, price, booking_created_at, created_at, wix_payload, source'
    )
    .in('status', [
      'completed',
      'booked',
      'rescheduled',
      'reschedule_requested',
      'no_show',
      'noshow',
      'cancelled',
      'canceled',
      'refunded',
    ])
    .neq('session_type', 'free_assessment')
    .not('psychologist_id', 'is', null)
    .in('psychologist_id', allPsychIds));

  if (err) throw err;

  const istToday = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .slice(0, 10);

  const statusesForTotal = [
    'completed',
    'booked',
    'rescheduled',
    'reschedule_requested',
    'no_show',
    'noshow',
    'cancelled',
    'canceled',
  ];

  let todayRowsDash = sessions.filter((s) => {
    if (!s || s.session_type === 'free_assessment') return false;
    if (!statusesForTotal.includes(s.status)) return false;
    const ymd = getSessionBookingCreatedIstDateString(s);
    return !!(ymd && ymd >= istToday && ymd <= istToday);
  });

  /** Final summary uses commission loop overwrite (matches lines 1454–1460): any status from allSessions, still IST booking-day filter. */
  let todayRowsOverride = sessions.filter((s) => {
    const ymd = getSessionBookingCreatedIstDateString(s);
    return !!(ymd && ymd >= istToday && ymd <= istToday);
  });

  const withPay = todayRowsOverride.filter((s) => s.payment_id);
  const noPay = todayRowsOverride.filter((s) => !s.payment_id);
  const paymentIds = new Set(withPay.map((s) => String(s.payment_id)));

  console.log(JSON.stringify({
    istToday,
    psychiatristFilter: 'psychologist assigned + excludes ASSESSMENT_PSYCHOLOGIST_ID',
    totalSessions_cards_firstLogic_excludesRefunded: todayRowsDash.length,
    totalSessions_summary_overrideIncludesRefunded: todayRowsOverride.length,
    distinctPaymentIdAmongRowsWithPayment: paymentIds.size,
    rowsWithoutPaymentId: noPay.length,
  }));
})();
