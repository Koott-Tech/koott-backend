const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');

const LOG_PREFIX = '[monthlyFinanceSnapshot]';

function monthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(year, month, 0).toISOString().split('T')[0];
  return { start, end };
}

async function upsertSnapshot(year, month, payload) {
  const { data: existingSnapshot } = await supabaseAdmin
    .from('monthly_finance_dashboard')
    .select('id, snapshot_locked')
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();

  if (existingSnapshot?.snapshot_locked) {
    console.log(`${LOG_PREFIX} snapshot is locked for ${year}-${month}; skipping`);
    return;
  }

  const { error } = await supabaseAdmin
    .from('monthly_finance_dashboard')
    .upsert({
      year,
      month,
      ...payload,
      snapshot_locked: existingSnapshot?.snapshot_locked || false,
      last_updated_at: new Date().toISOString()
    }, { onConflict: 'year,month' });

  if (error) throw error;
}

async function generateMonthlySnapshot(year, month) {
  const { start, end } = monthRange(year, month);
  console.log(`${LOG_PREFIX} generating snapshot for ${year}-${String(month).padStart(2, '0')} (${start} to ${end})`);

  const [{ data: sessions }, { data: commissions }, { data: payouts }, { data: expenses }] = await Promise.all([
    supabaseAdmin
      .from('sessions')
      .select('id, psychologist_id, status, price, original_scheduled_date, completion_date')
      .neq('session_type', 'free_assessment')
      .gte('original_scheduled_date', start)
      .lte('original_scheduled_date', end),
    supabaseAdmin
      .from('commission_history')
      .select('commission_amount, session_amount, session_date')
      .gte('session_date', start)
      .lte('session_date', end),
    supabaseAdmin
      .from('payouts')
      .select('amount, payout_amount, payout_date, status')
      .eq('status', 'paid')
      .gte('payout_date', start)
      .lte('payout_date', end),
    supabaseAdmin
      .from('expenses')
      .select('amount, status, created_at')
      .eq('status', 'approved')
      .gte('created_at', `${start}T00:00:00`)
      .lte('created_at', `${end}T23:59:59`)
  ]);

  const sessionRows = sessions || [];
  const commissionRows = commissions || [];
  const payoutRows = payouts || [];
  const expenseRows = expenses || [];

  const totalSessions = sessionRows.length;
  const completedSessions = sessionRows.filter(s => ['completed', 'complete'].includes(String(s.status || '').toLowerCase())).length;
  const pendingSessions = Math.max(0, totalSessions - completedSessions);
  const rescheduledSessions = sessionRows.filter(s => String(s.status || '').toLowerCase() === 'rescheduled').length;
  const rescheduleRequestedSessions = sessionRows.filter(s => String(s.status || '').toLowerCase() === 'reschedule_requested').length;
  const noShowSessions = sessionRows.filter(s => ['no_show', 'noshow'].includes(String(s.status || '').toLowerCase())).length;
  const upcomingSessions = sessionRows.filter(s => ['booked', 'rescheduled'].includes(String(s.status || '').toLowerCase())).length;
  const activeDoctors = new Set(sessionRows.map(s => s.psychologist_id).filter(Boolean)).size;

  const totalRevenue = sessionRows.reduce((sum, s) => sum + (parseFloat(s.price || 0) || 0), 0);
  const totalCompanyCommission = commissionRows.reduce((sum, c) => sum + (parseFloat(c.commission_amount || 0) || 0), 0);
  const totalDoctorWallet = commissionRows.reduce((sum, c) => {
    const sessionAmount = parseFloat(c.session_amount || 0) || 0;
    const commissionAmount = parseFloat(c.commission_amount || 0) || 0;
    return sum + (sessionAmount - commissionAmount);
  }, 0);
  const payoutReceived = payoutRows.reduce((sum, p) => sum + (parseFloat(p.payout_amount ?? p.amount ?? 0) || 0), 0);
  const pendingPayout = Math.max(0, totalDoctorWallet - payoutReceived);
  const totalExpenses = expenseRows.reduce((sum, e) => sum + (parseFloat(e.amount || 0) || 0), 0);
  const netProfit = totalRevenue - totalDoctorWallet - totalExpenses;

  await upsertSnapshot(year, month, {
    total_sessions: totalSessions,
    pending_sessions: pendingSessions,
    completed_sessions: completedSessions,
    rescheduled_sessions: rescheduledSessions,
    reschedule_requested_sessions: rescheduleRequestedSessions,
    no_show_sessions: noShowSessions,
    upcoming_sessions: upcomingSessions,
    total_revenue: totalRevenue,
    total_company_commission: totalCompanyCommission,
    total_doctor_wallet: totalDoctorWallet,
    pending_payout: pendingPayout,
    payout_received: payoutReceived,
    total_expenses: totalExpenses,
    net_profit: netProfit,
    active_doctors: activeDoctors
  });

  console.log(`${LOG_PREFIX} snapshot saved for ${year}-${String(month).padStart(2, '0')}`);
}

class MonthlyFinanceSnapshotService {
  start() {
    console.log(`${LOG_PREFIX} starting scheduler`);

    // Daily at 00:10 IST; always snapshot previous month so month-end is persisted.
    cron.schedule('10 0 * * *', async () => {
      try {
        const now = new Date();
        const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const year = prevMonthDate.getFullYear();
        const month = prevMonthDate.getMonth() + 1;
        await generateMonthlySnapshot(year, month);
      } catch (err) {
        console.error(`${LOG_PREFIX} scheduled run failed:`, err);
      }
    }, { timezone: 'Asia/Kolkata' });

    // One-shot bootstrap at startup to ensure previous month exists.
    (async () => {
      try {
        const now = new Date();
        const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        await generateMonthlySnapshot(prevMonthDate.getFullYear(), prevMonthDate.getMonth() + 1);
      } catch (err) {
        console.error(`${LOG_PREFIX} startup backfill failed:`, err);
      }
    })();

    console.log(`${LOG_PREFIX} scheduled (daily 00:10 IST)`);
  }
}

module.exports = new MonthlyFinanceSnapshotService();
module.exports.generateMonthlySnapshot = generateMonthlySnapshot;

