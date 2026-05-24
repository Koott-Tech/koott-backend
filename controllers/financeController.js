const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');
const auditLogger = require('../utils/auditLogger');
const {
  getSessionBookingCreatedAtIso,
  getSessionBookingCreatedIstDateString,
  countDistinctFinanceBookings,
  getFinanceBookingDedupeKey,
  getSessionFinanceRevenueAmount,
} = require('../utils/sessionBookingCreatedAt');

/** Rows counted for dashboard “total sessions / bookings”; excludes cancelled (soft-deleted) and refunded. */
const FINANCE_BOOKING_TOTAL_STATUSES = [
  'completed',
  'booked',
  'rescheduled',
  'reschedule_requested',
  'no_show',
  'noshow',
];

/** IST calendar YYYY-MM-DD from API/query → inclusive timestamptz window on booking_created_at. */
const IST_DAY_START_SUFFIX = 'T00:00:00.000+05:30';
const IST_DAY_END_SUFFIX = 'T23:59:59.999+05:30';
const { getBookingTimeColumnKey, appendBookingTimeSelectFragment } = require('../utils/sessionsBookingTimeColumn');

const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);
dayjs.extend(timezone);

const FINANCE_IST_TZ = 'Asia/Kolkata';

function isHiddenWixListRow(session) {
  const src = String(session?.source || '').toLowerCase();
  if (src !== 'wix') return false;
  const wp = session?.wix_payload;
  const missingSessionId = !wp || typeof wp !== 'object' || !wp.sessionId;
  const isUndefinedWix = !session?.payment_id && missingSessionId;
  const isPackageChild = Number(session?.package_session_number || 1) > 1;
  return isUndefinedWix || isPackageChild;
}

/** Non-terminal sessions that still count as “pending fulfilment” on the dashboard card (excludes cancelled). */
const PENDING_SESSION_CARD_STATUSES = new Set([
  'booked',
  'rescheduled',
  'reschedule_requested',
  'no_show',
  'noshow',
]);

/** Max months behind range start carry-in backlog respects (override with FINANCE_PENDING_BACKLOG_MONTHS). */
function getPendingCardBacklogMonths() {
  const n = Number(process.env.FINANCE_PENDING_BACKLOG_MONTHS);
  if (Number.isFinite(n) && n > 0 && n <= 120) return n;
  return 36;
}

function subtractMonthsFromIstCalendarYmd(ymdStr, months) {
  if (!ymdStr || typeof ymdStr !== 'string') return null;
  const parsed = dayjs.tz(ymdStr.slice(0, 10), FINANCE_IST_TZ);
  if (!parsed.isValid()) return null;
  return parsed.subtract(months, 'month').format('YYYY-MM-DD');
}

/**
 * Store monthly finance dashboard snapshot
 * @param {Object} snapshotData - Monthly snapshot data
 * @param {Boolean} forceUpdate - If true, update even if locked (default: false)
 */
const storeMonthlySnapshot = async (snapshotData, forceUpdate = false) => {
  try {
    const { year, month, ...data } = snapshotData;
    
    // First, check if snapshot exists and is locked
    const { data: existingSnapshot, error: checkError } = await supabaseAdmin
      .from('monthly_finance_dashboard')
      .select('id, snapshot_locked')
      .eq('year', year)
      .eq('month', month)
      .maybeSingle();
    
    if (checkError && checkError.code !== 'PGRST116') {
      // PGRST116 is "not found" which is fine, but other errors are not
      console.error('Error checking existing snapshot:', checkError);
      throw checkError;
    }
    
    // If snapshot exists and is locked, don't overwrite unless forceUpdate is true
    if (existingSnapshot && existingSnapshot.snapshot_locked && !forceUpdate) {
      console.log(`⚠️ Monthly snapshot for ${year}-${month} is locked. Skipping update to preserve historical data.`);
      return; // Don't overwrite locked snapshots
    }
    
    // Upsert monthly snapshot (update if exists, insert if not)
    // Only update if not locked or forceUpdate is true
    const { error } = await supabaseAdmin
      .from('monthly_finance_dashboard')
      .upsert({
        year,
        month,
        ...data,
        // Preserve snapshot_locked status if it exists and we're not forcing update
        snapshot_locked: existingSnapshot?.snapshot_locked || false,
        last_updated_at: new Date().toISOString()
      }, {
        onConflict: 'year,month'
      });
    
    if (error) {
      console.error('Error storing monthly snapshot:', error);
      throw error;
    }
    
    console.log(`✅ Monthly snapshot stored for ${year}-${month}${existingSnapshot?.snapshot_locked ? ' (locked, preserved)' : ''}`);
  } catch (err) {
    console.error('Exception storing monthly snapshot:', err);
    throw err;
  }
};

/**
 * Finance Controller
 * Handles all finance-related operations with security protection
 */

// ============================================
// DASHBOARD & OVERVIEW
// ============================================

/**
 * Get Finance Dashboard Data
 * GET /api/finance/dashboard
 */
const getDashboard = async (req, res) => {
  try {
    console.log('Finance dashboard request received:', { dateFrom: req.query.dateFrom, dateTo: req.query.dateTo });
    const userId = req.user.id;
    const userRole = req.user.role;

    // Security: Only finance, admin, superadmin can access
    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const dashBookingTimeCol = await getBookingTimeColumnKey(supabaseAdmin);

    const { dateFrom, dateTo, includeCharts, allTime } = req.query;
    const allTimeMode = String(allTime || '').toLowerCase() === 'true';
    console.log('Processing dashboard with dates:', { dateFrom, dateTo, allTimeMode });
    const shouldIncludeCharts = includeCharts !== 'false'; // Default to true for backward compatibility
    
    // Get current date in IST timezone for accurate defaults
    const getISTDateString = (date) => {
      // Convert to IST and format as YYYY-MM-DD
      const istString = date.toLocaleString('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      // Parse MM/DD/YYYY format and convert to YYYY-MM-DD
      const [month, day, year] = istString.split('/').map(num => num.padStart(2, '0'));
      return `${year}-${month}-${day}`;
    };
    
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfQuarter = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    // Calculate date ranges
    // allTime: no MTD bounds (full-history metrics for the selected summary path)
    // Else if dateFrom/dateTo are provided, use them; else default to current month (IST)
    let mtdFrom;
    let mtdTo;
    if (allTimeMode) {
      mtdFrom = null;
      mtdTo = null;
    } else {
      mtdFrom = dateFrom || getISTDateString(startOfMonth);
      mtdTo = dateTo || getISTDateString(today);
    }

    // Check if we should use stored monthly snapshot
    let filterYear = today.getFullYear();
    let filterMonth = today.getMonth() + 1;
    if (mtdFrom) {
      const filterDate = new Date(mtdFrom);
      if (!isNaN(filterDate.getTime())) {
        filterYear = filterDate.getFullYear();
        filterMonth = filterDate.getMonth() + 1;
      }
    }
    
    // Check if this is a full month filter (from start to end of month)
    const isFullMonthFilter = dateFrom && dateTo;
    let monthStartDate = null;
    let monthEndDate = null;
    if (isFullMonthFilter) {
      const fromDate = new Date(dateFrom);
      const toDate = new Date(dateTo);
      // Check if it's exactly a full month (e.g., 2025-12-01 to 2025-12-31)
      const isStartOfMonth = fromDate.getDate() === 1;
      const isEndOfMonth = toDate.getDate() === new Date(toDate.getFullYear(), toDate.getMonth() + 1, 0).getDate();
      const sameMonth = fromDate.getMonth() === toDate.getMonth() && fromDate.getFullYear() === toDate.getFullYear();
      if (isStartOfMonth && isEndOfMonth && sameMonth) {
        monthStartDate = dateFrom;
        monthEndDate = dateTo;
      }
    }
    
    // Try to retrieve stored monthly snapshot if it's a full month filter
    let storedSnapshot = null;
    if (monthStartDate && monthEndDate) {
      try {
        const { data: snapshot, error: snapshotError } = await supabaseAdmin
          .from('monthly_finance_dashboard')
          .select('*')
          .eq('year', filterYear)
          .eq('month', filterMonth)
          .maybeSingle();
        
        if (!snapshotError && snapshot && snapshot.snapshot_locked) {
          // Use stored snapshot if it's locked (preserved historical data)
          storedSnapshot = snapshot;
          console.log(`Using stored monthly snapshot for ${filterYear}-${filterMonth}`);
        }
      } catch (err) {
        console.error('Error checking monthly snapshot:', err);
        // Continue with live calculation if snapshot check fails
      }
    }
    
    console.log('Finance dashboard date filtering:', {
      reqQueryDateFrom: dateFrom,
      reqQueryDateTo: dateTo,
      mtdFrom,
      mtdTo,
      startOfMonth: startOfMonth.toISOString().split('T')[0],
      today: today.toISOString().split('T')[0]
    });
    const qtdFrom = startOfQuarter.toISOString().split('T')[0];
    const qtdTo = today.toISOString().split('T')[0];
    const ytdFrom = startOfYear.toISOString().split('T')[0];
    const ytdTo = today.toISOString().split('T')[0];

    // Get revenue data - include all sessions where payment was made (exclude free assessments)
    // Statuses where payment exists: booked, completed, rescheduled, reschedule_requested, no_show, cancelled
    // Fetch all sessions (no date filter) - filter in calculation function
    let sessionsData = [];
    try {
      let sessions = null;
      let sessionsError = null;
      const dashBcf = appendBookingTimeSelectFragment(dashBookingTimeCol);
      let sessionsQuery = supabaseAdmin
        .from('sessions')
        .select(`id, scheduled_date, original_scheduled_date, price, psychologist_id, client_id, status, payment_id, session_type, created_at, booking_created_at, ${dashBcf} wix_payload, package_id, source, package_session_number, session_count`)
        .in('status', ['completed', 'booked', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
        .neq('session_type', 'free_assessment');

      // Optimization: If not all-time, filter from start of year to ensure we get enough data for MTD/QTD/YTD cards
      // without hitting the default 1000-row limit on old data.
      if (!allTimeMode) {
        sessionsQuery = sessionsQuery.gte('created_at', `${ytdFrom}T00:00:00+05:30`);
      }
      
      // Order by latest first and increase limit to avoid missing recent bookings
      sessionsQuery = sessionsQuery.order('created_at', { ascending: false }).limit(5000);

      ({ data: sessions, error: sessionsError } = await sessionsQuery);

      // Legacy schema fallback: sessions.payment_id not present
      if (sessionsError && String(sessionsError.message || '').includes('payment_id')) {
        let fbQuery1 = supabaseAdmin
          .from('sessions')
          .select(`id, scheduled_date, original_scheduled_date, price, psychologist_id, client_id, status, session_type, created_at, booking_created_at, ${dashBcf} wix_payload, package_id, source, package_session_number, session_count`)
          .in('status', ['completed', 'booked', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
          .neq('session_type', 'free_assessment');
        if (!allTimeMode) {
          fbQuery1 = fbQuery1.gte('created_at', `${ytdFrom}T00:00:00+05:30`);
        }
        ({ data: sessions, error: sessionsError } = await fbQuery1.order('created_at', { ascending: false }).limit(5000));
      }
      // Optional column until migration applies — still derives booking time from wix_payload / created_at
      if (sessionsError && /booking_created_at/i.test(String(sessionsError.message || ''))) {
        let fbQuery2 = supabaseAdmin
          .from('sessions')
          .select(`id, scheduled_date, original_scheduled_date, price, psychologist_id, client_id, status, payment_id, session_type, created_at, ${dashBcf} wix_payload, package_id, source, package_session_number, session_count`)
          .in('status', ['completed', 'booked', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
          .neq('session_type', 'free_assessment');
        if (!allTimeMode) {
          fbQuery2 = fbQuery2.gte('created_at', `${ytdFrom}T00:00:00+05:30`);
        }
        ({ data: sessions, error: sessionsError } = await fbQuery2.order('created_at', { ascending: false }).limit(5000));
        if (
          sessionsError &&
          String(sessionsError.message || '').includes('payment_id')
        ) {
          let fbQuery3 = supabaseAdmin
            .from('sessions')
            .select(`id, scheduled_date, original_scheduled_date, price, psychologist_id, client_id, status, session_type, created_at, ${dashBcf} wix_payload, package_id, source, package_session_number, session_count`)
            .in('status', ['completed', 'booked', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
            .neq('session_type', 'free_assessment');
          if (!allTimeMode) {
            fbQuery3 = fbQuery3.gte('created_at', `${ytdFrom}T00:00:00+05:30`);
          }
          ({ data: sessions, error: sessionsError } = await fbQuery3.order('created_at', { ascending: false }).limit(5000));
        }
      }

      if (sessionsError) {
        console.error('Error fetching sessions:', sessionsError);
        sessionsData = [];
      } else {
        sessionsData = sessions || [];
      }
    } catch (err) {
      console.error('Exception fetching sessions:', err);
      sessionsData = [];
    }

    const assessmentPsychIdForFinance = process.env.ASSESSMENT_PSYCHOLOGIST_ID || '00000000-0000-0000-0000-000000000000';
    let financeDashboardPsychIds = [];
    let financePsychIdSet = null;
    try {
      const { data: financePsychRows } = await supabaseAdmin
        .from('psychologists')
        .select('id')
        .neq('id', assessmentPsychIdForFinance);
      financeDashboardPsychIds = financePsychRows?.map((p) => p.id).filter(Boolean) || [];
      if (financeDashboardPsychIds.length > 0) {
        financePsychIdSet = new Set(financeDashboardPsychIds);
      }
    } catch (psychErr) {
      console.error('Error fetching psychologists for finance dashboard:', psychErr);
    }

    // Calculate revenue metrics
    // Include all sessions where payment was made (regardless of final status)
    // Statuses: completed, booked, rescheduled, reschedule_requested, no_show, cancelled
    // Dashboard picker (mtdFrom/mtdTo): IST calendar strings; booking-day rollups match Wix Admin India + DB +05:30 bounds below.
    // QTD/YTD tiles: remain on therapy/scheduled date (original_scheduled_date) for fiscal-style rollups.
    const calculateRevenue = (sessions, fromDate, toDate, opts = {}) => {
      if (!sessions || !Array.isArray(sessions)) {
        return { total: 0, count: 0, sessions: [] };
      }
      const byBookingCreated = !!(opts && opts.byBookingCreated);
      const filtered = sessions.filter(s => {
        if (!s) return false;
        
        // If no date filter provided (fromDate/toDate are null), include all sessions
        if (!fromDate || !toDate) {
          // Include all statuses where payment was made (these sessions exist only after successful payment)
          const paidStatuses = ['completed', 'booked', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'];
          return paidStatuses.includes(s.status);
        }

        let dateStr = '';
        if (byBookingCreated) {
          dateStr = getSessionBookingCreatedIstDateString(s);
        } else {
          const date = s.original_scheduled_date || s.scheduled_date;
          if (!date) return false;
          dateStr = typeof date === 'string' ? date.split('T')[0] : date;
        }

        if (!dateStr || dateStr < fromDate || dateStr > toDate) return false;
        
        // Include all statuses where payment was made (these sessions exist only after successful payment)
        const paidStatuses = ['completed', 'booked', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'];
        return paidStatuses.includes(s.status);
      });
      const total = filtered.reduce((sum, s) => sum + getSessionFinanceRevenueAmount(s), 0);
      return {
        total,
        count: filtered.length,
        sessions: filtered
      };
    };

    const mtdRevenue = calculateRevenue(sessionsData, mtdFrom, mtdTo, { byBookingCreated: true });
    const qtdRevenue = calculateRevenue(sessionsData, qtdFrom, qtdTo);
    const ytdRevenue = calculateRevenue(sessionsData, ytdFrom, ytdTo);
    
    // For header summary, use revenue calculated from commission section (matches doctors page exactly)
    // This will be calculated below in the commission calculation section

    // Get expenses (handle table not existing)
    let expensesData = [];
    try {
      let expenses = null;
      let expensesError = null;
      ({ data: expenses, error: expensesError } = await supabaseAdmin
        .from('expenses')
        .select('*')
        .eq('approval_status', 'approved')
        .gte('date', ytdFrom));

      // Legacy schema fallback: approval_status/date may be missing
      if (expensesError && String(expensesError.message || '').includes('approval_status')) {
        ({ data: expenses, error: expensesError } = await supabaseAdmin
          .from('expenses')
          .select('*')
          .eq('status', 'approved')
          .gte('created_at', `${ytdFrom}T00:00:00`));
      }

      if (expensesError) {
        console.error('Error fetching expenses:', expensesError);
        // If table doesn't exist, continue with empty array
        if (expensesError.code === '42P01') {
          console.log('Expenses table does not exist yet, using empty data');
        }
        expensesData = [];
      } else {
        expensesData = (expenses || []).map((e) => ({
          ...e,
          date: e.date || (e.created_at ? String(e.created_at).split('T')[0] : null),
          total_amount: e.total_amount ?? e.amount ?? 0,
          approval_status: e.approval_status || e.status || 'pending'
        }));
      }
    } catch (err) {
      console.error('Exception fetching expenses:', err);
      expensesData = [];
    }

    // Get income entries (manual/other income) for net-profit adjustments.
    // This should affect net profit, not total revenue from sessions.
    let incomeData = [];
    try {
      let income = null;
      let incomeError = null;
      ({ data: income, error: incomeError } = await supabaseAdmin
        .from('income_entries')
        .select('*')
        .gte('date', ytdFrom));

      // Legacy fallback where table is named `income`.
      if (incomeError && (incomeError.code === '42P01' || incomeError.code === 'PGRST205')) {
        ({ data: income, error: incomeError } = await supabaseAdmin
          .from('income')
          .select('*')
          .gte('date', ytdFrom));
      }

      // Legacy fallback where `date` may not exist.
      if (incomeError && String(incomeError.message || '').includes('.date')) {
        ({ data: income, error: incomeError } = await supabaseAdmin
          .from('income_entries')
          .select('*')
          .gte('created_at', `${ytdFrom}T00:00:00`));
      }

      if (incomeError) {
        console.error('Error fetching income for dashboard:', incomeError);
        incomeData = [];
      } else {
        incomeData = (income || []).map((i) => ({
          ...i,
          date: i.date || (i.created_at ? String(i.created_at).split('T')[0] : null),
          amount: i.amount ?? 0
        }));
      }
    } catch (err) {
      console.error('Exception fetching income for dashboard:', err);
      incomeData = [];
    }

    const calculateExpenses = (expenses, fromDate, toDate) => {
      if (!expenses || !Array.isArray(expenses)) {
        return 0;
      }

      // Only approved expenses should impact finance summary/net profit.
      const approvedExpenses = expenses.filter((e) => {
        const st = String(e?.approval_status || e?.status || 'pending').toLowerCase();
        return st === 'approved';
      });

      // If no date filter provided, include all expenses
      if (!fromDate || !toDate) {
        return approvedExpenses.reduce((sum, e) => {
          if (!e) return sum;
          return sum + (parseFloat(e.total_amount) || 0);
        }, 0);
      }

      let total = 0;
      const from = new Date(fromDate);
      const to = new Date(toDate);

      // Month-wise accounting for both subscription and additional rows:
      // only rows that exist in selected date range are counted.
      // This ensures deleting one month's subscription removes only that month.
      approvedExpenses.forEach((e) => {
        if (!e) return;
        const expenseDateStr = e.date || e.created_at;
        if (!expenseDateStr) return;
        const expenseDate = new Date(expenseDateStr);
        if (expenseDate >= from && expenseDate <= to) {
          total += parseFloat(e.total_amount || e.amount || 0) || 0;
        }
      });

      return total;
    };

    const calculateIncome = (entries, fromDate, toDate) => {
      if (!entries || !Array.isArray(entries)) return 0;
      return entries.reduce((sum, i) => {
        if (!i) return sum;
        const d = i.date;
        if (!d) return sum;
        if (fromDate && toDate && (d < fromDate || d > toDate)) return sum;
        return sum + (parseFloat(i.amount) || 0);
      }, 0);
    };

    const mtdExpenses = calculateExpenses(expensesData, mtdFrom, mtdTo);
    const qtdExpenses = calculateExpenses(expensesData, qtdFrom, qtdTo);
    const ytdExpenses = calculateExpenses(expensesData, ytdFrom, ytdTo);
    const mtdIncome = calculateIncome(incomeData, mtdFrom, mtdTo);
    const qtdIncome = calculateIncome(incomeData, qtdFrom, qtdTo);
    const ytdIncome = calculateIncome(incomeData, ytdFrom, ytdTo);

    // Calculate profits
    const mtdProfit = mtdRevenue.total + mtdIncome - mtdExpenses;
    const qtdProfit = qtdRevenue.total + qtdIncome - qtdExpenses;
    const ytdProfit = ytdRevenue.total + ytdIncome - ytdExpenses;

    // Get pending payments (check payments table instead)
    let pendingPayments = 0;
    try {
      const { data: pendingPaymentsData } = await supabaseAdmin
        .from('payments')
        .select('amount')
        .eq('status', 'pending');

      pendingPayments = pendingPaymentsData?.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) || 0;
    } catch (err) {
      console.error('Exception fetching pending payments:', err);
      pendingPayments = 0;
    }

    // Get pending commission — sessions booked (status) whose customer booking falls in picker range (IST)
    let totalPendingCommission = 0;
    try {
      const pendingSessionsInRange =
        mtdFrom && mtdTo
          ? sessionsData.filter((s) => {
              if (!s || s.status !== 'booked') return false;
              const ymd = getSessionBookingCreatedIstDateString(s);
              return !!(ymd && ymd >= mtdFrom && ymd <= mtdTo);
            })
          : sessionsData.filter((s) => s && s.status === 'booked');

      if (pendingSessionsInRange.length > 0) {
        const sessionIds = pendingSessionsInRange.map((s) => s.id);
        
        // Get commission_history for these sessions with pending status
        const { data: pendingCommission, error: commissionError } = await supabaseAdmin
          .from('commission_history')
          .select('commission_amount')
          .in('session_id', sessionIds)
          .eq('payment_status', 'pending');

        if (!commissionError && pendingCommission) {
          totalPendingCommission = pendingCommission.reduce((sum, c) => sum + (parseFloat(c.commission_amount) || 0), 0);
        }
      }
    } catch (err) {
      console.error('Exception fetching pending commission:', err);
      totalPendingCommission = 0;
    }

    // Get active sessions count
    const { data: activeSessions } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .in('status', ['booked'])
      .gte('scheduled_date', today.toISOString().split('T')[0]);

    // Total sessions card: distinct bookings (packages share payment_id; Wix shares wix_payload.sessionId). IST booking day; same psych roster as doctors.
    let totalSessions = 0;
    try {
      const rowsForCard = sessionsData.filter((s) => {
        if (!s || s.session_type === 'free_assessment') return false;
        if (!FINANCE_BOOKING_TOTAL_STATUSES.includes(s.status)) return false;
        if (financePsychIdSet && !(s.psychologist_id && financePsychIdSet.has(s.psychologist_id))) return false;
        if (!mtdFrom || !mtdTo) return true;
        const ymd = getSessionBookingCreatedIstDateString(s);
        return !!(ymd && ymd >= mtdFrom && ymd <= mtdTo);
      });
      totalSessions = countDistinctFinanceBookings(rowsForCard);
    } catch (err) {
      console.error('Error computing total sessions for dashboard:', err);
      totalSessions = 0;
    }

    // Get active doctors count (psychologists with at least one session) - exclude free assessments
    let activeDoctors = 0;
    try {
      const { data: activeDoctorsData } = await supabaseAdmin
        .from('sessions')
        .select('psychologist_id')
        .not('psychologist_id', 'is', null)
        .neq('session_type', 'free_assessment');
      
      if (activeDoctorsData && activeDoctorsData.length > 0) {
        const uniqueDoctors = new Set(activeDoctorsData.map(s => s.psychologist_id).filter(Boolean));
        activeDoctors = uniqueDoctors.size;
      }
    } catch (err) {
      console.error('Error fetching active doctors:', err);
      activeDoctors = 0;
    }

    // Get total commission paid
    let commissionPaid = 0;
    try {
      const { data: commissionData } = await supabaseAdmin
        .from('commission_history')
        .select('commission_amount')
        .eq('payment_status', 'paid');
      
      if (commissionData) {
        commissionPaid = commissionData.reduce((sum, c) => sum + (parseFloat(c.commission_amount) || 0), 0);
      }
    } catch (err) {
      console.error('Error fetching commission paid:', err);
      commissionPaid = 0;
    }

    // Calculate growth rates
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const lastMonthRevenue = calculateRevenue(sessionsData, lastMonth.toISOString().split('T')[0], lastMonthEnd.toISOString().split('T')[0]);
    const revenueGrowthMoM = lastMonthRevenue.total > 0 
      ? ((mtdRevenue.total - lastMonthRevenue.total) / lastMonthRevenue.total * 100).toFixed(2)
      : 0;

    const lastYear = new Date(today.getFullYear() - 1, 0, 1);
    const lastYearEnd = new Date(today.getFullYear() - 1, 11, 31);
    const lastYearRevenue = calculateRevenue(sessionsData, lastYear.toISOString().split('T')[0], lastYearEnd.toISOString().split('T')[0]);
    const revenueGrowthYoY = lastYearRevenue.total > 0
      ? ((ytdRevenue.total - lastYearRevenue.total) / lastYearRevenue.total * 100).toFixed(2)
      : 0;

    // Helper function to check if session should be included in revenue
    // Include all statuses where payment was made (sessions exist only after successful payment)
    const shouldIncludeInRevenue = (s) => {
      if (!s) return false;
      const paidStatuses = ['completed', 'booked', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow'];
      return paidStatuses.includes(s.status);
    };

    // Filter sessions for picker range: bookings created on an IST calendar day within range
    // If no date filter (all time), keep prior behavior (any session with scheduled_date)
    const filteredSessionsForDisplay = sessionsData.filter(s => {
      if (!s) return false;

      if (!mtdFrom || !mtdTo) {
        return !!(s.scheduled_date);
      }

      const bookedYmd = getSessionBookingCreatedIstDateString(s);
      return !!(bookedYmd && bookedYmd >= mtdFrom && bookedYmd <= mtdTo);
    });

    // Get revenue by session type (only if charts are needed)
    let revenueByType = { individual: 0, package: 0 };
    if (shouldIncludeCharts) {
      const revenueSessions = filteredSessionsForDisplay.filter(shouldIncludeInRevenue);
      revenueByType = {
        individual: revenueSessions
          .filter(s => s.session_type !== 'package')
          .reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0),
        package: revenueSessions
          .filter(s => s.session_type === 'package')
          .reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0),
      };
    }

    // Get top 3 doctors by revenue (filtered by date range)
    const doctorRevenue = {};
    filteredSessionsForDisplay.filter(shouldIncludeInRevenue).forEach(s => {
      if (s.psychologist_id) {
        if (!doctorRevenue[s.psychologist_id]) {
          doctorRevenue[s.psychologist_id] = { revenue: 0, session_count: 0 };
        }
        doctorRevenue[s.psychologist_id].revenue += parseFloat(s.price) || 0;
        doctorRevenue[s.psychologist_id].session_count += 1;
      }
    });

    const topDoctors = Object.entries(doctorRevenue)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 3)
      .map(([id, data]) => ({ psychologist_id: id, total_commission: data.revenue, session_count: data.session_count }));

    // Get recent bookings: latest 3 by client booking instant (Wix createdDate when known)
    const recentSessionsFiltered = filteredSessionsForDisplay
      .filter(shouldIncludeInRevenue)
      .sort((a, b) => {
        const createdA = new Date(getSessionBookingCreatedAtIso(a) || a.created_at || 0).getTime();
        const createdB = new Date(getSessionBookingCreatedAtIso(b) || b.created_at || 0).getTime();
        return createdB - createdA; // Latest booked first
      })
      .slice(0, 3);

    // Get all unique psychologist IDs for both top doctors and recent sessions
    const allPsychologistIds = [...new Set([
      ...topDoctors.map(d => d.psychologist_id),
      ...recentSessionsFiltered.map(s => s?.psychologist_id).filter(Boolean)
    ])];
    
    // Get all unique client IDs for recent sessions
    const allClientIds = [...new Set(recentSessionsFiltered.map(s => s?.client_id).filter(Boolean))];

    let allPsychologists = [];
    let allClients = [];
    
    if (allPsychologistIds.length > 0) {
      const { data: psychologists } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name')
        .in('id', allPsychologistIds);
      allPsychologists = psychologists || [];
    }
    
    if (allClientIds.length > 0) {
      const { data: clients } = await supabaseAdmin
        .from('clients')
        .select('id, first_name, last_name')
        .in('id', allClientIds);
      allClients = clients || [];
    }

    // Package progress for recent bookings: total from packages, session number per session
    const recentPackageIds = [...new Set(recentSessionsFiltered.map(s => s?.package_id).filter(Boolean))];
    let packageTotalById = {};
    let sessionNumberMap = {}; // key: session.id -> position number in package
    if (recentPackageIds.length > 0) {
      const { data: packagesList } = await supabaseAdmin
        .from('packages')
        .select('id, session_count')
        .in('id', recentPackageIds);
      (packagesList || []).forEach(p => {
        packageTotalById[p.id] = p.session_count ?? 0;
      });
      const pkgBcf = appendBookingTimeSelectFragment(dashBookingTimeCol);
      const { data: allPkgSessions } = await supabaseAdmin
        .from('sessions')
        .select(`id, client_id, package_id, created_at, ${pkgBcf} wix_payload, source`)
        .in('package_id', recentPackageIds)
        .order(dashBookingTimeCol, { ascending: true });
      const counterByClientPackage = {};
      (allPkgSessions || []).forEach(s => {
        if (s.client_id && s.package_id) {
          const key = `${s.client_id}:${s.package_id}`;
          counterByClientPackage[key] = (counterByClientPackage[key] || 0) + 1;
          sessionNumberMap[s.id] = counterByClientPackage[key];
        }
      });
    }

    // Get doctor names for top doctors
    let topDoctorsWithNames = [];
    if (topDoctors.length > 0) {
      topDoctorsWithNames = topDoctors.map(d => {
        const psych = allPsychologists.find(p => p.id === d.psychologist_id);
        return {
          ...d,
          first_name: psych?.first_name || 'Unknown',
          last_name: psych?.last_name || '',
          psychologist: psych ? { first_name: psych.first_name, last_name: psych.last_name } : null
        };
      });
    }

    // Get expense breakdown (only if charts are needed)
    const expenseByCategory = {};
    if (shouldIncludeCharts) {
      expensesData.forEach(e => {
        if (e && e.category) {
          if (!expenseByCategory[e.category]) {
            expenseByCategory[e.category] = 0;
          }
          expenseByCategory[e.category] += parseFloat(e.total_amount) || 0;
        }
      });
    }

    // Calculate monthly revenue for charts (last 12 months) - only if includeCharts is true
    const monthlyRevenueData = [];
    const monthlyExpensesData = [];
    const monthlyCommissionData = [];
    const monthlyDoctorWalletData = [];
    
    if (shouldIncludeCharts) {
      for (let i = 11; i >= 0; i--) {
        const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const monthNum = date.getMonth() + 1;
        const monthKey = `${date.getFullYear()}-${monthNum < 10 ? '0' : ''}${monthNum}`;
        const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        const monthStart = `${monthKey}-01`;
        const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0).toISOString().split('T')[0];
        
        const monthRevenue = calculateRevenue(sessionsData, monthStart, monthEnd);
        const monthExpenses = calculateExpenses(expensesData, monthStart, monthEnd);
        
        // Get commission data for this month
        let monthCommission = 0;
        let monthDoctorWallet = 0;
        try {
          const { data: monthCommissions } = await supabaseAdmin
            .from('commission_history')
            .select('commission_amount, session_amount')
            .gte('session_date', monthStart)
            .lte('session_date', monthEnd);
          
          if (monthCommissions) {
            monthCommission = monthCommissions.reduce((sum, c) => sum + (parseFloat(c.commission_amount) || 0), 0);
            monthDoctorWallet = monthCommissions.reduce((sum, c) => {
              const sessionAmount = parseFloat(c.session_amount || 0);
              const commissionAmount = parseFloat(c.commission_amount || 0);
              return sum + (sessionAmount - commissionAmount);
            }, 0);
          }
        } catch (err) {
          // Ignore errors
        }
        
        monthlyRevenueData.push({ month: monthName, revenue: monthRevenue.total });
        monthlyExpensesData.push({ month: monthName, expenses: monthExpenses });
        monthlyCommissionData.push({ month: monthName, commission: monthCommission });
        monthlyDoctorWalletData.push({ month: monthName, wallet: monthDoctorWallet });
      }
    }

    // Calculate commission breakdown - simple: use same logic as doctors page and sum all totals
    let totalCompanyCommission = 0; // Total company commission for sessions ORIGINALLY BOOKED in date range (uses original_scheduled_date, for revenue/net profit)
    let totalCompanyCommissionCompleted = 0; // Company commission from completed sessions (completed in date range)
    let totalDoctorWallet = 0; // Total doctor wallet for sessions ORIGINALLY BOOKED in date range (uses original_scheduled_date, for revenue calculation)
    let totalRevenueFromSessions = 0; // Calculate total revenue from sessions ORIGINALLY BOOKED in date range (uses original_scheduled_date)
    let totalRefundAmount = 0; // Total refunded amount in selected range
    let pendingPayout = 0; // Doctor wallet pending payment (completed-unpaid)
    let payout = 0; // Doctor wallet already paid (from payouts table in range)
    let completedDoctorWalletInRange = 0; // Total doctor wallet from completed sessions in range
    let pendingSessionsCount = 0; // Distinct finance bookings still non-completed in range (matches total_sessions dedupe)
    const pendingSessionsByFinanceBookingKey = new Set();
    let completedSessionsCount = 0; // Count of completed sessions scheduled in date range
    let rescheduledSessionsCount = 0; // Count of rescheduled sessions rescheduled FROM date range (original_scheduled_date in range)
    let rescheduleRequestedSessionsCount = 0; // Count of reschedule requested sessions scheduled in date range
    let noShowSessionsCount = 0; // Count of no show sessions scheduled in date range
    let upcomingSessionsCount = 0; // Distinct finance bookings with upcoming booked/rescheduled in range
    const upcomingSessionsByFinanceBookingKey = new Set();
    
    try {
      const allPsychIds = financeDashboardPsychIds;

      if (allPsychIds.length > 0) {
        // Get all sessions (same as doctors page) - include all paid statuses
        // IMPORTANT: Don't filter by scheduled_date here - we need all sessions to properly calculate
        // pending payouts (based on payment date) and completed payouts (based on completion date)
        // We'll filter in the processing loop based on different criteria for each metric
        let allSessionsQuery = supabaseAdmin
          .from('sessions')
          .select('id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, original_scheduled_date, status, payment_id, created_at, updated_at, completion_date, package_session_number, session_count, booking_created_at, wix_payload, source')
          .not('psychologist_id', 'is', null)
          .neq('session_type', 'free_assessment')
          .in('status', ['booked', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
          .in('psychologist_id', allPsychIds);

        if (!allTimeMode) {
          allSessionsQuery = allSessionsQuery.gte('created_at', `${ytdFrom}T00:00:00+05:30`);
        }
        allSessionsQuery = allSessionsQuery.order('created_at', { ascending: true }).limit(5000);
        
        // Fetch all relevant sessions - we'll filter by different date criteria in the processing loop:
        // - Pending payouts: Filter by created_at (payment date) within date range
        // - Completed payouts: Filter by updated_at (completion date) within date range  
        // - Revenue: Filter by scheduled_date within date range
        let allSessions = null;
        let allSessionsError = null;
        ({ data: allSessions, error: allSessionsError } = await allSessionsQuery.order('created_at', { ascending: true }));
        if (allSessionsError && String(allSessionsError.message || '').includes('payment_id')) {
          allSessionsQuery = supabaseAdmin
            .from('sessions')
            .select('id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, original_scheduled_date, status, created_at, updated_at, completion_date, package_session_number, session_count, booking_created_at, wix_payload, source')
            .not('psychologist_id', 'is', null)
            .neq('session_type', 'free_assessment')
            .in('status', ['booked', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
            .in('psychologist_id', allPsychIds);
          if (!allTimeMode) {
            allSessionsQuery = allSessionsQuery.gte('created_at', `${ytdFrom}T00:00:00+05:30`);
          }
          ({ data: allSessions, error: allSessionsError } = await allSessionsQuery.order('created_at', { ascending: true }).limit(5000));
        }
        if (allSessionsError && /booking_created_at/i.test(String(allSessionsError.message || ''))) {
          allSessionsQuery = supabaseAdmin
            .from('sessions')
            .select('id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, original_scheduled_date, status, payment_id, created_at, updated_at, completion_date, package_session_number, session_count, wix_payload, source')
            .not('psychologist_id', 'is', null)
            .neq('session_type', 'free_assessment')
            .in('status', ['booked', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
            .in('psychologist_id', allPsychIds);
          if (!allTimeMode) {
            allSessionsQuery = allSessionsQuery.gte('created_at', `${ytdFrom}T00:00:00+05:30`);
          }
          ({ data: allSessions, error: allSessionsError } = await allSessionsQuery.order('created_at', { ascending: true }).limit(5000));
          if (allSessionsError && String(allSessionsError.message || '').includes('payment_id')) {
            allSessionsQuery = supabaseAdmin
              .from('sessions')
              .select('id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, original_scheduled_date, status, created_at, updated_at, completion_date, package_session_number, session_count, wix_payload, source')
              .not('psychologist_id', 'is', null)
              .neq('session_type', 'free_assessment')
              .in('status', ['booked', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
              .in('psychologist_id', allPsychIds);
            if (!allTimeMode) {
              allSessionsQuery = allSessionsQuery.gte('created_at', `${ytdFrom}T00:00:00+05:30`);
            }
            ({ data: allSessions, error: allSessionsError } = await allSessionsQuery.order('created_at', { ascending: true }).limit(5000));
          }
        }
        if (allSessionsError) throw allSessionsError;
        
        // Get commission settings (same as doctors page)
        const { data: commissions } = await supabaseAdmin
          .from('doctor_commissions')
          .select('psychologist_id, commission_amounts, commission_amount_individual, commission_amount_package, doctor_commission_first_session, doctor_commission_followup, doctor_commission_individual, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages')
          .eq('is_active', true)
          .in('psychologist_id', allPsychIds)
          .order('effective_from', { ascending: false });
        
        // Build commission amounts map
        const commissionAmountsMap = {};
        const seenPsychIds = new Set();
        commissions?.forEach(c => {
          if (c.psychologist_id && !seenPsychIds.has(c.psychologist_id)) {
            seenPsychIds.add(c.psychologist_id);
            if (c.commission_amounts && typeof c.commission_amounts === 'object') {
              commissionAmountsMap[c.psychologist_id] = c.commission_amounts;
            } else {
              commissionAmountsMap[c.psychologist_id] = {
                individual: parseFloat(c.commission_amount_individual || 0),
                package: parseFloat(c.commission_amount_package || 0)
              };
            }
          }
        });
        
        // Get packages (need full package data for packagePricesMap)
        const { data: packages } = await supabaseAdmin
          .from('packages')
          .select('id, psychologist_id, package_type, name, price, session_count')
          .in('psychologist_id', allPsychIds);
        
        const packageTypeMap = {};
        const packagePricesMap = {};
        packages?.forEach(pkg => {
          packageTypeMap[pkg.id] = pkg.package_type || 'package';
          if (!packagePricesMap[pkg.psychologist_id]) {
            packagePricesMap[pkg.psychologist_id] = [];
          }
          packagePricesMap[pkg.psychologist_id].push({
            id: pkg.id,
            type: pkg.package_type,
            name: pkg.name || `${pkg.session_count} Session Package`,
            price: parseFloat(pkg.price) || 0,
            session_count: pkg.session_count || 1
          });
        });
        
        // Get commission history
        const sessionIds = allSessions?.map(s => s.id).filter(Boolean) || [];
        let commissionHistory = [];
        if (sessionIds.length > 0) {
          const { data: history } = await supabaseAdmin
            .from('commission_history')
            .select('session_id, commission_amount, session_amount, payment_status, payout_id')
            .in('session_id', sessionIds);
          commissionHistory = history || [];
        }
        
        const commissionHistoryMap = {};
        commissionHistory?.forEach(ch => {
          if (ch.session_id) {
            commissionHistoryMap[ch.session_id] = ch;
          }
        });
        
        // Build commission records map for doctor commission fields
        const commissionRecordsMap = {};
        commissions?.forEach(c => {
          if (c.psychologist_id && !commissionRecordsMap[c.psychologist_id]) {
            commissionRecordsMap[c.psychologist_id] = c;
          }
        });
        
        // Determine first sessions for each client (sorted by created_at)
        const clientFirstSessions = new Set();
        if (allSessions && allSessions.length > 0) {
          const sessionsByClient = {};
          allSessions.forEach(s => {
            if (!s.client_id) return;
            if (!sessionsByClient[s.client_id]) {
              sessionsByClient[s.client_id] = [];
            }
            sessionsByClient[s.client_id].push(s);
          });
          
          // For each client, mark the first paid session as first session
          Object.values(sessionsByClient).forEach(clientSessions => {
            // Sort by created_at to find the earliest session
            const sortedSessions = clientSessions.sort((a, b) => {
              const dateA = new Date(a.created_at || a.scheduled_date || 0);
              const dateB = new Date(b.created_at || b.scheduled_date || 0);
              return dateA - dateB;
            });
            
            // Mark the first session as first session
            if (sortedSessions.length > 0 && sortedSessions[0].id) {
              clientFirstSessions.add(sortedSessions[0].id);
            }
          });
        }
        
        // Calculate totals - separate completed vs pending
        // Apply different date filters for pending vs completed payouts
        let sessionsToProcess = allSessions || [];
        
        // Helper function to check if a date falls within the date range
        // Use mtdFrom/mtdTo which defaults to current month if not provided
        const isInDateRange = (dateStr) => {
          if (!mtdFrom || !mtdTo || !dateStr) return true; // If no date range, include all
          const date = (dateStr || '').split('T')[0]; // Extract date part (YYYY-MM-DD)
          return date >= mtdFrom && date <= mtdTo;
        };
        
        // "Passed" statuses: rescheduled, no_show, reschedule_requested (forward to scheduled month, exclude from total)
        const passedStatuses = ['rescheduled', 'reschedule_requested', 'no_show', 'noshow'];
        const isPassedStatus = (st) => passedStatuses.includes(st);

        const pendingCardBacklogFloorYmd =
          mtdFrom && mtdTo ? subtractMonthsFromIstCalendarYmd(mtdFrom, getPendingCardBacklogMonths()) : null;
        
        for (const s of sessionsToProcess) {
          if (!s.psychologist_id) continue;
          
          const sessionPrice = getSessionFinanceRevenueAmount(s);
          const historyRecord = commissionHistoryMap[s.id];
          const isCompleted = s.status === 'completed';
          const isRefunded = s.status === 'refunded';
          const isFirstSession = clientFirstSessions.has(s.id);
          const isInitialPackageSession = !!s.package_id && (parseInt(s.package_session_number, 10) || 0) === 1;
          const origDate = s.original_scheduled_date || s.scheduled_date;
          
          // Determine inclusion flags
          let shouldIncludeForPending = false;
          let shouldIncludeForCompleted = false;
          let shouldIncludeForRevenue = false;
          let shouldIncludeForRescheduledCount = false;   // rescheduled FROM this month (original_scheduled_date in range)
          let shouldIncludeForNoShowCount = false;   // no_show with scheduled_date in range
          let shouldIncludeForRescheduleRequestedCount = false;   // reschedule_requested with scheduled_date in range
          let shouldIncludeForUpcoming = false;   // upcoming sessions TO this month (scheduled_date in range, status booked/rescheduled)
          let shouldIncludeForTotal = false;   // new bookings only (original in range, NOT passed statuses)
          let shouldIncludeForPendingCount = false;
          let shouldIncludeForCompletedCount = false;
          
          // Always use mtdFrom/mtdTo for filtering (defaults to current month if not provided)
          let origInRange = false;
          let schedInRange = false;
          if (mtdFrom && mtdTo) {
            const bookedCreatedYmd = getSessionBookingCreatedIstDateString(s);
            const bookingCreatedInRange = !!(bookedCreatedYmd && bookedCreatedYmd >= mtdFrom && bookedCreatedYmd <= mtdTo);
            origInRange = bookingCreatedInRange;
            schedInRange = bookingCreatedInRange;

            // Revenue & totals: customer booking created in picker range (IST day)
            shouldIncludeForRevenue = bookingCreatedInRange;
            shouldIncludeForTotal = bookingCreatedInRange;

            if (s.status === 'rescheduled') shouldIncludeForRescheduledCount = bookingCreatedInRange;
            if (s.status === 'no_show' || s.status === 'noshow') shouldIncludeForNoShowCount = bookingCreatedInRange;
            if (s.status === 'reschedule_requested') shouldIncludeForRescheduleRequestedCount = bookingCreatedInRange;

            if ((s.status === 'booked' || s.status === 'rescheduled') && bookingCreatedInRange) {
              shouldIncludeForUpcoming = true;
            }

            const bookedInPreviousWindow = !!(bookedCreatedYmd && mtdFrom && bookedCreatedYmd < mtdFrom);

            if (isCompleted) {
              shouldIncludeForCompleted = bookingCreatedInRange;
              shouldIncludeForCompletedCount = bookingCreatedInRange;

              if (s.completion_date) {
                const completionDateStr = s.completion_date.split('T')[0];
                const wasPendingInThisMonth = completionDateStr > mtdTo;
                const bookedInThisMonth = bookingCreatedInRange;

                if (wasPendingInThisMonth && (bookedInThisMonth || bookedInPreviousWindow)) {
                  shouldIncludeForPending = true;
                  shouldIncludeForPendingCount = bookedInThisMonth;
                }
              }
            } else {
              const bookedInThisMonth = bookingCreatedInRange;
              const wasPendingInThisMonth = bookedInPreviousWindow || bookedInThisMonth;

              if (bookedInThisMonth) {
                shouldIncludeForPending = true;
                shouldIncludeForPendingCount = true;
              } else if (bookedInPreviousWindow && wasPendingInThisMonth) {
                shouldIncludeForPending = true;
                shouldIncludeForPendingCount = false;
              } else if (schedInRange && wasPendingInThisMonth) {
                shouldIncludeForPending = true;
                shouldIncludeForPendingCount = bookingCreatedInRange;
              }
            }
          } else {
            shouldIncludeForPending = !isCompleted;
            shouldIncludeForRevenue = true;
            shouldIncludeForTotal = true;
            shouldIncludeForRescheduledCount = (s.status === 'rescheduled');
            shouldIncludeForNoShowCount = (s.status === 'no_show' || s.status === 'noshow');
            shouldIncludeForRescheduleRequestedCount = (s.status === 'reschedule_requested');
            shouldIncludeForUpcoming = (s.status === 'booked' || s.status === 'rescheduled');
            shouldIncludeForPendingCount = !isCompleted;
            shouldIncludeForCompletedCount = isCompleted;
            if (isCompleted) shouldIncludeForCompleted = true;
          }
          
          // Skip if not relevant for any calculation
          if (!shouldIncludeForPending && !shouldIncludeForCompleted && !shouldIncludeForRevenue && 
              !shouldIncludeForRescheduledCount && !shouldIncludeForNoShowCount && !shouldIncludeForRescheduleRequestedCount && 
              !shouldIncludeForUpcoming && !shouldIncludeForTotal) {
            continue;
          }
          
          let commissionToCompany = 0;
          let toDoctorWallet = sessionPrice;
          
          // Count rescheduled sessions rescheduled FROM this month (original_scheduled_date in range)
          if (shouldIncludeForRescheduledCount) {
            rescheduledSessionsCount++;
          }
          
          // Count reschedule_requested sessions (scheduled_date in range)
          if (shouldIncludeForRescheduleRequestedCount) {
            rescheduleRequestedSessionsCount++;
          }
          
          // Count no_show sessions (scheduled_date in range)
          if (shouldIncludeForNoShowCount) {
            noShowSessionsCount++;
          }
          
          // Count upcoming sessions scheduled TO this month (scheduled_date in range, status booked/rescheduled)
          if (shouldIncludeForUpcoming) {
            const ubk = getFinanceBookingDedupeKey(s);
            if (ubk) upcomingSessionsByFinanceBookingKey.add(ubk);
          }
          
          if (isRefunded) {
            // Refunded sessions count toward total revenue only.
            commissionToCompany = 0;
            toDoctorWallet = 0;
          } else if (isCompleted) {
            // Completed session
            const isPackage = s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined' && s.package_id !== 'individual' ||
                             s.session_type === 'Package Session' || 
                             (s.session_type && s.session_type.toLowerCase().includes('package'));
            
            if (isPackage && s.package_id) {
              if (historyRecord) {
                const commissionAmount = parseFloat(historyRecord.commission_amount || 0);
                const sessionAmount = parseFloat(historyRecord.session_amount || sessionPrice);
                commissionToCompany = commissionAmount;
                toDoctorWallet = sessionAmount - commissionAmount;
              } else {
                const commissionRecord = commissionRecordsMap[s.psychologist_id] || {};
                const pkg = packagePricesMap[s.psychologist_id]?.find(p => p.id === s.package_id);
                const packageType = pkg?.type || packageTypeMap[s.package_id] || 'package';
                const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
                let doctorCommission = 0;

                if (isInitialPackageSession) {
                  const firstKey = `${packageType}_first_session`;
                  doctorCommission = parseFloat(
                    doctorCommissionPackages[firstKey] ?? commissionRecord?.doctor_commission_first_session_package ?? 0
                  ) || 0;
                } else {
                  const followKey = `${packageType}_followup`;
                  doctorCommission = parseFloat(
                    doctorCommissionPackages[followKey] ?? commissionRecord?.doctor_commission_followup_package ?? 0
                  ) || 0;
                }

                commissionToCompany = Math.max(0, sessionPrice - doctorCommission);
                toDoctorWallet = Math.min(sessionPrice, Math.max(0, doctorCommission));
              }

              if (shouldIncludeForCompleted) {
                totalCompanyCommissionCompleted += commissionToCompany;
                completedDoctorWalletInRange += toDoctorWallet;
              }
              if (shouldIncludeForCompletedCount && isCompleted) {
                completedSessionsCount++;
              }
            } else {
              // Individual session
              if (historyRecord) {
                // Use commission_history if it exists (already calculated)
                const commissionAmount = parseFloat(historyRecord.commission_amount || 0);
                const sessionAmount = parseFloat(historyRecord.session_amount || sessionPrice);
                commissionToCompany = commissionAmount;
                toDoctorWallet = sessionAmount - commissionAmount;
              } else {
                // Commission history doesn't exist yet - calculate from commission settings
                const commissionAmounts = commissionAmountsMap[s.psychologist_id];
                const commissionRecord = commissionRecordsMap[s.psychologist_id] || {};
                
                let doctorCommission = 0;
                
                // Individual/couple session
                const isCoupleSession = String(s.session_type || '').toLowerCase().includes('couple') || String(s.session_type || '').toLowerCase().includes('cpl');
                if (isCoupleSession) {
                  const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
                  doctorCommission = parseFloat(
                    doctorCommissionPackages.couple_session ??
                    doctorCommissionPackages.cpl_session ??
                    commissionRecord.doctor_commission_individual ??
                    0
                  ) || 0;
                } else if (isFirstSession && commissionRecord.doctor_commission_first_session !== null && commissionRecord.doctor_commission_first_session !== undefined) {
                  doctorCommission = parseFloat(commissionRecord.doctor_commission_first_session) || 0;
                } else if (!isFirstSession && commissionRecord.doctor_commission_followup !== null && commissionRecord.doctor_commission_followup !== undefined) {
                  doctorCommission = parseFloat(commissionRecord.doctor_commission_followup) || 0;
                } else {
                  // Fallback to individual commission calculation
                  const commissionAmount = parseFloat(commissionAmounts?.individual || 0);
                  doctorCommission = sessionPrice - commissionAmount;
                }
                
                commissionToCompany = Math.max(0, sessionPrice - doctorCommission);
                toDoctorWallet = Math.min(sessionPrice, Math.max(0, doctorCommission));
              }
              
              // Add to completed company commission (for net profit calculation) - only if in date range
              if (shouldIncludeForCompleted) {
                totalCompanyCommissionCompleted += commissionToCompany;
                // Completed sessions contribute to eligible doctor wallet in period.
                completedDoctorWalletInRange += toDoctorWallet;
              }
              
              // Count completed sessions: that month booked only (original_scheduled_date)
              if (shouldIncludeForCompletedCount && isCompleted) {
                completedSessionsCount++;
              }
            }
          } else {
            // Booked/Non-completed - calculate from commission settings (pending payout)
            const commissionAmounts = commissionAmountsMap[s.psychologist_id];
            const commissionRecord = commissionRecordsMap[s.psychologist_id] || {};
            
            const isPackage = s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined' && s.package_id !== 'individual' ||
                             s.session_type === 'Package Session' || 
                             (s.session_type && s.session_type.toLowerCase().includes('package'));
            
            let doctorCommission = 0;
            
            if (isPackage && s.package_id) {
              const pkg = packagePricesMap[s.psychologist_id]?.find(p => p.id === s.package_id);
              const packageType = pkg?.type || packageTypeMap[s.package_id] || 'package';
              const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};

              if (isInitialPackageSession) {
                const firstKey = `${packageType}_first_session`;
                doctorCommission = parseFloat(
                  doctorCommissionPackages[firstKey] ?? commissionRecord?.doctor_commission_first_session_package ?? 0
                ) || 0;
              } else {
                const followKey = `${packageType}_followup`;
                doctorCommission = parseFloat(
                  doctorCommissionPackages[followKey] ?? commissionRecord?.doctor_commission_followup_package ?? 0
                ) || 0;
              }

              commissionToCompany = Math.max(0, sessionPrice - doctorCommission);
              toDoctorWallet = Math.min(sessionPrice, Math.max(0, doctorCommission));

              // Pending payout amount should be based on completed-unpaid only.
            } else {
              // Individual/couple session
              const isCoupleSession = String(s.session_type || '').toLowerCase().includes('couple') || String(s.session_type || '').toLowerCase().includes('cpl');
              if (isCoupleSession) {
                const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
                doctorCommission = parseFloat(
                  doctorCommissionPackages.couple_session ??
                  doctorCommissionPackages.cpl_session ??
                  commissionRecord.doctor_commission_individual ??
                  0
                ) || 0;
              } else if (isFirstSession && commissionRecord.doctor_commission_first_session !== null && commissionRecord.doctor_commission_first_session !== undefined) {
                doctorCommission = parseFloat(commissionRecord.doctor_commission_first_session) || 0;
              } else if (!isFirstSession && commissionRecord.doctor_commission_followup !== null && commissionRecord.doctor_commission_followup !== undefined) {
                doctorCommission = parseFloat(commissionRecord.doctor_commission_followup) || 0;
              } else {
                // Fallback to individual commission calculation
                const commissionAmount = parseFloat(commissionAmounts?.individual || 0);
                doctorCommission = sessionPrice - commissionAmount;
              }
              
              commissionToCompany = Math.max(0, sessionPrice - doctorCommission);
              toDoctorWallet = Math.min(sessionPrice, Math.max(0, doctorCommission));
              
              // Add to pending payout (non-completed sessions including no_show, rescheduled, etc.)
              // Only include if scheduled_date is in the selected date range
              // For no_show sessions, shouldIncludeForPending should be set to schedInRange (line 750)
              // Pending payout amount should be based on completed-unpaid only.
              
              // Debug logging for no_show sessions to trace the issue
              if (s.status === 'no_show' || s.status === 'noshow') {
                console.log(`[NO_SHOW DEBUG] Session ${s.id.substring(0, 8)}...:`, {
                  status: s.status,
                  scheduled_date: s.scheduled_date?.split('T')[0],
                  original_scheduled_date: s.original_scheduled_date?.split('T')[0],
                  isCompleted,
                  shouldIncludeForPending,
                  shouldIncludeForRevenue,
                  schedInRange,
                  mtdFrom,
                  mtdTo,
                  doctorWallet: toDoctorWallet,
                  price: sessionPrice,
                  'pendingPayoutAfter': pendingPayout,
                  'totalDoctorWalletBefore': totalDoctorWallet
                });
              }
            }
          }
          
          // Add to commission totals based on different criteria:
          // 1. Revenue/Commission for sessions scheduled/completed in date range
          // Uses scheduled_date for non-completed, completion_date for completed sessions
          if (shouldIncludeForRevenue) {
            if (isRefunded) {
              totalRefundAmount += sessionPrice;
            }
            totalCompanyCommission += commissionToCompany;
            totalDoctorWallet += toDoctorWallet;
            totalRevenueFromSessions += sessionPrice; // Sum all session prices for total revenue
          }

          /* Pending sessions card:
           * − Bookings **created** in [mtdFrom, mtdTo] that are still open (same cohort as totals), and
           * − **carry-in**: booked before mtdFrom but still open (e.g. 5 left last month appear when viewing June),
           *   limited to FINANCE_PENDING_BACKLOG_MONTHS (default 36) so ancient rows stay out. */
          const pendingCardKey = getFinanceBookingDedupeKey(s);
          if (
            pendingCardKey &&
            !isCompleted &&
            !isRefunded &&
            PENDING_SESSION_CARD_STATUSES.has(String(s.status || '').toLowerCase())
          ) {
            const pendYmd = getSessionBookingCreatedIstDateString(s);
            if (pendYmd) {
              if (!mtdFrom || !mtdTo) {
                if (shouldIncludeForPendingCount) pendingSessionsByFinanceBookingKey.add(pendingCardKey);
              } else if (pendYmd >= mtdFrom && pendYmd <= mtdTo) {
                pendingSessionsByFinanceBookingKey.add(pendingCardKey);
              } else if (
                pendYmd < mtdFrom &&
                pendingCardBacklogFloorYmd &&
                pendYmd >= pendingCardBacklogFloorYmd
              ) {
                pendingSessionsByFinanceBookingKey.add(pendingCardKey);
              }
            }
          }
          
          // Note: pendingPayout and payout are already being added above in their respective sections
          // pendingPayout includes pending sessions scheduled in date range (uses scheduled_date for booked sessions) - this is correct
          // payout includes only sessions completed in date range (uses completion_date) - this is correct
        }

        pendingSessionsCount = pendingSessionsByFinanceBookingKey.size;
        upcomingSessionsCount = upcomingSessionsByFinanceBookingKey.size;

        // Paid payout amount in selected range.
        // Source of truth: commission_history payment_status for completed sessions in range.
        // (Fallback to payouts table only if history read fails.)
        try {
          let completedInRange = null;
          let completedInRangeErr = null;
          ({ data: completedInRange, error: completedInRangeErr } = await supabaseAdmin
            .from('sessions')
            .select('id, price, updated_at, completion_date, status')
            .eq('status', 'completed')
            .gte('updated_at', `${mtdFrom}${IST_DAY_START_SUFFIX}`)
            .lte('updated_at', `${mtdTo}${IST_DAY_END_SUFFIX}`));

          if (completedInRangeErr && String(completedInRangeErr.message || '').includes('updated_at')) {
            ({ data: completedInRange, error: completedInRangeErr } = await supabaseAdmin
              .from('sessions')
              .select('id, price, completion_date, status')
              .eq('status', 'completed')
              .gte('completion_date', `${mtdFrom}${IST_DAY_START_SUFFIX}`)
              .lte('completion_date', `${mtdTo}${IST_DAY_END_SUFFIX}`));
          }

          if (completedInRangeErr) throw completedInRangeErr;

          const completedIds = (completedInRange || []).map(s => s.id).filter(Boolean);
          if (completedIds.length === 0) {
            payout = 0;
          } else {
            let paidHistoryRows = null;
            let paidHistoryErr = null;
            ({ data: paidHistoryRows, error: paidHistoryErr } = await supabaseAdmin
              .from('commission_history')
              .select('session_id, session_amount, commission_amount, payment_status, payout_id, payment_id')
              .in('session_id', completedIds));

            if (paidHistoryErr && String(paidHistoryErr.message || '').includes('payment_status')) {
              ({ data: paidHistoryRows, error: paidHistoryErr } = await supabaseAdmin
                .from('commission_history')
                .select('session_id, session_amount, commission_amount, payout_id, payment_id')
                .in('session_id', completedIds));
            }

            if (paidHistoryErr && String(paidHistoryErr.message || '').includes('session_amount')) {
              ({ data: paidHistoryRows, error: paidHistoryErr } = await supabaseAdmin
                .from('commission_history')
                .select('session_id, commission_amount, payment_status, payout_id, payment_id')
                .in('session_id', completedIds));
            }

            if (paidHistoryErr && String(paidHistoryErr.message || '').includes('payment_status')) {
              ({ data: paidHistoryRows, error: paidHistoryErr } = await supabaseAdmin
                .from('commission_history')
                .select('session_id, commission_amount, payout_id, payment_id')
                .in('session_id', completedIds));
            }

            if (paidHistoryErr) throw paidHistoryErr;

            const sessionPriceMap = new Map((completedInRange || []).map(s => [s.id, parseFloat(s.price || 0) || 0]));
            payout = (paidHistoryRows || []).reduce((sum, row) => {
              if (!(row?.payment_status === 'paid' || row?.payout_id || row?.payment_id)) return sum;
              const sessionAmount = parseFloat(row?.session_amount ?? sessionPriceMap.get(row.session_id) ?? 0) || 0;
              const companyCommission = parseFloat(row?.commission_amount || 0) || 0;
              const wallet = Math.max(0, sessionAmount - companyCommission);
              return sum + wallet;
            }, 0);
          }
        } catch (paidPayoutError) {
          console.error('Error calculating paid payouts from commission_history, trying payouts fallback:', paidPayoutError);
          try {
            let paidPayoutRows = null;
            let paidPayoutErr = null;
            let paidPayoutQuery = supabaseAdmin
              .from('payouts')
              .select('*')
              .in('status', ['paid', 'completed']);
            if (mtdFrom && mtdTo) {
              paidPayoutQuery = paidPayoutQuery.gte('payout_date', mtdFrom).lte('payout_date', mtdTo);
            }
            ({ data: paidPayoutRows, error: paidPayoutErr } = await paidPayoutQuery);
            if (paidPayoutErr) throw paidPayoutErr;
            payout = (paidPayoutRows || []).reduce((sum, row) => {
              const rowAmount = parseFloat(row?.net_payout ?? row?.payout_amount ?? row?.amount ?? 0) || 0;
              return sum + rowAmount;
            }, 0);
          } catch (fallbackErr) {
            console.error('Error calculating paid payouts from payouts fallback:', fallbackErr);
            payout = 0;
          }
        }

        // Safety guard: paid payout in range cannot exceed completed wallet accrued in range.
        // Protects dashboard from legacy/mistyped payout rows (e.g. incorrect net_payout values).
        if (payout > completedDoctorWalletInRange) {
          console.warn('[finance-dashboard] paid payout exceeded completed wallet; clamping', {
            payout,
            completedDoctorWalletInRange
          });
          payout = completedDoctorWalletInRange;
        }

        // Recompute pending payout directly from commission_history payment states
        // so paid actions move amounts immediately from pending -> payout.
        try {
          let completedInRange = null;
          let completedInRangeErr = null;
          ({ data: completedInRange, error: completedInRangeErr } = await supabaseAdmin
            .from('sessions')
            .select('id, price, updated_at, completion_date, status')
            .eq('status', 'completed')
            .gte('updated_at', `${mtdFrom}${IST_DAY_START_SUFFIX}`)
            .lte('updated_at', `${mtdTo}${IST_DAY_END_SUFFIX}`));

          if (completedInRangeErr && String(completedInRangeErr.message || '').includes('updated_at')) {
            ({ data: completedInRange, error: completedInRangeErr } = await supabaseAdmin
              .from('sessions')
              .select('id, price, completion_date, status')
              .eq('status', 'completed')
              .gte('completion_date', `${mtdFrom}${IST_DAY_START_SUFFIX}`)
              .lte('completion_date', `${mtdTo}${IST_DAY_END_SUFFIX}`));
          }

          if (!completedInRangeErr) {
            const completedIds = (completedInRange || []).map(s => s.id).filter(Boolean);
            if (completedIds.length > 0) {
              let chRows = null;
              let chErr = null;
              ({ data: chRows, error: chErr } = await supabaseAdmin
                .from('commission_history')
                .select('session_id, session_amount, commission_amount, payment_status, payout_id, payment_id')
                .in('session_id', completedIds));

              if (chErr && String(chErr.message || '').includes('payment_status')) {
                ({ data: chRows, error: chErr } = await supabaseAdmin
                  .from('commission_history')
                  .select('session_id, session_amount, commission_amount, payout_id, payment_id')
                  .in('session_id', completedIds));
              }

              if (chErr && String(chErr.message || '').includes('session_amount')) {
                ({ data: chRows, error: chErr } = await supabaseAdmin
                  .from('commission_history')
                  .select('session_id, commission_amount, payment_status, payout_id, payment_id')
                  .in('session_id', completedIds));
              }

              if (chErr && String(chErr.message || '').includes('payment_status')) {
                ({ data: chRows, error: chErr } = await supabaseAdmin
                  .from('commission_history')
                  .select('session_id, commission_amount, payout_id, payment_id')
                  .in('session_id', completedIds));
              }

              if (!chErr) {
                const sessionPriceMap = new Map((completedInRange || []).map(s => [s.id, parseFloat(s.price || 0) || 0]));
                let pendingWalletFromHistory = 0;
                let completedWalletFromHistory = 0;

                (chRows || []).forEach((row) => {
                  const sessionAmount = parseFloat(row?.session_amount ?? sessionPriceMap.get(row.session_id) ?? 0) || 0;
                  const companyCommission = parseFloat(row?.commission_amount || 0) || 0;
                  const wallet = Math.max(0, sessionAmount - companyCommission);
                  completedWalletFromHistory += wallet;
                  if (!(row?.payment_status === 'paid' || row?.payout_id || row?.payment_id)) {
                    pendingWalletFromHistory += wallet;
                  }
                });

                completedDoctorWalletInRange = completedWalletFromHistory;
                pendingPayout = Math.max(0, pendingWalletFromHistory);
              } else {
                // fallback if commission history read fails
                pendingPayout = Math.max(0, completedDoctorWalletInRange - payout);
              }
            } else {
              completedDoctorWalletInRange = 0;
              pendingPayout = 0;
            }
          } else {
            // fallback if completed sessions read fails
            pendingPayout = Math.max(0, completedDoctorWalletInRange - payout);
          }
        } catch (pendingErr) {
          console.error('Error recalculating pending payout from history:', pendingErr);
          pendingPayout = Math.max(0, completedDoctorWalletInRange - payout);
        }
        
        // Same definition as total sessions card: distinct bookings, FINANCE_BOOKING_TOTAL_STATUSES, IST booking day in range
        const rowsForTotalSessions = sessionsToProcess.filter((s) => {
          if (!s || s.session_type === 'free_assessment') return false;
          if (!FINANCE_BOOKING_TOTAL_STATUSES.includes(s.status)) return false;
          if (mtdFrom && mtdTo) {
            const ymd = getSessionBookingCreatedIstDateString(s);
            return !!(ymd && ymd >= mtdFrom && ymd <= mtdTo);
          }
          return true;
        });
        totalSessions = countDistinctFinanceBookings(rowsForTotalSessions);
      }
    } catch (err) {
      console.error('Error calculating commission totals:', err);
    }

    // Audit log (non-blocking)
    auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_DASHBOARD_VIEWED',
      resource: 'finance_dashboard',
      endpoint: '/api/finance/dashboard',
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error (non-blocking):', err));

    // Profit = Total company commission (what company gets from commissions)
    // Total Revenue = Sum of all session prices (ALL sessions - completed + pending)
    // Net Profit = Company commission from ALL sessions (completed + pending) - expenses
    // Doctor Wallet = Total amount doctors get (pending + completed)
    // 
    // IMPORTANT: Net Profit uses ALL sessions (completed + pending) because:
    // - Payment has been received for all sessions (booked, completed, etc.)
    // - Company commission is recognized when payment is received, not when session is completed
    // - This gives a more accurate picture of company's financial position
    
    // Calculate net profit after expenses
    // For the date range, calculate expenses based on type:
    // - Subscription: count for every month in the range
    // - Additional: count only in the month they were added
    // Use total company commission (completed + pending) for net profit calculation
    
    // Calculate expenses for the selected date range (uses mtdFrom/mtdTo which defaults to current month)
    const expensesForSelectedRange = calculateExpenses(expensesData, mtdFrom, mtdTo);
    
    // Net profit = Company commission from sessions ORIGINALLY BOOKED in date range - expenses in date range
    // Note: totalCompanyCommission includes commissions for sessions ORIGINALLY BOOKED in the date range (uses original_scheduled_date)
    // This represents the company's commission from revenue received for sessions originally booked in this period
    const incomeForSelectedRange = calculateIncome(incomeData, mtdFrom, mtdTo);
    const netRevenueExcludingRefunds = totalRevenueFromSessions - totalRefundAmount;
    const netProfitForSelectedRange = netRevenueExcludingRefunds + incomeForSelectedRange - totalDoctorWallet - expensesForSelectedRange;
    
    // For MTD/QTD/YTD metrics, use totalCompanyCommission (sessions originally booked in those periods)
    const calculateRefundTotal = (sessions, fromDate, toDate, opts = {}) => {
      const byBookingCreated = !!(opts && opts.byBookingCreated);
      if (!sessions || !Array.isArray(sessions)) return 0;
      return sessions.reduce((sum, s) => {
        if (!s || s.status !== 'refunded') return sum;
        if (!fromDate || !toDate) return sum + getSessionFinanceRevenueAmount(s);
        let dateStr = '';
        if (byBookingCreated) {
          dateStr = getSessionBookingCreatedIstDateString(s);
        } else {
          const date = s.original_scheduled_date || s.scheduled_date;
          dateStr = typeof date === 'string' ? date.split('T')[0] : date;
        }
        if (!dateStr || dateStr < fromDate || dateStr > toDate) return sum;
        return sum + getSessionFinanceRevenueAmount(s);
      }, 0);
    };
    const mtdRefundTotal = calculateRefundTotal(sessionsData, mtdFrom, mtdTo, { byBookingCreated: true });
    const qtdRefundTotal = calculateRefundTotal(sessionsData, qtdFrom, qtdTo);
    const ytdRefundTotal = calculateRefundTotal(sessionsData, ytdFrom, ytdTo);
    const mtdNetProfit = (mtdRevenue.total - mtdRefundTotal) + mtdIncome - totalDoctorWallet - mtdExpenses;
    const qtdNetProfit = (qtdRevenue.total - qtdRefundTotal) + qtdIncome - totalDoctorWallet - qtdExpenses;
    const ytdNetProfit = (ytdRevenue.total - ytdRefundTotal) + ytdIncome - totalDoctorWallet - ytdExpenses;
    
    console.log('Finance dashboard summary calculated:', {
      totalRevenueFromSessions,
      totalRefundAmount,
      totalCompanyCommission,
      expensesForSelectedRange,
      totalSessions,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      mtdFrom,
      mtdTo,
      pendingSessionsCount,
      completedSessionsCount,
      usingStoredSnapshot: !!storedSnapshot
    });
    
    // Use stored snapshot only for locked PAST months.
    // Current month must stay live so pending/payout cards reflect recent mark-paid actions.
    let finalSummary = {};
    const now = new Date();
    const isCurrentFilterMonth = filterYear === now.getFullYear() && filterMonth === (now.getMonth() + 1);
    const useLockedSnapshot = !!(storedSnapshot && storedSnapshot.snapshot_locked && !isCurrentFilterMonth);

    if (useLockedSnapshot) {
      // Use stored snapshot data (preserved historical data)
      finalSummary = {
        total_revenue: parseFloat(storedSnapshot.total_revenue || 0),
        net_profit: parseFloat(storedSnapshot.net_profit || 0),
        total_expenses: parseFloat(storedSnapshot.total_expenses || 0),
        pending_payouts: parseFloat(storedSnapshot.pending_payout || 0),
        payout: parseFloat(storedSnapshot.payout_received || 0),
        total_sessions: storedSnapshot.total_sessions || 0,
        pending_sessions: storedSnapshot.pending_sessions || 0,
        completed_sessions: storedSnapshot.completed_sessions || 0,
        rescheduled_sessions: storedSnapshot.rescheduled_sessions || 0,
        reschedule_requested_sessions: storedSnapshot.reschedule_requested_sessions || 0,
        no_show_sessions: storedSnapshot.no_show_sessions || 0,
        upcoming_sessions: storedSnapshot.upcoming_sessions || 0,
        active_doctors: storedSnapshot.active_doctors || 0,
        total_company_commission: parseFloat(storedSnapshot.total_company_commission || 0),
        total_company_commission_completed: parseFloat(storedSnapshot.total_company_commission || 0), // Use same for completed
        total_doctor_wallet: parseFloat(storedSnapshot.total_doctor_wallet || 0),
        refund_total: parseFloat(storedSnapshot.refund_total || 0),
        revenue_change: revenueGrowthMoM ? `${revenueGrowthMoM > 0 ? '+' : ''}${revenueGrowthMoM}%` : null,
        revenue_change_type: parseFloat(revenueGrowthMoM) >= 0 ? 'increase' : 'decrease',
        profit_change: revenueGrowthMoM ? `${revenueGrowthMoM > 0 ? '+' : ''}${revenueGrowthMoM}%` : null,
        profit_change_type: parseFloat(revenueGrowthMoM) >= 0 ? 'increase' : 'decrease',
        expenses_change: null,
        expenses_change_type: null
      };
      console.log('Using stored monthly snapshot for historical data preservation (past locked month)');
    } else {
      // Use calculated values (live data)
      finalSummary = {
        total_revenue: totalRevenueFromSessions,
        net_profit: netProfitForSelectedRange,
        total_expenses: expensesForSelectedRange,
        pending_payouts: pendingPayout || 0,
        payout: payout || 0,
        total_sessions: totalSessions,
        pending_sessions: pendingSessionsCount || 0,
        completed_sessions: completedSessionsCount || 0,
        rescheduled_sessions: rescheduledSessionsCount || 0,
        reschedule_requested_sessions: rescheduleRequestedSessionsCount || 0,
        no_show_sessions: noShowSessionsCount || 0,
        upcoming_sessions: upcomingSessionsCount || 0,
        active_doctors: activeDoctors,
        total_company_commission: totalCompanyCommission,
        total_company_commission_completed: totalCompanyCommissionCompleted,
        total_doctor_wallet: totalDoctorWallet,
        refund_total: totalRefundAmount,
        revenue_change: revenueGrowthMoM ? `${revenueGrowthMoM > 0 ? '+' : ''}${revenueGrowthMoM}%` : null,
        revenue_change_type: parseFloat(revenueGrowthMoM) >= 0 ? 'increase' : 'decrease',
        profit_change: revenueGrowthMoM ? `${revenueGrowthMoM > 0 ? '+' : ''}${revenueGrowthMoM}%` : null,
        profit_change_type: parseFloat(revenueGrowthMoM) >= 0 ? 'increase' : 'decrease',
        expenses_change: null,
        expenses_change_type: null
      };
      
      // Store monthly snapshot if it's a full month filter
      // Only store if snapshot doesn't exist or is not locked
      // Only store for PAST months (never current/future month, to avoid stale dashboard cards)
      if (monthStartDate && monthEndDate) {
        const snapshotDate = new Date(monthStartDate);
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const isPastMonth = snapshotDate < currentMonthStart;
        
        // Only store if:
        // 1. No stored snapshot exists, OR
        // 2. Stored snapshot exists but is NOT locked (can be updated)
        const shouldStore = !storedSnapshot || (storedSnapshot && !storedSnapshot.snapshot_locked);
        
        if (isPastMonth && shouldStore) {
          // Store snapshot asynchronously (don't block response)
          // Don't force update - respect locked snapshots
          storeMonthlySnapshot({
            year: filterYear,
            month: filterMonth,
            total_sessions: totalSessions,
            pending_sessions: pendingSessionsCount || 0,
            completed_sessions: completedSessionsCount || 0,
            rescheduled_sessions: rescheduledSessionsCount || 0,
            reschedule_requested_sessions: rescheduleRequestedSessionsCount || 0,
            no_show_sessions: noShowSessionsCount || 0,
            upcoming_sessions: upcomingSessionsCount || 0,
            total_revenue: totalRevenueFromSessions,
            total_company_commission: totalCompanyCommission,
            total_doctor_wallet: totalDoctorWallet,
            refund_total: totalRefundAmount,
            pending_payout: pendingPayout || 0,
            payout_received: payout || 0,
            total_expenses: expensesForSelectedRange,
            net_profit: netProfitForSelectedRange,
            active_doctors: activeDoctors,
            snapshot_locked: false // Default to false, can be locked manually later
          }, false).catch(err => {
            console.error('Error storing monthly snapshot (non-blocking):', err);
          });
        } else if (storedSnapshot && storedSnapshot.snapshot_locked) {
          console.log(`📌 Monthly snapshot for ${filterYear}-${filterMonth} is locked. Using stored data and skipping update.`);
        }
      }
    }
    
    res.json(successResponse({
      summary: finalSummary,
      metrics: {
        revenue: {
          mtd: mtdRevenue.total,
          qtd: qtdRevenue.total,
          ytd: ytdRevenue.total,
          growthMoM: parseFloat(revenueGrowthMoM),
          growthYoY: parseFloat(revenueGrowthYoY)
        },
        expenses: {
          mtd: mtdExpenses,
          qtd: qtdExpenses,
          ytd: ytdExpenses
        },
        profit: {
          mtd: mtdProfit,
          qtd: qtdProfit,
          ytd: ytdProfit
        },
        pendingPayments,
        pendingCommission: totalPendingCommission,
        activeSessions: activeSessions?.length || 0
      },
      charts: shouldIncludeCharts ? {
        topDoctors: topDoctorsWithNames,
        revenueByType,
        expenseByCategory: Object.entries(expenseByCategory).map(([category, amount]) => ({
          category,
          amount
        })),
        monthlyRevenue: monthlyRevenueData,
        monthlyExpenses: monthlyExpensesData,
        monthlyCommission: monthlyCommissionData,
        monthlyDoctorWallet: monthlyDoctorWalletData,
        commissionBreakdown: {
          company: totalCompanyCommission,
          doctor: totalDoctorWallet
        }
      } : null,
      recent_sessions: recentSessionsFiltered.map(s => {
        if (!s) return null;
        const psych = allPsychologists.find(p => p.id === s.psychologist_id);
        const client = allClients.find(c => c.id === s.client_id);
        let package_progress = null;
        if (s.package_id && packageTotalById[s.package_id] != null) {
          const total = packageTotalById[s.package_id];
          const num = sessionNumberMap[s.id] ?? 0;
          package_progress = `${num}/${total}`;
        }
        return {
          id: s.id,
          session_date: s.scheduled_date,
          amount: s.price,
          status: s.status,
          session_type: s.session_type || 'individual',
          package_id: s.package_id || null,
          package_progress,
          psychologist: psych ? {
            id: psych.id,
            first_name: psych.first_name,
            last_name: psych.last_name
          } : null,
          client: client ? {
            id: client.id,
            first_name: client.first_name,
            last_name: client.last_name
          } : null
        };
      }).filter(Boolean),
      top_doctors: topDoctorsWithNames,
      monthly_revenue: shouldIncludeCharts ? monthlyRevenueData : []
    }, 'Dashboard data fetched successfully'));

  } catch (error) {
    console.error('Finance dashboard error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json(
      errorResponse(`Internal server error while fetching dashboard data: ${error.message || 'Unknown error'}`)
    );
  }
};

/**
 * Get Doctor-Level Payouts
 * GET /api/finance/payouts/doctors
 */
const getDoctorPayouts = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    // Security: Only finance, admin, superadmin can access
    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { dateFrom, dateTo, status } = req.query; // status: 'pending' or 'completed'

    // Get all psychologists (exclude assessment specialist)
    const assessmentPsychId = process.env.ASSESSMENT_PSYCHOLOGIST_ID || '00000000-0000-0000-0000-000000000000';
    const { data: psychologists } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email')
      .neq('id', assessmentPsychId);
    
    const allPsychIds = psychologists?.map(p => p.id).filter(Boolean) || [];
    
    if (allPsychIds.length === 0) {
      return res.json(successResponse({ payouts: [] }, 'No doctors found'));
    }

    // Get all sessions
    const allSessionsQuery = supabaseAdmin
      .from('sessions')
      .select('id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, original_scheduled_date, status, payment_id, created_at, updated_at, completion_date, package_session_number')
      .not('psychologist_id', 'is', null)
      .neq('session_type', 'free_assessment')
      .in('status', ['booked', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow'])
      .in('psychologist_id', allPsychIds);
    
    const { data: allSessions } = await allSessionsQuery.order('created_at', { ascending: true });
    
    // Get commission settings
    const { data: commissions } = await supabaseAdmin
      .from('doctor_commissions')
      .select('psychologist_id, commission_amounts, commission_amount_individual, commission_amount_package, doctor_commission_first_session, doctor_commission_followup, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages')
      .eq('is_active', true)
      .in('psychologist_id', allPsychIds)
      .order('effective_from', { ascending: false });
    
    // Build commission maps
    const commissionAmountsMap = {};
    const commissionRecordsMap = {};
    const seenPsychIds = new Set();
    commissions?.forEach(c => {
      if (c.psychologist_id && !seenPsychIds.has(c.psychologist_id)) {
        seenPsychIds.add(c.psychologist_id);
        if (c.commission_amounts && typeof c.commission_amounts === 'object') {
          commissionAmountsMap[c.psychologist_id] = c.commission_amounts;
        } else {
          commissionAmountsMap[c.psychologist_id] = {
            individual: parseFloat(c.commission_amount_individual || 0),
            package: parseFloat(c.commission_amount_package || 0)
          };
        }
        commissionRecordsMap[c.psychologist_id] = c;
      }
    });
    
    // Get packages
    const { data: packages } = await supabaseAdmin
      .from('packages')
      .select('id, psychologist_id, package_type, name, price, session_count')
      .in('psychologist_id', allPsychIds);
    
    const packageTypeMap = {};
    const packagePricesMap = {};
    packages?.forEach(pkg => {
      packageTypeMap[pkg.id] = pkg.package_type || 'package';
      if (!packagePricesMap[pkg.psychologist_id]) {
        packagePricesMap[pkg.psychologist_id] = [];
      }
      packagePricesMap[pkg.psychologist_id].push({
        id: pkg.id,
        type: pkg.package_type,
        name: pkg.name || `${pkg.session_count} Session Package`,
        price: parseFloat(pkg.price) || 0,
        session_count: pkg.session_count || 1
      });
    });
    
    // Get commission history
    const sessionIds = allSessions?.map(s => s.id).filter(Boolean) || [];
    let commissionHistory = [];
    if (sessionIds.length > 0) {
      const { data: history } = await supabaseAdmin
        .from('commission_history')
        .select('session_id, commission_amount, session_amount')
        .in('session_id', sessionIds);
      commissionHistory = history || [];
    }
    
    const commissionHistoryMap = {};
    commissionHistory?.forEach(ch => {
      if (ch.session_id) {
        commissionHistoryMap[ch.session_id] = ch;
      }
    });
    
    // Determine first sessions for each client
    const clientFirstSessions = new Set();
    if (allSessions && allSessions.length > 0) {
      const sessionsByClient = {};
      allSessions.forEach(s => {
        if (!s.client_id) return;
        if (!sessionsByClient[s.client_id]) {
          sessionsByClient[s.client_id] = [];
        }
        sessionsByClient[s.client_id].push(s);
      });
      
      Object.values(sessionsByClient).forEach(clientSessions => {
        const sortedSessions = clientSessions.sort((a, b) => {
          const dateA = new Date(a.created_at || a.scheduled_date || 0);
          const dateB = new Date(b.created_at || b.scheduled_date || 0);
          return dateA - dateB;
        });
        
        if (sortedSessions.length > 0 && sortedSessions[0].id) {
          clientFirstSessions.add(sortedSessions[0].id);
        }
      });
    }
    
    // Helper function to check if a date falls within the date range
    const isInDateRange = (dateStr) => {
      if (!dateFrom || !dateTo || !dateStr) return true;
      const date = dateStr.split('T')[0];
      return date >= dateFrom && date <= dateTo;
    };
    
    // Group payouts by doctor
    const payoutsByDoctor = {};
    
    for (const s of (allSessions || [])) {
      if (!s.psychologist_id) continue;
      
      const sessionPrice = parseFloat(s.price) || 0;
      const historyRecord = commissionHistoryMap[s.id];
      const isCompleted = s.status === 'completed';
      const isFirstSession = clientFirstSessions.has(s.id);
      const isInitialPackageSession = !!s.package_id && (parseInt(s.package_session_number, 10) || 0) === 1;
      
      // Determine if this session should be included
      let shouldInclude = false;
      
      if (status === 'pending') {
        // For pending: payment date in range AND not completed
        if (!isCompleted && isInDateRange(s.created_at)) {
          shouldInclude = true;
        }
      } else if (status === 'completed') {
        // For completed: filter by completion_date if available, otherwise use original scheduled date
        const completionDate = s.completion_date || s.original_scheduled_date || s.scheduled_date;
        if (isCompleted && completionDate && isInDateRange(completionDate)) {
          shouldInclude = true;
        }
      } else {
        // No status filter: include all
        shouldInclude = true;
      }
      
      if (!shouldInclude) continue;
      
      // Calculate commission
      let commissionToCompany = 0;
      let toDoctorWallet = sessionPrice;
      
      if (isCompleted) {
        if (historyRecord) {
          const commissionAmount = parseFloat(historyRecord.commission_amount || 0);
          const sessionAmount = parseFloat(historyRecord.session_amount || sessionPrice);
          commissionToCompany = commissionAmount;
          toDoctorWallet = sessionAmount - commissionAmount;
        } else {
          // Calculate from commission settings
          const commissionAmounts = commissionAmountsMap[s.psychologist_id];
          const commissionRecord = commissionRecordsMap[s.psychologist_id] || {};
          
          const isPackage = s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined' && s.package_id !== 'individual' ||
                           s.session_type === 'Package Session' || 
                           (s.session_type && s.session_type.toLowerCase().includes('package'));
          
          let doctorCommission = 0;
          
          if (isPackage) {
            const pkg = packagePricesMap[s.psychologist_id]?.find(p => p.id === s.package_id);
            const packageType = pkg?.type || packageTypeMap[s.package_id] || 'package';
            const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};

            if (isInitialPackageSession) {
              const firstKey = `${packageType}_first_session`;
              doctorCommission = parseFloat(
                doctorCommissionPackages[firstKey] ?? commissionRecord.doctor_commission_first_session_package ?? 0
              ) || 0;
            } else {
              const followKey = `${packageType}_followup`;
              doctorCommission = parseFloat(
                doctorCommissionPackages[followKey] ?? commissionRecord.doctor_commission_followup_package ?? 0
              ) || 0;
            }

            if (!doctorCommission) {
              const commissionAmount = parseFloat(commissionAmounts?.[packageType] || commissionAmounts?.package || 0);
              doctorCommission = sessionPrice - commissionAmount;
            }
          } else {
            const isCoupleSession = String(s.session_type || '').toLowerCase().includes('couple') || String(s.session_type || '').toLowerCase().includes('cpl');
            if (isCoupleSession) {
              const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
              doctorCommission = parseFloat(
                doctorCommissionPackages.couple_session ??
                doctorCommissionPackages.cpl_session ??
                commissionRecord.doctor_commission_individual ??
                0
              ) || 0;
            } else if (isFirstSession && commissionRecord.doctor_commission_first_session !== null && commissionRecord.doctor_commission_first_session !== undefined) {
              doctorCommission = parseFloat(commissionRecord.doctor_commission_first_session) || 0;
            } else if (!isFirstSession && commissionRecord.doctor_commission_followup !== null && commissionRecord.doctor_commission_followup !== undefined) {
              doctorCommission = parseFloat(commissionRecord.doctor_commission_followup) || 0;
            } else {
              const commissionAmount = parseFloat(commissionAmounts?.individual || 0);
              doctorCommission = sessionPrice - commissionAmount;
            }
          }
          
          commissionToCompany = Math.max(0, sessionPrice - doctorCommission);
          toDoctorWallet = Math.min(sessionPrice, Math.max(0, doctorCommission));
        }
      } else {
        // Non-completed: calculate from commission settings
        const commissionAmounts = commissionAmountsMap[s.psychologist_id];
        const commissionRecord = commissionRecordsMap[s.psychologist_id] || {};
        
        const isPackage = s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined' && s.package_id !== 'individual' ||
                         s.session_type === 'Package Session' || 
                         (s.session_type && s.session_type.toLowerCase().includes('package'));
        
        let doctorCommission = 0;
        
        if (isPackage) {
          const pkg = packagePricesMap[s.psychologist_id]?.find(p => p.id === s.package_id);
          const packageType = pkg?.type || packageTypeMap[s.package_id] || 'package';
          const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};

          if (isInitialPackageSession) {
            const firstKey = `${packageType}_first_session`;
            doctorCommission = parseFloat(
              doctorCommissionPackages[firstKey] ?? commissionRecord.doctor_commission_first_session_package ?? 0
            ) || 0;
          } else {
            const followKey = `${packageType}_followup`;
            doctorCommission = parseFloat(
              doctorCommissionPackages[followKey] ?? commissionRecord.doctor_commission_followup_package ?? 0
            ) || 0;
          }

          if (!doctorCommission) {
            const commissionAmount = parseFloat(commissionAmounts?.[packageType] || commissionAmounts?.package || 0);
            doctorCommission = sessionPrice - commissionAmount;
          }
        } else {
          const isCoupleSession = String(s.session_type || '').toLowerCase().includes('couple') || String(s.session_type || '').toLowerCase().includes('cpl');
          if (isCoupleSession) {
            const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
            doctorCommission = parseFloat(
              doctorCommissionPackages.couple_session ??
              doctorCommissionPackages.cpl_session ??
              commissionRecord.doctor_commission_individual ??
              0
            ) || 0;
          } else if (isFirstSession && commissionRecord.doctor_commission_first_session !== null && commissionRecord.doctor_commission_first_session !== undefined) {
            doctorCommission = parseFloat(commissionRecord.doctor_commission_first_session) || 0;
          } else if (!isFirstSession && commissionRecord.doctor_commission_followup !== null && commissionRecord.doctor_commission_followup !== undefined) {
            doctorCommission = parseFloat(commissionRecord.doctor_commission_followup) || 0;
          } else {
            const commissionAmount = parseFloat(commissionAmounts?.individual || 0);
            doctorCommission = sessionPrice - commissionAmount;
          }
        }
        
        commissionToCompany = Math.max(0, sessionPrice - doctorCommission);
        toDoctorWallet = Math.min(sessionPrice, Math.max(0, doctorCommission));
      }
      
      // Initialize doctor payout if not exists
      if (!payoutsByDoctor[s.psychologist_id]) {
        const psych = psychologists.find(p => p.id === s.psychologist_id);
        payoutsByDoctor[s.psychologist_id] = {
          psychologist_id: s.psychologist_id,
          psychologist: psych ? {
            id: psych.id,
            first_name: psych.first_name,
            last_name: psych.last_name,
            email: psych.email
          } : null,
          total_sessions: 0,
          total_company_commission: 0,
          total_doctor_wallet: 0,
          session_counts_by_type: {},
          session_details: []
        };
      }
      
      // Add to totals
      payoutsByDoctor[s.psychologist_id].total_sessions += 1;
      payoutsByDoctor[s.psychologist_id].total_company_commission += commissionToCompany;
      payoutsByDoctor[s.psychologist_id].total_doctor_wallet += toDoctorWallet;
      
      // Session type count
      const sessionType = s.package_id ? 'package' : 'individual';
      if (!payoutsByDoctor[s.psychologist_id].session_counts_by_type[sessionType]) {
        payoutsByDoctor[s.psychologist_id].session_counts_by_type[sessionType] = 0;
      }
      payoutsByDoctor[s.psychologist_id].session_counts_by_type[sessionType] += 1;
      
      // Add session detail
      payoutsByDoctor[s.psychologist_id].session_details.push({
        session_id: s.id,
        session_date: s.scheduled_date,
        session_type: sessionType,
        session_amount: sessionPrice,
        company_commission: commissionToCompany,
        doctor_wallet: toDoctorWallet
      });
    }
    
    // Convert to array and filter out doctors with no sessions
    const payouts = Object.values(payoutsByDoctor).filter(p => p.total_sessions > 0);
    
    // Audit log
    auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_DOCTOR_PAYOUTS_VIEWED',
      resource: 'payouts',
      endpoint: '/api/finance/payouts/doctors',
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));
    
    res.json(successResponse({ payouts }, 'Doctor payouts fetched successfully'));
    
  } catch (error) {
    console.error('Get doctor payouts error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching doctor payouts')
    );
  }
};

// ============================================
// SESSIONS MANAGEMENT
// ============================================

/**
 * Get All Sessions with Filters
 * GET /api/finance/sessions
 */
const getSessions = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const bookingTimeCol = await getBookingTimeColumnKey(supabaseAdmin);
    const sessBcf = appendBookingTimeSelectFragment(bookingTimeCol);

    const {
      dateFrom,
      dateTo,
      dateBasis = 'scheduled',
      includeUnpaid = 'false',
      psychologistId,
      sessionType,
      status,
      page = 1,
      limit = 50,
      search
    } = req.query;
    const normalizedDateBasis = String(dateBasis || 'scheduled').toLowerCase() === 'booked' ? 'booked' : 'scheduled';
    const shouldIncludeUnpaid = String(includeUnpaid || 'false').toLowerCase() === 'true';

    // Exclude free assessments. Finance sessions can optionally include unpaid Wix rows
    // so the page can mirror the admin/Wix booking lists when needed.
    let query = supabaseAdmin
      .from('sessions')
      .select(`
        id,
        created_at,
        ${sessBcf}
        wix_payload,
        scheduled_date,
        scheduled_time,
        price,
        status,
        payment_id,
        psychologist_id,
        client_id,
        session_type,
        source,
        wix_order_number,
        package_session_number,
        session_count,
        package_id
      `, { count: 'exact' })
      .neq('session_type', 'free_assessment'); // Exclude free assessments

    if (!shouldIncludeUnpaid) {
      query = query.not('payment_id', 'is', null); // Only sessions with payment_id
    }

    // Apply filters
    if (dateFrom) {
      if (normalizedDateBasis === 'booked') {
        query = query.gte(bookingTimeCol, `${dateFrom}${IST_DAY_START_SUFFIX}`);
      } else {
        query = query.gte('scheduled_date', dateFrom);
      }
    }
    if (dateTo) {
      if (normalizedDateBasis === 'booked') {
        query = query.lte(bookingTimeCol, `${dateTo}${IST_DAY_END_SUFFIX}`);
      } else {
        query = query.lte('scheduled_date', dateTo);
      }
    }
    if (psychologistId) {
      query = query.eq('psychologist_id', psychologistId);
    }
    if (status) {
      query = query.eq('status', status);
    }
    // Filter and paginate in memory so totals match the rows actually shown.
    query = query.order(normalizedDateBasis === 'booked' ? bookingTimeCol : 'scheduled_date', { ascending: false });

    const { data: sessions, error, count } = await query;

    if (error) {
      console.error('Error fetching sessions:', error);
      // Return empty result instead of throwing
      return res.json(successResponse({
        sessions: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          totalPages: 0
        }
      }, 'Sessions fetched successfully (empty)'));
    }

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 50);

    // Ensure sessions is an array
    let sessionsData = sessions || [];
    
    // Apply search filter after fetching (search by session ID only)
    if (search) {
      const searchLower = search.toLowerCase();
      sessionsData = sessionsData.filter(s => {
        const sessionId = s?.id?.toString().toLowerCase() || '';
        return sessionId.includes(searchLower);
      });
    }

    // Filter by successful payment status (paid, success, completed, cash)
    // when the caller wants paid finance rows only.
    const paymentIds = [...new Set(sessionsData.map(s => s.payment_id).filter(Boolean))];
    let successfulPaymentIds = [];
    
    if (paymentIds.length > 0) {
      const { data: payments, error: paymentError } = await supabaseAdmin
        .from('payments')
        .select('id, status')
        .in('id', paymentIds)
        .in('status', ['paid', 'success', 'completed', 'cash']); // Only successful payments
      
      if (!paymentError && payments) {
        successfulPaymentIds = payments.map(p => p.id);
      }
    }

    const sessionsForResponse = shouldIncludeUnpaid
      ? sessionsData
      : sessionsData.filter(s => s.payment_id && successfulPaymentIds.includes(s.payment_id));

    // Get commission data for each session
    const sessionIds = sessionsForResponse.map(s => s?.id).filter(Boolean);
    let commissions = [];
    
    if (sessionIds.length > 0) {
      const { data: commissionData, error: commissionError } = await supabaseAdmin
        .from('commission_history')
        .select('session_id, commission_amount, company_revenue, net_company_revenue, payment_status')
        .in('session_id', sessionIds);
      
      if (!commissionError && commissionData) {
        commissions = commissionData;
      }
    }

    // Get psychologist and client details separately
    const psychologistIds = [...new Set(sessionsData.map(s => s?.psychologist_id).filter(Boolean))];
    const clientIds = [...new Set(sessionsData.map(s => s?.client_id).filter(Boolean))];
    
    let psychologists = [];
    let clients = [];
    
    if (psychologistIds.length > 0) {
      const { data: psychData } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name')
        .in('id', psychologistIds);
      psychologists = psychData || [];
    }
    
    if (clientIds.length > 0) {
      const { data: clientData } = await supabaseAdmin
        .from('clients')
        .select('id, first_name, last_name, child_name, email')
        .in('id', clientIds);
      clients = clientData || [];
    }

    const sessionsWithCommission = sessionsForResponse.map(session => {
      if (!session) return null;
      const commission = commissions.find(c => c.session_id === session.id);
      const psychologist = psychologists.find(p => p.id === session.psychologist_id);
      const client = clients.find(c => c.id === session.client_id);
      
      return {
        ...session,
        booking_created_at: getSessionBookingCreatedAtIso(session),
        // Map backend fields to frontend expected fields
        session_date: session.scheduled_date,
        amount: session.price,
        session_type: session.session_type || 'Individual', // Default to Individual if not set
        psychologist: psychologist ? {
          id: psychologist.id,
          first_name: psychologist.first_name,
          last_name: psychologist.last_name
        } : null,
        client: client ? {
          id: client.id,
          first_name: client.first_name,
          last_name: client.last_name,
          child_name: client.child_name,
          email: client.email || null
        } : null,
        commission_amount: commission?.commission_amount || 0,
        company_revenue: commission?.company_revenue || 0,
        net_company_revenue: commission?.net_company_revenue || 0,
        commission_payment_status: commission?.payment_status || null,
        source: session.source || 'platform',
        wix_order_number: session.wix_order_number,
        package_session_number: session.package_session_number,
        session_count: session.session_count,
        package_id: session.package_id
      };
    }).filter(Boolean);
    
    // Apply final search filter on client/psychologist names if search provided
    let finalSessions = sessionsWithCommission;
    if (search) {
      const searchLower = search.toLowerCase();
      finalSessions = sessionsWithCommission.filter(s => {
        const sessionId = s?.id?.toString().toLowerCase() || '';
        const doctorName = `${s?.psychologist?.first_name || ''} ${s?.psychologist?.last_name || ''}`.toLowerCase();
        const clientName = `${s?.client?.first_name || ''} ${s?.client?.last_name || ''}`.toLowerCase();
        return sessionId.includes(searchLower) || 
               doctorName.includes(searchLower) || 
               clientName.includes(searchLower);
      });
    }

    finalSessions = finalSessions.filter((s) => !isHiddenWixListRow(s));
    const totalVisibleSessions = finalSessions.length;
    const offset = (safePage - 1) * safeLimit;
    const paginatedSessions = finalSessions.slice(offset, offset + safeLimit);

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_SESSIONS_VIEWED',
      resource: 'sessions',
      endpoint: '/api/finance/sessions',
      method: 'GET',
      details: { filters: req.query },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({
      sessions: paginatedSessions || [],
      filters: {
        dateBasis: normalizedDateBasis,
      },
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: totalVisibleSessions,
        totalPages: Math.max(1, Math.ceil(totalVisibleSessions / safeLimit))
      }
    }, 'Sessions fetched successfully'));

  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching sessions')
    );
  }
};

/**
 * Get compact doctor booking list for Finance doctor card modal
 * GET /api/finance/doctors/:psychologistId/bookings
 */
const getDoctorBookings = async (req, res) => {
  try {
    const userRole = req.user.role;
    const { psychologistId } = req.params;
    const { limit = 100, page = 1, dateFrom, dateTo, dateBasis = 'booked' } = req.query;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }
    if (!psychologistId) {
      return res.status(400).json(errorResponse('psychologistId is required'));
    }

    const docBookingTimeCol = await getBookingTimeColumnKey(supabaseAdmin);
    const docSelBcf = appendBookingTimeSelectFragment(docBookingTimeCol);

    const safeLimit = Math.min(300, Math.max(1, parseInt(limit, 10) || 100));
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const offset = (safePage - 1) * safeLimit;

    const normalizedDateBasis = String(dateBasis || 'booked').toLowerCase() === 'scheduled' ? 'scheduled' : 'booked';

    let query = supabaseAdmin
      .from('sessions')
      .select(
        `id,${docSelBcf}created_at,wix_payload,source,scheduled_date,scheduled_time,status,payment_id,wix_order_number,client_id`,
        { count: 'exact' }
      )
      .eq('psychologist_id', psychologistId)
      .neq('session_type', 'free_assessment')
      .in('status', ['booked', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded']);

    if (dateFrom) {
      if (normalizedDateBasis === 'booked') {
        query = query.gte(docBookingTimeCol, `${dateFrom}${IST_DAY_START_SUFFIX}`);
      } else {
        query = query.gte('scheduled_date', dateFrom);
      }
    }
    if (dateTo) {
      if (normalizedDateBasis === 'booked') {
        query = query.lte(docBookingTimeCol, `${dateTo}${IST_DAY_END_SUFFIX}`);
      } else {
        query = query.lte('scheduled_date', dateTo);
      }
    }

    const { data: sessions, error, count } = await query
      .order(normalizedDateBasis === 'booked' ? docBookingTimeCol : 'scheduled_date', { ascending: false })
      .range(offset, offset + safeLimit - 1);

    if (error) {
      console.error('Error fetching doctor bookings:', error);
      return res.status(500).json(errorResponse('Failed to fetch doctor bookings'));
    }

    const rows = sessions || [];
    const clientIds = [...new Set(rows.map((s) => s.client_id).filter(Boolean))];
    let clients = [];
    if (clientIds.length > 0) {
      const { data: clientData } = await supabaseAdmin
        .from('clients')
        .select('id,user_id,first_name,last_name,child_name,email')
        .in('id', clientIds);
      clients = clientData || [];
    }
    const userIds = [...new Set(clients.map((c) => c?.user_id).filter(Boolean))];
    let users = [];
    if (userIds.length > 0) {
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('id,email')
        .in('id', userIds);
      users = userData || [];
    }
    const userEmailById = new Map(users.map((u) => [u.id, u.email || null]));
    const clientById = new Map(clients.map((c) => [c.id, c]));

    const bookings = rows.map((s) => {
      const c = clientById.get(s.client_id);
      return {
        id: s.id,
        order_id: s.wix_order_number || s.payment_id || s.id,
        booked_at: getSessionBookingCreatedAtIso(s),
        session_date: s.scheduled_date || null,
        session_time: s.scheduled_time || null,
        status: s.status || null,
        client: c
          ? {
              id: c.id,
              first_name: c.first_name,
              last_name: c.last_name,
              child_name: c.child_name,
              email: c.email || userEmailById.get(c.user_id) || null,
            }
          : null,
      };
    });

    return res.json(
      successResponse(
        {
          bookings,
          filters: {
            dateBasis: normalizedDateBasis,
            ...(dateFrom && dateTo ? { dateFrom, dateTo } : {}),
          },
          pagination: {
            page: safePage,
            limit: safeLimit,
            total: count || 0,
            totalPages: Math.ceil((count || 0) / safeLimit),
          },
        },
        'Doctor bookings fetched successfully'
      )
    );
  } catch (error) {
    console.error('Get doctor bookings error:', error);
    return res.status(500).json(errorResponse('Internal server error while fetching doctor bookings'));
  }
};

/**
 * Get Session Details
 * GET /api/finance/sessions/:sessionId
 */
const getSessionDetails = async (req, res) => {
  try {
    const userRole = req.user.role;
    const { sessionId } = req.params;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    // Get session with related data
    const { data: session, error } = await supabaseAdmin
      .from('sessions')
      .select(`
        *,
        psychologist:psychologists(*),
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          child_age,
          phone_number,
          date_of_birth,
          gender,
          user:users(
            email
          )
        )
      `)
      .eq('id', sessionId)
      .single();

    if (error || !session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // Get complete payment details
    let paymentDetails = null;
    if (session.payment_id) {
      const { data: payment, error: paymentError } = await supabaseAdmin
        .from('payments')
        .select('*')
        .eq('id', session.payment_id)
        .single();
      
      if (!paymentError && payment) {
        // Extract payment method from payment record or Razorpay response
        let paymentMethod = payment.payment_method;
        
        // If payment_method is not stored, try to extract from razorpay_response
        if (!paymentMethod && payment.razorpay_response) {
          const razorpayResponse = typeof payment.razorpay_response === 'string' 
            ? JSON.parse(payment.razorpay_response) 
            : payment.razorpay_response;
          
          // Razorpay stores method in payment.entity.method
          if (razorpayResponse.payment?.entity?.method) {
            paymentMethod = razorpayResponse.payment.entity.method;
          } else if (razorpayResponse.method) {
            paymentMethod = razorpayResponse.method;
          } else if (razorpayResponse.razorpay_payment_id) {
            // If there's a payment ID but no method, it's an online payment
            paymentMethod = 'online';
          }
        }
        
        // Map Razorpay method names to readable format
        let paymentMethodDisplay = paymentMethod;
        if (paymentMethod && paymentMethod !== 'cash') {
          const methodMap = {
            'netbanking': 'Net Banking',
            'card': 'Card Payment',
            'credit_card': 'Card Payment',
            'debit_card': 'Card Payment',
            'upi': 'UPI Payment',
            'wallet': 'Wallet Payment',
            'online': 'Online Payment'
          };
          paymentMethodDisplay = methodMap[paymentMethod.toLowerCase()] || 'Online Payment';
        } else if (paymentMethod === 'cash') {
          paymentMethodDisplay = 'Cash Payment';
        }
        
        paymentDetails = {
          id: payment.id,
          transaction_id: payment.transaction_id,
          razorpay_order_id: payment.razorpay_order_id,
          razorpay_payment_id: payment.razorpay_payment_id,
          amount: payment.amount,
          currency: payment.currency || 'INR',
          status: payment.status,
          payment_method: paymentMethodDisplay || paymentMethod || 'Online Payment',
          payment_date: payment.completed_at || payment.created_at,
          receipt_url: payment.receipt_url,
          reference_number: payment.reference_number,
          notes: payment.notes,
          razorpay_params: payment.razorpay_params
        };
      }
    }

    // Get receipt details if available
    let receiptDetails = null;
    if (paymentDetails?.transaction_id) {
      const { data: receipt, error: receiptError } = await supabaseAdmin
        .from('receipts')
        .select('*')
        .eq('transaction_id', paymentDetails.transaction_id)
        .maybeSingle();
      
      if (!receiptError && receipt) {
        receiptDetails = {
          receipt_number: receipt.receipt_number,
          receipt_number_long: receipt.receipt_number_long,
          receipt_url: receipt.receipt_url,
          file_path: receipt.file_path,
          file_url: receipt.file_url,
          created_at: receipt.created_at
        };
      }
    }

    // Get commission data
    const { data: commission } = await supabaseAdmin
      .from('commission_history')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_SESSION_DETAILS_VIEWED',
      resource: 'sessions',
      resourceId: sessionId,
      endpoint: `/api/finance/sessions/${sessionId}`,
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    const bookedInstant = getSessionBookingCreatedAtIso(session);

    res.json(successResponse({
      session: {
        id: session.id,
        session_date: session.scheduled_date,
        session_time: session.scheduled_time,
        status: session.status,
        session_type: session.session_type,
        price: session.price,
        package_id: session.package_id,
        booking_created_at: bookedInstant,
        created_at: session.created_at,
        updated_at: session.updated_at,
        psychologist: session.psychologist ? {
          id: session.psychologist.id,
          first_name: session.psychologist.first_name,
          last_name: session.psychologist.last_name,
          email: session.psychologist.email,
          phone: session.psychologist.phone,
          cover_image_url: session.psychologist.cover_image_url,
          specialization: session.psychologist.specialization,
          experience_years: session.psychologist.experience_years
        } : null,
        client: session.client ? {
          id: session.client.id,
          first_name: session.client.first_name,
          last_name: session.client.last_name,
          child_name: session.client.child_name,
          phone_number: session.client.phone_number,
          email: session.client.user?.email || null,
          date_of_birth: session.client.date_of_birth,
          gender: session.client.gender
        } : null,
        payment: paymentDetails,
        receipt: receiptDetails,
        commission: commission || null
      }
    }, 'Session details fetched successfully'));

  } catch (error) {
    console.error('Get session details error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching session details')
    );
  }
};

// ============================================
// REVENUE MANAGEMENT
// ============================================

/**
 * Get Revenue Summary
 * GET /api/finance/revenue
 */
const getRevenue = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { dateFrom, dateTo, psychologistId, sessionType } = req.query;

    // Get sessions with commission data
    // Exclude free assessments
    let query = supabaseAdmin
      .from('sessions')
      .select(`
        id,
        scheduled_date,
        price,
        psychologist_id,
        status,
        session_type,
        psychologist:psychologists(id, first_name, last_name)
      `)
      .eq('status', 'completed')
      .neq('session_type', 'free_assessment');

    if (dateFrom) query = query.gte('scheduled_date', dateFrom);
    if (dateTo) query = query.lte('scheduled_date', dateTo);
    if (psychologistId) query = query.eq('psychologist_id', psychologistId);

    const { data: sessions, error } = await query;

    if (error) throw error;

    // Get commission data
    const sessionIds = sessions?.map(s => s.id) || [];
    const { data: commissions } = await supabaseAdmin
      .from('commission_history')
      .select('session_id, commission_amount, company_revenue, net_company_revenue')
      .in('session_id', sessionIds);

    // Calculate totals
    const totalRevenue = sessions?.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0) || 0;
    const totalCommission = commissions?.reduce((sum, c) => sum + (parseFloat(c.commission_amount) || 0), 0) || 0;
    const totalCompanyRevenue = commissions?.reduce((sum, c) => sum + (parseFloat(c.company_revenue) || 0), 0) || 0;
    const totalNetRevenue = commissions?.reduce((sum, c) => sum + (parseFloat(c.net_company_revenue) || 0), 0) || 0;

    // Revenue by doctor
    const revenueByDoctor = {};
    sessions?.forEach(s => {
      const commission = commissions?.find(c => c.session_id === s.id);
      if (!revenueByDoctor[s.psychologist_id]) {
        revenueByDoctor[s.psychologist_id] = {
          id: s.psychologist_id,
          psychologist_id: s.psychologist_id,
          first_name: s.psychologist?.first_name || 'Unknown',
          last_name: s.psychologist?.last_name || '',
          revenue: 0,
          session_count: 0
        };
      }
      revenueByDoctor[s.psychologist_id].revenue += parseFloat(s.price) || 0;
      revenueByDoctor[s.psychologist_id].session_count += 1;
    });

    // Revenue by session type
    const revenueByType = {};
    sessions?.forEach(s => {
      const sessionType = s.session_type || 'Individual';
      if (!revenueByType[sessionType]) {
        revenueByType[sessionType] = {
          session_type: sessionType,
          revenue: 0,
          session_count: 0
        };
      }
      revenueByType[sessionType].revenue += parseFloat(s.price) || 0;
      revenueByType[sessionType].session_count += 1;
    });

    // Monthly breakdown
    const monthlyBreakdown = {};
    sessions?.forEach(s => {
      if (s.scheduled_date) {
        const monthKey = s.scheduled_date.substring(0, 7); // YYYY-MM
        const dateObj = new Date(s.scheduled_date + 'T00:00:00');
        const monthName = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        if (!monthlyBreakdown[monthKey]) {
          monthlyBreakdown[monthKey] = {
            month: monthName,
            monthKey: monthKey,
            revenue: 0
          };
        }
        monthlyBreakdown[monthKey].revenue += parseFloat(s.price) || 0;
      }
    });

    // Sort monthly breakdown by monthKey (chronologically)
    const sortedMonthlyBreakdown = Object.values(monthlyBreakdown).sort((a, b) => {
      return a.monthKey.localeCompare(b.monthKey);
    });

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_REVENUE_VIEWED',
      resource: 'revenue',
      endpoint: '/api/finance/revenue',
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({
      total_revenue: totalRevenue,
      net_revenue: totalNetRevenue,
      total_sessions: sessions?.length || 0,
      monthly_breakdown: sortedMonthlyBreakdown,
      by_doctor: Object.values(revenueByDoctor),
      by_session_type: Object.values(revenueByType)
    }, 'Revenue data fetched successfully'));

  } catch (error) {
    console.error('Get revenue error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching revenue data')
    );
  }
};

// ============================================
// EXPENSE MANAGEMENT
// ============================================

/**
 * Get Expenses
 * GET /api/finance/expenses
 */
const getExpenses = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { dateFrom, dateTo, category, approvalStatus, expenseType, page = 1, limit = 50 } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let expenses = [];
    let count = 0;

    let query = supabaseAdmin
      .from('expenses')
      .select('*', { count: 'exact' })
      .order('date', { ascending: false });

    if (dateFrom) query = query.gte('date', dateFrom);
    if (dateTo) query = query.lte('date', dateTo);
    if (category) query = query.eq('category', category);
    if (approvalStatus) query = query.eq('approval_status', approvalStatus);
    if (expenseType) query = query.eq('expense_type', expenseType);
    query = query.range(offset, offset + parseInt(limit) - 1);

    let result = await query;

    // Fallback for older schema where `date` column does not exist.
    if (result.error && String(result.error.message || '').includes('column expenses.date does not exist')) {
      let fallbackQuery = supabaseAdmin
        .from('expenses')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });
      if (category) fallbackQuery = fallbackQuery.eq('category', category);
      if (approvalStatus) fallbackQuery = fallbackQuery.eq('approval_status', approvalStatus);
      if (expenseType) fallbackQuery = fallbackQuery.eq('expense_type', expenseType);
      fallbackQuery = fallbackQuery.range(offset, offset + parseInt(limit) - 1);
      result = await fallbackQuery;
    }

    if (result.error) {
      // If expenses table is missing, return empty state instead of 500.
      if (result.error.code === '42P01' || result.error.code === 'PGRST205') {
        return res.json(successResponse({
          expenses: [],
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: 0,
            totalPages: 0
          }
        }, 'Expenses table not found; returning empty data'));
      }
      throw result.error;
    }

    expenses = result.data || [];
    count = result.count || 0;

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_EXPENSES_VIEWED',
      resource: 'expenses',
      endpoint: '/api/finance/expenses',
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    // For subscription expenses, also fetch history if subscription_id exists
    const expensesWithHistory = await Promise.all((expenses || []).map(async (expense) => {
      if (expense.expense_type === 'subscription' && expense.subscription_id) {
        let history = [];
        let historyRes = await supabaseAdmin
          .from('expenses')
          .select('id, date, amount, total_amount, description')
          .eq('subscription_id', expense.subscription_id)
          .order('date', { ascending: false });
        if (historyRes.error && String(historyRes.error.message || '').includes('column expenses.date does not exist')) {
          historyRes = await supabaseAdmin
            .from('expenses')
            .select('id, amount, total_amount, description, created_at')
            .eq('subscription_id', expense.subscription_id)
            .order('created_at', { ascending: false });
        }
        history = historyRes.data || [];
        expense.history = history || [];
      }
      // Use custom_category if available, otherwise use category
      if (expense.custom_category) {
        expense.display_category = expense.custom_category;
      } else {
        expense.display_category = expense.category;
      }
      // Map approval_status to status for frontend compatibility
      expense.status = expense.approval_status || 'pending';
      return expense;
    }));

    res.json(successResponse({
      expenses: expensesWithHistory || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        totalPages: Math.ceil((count || 0) / parseInt(limit))
      }
    }, 'Expenses fetched successfully'));

  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching expenses')
    );
  }
};

/**
 * Create Expense
 * POST /api/finance/expenses
 */
const createExpense = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const {
      date,
      category,
      custom_category,
      description,
      amount,
      payment_method,
      vendor_supplier,
      receipt_url,
      is_recurring = false,
      recurring_frequency,
      expense_type = 'additional',
      subscription_id
    } = req.body;

    // Use custom_category if provided, otherwise use category
    const finalCategory = custom_category && custom_category.trim() ? custom_category.trim() : category;

    if (!date || (!category && !custom_category) || !amount) {
      return res.status(400).json(
        errorResponse('Date, category (or custom category), and amount are required')
      );
    }

    const total_amount = parseFloat(amount);
    const expenseDate = new Date(date);
    const expenseMonth = expenseDate.getMonth() + 1;
    const expenseYear = expenseDate.getFullYear();

    let finalSubscriptionId = subscription_id;
    let finalAmount = parseFloat(amount);

    // For subscription expenses, handle history and auto-fill amount
    if (expense_type === 'subscription') {
      // If subscription_id is provided, this is updating an existing subscription
      if (subscription_id) {
        finalSubscriptionId = subscription_id;
      } else {
        // Multiple subscriptions are allowed (even in same month/category).
        // If there is a prior subscription chain for this category, reuse its subscription_id.
        // Find previous month's expense for this category to get subscription_id and amount
        // Match by either category or custom_category
        const { data: previousExpenses } = await supabaseAdmin
          .from('expenses')
          .select('*')
          .eq('expense_type', 'subscription')
          .or(`category.eq.${finalCategory},custom_category.eq.${finalCategory}`)
          .lt('date', `${expenseYear}-${expenseMonth < 10 ? '0' : ''}${expenseMonth}-01`)
          .order('date', { ascending: false })
          .limit(1);

        if (previousExpenses && previousExpenses.length > 0) {
          const prevExpense = previousExpenses[0];
          finalSubscriptionId = prevExpense.subscription_id || prevExpense.id;
          // If amount not provided, use previous month's amount
          if (!amount || amount === '') {
            finalAmount = parseFloat(prevExpense.amount) || 0;
          }
        } else {
          // First time creating this subscription - create new subscription_id
          finalSubscriptionId = null; // Will be set to this expense's id after insert
        }
      }
    }

    const { data: expense, error } = await supabaseAdmin
      .from('expenses')
      .insert([{
        date,
        category: finalCategory,
        custom_category: custom_category && custom_category.trim() ? custom_category.trim() : null,
        description,
        amount: finalAmount,
        total_amount: finalAmount,
        payment_method,
        vendor_supplier,
        receipt_url,
        is_recurring,
        recurring_frequency,
        expense_type: expense_type === 'subscription' ? 'subscription' : 'additional',
        subscription_id: finalSubscriptionId,
        approval_status: 'pending',
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    // If this is the first subscription expense, update it to use its own id as subscription_id
    if (expense_type === 'subscription' && !finalSubscriptionId && expense) {
      await supabaseAdmin
        .from('expenses')
        .update({ subscription_id: expense.id })
        .eq('id', expense.id);
      expense.subscription_id = expense.id;
    }

    if (error) throw error;

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_EXPENSE_CREATED',
      resource: 'expenses',
      resourceId: expense.id,
      endpoint: '/api/finance/expenses',
      method: 'POST',
      details: { amount, category },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.status(201).json(
      successResponse(expense, 'Expense created successfully')
    );

  } catch (error) {
    console.error('Create expense error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating expense')
    );
  }
};

/**
 * Approve Expense
 * POST /api/finance/expenses/:expenseId/approve
 */
const approveExpense = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    const { expenseId } = req.params;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { data: expense, error: fetchError } = await supabaseAdmin
      .from('expenses')
      .select('*')
      .eq('id', expenseId)
      .single();

    if (fetchError || !expense) {
      return res.status(404).json(
        errorResponse('Expense not found')
      );
    }

    const { data: updatedExpense, error } = await supabaseAdmin
      .from('expenses')
      .update({
        approval_status: 'approved',
        approved_by: userId,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', expenseId)
      .select()
      .single();

    if (error) throw error;

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_EXPENSE_APPROVED',
      resource: 'expenses',
      resourceId: expenseId,
      endpoint: `/api/finance/expenses/${expenseId}/approve`,
      method: 'POST',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(
      successResponse(updatedExpense, 'Expense approved successfully')
    );

  } catch (error) {
    console.error('Approve expense error:', error);
    res.status(500).json(
      errorResponse('Internal server error while approving expense')
    );
  }
};

/**
 * Update Expense
 * PUT /api/finance/expenses/:expenseId
 */
const updateExpense = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    const { expenseId } = req.params;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const {
      date,
      category,
      custom_category,
      description,
      amount,
      payment_method,
      vendor_supplier,
      receipt_url,
      reference_number,
      notes,
      is_recurring,
      recurring_frequency,
      expense_type,
      subscription_id
    } = req.body;

    // Use custom_category if provided, otherwise use category
    const finalCategory = custom_category && custom_category.trim() ? custom_category.trim() : category;

    // Check if expense exists
    const { data: existingExpense, error: checkError } = await supabaseAdmin
      .from('expenses')
      .select('*')
      .eq('id', expenseId)
      .single();

    if (checkError || !existingExpense) {
      return res.status(404).json(
        errorResponse('Expense not found')
      );
    }

    // Build update data - only include fields that have actually changed
    const updateData = {
      updated_at: new Date().toISOString()
    };

    // Only update fields that are provided AND different from existing values
    if (date && date !== existingExpense.date) updateData.date = date;
    if (category !== undefined || custom_category !== undefined) {
      const newCategory = finalCategory;
      const newCustomCategory = custom_category && custom_category.trim() ? custom_category.trim() : null;
      const existingCustomCategory = existingExpense.custom_category || null;
      if (newCategory !== existingExpense.category || newCustomCategory !== existingCustomCategory) {
        updateData.category = newCategory;
        updateData.custom_category = newCustomCategory;
      }
    }
    if (description !== undefined && description !== (existingExpense.description || '')) updateData.description = description;
    if (subscription_id !== undefined && subscription_id !== existingExpense.subscription_id) updateData.subscription_id = subscription_id;
    if (amount !== undefined) {
      const parsedAmount = parseFloat(amount);
      const existingAmount = parseFloat(existingExpense.amount || 0);
      if (parsedAmount !== existingAmount) {
        updateData.amount = parsedAmount;
        // Recalculate total_amount if amount changed
        updateData.total_amount = parsedAmount;
      }
    }
    if (payment_method !== undefined && payment_method !== (existingExpense.payment_method || '')) updateData.payment_method = payment_method;
    if (vendor_supplier !== undefined && vendor_supplier !== (existingExpense.vendor_supplier || '')) updateData.vendor_supplier = vendor_supplier;
    if (receipt_url !== undefined && receipt_url !== (existingExpense.receipt_url || '')) updateData.receipt_url = receipt_url;
    if (reference_number !== undefined && reference_number !== (existingExpense.reference_number || '')) updateData.reference_number = reference_number;
    if (notes !== undefined && notes !== (existingExpense.notes || '')) updateData.notes = notes;
    if (is_recurring !== undefined && is_recurring !== existingExpense.is_recurring) updateData.is_recurring = is_recurring;
    if (recurring_frequency !== undefined && recurring_frequency !== (existingExpense.recurring_frequency || '')) updateData.recurring_frequency = recurring_frequency;
    if (expense_type !== undefined) {
      const newExpenseType = expense_type === 'subscription' ? 'subscription' : 'additional';
      if (newExpenseType !== existingExpense.expense_type) {
        updateData.expense_type = newExpenseType;
      }
    }

    // Only perform update if there are actual changes (besides updated_at)
    let updatedExpense;
    let error;
    
    if (Object.keys(updateData).length > 1) {
      const { data, error: updateError } = await supabaseAdmin
        .from('expenses')
        .update(updateData)
        .eq('id', expenseId)
        .select()
        .single();
      
      updatedExpense = data;
      error = updateError;
    } else {
      // No changes, return existing expense
      updatedExpense = existingExpense;
      error = null;
    }

    if (error) {
      console.error('Error updating expense:', error);
      throw error;
    }

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_EXPENSE_UPDATED',
      resource: 'expenses',
      resourceId: expenseId,
      endpoint: `/api/finance/expenses/${expenseId}`,
      method: 'PUT',
      details: { amount: updatedExpense.amount, category: updatedExpense.category },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(
      successResponse(updatedExpense, 'Expense updated successfully')
    );

  } catch (error) {
    console.error('Update expense error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating expense')
    );
  }
};

/**
 * Delete Expense
 * DELETE /api/finance/expenses/:expenseId
 */
const deleteExpense = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    const { expenseId } = req.params;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    // Check if expense exists
    const { data: existingExpense, error: checkError } = await supabaseAdmin
      .from('expenses')
      .select('*')
      .eq('id', expenseId)
      .single();

    if (checkError || !existingExpense) {
      return res.status(404).json(
        errorResponse('Expense not found')
      );
    }

    // Delete expense
    const { error } = await supabaseAdmin
      .from('expenses')
      .delete()
      .eq('id', expenseId);

    if (error) {
      console.error('Error deleting expense:', error);
      throw error;
    }

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_EXPENSE_DELETED',
      resource: 'expenses',
      resourceId: expenseId,
      endpoint: `/api/finance/expenses/${expenseId}`,
      method: 'DELETE',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(
      successResponse(null, 'Expense deleted successfully')
    );

  } catch (error) {
    console.error('Delete expense error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting expense')
    );
  }
};

// ============================================
// COMMISSION MANAGEMENT
// ============================================

/** `booked` = filter by booking_created_at when present, else created_at. `scheduled` = scheduled_date / therapy day. */
function parseFinanceDoctorDateBasis(query) {
  const raw = String(query?.dateBasis ?? 'booked').toLowerCase();
  return raw === 'scheduled' ? 'scheduled' : 'booked';
}

function hasConfiguredMoneyValue(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

function toMoneyNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Get Doctor Commissions
 * GET /api/finance/commissions
 */
const getCommissions = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { psychologistId, month, year, dateFrom, dateTo } = req.query;
    const doctorDateBasis = parseFinanceDoctorDateBasis(req.query);

    const commissionBookingTimeCol = await getBookingTimeColumnKey(supabaseAdmin);
    const commSessionsBcf = appendBookingTimeSelectFragment(commissionBookingTimeCol);

    // Get ALL psychologists (not just those with sessions)
    // Filter out assessment specialist
    const assessmentEmail = (process.env.FREE_ASSESSMENT_PSYCHOLOGIST_EMAIL || 'assessment.koott@gmail.com').toLowerCase();
    
    let psychologists = [];
    try {
      // Use select('*') to stay compatible across environments where some
      // optional columns (e.g., individual_session_price) may not exist yet.
      let query = supabaseAdmin
        .from('psychologists')
        .select('*')
        // Include psychologists even when email is null/empty.
        // Exclude only the configured assessment specialist email.
        .or(`email.is.null,email.neq.${assessmentEmail}`)
        .order('first_name', { ascending: true });

      if (psychologistId) {
        query = query.eq('id', psychologistId);
      }

      const { data: psychData, error: psychError } = await query;
      
      if (psychError) {
        console.error('Error fetching psychologists:', psychError);
        psychologists = [];
      } else {
        psychologists = psychData || [];
      }
    } catch (err) {
      console.error('Exception fetching psychologists:', err);
      psychologists = [];
    }

    // Align finance-doctors base listing with Koott Therapists:
    // if we can resolve linked therapists from wix_bookings, prioritize that subset.
    try {
      const { data: wixRows } = await supabaseAdmin
        .from('wix_bookings')
        .select('therapist_name,payload,created_at')
        .order('created_at', { ascending: false })
        .limit(3000);

      if (wixRows?.length && psychologists?.length) {
        const psychByEmail = new Map();
        const psychByName = new Map();
        psychologists.forEach((p) => {
          const email = String(p.email || '').trim().toLowerCase();
          if (email) psychByEmail.set(email, p);
          const nameKey = `${String(p.first_name || '').trim().toLowerCase()} ${String(p.last_name || '').trim().toLowerCase()}`.trim();
          if (nameKey) psychByName.set(nameKey, p);
        });

        const matchedPsychIds = new Set();
        wixRows.forEach((r) => {
          const payload = r.payload || {};
          const t = payload.therapist || {};
          const email = String(t.email || '').trim().toLowerCase();
          const nameKey = String(r.therapist_name || t.name || t.displayName || t.fullName || '').trim().toLowerCase();
          const matched = (email && psychByEmail.get(email)) || psychByName.get(nameKey) || null;
          if (matched?.id) matchedPsychIds.add(matched.id);
        });

        // Do NOT hard-filter the finance doctors list to Wix matches only.
        // Finance should still show all psychologist profiles (including missing-email rows).
      }
    } catch (wixFilterErr) {
      console.warn('Wix therapist alignment skipped in getCommissions:', wixFilterErr?.message || wixFilterErr);
    }

    // Deduplicate psychologists by identity key:
    // - prefer email when available
    // - fallback to normalized full name
    // This prevents repeated rows when duplicate psychologist records exist.
    const psychIdentityMap = new Map();
    for (const p of (psychologists || [])) {
      const emailKey = String(p.email || '').trim().toLowerCase();
      const nameKey = `${String(p.first_name || '').trim().toLowerCase()} ${String(p.last_name || '').trim().toLowerCase()}`.trim();
      const key = emailKey ? `email:${emailKey}` : `name:${nameKey}`;
      if (!key || key === 'name:') continue;

      const existing = psychIdentityMap.get(key);
      if (!existing) {
        psychIdentityMap.set(key, p);
        continue;
      }

      // Keep the richer profile row (email/phone/image), fallback to latest updated_at.
      const score = (row) => {
        let s = 0;
        if (row?.email) s += 4;
        if (row?.phone) s += 2;
        if (row?.cover_image_url || row?.profile_picture_url) s += 1;
        if (row?.updated_at) s += 0.5;
        return s;
      };
      const existingScore = score(existing);
      const candidateScore = score(p);
      if (candidateScore > existingScore) {
        psychIdentityMap.set(key, p);
      } else if (candidateScore === existingScore) {
        const existingUpdated = new Date(existing.updated_at || existing.created_at || 0).getTime();
        const candidateUpdated = new Date(p.updated_at || p.created_at || 0).getTime();
        if (candidateUpdated > existingUpdated) {
          psychIdentityMap.set(key, p);
        }
      }
    }
    psychologists = Array.from(psychIdentityMap.values());

    const allPsychologistIds = psychologists.map(p => p.id);

    // Build Koott-therapists-style Wix booking count map by matched psychologist.
    const wixCountsByPsychId = {};
    try {
      const { data: wixRows } = await supabaseAdmin
        .from('wix_bookings')
        .select('therapist_name,created_at,payload')
        .order('created_at', { ascending: false })
        .limit(5000);

      if (wixRows?.length && psychologists?.length) {
        // Same summary keying as admin/wix-therapists page source logic.
        const summary = new Map();
        for (const r of wixRows) {
          const payload = r.payload || {};
          const t = payload.therapist || {};
          const name = String(r.therapist_name || t.name || t.displayName || t.fullName || '').trim();
          const email = String(t.email || '').trim().toLowerCase() || null;
          if (!name && !email) continue;
          const key = `${name.toLowerCase()}|${email || ''}`;
          const existing = summary.get(key);
          if (!existing) {
            summary.set(key, { name, email, bookingsCount: 1, latestBookingAt: r.created_at || null });
          } else {
            existing.bookingsCount += 1;
            if ((r.created_at || '') > (existing.latestBookingAt || '')) {
              existing.latestBookingAt = r.created_at;
            }
          }
        }

        const psychByEmail = new Map();
        const psychByName = new Map();
        psychologists.forEach((p) => {
          const email = String(p.email || '').trim().toLowerCase();
          if (email) psychByEmail.set(email, p);
          const nameKey = `${String(p.first_name || '').trim().toLowerCase()} ${String(p.last_name || '').trim().toLowerCase()}`.trim();
          if (nameKey) psychByName.set(nameKey, p);
        });

        for (const t of summary.values()) {
          const nameKey = String(t.name || '').trim().toLowerCase();
          const matched = (t.email && psychByEmail.get(t.email)) || psychByName.get(nameKey) || null;
          if (!matched?.id) continue;
          if (!wixCountsByPsychId[matched.id]) {
            wixCountsByPsychId[matched.id] = { bookingsCount: 0, latestBookingAt: null };
          }
          wixCountsByPsychId[matched.id].bookingsCount += t.bookingsCount || 0;
          if ((t.latestBookingAt || '') > (wixCountsByPsychId[matched.id].latestBookingAt || '')) {
            wixCountsByPsychId[matched.id].latestBookingAt = t.latestBookingAt || null;
          }
        }
      }
    } catch (wixCountErr) {
      console.warn('Wix booking count enrichment failed in getCommissions:', wixCountErr?.message || wixCountErr);
    }

    // Get package prices for each psychologist
    const packagePricesMap = {};
    const individualPriceMap = {};
    const packageTypeMap = {}; // Map package_id to package_type
    if (allPsychologistIds.length > 0) {
      try {
        const { data: packages } = await supabaseAdmin
          .from('packages')
          .select('id, psychologist_id, package_type, price, session_count, name')
          .in('psychologist_id', allPsychologistIds)
          .order('session_count', { ascending: true });

        packages?.forEach(pkg => {
          if (pkg.package_type === 'individual') {
            // Use package table as fallback source for individual session price.
            if (!individualPriceMap[pkg.psychologist_id]) {
              individualPriceMap[pkg.psychologist_id] = parseFloat(pkg.price) || 0;
            }
            return;
          }
          packageTypeMap[pkg.id] = pkg.package_type || 'package'; // Store package type mapping
          if (!packagePricesMap[pkg.psychologist_id]) {
            packagePricesMap[pkg.psychologist_id] = [];
          }
          packagePricesMap[pkg.psychologist_id].push({
            id: pkg.id,
            type: pkg.package_type,
            name: pkg.name || `${pkg.session_count} Session Package`,
            price: parseFloat(pkg.price) || 0,
            session_count: pkg.session_count || 1,
            price_per_session: (parseFloat(pkg.price) || 0) / (pkg.session_count || 1)
          });
        });
      } catch (err) {
        console.error('Error fetching package prices:', err);
      }
    }

    // Get all sessions (booked, completed, rescheduled, etc.) for counts, but commissions only for completed
    let allSessionsQuery = supabaseAdmin
      .from('sessions')
      .select(`id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, status, created_at, ${commSessionsBcf} wix_payload, source, package_session_number`)
      .not('psychologist_id', 'is', null)
      .neq('session_type', 'free_assessment')
      .in('status', ['booked', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow']); // Include all paid sessions

    if (dateFrom && dateTo) {
      if (doctorDateBasis === 'scheduled') {
        allSessionsQuery = allSessionsQuery
          .gte('scheduled_date', dateFrom)
          .lte('scheduled_date', dateTo);
      } else {
        const createdFrom = `${dateFrom}${IST_DAY_START_SUFFIX}`;
        const createdTo = `${dateTo}${IST_DAY_END_SUFFIX}`;
        allSessionsQuery = allSessionsQuery
          .gte(commissionBookingTimeCol, createdFrom)
          .lte(commissionBookingTimeCol, createdTo);
      }
    } else if (month && year) {
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
      if (doctorDateBasis === 'scheduled') {
        allSessionsQuery = allSessionsQuery
          .gte('scheduled_date', startDate)
          .lte('scheduled_date', endDate);
      } else {
        allSessionsQuery = allSessionsQuery
          .gte(commissionBookingTimeCol, `${startDate}${IST_DAY_START_SUFFIX}`)
          .lte(commissionBookingTimeCol, `${endDate}${IST_DAY_END_SUFFIX}`);
      }
    }

    const { data: allSessions } = await allSessionsQuery;

    // Get commission rates for all psychologists
    let commissions = [];
    if (allPsychologistIds.length > 0) {
      try {
        let commissionData = null;
        let error = null;

        // Preferred path (newer schema with is_active)
        ({ data: commissionData, error } = await supabaseAdmin
          .from('doctor_commissions')
          .select('*')
          .eq('is_active', true)
          .in('psychologist_id', allPsychologistIds)
          .order('effective_from', { ascending: false }));

        // Backward-compatible fallback (older schema without is_active column)
        const errMsg = String(error?.message || '');
        if (error && (errMsg.includes('is_active') || errMsg.includes('effective_from'))) {
          console.warn('doctor_commissions schema mismatch; falling back to basic latest-record query');
          ({ data: commissionData, error } = await supabaseAdmin
            .from('doctor_commissions')
            .select('*')
            .in('psychologist_id', allPsychologistIds));
        }

        if (error) {
          console.error('Error fetching commissions:', error);
          commissions = [];
        } else {
          commissions = commissionData || [];
        }
      } catch (err) {
        console.error('Exception fetching commissions:', err);
        commissions = [];
      }
    }

    // Build commission amounts map and store full commission records (from JSONB or legacy columns)
    // Only use the most recent commission for each psychologist (first one since ordered by effective_from DESC)
    const commissionAmountsMap = {};
    const commissionRecordsMap = {}; // Store full commission records for doctor commission fields
    const seenPsychologistIds = new Set();
    commissions?.forEach(c => {
      if (c.psychologist_id && !seenPsychologistIds.has(c.psychologist_id)) {
        seenPsychologistIds.add(c.psychologist_id);
        commissionRecordsMap[c.psychologist_id] = c; // Store full record
        
        // Try JSONB first
        if (c.commission_amounts && typeof c.commission_amounts === 'object') {
          commissionAmountsMap[c.psychologist_id] = c.commission_amounts;
        } else {
          // Fallback to legacy columns
          commissionAmountsMap[c.psychologist_id] = {
            individual: c.commission_amount_individual !== null && c.commission_amount_individual !== undefined ? parseFloat(c.commission_amount_individual) : 0,
            package: c.commission_amount_package !== null && c.commission_amount_package !== undefined ? parseFloat(c.commission_amount_package) : 0
          };
        }
      }
    });
    
    // Get commission history for all sessions
    const sessionIds = allSessions?.map(s => s.id).filter(Boolean) || [];
    let commissionHistory = [];
    if (sessionIds.length > 0) {
      const { data: history } = await supabaseAdmin
        .from('commission_history')
        .select('psychologist_id, commission_amount, company_revenue, session_id, session_date, session_amount')
        .in('session_id', sessionIds);
      commissionHistory = history || [];
    }

    // Build commissions map
    const commissionsMap = {};
    commissions?.forEach(c => {
      if (c.psychologist_id) {
        commissionsMap[c.psychologist_id] = c;
      }
    });

    // Build commission history map by session_id
    const commissionHistoryMap = {};
    commissionHistory?.forEach(ch => {
      if (ch.session_id) {
        commissionHistoryMap[ch.session_id] = ch;
      }
    });

    // Determine first sessions for each client (sorted by created_at) - SAME LOGIC AS getDashboard
    const clientFirstSessions = new Set();
    if (allSessions && allSessions.length > 0) {
      const sessionsByClient = {};
      allSessions.forEach(s => {
        if (!s.client_id) return;
        if (!sessionsByClient[s.client_id]) {
          sessionsByClient[s.client_id] = [];
        }
        sessionsByClient[s.client_id].push(s);
      });
      
      // For each client, mark the first paid session as first session
      Object.values(sessionsByClient).forEach(clientSessions => {
        // Sort by client booking instant (Wix payload time when available), then scheduled date.
        const sortedSessions = clientSessions.sort((a, b) => {
          const dateA = new Date(getSessionBookingCreatedAtIso(a) || a.scheduled_date || 0);
          const dateB = new Date(getSessionBookingCreatedAtIso(b) || b.scheduled_date || 0);
          return dateA - dateB;
        });
        
        // Mark the first session as first session
        if (sortedSessions.length > 0 && sortedSessions[0].id) {
          clientFirstSessions.add(sortedSessions[0].id);
        }
      });
    }

    // Calculate average prices from actual sessions
    const averagePricesByPsych = {};
    allSessions?.forEach(s => {
      if (!s.psychologist_id) return;
      
      if (!averagePricesByPsych[s.psychologist_id]) {
        averagePricesByPsych[s.psychologist_id] = {
          individual: { total: 0, count: 0 },
          package: { total: 0, count: 0 }
        };
      }

      const isPackage = s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined' && s.package_id !== 'individual' ||
                       s.session_type === 'Package Session' || 
                       (s.session_type && s.session_type.toLowerCase().includes('package'));
      
      const sessionPrice = parseFloat(s.price) || 0;
      if (isPackage) {
        averagePricesByPsych[s.psychologist_id].package.total += sessionPrice;
        averagePricesByPsych[s.psychologist_id].package.count += 1;
      } else {
        averagePricesByPsych[s.psychologist_id].individual.total += sessionPrice;
        averagePricesByPsych[s.psychologist_id].individual.count += 1;
      }
    });

    // Calculate statistics per psychologist
    const statsByPsych = {};
    
    // Process sessions - use commission_history if available, otherwise calculate
    allSessions?.forEach(s => {
      if (!s.psychologist_id) return;
      
      if (!statsByPsych[s.psychologist_id]) {
        statsByPsych[s.psychologist_id] = {
          individual_sessions: 0,
          package_sessions: 0,
          total_sessions: 0,
          pending_sessions: 0,
          completed_sessions: 0,
          total_revenue: 0,
          total_commission_to_company: 0,
          total_to_doctor_wallet: 0,
          pending_payout: 0,
          completed_payout: 0,
          monthly_breakdown: {}
        };
      }

      const isPackage = s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined' && s.package_id !== 'individual' ||
                       s.session_type === 'Package Session' || 
                       (s.session_type && s.session_type.toLowerCase().includes('package'));
      
      // Count all sessions (booked, completed, etc.) for session counts
      if (isPackage) {
        statsByPsych[s.psychologist_id].package_sessions++;
      } else {
        statsByPsych[s.psychologist_id].individual_sessions++;
      }
      statsByPsych[s.psychologist_id].total_sessions++;

      // Calculate revenue and commissions for all sessions
      // For completed sessions: use commission_history if available, otherwise calculate
      // For booked sessions: calculate expected commission based on doctor's commission settings
      let sessionPrice = parseFloat(s.price) || 0; // Use let instead of const to allow modification for packages
      const isCompleted = s.status === 'completed';
      const historyRecord = commissionHistoryMap[s.id];
      const isFirstSession = clientFirstSessions.has(s.id); // Check if this is the first session for the client
      const isInitialPackageSession = !!s.package_id && (parseInt(s.package_session_number, 10) || 0) === 1;
      
      // Calculate commission values (used in both total stats and monthly breakdown)
      let commissionToCompany = 0;
      let toDoctorWallet = 0;
      
      // If commission history exists (completed session with calculated commission), use it
      if (historyRecord) {
        // commission_amount in history = fixed commission amount = what COMPANY gets (e.g., ₹300)
        // company_revenue in history = commission_amount (same value, for backward compatibility)
        // doctor wallet = session_amount - commission_amount = what DOCTOR gets (e.g., ₹700)
        const commissionAmount = toMoneyNumber(historyRecord.commission_amount || 0);
        const sessionAmount = toMoneyNumber(historyRecord.session_amount || sessionPrice);
        commissionToCompany = commissionAmount; // Company gets the commission (fixed amount)
        toDoctorWallet = Math.max(0, sessionAmount - commissionAmount); // Doctor gets the rest
      } else {
        // Booked/Non-completed - calculate from commission settings (pending payout)
        // Use first session vs follow-up logic
        const commissionAmounts = commissionAmountsMap[s.psychologist_id];
        const commissionRecord = commissionRecordsMap[s.psychologist_id] || {};
        
        let doctorCommission = 0;
        let hasExplicitDoctorCommission = false;
        
        if (isPackage && s.package_id) {
          // Package session - commission is calculated per session:
          // first package session uses initial commission, remaining sessions use follow-up.
          const pkg = packagePricesMap[s.psychologist_id]?.find(p => p.id === s.package_id);
          const packageType = pkg?.type || packageTypeMap[s.package_id] || 'package';

          // Get package-specific doctor commissions from JSONB field
          const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
          
          if (isInitialPackageSession) {
            const packageFirstSessionKey = `${packageType}_first_session`;
            if (hasConfiguredMoneyValue(doctorCommissionPackages, packageFirstSessionKey)) {
              doctorCommission = toMoneyNumber(doctorCommissionPackages[packageFirstSessionKey]);
              hasExplicitDoctorCommission = true;
            } else if (hasConfiguredMoneyValue(commissionRecord, 'doctor_commission_first_session_package')) {
              doctorCommission = toMoneyNumber(commissionRecord.doctor_commission_first_session_package);
              hasExplicitDoctorCommission = true;
            }
          } else {
            const packageFollowupKey = `${packageType}_followup`;
            if (hasConfiguredMoneyValue(doctorCommissionPackages, packageFollowupKey)) {
              doctorCommission = toMoneyNumber(doctorCommissionPackages[packageFollowupKey]);
              hasExplicitDoctorCommission = true;
            } else if (hasConfiguredMoneyValue(commissionRecord, 'doctor_commission_followup_package')) {
              doctorCommission = toMoneyNumber(commissionRecord.doctor_commission_followup_package);
              hasExplicitDoctorCommission = true;
            }
          }
          
          // Only use fallback when no doctor-side commission is configured at all.
          if (!hasExplicitDoctorCommission) {
            const commissionAmount = toMoneyNumber(commissionAmounts?.[packageType] || commissionAmounts?.package || 0);
            doctorCommission = Math.max(0, sessionPrice - commissionAmount);
          }
          
          // Per-session package math
          commissionToCompany = Math.max(0, sessionPrice - doctorCommission);
          toDoctorWallet = Math.min(sessionPrice, Math.max(0, doctorCommission));
        } else {
          // Individual/couple session
          const isCoupleSession = String(s.session_type || '').toLowerCase().includes('couple') || String(s.session_type || '').toLowerCase().includes('cpl');
          if (isCoupleSession) {
            const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
            if (hasConfiguredMoneyValue(doctorCommissionPackages, 'couple_session')) {
              doctorCommission = toMoneyNumber(doctorCommissionPackages.couple_session);
              hasExplicitDoctorCommission = true;
            } else if (hasConfiguredMoneyValue(doctorCommissionPackages, 'cpl_session')) {
              doctorCommission = toMoneyNumber(doctorCommissionPackages.cpl_session);
              hasExplicitDoctorCommission = true;
            } else if (hasConfiguredMoneyValue(commissionRecord, 'doctor_commission_individual')) {
              doctorCommission = toMoneyNumber(commissionRecord.doctor_commission_individual);
              hasExplicitDoctorCommission = true;
            }
          } else if (isFirstSession && hasConfiguredMoneyValue(commissionRecord, 'doctor_commission_first_session')) {
            doctorCommission = toMoneyNumber(commissionRecord.doctor_commission_first_session);
            hasExplicitDoctorCommission = true;
          } else if (!isFirstSession && hasConfiguredMoneyValue(commissionRecord, 'doctor_commission_followup')) {
            doctorCommission = toMoneyNumber(commissionRecord.doctor_commission_followup);
            hasExplicitDoctorCommission = true;
          } else {
            // Fallback to individual commission calculation
            const commissionAmount = toMoneyNumber(commissionAmounts?.individual || 0);
            doctorCommission = Math.max(0, sessionPrice - commissionAmount);
          }
          
          // For individual sessions
          commissionToCompany = Math.max(0, sessionPrice - doctorCommission);
          toDoctorWallet = Math.min(sessionPrice, Math.max(0, doctorCommission));
        }
      }

      // Add to total stats (for all sessions - booked sessions show expected amounts, completed show actual)
      statsByPsych[s.psychologist_id].total_revenue += sessionPrice;
      statsByPsych[s.psychologist_id].total_commission_to_company += commissionToCompany;
      statsByPsych[s.psychologist_id].total_to_doctor_wallet += toDoctorWallet;
      if (isCompleted) {
        statsByPsych[s.psychologist_id].completed_sessions += 1;
        statsByPsych[s.psychologist_id].completed_payout += toDoctorWallet;
      } else {
        statsByPsych[s.psychologist_id].pending_sessions += 1;
        statsByPsych[s.psychologist_id].pending_payout += toDoctorWallet;
      }

      // Monthly breakdown buckets: align with doctorDateBasis (booked vs therapy month)
      const bucketYmd =
        doctorDateBasis === 'booked'
          ? getSessionBookingCreatedIstDateString(s)
          : (s.scheduled_date || '').split('T')[0].slice(0, 10);

      if (bucketYmd && bucketYmd.length >= 7) {
        const monthKey = bucketYmd.substring(0, 7); // YYYY-MM
        if (!statsByPsych[s.psychologist_id].monthly_breakdown[monthKey]) {
          statsByPsych[s.psychologist_id].monthly_breakdown[monthKey] = {
            month: monthKey,
            individual_sessions: 0,
            package_sessions: 0,
            total_revenue: 0,
            commission_to_company: 0,
            to_doctor_wallet: 0
          };
        }
        
        // Count all sessions in monthly breakdown
        if (isPackage) {
          statsByPsych[s.psychologist_id].monthly_breakdown[monthKey].package_sessions++;
        } else {
          statsByPsych[s.psychologist_id].monthly_breakdown[monthKey].individual_sessions++;
        }
        
        // Add revenue and commission for all sessions (commission values already calculated above)
        statsByPsych[s.psychologist_id].monthly_breakdown[monthKey].total_revenue += sessionPrice;
        statsByPsych[s.psychologist_id].monthly_breakdown[monthKey].commission_to_company += commissionToCompany;
        statsByPsych[s.psychologist_id].monthly_breakdown[monthKey].to_doctor_wallet += toDoctorWallet;
      }
    });

    // Build final response with all doctors
    const commissionsWithTotals = psychologists?.map(psych => {
      const commission = commissionsMap[psych.id];
      const stats = statsByPsych[psych.id] || {
        individual_sessions: 0,
        package_sessions: 0,
        total_sessions: 0,
        pending_sessions: 0,
        completed_sessions: 0,
        total_revenue: 0,
        total_commission_to_company: 0,
        total_to_doctor_wallet: 0,
        pending_payout: 0,
        completed_payout: 0,
        monthly_breakdown: {}
      };

      const avgPrices = averagePricesByPsych[psych.id] || {
        individual: { total: 0, count: 0 },
        package: { total: 0, count: 0 }
      };

      const individualAvgPrice = avgPrices.individual.count > 0 
        ? avgPrices.individual.total / avgPrices.individual.count 
        : 0;
      const packageAvgPrice = avgPrices.package.count > 0 
        ? avgPrices.package.total / avgPrices.package.count 
        : 0;

      // Get commission amounts (from JSONB or legacy columns)
      const commissionAmounts = commissionAmountsMap[psych.id] || {};
      
      // Get packages for this doctor
      const packages = packagePricesMap[psych.id] || [];
      const individualSessionPrice =
        parseFloat(psych.individual_session_price ?? individualPriceMap[psych.id] ?? 0) || 0;
      
      // Build commission amounts for each package type
      const packageCommissions = packages.map(pkg => ({
        ...pkg,
        commission_amount: parseFloat(commissionAmounts[pkg.type] || commissionAmounts.package || 0)
      }));

      // Get doctor commission amounts from commission record
      const commissionRecord = commissionRecordsMap[psych.id] || {};
      const companyIndividualCommission = parseFloat(commissionAmounts.individual || 0) || 0;
      const effectiveDoctorFirstIndividual =
        (commissionRecord.doctor_commission_first_session !== null && commissionRecord.doctor_commission_first_session !== undefined)
          ? parseFloat(commissionRecord.doctor_commission_first_session) || 0
          : Math.max(0, individualSessionPrice - companyIndividualCommission);
      const effectiveDoctorFollowupIndividual =
        (commissionRecord.doctor_commission_followup !== null && commissionRecord.doctor_commission_followup !== undefined)
          ? parseFloat(commissionRecord.doctor_commission_followup) || 0
          : effectiveDoctorFirstIndividual;

      const doctorCommissionPackages = commissionRecord.doctor_commission_packages || {};
      const effectivePackageCommissions = packageCommissions.map((pkg) => {
        const packageType = pkg.type || 'package';
        const firstKey = `${packageType}_first_session`;
        const followupKey = `${packageType}_followup`;
        const pkgPrice = parseFloat(pkg.price || 0) || 0;
        const companyPkgCommission = parseFloat(pkg.commission_amount || 0) || 0;
        const defaultDoctorForPkg = Math.max(0, pkgPrice - companyPkgCommission);

        const doctorFirst =
          (doctorCommissionPackages[firstKey] !== null && doctorCommissionPackages[firstKey] !== undefined)
            ? parseFloat(doctorCommissionPackages[firstKey]) || 0
            : (
              (commissionRecord.doctor_commission_first_session_package !== null && commissionRecord.doctor_commission_first_session_package !== undefined)
                ? parseFloat(commissionRecord.doctor_commission_first_session_package) || 0
                : defaultDoctorForPkg
            );
        const doctorFollow =
          (doctorCommissionPackages[followupKey] !== null && doctorCommissionPackages[followupKey] !== undefined)
            ? parseFloat(doctorCommissionPackages[followupKey]) || 0
            : (
              (commissionRecord.doctor_commission_followup_package !== null && commissionRecord.doctor_commission_followup_package !== undefined)
                ? parseFloat(commissionRecord.doctor_commission_followup_package) || 0
                : doctorFirst
            );

        return {
          ...pkg,
          doctor_commission_first_session: doctorFirst,
          doctor_commission_followup: doctorFollow
        };
      });

      const wixCount = wixCountsByPsychId[psych.id]?.bookingsCount || 0;
      const displayTotalSessions = wixCount > 0 ? wixCount : stats.total_sessions;

      return {
        psychologist_id: psych.id,
        commission_amounts: commissionAmounts, // Full JSONB object
        commission_amount_individual: commissionAmounts.individual || 0, // For backward compatibility
        commission_amount_package: commissionAmounts.package || 0, // For backward compatibility
        doctor_commission_first_session: effectiveDoctorFirstIndividual,
        doctor_commission_followup: effectiveDoctorFollowupIndividual,
        doctor_commission_couple:
          (doctorCommissionPackages.couple_session !== null && doctorCommissionPackages.couple_session !== undefined)
            ? parseFloat(doctorCommissionPackages.couple_session) || 0
            : (
              (doctorCommissionPackages.cpl_session !== null && doctorCommissionPackages.cpl_session !== undefined)
                ? parseFloat(doctorCommissionPackages.cpl_session) || 0
                : null
            ),
        doctor_commission_individual: commissionRecord.doctor_commission_individual || null,
        doctor_commission_first_session_package:
          (commissionRecord.doctor_commission_first_session_package !== null && commissionRecord.doctor_commission_first_session_package !== undefined)
            ? parseFloat(commissionRecord.doctor_commission_first_session_package) || 0
            : null,
        doctor_commission_followup_package:
          (commissionRecord.doctor_commission_followup_package !== null && commissionRecord.doctor_commission_followup_package !== undefined)
            ? parseFloat(commissionRecord.doctor_commission_followup_package) || 0
            : null,
        doctor_commission_packages: doctorCommissionPackages, // Package-specific doctor commissions
        package_commissions: effectivePackageCommissions, // Packages with company + doctor commission amounts
        individual_sessions: stats.individual_sessions,
        package_sessions: stats.package_sessions,
        total_sessions: displayTotalSessions,
        total_sessions_finance: stats.total_sessions,
        pending_sessions: stats.pending_sessions,
        completed_sessions: stats.completed_sessions,
        wix_bookings_count: wixCount,
        latest_wix_booking_at: wixCountsByPsychId[psych.id]?.latestBookingAt || null,
        total_revenue: stats.total_revenue,
        total_commission_to_company: stats.total_commission_to_company,
        total_to_doctor_wallet: stats.total_to_doctor_wallet,
        pending_payout: stats.pending_payout,
        completed_payout: stats.completed_payout,
        monthly_breakdown: Object.values(stats.monthly_breakdown).sort((a, b) => 
          b.month.localeCompare(a.month)
        ),
        // Pricing information
        individual_session_price: individualSessionPrice,
        package_prices: packages,
        average_individual_price: individualAvgPrice,
        average_package_price: packageAvgPrice,
        psychologist: {
          id: psych.id,
          first_name: psych.first_name,
          last_name: psych.last_name,
          email: psych.email,
          experience_years: psych.experience_years,
          cover_image_url: psych.cover_image_url
        }
      };
    }) || [];

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_COMMISSIONS_VIEWED',
      resource: 'commissions',
      endpoint: '/api/finance/commissions',
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({
      commissions: commissionsWithTotals || [],
      filters: {
        dateBasis: doctorDateBasis,
        ...(dateFrom && dateTo ? { dateFrom, dateTo } : {}),
      },
    }, 'Commissions fetched successfully'));

  } catch (error) {
    console.error('Get commissions error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching commissions')
    );
  }
};

/**
 * Update Commission Rate (Fixed Amounts)
 * PUT /api/finance/commissions/:psychologistId
 */
const updateCommissionRate = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    const { psychologistId } = req.params;
    const { 
      commission_amounts, // New: JSONB object with package types as keys
      commission_amount_individual, // Legacy support
      commission_amount_package, // Legacy support
      doctor_commission_first_session, // Doctor commission for first session (individual)
      doctor_commission_followup, // Doctor commission for follow-up session (individual)
      doctor_commission_individual, // Doctor commission for individual session (base)
      doctor_commission_first_session_package, // Doctor commission for first session (package) - legacy
      doctor_commission_followup_package, // Doctor commission for follow-up session (package) - legacy
      doctor_commission_packages, // Package-specific doctor commissions JSONB: { "package_3_first_session": 100, "package_3_followup": 150, ... }
      effective_from, 
      notes 
    } = req.body;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    // Build commission amounts object
    let commissionAmountsObj = {};
    
    if (commission_amounts && typeof commission_amounts === 'object') {
      // New format: JSONB object
      for (const [packageType, amount] of Object.entries(commission_amounts)) {
        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount < 0) {
          return res.status(400).json(
            errorResponse(`Invalid commission amount for ${packageType}: must be ≥ 0`)
          );
        }
        commissionAmountsObj[packageType] = parsedAmount;
      }
    } else {
      // Legacy format: individual and package
      const individualAmount = commission_amount_individual ? parseFloat(commission_amount_individual) : null;
      const packageAmount = commission_amount_package ? parseFloat(commission_amount_package) : null;

      if (individualAmount !== null && (isNaN(individualAmount) || individualAmount < 0)) {
        return res.status(400).json(
          errorResponse('Valid commission amount for individual sessions (≥ 0) is required')
        );
      }

      if (packageAmount !== null && (isNaN(packageAmount) || packageAmount < 0)) {
        return res.status(400).json(
          errorResponse('Valid commission amount for package sessions (≥ 0) is required')
        );
      }

      if (individualAmount === null && packageAmount === null) {
        return res.status(400).json(
          errorResponse('At least one commission amount must be provided')
        );
      }

      if (individualAmount !== null) {
        commissionAmountsObj.individual = individualAmount;
      }
      if (packageAmount !== null) {
        commissionAmountsObj.package = packageAmount;
      }
    }

    const hasDoctorCommissionInput =
      (doctor_commission_first_session !== undefined && doctor_commission_first_session !== null && doctor_commission_first_session !== '') ||
      (doctor_commission_followup !== undefined && doctor_commission_followup !== null && doctor_commission_followup !== '') ||
      (doctor_commission_individual !== undefined && doctor_commission_individual !== null && doctor_commission_individual !== '') ||
      (doctor_commission_first_session_package !== undefined && doctor_commission_first_session_package !== null && doctor_commission_first_session_package !== '') ||
      (doctor_commission_followup_package !== undefined && doctor_commission_followup_package !== null && doctor_commission_followup_package !== '') ||
      (doctor_commission_packages && typeof doctor_commission_packages === 'object' && Object.keys(doctor_commission_packages).length > 0);

    if (Object.keys(commissionAmountsObj).length === 0 && !hasDoctorCommissionInput) {
      return res.status(400).json(
        errorResponse('At least one commission value must be provided')
      );
    }

    // Deactivate old commission record
    await supabaseAdmin
      .from('doctor_commissions')
      .update({ is_active: false, effective_to: new Date().toISOString().split('T')[0] })
      .eq('psychologist_id', psychologistId)
      .eq('is_active', true);

    // Create new commission record with fixed amounts
    const effectiveDate = effective_from || new Date().toISOString().split('T')[0];

    // Check if a record already exists with this psychologist_id and effective_from.
    // Fallback for older schemas where effective_from may be missing.
    let existingRecord = null;
    {
      const { data, error: existingErr } = await supabaseAdmin
        .from('doctor_commissions')
        .select('id')
        .eq('psychologist_id', psychologistId)
        .eq('effective_from', effectiveDate)
        .maybeSingle();

      if (existingErr && String(existingErr.message || '').includes('effective_from')) {
        const { data: fallbackRows } = await supabaseAdmin
          .from('doctor_commissions')
          .select('id')
          .eq('psychologist_id', psychologistId)
          .limit(1);
        existingRecord = fallbackRows?.[0] || null;
      } else {
        existingRecord = data || null;
      }
    }

    const commissionData = {
      psychologist_id: psychologistId,
      effective_from: effectiveDate,
      is_active: true,
      notes,
      updated_at: new Date().toISOString(),
      commission_percentage: 0 // Keep for backward compatibility
    };
    // Store JSONB commissions when supported; legacy schemas will fall back automatically.
    commissionData.commission_amounts = commissionAmountsObj;

    // Also set legacy columns for backward compatibility
    if (commissionAmountsObj.individual !== undefined) {
      commissionData.commission_amount_individual = commissionAmountsObj.individual;
    }
    if (commissionAmountsObj.package !== undefined) {
      commissionData.commission_amount_package = commissionAmountsObj.package;
    }

    // Set doctor commission amounts (what doctor gets)
    if (doctor_commission_first_session !== undefined && doctor_commission_first_session !== null && doctor_commission_first_session !== '') {
      const amount = parseFloat(doctor_commission_first_session);
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json(
          errorResponse('Invalid doctor commission amount for first session: must be ≥ 0')
        );
      }
      commissionData.doctor_commission_first_session = amount;
    }
    if (doctor_commission_followup !== undefined && doctor_commission_followup !== null && doctor_commission_followup !== '') {
      const amount = parseFloat(doctor_commission_followup);
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json(
          errorResponse('Invalid doctor commission amount for follow-up session: must be ≥ 0')
        );
      }
      commissionData.doctor_commission_followup = amount;
    }
    if (doctor_commission_individual !== undefined && doctor_commission_individual !== null && doctor_commission_individual !== '') {
      const amount = parseFloat(doctor_commission_individual);
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json(
          errorResponse('Invalid doctor commission amount for individual session: must be ≥ 0')
        );
      }
      commissionData.doctor_commission_individual = amount;
    }
    if (doctor_commission_first_session_package !== undefined && doctor_commission_first_session_package !== null && doctor_commission_first_session_package !== '') {
      const amount = parseFloat(doctor_commission_first_session_package);
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json(
          errorResponse('Invalid doctor commission amount for first session (package): must be ≥ 0')
        );
      }
      commissionData.doctor_commission_first_session_package = amount;
    }
    if (doctor_commission_followup_package !== undefined && doctor_commission_followup_package !== null && doctor_commission_followup_package !== '') {
      const amount = parseFloat(doctor_commission_followup_package);
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json(
          errorResponse('Invalid doctor commission amount for follow-up session (package): must be ≥ 0')
        );
      }
      commissionData.doctor_commission_followup_package = amount;
    }
    
    // Handle package-specific doctor commissions (JSONB object)
    if (doctor_commission_packages && typeof doctor_commission_packages === 'object') {
      // Validate all values are valid numbers ≥ 0
      for (const [key, value] of Object.entries(doctor_commission_packages)) {
        const amount = parseFloat(value);
        if (isNaN(amount) || amount < 0) {
          return res.status(400).json(
            errorResponse(`Invalid doctor commission amount for ${key}: must be ≥ 0`)
          );
        }
        doctor_commission_packages[key] = amount; // Ensure it's a number
      }
      commissionData.doctor_commission_packages = doctor_commission_packages;
    }

    let newCommission;
    let error;

    if (existingRecord && existingRecord.id) {
      // Update existing record - only update changed fields
      const { data: existingCommissionData } = await supabaseAdmin
        .from('doctor_commissions')
        .select('*')
        .eq('id', existingRecord.id)
        .single();

      // Build update data with only changed fields
      const updateData = {
        updated_at: new Date().toISOString()
      };

      // Only update fields that have actually changed
      if (commissionData.commission_amounts && JSON.stringify(commissionData.commission_amounts) !== JSON.stringify(existingCommissionData?.commission_amounts)) {
        updateData.commission_amounts = commissionData.commission_amounts;
      }
      if (commissionData.commission_amount_individual !== undefined && commissionData.commission_amount_individual !== existingCommissionData?.commission_amount_individual) {
        updateData.commission_amount_individual = commissionData.commission_amount_individual;
      }
      if (commissionData.commission_amount_package !== undefined && commissionData.commission_amount_package !== existingCommissionData?.commission_amount_package) {
        updateData.commission_amount_package = commissionData.commission_amount_package;
      }
      if (commissionData.doctor_commission_first_session !== undefined && commissionData.doctor_commission_first_session !== existingCommissionData?.doctor_commission_first_session) {
        updateData.doctor_commission_first_session = commissionData.doctor_commission_first_session;
      }
      if (commissionData.doctor_commission_followup !== undefined && commissionData.doctor_commission_followup !== existingCommissionData?.doctor_commission_followup) {
        updateData.doctor_commission_followup = commissionData.doctor_commission_followup;
      }
      if (commissionData.doctor_commission_individual !== undefined && commissionData.doctor_commission_individual !== existingCommissionData?.doctor_commission_individual) {
        updateData.doctor_commission_individual = commissionData.doctor_commission_individual;
      }
      if (commissionData.doctor_commission_first_session_package !== undefined && commissionData.doctor_commission_first_session_package !== existingCommissionData?.doctor_commission_first_session_package) {
        updateData.doctor_commission_first_session_package = commissionData.doctor_commission_first_session_package;
      }
      if (commissionData.doctor_commission_followup_package !== undefined && commissionData.doctor_commission_followup_package !== existingCommissionData?.doctor_commission_followup_package) {
        updateData.doctor_commission_followup_package = commissionData.doctor_commission_followup_package;
      }
      if (commissionData.doctor_commission_packages && JSON.stringify(commissionData.doctor_commission_packages) !== JSON.stringify(existingCommissionData?.doctor_commission_packages)) {
        updateData.doctor_commission_packages = commissionData.doctor_commission_packages;
      }
      if (commissionData.notes !== undefined && commissionData.notes !== existingCommissionData?.notes) {
        updateData.notes = commissionData.notes;
      }
      if (commissionData.effective_from && commissionData.effective_from !== existingCommissionData?.effective_from) {
        updateData.effective_from = commissionData.effective_from;
      }

      // Only perform update if there are actual changes (besides updated_at)
      if (Object.keys(updateData).length > 1) {
        let result = await supabaseAdmin
          .from('doctor_commissions')
          .update(updateData)
          .eq('id', existingRecord.id)
          .select()
          .single();

        // Legacy schema fallback: if JSONB column is missing, retry without it.
        if (result.error && String(result.error.message || '').includes('commission_amounts')) {
          const retryData = { ...updateData };
          delete retryData.commission_amounts;
          result = await supabaseAdmin
            .from('doctor_commissions')
            .update(retryData)
            .eq('id', existingRecord.id)
            .select()
            .single();
        }
        
        newCommission = result.data;
        error = result.error;
      } else {
        // No changes, return existing record
        const { data } = await supabaseAdmin
          .from('doctor_commissions')
          .select('*')
          .eq('id', existingRecord.id)
          .single();
        newCommission = data;
        error = null;
      }
    } else {
      // Create new record
      commissionData.created_by = userId;
      commissionData.created_at = new Date().toISOString();
      
      let result = await supabaseAdmin
        .from('doctor_commissions')
        .insert([commissionData])
        .select()
        .single();

      // Legacy schema fallback: if JSONB column is missing, retry without it.
      if (result.error && String(result.error.message || '').includes('commission_amounts')) {
        const retryData = { ...commissionData };
        delete retryData.commission_amounts;
        result = await supabaseAdmin
          .from('doctor_commissions')
          .insert([retryData])
          .select()
          .single();
      }
      
      newCommission = result.data;
      error = result.error;
    }

    if (error) throw error;

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_COMMISSION_UPDATED',
      resource: 'commissions',
      resourceId: psychologistId,
      endpoint: `/api/finance/commissions/${psychologistId}`,
      method: 'PUT',
      details: { 
        commission_amounts: commissionAmountsObj
      },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(
      successResponse(newCommission, 'Commission amounts updated successfully')
    );

  } catch (error) {
    console.error('Update commission error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating commission')
    );
  }
};

// ============================================
// PAYOUTS MANAGEMENT
// ============================================

/**
 * Get Pending Payouts
 * GET /api/finance/payouts/pending
 * Returns doctors with completed sessions only, grouped by month
 */
const getPendingPayouts = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { month, year } = req.query;
    
    // Default to current month if not specified
    const today = new Date();
    const targetMonth = month ? parseInt(month) : today.getMonth() + 1;
    const targetYear = year ? parseInt(year) : today.getFullYear();
    
    const monthStr = targetMonth < 10 ? `0${targetMonth}` : String(targetMonth);
    const monthStart = `${targetYear}-${monthStr}-01`;
    const monthEnd = new Date(targetYear, targetMonth, 0).toISOString().split('T')[0]; // Last day of month

    // Get completed sessions by completion timestamp (updated_at) for payout month.
    // This keeps pending payout aligned with "session marked complete" behavior.
    const rangeStartTs = `${monthStart}${IST_DAY_START_SUFFIX}`;
    const rangeEndTs = `${monthEnd}${IST_DAY_END_SUFFIX}`;

    let completedSessions = null;
    let sessionsError = null;

    ({ data: completedSessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select(`
        id,
        psychologist_id,
        client_id,
        session_type,
        package_id,
        package_session_number,
        scheduled_date,
        created_at,
        updated_at,
        status,
        payment_id,
        price,
        psychologist:psychologists(id, first_name, last_name, email, phone, cover_image_url)
      `)
      .eq('status', 'completed')
      .gte('updated_at', rangeStartTs)
      .lte('updated_at', rangeEndTs)
      .not('psychologist_id', 'is', null)
      .neq('session_type', 'free_assessment'));

    if (sessionsError && String(sessionsError.message || '').includes('cover_image_url')) {
      ({ data: completedSessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(`
          id,
          psychologist_id,
          client_id,
          session_type,
          package_id,
          package_session_number,
          scheduled_date,
          created_at,
          updated_at,
          status,
          payment_id,
          price,
          psychologist:psychologists(id, first_name, last_name, email, phone)
        `)
        .eq('status', 'completed')
        .gte('updated_at', rangeStartTs)
        .lte('updated_at', rangeEndTs)
        .not('psychologist_id', 'is', null)
        .neq('session_type', 'free_assessment'));
    }

    // Older schemas may miss updated_at filtering guarantees; fallback to scheduled_date month filter.
    if (sessionsError && String(sessionsError.message || '').includes('updated_at')) {
      ({ data: completedSessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(`
          id,
          psychologist_id,
          client_id,
          session_type,
          package_id,
          package_session_number,
          scheduled_date,
          created_at,
          status,
          payment_id,
          price,
          psychologist:psychologists(id, first_name, last_name, email, phone)
        `)
        .eq('status', 'completed')
        .gte('scheduled_date', monthStart)
        .lte('scheduled_date', monthEnd)
        .not('psychologist_id', 'is', null)
        .neq('session_type', 'free_assessment'));
    }

    if (sessionsError) throw sessionsError;

    // Payout eligibility is based on completion status, not payment row availability.
    const completedSessionsWithPayments = completedSessions || [];

    if (sessionsError) throw sessionsError;
    
    // Get commission_history for these completed sessions
    const sessionIds = completedSessionsWithPayments.map(s => s.id);
    let commissionHistory = null;
    let commissionError = null;
    ({ data: commissionHistory, error: commissionError } = await supabaseAdmin
      .from('commission_history')
      .select(`
        session_id,
        psychologist_id,
        session_amount,
        commission_amount,
        session_type,
        payment_status,
        payout_id
      `)
      .in('session_id', sessionIds));

    if (commissionError && String(commissionError.message || '').includes('session_amount')) {
      ({ data: commissionHistory, error: commissionError } = await supabaseAdmin
        .from('commission_history')
        .select(`
          session_id,
          psychologist_id,
          commission_amount,
          session_type,
          payment_status,
          payout_id
        `)
        .in('session_id', sessionIds));
    }

    if (commissionError) {
      console.error('Error fetching commission history:', commissionError);
    }

    // Check if there are any payouts for any psychologists in this month
    // If a payout exists for a psychologist, all sessions for that psychologist in that month should be excluded
    const psychologistIds = [...new Set(completedSessionsWithPayments.map(s => s.psychologist_id).filter(Boolean))];
    
    let paidPsychologistIds = new Set();
    if (psychologistIds.length > 0) {
      // Check for payouts that match the psychologist and month
      // We check if payout notes contain the month/year or if payout_date is in the month range
      const { data: existingPayouts, error: payoutCheckError } = await supabaseAdmin
        .from('payouts')
        .select('id, psychologist_id, payout_date, notes')
        .in('psychologist_id', psychologistIds)
        .eq('status', 'paid');

      // Get all psychologist IDs that have paid payouts for this month
      // Match by checking if notes contain the month/year or if payout_date falls within the month
      if (!payoutCheckError && existingPayouts) {
        const monthYearStr = new Date(targetYear, targetMonth - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        existingPayouts.forEach(payout => {
          // Check if payout notes mention this month/year, or if payout_date is in the month range
          const payoutDate = new Date(payout.payout_date);
          const payoutMonth = payoutDate.getMonth() + 1;
          const payoutYear = payoutDate.getFullYear();
          
          if ((payout.notes && payout.notes.includes(monthYearStr)) || 
              (payoutMonth === targetMonth && payoutYear === targetYear)) {
            paidPsychologistIds.add(payout.psychologist_id);
          }
        });
      }
    }

    // Filter out sessions that have already been paid (have payout_id or payment_status = 'paid')
    const paidSessionIds = new Set(
      (commissionHistory || [])
        .filter(ch => ch.payment_status === 'paid' || ch.payout_id)
        .map(ch => ch.session_id)
    );

    // Exclude already paid sessions from the list
    // Also exclude all sessions for psychologists who have a paid payout for this month
    const unpaidSessions = completedSessionsWithPayments.filter(s => 
      !paidSessionIds.has(s.id) && !paidPsychologistIds.has(s.psychologist_id)
    );
    
    console.log(`📊 Found ${unpaidSessions.length} unpaid completed sessions (${completedSessionsWithPayments.length} total) for ${targetMonth}/${targetYear}`);

    if (!unpaidSessions || unpaidSessions.length === 0) {
      await auditLogger.logAction({
        userId: req.user.id,
        userEmail: req.user.email,
        userRole,
        action: 'FINANCE_PENDING_PAYOUTS_VIEWED',
        resource: 'payouts',
        endpoint: '/api/finance/payouts/pending',
        method: 'GET',
        ip: req.ip,
        userAgent: req.headers['user-agent']
      }).catch(err => console.error('Audit log error:', err));

      return res.json(successResponse({
        payouts: [],
        month: targetMonth,
        year: targetYear
      }, 'No completed sessions found for the selected month'));
    }

    // Get package types for package sessions
    const packageIds = [...new Set(unpaidSessions.map(s => s.package_id).filter(Boolean))];
    let packagesMap = {};
    if (packageIds.length > 0) {
      const { data: packages } = await supabaseAdmin
        .from('packages')
        .select('id, package_type, session_count')
        .in('id', packageIds);
      
      if (packages) {
        packages.forEach(pkg => {
          packagesMap[pkg.id] = pkg;
        });
      }
    }

    // Build commission map by session_id (only for unpaid sessions)
    const commissionMap = {};
    commissionHistory?.forEach(ch => {
      if (!paidSessionIds.has(ch.session_id)) { // Only include unpaid sessions
        commissionMap[ch.session_id] = ch;
      }
    });

    // Get session prices for sessions without commission history
    // Price is already included in unpaidSessions, so use it directly
    const sessionPriceMap = {};
    unpaidSessions.forEach(s => {
      if (!commissionMap[s.id] && s.price !== undefined) {
        sessionPriceMap[s.id] = parseFloat(s.price || 0);
      }
    });

    // Commission fallback config per doctor (when commission_history row is missing).
    const pendingPsychIds = [...new Set(unpaidSessions.map(s => s.psychologist_id).filter(Boolean))];
    const commissionConfigMap = {};
    if (pendingPsychIds.length > 0) {
      let commissionCfgRows = [];
      let commissionCfgError = null;
      ({ data: commissionCfgRows, error: commissionCfgError } = await supabaseAdmin
        .from('doctor_commissions')
        .select('psychologist_id, commission_amount_individual, commission_amount_package, commission_amounts, doctor_commission_first_session, doctor_commission_followup, doctor_commission_first_session_package, doctor_commission_followup_package')
        .eq('is_active', true)
        .in('psychologist_id', pendingPsychIds)
        .order('effective_from', { ascending: false }));

      if (commissionCfgError && String(commissionCfgError.message || '').includes('is_active')) {
        ({ data: commissionCfgRows, error: commissionCfgError } = await supabaseAdmin
          .from('doctor_commissions')
          .select('psychologist_id, commission_amount_individual, commission_amount_package, commission_amounts, doctor_commission_first_session, doctor_commission_followup, doctor_commission_first_session_package, doctor_commission_followup_package')
          .in('psychologist_id', pendingPsychIds));
      } else if (commissionCfgError && String(commissionCfgError.message || '').includes('effective_from')) {
        ({ data: commissionCfgRows, error: commissionCfgError } = await supabaseAdmin
          .from('doctor_commissions')
          .select('psychologist_id, commission_amount_individual, commission_amount_package, commission_amounts, doctor_commission_first_session, doctor_commission_followup, doctor_commission_first_session_package, doctor_commission_followup_package')
          .eq('is_active', true)
          .in('psychologist_id', pendingPsychIds));
      }

      (commissionCfgRows || []).forEach((row) => {
        if (row?.psychologist_id && !commissionConfigMap[row.psychologist_id]) {
          commissionConfigMap[row.psychologist_id] = row;
        }
      });
    }

    // Group by psychologist
    const payoutsByDoctor = {};
    
    // Use for...of loop instead of forEach to support await
    for (const session of unpaidSessions) {
      const psychId = session.psychologist_id;
      let commission = commissionMap[session.id];
      
      // Fallback (legacy rows without commission_history)
      if (!commission && sessionPriceMap[session.id] !== undefined) {
        const sessionAmount = sessionPriceMap[session.id];
        const cfg = commissionConfigMap[psychId] || {};
        const isPackage = !!session.package_id;
        const isInitialPackageSession = isPackage && ((parseInt(session.package_session_number, 10) || 0) === 1);

        // If exact first/follow-up cannot be determined for individual fallback, prefer first-session commission.
        let doctorCommission = 0;
        if (isPackage) {
          doctorCommission = isInitialPackageSession
            ? (parseFloat(cfg.doctor_commission_first_session_package || 0) || 0)
            : (parseFloat(cfg.doctor_commission_followup_package || 0) || 0);
        } else {
          doctorCommission = parseFloat(cfg.doctor_commission_first_session || cfg.doctor_commission_followup || 0) || 0;
        }

        if (!doctorCommission || doctorCommission <= 0) {
          const amountConfig = cfg.commission_amounts && typeof cfg.commission_amounts === 'object' ? cfg.commission_amounts : null;
          const companyCommissionFallback = isPackage
            ? parseFloat(amountConfig?.package ?? cfg.commission_amount_package ?? 0) || 0
            : parseFloat(amountConfig?.individual ?? cfg.commission_amount_individual ?? 0) || 0;
          doctorCommission = Math.max(0, sessionAmount - companyCommissionFallback);
        }

        const commissionAmount = Math.max(0, sessionAmount - doctorCommission);

        commission = {
          session_id: session.id,
          psychologist_id: psychId,
          session_amount: sessionAmount,
          commission_amount: commissionAmount,
          session_type: session.session_type || 'individual',
          payment_status: 'pending'
        };
      }
      
      // Skip if still no commission data
      if (!commission) {
        console.warn(`No commission data for session ${session.id}, skipping`);
        continue;
      }

      if (!payoutsByDoctor[psychId]) {
        payoutsByDoctor[psychId] = {
          psychologist_id: psychId,
          psychologist: session.psychologist,
          total_sessions: 0,
          session_counts_by_type: {},
          total_doctor_wallet: 0,
          total_company_commission: 0,
          sessions: []
        };
      }

      // Determine session type for counting
      let sessionTypeForCount = 'individual';
      if (session.package_id) {
        const pkg = packagesMap[session.package_id];
        if (pkg) {
          sessionTypeForCount = pkg.package_type || `package_${pkg.session_count || 'unknown'}`;
        } else {
          sessionTypeForCount = 'package_unknown';
        }
      }

      // Update counts
      payoutsByDoctor[psychId].total_sessions += 1;
      if (!payoutsByDoctor[psychId].session_counts_by_type[sessionTypeForCount]) {
        payoutsByDoctor[psychId].session_counts_by_type[sessionTypeForCount] = 0;
      }
      payoutsByDoctor[psychId].session_counts_by_type[sessionTypeForCount] += 1;

      // Calculate wallet and commission
      const sessionAmount = parseFloat(commission.session_amount || session.price || 0);
      const commissionAmount = parseFloat(commission.commission_amount || 0);
      const doctorWallet = sessionAmount - commissionAmount;

      payoutsByDoctor[psychId].total_doctor_wallet += doctorWallet;
      payoutsByDoctor[psychId].total_company_commission += commissionAmount;

      // Store session details
      payoutsByDoctor[psychId].sessions.push({
        session_id: session.id,
        session_date: session.scheduled_date,
        session_type: sessionTypeForCount,
        session_amount: sessionAmount,
        doctor_wallet: doctorWallet,
        company_commission: commissionAmount
      });
    }

    // Convert to array and format for frontend
    const payouts = Object.values(payoutsByDoctor).map(payout => ({
      id: payout.psychologist_id, // Using psychologist_id as ID for pending payouts
      psychologist_id: payout.psychologist_id,
      psychologist: payout.psychologist,
      total_sessions: payout.total_sessions,
      session_counts_by_type: payout.session_counts_by_type,
      total_doctor_wallet: Math.round(payout.total_doctor_wallet * 100) / 100,
      pending_payout_amount: Math.round(payout.total_doctor_wallet * 100) / 100,
      total_company_commission: Math.round(payout.total_company_commission * 100) / 100,
      // For backward compatibility with frontend
      total_commission: payout.total_company_commission,
      net_payout: payout.total_doctor_wallet,
      session_details: payout.sessions
    }));
    
    console.log(`✅ Processed ${payouts.length} doctors with completed paid sessions`);

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_PENDING_PAYOUTS_VIEWED',
      resource: 'payouts',
      endpoint: '/api/finance/payouts/pending',
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({
      payouts,
      month: targetMonth,
      year: targetYear,
      month_name: new Date(targetYear, targetMonth - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    }, 'Pending payouts fetched successfully'));

  } catch (error) {
    console.error('Get pending payouts error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching pending payouts')
    );
  }
};

/**
 * Process Payout
 * POST /api/finance/payouts
 */
const processPayout = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const {
      psychologist_id,
      payout_date,
      total_commission,
      tds_percentage = 0,
      payment_method,
      bank_account_number,
      ifsc_code,
      upi_id,
      cheque_number,
      transaction_id,
      reference_number,
      notes
    } = req.body;

    if (!psychologist_id || !payout_date || !total_commission || !payment_method) {
      return res.status(400).json(
        errorResponse('Psychologist ID, payout date, commission amount, and payment method are required')
      );
    }

    // Calculate TDS and net payout
    const tds_amount = (parseFloat(total_commission) * parseFloat(tds_percentage)) / 100;
    const net_payout = parseFloat(total_commission) - tds_amount;

    // Create payout record
    const { data: payout, error } = await supabaseAdmin
      .from('payouts')
      .insert([{
        psychologist_id,
        payout_date,
        total_commission: parseFloat(total_commission),
        tds_amount,
        tds_percentage: parseFloat(tds_percentage),
        net_payout,
        payment_method,
        bank_account_number,
        ifsc_code,
        upi_id,
        cheque_number,
        transaction_id,
        reference_number,
        status: 'paid',
        processed_by: userId,
        processed_at: new Date().toISOString(),
        notes,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    // Update commission history to mark as paid
    await supabaseAdmin
      .from('commission_history')
      .update({
        payment_status: 'paid',
        payout_id: payout.id,
        updated_at: new Date().toISOString()
      })
      .eq('psychologist_id', psychologist_id)
      .eq('payment_status', 'pending');

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_PAYOUT_PROCESSED',
      resource: 'payouts',
      resourceId: payout.id,
      endpoint: '/api/finance/payouts',
      method: 'POST',
      details: { psychologist_id, amount: net_payout },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.status(201).json(
      successResponse(payout, 'Payout processed successfully')
    );

  } catch (error) {
    console.error('Process payout error:', error);
    res.status(500).json(
      errorResponse('Internal server error while processing payout')
    );
  }
};

/**
 * Mark Payout as Paid (Simple)
 * POST /api/finance/payouts/mark-paid
 * Marks pending payouts for a psychologist as paid for a specific month/year
 */
const markPayoutAsPaid = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { psychologist_id, month, year, dateFrom, dateTo } = req.body;

    if (!psychologist_id) {
      return res.status(400).json(
        errorResponse('Psychologist ID is required')
      );
    }

    // Support both month/year and date range formats
    let monthStart, monthEnd;
    if (dateFrom && dateTo) {
      monthStart = dateFrom;
      monthEnd = dateTo;
    } else if (month && year) {
      const monthStr = month < 10 ? `0${month}` : String(month);
      monthStart = `${year}-${monthStr}-01`;
      monthEnd = new Date(year, month, 0).toISOString().split('T')[0];
    } else {
      return res.status(400).json(
        errorResponse('Either month/year or dateFrom/dateTo are required')
      );
    }

    // Get pending payout data for this psychologist and date range.
    // Use updated_at (completion date) for filtering completed sessions.
    let completedSessions = null;
    let sessionsError = null;

    ({ data: completedSessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select(`
        id,
        psychologist_id,
        scheduled_date,
        updated_at,
        status,
        payment_id,
        price,
        psychologist:psychologists(id, first_name, last_name, email, phone, cover_image_url)
      `)
      .eq('status', 'completed')
      .eq('psychologist_id', psychologist_id)
      .gte('updated_at', `${monthStart}T00:00:00.000Z`)
      .lte('updated_at', `${monthEnd}T23:59:59.999Z`)
      .neq('session_type', 'free_assessment'));

    if (sessionsError && String(sessionsError.message || '').includes('cover_image_url')) {
      ({ data: completedSessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(`
          id,
          psychologist_id,
          scheduled_date,
          updated_at,
          status,
          payment_id,
          price,
          psychologist:psychologists(id, first_name, last_name, email, phone)
        `)
        .eq('status', 'completed')
        .eq('psychologist_id', psychologist_id)
        .gte('updated_at', `${monthStart}T00:00:00.000Z`)
        .lte('updated_at', `${monthEnd}T23:59:59.999Z`)
        .neq('session_type', 'free_assessment'));
    }

    if (sessionsError) {
      console.error('Error fetching completed sessions:', sessionsError);
      throw sessionsError;
    }

    const completedSessionsInRange = completedSessions || [];

    if (completedSessionsInRange.length === 0) {
      return res.status(404).json(
        errorResponse('No completed sessions found for this psychologist in the selected month')
      );
    }

    const sessionIds = completedSessionsInRange.map(s => s.id);
    const { data: commissionHistory, error: commissionError } = await supabaseAdmin
      .from('commission_history')
      .select(`
        session_id,
        psychologist_id,
        session_amount,
        commission_amount,
        payment_status
      `)
      .in('session_id', sessionIds);

    if (commissionError) {
      console.error('Error fetching commission history:', commissionError);
    }

    // Calculate totals
    let totalCommission = 0;
    let totalDoctorWallet = 0;
    let totalSessionAmount = 0;

    const commissionMap = {};
    commissionHistory?.forEach(ch => {
      commissionMap[ch.session_id] = ch;
    });

    completedSessionsInRange.forEach(session => {
      let commission = commissionMap[session.id];
      
      if (!commission) {
        // Fallback: if history row is missing, treat full session amount as doctor payout.
        // This avoids blocking mark-paid while keeping company commission conservative.
        const sessionAmount = parseFloat(session.price || 0);
        commission = {
          session_amount: sessionAmount,
          commission_amount: 0
        };
      }

      const sessionAmount = parseFloat(commission.session_amount || 0);
      const commissionAmount = parseFloat(commission.commission_amount || 0);
      const doctorWallet = sessionAmount - commissionAmount;

      totalSessionAmount += sessionAmount;
      totalCommission += commissionAmount;
      totalDoctorWallet += doctorWallet;
    });

    // Create payout record
    const payoutDate = new Date().toISOString().split('T')[0];
    const payoutPeriodLabel = (month && year)
      ? new Date(year, month - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : `${monthStart} to ${monthEnd}`;
    const { data: payout, error: payoutError } = await supabaseAdmin
      .from('payouts')
      .insert([{
        psychologist_id,
        payout_date: payoutDate,
        total_commission: Math.round(totalCommission * 100) / 100,
        tds_amount: 0,
        tds_percentage: 0,
        net_payout: Math.round(totalDoctorWallet * 100) / 100,
        payment_method: 'other',
        status: 'paid',
        processed_by: userId,
        processed_at: new Date().toISOString(),
        notes: `Marked as paid for ${payoutPeriodLabel}`,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (payoutError) {
      console.error('Error creating payout:', payoutError);
      throw payoutError;
    }

    // Update commission history to mark as paid
    // Update all commission history entries for sessions in this month that are still pending
    const { error: commissionUpdateError } = await supabaseAdmin
      .from('commission_history')
      .update({
        payment_status: 'paid',
        payout_id: payout.id,
        updated_at: new Date().toISOString()
      })
      .in('session_id', sessionIds)
      .eq('psychologist_id', psychologist_id)
      .eq('payment_status', 'pending');

    if (commissionUpdateError) {
      console.error('Error updating commission history:', commissionUpdateError);
      // Don't throw - payout is already created, just log the error
    }

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_PAYOUT_MARKED_PAID',
      resource: 'payouts',
      resourceId: payout.id,
      endpoint: '/api/finance/payouts/mark-paid',
      method: 'POST',
      details: { psychologist_id, month, year, amount: totalDoctorWallet },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(
      successResponse(payout, 'Payout marked as paid successfully')
    );

  } catch (error) {
    console.error('Mark payout as paid error:', error);
    res.status(500).json(
      errorResponse('Internal server error while marking payout as paid')
    );
  }
};

// Export all functions
// ============================================
// INCOME MANAGEMENT
// ============================================

/**
 * Get Income Entries
 * GET /api/finance/income
 */
const getIncome = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { dateFrom, dateTo, incomeSource, page = 1, limit = 50 } = req.query;

    let sourceTable = 'income_entries';
    let query = supabaseAdmin
      .from(sourceTable)
      .select('*', { count: 'exact' })
      .order('date', { ascending: false });

    if (dateFrom) query = query.gte('date', dateFrom);
    if (dateTo) query = query.lte('date', dateTo);
    if (incomeSource) query = query.eq('income_source', incomeSource);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    let { data: income, error, count } = await query;

    if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
      // Fallback for environments where table is named `income`.
      sourceTable = 'income';
      let fallbackQuery = supabaseAdmin
        .from(sourceTable)
        .select('*', { count: 'exact' })
        .order('date', { ascending: false });
      if (dateFrom) fallbackQuery = fallbackQuery.gte('date', dateFrom);
      if (dateTo) fallbackQuery = fallbackQuery.lte('date', dateTo);
      if (incomeSource) fallbackQuery = fallbackQuery.eq('income_source', incomeSource);
      fallbackQuery = fallbackQuery.range(offset, offset + parseInt(limit) - 1);
      ({ data: income, error, count } = await fallbackQuery);
    }

    if (error && String(error.message || '').includes('column') && String(error.message || '').includes('.date')) {
      // Fallback if date column is missing.
      let fallbackQuery = supabaseAdmin
        .from(sourceTable)
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });
      if (incomeSource) fallbackQuery = fallbackQuery.eq('income_source', incomeSource);
      fallbackQuery = fallbackQuery.range(offset, offset + parseInt(limit) - 1);
      ({ data: income, error, count } = await fallbackQuery);
    }

    if (error) {
      console.error('Error fetching income:', error);
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return res.json(successResponse({
          income: [],
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: 0,
            totalPages: 0
          }
        }, 'Income table not found; returning empty data'));
      }
      return res.status(500).json(
        errorResponse('Internal server error while fetching income')
      );
    }

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_INCOME_VIEWED',
      resource: 'income',
      endpoint: '/api/finance/income',
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({
      income: income || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        totalPages: Math.ceil((count || 0) / parseInt(limit))
      }
    }, 'Income entries fetched successfully'));

  } catch (error) {
    console.error('Get income error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching income')
    );
  }
};

/**
 * Create Income Entry
 * POST /api/finance/income
 */
const createIncome = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const {
      date,
      income_source,
      description,
      amount,
      payment_method,
      reference_number,
      notes
    } = req.body;

    if (!date || !income_source || !amount) {
      return res.status(400).json(
        errorResponse('Date, income source, and amount are required')
      );
    }

    const { data: income, error } = await supabaseAdmin
      .from('income_entries')
      .insert([{
        date,
        income_source,
        description,
        amount: parseFloat(amount),
        payment_method,
        reference_number,
        notes,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      console.error('Error creating income:', error);
      throw error;
    }

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_INCOME_CREATED',
      resource: 'income',
      resourceId: income.id,
      endpoint: '/api/finance/income',
      method: 'POST',
      details: { amount, income_source },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.status(201).json(
      successResponse(income, 'Income entry created successfully')
    );

  } catch (error) {
    console.error('Create income error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating income entry')
    );
  }
};

// ============================================
// EXPENSE CATEGORIES
// ============================================

/**
 * Get Expense Categories
 * GET /api/finance/settings/categories
 */
const getExpenseCategories = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    let { data: categories, error } = await supabaseAdmin
      .from('expense_categories')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true });

    // Fallback if `is_active` column doesn't exist.
    if (error && String(error.message || '').includes('is_active')) {
      ({ data: categories, error } = await supabaseAdmin
        .from('expense_categories')
        .select('*')
        .order('name', { ascending: true }));
    }

    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return res.json(successResponse({
          categories: []
        }, 'Expense categories table not found; returning empty data'));
      }
      console.error('Error fetching expense categories:', error);
      throw error;
    }

    res.json(successResponse({
      categories: categories || []
    }, 'Expense categories fetched successfully'));

  } catch (error) {
    console.error('Get expense categories error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching expense categories')
    );
  }
};

/**
 * Create Expense Category
 * POST /api/finance/settings/categories
 */
const createExpenseCategory = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { name, description, parent_category_id } = req.body;

    if (!name) {
      return res.status(400).json(
        errorResponse('Category name is required')
      );
    }

    const { data: category, error } = await supabaseAdmin
      .from('expense_categories')
      .insert([{
        name,
        description,
        parent_category_id,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      console.error('Error creating expense category:', error);
      if (error.code === '23505') {
        return res.status(400).json(
          errorResponse('Category with this name already exists')
        );
      }
      throw error;
    }

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_EXPENSE_CATEGORY_CREATED',
      resource: 'expense_categories',
      resourceId: category.id,
      endpoint: '/api/finance/settings/categories',
      method: 'POST',
      details: { name },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.status(201).json(
      successResponse(category, 'Expense category created successfully')
    );

  } catch (error) {
    console.error('Create expense category error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating expense category')
    );
  }
};

// ============================================
// INCOME SOURCES
// ============================================

/**
 * Get Income Sources
 * GET /api/finance/settings/income-sources
 */
const getIncomeSources = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    let { data: sources, error } = await supabaseAdmin
      .from('income_sources')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error && String(error.message || '').includes('is_active')) {
      ({ data: sources, error } = await supabaseAdmin
        .from('income_sources')
        .select('*')
        .order('name', { ascending: true }));
    }

    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return res.json(successResponse({
          sources: []
        }, 'Income sources table not found; returning empty data'));
      }
      console.error('Error fetching income sources:', error);
      throw error;
    }

    res.json(successResponse({
      sources: sources || []
    }, 'Income sources fetched successfully'));

  } catch (error) {
    console.error('Get income sources error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching income sources')
    );
  }
};

/**
 * Create Income Source
 * POST /api/finance/settings/income-sources
 */
const createIncomeSource = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { name, description, is_auto_calculated } = req.body;

    if (!name) {
      return res.status(400).json(
        errorResponse('Income source name is required')
      );
    }

    const { data: source, error } = await supabaseAdmin
      .from('income_sources')
      .insert([{
        name,
        description,
        is_auto_calculated: is_auto_calculated || false,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      console.error('Error creating income source:', error);
      if (error.code === '23505') {
        return res.status(400).json(
          errorResponse('Income source with this name already exists')
        );
      }
      throw error;
    }

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_INCOME_SOURCE_CREATED',
      resource: 'income_sources',
      resourceId: source.id,
      endpoint: '/api/finance/settings/income-sources',
      method: 'POST',
      details: { name },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.status(201).json(
      successResponse(source, 'Income source created successfully')
    );

  } catch (error) {
    console.error('Create income source error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating income source')
    );
  }
};

module.exports = {
  getDashboard,
  getSessions,
  getDoctorBookings,
  getSessionDetails,
  getRevenue,
  getExpenses,
  createExpense,
  approveExpense,
  updateExpense,
  deleteExpense,
  getCommissions,
  updateCommissionRate,
  getPendingPayouts,
  processPayout,
  getIncome,
  createIncome,
  getExpenseCategories,
  createExpenseCategory,
  getIncomeSources,
  createIncomeSource
};

// ============================================
// INCOME MANAGEMENT (UPDATE & DELETE)
// ============================================

/**
 * Update Income Entry
 * PUT /api/finance/income/:incomeId
 */
const updateIncome = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    const { incomeId } = req.params;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const {
      date,
      income_source,
      description,
      amount,
      payment_method,
      reference_number,
      notes
    } = req.body;

    // Check if income entry exists
    const { data: existingIncome, error: checkError } = await supabaseAdmin
      .from('income_entries')
      .select('*')
      .eq('id', incomeId)
      .single();

    if (checkError || !existingIncome) {
      return res.status(404).json(
        errorResponse('Income entry not found')
      );
    }

    // Build update data - only include fields that have actually changed
    const updateData = {
      updated_at: new Date().toISOString()
    };

    // Only update fields that are provided AND different from existing values
    if (date && date !== existingIncome.date) updateData.date = date;
    if (income_source && income_source !== (existingIncome.income_source || '')) updateData.income_source = income_source;
    if (description !== undefined && description !== (existingIncome.description || '')) updateData.description = description;
    if (amount !== undefined) {
      const parsedAmount = parseFloat(amount);
      const existingAmount = parseFloat(existingIncome.amount || 0);
      if (parsedAmount !== existingAmount) {
        updateData.amount = parsedAmount;
      }
    }
    if (payment_method !== undefined && payment_method !== (existingIncome.payment_method || '')) updateData.payment_method = payment_method;
    if (reference_number !== undefined && reference_number !== (existingIncome.reference_number || '')) updateData.reference_number = reference_number;
    if (notes !== undefined && notes !== (existingIncome.notes || '')) updateData.notes = notes;

    // Only perform update if there are actual changes (besides updated_at)
    let updatedIncome;
    let error;
    
    if (Object.keys(updateData).length > 1) {
      const { data, error: updateError } = await supabaseAdmin
        .from('income_entries')
        .update(updateData)
        .eq('id', incomeId)
        .select()
        .single();
      
      updatedIncome = data;
      error = updateError;
    } else {
      // No changes, return existing income
      updatedIncome = existingIncome;
      error = null;
    }

    if (error) {
      console.error('Error updating income:', error);
      throw error;
    }

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_INCOME_UPDATED',
      resource: 'income',
      resourceId: incomeId,
      endpoint: `/api/finance/income/${incomeId}`,
      method: 'PUT',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(
      successResponse(updatedIncome, 'Income entry updated successfully')
    );

  } catch (error) {
    console.error('Update income error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating income entry')
    );
  }
};

/**
 * Delete Income Entry
 * DELETE /api/finance/income/:incomeId
 */
const deleteIncome = async (req, res) => {
  try {
    const userRole = req.user.role;
    const userId = req.user.id;
    const { incomeId } = req.params;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    // Check if income entry exists
    const { data: existingIncome, error: checkError } = await supabaseAdmin
      .from('income_entries')
      .select('*')
      .eq('id', incomeId)
      .single();

    if (checkError || !existingIncome) {
      return res.status(404).json(
        errorResponse('Income entry not found')
      );
    }

    // Delete income entry
    const { error } = await supabaseAdmin
      .from('income_entries')
      .delete()
      .eq('id', incomeId);

    if (error) {
      console.error('Error deleting income:', error);
      throw error;
    }

    await auditLogger.logAction({
      userId,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_INCOME_DELETED',
      resource: 'income',
      resourceId: incomeId,
      endpoint: `/api/finance/income/${incomeId}`,
      method: 'DELETE',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(
      successResponse(null, 'Income entry deleted successfully')
    );

  } catch (error) {
    console.error('Delete income error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting income entry')
    );
  }
};

// ============================================
// PAYOUTS (GET ALL & DETAILS)
// ============================================

/**
 * Get All Payouts
 * GET /api/finance/payouts
 */
const getPayouts = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { dateFrom, dateTo, psychologistId, status, page = 1, limit = 50 } = req.query;

    let query = supabaseAdmin
      .from('payouts')
      .select(`
        *,
        psychologist:psychologists(id, first_name, last_name)
      `, { count: 'exact' })
      .order('payout_date', { ascending: false });

    if (dateFrom) query = query.gte('payout_date', dateFrom);
    if (dateTo) query = query.lte('payout_date', dateTo);
    if (psychologistId) query = query.eq('psychologist_id', psychologistId);
    if (status) query = query.eq('status', status);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data: payouts, error, count } = await query;

    if (error) {
      console.error('Error fetching payouts:', error);
      throw error;
    }

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_PAYOUTS_VIEWED',
      resource: 'payouts',
      endpoint: '/api/finance/payouts',
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({
      payouts: payouts || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        totalPages: Math.ceil((count || 0) / parseInt(limit))
      }
    }, 'Payouts fetched successfully'));

  } catch (error) {
    console.error('Get payouts error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching payouts')
    );
  }
};

/**
 * Get Payout Details
 * GET /api/finance/payouts/:payoutId
 */
const getPayoutDetails = async (req, res) => {
  try {
    const userRole = req.user.role;
    const { payoutId } = req.params;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const { data: payout, error } = await supabaseAdmin
      .from('payouts')
      .select(`
        *,
        psychologist:psychologists(id, first_name, last_name, email, phone)
      `)
      .eq('id', payoutId)
      .single();

    if (error || !payout) {
      return res.status(404).json(
        errorResponse('Payout not found')
      );
    }

    // Get related commission history
    const { data: commissions } = await supabaseAdmin
      .from('commission_history')
      .select('*')
      .eq('payout_id', payoutId);

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_PAYOUT_DETAILS_VIEWED',
      resource: 'payouts',
      resourceId: payoutId,
      endpoint: `/api/finance/payouts/${payoutId}`,
      method: 'GET',
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({
      payout: {
        ...payout,
        commissions: commissions || []
      }
    }, 'Payout details fetched successfully'));

  } catch (error) {
    console.error('Get payout details error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching payout details')
    );
  }
};

module.exports = {
  getDashboard,
  getSessions,
  getDoctorBookings,
  getSessionDetails,
  getRevenue,
  getExpenses,
  createExpense,
  approveExpense,
  updateExpense,
  deleteExpense,
  getCommissions,
  updateCommissionRate,
  getPendingPayouts,
  processPayout,
  getIncome,
  createIncome,
  updateIncome,
  deleteIncome,
  getExpenseCategories,
  createExpenseCategory,
  getIncomeSources,
  createIncomeSource,
  getPayouts,
  getPayoutDetails
};

// ============================================
// FREE ASSESSMENTS MANAGEMENT
// ============================================

/**
 * Get All Free Assessments
 * GET /api/finance/free-assessments
 */
const getFreeAssessments = async (req, res) => {
  try {
    const userRole = req.user.role;

    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(
        errorResponse('Access denied. Finance role required.')
      );
    }

    const {
      dateFrom,
      dateTo,
      psychologistId,
      status,
      page = 1,
      limit = 50,
      search
    } = req.query;

    // Build query for free assessments
    let query = supabaseAdmin
      .from('free_assessments')
      .select(`
        id,
        assessment_number,
        scheduled_date,
        scheduled_time,
        status,
        psychologist_id,
        client_id,
        user_id,
        session_id,
        created_at
      `, { count: 'exact' });

    // Apply filters
    if (dateFrom) {
      query = query.gte('scheduled_date', dateFrom);
    }
    if (dateTo) {
      query = query.lte('scheduled_date', dateTo);
    }
    if (psychologistId) {
      query = query.eq('psychologist_id', psychologistId);
    }
    if (status) {
      query = query.eq('status', status);
    }
    if (search) {
      query = query.or(`id.ilike.%${search}%,assessment_number.ilike.%${search}%`);
    }

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);
    query = query.order('scheduled_date', { ascending: false });
    query = query.order('scheduled_time', { ascending: false });

    const { data: assessments, error, count } = await query;

    if (error) {
      console.error('Error fetching free assessments:', error);
      return res.json(successResponse({
        assessments: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          totalPages: 0
        }
      }, 'Free assessments fetched successfully (empty)'));
    }

    const assessmentsData = assessments || [];

    // Get psychologist and client details separately
    const psychologistIds = [...new Set(assessmentsData.map(a => a?.psychologist_id).filter(Boolean))];
    const clientIds = [...new Set(assessmentsData.map(a => a?.client_id).filter(Boolean))];
    
    let psychologists = [];
    let clients = [];
    
    if (psychologistIds.length > 0) {
      const { data: psychData } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, email')
        .in('id', psychologistIds);
      psychologists = psychData || [];
    }
    
    if (clientIds.length > 0) {
      const { data: clientData } = await supabaseAdmin
        .from('clients')
        .select('id, first_name, last_name, child_name')
        .in('id', clientIds);
      clients = clientData || [];
    }

    // Get session data for meet links using session_id from free_assessments
    const sessionIds = assessmentsData.map(a => a?.session_id).filter(Boolean);
    let sessions = [];
    if (sessionIds.length > 0) {
      const { data: sessionData } = await supabaseAdmin
        .from('sessions')
        .select('id, google_meet_link')
        .in('id', sessionIds);
      sessions = sessionData || [];
    }

    const assessmentsWithDetails = assessmentsData.map(assessment => {
      if (!assessment) return null;
      const psychologist = psychologists.find(p => p.id === assessment.psychologist_id);
      const client = clients.find(c => c.id === assessment.client_id);
      // Match session by session_id from free_assessments table
      const session = assessment.session_id ? sessions.find(s => s && s.id === assessment.session_id) : null;
      
      return {
        id: assessment.id,
        assessment_number: assessment.assessment_number,
        scheduled_date: assessment.scheduled_date,
        scheduled_time: assessment.scheduled_time,
        status: assessment.status,
        created_at: assessment.created_at || null,
        psychologist: psychologist ? {
          id: psychologist.id,
          first_name: psychologist.first_name,
          last_name: psychologist.last_name,
          email: psychologist.email
        } : null,
        client: client ? {
          id: client.id,
          first_name: client.first_name,
          last_name: client.last_name,
          child_name: client.child_name
        } : null,
        meet_link: session?.google_meet_link || null
      };
    }).filter(Boolean);

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_FREE_ASSESSMENTS_VIEWED',
      resource: 'free_assessments',
      endpoint: '/api/finance/free-assessments',
      method: 'GET',
      details: { filters: req.query },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({
      assessments: assessmentsWithDetails || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        totalPages: Math.ceil((count || 0) / parseInt(limit))
      }
    }, 'Free assessments fetched successfully'));

  } catch (error) {
    console.error('Get free assessments error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching free assessments')
    );
  }
};

module.exports = {
  getDashboard,
  getSessions,
  getDoctorBookings,
  getSessionDetails,
  getRevenue,
  getExpenses,
  createExpense,
  approveExpense,
  updateExpense,
  deleteExpense,
  getCommissions,
  updateCommissionRate,
  getPendingPayouts,
  processPayout,
  getIncome,
  createIncome,
  updateIncome,
  deleteIncome,
  getExpenseCategories,
  createExpenseCategory,
  getIncomeSources,
  createIncomeSource,
  getPayouts,
  getPayoutDetails,
  getFreeAssessments,
  markPayoutAsPaid,
  getDoctorPayouts
};
