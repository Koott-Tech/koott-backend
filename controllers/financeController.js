const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');
const { computeSessionDoctorWallet } = require('../utils/sessionCommission');
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
const { enrichSessionRowDisplayFields, hydrateSessionsWixPayloadFromMirror } = require('../utils/wixSessionRowEnrichment');

const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);
dayjs.extend(timezone);

const FINANCE_IST_TZ = 'Asia/Kolkata';

const FINANCE_SNAPSHOT_SELECT = [
  'snapshot_locked',
  'total_revenue',
  'net_profit',
  'total_expenses',
  'pending_payout',
  'payout_received',
  'total_sessions',
  'pending_sessions',
  'completed_sessions',
  'rescheduled_sessions',
  'reschedule_requested_sessions',
  'no_show_sessions',
  'upcoming_sessions',
  'active_doctors',
  'total_company_commission',
  'total_doctor_wallet',
  'refund_total',
].join(', ');

const FINANCE_EXPENSE_SELECT = [
  'id',
  'date',
  'created_at',
  'category',
  'custom_category',
  'description',
  'amount',
  'payment_method',
  'vendor_supplier',
  'receipt_url',
  'reference_number',
  'notes',
  'approval_status',
  'status',
  'approved_by',
  'approved_at',
  'updated_at',
  'is_recurring',
  'recurring_frequency',
  'expense_type',
  'subscription_id',
].join(', ');

const FINANCE_EXPENSE_LEGACY_SELECT = [
  'id',
  'created_at',
  'category',
  'custom_category',
  'description',
  'amount',
  'payment_method',
  'vendor_supplier',
  'receipt_url',
  'reference_number',
  'notes',
  'status',
  'approved_by',
  'approved_at',
  'updated_at',
  'is_recurring',
  'recurring_frequency',
  'expense_type',
  'subscription_id',
].join(', ');

const FINANCE_INCOME_SELECT = [
  'id',
  'date',
  'created_at',
  'income_source',
  'description',
  'amount',
  'payment_method',
  'reference_number',
  'notes',
  'updated_at',
].join(', ');

const FINANCE_INCOME_LEGACY_SELECT = [
  'id',
  'created_at',
  'income_source',
  'description',
  'amount',
  'payment_method',
  'reference_number',
  'notes',
  'updated_at',
].join(', ');

const FINANCE_DOCTOR_COMMISSION_SELECT = [
  'id',
  'psychologist_id',
  'commission_amount_individual',
  'commission_amount_package',
  'commission_percentage',
  'commission_amounts',
  'doctor_commission_first_session',
  'doctor_commission_followup',
  'doctor_commission_individual',
  'doctor_commission_first_session_package',
  'doctor_commission_followup_package',
  'doctor_commission_packages',
  'is_active',
  'effective_from',
  'notes',
  'created_at',
  'updated_at',
].join(', ');

const FINANCE_PAYMENT_SELECT = [
  'id',
  'transaction_id',
  'razorpay_order_id',
  'razorpay_payment_id',
  'amount',
  'currency',
  'status',
  'payment_method',
  'completed_at',
  'created_at',
  'receipt_url',
  'reference_number',
  'notes',
  'razorpay_params',
  'razorpay_response',
].join(', ');

const FINANCE_RECEIPT_SELECT = [
  'receipt_number',
  'receipt_number_long',
  'receipt_url',
  'file_path',
  'file_url',
  'created_at',
].join(', ');

const FINANCE_CATEGORY_SELECT = 'id, name, description, is_active, created_at, updated_at';
const FINANCE_INCOME_SOURCE_SELECT = 'id, name, description, is_auto_calculated, is_active, created_at, updated_at';
const FINANCE_PAYOUT_FALLBACK_SELECT = 'id, net_payout, payout_amount, amount, payout_date, status';

const DEFAULT_SALARY_EMPLOYEES = [
  { employee_id: 'KT001', name: 'ATHULYA O', email: 'koott.athulya@gmail.com', designation: 'CARE MANAGER / PSYCHOLOGIST', location: 'Calicut, India' },
  { employee_id: 'KT002', name: 'JISHNULAL M', email: 'Jishnulal954@gmail.com', designation: 'TEAM MARKETING', location: 'Calicut, India' },
  { employee_id: 'KT003', name: 'DR. ASWATHI PR', email: 'dr.aswathi.raman.koott@gmail.com', designation: 'CHIEF PSYCHOLOGIST', location: 'Calicut, India' },
  { employee_id: 'KT004', name: 'IRENE CHERIAN', email: 'irene.Koott@gmail.com', designation: 'CONSULTANT PSYCHOLOGIST', location: 'Calicut, India' },
  { employee_id: 'KT005', name: 'SHUHAIMA KATTI', email: 'shuhaima.koott@gmail.com', designation: 'CONSULTANT PSYCHOLOGIST', location: 'Calicut, India' },
  { employee_id: 'KT006', name: 'SHINAS KD', email: 'Shinaschungam@mail.com', designation: 'MARKETING TEAM', location: 'Calicut, India' },
  { employee_id: 'KT007', name: 'FAISAL VP', email: 'faisal@koott.in', designation: 'CEO / FOUNDER', location: 'Calicut, India' },
  { employee_id: 'KT008', name: 'LIANA SAMEER', email: 'liana.koott@gmail.com', designation: 'CONSULTANT PSYCHOLOGIST', location: 'Calicut, India' },
  { employee_id: 'KT009', name: 'ABHISHEK R', email: 'abhishekravi063@gmail.com', designation: 'DEVELOPER TEAM', location: 'Calicut, India' },
  { employee_id: 'KT0010', name: 'SIMSARUL HAQUE', email: 'simsar280108@gmail.com', designation: 'GROUP ACCOUNTANT', location: 'Calicut, India' },
  { employee_id: 'KT0011', name: 'SREERAG BABU', email: 'sreerag.koott@gmail.com', designation: 'CONSULTANT PSYCHOLOGIST', location: 'Calicut, India' },
  { employee_id: 'KT0012', name: 'AISWARYA', email: 'aiswaryasanthosh801@gamil.com', designation: 'TEAM MARKETING', location: 'Calicut, India' },
  { employee_id: 'KT0013', name: 'SREEDEVI V V', email: 'Sreedevi.koott@gmail.com', designation: 'TEAM OPERATION', location: 'Calicut, India' },
  { employee_id: 'KT0014', name: 'RAHNAS FATHIMA', email: 'rahnaskoott@gmail.com', designation: 'TEAM OPERATION', location: 'Calicut, India' },
  { employee_id: 'KT0015', name: 'SREELAKSHMI N', email: 'sreelakshmi.koott@gmail.com', designation: 'CONSULTANT PSYCHOLOGIST', location: 'Calicut, India' },
  { employee_id: 'KT0016', name: 'SIKHA K', email: 'sikha.koott@gmail.com', designation: 'TEAM OPERATION', location: 'Calicut, India' },
];

const mapSalaryEmployeeForApi = (row) => ({
  id: row.id || null,
  employeeId: row.employee_id || row.employeeId || '',
  name: row.name || '',
  email: row.email || '',
  designation: row.designation || '',
  location: row.location || 'Calicut, India',
});

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeReceiptFileName(value = 'koott-receipt.pdf') {
  const cleaned = String(value || 'koott-receipt.pdf')
    .replace(/[^\w.\-() ]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120);
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned || 'koott-receipt'}.pdf`;
}

function isHiddenWixListRow(session) {
  const src = String(session?.source || '').toLowerCase();
  if (src !== 'wix') return false;
  const wp = session?.wix_payload;
  const missingSessionId = !wp || typeof wp !== 'object' || !wp.sessionId;
  const isUndefinedWix = !session?.payment_id && missingSessionId;
  const isPackageChild = Number(session?.package_session_number || 1) > 1;
  return isUndefinedWix || isPackageChild;
}

function isCoupleSessionLike(session) {
  const sessionTypeText = String(session?.session_type || '').toLowerCase();
  const payloadText = `${session?.wix_payload?.bookingType || ''} ${session?.wix_payload?.booking_type || ''} ${session?.wix_payload?.session_type || ''}`.toLowerCase();
  return sessionTypeText.includes('couple') ||
    sessionTypeText.includes('cpl') ||
    payloadText.includes('couple') ||
    payloadText.includes('cpl');
}

function getFinancePackageType(session, packageMeta = null) {
  const sessionCount = Math.max(
    1,
    parseInt(session?.session_count || packageMeta?.session_count, 10) || 1
  );
  const isCouplePackage = isCoupleSessionLike(session) && sessionCount > 1;
  if (isCouplePackage) return `couple_package_${sessionCount}`;
  return packageMeta?.package_type || `package_${sessionCount}`;
}

/** Non-terminal sessions that still count as “pending fulfilment” on the dashboard card (excludes cancelled). */
// Marks a commission_history row as hand-edited in the finance UI. Recalculation jobs must
// skip these rows so a backfill never overwrites a deliberate correction.
const MANUAL_COMMISSION_EDIT_TAG = 'MANUAL_COMMISSION_EDIT';

const PENDING_SESSION_CARD_STATUSES = new Set([
  'booked',
  // A handful of rows carry a literal 'pending' status (e.g. sessions transferred between
  // therapists). It means the same thing as a past-due 'booked' row — which the admin and
  // finance UIs already both render as "pending" — but leaving it out of this set dropped
  // those sessions from the payout scan entirely: absent from the payouts table, from View
  // Details and from the Excel export, so the therapist was never paid for them.
  'pending',
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
 * Clients imported from past contact lists (backdated to 2024-12-31, no password_hash/google_id)
 * are pre-existing/past clients even though they have no session history in our system. Their
 * first booking here must NOT be treated as a "first session" for commission purposes — they
 * should get the follow-up rate. Cutoff is safely before any real signup (earliest real signup
 * seen is 2026+).
 */
const PRE_EXISTING_CLIENT_CUTOFF = '2025-06-01';

/** Returns a Set of client_ids that are pre-existing (imported) clients, given a list of client_ids to check. */
async function getPreExistingClientIds(clientIds) {
  const ids = Array.from(new Set((clientIds || []).filter(Boolean)));
  if (!ids.length) return new Set();
  const result = new Set();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data } = await supabaseAdmin
      .from('clients')
      .select('id, created_at')
      .in('id', chunk)
      .lt('created_at', PRE_EXISTING_CLIENT_CUTOFF);
    (data || []).forEach((c) => result.add(c.id));
  }
  return result;
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
    const shouldIncludeCharts = includeCharts === true || String(includeCharts || '').toLowerCase() === 'true';
    
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
          .select(FINANCE_SNAPSHOT_SELECT)
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
        .in('status', ['completed', 'booked', 'pending', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'])
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
          .in('status', ['completed', 'booked', 'pending', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'])
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
          .in('status', ['completed', 'booked', 'pending', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'])
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
            .in('status', ['completed', 'booked', 'pending', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'])
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
          const paidStatuses = ['completed', 'booked', 'pending', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'];
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
        const paidStatuses = ['completed', 'booked', 'pending', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'];
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
        .select(FINANCE_EXPENSE_SELECT)
        .eq('approval_status', 'approved')
        .gte('date', ytdFrom));

      // Legacy schema fallback: approval_status/date may be missing
      if (expensesError && String(expensesError.message || '').includes('approval_status')) {
        ({ data: expenses, error: expensesError } = await supabaseAdmin
          .from('expenses')
          .select(FINANCE_EXPENSE_LEGACY_SELECT)
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
        .select(FINANCE_INCOME_SELECT)
        .gte('date', ytdFrom));

      // Legacy fallback where table is named `income`.
      if (incomeError && (incomeError.code === '42P01' || incomeError.code === 'PGRST205')) {
        ({ data: income, error: incomeError } = await supabaseAdmin
          .from('income')
          .select(FINANCE_INCOME_SELECT)
          .gte('date', ytdFrom));
      }

      // Legacy fallback where `date` may not exist.
      if (incomeError && String(incomeError.message || '').includes('.date')) {
        ({ data: income, error: incomeError } = await supabaseAdmin
          .from('income_entries')
          .select(FINANCE_INCOME_LEGACY_SELECT)
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
      const paidStatuses = ['completed', 'booked', 'pending', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow'];
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
        const monthEnd = new Date(Date.UTC(date.getFullYear(), date.getMonth() + 1, 0)).toISOString().split('T')[0];
        
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
    let pendingPayout = 0; // Doctor wallet for BOOKED (not yet completed) sessions — work pending
    let payout = 0; // Doctor wallet for COMPLETED sessions — earned/ready to pay out
    let completedDoctorWalletInRange = 0; // Total doctor wallet from completed sessions in range (= payout)
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
          .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'])
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
            .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'])
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
            .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'])
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
              .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'])
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
            .select('session_id, commission_amount, session_amount, payment_status')
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

          // Pre-existing (imported) clients don't get the first-session rate even
          // though this is their first session in our system — they're past clients.
          const preExistingIds = await getPreExistingClientIds(Object.keys(sessionsByClient));
          if (preExistingIds.size) {
            Object.entries(sessionsByClient).forEach(([clientId, clientSessions]) => {
              if (!preExistingIds.has(clientId)) return;
              clientSessions.forEach(s => clientFirstSessions.delete(s.id));
            });
          }
        }

        // Build a set of package_ids whose package is the client's first engagement.
        // All sessions in such a package use the first-session commission rate.
        const firstPackages = new Set();
        (allSessions || []).forEach(s => {
          if (s.package_id && clientFirstSessions.has(s.id)) {
            firstPackages.add(s.package_id);
          }
        });

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
          // A "refund" in finance terms = any session where money was returned to client.
          // This includes both status='refunded' AND status='cancelled' (when price > 0)
          // because both represent revenue that was refunded.
          const isRefunded = s.status === 'refunded' || (s.status === 'cancelled' && parseFloat(s.price || 0) > 0);
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
          //
          // Rule (consistent across admin / finance / therapist dashboards):
          //   • Total / Revenue / Refund  → booking_created_at in range (when money / booking happened)
          //   • Upcoming / Completed / Rescheduled / NoShow → scheduled_date in range
          //     (when the session is/was actually happening)
          let origInRange = false;
          let schedInRange = false;
          if (mtdFrom && mtdTo) {
            const bookedCreatedYmd = getSessionBookingCreatedIstDateString(s);
            const bookingCreatedInRange = !!(bookedCreatedYmd && bookedCreatedYmd >= mtdFrom && bookedCreatedYmd <= mtdTo);
            const scheduledYmd = s.scheduled_date ? String(s.scheduled_date).slice(0, 10) : null;
            const scheduledInRange = !!(scheduledYmd && scheduledYmd >= mtdFrom && scheduledYmd <= mtdTo);
            origInRange = bookingCreatedInRange;
            schedInRange = scheduledInRange;

            // Revenue & totals: customer booking created in picker range (IST day)
            shouldIncludeForRevenue = bookingCreatedInRange;
            shouldIncludeForTotal = bookingCreatedInRange;

            // Status counts: based on scheduled_date (when work is happening this month)
            if (s.status === 'rescheduled') shouldIncludeForRescheduledCount = scheduledInRange;
            if (s.status === 'no_show' || s.status === 'noshow') shouldIncludeForNoShowCount = scheduledInRange;
            if (s.status === 'reschedule_requested') shouldIncludeForRescheduleRequestedCount = scheduledInRange;

            if ((s.status === 'booked' || s.status === 'rescheduled') && scheduledInRange) {
              shouldIncludeForUpcoming = true;
            }

            const bookedInPreviousWindow = !!(bookedCreatedYmd && mtdFrom && bookedCreatedYmd < mtdFrom);

            if (isCompleted) {
              // Completed counts: prefer completion_date if available, else scheduled_date
              const completionYmd = s.completion_date ? String(s.completion_date).slice(0, 10) : scheduledYmd;
              const completedInRange = !!(completionYmd && completionYmd >= mtdFrom && completionYmd <= mtdTo);
              shouldIncludeForCompleted = completedInRange;
              shouldIncludeForCompletedCount = completedInRange;

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
            // Completed session — use shared utility for consistent per-session split
            const dc = commissionRecordsMap[s.psychologist_id] || null;
            const ch = historyRecord || null;
            toDoctorWallet = computeSessionDoctorWallet(s, dc, ch);
            commissionToCompany = Math.max(0, sessionPrice - toDoctorWallet);

            if (shouldIncludeForCompleted) {
              totalCompanyCommissionCompleted += commissionToCompany;
              completedDoctorWalletInRange += toDoctorWallet;
            }
            if (shouldIncludeForCompletedCount && isCompleted) {
              completedSessionsCount++;
            }
          } else {
            // Booked/Non-completed — pending payout, use shared utility for consistent split
            const dc = commissionRecordsMap[s.psychologist_id] || null;
            toDoctorWallet = computeSessionDoctorWallet(s, dc, null);
            commissionToCompany = Math.max(0, sessionPrice - toDoctorWallet);
          }
          
          // Add to commission totals based on different criteria:
          // 1. Revenue/Commission for sessions scheduled/completed in date range
          // Uses scheduled_date for non-completed, completion_date for completed sessions
          // Carry-over model:
          //  • Revenue / Doctor Wallet / Refund → based on booking_created_at in range ("money in" this month)
          //  • Payout → based on completion_date in range ("doctor earned" in this month, regardless of booking month)
          //  • Pending Payout → doctor wallet for sessions that were STILL pending at month end
          //                     (booked by end of view-month AND not completed by end of view-month).
          //                     A May-booked session not completed by May 31 → in May's pending.
          //                     If it then completes in June → leaves the live pending balance and
          //                     enters June's payout (May's snapshot stays frozen).

          // 1. REVENUE / DOCTOR WALLET / REFUND — booking_created_at in range
          if (shouldIncludeForRevenue) {
            if (isRefunded) {
              totalRefundAmount += sessionPrice;
              // Refunded sessions: NO commission, NO doctor wallet — money was returned
            } else {
              totalCompanyCommission += commissionToCompany;
              totalDoctorWallet += toDoctorWallet;
            }
            totalRevenueFromSessions += sessionPrice;
          }

          // 2. PAYOUT — completion_date in range, regardless of when session was booked
          if (isCompleted && !isRefunded) {
            const completionYmd = s.completion_date
              ? String(s.completion_date).split('T')[0]
              : (s.scheduled_date ? String(s.scheduled_date).split('T')[0] : null);
            const completedInMonth = mtdFrom && mtdTo
              ? !!(completionYmd && completionYmd >= mtdFrom && completionYmd <= mtdTo)
              : true;
            if (completedInMonth) {
              payout += toDoctorWallet;
            }
          }

          // 3. PENDING PAYOUT — sessions still pending at end of view-month
          //    Includes carry-over: a session booked before the view-month that
          //    hasn't been completed by view-month-end still appears here.
          if (!isRefunded) {
            const bookedYmd = getSessionBookingCreatedIstDateString(s);
            const bookedByMonthEnd = !mtdTo || (bookedYmd && bookedYmd <= mtdTo);
            const completionYmd = s.completion_date
              ? String(s.completion_date).split('T')[0]
              : (s.scheduled_date ? String(s.scheduled_date).split('T')[0] : null);
            const stillPendingAtMonthEnd = !isCompleted ||
              (completionYmd && mtdTo && completionYmd > mtdTo);
            if (bookedByMonthEnd && stillPendingAtMonthEnd) {
              pendingPayout += toDoctorWallet;
            }
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

        // NEW SEMANTICS: payout = doctor wallet from COMPLETED sessions; pendingPayout = doctor wallet
        // from BOOKED sessions (waiting). Both are already accumulated in the loop above. Skip the
        // legacy commission_history override (which conflated "paid by finance" with "earned").
        // To re-enable history-based payout tracking, set FINANCE_USE_HISTORY_PAYOUTS=true in env.
        if (process.env.FINANCE_USE_HISTORY_PAYOUTS === 'true') try {
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
              .select('session_id, session_amount, commission_amount, payment_status, payment_id')
              .in('session_id', completedIds));

            if (paidHistoryErr && String(paidHistoryErr.message || '').includes('payment_status')) {
              ({ data: paidHistoryRows, error: paidHistoryErr } = await supabaseAdmin
                .from('commission_history')
                .select('session_id, session_amount, commission_amount, payment_id')
                .in('session_id', completedIds));
            }

            if (paidHistoryErr && String(paidHistoryErr.message || '').includes('session_amount')) {
              ({ data: paidHistoryRows, error: paidHistoryErr } = await supabaseAdmin
                .from('commission_history')
                .select('session_id, commission_amount, payment_status, payment_id')
                .in('session_id', completedIds));
            }

            if (paidHistoryErr && String(paidHistoryErr.message || '').includes('payment_status')) {
              ({ data: paidHistoryRows, error: paidHistoryErr } = await supabaseAdmin
                .from('commission_history')
                .select('session_id, commission_amount, payment_id')
                .in('session_id', completedIds));
            }

            if (paidHistoryErr) throw paidHistoryErr;

            const sessionPriceMap = new Map((completedInRange || []).map(s => [s.id, parseFloat(s.price || 0) || 0]));
            payout = (paidHistoryRows || []).reduce((sum, row) => {
              if (!(row?.payment_status === 'paid' || row?.payment_id)) return sum;
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
              .select(FINANCE_PAYOUT_FALLBACK_SELECT)
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
        // GATED: Skipped by default because we now use the in-loop semantics
        // (pending = booked, payout = completed). Re-enable with FINANCE_USE_HISTORY_PAYOUTS=true.
        if (process.env.FINANCE_USE_HISTORY_PAYOUTS === 'true') try {
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
                .select('session_id, session_amount, commission_amount, payment_status, payment_id')
                .in('session_id', completedIds));

              if (chErr && String(chErr.message || '').includes('payment_status')) {
                ({ data: chRows, error: chErr } = await supabaseAdmin
                  .from('commission_history')
                  .select('session_id, session_amount, commission_amount, payment_id')
                  .in('session_id', completedIds));
              }

              if (chErr && String(chErr.message || '').includes('session_amount')) {
                ({ data: chRows, error: chErr } = await supabaseAdmin
                  .from('commission_history')
                  .select('session_id, commission_amount, payment_status, payment_id')
                  .in('session_id', completedIds));
              }

              if (chErr && String(chErr.message || '').includes('payment_status')) {
                ({ data: chRows, error: chErr } = await supabaseAdmin
                  .from('commission_history')
                  .select('session_id, commission_amount, payment_id')
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
                  if (!(row?.payment_status === 'paid' || row?.payment_id)) {
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
        total_revenue: Math.round(totalRevenueFromSessions || 0),
        net_profit: Math.round(netProfitForSelectedRange || 0),
        total_expenses: Math.round(expensesForSelectedRange || 0),
        pending_payouts: Math.round(pendingPayout || 0),
        payout: Math.round(payout || 0),
        total_sessions: totalSessions,
        pending_sessions: pendingSessionsCount || 0,
        completed_sessions: completedSessionsCount || 0,
        rescheduled_sessions: rescheduledSessionsCount || 0,
        reschedule_requested_sessions: rescheduleRequestedSessionsCount || 0,
        no_show_sessions: noShowSessionsCount || 0,
        upcoming_sessions: upcomingSessionsCount || 0,
        active_doctors: activeDoctors,
        total_company_commission: Math.round(totalCompanyCommission || 0),
        total_company_commission_completed: Math.round(totalCompanyCommissionCompleted || 0),
        total_doctor_wallet: Math.round(totalDoctorWallet || 0),
        refund_total: Math.round(totalRefundAmount || 0),
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

    // Get only sessions that can appear for the requested payout status.
    let allSessionsQuery = supabaseAdmin
      .from('sessions')
      .select('id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, original_scheduled_date, status, payment_id, created_at, updated_at, completion_date, package_session_number, session_count')
      .not('psychologist_id', 'is', null)
      .neq('session_type', 'free_assessment')
      .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow'])
      .in('psychologist_id', allPsychIds);

    if (status === 'completed') {
      allSessionsQuery = allSessionsQuery.eq('status', 'completed');
      if (dateFrom && dateTo) {
        allSessionsQuery = allSessionsQuery.gte('scheduled_date', dateFrom).lte('scheduled_date', dateTo);
      }
    } else if (status === 'pending' && dateFrom && dateTo) {
      allSessionsQuery = allSessionsQuery.gte('created_at', `${dateFrom}T00:00:00+05:30`).lte('created_at', `${dateTo}T23:59:59.999+05:30`);
    }
    
    // Paginate — the same 1000-row PostgREST cap that was silently truncating the pending
    // payout scan applies here too (July alone has 1041 completed sessions), which under-
    // reported every doctor's Completed-tab total.
    const allSessions = [];
    {
      let pageErr = null;
      for (let offset = 0; ; offset += 1000) {
        const { data: page, error } = await allSessionsQuery
          .order('created_at', { ascending: true })
          .range(offset, offset + 999);
        if (error) { pageErr = error; break; }
        allSessions.push(...(page || []));
        if (!page || page.length < 1000) break;
      }
      if (pageErr) console.error('[getDoctorPayouts] session page fetch failed:', pageErr.message);
    }

    // Client names for the session-level breakdown table.
    const payoutClientIds = [...new Set((allSessions || []).map((s) => s.client_id).filter(Boolean))];
    const payoutClientNameMap = {};
    const payoutClientEmailMap = {};
    {
      // clients.email is usually NULL — the address lives on users.email via clients.user_id.
      const userIdByClient = {};
      for (let i = 0; i < payoutClientIds.length; i += 100) {
        const { data: cRows } = await supabaseAdmin
          .from('clients')
          .select('id, first_name, last_name, email, user_id')
          .in('id', payoutClientIds.slice(i, i + 100));
        (cRows || []).forEach((c) => {
          payoutClientNameMap[c.id] = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
          if (c.email) payoutClientEmailMap[c.id] = c.email;
          else if (c.user_id) userIdByClient[c.id] = c.user_id;
        });
      }
      const missingUserIds = [...new Set(Object.values(userIdByClient))];
      const emailByUser = {};
      for (let i = 0; i < missingUserIds.length; i += 100) {
        const { data: uRows } = await supabaseAdmin
          .from('users').select('id, email').in('id', missingUserIds.slice(i, i + 100));
        (uRows || []).forEach((u) => { if (u.email) emailByUser[u.id] = u.email; });
      }
      Object.entries(userIdByClient).forEach(([cid, uid]) => {
        if (emailByUser[uid]) payoutClientEmailMap[cid] = emailByUser[uid];
      });
    }

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
    // Chunk this lookup: a single .in() with every completed session id (973+ UUIDs) overflows
    // the PostgREST GET URL and returns "Bad Request". The error was discarded here, so the
    // map came back EMPTY — and since a completed payout requires payment_status === 'paid'
    // from that map, the Completed tab silently showed ZERO payouts for every doctor.
    for (let i = 0; i < sessionIds.length; i += 100) {
      const { data: history, error: historyErr } = await supabaseAdmin
        .from('commission_history')
        .select('session_id, commission_amount, session_amount, payment_status')
        .in('session_id', sessionIds.slice(i, i + 100));
      if (historyErr) {
        console.error('[getDoctorPayouts] commission_history chunk failed:', historyErr.message);
        continue;
      }
      commissionHistory.push(...(history || []));
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

      // Pre-existing (imported) clients don't get the first-session rate even
      // though this is their first session in our system — they're past clients.
      const preExistingIds = await getPreExistingClientIds(Object.keys(sessionsByClient));
      if (preExistingIds.size) {
        Object.entries(sessionsByClient).forEach(([clientId, clientSessions]) => {
          if (!preExistingIds.has(clientId)) return;
          clientSessions.forEach(s => clientFirstSessions.delete(s.id));
        });
      }
    }

    const firstPackages = new Set();
    (allSessions || []).forEach(s => {
      if (s.package_id && clientFirstSessions.has(s.id)) {
        firstPackages.add(s.package_id);
      }
    });

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
      const isPackage = !!s.package_id || (parseInt(s.session_count, 10) || 1) > 1 || String(s.session_type || '').toLowerCase().includes('package');
      const isPackageFirstForClient = isPackage ? (s.package_id ? firstPackages.has(s.package_id) : isFirstSession) : false;
      const rateIsFirstSession = isPackage ? isPackageFirstForClient : isFirstSession;
      const sessionSequence = rateIsFirstSession ? 'first' : 'followup';
      const sessionSequenceLabel = rateIsFirstSession ? 'First' : 'Follow-up';
      
      // Determine if this session should be included
      let shouldInclude = false;
      
      if (status === 'pending') {
        // For pending: payment date in range, not completed, not cancelled/refunded
        const isCancelledOrRefunded = s.status === 'cancelled' || s.status === 'refunded';
        if (!isCompleted && !isCancelledOrRefunded && isInDateRange(s.created_at)) {
          shouldInclude = true;
        }
      } else if (status === 'completed') {
        // Completed payouts must be both in-range and actually marked paid. Range is keyed on
        // the SESSION date (when the work happened), matching the pending side — keying it on
        // completion_date made a session drift into a different month purely because the
        // therapist marked it complete late.
        const payoutDate = s.scheduled_date || s.original_scheduled_date || s.completion_date;
        const payoutStatus = String(historyRecord?.payment_status || '').toLowerCase();
        if (isCompleted && payoutStatus === 'paid' && payoutDate && isInDateRange(payoutDate)) {
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
      
      {
        // Use shared utility — consistent per-session split for packages everywhere
        const dc = commissionRecordsMap[s.psychologist_id] || null;
        const ch = historyRecord || null;
        toDoctorWallet = computeSessionDoctorWallet(s, dc, ch, { isFirstSession: rateIsFirstSession });
        commissionToCompany = Math.max(0, sessionPrice - toDoctorWallet);
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
        client_name: payoutClientNameMap[s.client_id] || '—',
        // The View Details modal renders these two columns; without them it showed "—".
        client_email: payoutClientEmailMap[s.client_id] || null,
        booked_at: getSessionBookingCreatedAtIso(s) || s.created_at || null,
        session_type: sessionType,
        session_sequence: sessionSequence,
        session_sequence_label: sessionSequenceLabel,
        is_first_session: isFirstSession,
        is_package_first_for_client: isPackageFirstForClient,
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
        wix_booking_id,
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
        package_id,
        payment_verified,
        payment_verified_at
      `, { count: 'exact' })
      .neq('session_type', 'free_assessment'); // Exclude free assessments

    if (!shouldIncludeUnpaid) {
      // Include paid sessions OR manual/plan-credit sessions (price > 0, no payment_id)
      // Plan-credit Wix sessions (inPerson vendor) have no payment_id but are real paid sessions.
      // Also include ₹0 package follow-ups (they belong to a paid package) so a package's later
      // sessions show alongside its paid first session — matching the Wix Discovery page.
      query = query.or('payment_id.not.is.null,source.eq.admin_manual,price.gt.0,package_group_id.not.is.null');
    }

    // Apply date filter. Match the admin Wix Discovery page: a session belongs to a month if
    // it was either SCHEDULED in that month OR BOOKED in that month (OR-union). So a
    // July-booked / August-scheduled session shows under BOTH July AND August — otherwise the
    // 'booked' basis hides August-scheduled bookings from the August view (they were booked in
    // July), leaving the current month nearly empty. Applied whenever a full range is given.
    if (dateFrom && dateTo) {
      query = query.or(
        `and(scheduled_date.gte.${dateFrom},scheduled_date.lte.${dateTo}),` +
        `and(${bookingTimeCol}.gte.${dateFrom}${IST_DAY_START_SUFFIX},${bookingTimeCol}.lte.${dateTo}${IST_DAY_END_SUFFIX})`
      );
    } else if (dateFrom) {
      if (normalizedDateBasis === 'booked') query = query.gte(bookingTimeCol, `${dateFrom}${IST_DAY_START_SUFFIX}`);
      else query = query.gte('scheduled_date', dateFrom);
    } else if (dateTo) {
      if (normalizedDateBasis === 'booked') query = query.lte(bookingTimeCol, `${dateTo}${IST_DAY_END_SUFFIX}`);
      else query = query.lte('scheduled_date', dateTo);
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

    // Upgrade bare therapist-only wix_payload stubs to the full Wix payload from the
    // wix_bookings mirror — otherwise Wix rows (which have null client_id/psychologist_id)
    // have no client name/email/therapist to display. Mirrors the admin Wix Discovery page.
    if (sessionsData.length) {
      await hydrateSessionsWixPayloadFromMirror(supabaseAdmin, sessionsData);
    }

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
    
    // Also build a receipt_url map for manual booking image previews in the approval popup
    const paymentReceiptMap = {};
    if (paymentIds.length > 0) {
      const { data: payments, error: paymentError } = await supabaseAdmin
        .from('payments')
        .select('id, status, receipt_url')
        .in('id', paymentIds)
        .in('status', ['paid', 'success', 'completed', 'cash']); // Only successful payments

      if (!paymentError && payments) {
        successfulPaymentIds = payments.map(p => p.id);
        payments.forEach(p => { if (p.receipt_url) paymentReceiptMap[p.id] = p.receipt_url; });
      }
    }

    // A Wix booking counts as PAID via its wix_payload (paymentState COMPLETE/PAID, or a
    // real positive price) even when it has no row in the `payments` table — Wix payments
    // live in wix_payload, not `payments`. Without this, Wix sessions (the bulk of a month,
    // e.g. August) silently vanish from the finance list even though they show on the admin
    // Wix Discovery page. Mirrors that page's "real paid booking" rule.
    const isPaidWixRow = (s) => {
      if (!s.wix_booking_id && String(s.source || '').toLowerCase() !== 'wix') return false;
      const p = s.wix_payload || {};
      const state = String(p.paymentState || p.paymentDetails?.state || '').toUpperCase();
      if (state === 'COMPLETE' || state === 'PAID') return true;
      if (Number(s.price) > 0) return true;                       // real-priced Wix booking
      // ₹0 package follow-up belonging to a (paid) package
      if (s.package_group_id || s.package_id || Number(s.session_count) > 1) return true;
      return false;
    };

    const sessionsForResponse = shouldIncludeUnpaid
      ? sessionsData
      : sessionsData.filter(s => (s.payment_id && successfulPaymentIds.includes(s.payment_id)) || isPaidWixRow(s));

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

    // Chunk these `.in()` lookups in batches of 100. A single `.in()` with hundreds of
    // UUIDs overflows the PostgREST GET URL and the whole request fails ("fetch failed"),
    // which silently dropped ALL client/therapist names for FK-based rows.
    for (let i = 0; i < psychologistIds.length; i += 100) {
      const { data: psychData } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name')
        .in('id', psychologistIds.slice(i, i + 100));
      if (psychData) psychologists.push(...psychData);
    }

    for (let i = 0; i < clientIds.length; i += 100) {
      const { data: clientData } = await supabaseAdmin
        .from('clients')
        .select('id, first_name, last_name, child_name, email, phone_number')
        .in('id', clientIds.slice(i, i + 100));
      if (clientData) clients.push(...clientData);
    }

    // Wix rows have null client_id/psychologist_id — their client & therapist live in the
    // wix_bookings mirror's flat columns (exactly what the admin Wix Discovery page reads).
    // Batch-fetch them so finance rows show the same name/email/phone/therapist.
    const wixBookingIds = [...new Set(sessionsData.map(s => s?.wix_booking_id).filter(Boolean))];
    const wixMirrorMap = {};
    for (let i = 0; i < wixBookingIds.length; i += 100) {
      const { data: wbRows } = await supabaseAdmin
        .from('wix_bookings')
        .select('wix_booking_id, client_full_name, client_first_name, client_last_name, client_email, client_phone, therapist_name')
        .in('wix_booking_id', wixBookingIds.slice(i, i + 100));
      (wbRows || []).forEach(r => { wixMirrorMap[r.wix_booking_id] = r; });
    }

    const sessionsWithCommission = sessionsForResponse.map(session => {
      if (!session) return null;
      const commission = commissions.find(c => c.session_id === session.id);
      const psychologist = psychologists.find(p => p.id === session.psychologist_id);
      const client = clients.find(c => c.id === session.client_id);
      
      const mirror = session.wix_booking_id ? wixMirrorMap[session.wix_booking_id] : null;

      // Client: FK client → Wix mirror flat columns → (wix_payload via enrich below).
      let clientObj = client ? {
        id: client.id,
        first_name: client.first_name,
        last_name: client.last_name,
        child_name: client.child_name,
        phone_number: client.phone_number || null,
        email: client.email || null,
        // Frontend reads client.user.email (mirrors the admin/Wix pages) — nest it too.
        user: client.email ? { email: client.email } : undefined,
      } : null;
      if (!clientObj && mirror && (mirror.client_full_name || mirror.client_first_name || mirror.client_email)) {
        clientObj = {
          id: null,
          first_name: mirror.client_first_name || mirror.client_full_name || null,
          last_name: mirror.client_last_name || null,
          child_name: null,
          phone_number: mirror.client_phone || null,
          email: mirror.client_email || null,
          user: mirror.client_email ? { email: mirror.client_email } : undefined,
        };
      }

      // Therapist: FK psychologist → Wix mirror therapist_name.
      let psychObj = psychologist ? {
        id: psychologist.id,
        first_name: psychologist.first_name,
        last_name: psychologist.last_name,
      } : null;
      if (!psychObj && mirror?.therapist_name) {
        const parts = String(mirror.therapist_name).trim().split(/\s+/);
        psychObj = { id: null, first_name: parts[0] || mirror.therapist_name, last_name: parts.slice(1).join(' ') || null };
      }

      const built = {
        ...session,
        booking_created_at: getSessionBookingCreatedAtIso(session),
        // Map backend fields to frontend expected fields
        session_date: session.scheduled_date,
        amount: session.price,
        session_type: session.session_type || 'Individual', // Default to Individual if not set
        psychologist: psychObj,
        client: clientObj,
        commission_amount: commission?.commission_amount || 0,
        company_revenue: commission?.company_revenue || 0,
        net_company_revenue: commission?.net_company_revenue || 0,
        commission_payment_status: commission?.payment_status || null,
        source: session.source || 'platform',
        wix_order_number: session.wix_order_number,
        package_session_number: session.package_session_number,
        session_count: session.session_count,
        package_id: session.package_id,
        // Payment proof image for manual booking approval popup
        receipt_url: session.payment_id ? (paymentReceiptMap[session.payment_id] || null) : null,
      };
      // For Wix rows the FK client/psychologist are null — fill name/email/therapist/price
      // from wix_payload so the finance list shows the same detail as the Wix Discovery page.
      enrichSessionRowDisplayFields(built);
      return built;
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
/**
 * Full financial profile for ONE therapist.
 * GET /api/finance/doctors/:psychologistId/profile?dateFrom=&dateTo=&dateBasis=
 *
 * Returns every session with its money broken out (session amount, doctor commission,
 * company commission) plus payout status, and a summary. Uses computeSessionDoctorWallet —
 * the same source of truth the rest of finance uses — so the numbers reconcile.
 */
const buildDoctorFinanceProfilePayload = async (psychologistId, { dateFrom, dateTo, dateBasis = 'scheduled' } = {}) => {
    if (!psychologistId) {
      const err = new Error('psychologistId is required');
      err.statusCode = 400;
      throw err;
    }

    const { data: doctor, error: docErr } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email, phone, area_of_expertise, designation, created_at')
      .eq('id', psychologistId)
      .maybeSingle();
    if (docErr || !doctor) {
      const err = new Error('Therapist not found');
      err.statusCode = 404;
      throw err;
    }

    // Commission rates live in their own table (one active row per therapist).
    const { data: dcRows } = await supabaseAdmin
      .from('doctor_commissions')
      .select(FINANCE_DOCTOR_COMMISSION_SELECT)
      .eq('psychologist_id', psychologistId)
      .order('created_at', { ascending: false });
    const activeDc = (dcRows || []).find((r) => r.is_active !== false) || (dcRows || [])[0] || null;

    let q = supabaseAdmin
      .from('sessions')
      .select('id, scheduled_date, scheduled_time, status, session_type, session_count, package_id, package_group_id, package_session_number, price, amount, therapist_commission, client_id, source, wix_order_number, payment_id, completion_date, created_at, booking_created_at, wix_payload')
      .eq('psychologist_id', psychologistId)
      .neq('session_type', 'free_assessment');

    const normalizedDateBasis = String(dateBasis || '').toLowerCase();
    const dateCol = normalizedDateBasis === 'booked'
      ? 'booking_created_at'
      : (normalizedDateBasis === 'completed' || normalizedDateBasis === 'completion'
        ? 'completion_date'
        : 'scheduled_date');
    if (dateFrom && dateTo) {
      if (dateCol === 'scheduled_date') q = q.gte('scheduled_date', dateFrom).lte('scheduled_date', dateTo);
      else if (dateCol === 'completion_date') q = q.gte('completion_date', dateFrom).lte('completion_date', dateTo);
      else q = q.gte('booking_created_at', `${dateFrom}T00:00:00+05:30`).lte('booking_created_at', `${dateTo}T23:59:59.999+05:30`);
    }

    const { data: sessions, error: sErr } = await q.order('scheduled_date', { ascending: false });
    if (sErr) {
      const err = new Error('Failed to fetch sessions');
      err.statusCode = 500;
      throw err;
    }
    if (sessions?.length) {
      await hydrateSessionsWixPayloadFromMirror(supabaseAdmin, sessions);
    }

    // Client names/emails. Keep this flat and fast: embedded user joins are noticeably
    // slower on large profile/payout popups, so fetch user emails only for clients that need it.
    const clientIds = [...new Set((sessions || []).map((s) => s.client_id).filter(Boolean))];
    const clientById = new Map();
    for (let i = 0; i < clientIds.length; i += 100) {
      const { data: cs } = await supabaseAdmin
        .from('clients')
        .select('id, first_name, last_name, user_id, email')
        .in('id', clientIds.slice(i, i + 100));
      (cs || []).forEach((c) => clientById.set(c.id, c));
    }
    const userIdsForEmail = [...new Set(
      [...clientById.values()]
        .filter((c) => !c.email && c.user_id)
        .map((c) => c.user_id)
    )];
    const userEmailById = new Map();
    for (let i = 0; i < userIdsForEmail.length; i += 100) {
      const { data: users } = await supabaseAdmin
        .from('users')
        .select('id, email')
        .in('id', userIdsForEmail.slice(i, i + 100));
      (users || []).forEach((u) => userEmailById.set(u.id, u.email));
    }

    // Determine first-vs-follow-up using the same client-history idea used elsewhere in finance.
    // This is exposed so receipt auto-fill can show separate first/follow-up rows instead of guessing.
    const clientFirstSessions = new Set();
    const historyBySessionId = new Map();
    if (clientIds.length) {
      const historyRows = [];
      for (let i = 0; i < clientIds.length; i += 100) {
        const { data: hist } = await supabaseAdmin
          .from('sessions')
          .select('id, client_id, created_at, scheduled_date, status, session_type, package_id')
          .in('client_id', clientIds.slice(i, i + 100))
          .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
          .neq('session_type', 'free_assessment');
        historyRows.push(...(hist || []));
      }
      historyRows.forEach((s) => historyBySessionId.set(s.id, s));

      const sessionsByClient = {};
      historyRows.forEach((s) => {
        if (!s.client_id) return;
        if (!sessionsByClient[s.client_id]) sessionsByClient[s.client_id] = [];
        sessionsByClient[s.client_id].push(s);
      });

      Object.values(sessionsByClient).forEach((clientSessions) => {
        const sorted = clientSessions.sort((a, b) => {
          const dateA = new Date(a.created_at || a.scheduled_date || 0);
          const dateB = new Date(b.created_at || b.scheduled_date || 0);
          return dateA - dateB;
        });
        if (sorted[0]?.id) clientFirstSessions.add(sorted[0].id);
      });

      const preExistingIds = await getPreExistingClientIds(Object.keys(sessionsByClient));
      if (preExistingIds.size) {
        Object.entries(sessionsByClient).forEach(([clientId, clientSessions]) => {
          if (!preExistingIds.has(clientId)) return;
          clientSessions.forEach((s) => clientFirstSessions.delete(s.id));
        });
      }
    }

    const firstPackages = new Set();
    [...clientFirstSessions].forEach((sessionId) => {
      const firstSession = historyBySessionId.get(sessionId);
      if (firstSession?.package_id) firstPackages.add(firstSession.package_id);
    });

    // Settled commission rows (authoritative for paid/pending)
    const sessionIds = (sessions || []).map((s) => s.id);
    const chBySession = new Map();
    for (let i = 0; i < sessionIds.length; i += 100) {
      const { data: chs } = await supabaseAdmin
        .from('commission_history')
        .select('session_id, commission_amount, session_amount, payment_status, created_at')
        .in('session_id', sessionIds.slice(i, i + 100));
      (chs || []).forEach((r) => chBySession.set(r.session_id, r));
    }

    const paymentIds = [...new Set((sessions || []).map((s) => s.payment_id).filter(Boolean))];
    const paymentById = new Map();
    for (let i = 0; i < paymentIds.length; i += 100) {
      const chunk = paymentIds.slice(i, i + 100);
      let { data: pays, error: pErr } = await supabaseAdmin
        .from('payments')
        .select('id, status, receipt_url, razorpay_params')
        .in('id', chunk);

      if (pErr && String(pErr.message || '').includes("Could not find the 'razorpay_params' column")) {
        ({ data: pays, error: pErr } = await supabaseAdmin
          .from('payments')
          .select('id, status, receipt_url')
          .in('id', chunk));
      }

      if (!pErr) {
        (pays || []).forEach((p) => paymentById.set(p.id, p));
      }
    }

    const dc = activeDc;
    const TERMINAL_UNPAID = ['cancelled', 'refunded', 'deleted'];
    const NOT_DUE_PAYOUT_STATUSES = new Set(['booked', 'pending', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow']);

    // A package is paid on its first session, but the therapist earns on every session of it.
    // So the company's real profit on a package = package price − the therapist's commission
    // for the WHOLE package. Attribute that net figure to the paying session and show ₹0 on the
    // follow-ups (rather than a negative). Sibling sessions are pulled regardless of the date
    // filter, so a package split across months still nets correctly.
    const groupIds = [...new Set((sessions || []).map((s) => s.package_group_id).filter(Boolean))];
    const groupDoctorTotal = new Map();
    if (groupIds.length) {
      const siblings = [];
      for (let i = 0; i < groupIds.length; i += 100) {
        const { data: sib } = await supabaseAdmin
          .from('sessions')
          .select('id, status, session_type, session_count, package_id, package_group_id, package_session_number, price, amount, therapist_commission, wix_payload')
          .eq('psychologist_id', psychologistId)
          .in('package_group_id', groupIds.slice(i, i + 100));
        siblings.push(...(sib || []));
      }
      if (siblings.length) {
        await hydrateSessionsWixPayloadFromMirror(supabaseAdmin, siblings);
      }
      for (const sib of siblings) {
        if (TERMINAL_UNPAID.includes(String(sib.status || '').toLowerCase())) continue;
        const sibIsPackage = !!sib.package_id ||
          (parseInt(sib.session_count, 10) || 1) > 1 ||
          String(sib.session_type || '').toLowerCase().includes('package');
        const sibIsFirst = sibIsPackage
          ? (sib.package_id ? firstPackages.has(sib.package_id) : clientFirstSessions.has(sib.id))
          : clientFirstSessions.has(sib.id);
        const d = computeSessionDoctorWallet(sib, dc, chBySession.get(sib.id) || null, { isFirstSession: sibIsFirst }) || 0;
        groupDoctorTotal.set(sib.package_group_id, (groupDoctorTotal.get(sib.package_group_id) || 0) + d);
      }
    }

    const rows = (sessions || []).map((s) => {
      const ch = chBySession.get(s.id) || null;
      const status = String(s.status || '').toLowerCase();
      const counts = !TERMINAL_UNPAID.includes(status);
      const isPackage = !!s.package_id || (parseInt(s.session_count, 10) || 1) > 1 || String(s.session_type || '').toLowerCase().includes('package');
      const isCouple = isCoupleSessionLike(s);
      const isFirstSession = clientFirstSessions.has(s.id);
      const isPackageFirstForClient = isPackage ? (s.package_id ? firstPackages.has(s.package_id) : isFirstSession) : false;
      const rateIsFirstSession = isPackage ? isPackageFirstForClient : isFirstSession;
      const sessionSequence = rateIsFirstSession ? 'first' : 'followup';
      const sessionSequenceLabel = rateIsFirstSession ? 'First' : 'Follow-up';
      const sessionAmount = parseFloat(s.price ?? s.amount ?? 0) || 0;
      // Doctor's share for this session (handles package splitting internally)
      const doctorAmount = counts ? (computeSessionDoctorWallet(s, dc, ch, { isFirstSession: rateIsFirstSession }) || 0) : 0;
      // Company share. For a package, the paying session carries the WHOLE package's profit
      // (price − therapist's commission across all its sessions) and follow-ups show ₹0 — so
      // the first row reads as "what the company earned on this package" and no row goes
      // negative. Non-package sessions are simply price − doctor.
      let companyAmount = 0;
      if (counts && sessionAmount > 0) {
        // Only a session that actually collected money carries company profit. If it belongs to
        // a package, deduct the therapist's commission for the WHOLE package so this one row
        // shows the true profit on that package.
        companyAmount = sessionAmount - (s.package_group_id
          ? (groupDoctorTotal.get(s.package_group_id) ?? doctorAmount)
          : doctorAmount);
      }
      // A ₹0 session (package credit / follow-up) shows ₹0 — never a negative. Its therapist
      // cost is already netted against whichever session was paid.
      const c = clientById.get(s.client_id);
      const isCompleted = status === 'completed';
      const payment = s.payment_id ? paymentById.get(s.payment_id) : null;
      const paymentParams = typeof payment?.razorpay_params === 'string'
        ? (() => { try { return JSON.parse(payment.razorpay_params); } catch { return null; } })()
        : payment?.razorpay_params;
      const isAdminPayment = String(s.source || '').toLowerCase().includes('admin') ||
        !!payment?.receipt_url ||
        !!paymentParams?.notes?.admin_created ||
        !!paymentParams?.notes?.manual;
      const paymentSource = isAdminPayment ? 'admin' : (s.source || 'razorpay');
      return {
        session_id: s.id,
        order_id: s.wix_order_number || s.payment_id || null,
        session_date: s.scheduled_date,
        session_time: s.scheduled_time,
        booked_at: s.booking_created_at || s.created_at,
        completion_date: s.completion_date,
        client_name: c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—' : '—',
        client_email: c?.email || userEmailById.get(c?.user_id) || null,
        client_id: s.client_id,
        session_type: s.session_type,
        package_label: Number(s.session_count) > 1 && s.package_session_number
          ? `${isCouple ? 'Couple ' : ''}Package ${s.package_session_number}/${s.session_count}`
          : (s.session_type || '—'),
        status: s.status,
        source: paymentSource,
        raw_source: s.source || null,
        payment_proof_url: payment?.receipt_url || null,
        is_first_session: isFirstSession,
        is_package: isPackage,
        is_couple: isCouple,
        is_package_first_for_client: isPackageFirstForClient,
        session_sequence: sessionSequence,
        session_sequence_label: sessionSequenceLabel,
        package_session_number: s.package_session_number || null,
        session_count: s.session_count || null,
        session_amount: sessionAmount,
        doctor_amount: doctorAmount,
        company_amount: companyAmount,
        // Payout: settled rows carry payment_status; otherwise a completed session is
        // payable-but-pending, and anything not yet completed isn't earned yet.
        payout_status: ch?.payment_status
          ? String(ch.payment_status).toLowerCase()
          : (isCompleted ? 'pending' : (counts && NOT_DUE_PAYOUT_STATUSES.has(status) ? 'not_due' : 'void')),
        settled: !!ch,
      };
    });

    const sum = (arr, k) => arr.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const completed = rows.filter((r) => String(r.status).toLowerCase() === 'completed');
    const paidRows = rows.filter((r) => r.payout_status === 'paid');
    const pendingRows = rows.filter((r) => r.payout_status === 'pending');
    const upcoming = rows.filter((r) => r.payout_status === 'not_due');

    return {
      doctor: {
        id: doctor.id,
        name: `${doctor.first_name || ''} ${doctor.last_name || ''}`.trim(),
        email: doctor.email,
        phone: doctor.phone,
        area_of_expertise: doctor.area_of_expertise,
        joined_at: doctor.created_at,
      },
      summary: {
        total_sessions: rows.length,
        completed_sessions: completed.length,
        upcoming_sessions: upcoming.length,
        cancelled_sessions: rows.filter((r) => r.payout_status === 'void').length,
        gross_revenue: sum(rows, 'session_amount'),
        doctor_earnings: sum(rows, 'doctor_amount'),
        company_earnings: sum(rows, 'company_amount'),
        payout_paid: sum(paidRows, 'doctor_amount'),
        payout_pending: sum(pendingRows, 'doctor_amount'),
        payout_not_due: sum(upcoming, 'doctor_amount'),
      },
      sessions: rows,
      filters: { dateFrom: dateFrom || null, dateTo: dateTo || null, dateBasis },
    };
};

const getDoctorFinanceProfile = async (req, res) => {
  try {
    const { psychologistId } = req.params;
    const { dateFrom, dateTo, dateBasis = 'scheduled' } = req.query;
    const payload = await buildDoctorFinanceProfilePayload(psychologistId, { dateFrom, dateTo, dateBasis });
    return res.json(successResponse(payload, 'Doctor finance profile fetched'));
  } catch (error) {
    console.error('getDoctorFinanceProfile error:', error);
    return res
      .status(error.statusCode || 500)
      .json(errorResponse(error.statusCode ? error.message : 'Internal server error while building doctor profile'));
  }
};

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
      .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded']);

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
        psychologist:psychologists!sessions_psychologist_id_fkey(*),
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          child_age,
          phone_number,
          email,
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
        .select(FINANCE_PAYMENT_SELECT)
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
        .select(FINANCE_RECEIPT_SELECT)
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

    // Extract Razorpay / payment gateway info from wix_payload for Wix sessions
    const wixPayDetails = session.wix_payload?.paymentDetails || null;
    const wixVendorDetails = wixPayDetails?.wixPayMultipleDetails?.[0] || null;
    const wixPaymentInfo = wixVendorDetails ? {
      vendor: wixVendorDetails.paymentVendorName || null,           // e.g. "Razorpay"
      razorpay_order_id: wixVendorDetails.orderId || null,          // Razorpay order ID from Wix
      wix_transaction_id: wixVendorDetails.txId || null,            // Wix transaction ID
      order_status: wixVendorDetails.orderStatus || null,           // e.g. "COMPLETE"
      amount: wixVendorDetails.orderAmount || null,
      approved_at: wixVendorDetails.orderApprovalTime || null,
    } : null;

    // Get commission data
    const { data: commission } = await supabaseAdmin
      .from('commission_history')
      .select('id, session_id, psychologist_id, payment_id, session_amount, commission_amount, payment_status, created_at, updated_at')
      .eq('session_id', sessionId)
      .single();

    // Determine first vs follow-up by checking if client has any earlier session
    let isFirstSession = false;
    if (session.client_id) {
      const { data: earlierSessions } = await supabaseAdmin
        .from('sessions')
        .select('id, created_at')
        .eq('client_id', session.client_id)
        .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
        .lt('created_at', session.created_at)
        .limit(1);
      isFirstSession = !earlierSessions?.length;

      // Pre-existing (imported) clients don't get the first-session rate even
      // though this may be their first session in our system — they're past clients.
      if (isFirstSession) {
        const preExistingIds = await getPreExistingClientIds([session.client_id]);
        if (preExistingIds.has(session.client_id)) isFirstSession = false;
      }
    }

    const sessionAmount = parseFloat(
      commission?.session_amount ??
      paymentDetails?.amount ??
      session.price ??
      0
    ) || 0;

    // Fetch psychologist commission settings from doctor_commissions table
    let commissionSettings = null;
    if (session.psychologist_id) {
      const { data: commSettingsRows } = await supabaseAdmin
        .from('doctor_commissions')
        .select('commission_amounts, commission_amount_individual, commission_amount_package, doctor_commission_first_session, doctor_commission_followup, doctor_commission_individual, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages')
        .eq('psychologist_id', session.psychologist_id)
        .eq('is_active', true)
        .order('effective_from', { ascending: false })
        .limit(1);
      commissionSettings = commSettingsRows?.[0] || null;
    }

    // Helper: derive company commission from doctor_commissions settings
    const deriveDefaultCommission = (cs, sessionType, amount, firstSession) => {
      if (!cs || amount <= 0) return null;
      const type = String(sessionType || '').toLowerCase();
      const isCouple = type.includes('couple') || type.includes('cpl');
      const isPackage = type.includes('package');
      const dp = cs.doctor_commission_packages || {};

      let doctorAmount = 0;

      if (isCouple) {
        doctorAmount = parseFloat(dp.couple_session ?? dp.cpl_session ?? cs.doctor_commission_individual ?? 0) || 0;
      } else if (isPackage) {
        doctorAmount = parseFloat(dp.package_followup ?? cs.doctor_commission_followup_package ?? cs.doctor_commission_followup ?? 0) || 0;
        // If the package doctor rate exceeds the session price (e.g. per-session Wix package priced
        // individually), fall back to the per-session individual followup rate to avoid company = 0.
        if (doctorAmount >= amount) {
          const fallback = parseFloat(cs.doctor_commission_followup ?? cs.doctor_commission_individual ?? 0) || 0;
          if (fallback < amount) doctorAmount = fallback;
          else doctorAmount = 0; // last resort: company keeps all
        }
      } else {
        // Individual: use first vs followup rate correctly
        if (firstSession && cs.doctor_commission_first_session != null) {
          doctorAmount = parseFloat(cs.doctor_commission_first_session) || 0;
        } else if (!firstSession && cs.doctor_commission_followup != null) {
          doctorAmount = parseFloat(cs.doctor_commission_followup) || 0;
        } else if (cs.doctor_commission_individual != null) {
          doctorAmount = parseFloat(cs.doctor_commission_individual) || 0;
        } else if (cs.commission_amounts?.individual != null) {
          const companyFixed = parseFloat(cs.commission_amounts.individual) || 0;
          doctorAmount = Math.max(0, amount - companyFixed);
        } else if (cs.commission_amount_individual != null) {
          const companyFixed = parseFloat(cs.commission_amount_individual) || 0;
          doctorAmount = Math.max(0, amount - companyFixed);
        }
      }

      return Math.max(0, amount - Math.min(doctorAmount, amount));
    };

    let companyCommission;
    let commissionSource;

    if (commission?.commission_amount != null) {
      companyCommission = parseFloat(commission.commission_amount) || 0;
      commissionSource = 'commission_history';
    } else if (session.therapist_commission != null && parseFloat(session.therapist_commission) > 0) {
      // therapist_commission stores doctor wallet amount (only use if explicitly set to non-zero)
      const tc = parseFloat(session.therapist_commission) || 0;
      companyCommission = Math.max(0, sessionAmount - tc);
      commissionSource = 'session';
    } else {
      // Derive from psychologist commission settings
      const derived = deriveDefaultCommission(commissionSettings, session.session_type, sessionAmount, isFirstSession);
      companyCommission = derived;
      commissionSource = derived != null ? 'calculated' : 'unavailable';
    }

    const doctorWallet = companyCommission != null
      ? Math.max(0, sessionAmount - companyCommission)
      : null;

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
        source: session.source || null,
        wix_booking_id: session.wix_booking_id || null,
        wix_order_number: session.wix_order_number || null,
        wix_payload: session.wix_payload || null,
        scheduled_date: session.scheduled_date,
        scheduled_time: session.scheduled_time,
        session_date: session.scheduled_date,   // legacy alias
        session_time: session.scheduled_time,   // legacy alias
        status: session.status,
        session_type: session.session_type,
        price: session.price,
        package_id: session.package_id,
        package_session_number: session.package_session_number ?? null,
        session_count: session.session_count ?? null,
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
          child_age: session.client.child_age,
          phone_number: session.client.phone_number,
          email: session.client.email || session.client.user?.email || null,
        } : null,
        payment: paymentDetails,
        wix_payment: wixPaymentInfo,
        receipt: receiptDetails,
        is_first_session: isFirstSession,
        commission: commission || null,
        commission_split: {
          session_amount: sessionAmount,
          company_commission: companyCommission,
          doctor_wallet: doctorWallet,
          is_first_session: isFirstSession,
          commission_payment_status: commission?.payment_status || null,
          source: commissionSource,
        }
      }
    }, 'Session details fetched successfully'));

  } catch (error) {
    console.error('Get session details error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching session details')
    );
  }
};

const getPsychologistOptions = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    }

    const { data, error } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email')
      .order('first_name', { ascending: true });

    if (error) throw error;

    res.json(successResponse({ psychologists: data || [] }, 'Psychologists fetched successfully'));
  } catch (error) {
    console.error('Get finance psychologist options error:', error);
    res.status(500).json(errorResponse('Internal server error while fetching psychologists'));
  }
};

const getSalaryEmployees = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    }

    const { data, error } = await supabaseAdmin
      .from('finance_salary_employees')
      .select('id, employee_id, name, email, designation, location, is_active')
      .eq('is_active', true)
      .order('employee_id', { ascending: true });

    if (error) {
      if (String(error.message || '').includes('finance_salary_employees')) {
        return res.json(successResponse({
          employees: DEFAULT_SALARY_EMPLOYEES.map(mapSalaryEmployeeForApi),
          source: 'fallback',
        }, 'Salary employees fetched from fallback seed'));
      }
      throw error;
    }

    res.json(successResponse({
      employees: (data || []).map(mapSalaryEmployeeForApi),
      source: 'database',
    }, 'Salary employees fetched successfully'));
  } catch (error) {
    console.error('Get salary employees error:', error);
    res.status(500).json(errorResponse('Internal server error while fetching salary employees'));
  }
};

const upsertSalaryEmployee = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    }

    const employeeId = String(req.body?.employeeId || req.body?.employee_id || '').trim();
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    const designation = String(req.body?.designation || '').trim();
    const location = String(req.body?.location || 'Calicut, India').trim() || 'Calicut, India';

    if (!employeeId || !name) {
      return res.status(400).json(errorResponse('Employee ID and name are required.'));
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json(errorResponse('Valid employee email is required.'));
    }

    const { data, error } = await supabaseAdmin
      .from('finance_salary_employees')
      .upsert({
        employee_id: employeeId,
        name,
        email: email || null,
        designation: designation || null,
        location,
        is_active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'employee_id' })
      .select('id, employee_id, name, email, designation, location, is_active')
      .single();

    if (error) throw error;

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_SALARY_EMPLOYEE_SAVED',
      resource: 'finance_salary_employees',
      resourceId: data?.id,
      endpoint: '/api/finance/settings/salary-employees',
      method: 'POST',
      details: { employee_id: employeeId, name, email: email || null },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }).catch(err => console.error('Audit log error:', err));

    res.json(successResponse({ employee: mapSalaryEmployeeForApi(data) }, 'Salary employee saved successfully'));
  } catch (error) {
    console.error('Upsert salary employee error:', error);
    res.status(500).json(errorResponse('Internal server error while saving salary employee'));
  }
};

const sendReceiptEmail = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    }

    const {
      to,
      recipientName,
      template,
      receiptNo,
      fileName,
      pdfBase64,
      message,
    } = req.body || {};

    const email = String(to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json(errorResponse('Valid recipient email is required.'));
    }
    if (!['payoutReceipt', 'salaryCertificate'].includes(template)) {
      return res.status(400).json(errorResponse('Only the 2026 payout receipt and salary certificate templates are supported.'));
    }

    const cleanBase64 = String(pdfBase64 || '').replace(/^data:application\/pdf;base64,/, '');
    if (!cleanBase64) {
      return res.status(400).json(errorResponse('PDF attachment is required.'));
    }

    const pdfBuffer = Buffer.from(cleanBase64, 'base64');
    if (!pdfBuffer.length || pdfBuffer.length > 8 * 1024 * 1024) {
      return res.status(400).json(errorResponse('PDF attachment is empty or too large.'));
    }

    const receiptLabel = template === 'salaryCertificate' ? 'Salary Certificate' : 'Payout Receipt';
    const safeReceiptNo = String(receiptNo || '').trim() || 'Draft';
    const safeRecipientName = String(recipientName || '').trim() || 'Doctor';
    const attachmentName = sanitizeReceiptFileName(fileName || `koott-${receiptLabel}-${safeReceiptNo}.pdf`);

    const emailService = require('../utils/emailService');
    await emailService.sendCustomEmail({
      to: email,
      subject: `Koott ${receiptLabel} - ${safeReceiptNo}`,
      text: [
        `Dear ${safeRecipientName},`,
        '',
        `Please find attached your Koott ${receiptLabel.toLowerCase()} (${safeReceiptNo}).`,
        message ? `\n${message}` : '',
        '',
        'Warm regards,',
        'Team Koott',
      ].join('\n'),
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
          <div style="border-bottom: 3px solid #025545; padding: 18px 0;">
            <h2 style="margin: 0; color: #025545;">Koott ${escapeHtml(receiptLabel)}</h2>
          </div>
          <div style="padding: 22px 0;">
            <p>Dear <strong>${escapeHtml(safeRecipientName)}</strong>,</p>
            <p>Please find attached your Koott ${escapeHtml(receiptLabel.toLowerCase())}.</p>
            <p style="background: #f0fdf4; border-left: 4px solid #025545; padding: 12px 14px;">
              <strong>Receipt No:</strong> ${escapeHtml(safeReceiptNo)}
            </p>
            ${message ? `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : ''}
            <p>Warm regards,<br><strong>Team Koott</strong></p>
          </div>
        </div>
      `,
      attachments: [{
        filename: attachmentName,
        content: pdfBuffer,
        contentType: 'application/pdf',
        contentDisposition: 'attachment',
      }],
    });

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'FINANCE_RECEIPT_EMAIL_SENT',
      resource: 'finance_receipts',
      details: { to: email, template, receiptNo: safeReceiptNo, fileName: attachmentName },
      endpoint: '/api/finance/receipts/send-email',
      method: 'POST',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }).catch(() => {});

    res.json(successResponse({ sent: true, to: email }, 'Receipt email sent successfully'));
  } catch (error) {
    console.error('Send finance receipt email error:', error);
    res.status(500).json(errorResponse('Internal server error while sending receipt email'));
  }
};

const getClientOptions = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    }

    const { data, error } = await supabaseAdmin
      .from('clients')
      .select(`
        id,
        user_id,
        first_name,
        last_name,
        phone_number,
        user:users(email)
      `)
      .order('first_name', { ascending: true });

    if (error) throw error;

    const clients = (data || []).map((client) => ({
      ...client,
      email: Array.isArray(client.user) ? client.user?.[0]?.email || null : client.user?.email || null,
      display_name: `${client.first_name || ''} ${client.last_name || ''}`.trim() || (Array.isArray(client.user) ? client.user?.[0]?.email : client.user?.email) || 'Unknown',
    }));

    res.json(successResponse({ clients }, 'Clients fetched successfully'));
  } catch (error) {
    console.error('Get finance client options error:', error);
    res.status(500).json(errorResponse('Internal server error while fetching clients'));
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
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name)
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
      .select(FINANCE_EXPENSE_SELECT, { count: 'exact' })
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
        .select(FINANCE_EXPENSE_LEGACY_SELECT, { count: 'exact' })
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
          .select('id, amount, subscription_id')
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
      .select(FINANCE_EXPENSE_SELECT)
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
      .select(FINANCE_EXPENSE_SELECT)
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
      .select(FINANCE_EXPENSE_SELECT)
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
      .select(FINANCE_EXPENSE_SELECT)
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
        .select(FINANCE_EXPENSE_SELECT)
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
      .select('id')
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
    const listOnly = String(req.query.listOnly ?? 'false').toLowerCase() === 'true';
    const doctorDateBasis = parseFinanceDoctorDateBasis(req.query);

    const commissionBookingTimeCol = await getBookingTimeColumnKey(supabaseAdmin);
    const commSessionsBcf = appendBookingTimeSelectFragment(commissionBookingTimeCol);

    // Get ALL psychologists (not just those with sessions)
    // Filter out assessment specialist
    const assessmentEmail = (process.env.FREE_ASSESSMENT_PSYCHOLOGIST_EMAIL || 'assessment.koott@gmail.com').toLowerCase();
    
    let psychologists = [];
    try {
      let query = supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, email, phone, experience_years, cover_image_url, profile_picture_url, individual_session_price, created_at, updated_at')
        // Include psychologists even when email is null/empty.
        // Exclude only the configured assessment specialist email.
        .or(`email.is.null,email.neq.${assessmentEmail}`)
        .order('first_name', { ascending: true });

      if (psychologistId) {
        query = query.eq('id', psychologistId);
      }

      let { data: psychData, error: psychError } = await query;

      if (psychError && String(psychError.message || '').includes('individual_session_price')) {
        query = supabaseAdmin
          .from('psychologists')
          .select('id, first_name, last_name, email, phone, experience_years, cover_image_url, profile_picture_url, created_at, updated_at')
          .or(`email.is.null,email.neq.${assessmentEmail}`)
          .order('first_name', { ascending: true });

        if (psychologistId) {
          query = query.eq('id', psychologistId);
        }

        ({ data: psychData, error: psychError } = await query);
      }
      
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

    // Get commission rates for all psychologists
    let commissions = [];
    if (allPsychologistIds.length > 0) {
      try {
        let commissionData = null;
        let error = null;

        // Preferred path (newer schema with is_active)
        ({ data: commissionData, error } = await supabaseAdmin
          .from('doctor_commissions')
          .select(FINANCE_DOCTOR_COMMISSION_SELECT)
          .eq('is_active', true)
          .in('psychologist_id', allPsychologistIds)
          .order('effective_from', { ascending: false }));

        // Backward-compatible fallback (older schema without is_active column)
        const errMsg = String(error?.message || '');
        if (error && (errMsg.includes('is_active') || errMsg.includes('effective_from'))) {
          console.warn('doctor_commissions schema mismatch; falling back to basic latest-record query');
          ({ data: commissionData, error } = await supabaseAdmin
            .from('doctor_commissions')
            .select(FINANCE_DOCTOR_COMMISSION_SELECT)
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

    // Build commissions map before any fast return; list-only pages still need edit config.
    const commissionsMap = {};
    commissions?.forEach(c => {
      if (c.psychologist_id) {
        commissionsMap[c.psychologist_id] = c;
      }
    });

    if (listOnly) {
      const fastCommissions = (psychologists || []).map((psych) => {
        const commission = commissionsMap[psych.id];
        const commissionAmounts = commissionAmountsMap[psych.id] || {};
        const packages = packagePricesMap[psych.id] || [];
        const individualSessionPrice =
          parseFloat(psych.individual_session_price ?? individualPriceMap[psych.id] ?? 0) || 0;
        const packageCommissions = packages.map(pkg => ({
          ...pkg,
          commission_amount: parseFloat(commissionAmounts[pkg.type] || commissionAmounts.package || 0)
        }));
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
          return {
            ...pkg,
            doctor_commission_first_session:
              (doctorCommissionPackages[firstKey] !== null && doctorCommissionPackages[firstKey] !== undefined)
                ? parseFloat(doctorCommissionPackages[firstKey]) || 0
                : (
                  (commissionRecord.doctor_commission_first_session_package !== null && commissionRecord.doctor_commission_first_session_package !== undefined)
                    ? parseFloat(commissionRecord.doctor_commission_first_session_package) || 0
                    : defaultDoctorForPkg
                ),
            doctor_commission_followup:
              (doctorCommissionPackages[followupKey] !== null && doctorCommissionPackages[followupKey] !== undefined)
                ? parseFloat(doctorCommissionPackages[followupKey]) || 0
                : (
                  (commissionRecord.doctor_commission_followup_package !== null && commissionRecord.doctor_commission_followup_package !== undefined)
                    ? parseFloat(commissionRecord.doctor_commission_followup_package) || 0
                    : defaultDoctorForPkg
                )
          };
        });

        return {
          psychologist_id: psych.id,
          is_fast_list: true,
          commission_amounts: commissionAmounts,
          commission_amount_individual: commissionAmounts.individual || 0,
          commission_amount_package: commissionAmounts.package || 0,
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
          doctor_commission_packages: doctorCommissionPackages,
          package_commissions: effectivePackageCommissions,
          total_sessions: null,
          total_sessions_finance: null,
          pending_sessions: null,
          upcoming_sessions: null,
          completed_sessions: null,
          cancelled_sessions: null,
          total_revenue: null,
          gross_revenue: null,
          total_commission_to_company: null,
          company_earnings: null,
          total_to_doctor_wallet: null,
          doctor_earnings: null,
          pending_payout: null,
          payout_pending: null,
          completed_payout: null,
          payout_paid: null,
          not_due_payout: null,
          payout_not_due: null,
          monthly_breakdown: [],
          individual_session_price: individualSessionPrice,
          package_prices: packages,
          average_individual_price: null,
          average_package_price: null,
          psychologist: {
            id: psych.id,
            first_name: psych.first_name,
            last_name: psych.last_name,
            email: psych.email,
            experience_years: psych.experience_years,
            cover_image_url: psych.cover_image_url
          }
        };
      });

      await auditLogger.logAction({
        userId: req.user.id,
        userEmail: req.user.email,
        userRole,
        action: 'FINANCE_COMMISSIONS_VIEWED',
        resource: 'commissions',
        endpoint: '/api/finance/commissions',
        method: 'GET',
        details: { filters: req.query, listOnly: true },
        ip: req.ip,
        userAgent: req.headers['user-agent']
      }).catch(err => console.error('Audit log error:', err));

      return res.json(successResponse({
        commissions: fastCommissions,
        filters: {
          dateBasis: doctorDateBasis,
          ...(dateFrom && dateTo ? { dateFrom, dateTo } : {}),
          listOnly: true,
        },
      }, 'Doctors listed successfully'));
    }

    // ─── SINGLE QUERY: all fields use scheduled_date ──────────────────────────
    // Total Sessions = all sessions scheduled this month
    // Completed      = sessions scheduled this month that are completed
    // Pending        = sessions scheduled this month that are still pending
    // Company Commission + Payouts = all from the same scheduled-this-month set
    // This ensures: Completed + Pending = Total (always consistent)
    // ─────────────────────────────────────────────────────────────────────────

    const sessionSelectFields = `id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, status, created_at, completion_date, ${commSessionsBcf} wix_payload, source, package_session_number, session_count`;

    // Derive view-month IST date boundaries
    let viewMonthStart = null;
    let viewMonthEnd = null;
    if (dateFrom && dateTo) {
      viewMonthStart = dateFrom;
      viewMonthEnd = dateTo;
    } else if (month && year) {
      viewMonthStart = `${year}-${String(month).padStart(2, '0')}-01`;
      viewMonthEnd   = `${year}-${String(month).padStart(2, '0')}-31`;
    }

    // Single query: sessions scheduled within the view month
    let allSessionsQuery = supabaseAdmin
      .from('sessions')
      .select(sessionSelectFields)
      .not('psychologist_id', 'is', null)
      .neq('session_type', 'free_assessment')
      .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow']);

    if (viewMonthStart && viewMonthEnd) {
      allSessionsQuery = allSessionsQuery
        .gte('scheduled_date', viewMonthStart)
        .lte('scheduled_date', viewMonthEnd);
    } else if (month && year) {
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate   = `${year}-${String(month).padStart(2, '0')}-31`;
      allSessionsQuery = allSessionsQuery
        .gte('scheduled_date', startDate)
        .lte('scheduled_date', endDate);
    }

    const { data: allSessions } = await allSessionsQuery;

    // No separate completed/pending queries needed — all come from allSessions
    const completedThisMonth = [];
    const pendingThisMonth = [];
    
    // Get commission history for sessions across ALL three queries
    const allSessionIds = new Set([
      ...(allSessions?.map(s => s.id).filter(Boolean) || []),
      ...(completedThisMonth?.map(s => s.id).filter(Boolean) || []),
      ...(pendingThisMonth?.map(s => s.id).filter(Boolean) || []),
    ]);
    const sessionIds = Array.from(allSessionIds);
    let commissionHistory = [];
    if (sessionIds.length > 0) {
      const { data: history } = await supabaseAdmin
        .from('commission_history')
        .select('psychologist_id, commission_amount, company_revenue, session_id, session_date, session_amount')
        .in('session_id', sessionIds);
      commissionHistory = history || [];
    }

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

      // Pre-existing (imported) clients don't get the first-session rate even
      // though this is their first session in our system — they're past clients.
      const preExistingIds = await getPreExistingClientIds(Object.keys(sessionsByClient));
      if (preExistingIds.size) {
        Object.entries(sessionsByClient).forEach(([clientId, clientSessions]) => {
          if (!preExistingIds.has(clientId)) return;
          clientSessions.forEach(s => clientFirstSessions.delete(s.id));
        });
      }
    }

    const firstPackages = new Set();
    (allSessions || []).forEach(s => {
      if (s.package_id && clientFirstSessions.has(s.id)) {
        firstPackages.add(s.package_id);
      }
    });

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
        
        if (isPackage) {
          // Package session - commission is split evenly across all sessions in the package.
          const pkg = s.package_id ? packagePricesMap[s.psychologist_id]?.find(p => p.id === s.package_id) : null;
          let packageType = pkg?.type || (s.package_id ? packageTypeMap[s.package_id] : null);
          const resolvedSessionCount = Math.max(1, parseInt(s.session_count, 10) || 1);
          const packageTypeFromCount = `package_${resolvedSessionCount}`;
          if (!packageType || packageType === 'package') {
            packageType = packageTypeFromCount;
          }

          // Get package-specific doctor commissions from JSONB field
          const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
          let totalDoctorPackageCommission = 0;

          // Use firstPackages (not isFirstSession) so all sessions in the same package
          // share the same first/followup designation.
          const isPackageFirstForClient = s.package_id ? firstPackages.has(s.package_id) : isFirstSession;

          if (isPackageFirstForClient) {
            const packageFirstSessionKey = `${packageType}_first_session`;
            if (hasConfiguredMoneyValue(doctorCommissionPackages, packageFirstSessionKey)) {
              totalDoctorPackageCommission = toMoneyNumber(doctorCommissionPackages[packageFirstSessionKey]);
              hasExplicitDoctorCommission = true;
            } else if (hasConfiguredMoneyValue(commissionRecord, 'doctor_commission_first_session_package')) {
              totalDoctorPackageCommission = toMoneyNumber(commissionRecord.doctor_commission_first_session_package);
              hasExplicitDoctorCommission = true;
            }
          } else {
            const packageFollowupKey = `${packageType}_followup`;
            if (hasConfiguredMoneyValue(doctorCommissionPackages, packageFollowupKey)) {
              totalDoctorPackageCommission = toMoneyNumber(doctorCommissionPackages[packageFollowupKey]);
              hasExplicitDoctorCommission = true;
            } else if (hasConfiguredMoneyValue(commissionRecord, 'doctor_commission_followup_package')) {
              totalDoctorPackageCommission = toMoneyNumber(commissionRecord.doctor_commission_followup_package);
              hasExplicitDoctorCommission = true;
            }
          }
          
          // Use the actual session_count as the divisor. Falling back to a generic
          // package type here can make a 9-session package calculate as package_3.
          const divisor = resolvedSessionCount;

          // Split doctor commission evenly across all sessions in the package.
          // Follow-up sessions have price=0 but still earn their share.
          toDoctorWallet = Math.round(totalDoctorPackageCommission / divisor);

          // Company commission: use the configured total package commission and split it.
          // Do NOT derive from sessionPrice — follow-up sessions have price=0 which would
          // give a negative result. commissionAmounts[packageType] is the total company
          // cut for the whole package (e.g. commissionAmounts.package_3 = ₹1500).
          const totalCompanyPackageCommission = toMoneyNumber(
            commissionAmounts?.[packageType] ||
            commissionAmounts?.[packageTypeFromCount] ||
            commissionAmounts?.package ||
            0
          );
          commissionToCompany = Math.round(totalCompanyPackageCommission / divisor);
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

      // Cancelled/refunded sessions don't contribute to any payout bucket
      const isCancelledOrRefunded = s.status === 'cancelled' || s.status === 'refunded';

      // All fields use scheduled_date (single query) so bucket directly here:
      // total_revenue + company commission from every session scheduled this month
      statsByPsych[s.psychologist_id].total_revenue += sessionPrice;
      statsByPsych[s.psychologist_id].total_commission_to_company += commissionToCompany;
      statsByPsych[s.psychologist_id].total_to_doctor_wallet += toDoctorWallet;

      // Completed = scheduled this month AND already done
      // Pending   = scheduled this month AND still outstanding
      if (isCompleted && !isCancelledOrRefunded) {
        statsByPsych[s.psychologist_id].completed_sessions += 1;
        statsByPsych[s.psychologist_id].completed_payout += toDoctorWallet;
      } else if (!isCompleted && !isCancelledOrRefunded) {
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
    const commissionsWithTotals = (psychologists || []).map((psych) => {
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

      const unifiedTotalSessions = stats.total_sessions;
      const unifiedCompletedSessions = stats.completed_sessions;
      const unifiedUpcomingSessions = stats.pending_sessions;
      const unifiedGrossRevenue = stats.total_revenue;
      const unifiedDoctorEarnings = stats.total_to_doctor_wallet;
      const unifiedCompanyEarnings = stats.total_commission_to_company;
      const unifiedPendingPayout = stats.completed_payout;
      const unifiedPaidPayout = 0;
      const unifiedNotDuePayout = stats.pending_payout;

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
        total_sessions: unifiedTotalSessions,
        total_sessions_finance: unifiedTotalSessions,
        pending_sessions: unifiedUpcomingSessions,
        upcoming_sessions: unifiedUpcomingSessions,
        completed_sessions: unifiedCompletedSessions,
        cancelled_sessions: 0,
        wix_bookings_count: 0,
        latest_wix_booking_at: null,
        total_revenue: unifiedGrossRevenue,
        gross_revenue: unifiedGrossRevenue,
        total_commission_to_company: unifiedCompanyEarnings,
        company_earnings: unifiedCompanyEarnings,
        total_to_doctor_wallet: unifiedDoctorEarnings,
        doctor_earnings: unifiedDoctorEarnings,
        pending_payout: unifiedPendingPayout,
        payout_pending: unifiedPendingPayout,
        completed_payout: unifiedPaidPayout,
        payout_paid: unifiedPaidPayout,
        not_due_payout: unifiedNotDuePayout,
        payout_not_due: unifiedNotDuePayout,
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
    });

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
        .select(FINANCE_DOCTOR_COMMISSION_SELECT)
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
          .select(FINANCE_DOCTOR_COMMISSION_SELECT)
          .single();

        // Legacy schema fallback: if JSONB column is missing, retry without it.
        if (result.error && String(result.error.message || '').includes('commission_amounts')) {
          const retryData = { ...updateData };
          delete retryData.commission_amounts;
          result = await supabaseAdmin
            .from('doctor_commissions')
            .update(retryData)
            .eq('id', existingRecord.id)
            .select(FINANCE_DOCTOR_COMMISSION_SELECT)
            .single();
        }
        
        newCommission = result.data;
        error = result.error;
      } else {
        // No changes, return existing record
        const { data } = await supabaseAdmin
          .from('doctor_commissions')
          .select(FINANCE_DOCTOR_COMMISSION_SELECT)
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
        .select(FINANCE_DOCTOR_COMMISSION_SELECT)
        .single();

      // Legacy schema fallback: if JSONB column is missing, retry without it.
      if (result.error && String(result.error.message || '').includes('commission_amounts')) {
        const retryData = { ...commissionData };
        delete retryData.commission_amounts;
        result = await supabaseAdmin
          .from('doctor_commissions')
          .insert([retryData])
          .select(FINANCE_DOCTOR_COMMISSION_SELECT)
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
 * Returns doctors with payable completed sessions and visible not-yet-due sessions, grouped by month
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
    const includeDetails = String(req.query.includeDetails ?? 'true').toLowerCase() !== 'false';
    const listOnly = String(req.query.listOnly ?? 'false').toLowerCase() === 'true';
    // Optional single-doctor scope. The Mark-as-Paid dialog and View Details only ever need
    // ONE therapist, but this endpoint computed the whole roster (~2.8s) to render one row.
    // Scoping the session scans to that psychologist cuts the work proportionally.
    const onlyPsychologistId = req.query.psychologistId || req.query.psychologist_id || null;
    
    // Default to current month if not specified
    const today = new Date();
    const targetMonth = month ? parseInt(month) : today.getMonth() + 1;
    const targetYear = year ? parseInt(year) : today.getFullYear();
    
    const monthStr = targetMonth < 10 ? `0${targetMonth}` : String(targetMonth);
    const monthStart = `${targetYear}-${monthStr}-01`;
    // Date.UTC, not local: new Date(y, m, 0) builds midnight LOCAL, and toISOString() then
    // shifts it back a day in IST (+05:30) — so 31 Jul became '2026-07-30' and the month's
    // final day was silently dropped from every payout window.
    const monthEnd = new Date(Date.UTC(targetYear, targetMonth, 0)).toISOString().split('T')[0]; // Last day of month

    const getConfiguredPackageDoctorShare = (session, packageMeta, cfg, isFirstSession) => {
      const resolvedSessionCount = Math.max(
        1,
        parseInt(session.session_count || packageMeta?.session_count, 10) || 1
      );
      const packageType = getFinancePackageType(session, packageMeta);
      const fallbackPackageType = packageMeta?.package_type || `package_${resolvedSessionCount}`;
      const packageNumber = parseInt(session.package_session_number, 10) || 1;
      const doctorPackages =
        cfg?.doctor_commission_packages && typeof cfg.doctor_commission_packages === 'object'
          ? cfg.doctor_commission_packages
          : {};
      const firstKey = `${packageType}_first_session`;
      const followupKey = `${packageType}_followup`;
      const fallbackFirstKey = `${fallbackPackageType}_first_session`;
      const fallbackFollowupKey = `${fallbackPackageType}_followup`;
      const firstTotal = (
            doctorPackages[firstKey] ??
            doctorPackages[fallbackFirstKey] ??
            cfg?.doctor_commission_first_session_package ??
            doctorPackages[followupKey] ??
            doctorPackages[fallbackFollowupKey] ??
            cfg?.doctor_commission_followup_package ??
            0
          );
      const followupTotal = (
            doctorPackages[followupKey] ??
            doctorPackages[fallbackFollowupKey] ??
            cfg?.doctor_commission_followup_package ??
            doctorPackages[firstKey] ??
            doctorPackages[fallbackFirstKey] ??
            cfg?.doctor_commission_first_session_package ??
            0
          );
      const configuredTotal = isFirstSession === true
        ? firstTotal
        : (isFirstSession === false ? followupTotal : (packageNumber <= 1 ? firstTotal : followupTotal));

      return Math.max(0, (parseFloat(configuredTotal) || 0) / resolvedSessionCount);
    };

    const getConfiguredCoupleDoctorShare = (cfg) => {
      const doctorPackages =
        cfg?.doctor_commission_packages && typeof cfg.doctor_commission_packages === 'object'
          ? cfg.doctor_commission_packages
          : {};
      return Math.max(
        0,
        parseFloat(
          doctorPackages.couple_session ??
          doctorPackages.cpl_session ??
          cfg?.doctor_commission_individual ??
          0
        ) || 0
      );
    };

    // Pending payouts should follow the recorded completion date so they match
    // the doctor breakdown and completed payout reconciliation.
    // listOnly deliberately omits the psychologist embed: PostgREST resolves that join for
    // EVERY session row (~1000/month), which measured 502ms / 357KB versus 61ms / 58KB
    // without it. The ~24 distinct doctors are fetched once below and attached in memory.
    const completedSessionSelect = listOnly
      ? `
        id,
        psychologist_id,
        session_type,
        status,
        completion_date
      `
      : `
        id,
        psychologist_id,
        client_id,
        session_type,
        wix_booking_id,
        package_id,
        package_session_number,
        scheduled_date,
        completion_date,
        created_at,
        updated_at,
        status,
        payment_id,
        price,
        session_count,
        wix_payload,
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone, cover_image_url)
      `;
    const completedSessionFallbackSelect = listOnly
      ? `
        id,
        psychologist_id,
        session_type,
        status,
        completion_date
      `
      : `
        id,
        psychologist_id,
        client_id,
        session_type,
        wix_booking_id,
        package_id,
        package_session_number,
        scheduled_date,
        completion_date,
        created_at,
        updated_at,
        status,
        payment_id,
        price,
        session_count,
        wix_payload,
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone)
      `;
    const completedScheduledFallbackSelect = listOnly
      ? `
        id,
        psychologist_id,
        session_type,
        status,
        scheduled_date,
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone)
      `
      : `
        id,
        psychologist_id,
        client_id,
        session_type,
        wix_booking_id,
        package_id,
        package_session_number,
        scheduled_date,
        created_at,
        status,
        payment_id,
        price,
        session_count,
        wix_payload,
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone)
      `;
    const notDueSessionSelect = listOnly
      ? `
        id,
        psychologist_id,
        session_type,
        status,
        scheduled_date
      `
      : completedSessionSelect;
    const notDueSessionFallbackSelect = listOnly
      ? `
        id,
        psychologist_id,
        session_type,
        status,
        scheduled_date
      `
      : completedSessionFallbackSelect;

    let completedSessions = null;
    let sessionsError = null;

    // Paginate: PostgREST caps a plain select at 1000 rows. July alone has 1041 completed
    // sessions, so the unpaginated scan silently dropped 41 of them — every doctor's payout
    // total was under-reported, and the shortfall moved around as data changed.
    const fetchAllPages = async (buildQuery) => {
      const out = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await buildQuery().range(offset, offset + 999);
        if (error) return { data: out, error };
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      return { data: out, error: null };
    };

    // Window by scheduled_date — the month the session actually HAPPENED. completion_date
    // only records when someone clicked "complete", so a 24 Jul session marked complete on
    // 2 Aug was pushed into August's payout and July under-paid. scheduled_date is also
    // always set, unlike completion_date (NULL on 49 of July's completed sessions).
    const buildCompletedScan = () => {
      let q = supabaseAdmin
        .from('sessions')
        .select(completedSessionSelect)
        .eq('status', 'completed')
        .gte('scheduled_date', monthStart)
        .lte('scheduled_date', monthEnd)
        .not('psychologist_id', 'is', null)
        .neq('session_type', 'free_assessment')
        .order('scheduled_date', { ascending: true });
      if (onlyPsychologistId) q = q.eq('psychologist_id', onlyPsychologistId);
      return q;
    };
    ({ data: completedSessions, error: sessionsError } = await fetchAllPages(buildCompletedScan));

    if (sessionsError && String(sessionsError.message || '').includes('cover_image_url')) {
      ({ data: completedSessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(completedScheduledFallbackSelect)
        .eq('status', 'completed')
        .gte('scheduled_date', monthStart)
        .lte('scheduled_date', monthEnd)
        .not('psychologist_id', 'is', null)
        .neq('session_type', 'free_assessment'));
    }

    // Older schemas may miss completion_date; fallback to scheduled_date month filter.
    if (sessionsError && String(sessionsError.message || '').includes('completion_date')) {
      ({ data: completedSessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(completedSessionFallbackSelect)
        .eq('status', 'completed')
        .gte('scheduled_date', monthStart)
        .lte('scheduled_date', monthEnd)
        .not('psychologist_id', 'is', null)
        .neq('session_type', 'free_assessment'));
    }

    if (sessionsError) throw sessionsError;

    // Payout eligibility is based on completion status, not payment row availability.
    const completedSessionsWithPayments = completedSessions || [];
    if (!listOnly && completedSessionsWithPayments.length) {
      await hydrateSessionsWixPayloadFromMirror(supabaseAdmin, completedSessionsWithPayments);
    }

    let notDueSessions = null;
    let notDueError = null;
    const buildNotDueScan = () => {
      let q = supabaseAdmin
        .from('sessions')
        .select(notDueSessionSelect)
        .in('status', Array.from(PENDING_SESSION_CARD_STATUSES))
        .gte('scheduled_date', monthStart)
        .lte('scheduled_date', monthEnd)
        .not('psychologist_id', 'is', null)
        .neq('session_type', 'free_assessment')
        .order('scheduled_date', { ascending: true });
      if (onlyPsychologistId) q = q.eq('psychologist_id', onlyPsychologistId);
      return q;
    };
    ({ data: notDueSessions, error: notDueError } = await fetchAllPages(buildNotDueScan));

    if (notDueError && String(notDueError.message || '').includes('cover_image_url')) {
      ({ data: notDueSessions, error: notDueError } = await supabaseAdmin
        .from('sessions')
        .select(notDueSessionFallbackSelect)
        .in('status', Array.from(PENDING_SESSION_CARD_STATUSES))
        .gte('scheduled_date', monthStart)
        .lte('scheduled_date', monthEnd)
        .not('psychologist_id', 'is', null)
        .neq('session_type', 'free_assessment'));
    }

    if (notDueError) throw notDueError;

    const visibleNotDueSessions = notDueSessions || [];
    if (!listOnly && visibleNotDueSessions.length) {
      await hydrateSessionsWixPayloadFromMirror(supabaseAdmin, visibleNotDueSessions);
    }

    if (sessionsError) throw sessionsError;
    
    // Get commission_history for these completed sessions
    // Include NOT-DUE sessions too. A booked session whose time has passed shows as "pending"
    // in the UI and can be edited there, but its commission_history row was never loaded here
    // (this list covered completed sessions only) — so the saved edit was invisible on read
    // and the amount recomputed from config, i.e. the edit appeared to revert.
    const sessionIds = [...new Set([
      ...completedSessionsWithPayments.map(s => s.id),
      ...(notDueSessions || []).map(s => s.id),
    ])].filter(Boolean);
    let commissionHistory = null;
    let commissionError = null;
    commissionHistory = [];
    // Run the id-chunks CONCURRENTLY. A month can hold 1000+ sessions = 10+ chunks, and
    // awaiting them one after another stacked ~10 network round-trips onto every page load.
    const historyChunks = [];
    for (let i = 0; i < sessionIds.length; i += 100) historyChunks.push(sessionIds.slice(i, i + 100));
    const historySelect = listOnly
      ? 'session_id, payment_status'
      : 'session_id, psychologist_id, session_amount, commission_amount, payment_status, notes';
    const historyResults = await Promise.all(historyChunks.map((chunk) =>
      supabaseAdmin.from('commission_history').select(historySelect).in('session_id', chunk)
    ));
    for (const res of historyResults) {
      if (res.error) { commissionError = res.error; break; }
      commissionHistory.push(...(res.data || []));
    }

    // Legacy-schema fallback (older DBs lack session_amount): retry sequentially, rare path.
    if (commissionError && String(commissionError.message || '').includes('session_amount')) {
      commissionError = null;
      commissionHistory = [];
      for (const chunk of historyChunks) {
        const { data, error } = await supabaseAdmin
          .from('commission_history')
          .select('session_id, psychologist_id, commission_amount, payment_status')
          .in('session_id', chunk);
        if (error) { commissionError = error; break; }
        commissionHistory.push(...(data || []));
      }
    }


    if (commissionError) {
      console.error('Error fetching commission history:', commissionError);
    }

    // Check if there are any payouts for any psychologists in this month
    // If a payout exists for a psychologist, all sessions for that psychologist in that month should be excluded
    const psychologistIds = [...new Set(
      [...completedSessionsWithPayments, ...visibleNotDueSessions]
        .map(s => s.psychologist_id)
        .filter(Boolean)
    )];
    
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
        .filter(ch => ch.payment_status === 'paid')
        .map(ch => ch.session_id)
    );

    // Exclude only the sessions that were ACTUALLY paid (payment_status = 'paid').
    //
    // This used to also drop every session of any psychologist holding a paid payout for the
    // month (`paidPsychologistIds`). That hid genuinely unpaid work: after marking a doctor
    // paid, sessions that were NOT part of that payout — e.g. ones completed later in the
    // month, or with a null completion_date — disappeared from Pending entirely and could
    // never be paid. It also leaked across months, because a payout_date of 3 Aug for the
    // JULY payout matched August too, blanking the doctor's August pending list.
    // markPayoutAsPaid writes/updates a commission_history row to 'paid' for every session it
    // settles, so the per-session check is the accurate one.
    const unpaidSessions = completedSessionsWithPayments.filter(s => !paidSessionIds.has(s.id));

    const unpaidNotDueSessions = visibleNotDueSessions.filter(s => !paidSessionIds.has(s.id));
    
    console.log(`📊 Found ${unpaidSessions.length} unpaid completed sessions and ${unpaidNotDueSessions.length} not-yet-due sessions for ${targetMonth}/${targetYear}`);

    if ((!unpaidSessions || unpaidSessions.length === 0) && (!unpaidNotDueSessions || unpaidNotDueSessions.length === 0)) {
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
      }, 'No payout sessions found for the selected month'));
    }

    if (listOnly) {
      // The selects above skipped the per-row psychologist embed for speed, so resolve the
      // handful of distinct doctors in ONE query and attach them in memory.
      const listPsychIds = [...new Set(
        [...(completedSessions || []), ...(notDueSessions || [])].map((s2) => s2.psychologist_id).filter(Boolean)
      )];
      const listPsychMap = {};
      for (let i = 0; i < listPsychIds.length; i += 100) {
        const { data: pRows } = await supabaseAdmin
          .from('psychologists')
          .select('id, first_name, last_name, email, phone, cover_image_url')
          .in('id', listPsychIds.slice(i, i + 100));
        (pRows || []).forEach((row) => { listPsychMap[row.id] = row; });
      }
      [...(completedSessions || []), ...(notDueSessions || [])].forEach((s2) => {
        if (!s2.psychologist) s2.psychologist = listPsychMap[s2.psychologist_id] || null;
      });

      const payoutsByDoctor = {};
      const ensurePayout = (session, state) => {
        const psychId = session.psychologist_id;
        if (!payoutsByDoctor[psychId]) {
          payoutsByDoctor[psychId] = {
            id: psychId,
            psychologist_id: psychId,
            psychologist: session.psychologist,
            payout_state: state,
            payment_status: state,
            has_payable_sessions: state === 'pending',
            can_mark_paid: state === 'pending',
            total_sessions: null,
            profile_total_sessions: null,
            completed_sessions: null,
            upcoming_sessions: null,
            cancelled_sessions: null,
            session_counts_by_type: {},
            total_doctor_wallet: null,
            pending_payout_amount: null,
            total_company_commission: null,
            profile_company_earnings: null,
            profile_gross_revenue: null,
            profile_doctor_earnings: null,
            profile_payout_paid: null,
            profile_payout_not_due: null,
            not_due_payout: null,
            not_due_company_earnings: null,
            total_commission: null,
            net_payout: null,
            session_details: []
          };
        } else if (state === 'pending') {
          payoutsByDoctor[psychId].payout_state = 'pending';
          payoutsByDoctor[psychId].payment_status = 'pending';
          payoutsByDoctor[psychId].has_payable_sessions = true;
          payoutsByDoctor[psychId].can_mark_paid = true;
        }
      };

      unpaidNotDueSessions.forEach((session) => ensurePayout(session, 'not_due'));
      unpaidSessions.forEach((session) => ensurePayout(session, 'pending'));

      const payouts = Object.values(payoutsByDoctor).sort((a, b) => {
        const aName = `${a.psychologist?.first_name || ''} ${a.psychologist?.last_name || ''}`.trim();
        const bName = `${b.psychologist?.first_name || ''} ${b.psychologist?.last_name || ''}`.trim();
        return aName.localeCompare(bName);
      });

      console.log(`✅ Listed ${payouts.length} payout doctors without finance aggregation`);

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
        payouts,
        month: targetMonth,
        year: targetYear,
        month_name: new Date(targetYear, targetMonth - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      }, 'Pending payout doctors listed successfully'));
    }

    // Client names for the session-level breakdown table (View Details modal).
    const pendingScopeSessions = [...unpaidSessions, ...unpaidNotDueSessions];
    const pendingClientIds = [...new Set(pendingScopeSessions.map(s => s.client_id).filter(Boolean))];
    const pendingClientNameMap = {};
    const pendingClientEmailMap = {};
    if (includeDetails) {
      // clients.email is usually NULL — the address lives on users.email via clients.user_id.
      const userIdByClient = {};
      for (let i = 0; i < pendingClientIds.length; i += 100) {
        const { data: cRows } = await supabaseAdmin
          .from('clients')
          .select('id, first_name, last_name, email, user_id')
          .in('id', pendingClientIds.slice(i, i + 100));
        (cRows || []).forEach((c) => {
          pendingClientNameMap[c.id] = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
          if (c.email) pendingClientEmailMap[c.id] = c.email;
          else if (c.user_id) userIdByClient[c.id] = c.user_id;
        });
      }
      const missingUserIds = [...new Set(Object.values(userIdByClient))];
      const emailByUser = {};
      for (let i = 0; i < missingUserIds.length; i += 100) {
        const { data: uRows } = await supabaseAdmin
          .from('users').select('id, email').in('id', missingUserIds.slice(i, i + 100));
        (uRows || []).forEach((u) => { if (u.email) emailByUser[u.id] = u.email; });
      }
      Object.entries(userIdByClient).forEach(([cid, uid]) => {
        if (emailByUser[uid]) pendingClientEmailMap[cid] = emailByUser[uid];
      });
    }

    const pendingClientFirstSessions = new Set();
    const pendingFirstPackages = new Set();
    if (pendingClientIds.length) {
      const historyRows = [];
      for (let i = 0; i < pendingClientIds.length; i += 100) {
        const { data: hist } = await supabaseAdmin
          .from('sessions')
          .select('id, client_id, created_at, scheduled_date, status, session_type, package_id')
          .in('client_id', pendingClientIds.slice(i, i + 100))
          .in('status', ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
          .neq('session_type', 'free_assessment');
        historyRows.push(...(hist || []));
      }

      const historyBySessionId = new Map();
      const sessionsByClient = {};
      historyRows.forEach((s) => {
        historyBySessionId.set(s.id, s);
        if (!s.client_id) return;
        if (!sessionsByClient[s.client_id]) sessionsByClient[s.client_id] = [];
        sessionsByClient[s.client_id].push(s);
      });

      Object.values(sessionsByClient).forEach((clientSessions) => {
        const sorted = clientSessions.sort((a, b) => {
          const dateA = new Date(a.created_at || a.scheduled_date || 0);
          const dateB = new Date(b.created_at || b.scheduled_date || 0);
          return dateA - dateB;
        });
        if (sorted[0]?.id) pendingClientFirstSessions.add(sorted[0].id);
      });

      const preExistingIds = await getPreExistingClientIds(Object.keys(sessionsByClient));
      if (preExistingIds.size) {
        Object.entries(sessionsByClient).forEach(([clientId, clientSessions]) => {
          if (!preExistingIds.has(clientId)) return;
          clientSessions.forEach((s) => pendingClientFirstSessions.delete(s.id));
        });
      }

      [...pendingClientFirstSessions].forEach((sessionId) => {
        const firstSession = historyBySessionId.get(sessionId);
        if (firstSession?.package_id) pendingFirstPackages.add(firstSession.package_id);
      });
    }

    // Get package types for package sessions
    const packageIds = [...new Set(pendingScopeSessions.map(s => s.package_id).filter(Boolean))];
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
    const pendingPsychIds = [...new Set(pendingScopeSessions.map(s => s.psychologist_id).filter(Boolean))];
    const commissionConfigMap = {};
    if (pendingPsychIds.length > 0) {
      let commissionCfgRows = [];
      let commissionCfgError = null;
      ({ data: commissionCfgRows, error: commissionCfgError } = await supabaseAdmin
        .from('doctor_commissions')
        .select('psychologist_id, commission_amount_individual, commission_amount_package, commission_amounts, doctor_commission_first_session, doctor_commission_followup, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages')
        .eq('is_active', true)
        .in('psychologist_id', pendingPsychIds)
        .order('effective_from', { ascending: false }));

      if (commissionCfgError && String(commissionCfgError.message || '').includes('is_active')) {
        ({ data: commissionCfgRows, error: commissionCfgError } = await supabaseAdmin
          .from('doctor_commissions')
          .select('psychologist_id, commission_amount_individual, commission_amount_package, commission_amounts, doctor_commission_first_session, doctor_commission_followup, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages')
          .in('psychologist_id', pendingPsychIds));
      } else if (commissionCfgError && String(commissionCfgError.message || '').includes('effective_from')) {
        ({ data: commissionCfgRows, error: commissionCfgError } = await supabaseAdmin
          .from('doctor_commissions')
          .select('psychologist_id, commission_amount_individual, commission_amount_package, commission_amounts, doctor_commission_first_session, doctor_commission_followup, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages')
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

    const ensureDoctorPayout = (session) => {
      const psychId = session.psychologist_id;
      if (!payoutsByDoctor[psychId]) {
        payoutsByDoctor[psychId] = {
          psychologist_id: psychId,
          psychologist: session.psychologist,
          total_sessions: 0,
          completed_sessions: 0,
          upcoming_sessions: 0,
          session_counts_by_type: {},
          total_doctor_wallet: 0,
          total_company_commission: 0,
          not_due_doctor_wallet: 0,
          not_due_company_commission: 0,
          sessions: []
        };
      }
      return payoutsByDoctor[psychId];
    };

    const getPendingSessionFinance = (session, commission, rateIsFirstSession, psychId) => {
      const cfg = commissionConfigMap[psychId] || null;
      const isPackageSession =
        !!session.package_id ||
        (parseInt(session.session_count, 10) || 1) > 1 ||
        String(session.session_type || '').toLowerCase().includes('package');
      const packageMeta = isPackageSession ? packagesMap[session.package_id] : null;
      const resolvedSessionCount = Math.max(
        1,
        parseInt(session.session_count || packageMeta?.session_count, 10) || 1
      );
      const packageTypeForMoney = isPackageSession
        ? getFinancePackageType(session, packageMeta)
        : null;

      let sessionAmount = parseFloat(commission?.session_amount ?? session.price ?? 0) || 0;
      let commissionAmount = parseFloat(commission?.commission_amount ?? 0) || 0;
      // A ₹0 package follow-up normally ignores its ledger row (the stored amount is a stale
      // 0 and the per-session share must come from config). But a row edited by hand in the
      // payout UI is authoritative — discarding it made manual edits "save" and then revert
      // to the computed value on the next page load.
      const isManuallyEdited = String(commission?.notes || '').includes(MANUAL_COMMISSION_EDIT_TAG);
      const commissionForWallet =
        isPackageSession && sessionAmount <= 0 && !isManuallyEdited
          ? null
          : (commission || null);
      let doctorWallet = computeSessionDoctorWallet(
        { ...session, session_count: resolvedSessionCount },
        cfg,
        commissionForWallet,
        { isFirstSession: rateIsFirstSession }
      );

      if (isPackageSession && !commission) {
        const packageDoctorShare = getConfiguredPackageDoctorShare(session, packageMeta, cfg, rateIsFirstSession);
        if (packageDoctorShare > 0) {
          doctorWallet = packageDoctorShare;
        }
        if (sessionAmount > 0) {
          commissionAmount = Math.max(0, sessionAmount - doctorWallet);
        }
      }

      if (isPackageSession && sessionAmount <= 0) {
        const amountConfig = cfg?.commission_amounts && typeof cfg.commission_amounts === 'object'
          ? cfg.commission_amounts
          : null;
        const totalCompanyPackageCommission = parseFloat(
          amountConfig?.[packageTypeForMoney] ??
          amountConfig?.[packageMeta?.package_type || `package_${resolvedSessionCount}`] ??
          amountConfig?.package ??
          cfg?.commission_amount_package ??
          0
        ) || 0;
        commissionAmount = totalCompanyPackageCommission / resolvedSessionCount;
        sessionAmount = doctorWallet + commissionAmount;
      } else if (!isPackageSession) {
        const isCoupleSession = String(session.session_type || '').toLowerCase().includes('couple') ||
          String(session.session_type || '').toLowerCase().includes('cpl');
        doctorWallet = sessionAmount > 0
          ? doctorWallet
          : (isCoupleSession
            ? getConfiguredCoupleDoctorShare(cfg)
            : computeSessionDoctorWallet(session, cfg, commission || null));
        commissionAmount = sessionAmount > 0
          ? commissionAmount
          : Math.max(0, sessionAmount - doctorWallet);
      }

      return { sessionAmount, doctorWallet, commissionAmount };
    };

    const getSessionTypeMeta = (session) => {
      let sessionTypeForCount = 'individual';
      const sessionCountForType = parseInt(session.session_count, 10) || 1;
      if (session.package_id || sessionCountForType > 1 || String(session.session_type || '').toLowerCase().includes('package')) {
        const pkg = packagesMap[session.package_id];
        sessionTypeForCount = getFinancePackageType(session, pkg);
      }
      const packageSessionNumber = parseInt(session.package_session_number, 10) || null;
      const sessionTypeLabel = sessionTypeForCount.startsWith('couple_package_')
          ? `Couple Package ${packageSessionNumber ? `${packageSessionNumber}/${sessionCountForType}` : String(sessionTypeForCount).replace('couple_package_', '')}`
        : sessionTypeForCount.startsWith('package_')
          ? `Package ${packageSessionNumber ? `${packageSessionNumber}/${sessionCountForType}` : String(sessionTypeForCount).replace('package_', '')}`
        : (sessionTypeForCount === 'package_unknown'
          ? `Package${packageSessionNumber ? ` (${packageSessionNumber}/${sessionCountForType || '?'})` : ''}`
          : (isCoupleSessionLike(session)
            ? 'Couple'
            : 'Individual'));

      return { sessionTypeForCount, sessionTypeLabel, packageSessionNumber, sessionCountForType };
    };
    
    // Use for...of loop instead of forEach to support await
    for (const session of unpaidSessions) {
      const psychId = session.psychologist_id;
      let commission = commissionMap[session.id];
      const isPackageForRate =
        !!session.package_id ||
        (parseInt(session.session_count, 10) || 1) > 1 ||
        String(session.session_type || '').toLowerCase().includes('package');
      const isClientFirstSession = pendingClientFirstSessions.has(session.id);
      const isPackageFirstForClient = isPackageForRate
        ? (session.package_id ? pendingFirstPackages.has(session.package_id) : isClientFirstSession)
        : false;
      // A hand-set First/Follow-up (stored as |SEQ:… on the ledger row) wins over the
      // derived value, so the label matches what finance chose in the payout UI.
      const seqTag = /\|SEQ:(first|followup)/.exec(String(commissionMap[session.id]?.notes || ''));
      const rateIsFirstSession = seqTag
        ? seqTag[1] === 'first'
        : (isPackageForRate ? isPackageFirstForClient : isClientFirstSession);
      const sessionSequence = rateIsFirstSession ? 'first' : 'followup';
      const sessionSequenceLabel = rateIsFirstSession ? 'First' : 'Follow-up';
      
      // Fallback (legacy rows without commission_history)
      if (!commission && sessionPriceMap[session.id] !== undefined) {
        const sessionAmount = sessionPriceMap[session.id];
        const cfg = commissionConfigMap[psychId] || {};
        const isPackage = isPackageForRate;

        // Derive divisor for package sessions
        const packageType = session.session_count ? `package_${session.session_count}` : 'package';
        const countMatch = String(packageType).match(/\d+/);
        const sessionCount = countMatch ? parseInt(countMatch[0], 10) : 3;
        const divisor = sessionCount > 0 ? sessionCount : 3;

        // If exact first/follow-up cannot be determined for individual fallback, prefer first-session commission.
        let doctorCommission = 0;
        if (isPackage) {
          doctorCommission = getConfiguredPackageDoctorShare(session, packagesMap[session.package_id], cfg, rateIsFirstSession);
        } else {
          doctorCommission = rateIsFirstSession
            ? (parseFloat(cfg.doctor_commission_first_session || cfg.doctor_commission_followup || 0) || 0)
            : (parseFloat(cfg.doctor_commission_followup || cfg.doctor_commission_first_session || 0) || 0);
        }

        if (!doctorCommission || doctorCommission <= 0) {
          const amountConfig = cfg.commission_amounts && typeof cfg.commission_amounts === 'object' ? cfg.commission_amounts : null;
          const companyCommissionFallbackTotal = isPackage
            ? parseFloat(amountConfig?.[packageType] ?? amountConfig?.package ?? cfg.commission_amount_package ?? 0) || 0
            : parseFloat(amountConfig?.individual ?? cfg.commission_amount_individual ?? 0) || 0;
          const companyCommissionFallback = isPackage ? Math.round(companyCommissionFallbackTotal / divisor) : companyCommissionFallbackTotal;
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

      const doctorPayout = ensureDoctorPayout(session);

      // Determine session type for counting
      const {
        sessionTypeForCount,
        sessionTypeLabel,
        packageSessionNumber,
        sessionCountForType
      } = getSessionTypeMeta(session);

      // Update counts
      doctorPayout.total_sessions += 1;
      doctorPayout.completed_sessions += 1;
      if (!doctorPayout.session_counts_by_type[sessionTypeForCount]) {
        doctorPayout.session_counts_by_type[sessionTypeForCount] = 0;
      }
      doctorPayout.session_counts_by_type[sessionTypeForCount] += 1;

      // Calculate per-session financial split.
      // Package follow-up rows often have price/session_amount = 0 in the DB, but
      // payout math must still show their allocated share of the package totals.
      const { sessionAmount, doctorWallet, commissionAmount } = getPendingSessionFinance(session, commission, rateIsFirstSession, psychId);

      doctorPayout.total_doctor_wallet += doctorWallet;
      doctorPayout.total_company_commission += commissionAmount;

      // Store session details
      if (includeDetails) {
        doctorPayout.sessions.push({
          session_id: session.id,
          session_date: session.scheduled_date,
          client_name: pendingClientNameMap[session.client_id] || '—',
          client_email: pendingClientEmailMap[session.client_id] || null,
          booked_at: getSessionBookingCreatedAtIso(session) || session.created_at || null,
          session_type: sessionTypeForCount,
          session_type_label: sessionTypeLabel,
          session_sequence: sessionSequence,
          session_sequence_label: sessionSequenceLabel,
          is_first_session: isClientFirstSession,
          is_package_first_for_client: isPackageFirstForClient,
          package_session_number: packageSessionNumber,
          session_count: sessionCountForType,
          session_amount: sessionAmount,
          doctor_wallet: doctorWallet,
          company_commission: commissionAmount,
          status: session.status,
          payout_status: 'pending'
        });
      }
    }

    for (const session of unpaidNotDueSessions) {
      const psychId = session.psychologist_id;
      const doctorPayout = ensureDoctorPayout(session);
      const isPackageForRate =
        !!session.package_id ||
        (parseInt(session.session_count, 10) || 1) > 1 ||
        String(session.session_type || '').toLowerCase().includes('package');
      const isClientFirstSession = pendingClientFirstSessions.has(session.id);
      const isPackageFirstForClient = isPackageForRate
        ? (session.package_id ? pendingFirstPackages.has(session.package_id) : isClientFirstSession)
        : false;
      // A hand-set First/Follow-up (stored as |SEQ:… on the ledger row) wins over the
      // derived value, so the label matches what finance chose in the payout UI.
      const seqTag = /\|SEQ:(first|followup)/.exec(String(commissionMap[session.id]?.notes || ''));
      const rateIsFirstSession = seqTag
        ? seqTag[1] === 'first'
        : (isPackageForRate ? isPackageFirstForClient : isClientFirstSession);
      const sessionSequence = rateIsFirstSession ? 'first' : 'followup';
      const sessionSequenceLabel = rateIsFirstSession ? 'First' : 'Follow-up';
      const {
        sessionTypeForCount,
        sessionTypeLabel,
        packageSessionNumber,
        sessionCountForType
      } = getSessionTypeMeta(session);
      // Pass the ledger row when one exists. This was hard-coded to null, so a NOT-DUE
      // session (a booked session past its time — the UI labels it "pending") always
      // recomputed from config and silently discarded any hand-edited commission.
      const finance = getPendingSessionFinance(session, commissionMap[session.id] || null, rateIsFirstSession, psychId);

      doctorPayout.total_sessions += 1;
      doctorPayout.upcoming_sessions += 1;
      if (!doctorPayout.session_counts_by_type[sessionTypeForCount]) {
        doctorPayout.session_counts_by_type[sessionTypeForCount] = 0;
      }
      doctorPayout.session_counts_by_type[sessionTypeForCount] += 1;
      doctorPayout.not_due_doctor_wallet += finance.doctorWallet;
      doctorPayout.not_due_company_commission += finance.commissionAmount;

      if (includeDetails) {
        doctorPayout.sessions.push({
          session_id: session.id,
          session_date: session.scheduled_date,
          client_name: pendingClientNameMap[session.client_id] || '—',
          client_email: pendingClientEmailMap[session.client_id] || null,
          booked_at: getSessionBookingCreatedAtIso(session) || session.created_at || null,
          session_type: sessionTypeForCount,
          session_type_label: sessionTypeLabel,
          session_sequence: sessionSequence,
          session_sequence_label: sessionSequenceLabel,
          is_first_session: isClientFirstSession,
          is_package_first_for_client: isPackageFirstForClient,
          package_session_number: packageSessionNumber,
          session_count: sessionCountForType,
          session_amount: finance.sessionAmount,
          doctor_wallet: finance.doctorWallet,
          company_commission: finance.commissionAmount,
          status: session.status,
          payout_status: 'not_due'
        });
      }
    }

    // Convert to array and format for frontend. Avoid rebuilding every doctor profile here:
    // this endpoint already has the eligible completed sessions, and the extra profile pass
    // makes large months time out on Render.
    const payouts = Object.values(payoutsByDoctor).map((payout) => {
      const pendingDoctorWallet = Math.round(payout.total_doctor_wallet * 100) / 100;
      const companyEarnings = Math.round(payout.total_company_commission * 100) / 100;
      const notDueDoctorWallet = Math.round(payout.not_due_doctor_wallet * 100) / 100;
      const notDueCompanyEarnings = Math.round(payout.not_due_company_commission * 100) / 100;
      const payoutState = pendingDoctorWallet > 0 ? 'pending' : 'not_due';

      return {
        id: payout.psychologist_id, // Using psychologist_id as ID for pending payouts
        psychologist_id: payout.psychologist_id,
        psychologist: payout.psychologist,
        total_sessions: payout.total_sessions,
        profile_total_sessions: payout.total_sessions,
        completed_sessions: payout.completed_sessions,
        upcoming_sessions: payout.upcoming_sessions,
        cancelled_sessions: null,
        session_counts_by_type: payout.session_counts_by_type,
        total_doctor_wallet: pendingDoctorWallet,
        pending_payout_amount: pendingDoctorWallet,
        total_company_commission: companyEarnings,
        profile_company_earnings: companyEarnings + notDueCompanyEarnings,
        profile_gross_revenue: pendingDoctorWallet + companyEarnings + notDueDoctorWallet + notDueCompanyEarnings,
        profile_doctor_earnings: pendingDoctorWallet,
        profile_payout_paid: null,
        profile_payout_not_due: notDueDoctorWallet,
        not_due_payout: notDueDoctorWallet,
        not_due_company_earnings: notDueCompanyEarnings,
        payout_state: payoutState,
        payment_status: payoutState,
        // For backward compatibility with frontend
        total_commission: companyEarnings,
        net_payout: pendingDoctorWallet,
        session_details: payout.sessions
      };
    });
    
    console.log(`✅ Processed ${payouts.length} doctors with pending/not-yet-due payout sessions`);

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
      .select('id, psychologist_id, payout_amount, net_payout, payout_date, status, payment_method, notes, created_at')
      .single();

    if (error) throw error;

    // Update commission history to mark as paid
    await supabaseAdmin
      .from('commission_history')
      .update({
        payment_status: 'paid',
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

    const { psychologist_id, month, year, dateFrom, dateTo, sessionIds } = req.body;

    if (!psychologist_id) {
      return res.status(400).json(
        errorResponse('Psychologist ID is required')
      );
    }

    const explicitSessionIds = Array.isArray(sessionIds)
      ? [...new Set(sessionIds.filter(Boolean).map((id) => String(id)))]
      : [];

    // Support explicit session IDs, month/year, and date range formats.
    let monthStart, monthEnd;
    if (explicitSessionIds.length > 0) {
      monthStart = dateFrom || null;
      monthEnd = dateTo || null;
    } else if (dateFrom && dateTo) {
      monthStart = dateFrom;
      monthEnd = dateTo;
    } else if (month && year) {
      const monthStr = month < 10 ? `0${month}` : String(month);
      monthStart = `${year}-${monthStr}-01`;
      // Date.UTC — see note above: local-time construction dropped the last day of the month.
      monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().split('T')[0];
    } else {
      return res.status(400).json(
        errorResponse('Either sessionIds, month/year, or dateFrom/dateTo are required')
      );
    }

    // Get pending payout data for this psychologist and date range using
    // completion_date so mark-paid matches the payout views exactly.
    let completedSessions = null;
    let sessionsError = null;

    let completedSessionsQuery = supabaseAdmin
      .from('sessions')
      .select(`
        id,
        psychologist_id,
        scheduled_date,
        completion_date,
        updated_at,
        status,
        payment_id,
        price,
        amount,
        therapist_commission,
        session_type,
        session_count,
        package_id,
        package_group_id,
        package_session_number,
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone, cover_image_url)
      `)
      .eq('status', 'completed')
      .eq('psychologist_id', psychologist_id)
      .neq('session_type', 'free_assessment');

    if (explicitSessionIds.length > 0) {
      completedSessionsQuery = completedSessionsQuery.in('id', explicitSessionIds);
    } else {
      completedSessionsQuery = completedSessionsQuery.gte('scheduled_date', monthStart).lte('scheduled_date', monthEnd); // session date — matches the payout screens
    }

    ({ data: completedSessions, error: sessionsError } = await completedSessionsQuery);

    if (sessionsError && String(sessionsError.message || '').includes('cover_image_url')) {
      let fallbackCompletedSessionsQuery = supabaseAdmin
        .from('sessions')
        .select(`
          id,
          psychologist_id,
          scheduled_date,
          completion_date,
          updated_at,
          status,
          payment_id,
          price,
          amount,
          therapist_commission,
          session_type,
          session_count,
          package_id,
          package_group_id,
          package_session_number,
          psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone)
        `)
        .eq('status', 'completed')
        .eq('psychologist_id', psychologist_id)
        .neq('session_type', 'free_assessment');

      if (explicitSessionIds.length > 0) {
        fallbackCompletedSessionsQuery = fallbackCompletedSessionsQuery.in('id', explicitSessionIds);
      } else {
        fallbackCompletedSessionsQuery = fallbackCompletedSessionsQuery.gte('scheduled_date', monthStart).lte('scheduled_date', monthEnd);
      }

      ({ data: completedSessions, error: sessionsError } = await fallbackCompletedSessionsQuery);
    }

    if (sessionsError) {
      console.error('Error fetching completed sessions:', sessionsError);
      throw sessionsError;
    }

    const completedSessionsInRange = completedSessions || [];

    if (completedSessionsInRange.length === 0) {
      return res.status(404).json(
        errorResponse('No completed sessions found for this psychologist in the selected payout')
      );
    }

    const payoutSessionIds = completedSessionsInRange.map(s => s.id);

    const { data: dcRows } = await supabaseAdmin
      .from('doctor_commissions')
      .select(FINANCE_DOCTOR_COMMISSION_SELECT)
      .eq('psychologist_id', psychologist_id)
      .order('created_at', { ascending: false });
    const activeDc = (dcRows || []).find((r) => r.is_active !== false) || (dcRows || [])[0] || null;

    const { data: commissionHistory, error: commissionError } = await supabaseAdmin
      .from('commission_history')
      .select(`
        id,
        session_id,
        psychologist_id,
        payment_id,
        session_amount,
        commission_amount,
        payment_status
      `)
      .in('session_id', payoutSessionIds);

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
        const sessionAmount = parseFloat(session.price ?? session.amount ?? 0) || 0;
        const doctorWallet = computeSessionDoctorWallet(session, activeDc, null) || 0;
        commission = {
          session_amount: sessionAmount,
          commission_amount: sessionAmount - doctorWallet
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
      // NOT FINANCE_INCOME_SELECT — that constant describes the finance_income table
      // (date, income_source, description, reference_number). Using it here made the insert
      // fail with "column payouts.date does not exist", which surfaced as a 500 on
      // POST /finance/payouts/mark-paid. Select the row we just wrote instead.
      .select('*')
      .single();

    if (payoutError) {
      console.error('Error creating payout:', payoutError);
      throw payoutError;
    }

    const existingCommissionSessionIds = new Set((commissionHistory || []).map((ch) => ch.session_id));

    // Existing rows may be pending/null. Mark every completed session row in this payout range
    // as paid; upcoming/booked sessions are not in completedSessionsInRange, so they stay Not due.
    const { error: commissionUpdateError } = await supabaseAdmin
      .from('commission_history')
      .update({
        payment_status: 'paid',
        updated_at: new Date().toISOString()
      })
      .in('session_id', payoutSessionIds)
      .eq('psychologist_id', psychologist_id);

    if (commissionUpdateError) {
      console.error('Error updating commission history:', commissionUpdateError);
      // Don't throw - payout is already created, just log the error
    }

    const missingCommissionRows = completedSessionsInRange
      .filter((session) => !existingCommissionSessionIds.has(session.id))
      .map((session) => {
        const sessionAmount = parseFloat(session.price ?? session.amount ?? 0) || 0;
        const doctorWallet = computeSessionDoctorWallet(session, activeDc, null) || 0;
        return {
          psychologist_id,
          session_id: session.id,
          payment_id: session.payment_id || null,
          session_amount: sessionAmount,
          commission_amount: sessionAmount - doctorWallet,
          payment_status: 'paid',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
      });

    if (missingCommissionRows.length > 0) {
      const { error: missingCommissionError } = await supabaseAdmin
        .from('commission_history')
        .insert(missingCommissionRows);

      if (missingCommissionError) {
        console.error('Error creating paid commission history rows:', missingCommissionError);
      }
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
      details: { psychologist_id, month, year, dateFrom, dateTo, session_count: completedSessionsInRange.length, amount: totalDoctorWallet },
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
      .select(FINANCE_INCOME_SELECT, { count: 'exact' })
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
        .select(FINANCE_INCOME_SELECT, { count: 'exact' })
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
        .select(FINANCE_INCOME_LEGACY_SELECT, { count: 'exact' })
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
      .select(FINANCE_CATEGORY_SELECT)
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
      .select(FINANCE_CATEGORY_SELECT)
      .eq('is_active', true)
      .order('name', { ascending: true });

    // Fallback if `is_active` column doesn't exist.
    if (error && String(error.message || '').includes('is_active')) {
      ({ data: categories, error } = await supabaseAdmin
        .from('expense_categories')
        .select(FINANCE_CATEGORY_SELECT)
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
      .select(FINANCE_CATEGORY_SELECT)
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
      .select(FINANCE_INCOME_SOURCE_SELECT)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error && String(error.message || '').includes('is_active')) {
      ({ data: sources, error } = await supabaseAdmin
        .from('income_sources')
        .select(FINANCE_INCOME_SOURCE_SELECT)
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
      .select(FINANCE_INCOME_SOURCE_SELECT)
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

/**
 * Update commission split for a single session.
 * Upserts into commission_history (source of truth for finance dashboard).
 * Also syncs sessions.therapist_commission as a fallback field.
 */
const updateSessionCommission = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!['finance', 'admin', 'superadmin'].includes(userRole)) {
      return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    }

    const { sessionId } = req.params;
    const { commission_amount, session_amount, payout_status, session_sequence } = req.body;

    // Optional First / Follow-up override. The UI can't know the therapist's rate card, so it
    // just sends the sequence and the server derives the doctor amount from doctor_commissions.
    let sequenceOverride = null;
    if (session_sequence !== undefined && session_sequence !== null && session_sequence !== '') {
      const sq = String(session_sequence).toLowerCase();
      if (!['first', 'followup'].includes(sq)) {
        return res.status(400).json(errorResponse("session_sequence must be 'first' or 'followup'"));
      }
      sequenceOverride = sq;
    }

    if (commission_amount === undefined || commission_amount === null || isNaN(Number(commission_amount))) {
      return res.status(400).json(errorResponse('commission_amount is required and must be a number'));
    }

    // Optional per-session payout status. Setting it to 'paid' settles THIS session alone —
    // it then leaves the Pending tab and appears under Completed, without touching any of the
    // therapist's other sessions (unlike the whole-month "Mark as Paid" action).
    let payoutStatusToSet = null;
    if (payout_status !== undefined && payout_status !== null && payout_status !== '') {
      const ps = String(payout_status).toLowerCase();
      if (!['paid', 'pending'].includes(ps)) {
        return res.status(400).json(errorResponse("payout_status must be 'paid' or 'pending'"));
      }
      payoutStatusToSet = ps;
    }

    // Fetch session to get session_amount and psychologist_id
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, price, amount, psychologist_id, payment_id')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return res.status(404).json(errorResponse('Session not found'));
    }

    const sessionAmount = session_amount === undefined || session_amount === null || session_amount === ''
      ? (parseFloat(session.price ?? session.amount ?? 0) || 0)
      : Number(session_amount);
    const companyCommission = Number(commission_amount);

    if (!Number.isFinite(sessionAmount) || sessionAmount < 0) {
      return res.status(400).json(errorResponse('session_amount must be a valid non-negative number'));
    }
    if (!Number.isFinite(companyCommission)) {
      return res.status(400).json(errorResponse('commission_amount must be a valid number'));
    }

    const doctorWallet = sessionAmount - companyCommission;

    // Derive the doctor amount for the requested sequence, overriding whatever the UI sent.
    let effectiveCompany = companyCommission;
    if (sequenceOverride) {
      const { data: cfgRow } = await supabaseAdmin
        .from('doctor_commissions')
        .select('doctor_commission_first_session, doctor_commission_followup, doctor_commission_packages')
        .eq('psychologist_id', session.psychologist_id)
        .eq('is_active', true)
        .limit(1);
      const cfg = cfgRow?.[0];
      if (cfg) {
        const packages = cfg.doctor_commission_packages || {};
        const n = Math.max(1, parseInt(session.session_count, 10) || 1);
        const isPkg = n > 1 || String(session.session_type || '').toLowerCase().includes('package');
        let doctorForSequence;
        if (isPkg) {
          const key = sequenceOverride === 'first' ? `package_${n}_first_session` : `package_${n}_followup`;
          const total = parseFloat(packages[key] ?? packages[`package_${n}_first_session`] ?? 0) || 0;
          doctorForSequence = total > 0 ? total / n : null;
        } else {
          doctorForSequence = parseFloat(
            sequenceOverride === 'first' ? cfg.doctor_commission_first_session : cfg.doctor_commission_followup
          );
        }
        if (Number.isFinite(doctorForSequence)) {
          effectiveCompany = Math.round((sessionAmount - doctorForSequence) * 100) / 100;
        }
      }
    }

    // Check if commission_history row already exists
    const { data: existing } = await supabaseAdmin
      .from('commission_history')
      .select('id')
      .eq('session_id', sessionId)
      .maybeSingle();

    let upsertError;
    if (existing?.id) {
      // Update existing row
      ({ error: upsertError } = await supabaseAdmin
        .from('commission_history')
        .update({
          commission_amount: effectiveCompany,
          session_amount: sessionAmount,
          // Tag the row so recalculation/backfill jobs leave it alone. Without this, the
          // next backfill recomputes from config and silently wipes the manual correction —
          // which is why edits "saved" and then reverted.
          notes: MANUAL_COMMISSION_EDIT_TAG + (sequenceOverride ? `|SEQ:${sequenceOverride}` : ''),
          ...(payoutStatusToSet ? { payment_status: payoutStatusToSet } : {}),
        })
        .eq('session_id', sessionId));
    } else {
      // Insert new row
      ({ error: upsertError } = await supabaseAdmin
        .from('commission_history')
        .insert({
          session_id: sessionId,
          psychologist_id: session.psychologist_id,
          payment_id: session.payment_id || null,
          commission_amount: effectiveCompany,
          session_amount: sessionAmount,
          payment_status: payoutStatusToSet || 'pending',
          notes: MANUAL_COMMISSION_EDIT_TAG + (sequenceOverride ? `|SEQ:${sequenceOverride}` : ''),
        }));
    }

    if (upsertError) {
      console.error('updateSessionCommission upsert error:', upsertError.message);
      return res.status(500).json(errorResponse('Failed to update commission record'));
    }

    // Sync session money fields so all finance views reconcile after manual edits.
    await supabaseAdmin
      .from('sessions')
      .update({
        price: sessionAmount,
        amount: sessionAmount,
        therapist_commission: doctorWallet,
      })
      .eq('id', sessionId);

    await auditLogger.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole,
      action: 'SESSION_COMMISSION_UPDATED',
      resource: 'sessions',
      resourceId: sessionId,
      details: { commission_amount: companyCommission, doctor_wallet: doctorWallet, session_amount: sessionAmount },
      endpoint: `/api/finance/sessions/${sessionId}/commission`,
      method: 'PUT',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }).catch(() => {});

    return res.json(successResponse({
      session_id: sessionId,
      session_amount: sessionAmount,
      commission_amount: companyCommission,
      doctor_wallet: doctorWallet,
    }, 'Commission updated successfully'));

  } catch (error) {
    console.error('updateSessionCommission error:', error);
    return res.status(500).json(errorResponse('Internal server error'));
  }
};

module.exports = {
  getDashboard,
  getSessions,
  getDoctorBookings,
  getDoctorFinanceProfile,
  getSessionDetails,
  getPsychologistOptions,
  getClientOptions,
  getSalaryEmployees,
  upsertSalaryEmployee,
  sendReceiptEmail,
  getRevenue,
  getExpenses,
  createExpense,
  approveExpense,
  updateExpense,
  deleteExpense,
  getCommissions,
  updateCommissionRate,
  updateSessionCommission,
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
      .select(FINANCE_INCOME_SELECT)
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
        .select(FINANCE_INCOME_SELECT)
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
      .select(FINANCE_INCOME_SELECT)
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
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name)
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
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone)
      `)
      .eq('id', payoutId)
      .single();

    if (error || !payout) {
      return res.status(404).json(
        errorResponse('Payout not found')
      );
    }

    // commission_history has no payout_id column — payout↔commission link not stored
    const commissions = [];

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
  getPsychologistOptions,
  getClientOptions,
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
  getDoctorFinanceProfile,
  getSessionDetails,
  getPsychologistOptions,
  getClientOptions,
  getSalaryEmployees,
  upsertSalaryEmployee,
  sendReceiptEmail,
  getRevenue,
  getExpenses,
  createExpense,
  approveExpense,
  updateExpense,
  deleteExpense,
  getCommissions,
  updateCommissionRate,
  updateSessionCommission,
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
