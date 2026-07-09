const { supabaseAdmin } = require('../config/supabase');
const { 
  successResponse, 
  errorResponse,
  hashPassword,
  formatDate,
  formatTime,
  addMinutesToTime
} = require('../utils/helpers');
const { validatePassword } = require('../utils/passwordPolicy');
const { deriveSessionCount } = require('../services/packageService');
const availabilityService = require('../utils/availabilityCalendarService');
const { getMeetEventDurationMinutes } = require('../utils/sessionMeetDuration');
const { getBookingTimeColumnKey } = require('../utils/sessionsBookingTimeColumn');
const { getCalendarYmdInTimeZone } = require('../utils/sessionBookingCreatedAt');
const {
  buildKoottSessionDescription,
  buildKoottSessionTitle,
  getClientDisplayName,
  getPsychologistDisplayName,
} = require('../utils/sessionTitleFormatter');

async function writeSessionDeliveryMarkers(sessionId, fields) {
  if (!sessionId || !fields || Object.keys(fields).length === 0) return;
  try {
    const { error } = await supabaseAdmin
      .from('sessions')
      .update(fields)
      .eq('id', sessionId);
    if (!error) return;
    if (/column .*email_sent_at.* does not exist/i.test(error.message || '')) return;
    console.warn('[admin delivery markers] update failed:', error.message || error);
  } catch (err) {
    console.warn('[admin delivery markers] unexpected error:', err?.message || err);
  }
}

const buildAdminManualWixMirror = ({
  syntheticWixBookingId,
  scheduledDate,
  scheduledTime,
  durationMinutes,
  sessionType,
  sessionCount,
  therapistName,
  therapistEmail,
  therapistPhone,
  psychologistId,
  client,
  amount,
  currency = 'INR',
  packageId = null,
  sessionId = null,
  title = null,
  notes = null,
}) => {
  const { startTimeIso, endTimeIso } = buildWixMirrorIsoWindow(scheduledDate, scheduledTime, durationMinutes);

  return {
    wix_booking_id: syntheticWixBookingId,
    wix_session_id: syntheticWixBookingId,
    status: 'booked',
    session_type: sessionType || 'individual',
    session_count: sessionCount || 1,
    package_session_number: sessionCount && sessionCount > 1 ? 1 : null,
    therapist_name: therapistName || null,
    client_full_name: `${client?.first_name || ''} ${client?.last_name || ''}`.trim() || client?.child_name || null,
    client_first_name: client?.first_name || null,
    client_last_name: client?.last_name || null,
    client_email: Array.isArray(client?.user) ? client?.user?.[0]?.email || null : client?.user?.email || null,
    client_phone: client?.phone_number || null,
    contact_id: client?.user_id || client?.id || null,
    service_id: psychologistId || null,
    title: title || therapistName || 'Manual booking',
    // notes column not present on wix_bookings — pushed into payload instead (see below)
    start_time: startTimeIso,
    end_time: endTimeIso,
    price: amount,
    currency,
    synced_at: new Date().toISOString(),
    locally_modified: true,
    payload: {
      id: syntheticWixBookingId,
      status: 'booked',
      bookingStatus: 'booked',
      title: title || therapistName || 'Manual booking',
      serviceName: therapistName || null,
      bookingType: sessionType || 'individual',
      paymentState: 'COMPLETE',
      startTime: startTimeIso,
      endTime: endTimeIso,
      therapist: {
        name: therapistName || null,
        email: therapistEmail || null,
        phone: therapistPhone || null,
        staffId: psychologistId || null,
      },
      client: {
        firstName: client?.first_name || null,
        lastName: client?.last_name || null,
        fullName: `${client?.first_name || ''} ${client?.last_name || ''}`.trim() || client?.child_name || null,
        email: Array.isArray(client?.user) ? client?.user?.[0]?.email || null : client?.user?.email || null,
        phone: client?.phone_number || null,
        contactId: client?.user_id || client?.id || null,
      },
      isAdminManual: true,
      manualBooking: true,
      packageId,
      sessionId,
      notes: notes || null,
      paymentDetails: {
        wixPayMultipleDetails: [
          { paymentVendorName: 'inPerson' }
        ]
      }
    }
  };
};

const normalizeManualSessionSelection = (rawType, packageData = null) => {
  const input = String(rawType || '').trim().toLowerCase();
  const packageType = String(packageData?.package_type || '').trim().toLowerCase();

  if (packageData) {
    const isCouplePackage = packageType.includes('couple');
    return {
      sessionType: isCouplePackage ? 'couple' : 'package',
      sessionCount: Number(packageData.session_count) || 1,
      isPackage: true,
      isCouplePackage,
    };
  }

  if (input === 'couple') {
    return { sessionType: 'couple', sessionCount: 1, isPackage: false, isCouplePackage: false };
  }
  if (input === 'package_3') {
    return { sessionType: 'package', sessionCount: 3, isPackage: true, isCouplePackage: false };
  }
  if (input === 'package_6') {
    return { sessionType: 'package', sessionCount: 6, isPackage: true, isCouplePackage: false };
  }
  if (input === 'package_9') {
    return { sessionType: 'package', sessionCount: 9, isPackage: true, isCouplePackage: false };
  }
  if (input === 'couple_package_3') {
    return { sessionType: 'couple', sessionCount: 3, isPackage: true, isCouplePackage: true };
  }

  return { sessionType: 'individual', sessionCount: 1, isPackage: false, isCouplePackage: false };
};

const getManualSessionDurationMinutes = (sessionType, packageData = null) => {
  if (packageData?.package_type) {
    const pkgType = String(packageData.package_type).toLowerCase();
    if (pkgType.includes('couple')) return 80;
    return getMeetEventDurationMinutes(packageData.package_type);
  }

  if (sessionType === 'couple' || sessionType === 'couple_package') {
    return 80;
  }

  return 50;
};

const getManualSessionLabel = (sessionType, sessionStage, packageData = null, sessionCount = 1) => {
  const stageLabel = sessionStage === 'follow_up' ? 'Follow-up' : 'First session';
  const totalSessions = Number(packageData?.session_count) || Number(sessionCount) || 1;
  if (totalSessions > 1) {
    const prefix = sessionType === 'couple' ? 'Couple package' : 'Package';
    return `${prefix} of ${totalSessions} (${stageLabel})`;
  }
  if (sessionType === 'couple') return `Couple session (${stageLabel})`;
  return `Individual session (${stageLabel})`;
};

// Helper function to get availability dates for a day of the week
const getAvailabilityDatesForDay = (dayName, numOccurrences = 1) => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayIndex = days.indexOf(dayName);
  if (dayIndex === -1) return [];
  
  // Use local date directly without timezone conversion
  const today = new Date();
  const currentDay = today.getDay();
  let daysUntilNext = dayIndex - currentDay;
  
  // If today is the target day, start from today
  if (daysUntilNext === 0) {
    daysUntilNext = 0;
  } else if (daysUntilNext < 0) {
    // If the day has passed this week, start from next week
    daysUntilNext += 7;
  }
  
  const dates = [];
  for (let occurrence = 0; occurrence < numOccurrences; occurrence++) {
    const date = new Date(today);
    date.setDate(today.getDate() + daysUntilNext + (occurrence * 7));
    dates.push(date);
  }
  
  return dates;
};

// Escape SQL LIKE/ILIKE special characters (%, _, \) so search string is treated literally
const escapeLike = (str) => {
  if (str == null || typeof str !== 'string') return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
};

const buildWixMirrorIsoWindow = (scheduledDate, scheduledTime, durationMinutes = 50) => {
  if (!scheduledDate || !scheduledTime) {
    return { startTimeIso: null, endTimeIso: null };
  }

  try {
    const startLocal = new Date(`${scheduledDate}T${String(scheduledTime).slice(0, 5)}:00+05:30`);
    if (Number.isNaN(startLocal.getTime())) {
      return { startTimeIso: null, endTimeIso: null };
    }

    const safeDuration = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 50;
    return {
      startTimeIso: startLocal.toISOString(),
      endTimeIso: new Date(startLocal.getTime() + safeDuration * 60000).toISOString(),
    };
  } catch (_) {
    return { startTimeIso: null, endTimeIso: null };
  }
};

// NOTE: This file was partially overwritten. Only createManualBooking function is present.
// Other functions need to be restored from backup or re-implemented.
// Functions needed: getAllUsers, getUserDetails, updateUserRole, deactivateUser, 
// getPlatformStats, searchUsers, getRecentActivities, getRecentUsers, getRecentBookings,
// getAllPsychologists, createPsychologist, updatePsychologist, deletePsychologist,
// addNextDayAvailability, updateAllPsychologistsAvailability, createPsychologistPackages,
// checkMissingPackages, deletePackage, getStuckSlotLocks, createUser, updateUser, deleteUser,
// rescheduleSession, updateSessionPayment, updateSession, getPsychologistAvailabilityForReschedule,
// handleRescheduleRequest, getRescheduleRequests, approveAssessmentRescheduleRequest,
// getPsychologistCalendarEvents, checkCalendarSyncStatus

// ============================================================================
// Multi-session package booking — schedule ALL sessions of a package upfront.
// Creates ONE payment + N sessions (each with its own Google Calendar event,
// Meet link, Wix-mirror row, and email/WhatsApp), linked by a shared
// package_group_id. Isolated from createManualBooking (single-session path).
// ============================================================================
async function createOneManualPackageSession({
  client, psychologist, paymentId, packageGroupId, syntheticWixBookingId,
  sessionType, sessionCount, sessionNumber,
  scheduledDate, scheduledTime, durationMinutes,
  price, therapistCommission, notes,
  packageId
}) {
  const meetLinkService = require('../utils/meetLinkService');
  const { addMinutesToTime } = require('../utils/helpers');
  const clientName = getClientDisplayName(client, 'Client');
  const psychologistName = getPsychologistDisplayName(psychologist);
  const clientEmailResolved = Array.isArray(client?.user) ? client.user?.[0]?.email : client?.user?.email;

  // 1. Calendar event + Meet link (on the therapist's calendar)
  const meetData = { meetLink: null, eventId: null, calendarLink: null };
  try {
    let userAuth = null;
    const creds = psychologist.google_calendar_credentials;
    if (creds?.access_token) userAuth = { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date };
    const meetResult = await meetLinkService.generateSessionMeetLink({
      summary: buildKoottSessionTitle({ clientName, psychologistName }),
      description: buildKoottSessionDescription({ clientName, psychologistName, clientPhone: client.phone_number }),
      startDate: scheduledDate,
      startTime: scheduledTime.slice(0, 5),
      endTime: addMinutesToTime(scheduledTime.slice(0, 5), durationMinutes),
      clientEmail: clientEmailResolved || null,
      psychologistEmail: psychologist?.email || null,
    }, userAuth);
    if (meetResult?.eventId) meetData.eventId = meetResult.eventId;
    if (meetResult?.eventLink || meetResult?.calendarLink) meetData.calendarLink = meetResult.eventLink || meetResult.calendarLink;
    if (meetResult?.meetLink && !meetResult.meetLink.includes('meet.google.com/new')) meetData.meetLink = meetResult.meetLink;
  } catch (e) { console.error('[manualPackage] meet failed (non-fatal):', e.message); }

  // 2. Insert the session
  const sessionRow = {
    client_id: client.id,
    psychologist_id: psychologist.id,
    package_id: packageId || null,
    session_type: sessionType,
    session_count: sessionCount,
    package_group_id: packageGroupId,
    package_session_number: sessionNumber,
    scheduled_date: scheduledDate,
    scheduled_time: scheduledTime,
    status: 'booked',
    payment_id: paymentId,
    price: price,
    therapist_commission: therapistCommission || 0,
    session_notes: notes || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    booking_created_at: new Date().toISOString(),
    original_scheduled_date: scheduledDate,
    // NOTE: wix_booking_id is set AFTER the mirror row exists (FK constraint) — see below.
  };
  if (meetData.eventId) sessionRow.google_calendar_event_id = meetData.eventId;
  if (meetData.meetLink) { sessionRow.google_meet_link = meetData.meetLink; sessionRow.google_meet_join_url = meetData.meetLink; sessionRow.google_meet_start_url = meetData.meetLink; }
  if (meetData.calendarLink) sessionRow.google_calendar_link = meetData.calendarLink;

  const { data: session, error: sessionError } = await supabaseAdmin.from('sessions').insert([sessionRow]).select('*').single();
  if (sessionError) throw new Error(`Session ${sessionNumber} creation failed: ${sessionError.message}`);

  // 3. Wix discovery mirror row
  try {
    const wixMirrorRow = buildAdminManualWixMirror({
      syntheticWixBookingId, scheduledDate, scheduledTime, durationMinutes,
      sessionType, sessionCount,
      therapistName: `${psychologist.first_name || ''} ${psychologist.last_name || ''}`.trim(),
      therapistEmail: psychologist.email || null, therapistPhone: psychologist.phone || null,
      psychologistId: psychologist.id, client, amount: price, currency: 'INR',
      packageId: packageId || null, sessionId: session.id,
      title: `${psychologist.first_name || ''} ${psychologist.last_name || ''}`.trim() || 'Manual booking', notes: notes || null,
    });
    wixMirrorRow.package_session_number = sessionNumber;
    wixMirrorRow.payload.planSessionNumber = sessionNumber;
    wixMirrorRow.payload.creditsAvailable = sessionCount;
    const { error: mirrorErr } = await supabaseAdmin.from('wix_bookings').insert([wixMirrorRow]);
    if (!mirrorErr) {
      // Link the session to the mirror only after the mirror row exists (FK constraint).
      await supabaseAdmin.from('sessions').update({ wix_booking_id: syntheticWixBookingId }).eq('id', session.id);
      session.wix_booking_id = syntheticWixBookingId;
    } else {
      console.warn('[manualPackage] wix mirror insert failed (non-fatal):', mirrorErr.message);
    }
  } catch (e) { console.warn('[manualPackage] wix mirror failed (non-fatal):', e.message); }

  // 4. Block the slot in availability
  try { await availabilityService.updateAvailabilityOnBooking(psychologist.id, scheduledDate, scheduledTime); }
  catch (e) { console.warn('[manualPackage] availability update failed (non-fatal):', e.message); }

  // 5. Notifications (email + WhatsApp + immediate-reminder check) — fire-and-forget
  (async () => {
    const packageInfo = { totalSessions: sessionCount, completedSessions: sessionNumber - 1, remainingSessions: sessionCount - sessionNumber, packageType: sessionType === 'couple' ? `couple_package_${sessionCount}` : `package_${sessionCount}` };
    try {
      const emailService = require('../utils/emailService');
      const emailResult = await emailService.sendSessionConfirmation({
        clientName, psychologistName, sessionDate: scheduledDate, sessionTime: scheduledTime,
        sessionDuration: `${durationMinutes} minutes`, clientEmail: clientEmailResolved,
        psychologistEmail: psychologist.email, googleMeetLink: meetData.meetLink, meetLink: meetData.meetLink,
        googleCalendarEventId: meetData.eventId, sessionId: session.id, amount: price, price,
        status: 'booked', psychologistId: psychologist.id, clientId: client.id, packageInfo,
      });
      if (emailResult?.clientEmailSent === true) {
        await writeSessionDeliveryMarkers(session.id, { email_sent_at: new Date().toISOString() });
      }
    } catch (e) { console.error('[manualPackage] email failed:', e.message); }
    try {
      const interaktService = require('../utils/interaktService');
      const meetOrNull = meetData.meetLink || null;
      if (client.phone_number) {
        const res = await interaktService.sendBookingConfirmation(client.phone_number, { clientName, psychologistName, date: scheduledDate, time: scheduledTime, meetLink: meetOrNull });
        if (res?.success) await writeSessionDeliveryMarkers(session.id, { whatsapp_sent_at: new Date().toISOString() });
      }
      if (psychologist.phone) await interaktService.sendSessionNotificationPsychologist(psychologist.phone, { therapistName: psychologistName, clientName, date: scheduledDate, time: scheduledTime, meetLink: meetOrNull });
    } catch (e) { console.error('[manualPackage] whatsapp failed:', e.message); }
    try { require('../services/sessionReminderService').checkAndSendReminderForSessionId(session.id).catch(() => {}); } catch {}
  })();

  return session;
}

const createManualPackageBooking = async (req, res) => {
  try {
    const { client_id, psychologist_id, session_type, schedules, amount, payment_received_date, payment_method, receipt_url, therapist_commission, notes } = req.body;

    if (!client_id || !psychologist_id || !Array.isArray(schedules) || schedules.length === 0 || !amount || !payment_received_date) {
      return res.status(400).json(errorResponse('Missing required fields: client_id, psychologist_id, schedules[], amount, payment_received_date'));
    }
    const selection = normalizeManualSessionSelection(session_type, null);
    if (!selection.isPackage) return res.status(400).json(errorResponse('session_type must be a package (e.g. package_3, package_6, package_9, couple_package_3)'));
    const sessionCount = selection.sessionCount;
    if (schedules.length !== sessionCount) return res.status(400).json(errorResponse(`This package needs ${sessionCount} dates, but ${schedules.length} were provided`));

    const seen = new Set();
    for (const s of schedules) {
      if (!s?.date || !s?.time) return res.status(400).json(errorResponse('Every session needs a date and a time'));
      const k = `${s.date}T${String(s.time).slice(0, 5)}`;
      if (seen.has(k)) return res.status(400).json(errorResponse('Two sessions are scheduled at the same date & time — pick distinct slots'));
      seen.add(k);
    }
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return res.status(400).json(errorResponse('Please enter a valid amount'));

    // Resolve client — the frontend may pass either the clients.id or the user_id,
    // so fall back to a user_id lookup (mirrors createManualBooking).
    const CLIENT_SELECT = 'id, first_name, last_name, child_name, phone_number, user_id, user:users(email)';
    let client = null;
    {
      const { data: byId } = await supabaseAdmin.from('clients').select(CLIENT_SELECT).eq('id', client_id).maybeSingle();
      client = byId || null;
      if (!client) {
        const { data: byUser } = await supabaseAdmin.from('clients').select(CLIENT_SELECT).eq('user_id', client_id).maybeSingle();
        client = byUser || null;
      }
    }
    if (!client) return res.status(404).json(errorResponse(`Client not found with id or user_id: ${client_id}`));
    const { data: psychologist } = await supabaseAdmin.from('psychologists').select('id, first_name, last_name, email, phone, google_calendar_credentials').eq('id', psychologist_id).single();
    if (!psychologist) return res.status(404).json(errorResponse('Psychologist not found'));

    // Resolve package catalog ID for this psychologist and session_type
    let resolvedPackageId = null;
    try {
      const { data: pkgCatalog } = await supabaseAdmin
        .from('packages')
        .select('id')
        .eq('psychologist_id', psychologist_id)
        .eq('package_type', session_type)
        .eq('is_active', true)
        .maybeSingle();
      if (pkgCatalog) {
        resolvedPackageId = pkgCatalog.id;
        console.log(`✅ [createManualPackageBooking] Automatically resolved package catalog ID: ${resolvedPackageId}`);
      }
    } catch (e) {
      console.warn('[createManualPackageBooking] package catalog resolve failed (non-fatal):', e.message);
    }

    // ONE payment for the whole package. Some optional columns (e.g. session_type) may
    // not exist in every deployment's payments schema — strip & retry on PGRST204.
    const transactionId = `MANUAL-PKG-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let paymentInsert = {
      transaction_id: transactionId, session_id: null, psychologist_id, client_id: client.id,
      package_id: resolvedPackageId || null,
      amount, session_type: selection.sessionType, status: 'success',
      payment_method: (payment_method || 'cash').toLowerCase(),
      receipt_url: (typeof receipt_url === 'string' && receipt_url.trim()) || null,
      razorpay_params: { notes: { manual: true, admin_created: true, package_upfront: true, created_by: req.user.id, payment_received_date } },
      completed_at: payment_received_date, created_at: new Date().toISOString(),
    };
    let payment = null;
    let payErr = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      ({ data: payment, error: payErr } = await supabaseAdmin.from('payments').insert(paymentInsert).select().single());
      if (!payErr || String(payErr.code || '') !== 'PGRST204') break;
      const missing = String(payErr.message || '').match(/Could not find the '([^']+)' column/)?.[1];
      if (!missing || !Object.prototype.hasOwnProperty.call(paymentInsert, missing)) break;
      console.warn(`[createManualPackageBooking] payments missing optional column '${missing}'; retrying without it`);
      delete paymentInsert[missing];
    }
    if (payErr) { console.error('[createManualPackageBooking] payment failed:', payErr); return res.status(500).json(errorResponse('Failed to create payment record')); }

    const { randomUUID } = require('crypto');
    const packageGroupId = randomUUID();
    // Optional admin-chosen duration override; else derive from the package type.
    const reqDur = parseInt(req.body.duration_minutes, 10);
    const durationMinutes = (Number.isFinite(reqDur) && reqDur > 0) ? reqDur : getManualSessionDurationMinutes(selection.sessionType, null);
    const normTime = (t) => { const x = String(t).split('.')[0].trim(); return x.length === 5 ? `${x}:00` : x; };

    const created = [];
    try {
      for (let i = 0; i < schedules.length; i++) {
        const sess = await createOneManualPackageSession({
          client, psychologist, paymentId: payment.id, packageGroupId,
          syntheticWixBookingId: `admin_manual_pkg_${Date.now()}_${i + 1}`,
          sessionType: selection.sessionType, sessionCount, sessionNumber: i + 1,
          scheduledDate: schedules[i].date, scheduledTime: normTime(schedules[i].time),
          durationMinutes,
          // Full package amount lives on session #1; others 0. Finance dedupes by payment_id
          // so revenue is still counted exactly once for the whole package.
          price: i === 0 ? amount : 0,
          therapistCommission: therapist_commission ? parseFloat(therapist_commission) : 0,
          notes,
          packageId: resolvedPackageId,
        });
        created.push({ id: sess.id, session_number: i + 1, scheduled_date: sess.scheduled_date, scheduled_time: sess.scheduled_time });
      }
    } catch (loopErr) {
      console.error('[createManualPackageBooking] session loop error:', loopErr.message);
      // Partial success is possible; report what was created so admin can finish the rest.
      return res.status(207).json(errorResponse(`Created ${created.length}/${sessionCount} sessions before an error: ${loopErr.message}`));
    }

    await supabaseAdmin.from('payments').update({ session_id: created[0]?.id }).eq('id', payment.id);
    console.log(`✅ [createManualPackageBooking] booked ${created.length} sessions (group ${packageGroupId})`);
    return res.json(successResponse({ sessions: created, package_group_id: packageGroupId, count: created.length }, `Booked ${created.length} package sessions with calendar + notifications`));
  } catch (e) {
    console.error('[createManualPackageBooking]', e);
    return res.status(500).json(errorResponse(e.message || 'Failed to create package booking'));
  }
};

/**
 * POST /admin/bookings/record-only-package
 * Record several ALREADY-HAPPENED sessions of a package that were never in our system
 * (e.g. a 6-session package where 3 were completed offline). Creates N session records with
 * proper package linkage (package_id, package_group_id, session_count) and leaves the rest
 * (total − N) bookable normally later via "Book Next Session".
 *
 * NO Google Calendar events, NO Meet links, NO notifications — pure records.
 *
 * Body: {
 *   client_id, psychologist_id, session_type ('package'|'couple'),
 *   total_sessions (number — the full package size),
 *   total_amount (whole package price — recorded on session #1; the rest are ₹0),
 *   payment_method, receipt_url, payment_received_date, notes,
 *   records: [{ scheduled_date, scheduled_time, status }]   // one per session being recorded
 * }
 */
const createRecordOnlyPackage = async (req, res) => {
  try {
    const {
      client_id, psychologist_id, session_type,
      total_sessions, total_amount,
      payment_method, receipt_url, payment_screenshot_url, payment_received_date,
      notes, records,
    } = req.body;

    const totalSessions = parseInt(total_sessions, 10);
    if (!client_id || !psychologist_id) {
      return res.status(400).json(errorResponse('client_id and psychologist_id are required'));
    }
    if (!Number.isFinite(totalSessions) || totalSessions < 1) {
      return res.status(400).json(errorResponse('total_sessions must be a positive whole number'));
    }
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json(errorResponse('At least one session record is required'));
    }
    if (records.length > totalSessions) {
      return res.status(400).json(errorResponse(`Cannot record ${records.length} sessions — the package only has ${totalSessions}`));
    }
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const timePattern = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    for (const [i, r] of records.entries()) {
      if (!datePattern.test(String(r.scheduled_date || ''))) {
        return res.status(400).json(errorResponse(`Record ${i + 1}: invalid date (expected YYYY-MM-DD)`));
      }
      const t = String(r.scheduled_time || '').trim().split(':').slice(0, 2).join(':');
      if (!timePattern.test(t)) {
        return res.status(400).json(errorResponse(`Record ${i + 1}: invalid time (expected HH:MM)`));
      }
    }

    // Resolve client (by id or user_id).
    const clientIdForQuery = isNaN(client_id) ? client_id : parseInt(client_id);
    let { data: client } = await supabaseAdmin.from('clients').select('*, user:users(email)').eq('id', clientIdForQuery).single();
    if (!client) {
      const { data: byUser } = await supabaseAdmin.from('clients').select('*, user:users(email)').eq('user_id', clientIdForQuery).single();
      client = byUser || null;
    }
    if (!client) return res.status(404).json(errorResponse(`Client not found: ${client_id}`));

    const { data: psychologist } = await supabaseAdmin.from('psychologists').select('id, first_name, last_name, email').eq('id', psychologist_id).single();
    if (!psychologist) return res.status(404).json(errorResponse('Psychologist not found'));

    // Find or create the packages row for this therapist at this size (no discount_percentage column).
    const isCouple = String(session_type || '').toLowerCase().includes('couple');
    const packageType = isCouple ? `couple_package_${totalSessions}` : `package_${totalSessions}`;
    let packageId = null;
    const { data: existingPkg } = await supabaseAdmin
      .from('packages')
      .select('id')
      .eq('psychologist_id', psychologist_id)
      .eq('package_type', packageType)
      .eq('session_count', totalSessions)
      .maybeSingle();
    if (existingPkg?.id) {
      packageId = existingPkg.id;
    } else {
      const { data: newPkg, error: pkgErr } = await supabaseAdmin.from('packages').insert([{
        psychologist_id, package_type: packageType,
        name: `${totalSessions} Session ${isCouple ? 'Couple ' : ''}Package`,
        description: `${totalSessions} therapy sessions`,
        session_count: totalSessions,
        price: Number(total_amount) || 0,
      }]).select('id').single();
      if (pkgErr) return res.status(500).json(errorResponse('Failed to create package: ' + pkgErr.message));
      packageId = newPkg.id;
    }

    const crypto = require('crypto');
    const groupId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const normalizedMethod = (payment_method || 'cash').toLowerCase();
    const normalizedReceipt = (typeof receipt_url === 'string' && receipt_url.trim())
      || (typeof payment_screenshot_url === 'string' && payment_screenshot_url.trim()) || null;
    const paidDate = payment_received_date || nowIso.slice(0, 10);
    const totalAmt = Number(total_amount) || 0;

    // One payment record for the whole package (attached to session #1 below).
    // NOTE: payments has no transaction_id / session_type columns — the record id goes in
    // provider_payment_id and razorpay_params.notes instead.
    const { data: payment } = await supabaseAdmin.from('payments').insert({
      session_id: null, psychologist_id, client_id: client.id, package_id: packageId,
      amount: totalAmt, currency: 'INR', status: 'success',
      provider: 'manual',
      provider_payment_id: `RECORDPKG-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      payment_method: normalizedMethod, receipt_url: normalizedReceipt,
      completed_at: paidDate, created_at: nowIso,
      razorpay_params: { notes: { record_only: true, package_record: true, admin_created: true, created_by: req.user?.id } },
    }).select('id').single();

    const allowed = ['booked', 'completed', 'cancelled', 'no_show', 'rescheduled'];
    const created = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const num = i + 1;
      const time = String(r.scheduled_time).trim().split(':').slice(0, 2).join(':') + ':00';
      const status = allowed.includes(String(r.status || '').toLowerCase()) ? String(r.status).toLowerCase() : 'completed';
      const row = {
        client_id: client.id,
        psychologist_id,
        package_id: packageId,
        package_group_id: groupId,
        package_session_number: num,
        session_count: totalSessions,
        session_type: isCouple ? 'couple' : 'package',
        status,
        scheduled_date: r.scheduled_date,
        scheduled_time: time,
        original_scheduled_date: r.scheduled_date,
        // Whole package price sits on session #1; the rest are ₹0 (normal package accounting).
        price: num === 1 ? totalAmt : 0,
        payment_id: num === 1 ? payment?.id || null : null,
        source: 'admin_manual',
        session_notes: notes || null,
        booking_created_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      };
      // Completed records need completion_date so finance counts them.
      if (status === 'completed') row.completion_date = r.scheduled_date;
      const { data: sess, error: sErr } = await supabaseAdmin.from('sessions').insert([row]).select('id, package_session_number, scheduled_date, status').single();
      if (sErr) {
        console.error('[createRecordOnlyPackage] session insert failed:', sErr.message);
        return res.status(500).json(errorResponse(`Failed to create record ${num}: ${sErr.message}`));
      }
      created.push(sess);
      if (num === 1 && payment?.id) {
        await supabaseAdmin.from('payments').update({ session_id: sess.id }).eq('id', payment.id);
      }
    }

    // client_packages: remaining = total − recorded, so "Book Next Session" continues from here.
    const remaining = Math.max(totalSessions - records.length, 0);
    await supabaseAdmin.from('client_packages').insert([{
      client_id: client.id, package_id: packageId,
      remaining_sessions: remaining,
      status: remaining > 0 ? 'active' : 'completed',
    }]).select('id').maybeSingle().then(() => {}).catch(() => {});

    return res.json(successResponse({
      package_id: packageId, package_group_id: groupId,
      recorded: created.length, total: totalSessions, remaining,
      sessions: created,
    }, `Recorded ${created.length} of ${totalSessions} package sessions. ${remaining} remaining to book.`));
  } catch (e) {
    console.error('[createRecordOnlyPackage]', e);
    return res.status(500).json(errorResponse(e.message || 'Failed to record package sessions'));
  }
};

// Create manual booking (admin only - for edge cases)
// Rebuilt from scratch to match normal booking flow with proper error handling
const createManualBooking = async (req, res) => {
  // Track created resources for rollback on error
  let paymentRecord = null;
  let session = null;
  let meetData = null;
  let meetUserAuth = null;

  try {
    // ============================================
    // STEP 1: VALIDATE INPUT
    // ============================================
    const { 
      client_id, 
      psychologist_id, 
      package_id: inputPackageId, 
      session_type,
      session_stage,
      scheduled_date, 
      scheduled_time, 
      amount,
      therapist_commission,
      payment_received_date,
      payment_method,
      receipt_url,
      payment_screenshot_url,
      notes 
    } = req.body;

    let package_id = inputPackageId;

    console.log('📝 [MANUAL BOOKING] Starting manual booking process:', {
      client_id,
      psychologist_id,
      package_id,
      scheduled_date,
      scheduled_time,
      amount
    });

    // Validate required fields
    if (!client_id || !psychologist_id || !scheduled_date || !scheduled_time || !amount) {
      return res.status(400).json(
        errorResponse('Missing required fields: client_id, psychologist_id, scheduled_date, scheduled_time, amount')
      );
    }

    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json(
        errorResponse('Invalid amount: must be a positive number')
      );
    }

    // Validate scheduled_date format (YYYY-MM-DD)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(scheduled_date)) {
      return res.status(400).json(
        errorResponse('Invalid scheduled_date format. Expected YYYY-MM-DD')
      );
    }
    // Validate it's a real date (parse as UTC noon so validation is timezone-independent)
    const [y, m, d] = scheduled_date.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    if (isNaN(dateObj.getTime()) || dateObj.getUTCFullYear() !== y || dateObj.getUTCMonth() !== m - 1 || dateObj.getUTCDate() !== d) {
      return res.status(400).json(
        errorResponse('Invalid scheduled_date: not a valid date')
      );
    }

    // Validate scheduled_time format (HH:MM or HH:MM:SS 24-hour); normalize to HH:MM
    const timePart = String(scheduled_time).trim().split(':').slice(0, 2).join(':');
    const timePattern = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timePattern.test(timePart)) {
      return res.status(400).json(
        errorResponse('Invalid scheduled_time format. Expected HH:MM in 24-hour format')
      );
    }
    const scheduledTimeNormalized = timePart;

    if (!payment_received_date) {
      return res.status(400).json(
        errorResponse('payment_received_date is required for manual bookings')
      );
    }

    // ============================================
    // STEP 2: LOOKUP CLIENT (with fallback to user_id)
    // ============================================
    const clientIdForQuery = isNaN(client_id) ? client_id : parseInt(client_id);
    
    let { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('*, user:users(email)')
      .eq('id', clientIdForQuery)
      .single();

    // Fallback: try user_id lookup if id lookup fails
    if (clientError || !client) {
      console.log('⚠️ [MANUAL BOOKING] Client not found by id, trying user_id lookup...');
      const { data: clientByUserId, error: userLookupError } = await supabaseAdmin
        .from('clients')
        .select('*, user:users(email)')
        .eq('user_id', clientIdForQuery)
        .single();

      if (clientByUserId && !userLookupError) {
        console.log('✅ [MANUAL BOOKING] Found client by user_id');
        client = clientByUserId;
      } else {
        console.error('❌ [MANUAL BOOKING] Client not found:', { client_id, clientIdForQuery });
        return res.status(404).json(
          errorResponse(`Client not found with id or user_id: ${client_id}`)
        );
      }
    }

    console.log('✅ [MANUAL BOOKING] Client found:', {
      clientId: client.id,
      clientEmail: client.user?.email,
      clientName: `${client.first_name} ${client.last_name}`
    });

    // ============================================
    // STEP 3: VALIDATE PSYCHOLOGIST
    // ============================================
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('*, google_calendar_credentials')
      .eq('id', psychologist_id)
      .single();

    if (psychologistError || !psychologist) {
      console.error('❌ [MANUAL BOOKING] Psychologist not found:', psychologist_id);
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    // ============================================
    // STEP 4: VALIDATE PACKAGE (if provided or implicit)
    // ============================================
    let packageData = null;
    const initialSelection = normalizeManualSessionSelection(session_type, null);
    if (!package_id && initialSelection.isPackage) {
      // Find package in catalog for this psychologist by package_type matching session_type
      const { data: pkgCatalog } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('psychologist_id', psychologist_id)
        .eq('package_type', session_type)
        .eq('is_active', true)
        .maybeSingle();
      if (pkgCatalog) {
        packageData = pkgCatalog;
        package_id = pkgCatalog.id;
        console.log(`✅ [MANUAL BOOKING] Automatically resolved catalog package ID: ${package_id} for type ${session_type}`);
      }
    } else if (package_id) {
      const { data: pkg, error: packageError } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('id', package_id)
        .single();

      if (packageError || !pkg) {
        console.error('❌ [MANUAL BOOKING] Package not found:', package_id);
        return res.status(404).json(
          errorResponse('Package not found')
        );
      }
      packageData = pkg;
    }

    const manualSelection = normalizeManualSessionSelection(session_type, packageData);
    const manualSessionType = manualSelection.sessionType;
    const manualSessionStage = session_stage === 'follow_up' ? 'follow_up' : 'first';
    const manualSessionCount = manualSelection.sessionCount;
    const manualPackageSessionNumber = manualSessionCount > 1 ? 1 : null;
    // Optional admin-chosen duration override (e.g. 15 min for psychiatrist). Falls back
    // to the type/package-derived default when not provided.
    const requestedDurationMin = parseInt(req.body.duration_minutes, 10);
    const overrideDurationMin = Number.isFinite(requestedDurationMin) && requestedDurationMin > 0 ? requestedDurationMin : null;
    const resolveMeetMinutes = () => overrideDurationMin || getManualSessionDurationMinutes(manualSessionType, packageData);

    // ============================================
    // STEP 5: MANUAL DATE/TIME ENTRY
    // ============================================
    // Admin manual bookings are intentionally no longer restricted to generated
    // availability slots. We still block duplicate inserts later via DB/session
    // creation safeguards, but we do not reject the chosen date/time here just
    // because it is not present in the availability calendar.
    console.log('ℹ️ [MANUAL BOOKING] Skipping slot availability check; using manually selected date/time');

    // ============================================
    // STEP 5.5: PACKAGE CHECK (no block if exhausted – we allow new purchase via manual booking)
    // ============================================
    // If client has an active package with remaining_sessions > 0 we'll consume one later.
    // If client has an exhausted package (remaining_sessions <= 0), we allow booking and will
    // create a new client_packages row (new purchase of same package type).
    if (package_id && packageData) {
      try {
        await supabaseAdmin
          .from('client_packages')
          .select('id, remaining_sessions')
          .eq('client_id', client.id)
          .eq('package_id', package_id)
          .eq('status', 'active')
          .maybeSingle();
        // No validation block: exhausted package is handled later by creating a new client_packages row
      } catch (packageValidationError) {
        console.error('❌ [MANUAL BOOKING] Error validating package:', packageValidationError);
        return res.status(500).json(
          errorResponse('Failed to validate package availability')
        );
      }
    }

    // ============================================
    // STEP 6: CREATE PAYMENT RECORD
    // ============================================
    const transactionId = `MANUAL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const normalizedPaymentMethod = (payment_method || 'cash').toLowerCase();
    const normalizedReceiptUrl =
      (typeof receipt_url === 'string' && receipt_url.trim()) ||
      (typeof payment_screenshot_url === 'string' && payment_screenshot_url.trim()) ||
      null;

    const basePaymentInsert = {
      transaction_id: transactionId,
      session_id: null, // Will be set after session creation
      psychologist_id: psychologist_id,
      client_id: client.id,
      package_id: package_id || null,
      amount: amount,
      session_type: manualSessionType,
      status: 'success',
      payment_method: normalizedPaymentMethod,
      receipt_url: normalizedReceiptUrl,
      razorpay_params: {
        notes: {
          manual: true,
          payment_method: normalizedPaymentMethod,
          admin_created: true,
          created_by: req.user.id,
          created_at: new Date().toISOString(),
          payment_received_date: payment_received_date,
          payment_screenshot_uploaded: Boolean(normalizedReceiptUrl)
        }
      },
      completed_at: payment_received_date,
      created_at: new Date().toISOString()
    };

    let payment = null;
    let paymentError = null;
    let paymentInsertData = { ...basePaymentInsert };

    for (let attempt = 0; attempt < 12; attempt++) {
      ({ data: payment, error: paymentError } = await supabaseAdmin
        .from('payments')
        .insert(paymentInsertData)
        .select()
        .single());

      const isMissingSchemaColumn =
        paymentError &&
        String(paymentError.code || '') === 'PGRST204';

      if (!isMissingSchemaColumn) break;

      const msg = String(paymentError.message || '');
      const missingMatch = msg.match(/Could not find the '([^']+)' column/);
      const missingColumn = missingMatch?.[1] || null;

      if (!missingColumn || !Object.prototype.hasOwnProperty.call(paymentInsertData, missingColumn)) {
        break;
      }

      console.warn(`[admin.createManualBooking] payments schema missing optional column '${missingColumn}'; retrying without it`);
      delete paymentInsertData[missingColumn];
    }

    if (paymentError) {
      console.error('❌ [MANUAL BOOKING] Payment creation failed:', paymentError);
      return res.status(500).json(
        errorResponse('Failed to create payment record')
      );
    }

    paymentRecord = payment;
    console.log('✅ [MANUAL BOOKING] Payment record created:', payment.id);

    // ============================================
    // STEP 7: CREATE GOOGLE MEET LINK
    // ============================================
    const meetLinkService = require('../utils/meetLinkService');
    const { addMinutesToTime } = require('../utils/helpers');

    try {
      console.log('🔄 [MANUAL BOOKING] Creating Google Meet link...');

      const manualMeetMinutes = resolveMeetMinutes();
      const clientName = getClientDisplayName(client, 'Client');
      const psychologistName = getPsychologistDisplayName(psychologist);

      // Resolve client email from the joined `user` relation (clients.user_id → users.email)
      const clientEmailResolved = Array.isArray(client?.user)
        ? client.user?.[0]?.email
        : client?.user?.email;

      const sessionData = {
        summary: buildKoottSessionTitle({ clientName, psychologistName }),
        description: buildKoottSessionDescription({
          clientName,
          psychologistName,
          clientPhone: client.phone_number,
        }),
        startDate: scheduled_date,
        startTime: scheduledTimeNormalized,
        endTime: addMinutesToTime(scheduledTimeNormalized, manualMeetMinutes),
        // Attendees — these are what was missing, causing "Not provided" / no client guest
        clientEmail: clientEmailResolved || null,
        psychologistEmail: psychologist?.email || null,
      };
      
      // Try to use psychologist's OAuth credentials
      let userAuth = null;
      if (psychologist.google_calendar_credentials) {
        try {
          const credentials = typeof psychologist.google_calendar_credentials === 'string' 
            ? JSON.parse(psychologist.google_calendar_credentials) 
            : psychologist.google_calendar_credentials;
          
          const now = Date.now();
          const expiryDate = credentials.expiry_date;
          const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
          
          if (credentials.access_token) {
            if (!expiryDate || expiryDate > (now + bufferTime)) {
              userAuth = {
                access_token: credentials.access_token,
                refresh_token: credentials.refresh_token,
                expiry_date: credentials.expiry_date
              };
              console.log('✅ [MANUAL BOOKING] Using valid OAuth credentials');
            } else if (credentials.refresh_token) {
              userAuth = {
                access_token: credentials.access_token,
                refresh_token: credentials.refresh_token,
                expiry_date: credentials.expiry_date
              };
              console.log('⚠️ [MANUAL BOOKING] OAuth token expired, will attempt refresh');
            }
          }
        } catch (credError) {
          console.warn('⚠️ [MANUAL BOOKING] Error parsing OAuth credentials:', credError.message);
        }
      }

      meetUserAuth = userAuth;
      const meetResult = await meetLinkService.generateSessionMeetLink(sessionData, userAuth);
      
      if (meetResult.success && meetResult.meetLink && !meetResult.meetLink.includes('meet.google.com/new')) {
        meetData = {
          meetLink: meetResult.meetLink,
          eventId: meetResult.eventId,
          calendarLink: meetResult.eventLink || meetResult.calendarLink || null,
          method: meetResult.method
        };
        console.log('✅ [MANUAL BOOKING] Real Meet link created:', meetResult.method);
      } else {
        meetData = {
          meetLink: meetResult.meetLink || null,
          eventId: meetResult.eventId || null,
          calendarLink: meetResult.eventLink || meetResult.calendarLink || null,
          method: meetResult.method || 'fallback',
          requiresOAuth: meetResult.requiresOAuth || false
        };
        console.log('⚠️ [MANUAL BOOKING] Using fallback Meet link or OAuth required');
      }
    } catch (meetError) {
      console.error('❌ [MANUAL BOOKING] Meet link creation failed:', meetError);
      meetData = {
        meetLink: null,
        eventId: null,
        calendarLink: null,
        method: 'error'
      };
    }

    // ============================================
    // STEP 8: CREATE SESSION
    // ============================================
    const sessionData = {
      client_id: client.id,
      psychologist_id: psychologist_id,
      package_id: package_id || null,
      session_type: manualSessionType,
      session_count: manualSessionCount,
      package_session_number: manualPackageSessionNumber,
      scheduled_date: scheduled_date,
      scheduled_time: scheduledTimeNormalized,
      status: 'booked',
      payment_id: payment.id,
      price: amount,
      therapist_commission: therapist_commission ? parseFloat(therapist_commission) : 0,
      session_notes: notes || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      booking_created_at: new Date().toISOString(),
      original_scheduled_date: scheduled_date
    };

    // Add Meet data if available
          if (meetData && meetData.eventId) {
            sessionData.google_calendar_event_id = meetData.eventId;
            if (meetData.meetLink && !meetData.meetLink.includes('meet.google.com/new')) {
              sessionData.google_meet_link = meetData.meetLink;
              sessionData.google_meet_join_url = meetData.meetLink;
              sessionData.google_meet_start_url = meetData.meetLink;
            }
            if (meetData.calendarLink) {
              sessionData.google_calendar_link = meetData.calendarLink;
            }
          }

    const { data: createdSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (sessionError) {
      console.error('❌ [MANUAL BOOKING] Session creation failed:', sessionError);
      
      // Check for unique constraint violation (double booking)
        const isUniqueViolation = 
          sessionError.code === '23505' || 
          sessionError.message?.toLowerCase().includes('unique') || 
          sessionError.message?.toLowerCase().includes('duplicate') ||
          sessionError.hint?.toLowerCase().includes('unique');
        
        if (isUniqueViolation) {
        console.log('⚠️ [MANUAL BOOKING] Double booking detected');
        // Rollback payment
        if (paymentRecord) {
          await supabaseAdmin.from('payments').delete().eq('id', paymentRecord.id);
        }
          return res.status(409).json(
            errorResponse('This time slot was just booked by another user. Please select another time.')
          );
        }
        
      // Rollback payment on other errors
      if (paymentRecord) {
      await supabaseAdmin.from('payments').delete().eq('id', paymentRecord.id);
      }
      return res.status(500).json(
        errorResponse('Failed to create session')
      );
    }

    session = createdSession;
    console.log('✅ [MANUAL BOOKING] Session created:', session.id);

    // ============================================
    // STEP 8.5: CREATE WIX DISCOVERY MIRROR ROW
    // ============================================
    try {
      const manualMeetMinutes = resolveMeetMinutes();
      const syntheticWixBookingId = `admin_manual_${Date.now()}`;
      const wixMirrorRow = buildAdminManualWixMirror({
        syntheticWixBookingId,
        scheduledDate: scheduled_date,
        scheduledTime: scheduledTimeNormalized,
        durationMinutes: manualMeetMinutes,
        sessionType: manualSessionType,
        sessionCount: manualSessionCount,
        therapistName: `${psychologist.first_name || ''} ${psychologist.last_name || ''}`.trim(),
        therapistEmail: psychologist.email || null,
        therapistPhone: psychologist.phone || null,
        psychologistId: psychologist_id,
        client,
        amount,
        currency: 'INR',
        packageId: package_id || null,
        sessionId: session.id,
        title: psychologist.first_name ? `${psychologist.first_name} ${psychologist.last_name || ''}`.trim() : 'Manual booking',
        notes: notes || null,
      });

      wixMirrorRow.package_session_number = manualPackageSessionNumber;
      wixMirrorRow.payload.planSessionNumber = manualPackageSessionNumber;
      wixMirrorRow.payload.creditsAvailable = manualSessionCount;
      wixMirrorRow.payload.manualSessionStage = manualSessionStage;
      wixMirrorRow.payload.manualSessionLabel = getManualSessionLabel(
        manualSessionType,
        manualSessionStage,
        packageData,
        manualSessionCount
      );

      const { error: wixMirrorError } = await supabaseAdmin
        .from('wix_bookings')
        .insert([wixMirrorRow]);

      if (wixMirrorError) {
        console.warn('⚠️ [MANUAL BOOKING] Failed to create wix_bookings mirror row:', wixMirrorError.message);
      } else {
        const { error: linkSessionError } = await supabaseAdmin
          .from('sessions')
          .update({ wix_booking_id: syntheticWixBookingId })
          .eq('id', session.id);

        if (linkSessionError) {
          console.warn('⚠️ [MANUAL BOOKING] Failed to link session to wix_bookings mirror:', linkSessionError.message);
        } else {
          session.wix_booking_id = syntheticWixBookingId;
          console.log('✅ [MANUAL BOOKING] Wix discovery mirror created:', syntheticWixBookingId);
        }
      }
    } catch (wixMirrorCreateError) {
      console.warn('⚠️ [MANUAL BOOKING] Unexpected wix mirror creation error:', wixMirrorCreateError.message);
    }

    // ============================================
    // STEP 9: UPDATE AVAILABILITY
    // ============================================
    try {
      await availabilityService.updateAvailabilityOnBooking(
        psychologist_id,
        scheduled_date,
        scheduled_time
      );
      console.log('✅ [MANUAL BOOKING] Availability updated');
    } catch (blockErr) {
      console.warn('⚠️ [MANUAL BOOKING] Failed to update availability:', blockErr?.message);
      // Continue - availability update failure is not critical
    }

    // ============================================
    // STEP 10: UPDATE PAYMENT WITH SESSION ID
    // ============================================
    await supabaseAdmin
      .from('payments')
      .update({ session_id: session.id })
      .eq('id', payment.id);

    // ============================================
    // STEP 11: HANDLE CLIENT PACKAGE (if package booking)
    // ============================================
    if (package_id && packageData) {
      try {
        const { data: existingClientPackage } = await supabaseAdmin
          .from('client_packages')
          .select('*')
          .eq('client_id', client.id)
          .eq('package_id', package_id)
          .eq('status', 'active')
          .maybeSingle();

        const currentRemaining = existingClientPackage?.remaining_sessions ?? 0;
        const hasRemaining = currentRemaining > 0;

        if (existingClientPackage && hasRemaining) {
          // Atomic conditional update: decrement remaining_sessions only if > 0
          const { data: updatedPackage, error: updateError } = await supabaseAdmin
            .from('client_packages')
            .update({ remaining_sessions: currentRemaining - 1 })
            .eq('id', existingClientPackage.id)
            .gt('remaining_sessions', 0)
            .select('remaining_sessions')
            .single();

          if (updateError || !updatedPackage) {
            if (session) await supabaseAdmin.from('sessions').delete().eq('id', session.id);
            if (paymentRecord) await supabaseAdmin.from('payments').delete().eq('id', paymentRecord.id);
            return res.status(400).json(
              errorResponse('Package has no remaining sessions (race condition detected). Session and payment have been rolled back.')
            );
          }
          console.log('✅ [MANUAL BOOKING] Updated existing client package (atomic update successful)');
        } else {
          // No active package, or existing package exhausted: create new client_packages (new purchase)
          if (existingClientPackage && !hasRemaining) {
            console.log('ℹ️ [MANUAL BOOKING] Existing package exhausted; creating new client_packages (new purchase)');
          }
          const clientPackageData = {
            client_id: client.id,
            psychologist_id: psychologist_id,
            package_id: package_id,
            package_type: packageData.package_type,
            total_sessions: packageData.session_count,
            remaining_sessions: packageData.session_count - 1,
            total_amount: packageData.price,
            amount_paid: packageData.price,
            status: 'active',
            purchased_at: payment_received_date,
            first_session_id: session.id
          };

          await supabaseAdmin
            .from('client_packages')
            .insert([clientPackageData]);
          console.log('✅ [MANUAL BOOKING] Created new client package');
        }
      } catch (packageError) {
        console.error('❌ [MANUAL BOOKING] Error handling client package:', packageError);
        // Rollback session and payment creation to maintain consistency
        try {
          if (session) {
            await supabaseAdmin.from('sessions').delete().eq('id', session.id);
            console.log('✅ [MANUAL BOOKING] Rolled back session creation due to package error');
          }
          if (paymentRecord) {
            await supabaseAdmin.from('payments').delete().eq('id', paymentRecord.id);
            console.log('✅ [MANUAL BOOKING] Rolled back payment creation due to package error');
          }
        } catch (rollbackError) {
          console.error('❌ [MANUAL BOOKING] Error during rollback:', rollbackError);
        }
        return res.status(500).json(
          errorResponse('Failed to handle client package. Session and payment have been rolled back.')
        );
      }
    }

    // ============================================
    // STEP 12: SEND NOTIFICATIONS (non-blocking)
    // ============================================
    // Send notifications asynchronously - don't block response
    (async () => {
      const sessionTypeLabel = getManualSessionLabel(
        manualSessionType,
        manualSessionStage,
        packageData,
        manualSessionCount
      );
      // First session just booked: completedSessions = 0 so template shows "1 of N sessions booked"
      const packageInfoForNotification = manualSessionCount > 1
        ? {
            totalSessions: manualSessionCount,
            completedSessions: Math.max((manualPackageSessionNumber || 1) - 1, 0),
            remainingSessions: Math.max(manualSessionCount - (manualPackageSessionNumber || 1), 0),
            packageType: packageData?.package_type || (manualSessionType === 'couple' ? `couple_package_${manualSessionCount}` : `package_${manualSessionCount}`)
          }
        : null;
      const manualNotifyMeetMinutes = resolveMeetMinutes();

      try {
        // Email notifications
        const emailService = require('../utils/emailService');
      const emailClientName = `${client.first_name || ''} ${client.last_name || ''}`.trim() || 'Client';
      const psychologistName = `${psychologist.first_name} ${psychologist.last_name}`.trim();

      const emailResult = await emailService.sendSessionConfirmation({
        clientName: emailClientName,
        psychologistName: psychologistName,
        sessionDate: scheduled_date,
        sessionTime: scheduledTimeNormalized,
        sessionDuration: `${manualNotifyMeetMinutes} minutes`,
        clientEmail: client.user?.email,
        psychologistEmail: psychologist.email,
        googleMeetLink: meetData?.meetLink,
        meetLink: meetData?.meetLink,
        googleCalendarEventId: meetData?.eventId,
        sessionId: session.id,
        transactionId: transactionId,
        amount: amount,
        price: amount,
          status: 'booked',
        psychologistId: psychologist_id,
        clientId: client.id,
        packageInfo: packageInfoForNotification
      });
      if (emailResult?.clientEmailSent === true) {
        await writeSessionDeliveryMarkers(session.id, { email_sent_at: new Date().toISOString() });
      }
        console.log('✅ [MANUAL BOOKING] Email notifications sent');
    } catch (emailError) {
        console.error('❌ [MANUAL BOOKING] Email notification failed:', emailError);
    }

    try {
      // WhatsApp notifications via Interakt templates (same as Wix-flow bookings)
      const interaktService = require('../utils/interaktService');

      // Use the shared display-name resolver — handles "Not provided", "Pending" etc.
      const clientName = getClientDisplayName(client, 'Client');
      const psychologistName = `${psychologist.first_name} ${psychologist.last_name}`.trim();
      const meetLinkOrPending = meetData?.meetLink && !meetData.meetLink.includes('meet.google.com/new')
        ? meetData.meetLink
        : null;

      // Client → booking_confirmation_v1
      if (client.phone_number) {
        const res = await interaktService.sendBookingConfirmation(client.phone_number, {
          clientName,
          psychologistName,
          date: scheduled_date,
          time: scheduledTimeNormalized,
          meetLink: meetLinkOrPending,
        });
        if (res?.success) {
          await writeSessionDeliveryMarkers(session.id, { whatsapp_sent_at: new Date().toISOString() });
          console.log('✅ [MANUAL BOOKING] booking_confirmation_v1 sent to client');
        } else {
          console.warn('⚠️ [MANUAL BOOKING] booking_confirmation_v1 to client failed:', res?.error || res?.reason);
        }
      } else {
        console.log('ℹ️ [MANUAL BOOKING] No client phone — skipping client WhatsApp');
      }

      // Psychologist → therapistconfirmation
      if (psychologist.phone) {
        const res = await interaktService.sendSessionNotificationPsychologist(psychologist.phone, {
          therapistName: psychologistName,
          clientName,
          date: scheduled_date,
          time: scheduledTimeNormalized,
          meetLink: meetLinkOrPending,
        });
        if (res?.success) {
          console.log('✅ [MANUAL BOOKING] session_notification_psychologist sent to therapist');
        } else {
          console.warn('⚠️ [MANUAL BOOKING] session_notification_psychologist to therapist failed:', res?.error || res?.reason);
        }
      } else {
        console.log('ℹ️ [MANUAL BOOKING] No therapist phone — skipping therapist WhatsApp');
      }
    } catch (whatsappError) {
      console.error('❌ [MANUAL BOOKING] WhatsApp notification failed:', whatsappError);
    }

      // Check for immediate reminder
      try {
        const sessionReminderService = require('../services/sessionReminderService');
        sessionReminderService.checkAndSendReminderForSessionId(session.id).catch(err => {
          console.error('❌ [MANUAL BOOKING] Reminder check failed:', err);
        });
      } catch (reminderError) {
        console.error('❌ [MANUAL BOOKING] Reminder check error:', reminderError);
      }
    })();

    // ============================================
    // STEP 13: FETCH COMPLETE SESSION FOR RESPONSE
    // ============================================
    const { data: completeSession } = await supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          phone_number,
          user:users(email)
        ),
        psychologist:psychologists!sessions_psychologist_id_fkey(
          id,
          first_name,
          last_name,
          email
        ),
        package:packages(*)
      `)
      .eq('id', session.id)
      .single();

    console.log('✅ [MANUAL BOOKING] Manual booking created successfully');

    // Return success response
    return res.status(201).json(
      successResponse(completeSession || session, 'Manual booking created successfully')
    );

  } catch (error) {
    console.error('❌ [MANUAL BOOKING] Unexpected error:', error);

    // Rollback any created resources
    if (session) {
      try {
        await supabaseAdmin.from('sessions').delete().eq('id', session.id);
        console.log('🔄 [MANUAL BOOKING] Rolled back session');
      } catch (rollbackError) {
        console.error('❌ [MANUAL BOOKING] Failed to rollback session:', rollbackError);
      }
    }

    if (paymentRecord) {
      try {
        await supabaseAdmin.from('payments').delete().eq('id', paymentRecord.id);
        console.log('🔄 [MANUAL BOOKING] Rolled back payment');
      } catch (rollbackError) {
        console.error('❌ [MANUAL BOOKING] Failed to rollback payment:', rollbackError);
      }
    }

    if (meetData?.eventId) {
      try {
        const meetLinkService = require('../utils/meetLinkService');
        const delResult = await meetLinkService.deleteCalendarEvent(meetData.eventId, meetUserAuth);
        if (!delResult.success) {
          console.error('❌ [MANUAL BOOKING] Failed to delete calendar event on rollback:', delResult.error);
        } else {
          console.log('🔄 [MANUAL BOOKING] Rolled back calendar event');
        }
      } catch (calendarRollbackError) {
        console.error('❌ [MANUAL BOOKING] Error deleting calendar event on rollback:', calendarRollbackError);
      }
    }

    return res.status(500).json(
      errorResponse('Internal server error while creating manual booking')
    );
  }
};

// Create record-only booking (admin only): add session record only, no Meet creation, no notifications.
// Use when the meeting was created elsewhere (e.g. another email). Optional meet_link can be pasted.
const createRecordOnlyBooking = async (req, res) => {
  let paymentRecord = null;
  let session = null;

  try {
    const {
      client_id,
      psychologist_id,
      package_id,
      scheduled_date,
      scheduled_time,
      amount,
      therapist_commission,
      payment_received_date,
      payment_method,
      receipt_url,
      payment_screenshot_url,
      notes,
      meet_link,
      status: bodyStatus
    } = req.body;

    if (!client_id || !psychologist_id || !scheduled_date || !scheduled_time || !amount) {
      return res.status(400).json(
        errorResponse('Missing required fields: client_id, psychologist_id, scheduled_date, scheduled_time, amount')
      );
    }

    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json(
        errorResponse('Invalid amount: must be a positive number')
      );
    }

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(scheduled_date)) {
      return res.status(400).json(
        errorResponse('Invalid scheduled_date format. Expected YYYY-MM-DD')
      );
    }
    const [y, m, d] = scheduled_date.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    if (isNaN(dateObj.getTime()) || dateObj.getUTCFullYear() !== y || dateObj.getUTCMonth() !== m - 1 || dateObj.getUTCDate() !== d) {
      return res.status(400).json(
        errorResponse('Invalid scheduled_date: not a valid date')
      );
    }

    const timePart = String(scheduled_time).trim().split(':').slice(0, 2).join(':');
    const timePattern = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timePattern.test(timePart)) {
      return res.status(400).json(
        errorResponse('Invalid scheduled_time format. Expected HH:MM in 24-hour format')
      );
    }
    const scheduledTimeNormalized = timePart;

    const paymentReceivedDate = payment_received_date || new Date().toISOString().slice(0, 10);

    // Resolve client (by id or user_id)
    const clientIdForQuery = isNaN(client_id) ? client_id : parseInt(client_id);
    let { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('*, user:users(email)')
      .eq('id', clientIdForQuery)
      .single();

    if (clientError || !client) {
      const { data: clientByUserId } = await supabaseAdmin
        .from('clients')
        .select('*, user:users(email)')
        .eq('user_id', clientIdForQuery)
        .single();
      if (clientByUserId) client = clientByUserId;
      else {
        return res.status(404).json(
          errorResponse(`Client not found with id or user_id: ${client_id}`)
        );
      }
    }

    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email')
      .eq('id', psychologist_id)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    let packageData = null;
    if (package_id) {
      const { data: pkg, error: packageError } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('id', package_id)
        .single();
      if (packageError || !pkg) {
        return res.status(404).json(
          errorResponse('Package not found')
        );
      }
      packageData = pkg;
    }

    // Create payment record
    const transactionId = `RECORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const normalizedPaymentMethod = (payment_method || 'cash').toLowerCase();
    const normalizedReceiptUrl =
      (typeof receipt_url === 'string' && receipt_url.trim()) ||
      (typeof payment_screenshot_url === 'string' && payment_screenshot_url.trim()) ||
      null;

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .insert({
        transaction_id: transactionId,
        session_id: null,
        psychologist_id: psychologist_id,
        client_id: client.id,
        package_id: package_id || null,
        amount: amount,
        session_type: packageData ? 'package' : 'individual',
        status: 'success',
        payment_method: normalizedPaymentMethod,
        receipt_url: normalizedReceiptUrl,
        razorpay_params: {
          notes: {
            record_only: true,
            payment_method: normalizedPaymentMethod,
            admin_created: true,
            created_by: req.user?.id,
            created_at: new Date().toISOString(),
            payment_received_date: paymentReceivedDate,
            payment_screenshot_uploaded: Boolean(normalizedReceiptUrl)
          }
        },
        completed_at: paymentReceivedDate,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (paymentError) {
      return res.status(500).json(
        errorResponse('Failed to create payment record')
      );
    }
    paymentRecord = payment;

    // Session data: no Meet creation; use meet_link from body if provided
    const allowedStatuses = ['booked', 'completed', 'cancelled', 'no_show', 'rescheduled', 'refund_request'];
    const sessionStatus = (bodyStatus && allowedStatuses.includes(String(bodyStatus).toLowerCase()))
      ? String(bodyStatus).toLowerCase()
      : 'booked';

    const sessionData = {
      client_id: client.id,
      psychologist_id: psychologist_id,
      package_id: package_id || null,
      scheduled_date: scheduled_date,
      scheduled_time: scheduledTimeNormalized,
      status: sessionStatus,
      payment_id: payment.id,
      price: amount,
      source: 'admin_manual',
      therapist_commission: therapist_commission ? parseFloat(therapist_commission) : 0,
      session_notes: notes || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      booking_created_at: new Date().toISOString(),
      original_scheduled_date: scheduled_date
    };

    const meetLinkTrimmed = typeof meet_link === 'string' ? meet_link.trim() : '';
    if (meetLinkTrimmed && meetLinkTrimmed.length > 0) {
      sessionData.google_meet_link = meetLinkTrimmed;
      sessionData.google_meet_join_url = meetLinkTrimmed;
      sessionData.google_meet_start_url = meetLinkTrimmed;
    }

    const { data: createdSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (sessionError) {
      if (paymentRecord) {
        await supabaseAdmin.from('payments').delete().eq('id', paymentRecord.id);
      }
      const isUniqueViolation =
        sessionError.code === '23505' ||
        sessionError.message?.toLowerCase().includes('unique') ||
        sessionError.message?.toLowerCase().includes('duplicate');
      if (isUniqueViolation) {
        return res.status(409).json(
          errorResponse('This time slot was just booked. Please select another time.')
        );
      }
      return res.status(500).json(
        errorResponse('Failed to create session')
      );
    }
    session = createdSession;

    await supabaseAdmin
      .from('payments')
      .update({ session_id: session.id })
      .eq('id', payment.id);

    // Update client_packages if package booking (keep counts correct)
    if (package_id && packageData) {
      const { data: existingClientPackage } = await supabaseAdmin
        .from('client_packages')
        .select('*')
        .eq('client_id', client.id)
        .eq('package_id', package_id)
        .eq('status', 'active')
        .maybeSingle();

      const currentRemaining = existingClientPackage?.remaining_sessions ?? 0;
      const hasRemaining = currentRemaining > 0;

      if (existingClientPackage && hasRemaining) {
        await supabaseAdmin
          .from('client_packages')
          .update({ remaining_sessions: currentRemaining - 1 })
          .eq('id', existingClientPackage.id)
          .gt('remaining_sessions', 0);
      } else {
        const clientPackageData = {
          client_id: client.id,
          psychologist_id: psychologist_id,
          package_id: package_id,
          package_type: packageData.package_type,
          total_sessions: packageData.session_count,
          remaining_sessions: packageData.session_count - 1,
          total_amount: packageData.price,
          amount_paid: packageData.price,
          status: 'active',
          purchased_at: paymentReceivedDate,
          first_session_id: session.id
        };
        await supabaseAdmin
          .from('client_packages')
          .insert([clientPackageData]);
      }
    }

    // Create wix_bookings mirror so this record appears on the Wix Discovery page
    try {
      const syntheticWixBookingId = `admin_manual_${Date.now()}`;
      const sessionType = package_id && packageData
        ? (packageData.package_type?.includes('couple') ? 'couple' : 'package')
        : 'individual';
      const sessionCount = packageData?.session_count || 1;

      const wixMirrorRow = buildAdminManualWixMirror({
        syntheticWixBookingId,
        scheduledDate: scheduled_date,
        scheduledTime: scheduledTimeNormalized,
        durationMinutes: 50,
        sessionType,
        sessionCount,
        therapistName: `${psychologist.first_name || ''} ${psychologist.last_name || ''}`.trim(),
        therapistEmail: psychologist.email || null,
        psychologistId: psychologist_id,
        client,
        amount,
        currency: 'INR',
        packageId: package_id || null,
        sessionId: session.id,
        title: `${psychologist.first_name || ''} ${psychologist.last_name || ''}`.trim() || 'Record-only booking',
        notes: notes || null,
      });
      wixMirrorRow.status = sessionStatus;
      wixMirrorRow.payload.status = sessionStatus;

      const { error: mirrorErr } = await supabaseAdmin.from('wix_bookings').insert([wixMirrorRow]);
      if (mirrorErr) {
        console.warn('⚠️ [RECORD ONLY] Failed to create wix_bookings mirror:', mirrorErr.message);
      } else {
        await supabaseAdmin.from('sessions').update({ wix_booking_id: syntheticWixBookingId }).eq('id', session.id);
        console.log('✅ [RECORD ONLY] Wix discovery mirror created:', syntheticWixBookingId);
      }
    } catch (mirrorCreateErr) {
      console.warn('⚠️ [RECORD ONLY] Unexpected wix mirror error:', mirrorCreateErr.message);
    }

    const { data: completeSession } = await supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(id, first_name, last_name, child_name, phone_number, user:users(email)),
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email),
        package:packages(*)
      `)
      .eq('id', session.id)
      .single();

    return res.status(201).json(
      successResponse(completeSession || session, 'Session record added successfully')
    );
  } catch (error) {
    console.error('❌ [RECORD ONLY] Unexpected error:', error);
    if (session) {
      try {
        await supabaseAdmin.from('sessions').delete().eq('id', session.id);
      } catch (_) {}
    }
    if (paymentRecord) {
      try {
        await supabaseAdmin.from('payments').delete().eq('id', paymentRecord.id);
      } catch (_) {}
    }
    return res.status(500).json(
      errorResponse('Internal server error while adding session record')
    );
  }
};

// ============================================
// STUB FUNCTIONS - Need to be restored from backup
// ============================================
// These are minimal implementations to allow server to start
// Full implementations need to be restored

const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 50, role, search } = req.query;
    const offset = (page - 1) * limit;

    // Light mode: skip the expensive `count: 'exact'` (which scans every matching row —
    // ~400ms on 13k+ clients). Callers that only need the rows (e.g. the manual-booking
    // client-search dropdown) pass ?light=1 and get a ~7x faster response.
    const lightMode = req.query.light === '1' || req.query.light === 'true' || req.query.count === 'none';
    const clientSelectCols = `
          id,
          first_name,
          last_name,
          phone_number,
          child_name,
          child_age,
          created_at,
          user_id
        `;

    // For clients, we need to join with the clients table to get name information
    if (role === 'client') {
      // Query clients table first, then fetch user emails separately (no FK embed)
      let query = lightMode
        ? supabaseAdmin.from('clients').select(clientSelectCols)
        : supabaseAdmin.from('clients').select(clientSelectCols, { count: 'exact' });

      if (search) {
        const escapedSearch = escapeLike(search);
        let emailMatchedUserIds = [];
        // Emails never contain spaces, so a multi-word search can't match one — skip the
        // extra email lookup query entirely in that case (one less full scan).
        const skipEmailLookup = /\s/.test(search);
        // Cap email matches: each id becomes a 36-char UUID inside the `.or()` filter,
        // so a broad search (e.g. "a") that matches hundreds of emails would build a
        // multi-KB query string and the PostgREST request fails (500). 100 keeps the
        // URL small; specific searches (full email/name) match far fewer than the cap.
        const { data: matchedUsers, error: matchedUsersError } = skipEmailLookup
          ? { data: [], error: null }
          : await supabaseAdmin
              .from('users')
              .select('id')
              .ilike('email', `%${escapedSearch}%`)
              .limit(100);

        if (matchedUsersError) {
          console.warn('[admin.getAllUsers] client email search lookup failed:', matchedUsersError.message);
        } else {
          emailMatchedUserIds = (matchedUsers || []).map((row) => row.id).filter(Boolean);
        }

        const searchTerms = [
          `first_name.ilike.%${escapedSearch}%`,
          `last_name.ilike.%${escapedSearch}%`,
          `child_name.ilike.%${escapedSearch}%`,
        ];

        // Multi-word search (e.g. "abhishek ravi"): match first token against
        // first_name AND the rest against last_name (and the reverse), so a full
        // "first last" name is found even though no single column holds the whole string.
        const parts = escapedSearch.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          const head = parts[0];
          const tail = parts.slice(1).join(' ');
          searchTerms.push(`and(first_name.ilike.%${head}%,last_name.ilike.%${tail}%)`);
          searchTerms.push(`and(first_name.ilike.%${tail}%,last_name.ilike.%${head}%)`);
        }

        if (emailMatchedUserIds.length > 0) {
          searchTerms.push(`user_id.in.(${emailMatchedUserIds.join(',')})`);
        }

        query = query.or(searchTerms.join(','));
      }

      query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false });

      const { data, error, count } = await query;

      if (error) {
        console.error('Error fetching clients:', error);
        return res.status(500).json(errorResponse(`Failed to fetch users: ${error.message || error.code || 'unknown'}`));
      }

      // Fetch user details separately to avoid PostgREST FK embed requirement
      const userIds = (data || []).map(c => c.user_id).filter(Boolean);
      const userMap = new Map();
      if (userIds.length) {
        const { data: usersData } = await supabaseAdmin
          .from('users')
          .select('id, email, role, profile_picture_url, created_at')
          .in('id', userIds);
        (usersData || []).forEach(u => userMap.set(u.id, u));
      }

      // Transform the data to match expected format
      const transformedUsers = (data || []).map(client => {
        const user = userMap.get(client.user_id) || {};
        return {
          id: user.id || client.user_id,
          client_id: client.id,
          email: user.email || '',
          role: user.role || 'client',
          profile_picture_url: user.profile_picture_url || null,
          created_at: user.created_at || client.created_at,
          profile: {
            first_name: client.first_name || '',
            last_name: client.last_name || '',
            phone_number: client.phone_number || null,
            child_name: client.child_name || null,
            child_age: client.child_age || null,
            client_id: client.id
          },
          name: client.first_name && client.last_name
            ? `${client.first_name} ${client.last_name}`.trim()
            : client.first_name || client.child_name || 'No Name'
        };
      });
      
      return res.json(successResponse({ 
        users: transformedUsers, 
        total: count, 
        page: parseInt(page), 
        limit: parseInt(limit),
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil((count || 0) / parseInt(limit))
        }
      }));
    } else {
      // For non-client roles, query users table directly
      let query = supabaseAdmin.from('users').select('*', { count: 'exact' });
      
      if (role) query = query.eq('role', role);
      if (search) {
        const escapedSearch = escapeLike(search);
        query = query.or(`email.ilike.%${escapedSearch}%`);
      }
      
      query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false });
      
      const { data, error, count } = await query;
      
      if (error) {
        return res.status(500).json(errorResponse('Failed to fetch users'));
      }
      
      // Transform users to include name field
      const transformedUsers = (data || []).map(user => ({
        ...user,
        name: user.first_name && user.last_name 
          ? `${user.first_name} ${user.last_name}`.trim()
          : user.first_name || user.email?.split('@')[0] || 'No Name'
      }));
      
      return res.json(successResponse({ 
        users: transformedUsers, 
        total: count, 
        page: parseInt(page), 
        limit: parseInt(limit),
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil((count || 0) / parseInt(limit))
        }
      }));
    }
  } catch (error) {
    console.error('Get all users error:', error);
    return res.status(500).json(errorResponse('Internal server error'));
  }
};

const getUserDetails = async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabaseAdmin.from('users').select('*').eq('id', userId).single();
    if (error || !data) {
      return res.status(404).json(errorResponse('User not found'));
    }
    return res.json(successResponse(data));
  } catch (error) {
    return res.status(500).json(errorResponse('Internal server error'));
  }
};

const updateUserRole = async (req, res) => {
  try {
    const { userId } = req.params;
    const { new_role } = req.body;

    if (!new_role || !['client', 'psychologist', 'admin', 'superadmin', 'finance'].includes(new_role)) {
      return res.status(400).json(
        errorResponse('Valid new role is required')
      );
    }

    // CRITICAL FIX: TOCTOU protection - Re-verify admin role from DB before operation
    const { data: freshAdminUser } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (!freshAdminUser || (freshAdminUser.role !== 'admin' && freshAdminUser.role !== 'superadmin')) {
      return res.status(403).json(
        errorResponse('Privilege revoked. Admin access required.')
      );
    }

    // Check if user exists
    // Use supabaseAdmin to bypass RLS (admin endpoint, proper auth already checked)
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('role, email')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json(
        errorResponse('User not found')
      );
    }

    // Prevent changing superadmin role
    if (user.role === 'superadmin') {
      return res.status(403).json(
        errorResponse('Cannot change superadmin role')
      );
    }

    // Update user role
    // Use supabaseAdmin to bypass RLS (admin endpoint, proper auth already checked)
    const { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update({
        role: new_role,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select('id, email, role, updated_at')
      .single();

    if (error) {
      console.error('Update user role error:', error);
      return res.status(500).json(
        errorResponse('Failed to update user role')
      );
    }

    // Audit log the role change
    const auditLogger = require('../utils/auditLogger');
    await auditLogger.logRequest(req, 'UPDATE_USER_ROLE', 'user', userId, {
      oldRole: user.role,
      newRole: new_role,
      targetUserEmail: user.email
    });

    // If role is being changed to/from admin, revoke all user tokens for security
    if (user.role === 'admin' || new_role === 'admin' || user.role === 'superadmin' || new_role === 'superadmin') {
      const tokenRevocationService = require('../utils/tokenRevocation');
      await tokenRevocationService.revokeUserTokens(userId);
      console.log(`🔒 Revoked all tokens for user ${userId} due to role change`);
    }

    res.json(
      successResponse(updatedUser, 'User role updated successfully')
    );

  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating user role')
    );
  }
};

const deactivateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    const auditLogger = require('../utils/auditLogger');
    const tokenRevocationService = require('../utils/tokenRevocation');

    // CRITICAL FIX: TOCTOU protection - Re-verify admin role from DB before operation
    const { data: freshAdminUser } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (!freshAdminUser || (freshAdminUser.role !== 'admin' && freshAdminUser.role !== 'superadmin')) {
      return res.status(403).json(
        errorResponse('Privilege revoked. Admin access required.')
      );
    }

    // Check if user exists
    // Use supabaseAdmin to bypass RLS (admin endpoint, proper auth already checked)
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('role, email')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json(
        errorResponse('User not found')
      );
    }

    // Prevent deactivating superadmin
    if (user.role === 'superadmin') {
      return res.status(403).json(
        errorResponse('Cannot deactivate superadmin')
      );
    }

    // Revoke all tokens for the deactivated user
    await tokenRevocationService.revokeUserTokens(userId);

    // Deactivate user: set is_active false so auth can reject revoked tokens
    // Use supabaseAdmin to bypass RLS (admin endpoint, proper auth already checked)
    const { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select('id, email, role, is_active, updated_at')
      .single();

    if (error) {
      console.error('Deactivate user error:', error);
      return res.status(500).json(
        errorResponse('Failed to deactivate user')
      );
    }

    // Audit log the deactivation
    await auditLogger.logRequest(req, 'DEACTIVATE_USER', 'user', userId, {
      reason: reason || 'No reason provided',
      targetUserEmail: user.email,
      targetUserRole: user.role
    });

    res.json(
      successResponse(updatedUser, 'User deactivated successfully')
    );

  } catch (error) {
    console.error('Deactivate user error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deactivating user')
    );
  }
};

const getPlatformStats = async (req, res) => {
  try {
    const start_date = req.query.start_date;
    const end_date = req.query.end_date;

    // Today in IST calendar (matches Wix / finance dashboards for India site)
    const today = getCalendarYmdInTimeZone(new Date().toISOString(), 'Asia/Kolkata');

    const bookingTimeCol = await getBookingTimeColumnKey(supabaseAdmin);

    const sessionsNoFreeSelect = () =>
      supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true })
        .neq('session_type', 'free_assessment')
        .neq('status', 'cancelled'); // Exclude soft-deleted sessions

    // Rule (matches finance/therapist dashboards):
    //   • Total bookings  → booking_created_at in range  (when the booking was made)
    //   • Status-based   → scheduled_date in range       (which sessions are in this period)
    //   • Cancelled      → booking_created_at in range   (cancellation is a booking event)
    /** Date-filter by booking creation date (used by Total Bookings and Cancelled). */
    const applyBookingDayRange = (q) => {
      let x = q;
      if (start_date) x = x.gte(bookingTimeCol, `${start_date}T00:00:00.000+05:30`);
      if (end_date) x = x.lte(bookingTimeCol, `${end_date}T23:59:59.999+05:30`);
      return x;
    };

    /** Date-filter by scheduled_date (used by Upcoming / Completed / Rescheduled / NoShow). */
    const applyScheduledDayRange = (q) => {
      let x = q;
      if (start_date) x = x.gte('scheduled_date', start_date);
      if (end_date) x = x.lte('scheduled_date', end_date);
      return x;
    };

    const scopedSessions = applyBookingDayRange(sessionsNoFreeSelect());

    // Count clients & psychologists unchanged (lifetime); session metrics respect date range when provided.
    const [clientsCount, psychologistsCount, sessionsCountAgg] = await Promise.all([
      supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('psychologists').select('id', { count: 'exact', head: true }),
      start_date || end_date ? scopedSessions : sessionsNoFreeSelect(),
    ]);

    /** Count sessions by status, filtered by scheduled_date (in-range == happening this month). */
    const countByScheduledDate = async (build) => {
      const base = sessionsNoFreeSelect();
      let q = build(base);
      q = applyScheduledDayRange(q);
      const { count } = await q;
      return count ?? 0;
    };

    // Cancelled — own base query (default base excludes cancelled), filtered by booking_created_at
    const countCancelled = async () => {
      let q = supabaseAdmin
        .from('sessions')
        .select('id', { count: 'exact', head: true })
        .neq('session_type', 'free_assessment')
        .eq('status', 'cancelled');
      if (start_date) q = q.gte('booking_created_at', `${start_date}T00:00:00.000+05:30`);
      if (end_date)   q = q.lte('booking_created_at', `${end_date}T23:59:59.999+05:30`);
      const { count } = await q;
      return count ?? 0;
    };

    const [
      completedN,
      rescheduledN,
      pendingN,
      noShowN,
      upcomingN,
      cancelledN,
    ] = await Promise.all([
      // Completed sessions whose scheduled_date is in range
      countByScheduledDate((b) => b.eq('status', 'completed')),
      // Rescheduled sessions whose (new) scheduled_date is in range
      countByScheduledDate((b) => b.eq('status', 'rescheduled')),
      // Pending = booked/rescheduled whose scheduled_date already passed (within range)
      countByScheduledDate((b) => b.in('status', ['booked', 'scheduled', 'rescheduled', 'reschedule_requested', 'confirmed']).lt('scheduled_date', today)),
      // No-show sessions whose scheduled_date is in range
      countByScheduledDate((b) => b.in('status', ['no_show', 'noshow'])),
      // Upcoming = booked/rescheduled whose scheduled_date is in range and not yet past
      countByScheduledDate((b) => b.in('status', ['booked', 'rescheduled']).gte('scheduled_date', today)),
      countCancelled(),
    ]);

    const bookingStatuses = {
      upcoming: upcomingN,
      rescheduled: rescheduledN,
      pending: pendingN,
      completed: completedN,
      noShow: noShowN,
      cancelled: cancelledN,
    };

    return res.json(successResponse({
      totalUsers: clientsCount.count || 0,
      totalClients: clientsCount.count || 0,
      totalPsychologists: psychologistsCount.count || 0,
      totalDoctors: psychologistsCount.count || 0,
      totalSessions: sessionsCountAgg.count || 0,
      totalBookings: sessionsCountAgg.count || 0,
      bookingStatuses,
    }));
  } catch (error) {
    console.error('Error getting platform stats:', error);
    return res.status(500).json(errorResponse('Internal server error'));
  }
};

const searchUsers = async (req, res) => {
  try {
    // HIGH-RISK FIX: Parameter pollution defense - normalize query params (reject arrays)
    const normalizeParam = (param) => {
      if (Array.isArray(param)) {
        return null; // Reject arrays
      }
      return param;
    };

    const searchQuery = normalizeParam(req.query.query);
    const page = normalizeParam(req.query.page) || 1;
    const limit = normalizeParam(req.query.limit) || 10;
    const role = normalizeParam(req.query.role);

    if (Array.isArray(req.query.query) || Array.isArray(req.query.role)) {
      return res.status(400).json(
        errorResponse('Invalid query parameters. Arrays not allowed.')
      );
    }

    if (!searchQuery) {
      return res.status(400).json(
        errorResponse('Search query is required')
      );
    }

    // Use supabaseAdmin to bypass RLS (admin endpoint, proper auth already checked)
    let supabaseQuery = supabaseAdmin
      .from('users')
      .select(`
        id,
        email,
        role,
        profile_picture_url,
        created_at,
        updated_at
      `, { count: 'exact' });

    // Filter by role if provided
    if (role) {
      supabaseQuery = supabaseQuery.eq('role', role);
    }

    // Filter by search query using database-level filtering
    if (searchQuery) {
      const escapedSearch = escapeLike(searchQuery);
      supabaseQuery = supabaseQuery.or(`email.ilike.%${escapedSearch}%,role.ilike.%${escapedSearch}%`);
    }

    // Add pagination at database level
    const offset = (page - 1) * limit;
    supabaseQuery = supabaseQuery.range(offset, offset + limit - 1);

    const { data: users, error, count } = await supabaseQuery;

    if (error) {
      console.error('Search users error:', error);
      return res.status(500).json(
        errorResponse('Failed to search users')
      );
    }

    res.json(
      successResponse({
        users: users || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0
        }
      })
    );

  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json(
      errorResponse('Internal server error while searching users')
    );
  }
};

const getRecentUsers = async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('users').select('id, email, name, created_at').order('created_at', { ascending: false }).limit(10);
    return res.json(successResponse(data || []));
  } catch (error) {
    return res.status(500).json(errorResponse('Internal server error'));
  }
};

const getRecentBookings = async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('sessions').select('*').order('created_at', { ascending: false }).limit(10);
    return res.json(successResponse(data || []));
  } catch (error) {
    return res.status(500).json(errorResponse('Internal server error'));
  }
};

const getAllPsychologists = async (req, res) => {
  try {
    let data = null;
    let error = null;

    // Primary sort for environments that have display_order.
    ({ data, error } = await supabaseAdmin
      .from('psychologists')
      .select('*')
      .order('display_order', { ascending: true, nullsLast: true }));

    // Fallback for DBs where display_order column does not exist.
    if (error && String(error.message || '').includes('display_order')) {
      console.warn('display_order column missing; falling back to first_name ordering for psychologists list');
      ({ data, error } = await supabaseAdmin
        .from('psychologists')
        .select('*')
        .order('first_name', { ascending: true }));
    }

    if (error) {
      console.error('Error fetching psychologists:', error);
      return res.status(500).json(errorResponse('Failed to fetch psychologists'));
    }
    
    // Transform data to include name field for easier frontend consumption
    const transformedData = (data || []).map(psychologist => {
      const firstName = psychologist.first_name || '';
      const lastName = psychologist.last_name || '';
      const fullName = `${firstName} ${lastName}`.trim() || psychologist.email?.split('@')[0] || 'No Name';
      
      const { google_calendar_credentials, ...safePsychologist } = psychologist;

      return {
        ...safePsychologist,
        name: fullName,
        psychologist_id: psychologist.id, // Add psychologist_id for compatibility
        id: psychologist.id,
        google_calendar_connected: !!google_calendar_credentials
      };
    });
    
    console.log(`✅ [ADMIN] Fetched ${transformedData.length} psychologists`);
    return res.json(successResponse(transformedData));
  } catch (error) {
    console.error('Error in getAllPsychologists:', error);
    return res.status(500).json(errorResponse('Internal server error'));
  }
};

const createPsychologist = async (req, res) => {
  try {
    console.log('=== createPsychologist function called ===');
    console.log('Request body:', req.body);
    let { 
      email, 
      password, 
      first_name, 
      last_name, 
      phone, 
      ug_college, 
      pg_college, 
      mphil_college,
      phd_college, 
      area_of_expertise, 
      description,
      designation,
      experience_years, 
      availability,
      packages, // New field for dynamic packages
      price, // Individual session price
      cover_image_url, // Doctor's profile image
      personality_traits, // NEW: array of strings like ['Happy','Energetic']
      display_order, // Display order for sorting
      faq_question_1,
      faq_answer_1,
      faq_question_2,
      faq_answer_2,
      faq_question_3,
      faq_answer_3,
      psychiatrist_15min_price,
      psychiatrist_30min_price,
      specialist_category,
      child_specialist_pricing,
      better_parent_pricing,
      wix_staff_id
    } = req.body;

    // Keep email as-is (don't normalize dots away)
    if (typeof email === 'string') {
      email = email.trim().toLowerCase();
    }

    // Force fixed password for all new doctor accounts
    password = 'Koott@#2026';

    // Check if psychologist already exists with this email
    const { data: existingPsychologist } = await supabaseAdmin
      .from('psychologists')
      .select('id')
      .eq('email', email)
      .single();

    if (existingPsychologist) {
      return res.status(400).json(
        errorResponse('Psychologist with this email already exists')
      );
    }

    // Validate password before hashing
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json(
        errorResponse('Password does not meet requirements', passwordValidation.errors)
      );
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    const isPsychiatrist = (designation || '').toLowerCase().includes('psychiatrist');

    // Price is OPTIONAL when creating a doctor — only name, email and phone are required.
    // If provided it must be a positive number; if omitted it defaults to 0 (unset) and the
    // admin can set the real price later via edit. Defaulting to 0 (not null) avoids any
    // NOT NULL constraint on psychologists.individual_session_price / packages.price.
    let individualSessionPrice = 0;
    if (price !== undefined && price !== null && String(price).trim() !== '') {
      const parsedPrice = parseInt(price, 10);
      if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
        return res.status(400).json(
          errorResponse('If provided, individual session price must be a valid non-negative number.')
        );
      }
      individualSessionPrice = parsedPrice;
    }

    const specialistCategoryValue =
      specialist_category === 'child_specialist' || specialist_category === 'better_parent'
        ? specialist_category
        : null;

    // Create psychologist directly in psychologists table (standalone) - after validation passes.
    // NOTE: only insert columns that actually exist on the psychologists table. Individual
    // session price is NOT a column here — it's stored on the linked `packages` row below.
    // Optional fields (college/faq/personality/display_order/psychiatrist pricing/etc.) are
    // not columns on this table and are intentionally omitted.
    const psychInsert = {
      email,
      password_hash: hashedPassword,
      first_name,
      last_name,
      phone,
      area_of_expertise: area_of_expertise || null,
      description: description || null,
      designation: designation?.trim() || null,
      experience_years: experience_years || 0,
      cover_image_url: cover_image_url || null,
      wix_staff_id: wix_staff_id || null,
    };
    // child_specialist_pricing exists on the table — include it only when provided.
    if (child_specialist_pricing != null) {
      psychInsert.child_specialist_pricing = child_specialist_pricing;
    }

    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .insert([psychInsert])
      .select('*')
      .single();

    if (psychologistError) {
      console.error('Psychologist creation error:', psychologistError);
      const createMsg = String(psychologistError.message || '').toLowerCase();
      if (psychologistError.code === '23505' || createMsg.includes('duplicate') || createMsg.includes('unique')) {
        return res.status(400).json(
          errorResponse('Psychologist with this email already exists')
        );
      }
      return res.status(500).json(
        errorResponse('Failed to create psychologist')
      );
    }

    // NOTE: packages table has no discount_percentage column — do not insert it.
    const individualSession = {
      psychologist_id: psychologist.id,
      package_type: 'individual',
      name: 'Single Session',
      description: 'One therapy session',
      session_count: 1,
      price: individualSessionPrice,
    };

    const { error: individualSessionError } = await supabaseAdmin
      .from('packages')
      .insert([individualSession]);

    if (individualSessionError) {
      console.error('❌ Error creating individual session package:', individualSessionError);
      const { error: deleteError } = await supabaseAdmin
        .from('psychologists')
        .delete()
        .eq('id', psychologist.id);

      if (deleteError) {
        console.error('❌ Error rolling back psychologist creation:', deleteError);
      } else {
        console.log('✅ Rolled back psychologist creation due to package creation failure');
      }

      return res.status(500).json(
        errorResponse('Failed to create individual session package')
      );
    }
    console.log('✅ Individual session package created');

    // Create dynamic packages for the psychologist based on admin selection
    if (packages && Array.isArray(packages) && packages.length > 0) {
      try {
        console.log('📦 Creating custom packages:', packages);
        
        // NOTE: packages table has no discount_percentage column — do not insert it.
        const packageData = packages.map(pkg => ({
          psychologist_id: psychologist.id,
          package_type: pkg.package_type || `package_${pkg.session_count}`,
          name: pkg.name || `Package of ${pkg.session_count} Sessions`,
          description: pkg.description || `${pkg.session_count} therapy sessions${pkg.discount_percentage > 0 ? ` with ${pkg.discount_percentage}% discount` : ''}`,
          session_count: pkg.session_count,
          price: pkg.price,
        }));

        const { error: packagesError } = await supabaseAdmin
          .from('packages')
          .insert(packageData);

        if (packagesError) {
          console.error('Custom packages creation error:', packagesError);
          // Continue without packages if it fails
        } else {
          console.log('✅ Custom packages created successfully');
          console.log('   - Packages created:', packageData.length);
          packageData.forEach(pkg => {
            console.log(`     • ${pkg.name}: ${pkg.session_count} sessions, $${pkg.price}`);
          });
        }
      } catch (packagesError) {
        console.error('Exception while creating custom packages:', packagesError);
        // Continue without packages if it fails
      }
    } else {
      console.log('📦 No packages specified - psychologist will have no packages initially');
    }

    // Set default availability (10 AM to 12 PM and 2 PM to 5 PM for 3 weeks)
    // This will only add dates that don't already exist
    try {
      const defaultAvailabilityService = require('../utils/defaultAvailabilityService');
      const defaultAvailResult = await defaultAvailabilityService.setDefaultAvailability(psychologist.id);
      if (defaultAvailResult.success) {
        console.log(`✅ Default availability set for psychologist ${psychologist.id}: ${defaultAvailResult.message}`);
      } else {
        console.warn(`⚠️ Failed to set default availability: ${defaultAvailResult.message}`);
      }
    } catch (defaultAvailError) {
      console.error('Error setting default availability:', defaultAvailError);
      // Continue even if default availability fails
    }

    // Handle custom availability if provided (allows doctors to remove/block slots)
    if (availability && availability.length > 0) {
      try {
        const availabilityRecords = [];
        availability.forEach(item => {
          // Only create availability for the next occurrence of the selected day (not 2 weeks)
          const dates = getAvailabilityDatesForDay(item.day, 1); // Create availability for only 1 occurrence
          dates.forEach(date => {
            // Only save if there are actual time slots
            if (item.slots && item.slots.length > 0) {
              // Use local date formatting to avoid timezone conversion issues
              const year = date.getFullYear();
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const day = String(date.getDate()).padStart(2, '0');
              const dateString = `${year}-${month}-${day}`;
              
              // Update existing availability or create new one
              availabilityRecords.push({
                psychologist_id: psychologist.id,
                date: dateString, // Use local date formatting
                time_slots: item.slots // Direct array of time strings as expected by validation
              });
            }
          });
        });

        if (availabilityRecords.length > 0) {
          // Use upsert to update existing or create new
          for (const record of availabilityRecords) {
            const { data: existing } = await supabaseAdmin
            .from('availability')
              .select('id')
              .eq('psychologist_id', record.psychologist_id)
              .eq('date', record.date)
              .single();

            if (existing) {
              // Update existing
              await supabaseAdmin
                .from('availability')
                .update({
                  time_slots: record.time_slots,
                  updated_at: new Date().toISOString()
                })
                .eq('id', existing.id);
            } else {
              // Insert new
              await supabaseAdmin
                .from('availability')
                .insert(record);
            }
          }
        }
      } catch (availabilityError) {
        console.error('Exception while creating custom availability:', availabilityError);
        // Continue without custom availability if it fails
      }
    }

    res.status(201).json(
      successResponse({
        psychologist: {
          id: psychologist.id,
          email: psychologist.email,
          first_name: psychologist.first_name,
          last_name: psychologist.last_name,
          phone: psychologist.phone,
          ug_college: psychologist.ug_college,
          pg_college: psychologist.pg_college,
          mphil_college: psychologist.mphil_college,
          phd_college: psychologist.phd_college,
          area_of_expertise: psychologist.area_of_expertise,
          description: psychologist.description,
          experience_years: psychologist.experience_years
        }
      }, 'Psychologist created successfully')
    );

  } catch (error) {
    console.error('Create psychologist error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating psychologist')
    );
  }
};

const updatePsychologist = async (req, res) => {
  try {
    const { psychologistId } = req.params;
    const updateData = req.body;

    console.log('📝 [ADMIN] Updating psychologist:', psychologistId);
    console.log('📦 [ADMIN] Update data keys:', Object.keys(updateData));

    // Get psychologist profile
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('*')
      .eq('id', psychologistId)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    // Remove fields that are not in the psychologists table
    // Capture password separately so we can update the linked user record
    // Also remove deletePackages flag (it's not a database column, just a control flag)
    const { price, availability, packages, password, deletePackages, ...psychologistUpdateData } = updateData;
    
    // Explicitly remove deletePackages if it somehow got through (safety check)
    delete psychologistUpdateData.deletePackages;
    
    // Convert display_order to integer if provided
    if (psychologistUpdateData.display_order !== undefined) {
      psychologistUpdateData.display_order = psychologistUpdateData.display_order ? parseInt(psychologistUpdateData.display_order) : null;
    }

    // Remove only undefined values from update data (preserve null for intentional field clearing)
    Object.keys(psychologistUpdateData).forEach(key => {
      if (psychologistUpdateData[key] === undefined) {
        delete psychologistUpdateData[key];
      }
    });

    // Only update fields that have actually changed (compare with existing values)
    const optimizedUpdateData = {};
    Object.keys(psychologistUpdateData).forEach(key => {
      const newValue = psychologistUpdateData[key];
      const existingValue = psychologist[key];
      
      // Compare values (handle different types)
      if (newValue !== existingValue) {
        // Special handling for arrays/objects (convert to JSON for comparison)
        if (Array.isArray(newValue) || Array.isArray(existingValue)) {
          if (JSON.stringify(newValue) !== JSON.stringify(existingValue)) {
            optimizedUpdateData[key] = newValue;
          }
        } else if (typeof newValue === 'object' && typeof existingValue === 'object' && newValue !== null && existingValue !== null) {
          if (JSON.stringify(newValue) !== JSON.stringify(existingValue)) {
            optimizedUpdateData[key] = newValue;
          }
        } else {
          optimizedUpdateData[key] = newValue;
        }
      }
    });

    // Only update psychologist profile if there are fields to update
    let updatedPsychologist = psychologist; // Default to existing psychologist data
    
    // Check if there are any fields to update (besides updated_at)
    const hasFieldsToUpdate = Object.keys(optimizedUpdateData).length > 0;

    if (hasFieldsToUpdate) {
      // Add updated_at timestamp
      optimizedUpdateData.updated_at = new Date().toISOString();
      
      // Update psychologist profile
      const { data: updatedData, error: updateError } = await supabaseAdmin
        .from('psychologists')
        .update(optimizedUpdateData)
        .eq('id', psychologistId)
        .select('*')
        .single();

      if (updateError) {
        console.error('Update psychologist error:', updateError);
        const updateMsg = String(updateError.message || '').toLowerCase();
        if (updateError.code === '23505' || updateMsg.includes('duplicate') || updateMsg.includes('unique')) {
          return res.status(400).json(
            errorResponse('Psychologist with this email already exists')
          );
        }
        // If error is PGRST116 (0 rows), it means the update didn't affect any rows
        // This can happen if the update data is invalid or the row doesn't exist
        if (updateError.code === 'PGRST116') {
          console.error('Update returned 0 rows - psychologist may not exist or update data is invalid');
          return res.status(404).json(
            errorResponse('Psychologist not found or update data is invalid')
          );
        }
        return res.status(500).json(
          errorResponse('Failed to update psychologist profile')
        );
      }
      
      if (updatedData) {
        updatedPsychologist = updatedData;
      }
    } else {
      console.log('No psychologist profile fields to update, skipping profile update');
    }

    // If admin requested a password change, update the psychologist password
    if (password && typeof password === 'string' && password.trim().length > 0) {
      try {
        // Use validatePassword function for consistent password policy enforcement
        const passwordValidation = validatePassword(password);
        if (!passwordValidation.valid) {
          return res.status(400).json(
            errorResponse('Password does not meet requirements', passwordValidation.errors)
          );
        }

        const hashedPassword = await hashPassword(password);

        // Update the password_hash directly in the psychologists table (this is the primary source of auth for psychologists)
        const { error: psychPwUpdateError } = await supabaseAdmin
          .from('psychologists')
          .update({ password_hash: hashedPassword, updated_at: new Date().toISOString() })
          .eq('id', psychologistId);

        if (psychPwUpdateError) {
          console.error('❌ Error updating psychologist password_hash:', psychPwUpdateError);
          throw new Error('Failed to update psychologist password hash');
        }

        console.log('✅ Successfully updated psychologist password_hash in psychologists table');

        // Update linked user account if user_id is present
        let targetUserId = psychologist.user_id;
        if (targetUserId) {
          const { error: userPasswordUpdateError } = await supabaseAdmin
            .from('users')
            .update({ password_hash: hashedPassword, updated_at: new Date().toISOString() })
            .eq('id', targetUserId);

          if (userPasswordUpdateError) {
            console.error('❌ Error updating linked user password:', userPasswordUpdateError);
          } else {
            console.log('✅ Successfully updated linked user password in users table');
          }
        }
      } catch (pwError) {
        console.error('❌ Exception during password update:', pwError);
        // Skip password update exception but continue with other updates
      }
    }

    // Handle individual price by storing it in the dedicated field
    if (price !== undefined) {
      console.log('💰 Individual price provided:', price);
      console.log('💰 Psychologist ID:', psychologistId);
      console.log('💰 Price type:', typeof price);
      console.log('💰 Parsed price:', parseInt(price));
      
      try {
        // Store price in the dedicated individual_session_price field (as integer)
        const { error: priceUpdateError } = await supabaseAdmin
          .from('psychologists')
          .update({ individual_session_price: parseInt(price) })
          .eq('id', psychologistId);

        if (priceUpdateError) {
          console.error('❌ Error updating individual_session_price:', priceUpdateError);
        } else {
          console.log('✅ Individual session price updated successfully');
          // Update the local copy for response
          updatedPsychologist.individual_session_price = parseInt(price);
        }
      } catch (priceError) {
        console.error('❌ Exception during price update:', priceError);
        // Continue even if price update fails
      }
    }

    // Handle packages if provided
    if (updateData.packages && Array.isArray(updateData.packages)) {
      try {
        // Get existing packages for this psychologist
        const { data: existingPackages } = await supabaseAdmin
          .from('packages')
          .select('id')
          .eq('psychologist_id', psychologistId);

        const existingPackageIds = (existingPackages || []).map(p => p.id);

        // Delete packages if deletePackages flag is set
        if (updateData.deletePackages) {
          const packagesToKeep = updateData.packages
            .filter(pkg => pkg.id && !pkg.id.toString().startsWith('pkg-'))
            .map(pkg => pkg.id);
          
          const packagesToDelete = existingPackageIds.filter(id => !packagesToKeep.includes(id));
          
          if (packagesToDelete.length > 0) {
            await supabaseAdmin
              .from('packages')
              .delete()
              .eq('psychologist_id', psychologistId)
              .in('id', packagesToDelete);
            console.log(`✅ [ADMIN] Deleted ${packagesToDelete.length} packages`);
          }
        }

        // Process each package (create or update)
        for (const pkg of updateData.packages) {
          if (!pkg.name || !pkg.price || !pkg.sessions) continue;

          const packageData = {
            psychologist_id: psychologistId,
            package_type: pkg.sessions > 1 ? `package_${pkg.sessions}` : 'individual',
            session_count: pkg.sessions,
            price: parseFloat(pkg.price),
            name: pkg.name,
            updated_at: new Date().toISOString()
          };

          // If package has an ID (not a temp ID), update it
          if (pkg.id && !pkg.id.toString().startsWith('pkg-')) {
            const { error: packageUpdateError } = await supabaseAdmin
              .from('packages')
              .update(packageData)
              .eq('id', pkg.id)
              .eq('psychologist_id', psychologistId);

            if (packageUpdateError) {
              console.error('❌ [ADMIN] Error updating package:', packageUpdateError);
            } else {
              console.log(`✅ [ADMIN] Updated package: ${pkg.id}`);
            }
          } else {
            // Create new package
            packageData.created_at = new Date().toISOString();
            const { error: packageCreateError } = await supabaseAdmin
              .from('packages')
              .insert([packageData]);

            if (packageCreateError) {
              console.error('❌ [ADMIN] Error creating package:', packageCreateError);
            } else {
              console.log(`✅ [ADMIN] Created new package for psychologist`);
            }
          }
        }
      } catch (packageError) {
        console.error('❌ [ADMIN] Error handling packages:', packageError);
        // Continue - package errors shouldn't block psychologist update
      }
    }

    // Handle availability if provided
    if (updateData.availability && Array.isArray(updateData.availability)) {
      try {
        for (const avail of updateData.availability) {
          if (!avail.date || !avail.timeSlots) continue;

          // Convert timeSlots object to array format
          const timeSlotsArray = [
            ...(avail.timeSlots.morning || []),
            ...(avail.timeSlots.noon || []),
            ...(avail.timeSlots.evening || []),
            ...(avail.timeSlots.night || [])
          ];

          if (timeSlotsArray.length === 0) continue;

          // Check if availability already exists for this date
          const { data: existingAvailability } = await supabaseAdmin
            .from('availability')
            .select('id')
            .eq('psychologist_id', psychologistId)
            .eq('date', avail.date)
            .single();

          if (existingAvailability) {
            // Update existing availability
            await supabaseAdmin
              .from('availability')
              .update({
                time_slots: timeSlotsArray,
                is_available: true,
                updated_at: new Date().toISOString()
              })
              .eq('id', existingAvailability.id);
          } else {
            // Create new availability
            await supabaseAdmin
              .from('availability')
              .insert({
                psychologist_id: psychologistId,
                date: avail.date,
                time_slots: timeSlotsArray,
                is_available: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              });
          }
        }
        console.log(`✅ [ADMIN] Updated availability for ${updateData.availability.length} dates`);
      } catch (availabilityError) {
        console.error('❌ [ADMIN] Error handling availability:', availabilityError);
        // Continue - availability errors shouldn't block psychologist update
      }
    }

    console.log('✅ [ADMIN] Psychologist updated successfully');
    return res.json(successResponse(updatedPsychologist, 'Psychologist updated successfully'));

  } catch (error) {
    console.error('❌ [ADMIN] Error in updatePsychologist:', error);
    return res.status(500).json(errorResponse('Internal server error while updating psychologist'));
  }
};

const deletePsychologist = async (req, res) => {
  try {
    const { psychologistId } = req.params;

    // Check if psychologist exists
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id')
      .eq('id', psychologistId)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    // Check for upcoming or active bookings before deletion
    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
    
    const { data: upcomingSessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select('id, client_id, scheduled_date, scheduled_time, status')
      .eq('psychologist_id', psychologistId)
      .in('status', ['booked', 'confirmed'])
      .gte('scheduled_date', today);

    if (sessionsError) {
      console.error('Error checking upcoming sessions:', sessionsError);
      return res.status(500).json(
        errorResponse('Failed to check upcoming sessions')
      );
    }

    if (upcomingSessions && upcomingSessions.length > 0) {
      // Filter to only include sessions that are actually in the future
      const futureSessions = upcomingSessions.filter(session => {
        if (!session.scheduled_date || !session.scheduled_time) return false;
        const sessionDateTime = new Date(`${session.scheduled_date}T${session.scheduled_time}`);
        return sessionDateTime >= now;
      });

      if (futureSessions.length > 0) {
        const earliestSession = futureSessions.sort((a, b) => {
          const dateA = new Date(`${a.scheduled_date}T${a.scheduled_time}`);
          const dateB = new Date(`${b.scheduled_date}T${b.scheduled_time}`);
          return dateA - dateB;
        })[0];
        return res.status(409).json(
          errorResponse(`Cannot delete psychologist: ${futureSessions.length} upcoming session(s) found. Earliest session: ${earliestSession.scheduled_date} ${earliestSession.scheduled_time}`)
        );
      }
    }

    // Delete availability records first
    const { error: deleteAvailabilityError } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('psychologist_id', psychologistId);

    if (deleteAvailabilityError) {
      console.error('Delete availability error:', deleteAvailabilityError);
      // Continue with deletion even if availability deletion fails
    }

    // Delete associated packages before deleting psychologist profile
    const { error: deletePackagesError } = await supabaseAdmin
      .from('packages')
      .delete()
      .eq('psychologist_id', psychologistId);

    if (deletePackagesError) {
      console.error('Delete packages error:', deletePackagesError);
      // Log error but continue with psychologist deletion
    } else {
      console.log('✅ Deleted associated packages for psychologist');
    }

    // Delete psychologist profile
    const { error: deleteProfileError } = await supabaseAdmin
      .from('psychologists')
      .delete()
      .eq('id', psychologistId);

    if (deleteProfileError) {
      console.error('Delete psychologist profile error:', deleteProfileError);
      return res.status(500).json(
        errorResponse('Failed to delete psychologist profile')
      );
    }

    // Invalidate frontend cache when psychologist is deleted
    const cacheInvalidationTimestamp = Date.now();
    console.log('🔄 Cache invalidation triggered for psychologist deletion:', cacheInvalidationTimestamp);

    res.json(
      successResponse({
        deleted: true,
        cache_invalidated: true,
        cache_timestamp: cacheInvalidationTimestamp
      }, 'Psychologist deleted successfully')
    );

  } catch (error) {
    console.error('Delete psychologist error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting psychologist')
    );
  }
};

const updateAllPsychologistsAvailability = async (req, res) => {
  try {
    const defaultAvailabilityService = require('../utils/defaultAvailabilityService');
    const result = await defaultAvailabilityService.updateAllPsychologistsAvailability();
    if (result.success) {
      res.json(successResponse(result, `Updated ${result.updated} psychologists with default availability`));
    } else {
      res.status(500).json(errorResponse(result.message || 'Failed to update psychologists availability'));
    }
  } catch (error) {
    console.error('Error in updateAllPsychologistsAvailability endpoint:', error);
    res.status(500).json(errorResponse('Internal server error while updating psychologists availability'));
  }
};

const createUser = async (req, res) => {
  try {
    const body = req.body || {};
    // Accept both camelCase (frontend) and snake_case
    const email = body.email;
    const password = body.password;
    const first_name = body.first_name ?? body.firstName ?? null;
    const last_name = body.last_name ?? body.lastName ?? null;
    const phone_number = body.phone_number ?? body.phone ?? null;
    const child_name = body.child_name ?? body.childName ?? null;
    const child_age = body.child_age ?? body.childAge ?? null;

    if (!password || typeof password !== 'string' || password.trim() === '') {
      return res.status(400).json(errorResponse('Password is required'));
    }
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json(
        errorResponse('Password does not meet requirements', passwordValidation.errors)
      );
    }

    // Check if user already exists
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json(
        errorResponse('User with this email already exists')
      );
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create user (use admin client to bypass RLS)
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert([{
        email,
        password_hash: hashedPassword,
        role: 'client'
      }])
      .select('id, email, role, created_at')
      .single();

    if (userError) {
      console.error('User creation error:', userError);
      return res.status(500).json(
        errorResponse('Failed to create user account')
      );
    }

    // Create client profile (use admin client to bypass RLS)
    // first_name and last_name are NOT NULL in DB; use fallbacks when missing
    const firstNameForDb = (first_name != null && String(first_name).trim()) ? String(first_name).trim() : (email ? (email.split('@')[0] || 'Client') : 'Client');
    const lastNameForDb = (last_name != null && String(last_name).trim()) ? String(last_name).trim() : '';
    // child_name and child_age are NOT NULL in DB; use placeholders when admin leaves them blank (e.g. manual booking)
    const childNameForDb = (child_name && String(child_name).trim()) ? String(child_name).trim() : 'Not provided';
    const childAgeForDb = (child_age != null && child_age !== '') ? Number(child_age) : 0;
    const { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .insert([{
        user_id: user.id,
        first_name: firstNameForDb,
        last_name: lastNameForDb,
        phone_number: phone_number || null,
        child_name: childNameForDb,
        child_age: childAgeForDb
      }])
      .select('*')
      .single();

    if (clientError) {
      console.error('Client profile creation error:', clientError);
      // Delete user if profile creation fails
      await supabaseAdmin.from('users').delete().eq('id', user.id);
      return res.status(500).json(
        errorResponse('Failed to create client profile')
      );
    }

    console.log('✅ Client created:', {
      userId: user.id,
      clientId: client.id,
      email: user.email
    });

    res.status(201).json(
      successResponse({
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          profile: client  // Contains client.id
        }
      }, 'Client created successfully')
    );

  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating user')
    );
  }
};

const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const body = req.body || {};
    const first_name = body.first_name ?? body.firstName;
    const last_name = body.last_name ?? body.lastName;
    const email = body.email;
    const phone = body.phone;
    const password = body.password;
    const child_name = body.child_name ?? body.childName;
    const child_age = body.child_age ?? body.childAge;

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, role')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json(errorResponse('User not found'));
    }

    // Only update users table for fields that are present in body and changed
    const updates = {};
    if (email !== undefined && email !== null && String(email).trim()) {
      const newEmail = String(email).trim().toLowerCase();
      if (newEmail !== (user.email || '').toLowerCase()) {
        const { data: existing } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('email', newEmail)
          .maybeSingle();
        if (existing) {
          return res.status(400).json(errorResponse('Another user already has this email'));
        }
        updates.email = newEmail;
      }
    }
    if (password !== undefined && password !== null && String(password).trim()) {
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json(
          errorResponse('Password does not meet requirements', passwordValidation.errors)
        );
      }
      updates.password_hash = await hashPassword(password);
    }
    // Note: users table may not have is_active column; omit to avoid schema errors

    if (Object.keys(updates).length > 0) {
      const { error: updateUserError } = await supabaseAdmin
        .from('users')
        .update(updates)
        .eq('id', userId);
      if (updateUserError) {
        console.error('Update user error:', updateUserError);
        return res.status(500).json(errorResponse('Failed to update user'));
      }
    }

    if (user.role === 'client') {
      const { data: clientRecord } = await supabaseAdmin
        .from('clients')
        .select('id, first_name, last_name, phone_number, child_name, child_age')
        .eq('user_id', userId)
        .maybeSingle();
      const clientId = clientRecord?.id;
      if (clientId && clientRecord) {
        const clientUpdates = {};
        if (first_name !== undefined) {
          const v = (first_name != null && String(first_name).trim()) ? String(first_name).trim() : (user.email ? user.email.split('@')[0] : 'Client');
          if (v !== (clientRecord.first_name || '')) clientUpdates.first_name = v;
        }
        if (last_name !== undefined) {
          const v = (last_name != null && String(last_name).trim()) ? String(last_name).trim() : '';
          if (v !== (clientRecord.last_name || '')) clientUpdates.last_name = v;
        }
        if (phone !== undefined && String(phone || '') !== String(clientRecord.phone_number || '')) {
          clientUpdates.phone_number = phone || null;
        }
        if (child_name !== undefined) {
          const v = (child_name && String(child_name).trim()) ? String(child_name).trim() : 'Not provided';
          if (v !== (clientRecord.child_name || '')) clientUpdates.child_name = v;
        }
        if (child_age !== undefined) {
          const v = (child_age != null && child_age !== '') ? Number(child_age) : 0;
          if (v !== (clientRecord.child_age ?? 0)) clientUpdates.child_age = v;
        }
        if (Object.keys(clientUpdates).length > 0) {
          const { error: clientUpdateError } = await supabaseAdmin
            .from('clients')
            .update(clientUpdates)
            .eq('id', clientId);
          if (clientUpdateError) {
            console.error('Update client profile error:', clientUpdateError);
            return res.status(500).json(errorResponse('Failed to update client profile'));
          }
        }
      }
    }

    const { data: updatedUser } = await supabaseAdmin
      .from('users')
      .select('id, email, role')
      .eq('id', userId)
      .single();

    let profile = null;
    if (user.role === 'client') {
      const { data: client } = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      profile = client || null;
    }

    return res.json(
      successResponse({
        user: {
          id: updatedUser?.id || userId,
          email: updatedUser?.email,
          role: updatedUser?.role,
          profile
        }
      }, 'User updated successfully')
    );
  } catch (error) {
    console.error('Update user error:', error);
    return res.status(500).json(errorResponse('Internal server error while updating user'));
  }
};

const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // CRITICAL FIX: TOCTOU protection - Re-verify admin role from DB before operation
    const { data: freshAdminUser } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (!freshAdminUser || (freshAdminUser.role !== 'admin' && freshAdminUser.role !== 'superadmin')) {
      return res.status(403).json(
        errorResponse('Privilege revoked. Admin access required.')
      );
    }

    // Get user
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json(
        errorResponse('User not found')
      );
    }

    // If client, delete all related data first
    if (user.role === 'client') {
      // Find client record (for new system, client.id != user.id)
      const { data: clientRecord } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();

      // Detect when clientRecord is missing and handle explicitly
      if (!clientRecord) {
        const processLogger = require('../utils/processLogger');
        const logger = processLogger || console;
        logger.warn('⚠️ Client record not found for user deletion', {
          userId,
          context: 'deleteUser',
          action: 'fallback_to_userId',
          warning: 'Cascade deletes will use userId instead of client.id - may cause incorrect deletions'
        });
      }

      const clientId = clientRecord?.id || userId; // Fallback to userId for old system

      console.log(`🗑️  Deleting all related data for client_id: ${clientId}`);

      // 1. Delete messages (via conversations)
      const { data: conversations, error: convErr } = await supabaseAdmin
        .from('conversations')
        .select('id')
        .eq('client_id', clientId);

      if (convErr) {
        console.error('Delete client cascade: fetch conversations error:', convErr);
        throw new Error(`Failed to fetch conversations for cascade delete: ${convErr.message}`);
      }

      if (conversations && conversations.length > 0) {
        const conversationIds = conversations.map(c => c.id);
        const { error: msgDelErr } = await supabaseAdmin
          .from('messages')
          .delete()
          .in('conversation_id', conversationIds);
        if (msgDelErr) {
          console.error('Delete client cascade: delete messages error:', msgDelErr);
          throw new Error(`Failed to delete messages: ${msgDelErr.message}`);
        }
        console.log(`   ✅ Deleted messages from ${conversations.length} conversation(s)`);
      }

      // 2. Delete conversations
      const { error: convDelErr } = await supabaseAdmin
        .from('conversations')
        .delete()
        .eq('client_id', clientId);
      if (convDelErr) {
        console.error('Delete client cascade: delete conversations error:', convDelErr);
        throw new Error(`Failed to delete conversations: ${convDelErr.message}`);
      }
      console.log(`   ✅ Deleted conversations`);

      // 3. Delete receipts (via sessions) and then sessions + payments.
      // IMPORTANT: sessions has a foreign key to payments (sessions.payment_id → payments.id),
      // so we must delete sessions BEFORE deleting payments to avoid FK violations.
      const { data: sessions, error: sessFetchErr } = await supabaseAdmin
        .from('sessions')
        .select('id')
        .eq('client_id', clientId);

      if (sessFetchErr) {
        console.error('Delete client cascade: fetch sessions error:', sessFetchErr);
        throw new Error(`Failed to fetch sessions for cascade delete: ${sessFetchErr.message}`);
      }

      if (sessions && sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);

        // Delete commission_history linked to these sessions
        const { error: commDelErr } = await supabaseAdmin
          .from('commission_history')
          .delete()
          .in('session_id', sessionIds);
        if (commDelErr) {
          console.error('Delete client cascade: delete commission_history error:', commDelErr);
          throw new Error(`Failed to delete commission history: ${commDelErr.message}`);
        }
        console.log(`   ✅ Deleted commission history for ${sessions.length} session(s)`);

        const { error: recDelErr } = await supabaseAdmin
          .from('receipts')
          .delete()
          .in('session_id', sessionIds);
        if (recDelErr) {
          console.error('Delete client cascade: delete receipts error:', recDelErr);
          throw new Error(`Failed to delete receipts: ${recDelErr.message}`);
        }
        console.log(`   ✅ Deleted receipts for ${sessions.length} session(s)`);

        // Delete sessions (must happen before deleting payments due to FK constraint)
        const { error: sessDelErr } = await supabaseAdmin
          .from('sessions')
          .delete()
          .eq('client_id', clientId);
        if (sessDelErr) {
          console.error('Delete client cascade: delete sessions error:', sessDelErr);
          throw new Error(`Failed to delete sessions: ${sessDelErr.message}`);
        }
        console.log(`   ✅ Deleted sessions`);
      }

      // Delete slot locks for this client
      const { error: slotDelErr } = await supabaseAdmin
        .from('slot_locks')
        .delete()
        .eq('client_id', clientId);
      if (slotDelErr) {
        console.error('Delete client cascade: delete slot_locks error:', slotDelErr);
        throw new Error(`Failed to delete slot locks: ${slotDelErr.message}`);
      }
      console.log(`   ✅ Deleted slot locks`);

      // 5. Delete payments (after sessions so FK sessions_payment_id_fkey is not violated)
      const { error: payDelErr } = await supabaseAdmin
        .from('payments')
        .delete()
        .eq('client_id', clientId);
      if (payDelErr) {
        console.error('Delete client cascade: delete payments error:', payDelErr);
        throw new Error(`Failed to delete payments: ${payDelErr.message}`);
      }
      console.log(`   ✅ Deleted payments`);

      // 6. Delete assessment sessions
      const { error: assSessDelErr } = await supabaseAdmin
        .from('assessment_sessions')
        .delete()
        .eq('client_id', clientId);
      if (assSessDelErr) {
        console.error('Delete client cascade: delete assessment_sessions error:', assSessDelErr);
        throw new Error(`Failed to delete assessment sessions: ${assSessDelErr.message}`);
      }
      console.log(`   ✅ Deleted assessment sessions`);

      // 7. Delete free assessments
      const { error: freeAssDelErr } = await supabaseAdmin
        .from('free_assessments')
        .delete()
        .eq('client_id', clientId);
      if (freeAssDelErr) {
        console.error('Delete client cascade: delete free_assessments error:', freeAssDelErr);
        throw new Error(`Failed to delete free assessments: ${freeAssDelErr.message}`);
      }
      console.log(`   ✅ Deleted free assessments`);

      // 8. Delete client packages
      const { error: pkgDelErr } = await supabaseAdmin
        .from('client_packages')
        .delete()
        .eq('client_id', clientId);
      if (pkgDelErr) {
        console.error('Delete client cascade: delete client_packages error:', pkgDelErr);
        throw new Error(`Failed to delete client packages: ${pkgDelErr.message}`);
      }
      console.log(`   ✅ Deleted client packages`);

      // 9. Delete client profile
      // IDs are UUIDs; use them directly in parameterized filters.
      const { error: deleteProfileError1 } = await supabaseAdmin
        .from('clients')
        .delete()
        .eq('id', clientId);
      
      // Also try deleting by user_id if different from id
      if (clientId !== userId) {
        const { error: deleteProfileError2 } = await supabaseAdmin
          .from('clients')
          .delete()
          .eq('user_id', userId);
        
        const deleteProfileError = deleteProfileError1 || deleteProfileError2;

        if (deleteProfileError) {
          console.error('Delete client profile error:', deleteProfileError);
          return res.status(500).json(
            errorResponse('Failed to delete client profile')
          );
        }
      } else {
        // If IDs are the same, only one delete was needed
        if (deleteProfileError1) {
          console.error('Delete client profile error:', deleteProfileError1);
          return res.status(500).json(
            errorResponse('Failed to delete client profile')
          );
        }
      }
      console.log(`   ✅ Deleted client profile`);
    }

    // Delete notifications for this user (uses user_id = users.id)
    if (user.role === 'client') {
      const { error: notifDelErr } = await supabaseAdmin
        .from('notifications')
        .delete()
        .eq('user_id', userId);
      if (notifDelErr) {
        console.error('Delete client cascade: delete notifications error:', notifDelErr);
        throw new Error(`Failed to delete notifications: ${notifDelErr.message}`);
      }
      console.log(`   ✅ Deleted notifications`);
    }

    // Delete user account
    const { error: deleteUserError } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (deleteUserError) {
      console.error('Delete user error:', deleteUserError);
      return res.status(500).json(
        errorResponse('Failed to delete user account')
      );
    }

    console.log(`   ✅ Deleted user account`);

    res.json(
      successResponse(null, 'User and all related data deleted successfully')
    );

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting user')
    );
  }
};

const updateSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const {
      psychologist_id,
      client_id,
      scheduled_date,
      scheduled_time,
      original_scheduled_date,
      status,
      price,
      therapist_commission,
      payment_method,
      transaction_id,
      razorpay_order_id,
      razorpay_payment_id,
      notify_doctor,
      // Package metadata fields
      session_type,
      session_count,
      package_session_number,
      package_group_id,
      package_id,
      // Notes, Summary, Report fields
      notes,
      summary,
      session_notes,
      session_summary,
      report,
      // No-show reschedule fee (only present when rescheduling a no-show session).
      noshow_fee_amount,
      noshow_fee_method,
      noshow_fee_receipt_url,
    } = req.body;

    if (!sessionId) {
      return res.status(400).json(errorResponse('Session ID is required'));
    }

    // Get current session to check if doctor changed
    const { data: currentSession, error: fetchError } = await supabaseAdmin
      .from('sessions')
      .select(`
        *,
        psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone),
        client:clients(id, first_name, last_name, child_name, phone_number)
      `)
      .eq('id', sessionId)
      .single();

    if (fetchError || !currentSession) {
      return res.status(404).json(errorResponse('Session not found'));
    }

    const originalPsychId = currentSession.psychologist_id;
    const doctorChanged = psychologist_id && psychologist_id !== originalPsychId;
    const effectiveDate = scheduled_date || currentSession.scheduled_date;
    const effectiveTime = scheduled_time || currentSession.scheduled_time;
    const scheduleChanged = (
      (scheduled_date && scheduled_date !== currentSession.scheduled_date) ||
      (scheduled_time && scheduled_time !== currentSession.scheduled_time)
    );
    const isSessionWithMeet = ['booked', 'rescheduled', 'reschedule_requested', 'scheduled', 'confirmed'].includes(
      (status || currentSession.status)?.toLowerCase?.() || status || currentSession.status
    );

    let adminRescheduleMeetMinutes = 50;
    if (currentSession.session_type === 'free_assessment') {
      adminRescheduleMeetMinutes = 20;
    } else if (currentSession.package_id) {
      const { data: pkgDurRow } = await supabaseAdmin
        .from('packages')
        .select('package_type')
        .eq('id', currentSession.package_id)
        .maybeSingle();
      adminRescheduleMeetMinutes = getMeetEventDurationMinutes(pkgDurRow?.package_type);
    }

    const updateData = {};

    // When psychologist is changed: remove old Meet from old doc's calendar and create new Meet for new doc
    if (doctorChanged && isSessionWithMeet && effectiveDate && effectiveTime) {
      const meetLinkService = require('../utils/meetLinkService');

      // 1) Delete old calendar event from old psychologist's calendar (best effort)
      const oldEventId = currentSession.google_calendar_event_id;
      if (oldEventId && originalPsychId) {
        try {
          const { data: oldPsych } = await supabaseAdmin
            .from('psychologists')
            .select('id, google_calendar_credentials')
            .eq('id', originalPsychId)
            .single();
          if (oldPsych?.google_calendar_credentials) {
            const creds = oldPsych.google_calendar_credentials;
            const oldAuth = {
              access_token: creds.access_token,
              refresh_token: creds.refresh_token,
              expiry_date: creds.expiry_date
            };
            const eventIds = String(oldEventId).split(',').map((id) => id.trim()).filter(Boolean);
            for (const eid of eventIds) {
              const delResult = await meetLinkService.deleteCalendarEvent(eid, oldAuth);
              if (delResult.success) {
                console.log('✅ [Admin] Removed old calendar event from previous psychologist:', eid);
              } else {
                console.warn('⚠️ [Admin] Could not delete old calendar event:', eid, delResult.error);
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ [Admin] Error removing old psychologist calendar event:', err.message);
        }
      }

      // 1b) Restore the time slot in the old psychologist's availability so it shows again on their frontend
      if (originalPsychId && effectiveDate && effectiveTime) {
        try {
          const restored = await availabilityService.restoreAvailabilitySlot(originalPsychId, effectiveDate, effectiveTime);
          if (restored) {
            console.log('✅ [Admin] Restored availability slot for previous psychologist:', effectiveDate, effectiveTime);
          }
        } catch (err) {
          console.warn('⚠️ [Admin] Error restoring availability slot for previous psychologist:', err.message);
        }
      }

      // 2) Fetch new psychologist and client (with user email) for new Meet
      const { data: newPsych } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, email, google_calendar_credentials')
        .eq('id', psychologist_id)
        .single();

      const clientIdForMeet = client_id || currentSession.client_id;
      const { data: clientForMeet } = await supabaseAdmin
        .from('clients')
        .select(`
          id,
          first_name,
          last_name,
          child_name,
          user:users(email)
        `)
        .eq('id', clientIdForMeet)
        .single();

      if (newPsych && clientForMeet) {
        const clientEmail = Array.isArray(clientForMeet.user)
          ? clientForMeet.user?.[0]?.email
          : clientForMeet.user?.email;
        const clientName = getClientDisplayName(clientForMeet, 'Client');
        const psychologistName = getPsychologistDisplayName(newPsych);
        const endTime = addMinutesToTime(effectiveTime, adminRescheduleMeetMinutes);
        const meetSessionData = {
          summary: buildKoottSessionTitle({ clientName, psychologistName }),
          description: buildKoottSessionDescription({
            clientName,
            psychologistName,
            clientPhone: clientForMeet.phone_number,
          }),
          startDate: effectiveDate,
          startTime: effectiveTime,
          endTime,
          clientEmail: clientEmail || null,
          psychologistEmail: newPsych.email || null
        };
        let userAuth = null;
        if (newPsych.google_calendar_credentials) {
          const c = newPsych.google_calendar_credentials;
          userAuth = {
            access_token: c.access_token,
            refresh_token: c.refresh_token,
            expiry_date: c.expiry_date
          };
        }
        const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
        if (meetResult.success && meetResult.meetLink) {
          updateData.google_meet_link = meetResult.meetLink;
          updateData.google_meet_join_url = meetResult.meetLink;
          updateData.google_meet_start_url = meetResult.meetLink;
          updateData.google_calendar_event_id = meetResult.eventId || null;
          console.log('✅ [Admin] New Meet link created for reassigned psychologist, session:', sessionId);
        } else {
          updateData.google_meet_link = null;
          updateData.google_meet_join_url = null;
          updateData.google_meet_start_url = null;
          updateData.google_calendar_event_id = null;
          console.warn('⚠️ [Admin] New Meet link generation failed for reassigned session:', meetResult?.error);
        }
      }
    }

    // When only date/time changed (same psychologist): UPDATE existing calendar event in place
    // → keeps the SAME Meet link, just moves the event to the new date/time slot.
    // The old slot disappears from the doctor's calendar because we're patching the same event.
    if (!doctorChanged && scheduleChanged && isSessionWithMeet && effectiveDate && effectiveTime) {
      const meetLinkService = require('../utils/meetLinkService');

      // Fetch psychologist (with OAuth creds) and client for attendee emails
      const targetPsychId = psychologist_id || currentSession.psychologist_id;
      const { data: psychForMeet } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, email, google_calendar_credentials')
        .eq('id', targetPsychId)
        .single();

      const clientIdForMeet = client_id || currentSession.client_id;
      const { data: clientForMeet } = await supabaseAdmin
        .from('clients')
        .select(`
          id,
          first_name,
          last_name,
          child_name,
          user:users(email)
        `)
        .eq('id', clientIdForMeet)
        .single();

      const oldEventId = currentSession.google_calendar_event_id;

      if (psychForMeet && clientForMeet) {
        const clientEmail = Array.isArray(clientForMeet.user)
          ? clientForMeet.user?.[0]?.email
          : clientForMeet.user?.email;
        const clientName = getClientDisplayName(clientForMeet, 'Client');
        const psychologistName = getPsychologistDisplayName(psychForMeet);

        const endTime = addMinutesToTime(effectiveTime, adminRescheduleMeetMinutes);
        const meetSessionData = {
          summary: buildKoottSessionTitle({ clientName, psychologistName }),
          description: buildKoottSessionDescription({
            clientName,
            psychologistName,
            clientPhone: clientForMeet.phone_number,
            isRescheduled: true,
          }),
          startDate: effectiveDate,
          startTime: effectiveTime,
          endTime,
          clientEmail: clientEmail || null,
          psychologistEmail: psychForMeet.email || null
        };

        let userAuth = null;
        if (psychForMeet.google_calendar_credentials) {
          const c = psychForMeet.google_calendar_credentials;
          userAuth = {
            access_token: c.access_token,
            refresh_token: c.refresh_token,
            expiry_date: c.expiry_date
          };
        }

        // Strategy: try to UPDATE the existing event (keeps the same Meet link).
        // Fall back to creating a fresh event only if the old event is gone or update fails.
        let meetResult = null;
        const primaryEventId = oldEventId
          ? String(oldEventId).split(',').map((id) => id.trim()).filter(Boolean)[0]
          : null;

        if (primaryEventId) {
          const updateResult = await meetLinkService.updateCalendarEvent(primaryEventId, meetSessionData, userAuth);
          if (updateResult.success && updateResult.meetLink) {
            meetResult = { success: true, meetLink: updateResult.meetLink, eventId: updateResult.eventId };
            console.log('✅ [Admin] Calendar event moved to new time; Meet link preserved:', updateResult.meetLink);
          } else {
            console.warn('⚠️ [Admin] updateCalendarEvent failed, falling back to create-new:', updateResult.error);
          }
        }

        // Fallback: no old event ID OR update failed → create a fresh event (new Meet link)
        if (!meetResult || !meetResult.success) {
          // Delete the old event first so it doesn't linger on therapist/client calendars
          if (primaryEventId) {
            try {
              await meetLinkService.deleteCalendarEvent(primaryEventId, userAuth);
              console.log('✅ [Admin] Deleted old calendar event before creating replacement:', primaryEventId);
            } catch (delErr) {
              console.warn('⚠️ [Admin] Could not delete old event before creating new one (non-fatal):', delErr.message);
            }
          }
          meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
          if (meetResult.success && meetResult.meetLink) {
            console.log('✅ [Admin] Created new Meet link for rescheduled session (no old event to update):', sessionId);
          }
        }

        if (meetResult?.success && meetResult.meetLink) {
          updateData.google_meet_link = meetResult.meetLink;
          updateData.google_meet_join_url = meetResult.meetLink;
          updateData.google_meet_start_url = meetResult.meetLink;
          updateData.google_calendar_event_id = meetResult.eventId || null;
        } else {
          console.warn('⚠️ [Admin] Meet preserve/regenerate both failed during reschedule, keeping previous links:', meetResult?.error);
        }
      }
    }

    if (psychologist_id) updateData.psychologist_id = psychologist_id;
    if (client_id) updateData.client_id = client_id;
    if (scheduled_date) updateData.scheduled_date = scheduled_date;
    if (scheduled_time) updateData.scheduled_time = scheduled_time;
    if (session_type !== undefined) updateData.session_type = session_type || null;
    if (session_count !== undefined) {
      updateData.session_count = (session_count === null || session_count === '') ? null : parseInt(session_count, 10);
    }
    if (package_session_number !== undefined) {
      updateData.package_session_number = (package_session_number === null || package_session_number === '') ? null : parseInt(package_session_number, 10);
    }
    if (package_group_id !== undefined) {
      updateData.package_group_id = package_group_id || null;
    }
    if (package_id !== undefined) {
      updateData.package_id = package_id || null;
    }
    if (notes !== undefined) updateData.notes = notes || null;
    if (summary !== undefined) updateData.summary = summary || null;
    if (session_notes !== undefined) updateData.session_notes = session_notes || null;
    if (session_summary !== undefined) updateData.session_summary = session_summary || null;
    if (report !== undefined) updateData.report = report || null;
    if (scheduleChanged) {
      updateData.status = 'rescheduled';
      updateData.reminder_sent = false;
    }
    if (original_scheduled_date !== undefined) {
      // Allow setting original_scheduled_date explicitly (for finance calculations)
      // If empty string, use scheduled_date as fallback
      updateData.original_scheduled_date = original_scheduled_date || scheduled_date || null;
    }
    if (status) updateData.status = status;
    if (price !== undefined) {
      const parsed = price === null ? null : parseFloat(price);
      if (parsed !== null && !Number.isFinite(parsed)) {
        return res.status(400).json(
          errorResponse('Invalid price: must be a valid number')
        );
      }
      updateData.price = parsed;
    }
    if (therapist_commission !== undefined) {
      const parsedComm = therapist_commission === null ? null : parseFloat(therapist_commission);
      if (parsedComm !== null && !Number.isFinite(parsedComm)) {
        return res.status(400).json(
          errorResponse('Invalid commission: must be a valid number')
        );
      }
      updateData.therapist_commission = parsedComm;
    }

    // Update session. Some environments may not yet have optional Google Calendar
    // columns in the sessions schema cache, so retry without them instead of failing
    // the whole reschedule/update flow.
    const sessionSelect = `
      *,
      psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, phone),
      client:clients(id, first_name, last_name, child_name, phone_number)
    `;
    let updatedSession = null;
    let updateError = null;

    let retryData = { ...updateData };
    for (let attempt = 0; attempt < 5; attempt++) {
      ({ data: updatedSession, error: updateError } = await supabaseAdmin
        .from('sessions')
        .update(retryData)
        .eq('id', sessionId)
        .select(sessionSelect)
        .single());

      const isMissingSchemaColumn =
        updateError &&
        String(updateError.code || '') === 'PGRST204';

      if (!isMissingSchemaColumn) break;

      const msg = String(updateError.message || '');
      const missingMatch = msg.match(/Could not find the '([^']+)' column/);
      const missingColumn = missingMatch?.[1] || null;

      if (!missingColumn || !Object.prototype.hasOwnProperty.call(retryData, missingColumn)) {
        break;
      }

      console.warn(`[admin.updateSession] sessions schema missing optional column '${missingColumn}'; retrying without it`);
      delete retryData[missingColumn];
    }

    if (updateError) {
      console.error('Error updating session:', updateError);
      return res.status(500).json(errorResponse('Failed to update session'));
    }

    // No-show reschedule fee: record the additional payment collected before rescheduling
    // a no-show session (client's mistake → they pay a top-up). Only fires when provided.
    if (noshow_fee_amount) {
      const { recordNoShowRescheduleFee } = require('../utils/noShowRescheduleFee');
      await recordNoShowRescheduleFee({
        sessionId,
        clientId: updatedSession?.client_id || currentSession.client_id,
        psychologistId: updatedSession?.psychologist_id || currentSession.psychologist_id,
        amount: noshow_fee_amount,
        method: noshow_fee_method,
        receiptUrl: noshow_fee_receipt_url,
      });
    }

    if (updatedSession?.wix_booking_id) {
      const wixMirrorUpdates = {
        locally_modified: true,
        synced_at: new Date().toISOString(),
      };

      const nextWixStatus = updateData.status || updatedSession.status;
      if (nextWixStatus) {
        wixMirrorUpdates.status = nextWixStatus;
      }

      if (session_type !== undefined) {
        wixMirrorUpdates.session_type = session_type;
      }
      if (session_count !== undefined) {
        wixMirrorUpdates.session_count = (session_count === null || session_count === '') ? null : parseInt(session_count, 10);
      }
      if (package_session_number !== undefined) {
        wixMirrorUpdates.package_session_number = (package_session_number === null || package_session_number === '') ? null : parseInt(package_session_number, 10);
      }
      if (package_group_id !== undefined) {
        wixMirrorUpdates.package_group_id = package_group_id || null;
      }
      if (notes !== undefined) {
        wixMirrorUpdates.notes = notes || null;
      }

      if (scheduleChanged || scheduled_date || scheduled_time) {
        const mirrorDate = updatedSession.scheduled_date || effectiveDate;
        const mirrorTime = updatedSession.scheduled_time || effectiveTime;
        const { startTimeIso, endTimeIso } = buildWixMirrorIsoWindow(
          mirrorDate,
          mirrorTime,
          adminRescheduleMeetMinutes
        );

        if (startTimeIso) wixMirrorUpdates.start_time = startTimeIso;
        if (endTimeIso) wixMirrorUpdates.end_time = endTimeIso;
      }

      try {
        const { data: wixMirrorRow, error: wixFetchError } = await supabaseAdmin
          .from('wix_bookings')
          .select('id, payload')
          .eq('wix_booking_id', updatedSession.wix_booking_id)
          .maybeSingle();

        if (wixFetchError) {
          console.warn('[admin.updateSession] failed to fetch linked wix_bookings row:', wixFetchError.message);
        } else if (wixMirrorRow?.id) {
          const existingPayload = wixMirrorRow.payload && typeof wixMirrorRow.payload === 'object'
            ? { ...wixMirrorRow.payload }
            : {};

          if (wixMirrorUpdates.start_time) existingPayload.startTime = wixMirrorUpdates.start_time;
          if (wixMirrorUpdates.end_time) existingPayload.endTime = wixMirrorUpdates.end_time;
          if (wixMirrorUpdates.status) {
            existingPayload.status = wixMirrorUpdates.status;
            existingPayload.bookingStatus = wixMirrorUpdates.status;
          }
          if (session_type !== undefined) {
            existingPayload.bookingType = session_type;
          }
          if (session_count !== undefined) {
            existingPayload.creditsAvailable = (session_count === null || session_count === '') ? null : parseInt(session_count, 10);
          }
          if (package_session_number !== undefined) {
            existingPayload.planSessionNumber = (package_session_number === null || package_session_number === '') ? null : parseInt(package_session_number, 10);
          }
          if (package_id !== undefined) {
            existingPayload.packageId = package_id || null;
          }
          if (notes !== undefined) {
            existingPayload.notes = notes || null;
          }

          wixMirrorUpdates.payload = existingPayload;

          const { error: wixUpdateError } = await supabaseAdmin
            .from('wix_bookings')
            .update(wixMirrorUpdates)
            .eq('id', wixMirrorRow.id);

          if (wixUpdateError) {
            console.warn('[admin.updateSession] failed to mirror session update into wix_bookings:', wixUpdateError.message);
          }
        }
      } catch (mirrorErr) {
        console.warn('[admin.updateSession] unexpected error while mirroring to wix_bookings:', mirrorErr.message);
      }
    }

    // Update payment details if provided
    if (payment_method || transaction_id || razorpay_order_id || razorpay_payment_id) {
      const { data: payment } = await supabaseAdmin
        .from('payments')
        .select('id')
        .eq('session_id', sessionId)
        .maybeSingle();

      if (payment) {
        const paymentUpdate = {};
        if (payment_method) paymentUpdate.payment_method = payment_method;
        if (transaction_id !== undefined) paymentUpdate.transaction_id = transaction_id || null;
        if (razorpay_order_id !== undefined) paymentUpdate.razorpay_order_id = razorpay_order_id || null;
        if (razorpay_payment_id !== undefined) paymentUpdate.razorpay_payment_id = razorpay_payment_id || null;

        await supabaseAdmin
          .from('payments')
          .update(paymentUpdate)
          .eq('id', payment.id);
      }
    }

    // When psychologist was changed: send full regular notifications (email + WhatsApp to client and new psychologist)
    if (doctorChanged && updatedSession.psychologist && updatedSession.client) {
      (async () => {
        try {
          const emailService = require('../utils/emailService');
          const interaktService = require('../utils/interaktService');

          const meetLink = updatedSession.google_meet_link ||
            updatedSession.google_meet_join_url ||
            updatedSession.google_calendar_link ||
            null;

          const clientName = getClientDisplayName(updatedSession.client, 'Client');
          const psychologistName = `${updatedSession.psychologist?.first_name || ''} ${updatedSession.psychologist?.last_name || ''}`.trim() || 'Psychologist';

          // Client email for confirmation email
          const { data: clientWithUser } = await supabaseAdmin
            .from('clients')
            .select('id, user:users(email)')
            .eq('id', updatedSession.client_id)
            .single();
          const clientEmail = clientWithUser?.user && (Array.isArray(clientWithUser.user) ? clientWithUser.user?.[0]?.email : clientWithUser.user?.email);

          // Payment amount and package info for email
          const { data: paymentRow } = await supabaseAdmin
            .from('payments')
            .select('id, amount, package_id')
            .eq('session_id', sessionId)
            .maybeSingle();
          let packageInfo = null;
          if (paymentRow?.package_id) {
            const { data: pkg } = await supabaseAdmin.from('packages').select('id, package_type, session_count').eq('id', paymentRow.package_id).single();
            if (pkg) {
              const { data: pkgSessions } = await supabaseAdmin
                .from('sessions')
                .select('id')
                .eq('package_id', paymentRow.package_id)
                .eq('client_id', updatedSession.client_id)
                .eq('status', 'completed');
              const completed = (pkgSessions || []).length;
              packageInfo = {
                totalSessions: pkg.session_count || 0,
                completedSessions: completed,
                remainingSessions: Math.max((pkg.session_count || 0) - completed, 0),
                packageType: pkg.package_type || 'Package'
              };
            }
          }

          // 1) Session confirmation emails (client + psychologist + admin)
          await emailService.sendSessionConfirmation({
            clientName,
            psychologistName,
            clientEmail: clientEmail || 'client@placeholder.com',
            psychologistEmail: updatedSession.psychologist?.email || 'psychologist@placeholder.com',
            scheduledDate: updatedSession.scheduled_date,
            scheduledTime: updatedSession.scheduled_time,
            sessionDate: updatedSession.scheduled_date,
            sessionTime: updatedSession.scheduled_time,
            googleMeetLink: meetLink,
            meetLink,
            googleCalendarEventId: updatedSession.google_calendar_event_id,
            sessionId: updatedSession.id,
            price: updatedSession.price ?? paymentRow?.amount ?? 0,
            amount: updatedSession.price ?? paymentRow?.amount ?? 0,
            status: updatedSession.status || 'booked',
            psychologistId: updatedSession.psychologist_id,
            clientId: updatedSession.client_id,
            packageInfo,
            durationMinutes: adminRescheduleMeetMinutes,
            receiptId: null,
            receiptNumber: null,
            receiptPdfBuffer: null
          });
          console.log('✅ [Admin] Session confirmation emails sent (reassigned session)');

          // 2) WhatsApp to client → booking_confirmation_v1
          const clientPhone = updatedSession.client?.phone_number || null;
          if (clientPhone && meetLink) {
            const res = await interaktService.sendBookingConfirmation(clientPhone, {
              clientName, psychologistName,
              date: updatedSession.scheduled_date,
              time: updatedSession.scheduled_time,
              meetLink,
            });
            if (res?.success) console.log('✅ [Admin] booking_confirmation_v1 sent to client (reassigned)');
            else console.warn('⚠️ [Admin] booking_confirmation_v1 to client failed:', res?.error || res?.reason);
          }

          // 3) WhatsApp to new psychologist → therapistconfirmation
          const psychologistPhone = updatedSession.psychologist?.phone || null;
          if (psychologistPhone && meetLink) {
            const res = await interaktService.sendSessionNotificationPsychologist(psychologistPhone, {
              therapistName: psychologistName,
              clientName,
              date: updatedSession.scheduled_date,
              time: updatedSession.scheduled_time,
              meetLink,
            });
            if (res?.success) console.log('✅ [Admin] therapistconfirmation sent to new therapist');
            else console.warn('⚠️ [Admin] session_notification_psychologist failed:', res?.error || res?.reason);
          }
        } catch (notifError) {
          console.error('❌ [Admin] Error sending reassignment notifications:', notifError);
          // Don't fail the request if notifications fail
        }
      })();
    }

    // When date/time changes (admin reschedule): send reschedule emails + WhatsApp confirmation
    if (scheduleChanged && updatedSession) {
      (async () => {
        try {
          const emailService = require('../utils/emailService');
          const interaktService = require('../utils/interaktService');
          const oldDate = currentSession.scheduled_date;
          const oldTime = currentSession.scheduled_time;
          const newDate = updatedSession.scheduled_date;
          const newTime = updatedSession.scheduled_time;

          // Resolve client email from users relation if needed
          const { data: clientWithUser } = await supabaseAdmin
            .from('clients')
            .select('id, first_name, last_name, child_name, phone_number, user:users(email)')
            .eq('id', updatedSession.client_id)
            .single();

          const clientEmail = clientWithUser?.user && (
            Array.isArray(clientWithUser.user)
              ? clientWithUser.user?.[0]?.email
              : clientWithUser.user?.email
          );

          const clientName = getClientDisplayName(clientWithUser, 'Client');

          // Resolve psychologist directly to ensure email/phone are always available
          const { data: psychologistRow } = await supabaseAdmin
            .from('psychologists')
            .select('id, first_name, last_name, email, phone')
            .eq('id', updatedSession.psychologist_id)
            .single();

          const psychologistName = `${psychologistRow?.first_name || updatedSession.psychologist?.first_name || ''} ${psychologistRow?.last_name || updatedSession.psychologist?.last_name || ''}`.trim() || 'Psychologist';
          const meetLink = updatedSession.google_meet_link ||
            updatedSession.google_meet_join_url ||
            updatedSession.google_calendar_link ||
            null;

          await emailService.sendRescheduleNotification({
            clientName,
            psychologistName,
            clientEmail: clientEmail || null,
            psychologistEmail: psychologistRow?.email || updatedSession.psychologist?.email || null,
            scheduledDate: newDate,
            scheduledTime: newTime,
            sessionId: updatedSession.id,
            meetLink,
            isFreeAssessment: updatedSession.session_type === 'free_assessment',
            durationMinutes: adminRescheduleMeetMinutes
          }, oldDate, oldTime);
          console.log('✅ [Admin] Reschedule notification emails sent');

          // Send rescheduled_link_sharing template to both CLIENT and THERAPIST
          const clientPhone = clientWithUser?.phone_number || updatedSession.client?.phone_number || null;
          if (clientPhone) {
            const waResult = await interaktService.sendRescheduleNotification(clientPhone, {
              recipientName: clientName,
              otherPartyName: psychologistName,
              date: newDate,
              time: newTime,
              meetLink,
            });
            if (waResult?.success) {
              console.log('✅ [Admin] Reschedule WhatsApp sent to client (rescheduled_link_sharing)');
            } else {
              console.warn('⚠️ [Admin] Failed to send reschedule WhatsApp to client:', waResult?.error || waResult?.reason);
            }
          }

          const psychologistPhone = psychologistRow?.phone || null;
          if (psychologistPhone) {
            const waResultPsych = await interaktService.sendRescheduleNotification(psychologistPhone, {
              recipientName: psychologistName,
              otherPartyName: clientName,
              date: newDate,
              time: newTime,
              meetLink,
            });
            if (waResultPsych?.success) {
              console.log('✅ [Admin] Reschedule WhatsApp sent to psychologist (rescheduled_link_sharing)');
            } else {
              console.warn('⚠️ [Admin] Failed to send reschedule WhatsApp to psychologist:', waResultPsych?.error || waResultPsych?.reason);
            }
          }
        } catch (notifError) {
          console.error('❌ [Admin] Error sending reschedule notifications:', notifError);
          // Do not fail request when notifications fail
        }
      })();
    }

    return res.json(successResponse(updatedSession, 'Session updated successfully'));

  } catch (error) {
    console.error('Update session error:', error);
    return res.status(500).json(errorResponse('Internal server error while updating session'));
  }
};

const getPsychologistAvailabilityForReschedule = async (req, res) => {
  try {
    const { psychologistId } = req.params;
    const { startDate, endDate } = req.query;

    if (!psychologistId) {
      return res.status(400).json(
        errorResponse('Psychologist ID is required')
      );
    }

    if (!startDate || !endDate) {
      return res.status(400).json(
        errorResponse('Both startDate and endDate are required (YYYY-MM-DD format)')
      );
    }

    console.log(`📅 [ADMIN] Getting availability for psychologist ${psychologistId} from ${startDate} to ${endDate}`);

    // Use the availability service to get availability range
    const availabilityService = require('../utils/availabilityCalendarService');
    const availability = await availabilityService.getPsychologistAvailabilityRange(
      psychologistId,
      startDate,
      endDate
    );

    // Format the response to match what the frontend expects
    // Frontend expects: { success: true, data: { availability: [...] } }
    // Each item should have: { date, available_slots (array of time strings), time_slots, booked_times, is_available }
    const formattedAvailability = availability.map(day => {
      // The availability service returns: { date, timeSlots: [{time, available, displayTime, reason}], ... }
      // Extract available slots from timeSlots array - these are the slots that can be booked
      const availableSlots = (day.timeSlots || [])
        .filter(slot => slot.available !== false && slot.reason !== 'booked' && slot.reason !== 'google_calendar_blocked')
        .map(slot => {
          // Return the time string in 12-hour format (e.g., "9:00 PM")
          return slot.displayTime || slot.time || String(slot);
        });
      
      // Extract all time slots (for reference)
      const allTimeSlots = (day.timeSlots || []).map(slot => slot.displayTime || slot.time || String(slot));
      
      // Extract booked times
      const bookedTimes = (day.timeSlots || [])
        .filter(slot => slot.available === false && slot.reason === 'booked')
        .map(slot => slot.displayTime || slot.time || String(slot));

      const formattedDay = {
        date: day.date,
        is_available: day.is_available !== false && availableSlots.length > 0,
        time_slots: allTimeSlots,
        available_slots: availableSlots, // This is what the frontend uses to display available times
        booked_times: bookedTimes
      };

      console.log(`📅 [ADMIN] Formatted day ${day.date}: ${availableSlots.length} available slots out of ${allTimeSlots.length} total`);
      
      return formattedDay;
    });

    console.log(`✅ [ADMIN] Availability fetched: ${formattedAvailability.length} days`);

      return res.json(
      successResponse({
        availability: formattedAvailability
      })
    );

  } catch (error) {
    console.error('❌ [ADMIN] Error getting psychologist availability:', error);
      return res.status(500).json(
      errorResponse('Failed to fetch psychologist availability')
    );
  }
};

const getRescheduleRequests = async (req, res) => {
  try {
    const { status } = req.query; // 'pending', 'approved', 'rejected', or undefined for all

    // Get all notifications that are reschedule requests
    // Filter by type='warning' and message contains 'reschedule' or title contains 'Reschedule'
    let query = supabaseAdmin
      .from('notifications')
      .select('*')
      .or('type.eq.warning,type.eq.info')
      .order('created_at', { ascending: false });

    const { data: allNotifications, error: fetchError } = await query;

    if (fetchError) {
      console.error('Get reschedule requests error:', fetchError);
      return res.status(500).json(
        errorResponse('Failed to fetch reschedule requests')
      );
    }

    // Filter for reschedule-related notifications
    let rescheduleRequests = (allNotifications || []).filter(notif => 
      (notif.message?.toLowerCase().includes('reschedule') || 
       notif.title?.toLowerCase().includes('reschedule')) &&
      notif.related_type === 'session'
    );

    // Filter by status (use status field or is_approved if available, fallback to is_read for backward compatibility)
    if (status === 'pending') {
      rescheduleRequests = rescheduleRequests.filter(req => 
        (req.status === 'pending' || req.status === undefined) && 
        (!req.is_approved || req.is_approved === false) && 
        !req.is_read
      );
    } else if (status === 'approved') {
      rescheduleRequests = rescheduleRequests.filter(req => 
        req.status === 'approved' || 
        req.is_approved === true || 
        req.is_read
      );
    } else if (status === 'rejected') {
      rescheduleRequests = rescheduleRequests.filter(req => 
        req.status === 'rejected' || 
        req.is_approved === false
      );
    }

    // Batch-fetch sessions to avoid N+1
    const sessionIds = [...new Set((rescheduleRequests || [])
      .map(req => req.related_id)
      .filter(Boolean))];
    let sessionMap = {};
    if (sessionIds.length > 0) {
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(`
          *,
          client:clients(
            *,
            user:users(email)
          ),
          psychologist:psychologists!sessions_psychologist_id_fkey(*)
        `)
        .in('id', sessionIds);
      if (sessionsError) {
        console.error('Get reschedule requests: batch fetch sessions error:', sessionsError);
        return res.status(500).json(
          errorResponse('Failed to fetch session details for reschedule requests')
        );
      }
      (sessions || []).forEach(s => { sessionMap[s.id] = s; });
    }

    const enrichedRequests = (rescheduleRequests || []).map((request) => {
      const session = request.related_id ? sessionMap[request.related_id] : null;
      return {
        ...request,
        session: session || null,
        client: session?.client || null,
        psychologist: session?.psychologist || null
      };
    });

    res.json(successResponse(enrichedRequests || [], 'Reschedule requests fetched successfully'));

  } catch (error) {
    console.error('Get reschedule requests error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching reschedule requests')
    );
  }
};

const getPsychologistCalendarEvents = async (req, res) => {
  try {
    const { psychologistId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json(
        errorResponse('Start date and end date are required')
      );
    }

    // Get psychologist details with Google Calendar credentials
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email, google_calendar_credentials')
      .eq('id', psychologistId)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    // Get internal sessions (Koott sessions)
    const { data: internalSessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select(`
        scheduled_date,
        scheduled_time,
        status,
        session_type,
        client:clients(
          first_name,
          last_name,
          child_name
        )
      `)
      .eq('psychologist_id', psychologistId)
      .gte('scheduled_date', startDate)
      .lte('scheduled_date', endDate)
      .in('status', ['booked', 'rescheduled', 'confirmed', 'completed'])
      .order('scheduled_date', { ascending: true });

    if (sessionsError) {
      console.error('Error fetching internal sessions:', sessionsError);
      return res.status(500).json(
        errorResponse('Failed to fetch internal sessions')
      );
    }

    // Get external calendar events if Google Calendar is connected
    let externalEvents = [];
    if (psychologist.google_calendar_credentials) {
      try {
        const googleCalendarService = require('../utils/googleCalendarService');
        
        const startDateObj = new Date(startDate);
        const endDateObj = new Date(endDate);
        
        // Get external events from Google Calendar
        const calendarEvents = await googleCalendarService.getCalendarEvents(
          psychologist.google_calendar_credentials,
          'primary',
          startDateObj,
          endDateObj
        );

        // Filter out events created by our own system using platform-specific metadata
        // Only exclude events that are positively identified as platform-created
        externalEvents = calendarEvents.filter(event => {
          // Check for platform-specific metadata indicators
          const isPlatformCreated = 
            event.creator?.email === 'no-reply@littleminds' ||
            event.creator?.email === 'assessment.koott@gmail.com' ||
            event.extendedProperties?.private?.littleMindsEvent === 'true' ||
            event.extendedProperties?.private?.koottEvent === 'true' ||
            event.source?.title === 'LittleMinds' ||
            event.source?.title === 'Koott';
          
          // Only exclude if positively identified as platform-created
          // Keep events when metadata is absent (fail-safe: don't exclude by summary text alone)
          return !isPlatformCreated;
        }).map(event => ({
          id: event.id,
          summary: event.summary || 'Untitled Event',
          start: event.start,
          end: event.end,
          location: event.location,
          description: event.description,
          source: 'external'
        }));
      } catch (calendarError) {
        console.error('Error fetching Google Calendar events:', calendarError);
        // Continue without external events if Google Calendar fails
      }
    }

    // Format internal sessions as events
    const internalEvents = internalSessions?.map(session => ({
      id: `internal-${session.scheduled_date}-${session.scheduled_time}`,
      summary: session.client ? 
        `Session with ${session.client.first_name} ${session.client.last_name}${session.client.child_name ? ` (${session.client.child_name})` : ''}` :
        'Session',
      start: {
        dateTime: `${session.scheduled_date}T${session.scheduled_time}:00`
      },
      end: {
        dateTime: (() => {
          // Calculate end time by adding 50 minutes to start time
          const startDateTime = new Date(`${session.scheduled_date}T${session.scheduled_time}:00`);
          const endDateTime = new Date(startDateTime.getTime() + 50 * 60 * 1000); // Add 50 minutes
          // Format back to ISO string format (YYYY-MM-DDTHH:MM:SS)
          const year = endDateTime.getFullYear();
          const month = String(endDateTime.getMonth() + 1).padStart(2, '0');
          const day = String(endDateTime.getDate()).padStart(2, '0');
          const hours = String(endDateTime.getHours()).padStart(2, '0');
          const minutes = String(endDateTime.getMinutes()).padStart(2, '0');
          return `${year}-${month}-${day}T${hours}:${minutes}:00`;
        })()
      },
      status: session.status,
      session_type: session.session_type,
      source: 'koott'
    })) || [];

    // Combine and sort all events
    const allEvents = [...internalEvents, ...externalEvents].sort((a, b) => {
      const dateA = new Date(a.start.dateTime || a.start.date);
      const dateB = new Date(b.start.dateTime || b.start.date);
      return dateA - dateB;
    });

    res.json(
      successResponse({
        psychologist: {
          id: psychologist.id,
          name: `${psychologist.first_name} ${psychologist.last_name}`,
          email: psychologist.email
        },
        events: allEvents,
        hasGoogleCalendar: !!psychologist.google_calendar_credentials,
        dateRange: { startDate, endDate }
      }, 'Calendar events fetched successfully')
    );

  } catch (error) {
    console.error('Get psychologist calendar events error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching calendar events')
    );
  }
};

// Book next package session (admin only) - for clients who prefer admin to book remaining sessions
const bookPackageNextSession = async (req, res) => {
  try {
    const { client_id, package_id, scheduled_date, scheduled_time } = req.body;

    if (!client_id || !package_id || !scheduled_date || !scheduled_time) {
      return res.status(400).json(
        errorResponse('Missing required fields: client_id, package_id, scheduled_date, scheduled_time')
      );
    }

    // Look up client_packages by client_id and package_id (packages.id)
    let { data: clientPackage, error: packageError } = await supabaseAdmin
      .from('client_packages')
      .select(`
        id,
        client_id,
        package_id,
        remaining_sessions,
        package:packages(id, package_type, session_count, psychologist_id)
      `)
      .eq('client_id', client_id)
      .eq('package_id', package_id)
      .eq('status', 'active')
      .maybeSingle();

    // Fallback: if no active client_packages, try without status filter (legacy/inconsistent data)
    if (!clientPackage) {
      const { data: fallback } = await supabaseAdmin
        .from('client_packages')
        .select(`
          id,
          client_id,
          package_id,
          remaining_sessions,
          package:packages(id, package_type, session_count, psychologist_id)
        `)
        .eq('client_id', client_id)
        .eq('package_id', package_id)
        .maybeSingle();
      if (fallback) clientPackage = fallback;
    }

    // Fallback: if still no client_packages, derive from packages + sessions and create record
    if (!clientPackage) {
      const { data: pkgRow, error: pkgErr } = await supabaseAdmin
        .from('packages')
        .select('id, package_type, session_count, psychologist_id')
        .eq('id', package_id)
        .single();

      if (pkgErr || !pkgRow) {
        return res.status(404).json(
          errorResponse('Package not found')
        );
      }

      const { data: packageSessionsCheck } = await supabaseAdmin
        .from('sessions')
        .select('id, status')
        .eq('package_id', package_id)
        .eq('client_id', client_id);

      let completedCheck = 0;
      let bookedCheck = 0;
      (packageSessionsCheck || []).forEach(s => {
        if (s.status === 'completed') completedCheck++;
        else if (s.status !== 'cancelled' && s.status !== 'no_show' && s.status !== 'noshow') bookedCheck++;
      });
      const totalCheck = deriveSessionCount(pkgRow);
      const remainingCheck = Math.max(totalCheck - completedCheck - bookedCheck, 0);

      // Allow booking the next session as long as the package has at least one live
      // session (booked OR completed) and sessions remain. Requiring a *completed*
      // session blocked booking ahead when the first session is still upcoming.
      if (remainingCheck <= 0 || (completedCheck + bookedCheck) === 0) {
        return res.status(404).json(
          errorResponse('No active package found for this client and package')
        );
      }

      const consumedSessions = completedCheck + bookedCheck;
      const remainingSessions = Math.max(totalCheck - consumedSessions, 0);
      // client_packages only has these columns — psychologist_id/package_type/total_sessions/
      // total_amount/amount_paid/purchased_at/first_session_id do NOT exist on this table.
      // That info is derived from the joined `packages` row (pkgRow) elsewhere instead.
      const clientPackagePayload = {
        client_id,
        package_id,
        remaining_sessions: remainingSessions,
        status: remainingSessions > 0 ? 'active' : 'completed',
      };

      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('client_packages')
        .insert([clientPackagePayload])
        .select('*')
        .single();

      if (insertErr) {
        if (insertErr.code === '23505' || insertErr.message?.includes('unique') || insertErr.message?.includes('duplicate')) {
          const { data: existingRow } = await supabaseAdmin
            .from('client_packages')
            .select(`
              id,
              client_id,
              package_id,
              remaining_sessions,
              package:packages(id, package_type, session_count, psychologist_id)
            `)
            .eq('client_id', client_id)
            .eq('package_id', package_id)
            .maybeSingle();
          if (existingRow) clientPackage = existingRow;
        }
        if (!clientPackage) {
          return res.status(500).json(
            errorResponse('Failed to create package record', { error: insertErr?.message })
          );
        }
      } else {
        clientPackage = { ...inserted, package: pkgRow };
      }
    }

    const totalSessionsCount = deriveSessionCount(clientPackage);
    const psychologistId = clientPackage.package?.psychologist_id;
    if (!psychologistId) {
      return res.status(400).json(errorResponse('Package has no psychologist'));
    }

    // Compute remaining sessions to book (same logic as client bookRemainingSession).
    // Also read package_group_id so the new session joins the SAME group as its siblings —
    // otherwise "Book Next" gating (which keys on the group) breaks and the option keeps
    // showing on earlier sessions of the package.
    const { data: packageSessions } = await supabaseAdmin
      .from('sessions')
      .select('id, status, package_group_id')
      .eq('package_id', clientPackage.package.id)
      .eq('client_id', client_id);

    // Inherit the package group id from any existing session in this package.
    let inheritedGroupId = (packageSessions || []).find(s => s.package_group_id)?.package_group_id || null;
    // Legacy/admin-created packages may have NO group id on any session. Establish one now
    // (anchored on an existing session's id) and backfill every session in the package, so the
    // new session joins a real group instead of falling back to a colliding group key — which
    // would break "Book Next" gating on the package.
    if (!inheritedGroupId && Array.isArray(packageSessions) && packageSessions.length > 0) {
      inheritedGroupId = packageSessions[0].id;
      await supabaseAdmin
        .from('sessions')
        .update({ package_group_id: inheritedGroupId })
        .in('id', packageSessions.map(s => s.id))
        .is('package_group_id', null);
    }

    let completedCount = 0;
    let bookedCount = 0;
    if (Array.isArray(packageSessions)) {
      packageSessions.forEach(s => {
        if (s.status === 'completed') completedCount++;
        else if (s.status !== 'cancelled' && s.status !== 'no_show' && s.status !== 'noshow') bookedCount++;
      });
    }
    const remainingToBook = Math.max(totalSessionsCount - completedCount - bookedCount, 0);
    if (remainingToBook <= 0) {
      return res.status(400).json(
        errorResponse('No remaining sessions in this package')
      );
    }

    // Skip availability check for admin package bookings (mirrors createManualBooking override behaviour)
    console.log('ℹ️ [bookPackageNextSession] Skipping slot availability check for admin booking');

    const formattedDate = formatDate(scheduled_date);
    const formattedTime = formatTime(scheduled_time);
    const { data: existingSession } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('psychologist_id', psychologistId)
      .eq('scheduled_date', formattedDate)
      .eq('scheduled_time', formattedTime)
      .in('status', ['booked', 'scheduled', 'reschedule_requested', 'rescheduled'])
      .maybeSingle();

    if (existingSession) {
      return res.status(409).json(
        errorResponse('This time slot was just booked by another user. Please select another time.')
      );
    }

    // Next session number = all existing non-cancelled sessions in this package + 1.
    // (completedCount + bookedCount were computed above from packageSessions.)
    const nextSessionNumber = completedCount + bookedCount + 1;

    const fallbackMeetLink = 'https://meet.google.com/new?hs=122&authuser=0';
    const nowIso = new Date().toISOString();
    const sessionData = {
      client_id,
      psychologist_id: psychologistId,
      package_id: clientPackage.package.id,
      scheduled_date: formattedDate,
      scheduled_time: formattedTime,
      status: 'booked',
      // Package metadata so the row shows as "Package (n/total)" and book-next gating works.
      session_type: 'package',
      session_count: totalSessionsCount,
      package_session_number: nextSessionNumber,
      // Join the same group as the package's other sessions so "Book Next" only shows on
      // the latest one (not on every earlier session).
      package_group_id: inheritedGroupId,
      google_calendar_event_id: null,
      google_meet_link: fallbackMeetLink,
      google_calendar_link: null,
      price: 0,
      original_scheduled_date: formattedDate,
      // booking_created_at MUST be set — the admin sessions list filters the "All" tab by this
      // column, and a NULL value would silently hide the row from the bookings page.
      booking_created_at: nowIso,
    };

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (sessionError) {
      if (sessionError.code === '23505' || sessionError.message?.includes('unique') || sessionError.message?.includes('duplicate')) {
        return res.status(409).json(
          errorResponse('This time slot was just booked by another user. Please select another time.')
        );
      }
      return res.status(500).json(
        errorResponse('Failed to create session', { error: sessionError.message })
      );
    }

    const totalSessions = deriveSessionCount(clientPackage);
    const currentRemaining = Number.isFinite(clientPackage.remaining_sessions)
      ? clientPackage.remaining_sessions
      : Math.max(totalSessions - 1, 0);
    const updatedRemaining = Math.max(currentRemaining - 1, 0);

    await supabaseAdmin
      .from('client_packages')
      .update({
        remaining_sessions: updatedRemaining,
        updated_at: new Date().toISOString()
      })
      .eq('id', clientPackage.id);

    res.json(
      successResponse({
        session,
        message: 'Next package session booked successfully',
        packageInfo: {
          totalSessions,
          completedSessions: completedCount,
          remainingSessions: updatedRemaining
        }
      })
    );

    setImmediate(async () => {
      try {
        const meetLinkService = require('../utils/meetLinkService');
        const emailService = require('../utils/emailService');
        const interaktService = require('../utils/interaktService');
        const { data: clientDetails } = await supabaseAdmin
          .from('clients')
          .select('first_name, last_name, child_name, phone_number, user:users(email)')
          .eq('id', client_id)
          .single();
        const { data: psychologistDetails } = await supabaseAdmin
          .from('psychologists')
          .select('first_name, last_name, email, phone')
          .eq('id', psychologistId)
          .single();

        const clientEmail = Array.isArray(clientDetails?.user) ? clientDetails?.user?.[0]?.email : clientDetails?.user?.email;
        const nextPkgMeetMinutes = getMeetEventDurationMinutes(clientPackage.package?.package_type);
        const clientName = getClientDisplayName(clientDetails, 'Client');
        const psychologistName = getPsychologistDisplayName(psychologistDetails);
        const meetSessionData = {
          summary: buildKoottSessionTitle({ clientName, psychologistName }),
          description: buildKoottSessionDescription({
            clientName,
            psychologistName,
            clientPhone: clientDetails?.phone_number,
          }),
          startDate: scheduled_date,
          startTime: scheduled_time,
          endTime: addMinutesToTime(scheduled_time, nextPkgMeetMinutes),
          clientEmail: clientEmail || undefined,
          psychologistEmail: psychologistDetails?.email || undefined
        };
        let userAuth = null;
        const { data: psychAuth } = await supabaseAdmin
          .from('psychologists')
          .select('google_calendar_credentials')
          .eq('id', psychologistId)
          .single();
        if (psychAuth?.google_calendar_credentials) {
          const c = psychAuth.google_calendar_credentials;
          userAuth = { access_token: c.access_token, refresh_token: c.refresh_token, expiry_date: c.expiry_date };
        }
        const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
        // Only use real Meet link in email/WhatsApp — never send fallback link to avoid confusion
        const effectiveMeetLink = (meetResult.success && meetResult.meetLink && !meetResult.meetLink.includes('meet.google.com/new'))
          ? meetResult.meetLink
          : null;

        if (meetResult.success && meetResult.meetLink && !meetResult.meetLink.includes('meet.google.com/new')) {
          await supabaseAdmin
            .from('sessions')
            .update({
              google_calendar_event_id: meetResult.eventId,
              google_meet_link: meetResult.meetLink,
              google_meet_join_url: meetResult.meetLink,
              google_meet_start_url: meetResult.meetLink,
              google_calendar_link: meetResult.eventLink || null,
              updated_at: new Date().toISOString()
            })
            .eq('id', session.id);
        }

        const packageInfo = {
          totalSessions,
          completedSessions: completedCount,
          remainingSessions: updatedRemaining,
          packageType: clientPackage.package?.package_type || null
        };

        // Notifications: email + WhatsApp to BOTH client and therapist (same as manual booking).
        // Only send the real Meet link — never the fallback placeholder.
        try {
          const emailResult = await emailService.sendSessionConfirmation({
            clientName, psychologistName,
            sessionDate: scheduled_date, sessionTime: scheduled_time,
            sessionDuration: `${nextPkgMeetMinutes} minutes`,
            clientEmail: clientEmail || undefined,
            psychologistEmail: psychologistDetails?.email || undefined,
            googleMeetLink: effectiveMeetLink, meetLink: effectiveMeetLink,
            googleCalendarEventId: meetResult?.eventId || null,
            sessionId: session.id, amount: 0, price: 0,
            status: 'booked', psychologistId, clientId: client_id, packageInfo,
          });
          if (emailResult?.clientEmailSent === true) {
            await writeSessionDeliveryMarkers(session.id, { email_sent_at: new Date().toISOString() });
          }
        } catch (e) { console.error('[BOOK PACKAGE NEXT] email failed:', e.message); }

        try {
          if (clientDetails?.phone_number) {
            const res = await interaktService.sendBookingConfirmation(clientDetails.phone_number, {
              clientName, psychologistName, date: scheduled_date, time: scheduled_time, meetLink: effectiveMeetLink,
            });
            if (res?.success) await writeSessionDeliveryMarkers(session.id, { whatsapp_sent_at: new Date().toISOString() });
          }
          if (psychologistDetails?.phone) {
            await interaktService.sendSessionNotificationPsychologist(psychologistDetails.phone, {
              therapistName: psychologistName, clientName, date: scheduled_date, time: scheduled_time, meetLink: effectiveMeetLink,
            });
          }
        } catch (e) { console.error('[BOOK PACKAGE NEXT] whatsapp failed:', e.message); }

        try {
          const sessionReminderService = require('../services/sessionReminderService');
          sessionReminderService.checkAndSendReminderForSessionId(session.id).catch(err =>
            console.error('Priority reminder check error:', err)
          );
        } catch (_) {}
      } catch (asyncErr) {
        console.error('Book package next session async error:', asyncErr);
      }
    });
  } catch (error) {
    console.error('bookPackageNextSession error:', error);
    res.status(500).json(
      errorResponse(error.message || 'Failed to book next package session')
    );
  }
};

// Get packages with remaining sessions (admin only) - for Packages tab.
// Returns all client+package combinations that have package sessions, with upcoming booked sessions
// and can_book_next true only when at least one session is completed and there are remaining to book.
const getPackagesWithRemainingSessions = async (req, res) => {
  try {
    // Pull sessions that are either:
    //  • Linked to a real packages-table entry (package_id IS NOT NULL), or
    //  • Wix-synced packages (session_type='package' with session_count > 1)
    const { data: sessions } = await supabaseAdmin
      .from('sessions')
      .select('id, client_id, psychologist_id, package_id, package_group_id, session_type, session_count, status, scheduled_date, scheduled_time, wix_payload, price')
      .or('package_id.not.is.null,session_type.eq.package')
      .neq('session_type', 'free_assessment');

    if (!sessions || sessions.length === 0) {
      return res.json(successResponse({ packages: [] }));
    }

    const byKey = {};
    sessions.forEach(s => {
      if (!s.client_id) return;
      // Real package: keyed by client_id + package_id
      if (s.package_id) {
        const key = `pkg_${s.client_id}_${s.package_id}`;
        if (!byKey[key]) byKey[key] = { kind: 'real', client_id: s.client_id, package_id: s.package_id, psychologist_id: s.psychologist_id, sessions: [] };
        byKey[key].sessions.push(s);
        return;
      }
      // Wix package (no real package_id): only count if session_count > 1
      if (s.session_type === 'package' && Number(s.session_count) > 1) {
        // Group by client + psychologist + session_count + subscriptionId/group_id
        const groupId = s.package_group_id
          || s.wix_payload?.subscriptionId
          || s.wix_payload?.pricingPlanInfo?.planName
          || `wix_${s.session_count}`;
        const key = `wix_${s.client_id}_${s.psychologist_id}_${groupId}`;
        if (!byKey[key]) byKey[key] = {
          kind: 'wix',
          client_id: s.client_id,
          psychologist_id: s.psychologist_id,
          package_id: null,
          session_count: s.session_count,
          plan_name: s.wix_payload?.pricingPlanInfo?.planName || s.wix_payload?.planName || null,
          group_id: groupId,
          sessions: [],
        };
        byKey[key].sessions.push(s);
      }
    });

    // Only look up real packages (skip Wix synthetic entries which have package_id = null)
    const packageIds = [...new Set(Object.values(byKey).filter(p => p.kind === 'real').map(p => p.package_id))];
    let packagesMap = {};
    if (packageIds.length > 0) {
      const { data: packages } = await supabaseAdmin
        .from('packages')
        .select('id, name, package_type, session_count, psychologist_id, price')
        .in('id', packageIds);
      packagesMap = (packages || []).reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
    }
    // Reference for later — also used in psychIds collection below
    const packages = Object.values(packagesMap);

    const clientIds = [...new Set(Object.values(byKey).map(p => p.client_id))];
    const { data: clients } = await supabaseAdmin
      .from('clients')
      .select('id, first_name, last_name, child_name')
      .in('id', clientIds);
    const clientsMap = (clients || []).reduce((acc, c) => { acc[c.id] = c; return acc; }, {});

    const psychIds = [...new Set([...Object.values(byKey).map(p => p.psychologist_id), ...(packages || []).map(p => p.psychologist_id)].filter(Boolean))];
    const { data: psychologists } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name')
      .in('id', psychIds);
    const psychologistsMap = (psychologists || []).reduce((acc, p) => { acc[p.id] = p; return acc; }, {});

    const bookedStatuses = ['booked', 'scheduled', 'reschedule_requested', 'rescheduled'];

    const result = [];
    Object.values(byKey).forEach(entry => {
      // Resolve package metadata — real package looks it up; Wix synthesizes one
      const pkg = entry.kind === 'real' ? packagesMap[entry.package_id] : null;
      const total = entry.kind === 'real'
        ? (pkg?.session_count || 0)
        : (Number(entry.session_count) || 0);
      // For real packages: require pkg metadata to exist
      if (entry.kind === 'real' && !pkg) return;

      let completed = 0;
      let booked = 0;
      const upcomingSessions = [];
      entry.sessions.forEach(s => {
        if (s.status === 'completed') completed++;
        else if (s.status !== 'cancelled' && s.status !== 'no_show' && s.status !== 'noshow') booked++;
        if (bookedStatuses.includes(s.status) && s.scheduled_date && s.scheduled_time) {
          upcomingSessions.push({
            id: s.id,
            scheduled_date: s.scheduled_date,
            scheduled_time: s.scheduled_time,
            status: s.status
          });
        }
      });
      upcomingSessions.sort((a, b) => {
        const d = (a.scheduled_date || '').localeCompare(b.scheduled_date || '');
        return d !== 0 ? d : (a.scheduled_time || '').localeCompare(b.scheduled_time || '');
      });
      const remaining = Math.max(total - completed - booked, 0);
      const canBookNext = completed > 0 && remaining > 0;

      // Skip fully completed packages - they belong in the Completed tab only
      if (total > 0 && completed >= total) return;

      const client = clientsMap[entry.client_id];
      const psychologist = psychologistsMap[entry.psychologist_id] || (pkg && psychologistsMap[pkg.psychologist_id]);
      const psychId = psychologist?.id || entry.psychologist_id || (pkg && pkg.psychologist_id) || null;

      if (entry.kind === 'real') {
        result.push({
          client_id: entry.client_id,
          psychologist_id: psychId,
          package_id: entry.package_id,
          client: client || { id: entry.client_id, first_name: '', last_name: '' },
          psychologist: psychologist || { id: psychId, first_name: '', last_name: '' },
          package: {
            id: pkg.id,
            name: pkg.name || null,
            package_type: pkg.package_type,
            price: pkg.price ?? null,
            session_count: total,
            total_sessions: total,
            completed_sessions: completed,
            remaining_sessions: remaining,
            can_book_next: canBookNext
          },
          upcoming_sessions: upcomingSessions
        });
      } else {
        // Wix-style package — synthesize metadata
        result.push({
          client_id: entry.client_id,
          psychologist_id: psychId,
          package_id: null,
          wix_package_group_id: entry.group_id,
          client: client || { id: entry.client_id, first_name: '', last_name: '' },
          psychologist: psychologist || { id: psychId, first_name: '', last_name: '' },
          package: {
            id: null,
            name: entry.plan_name || `Wix Package (${total} sessions)`,
            package_type: 'wix_plan',
            price: null,
            session_count: total,
            total_sessions: total,
            completed_sessions: completed,
            remaining_sessions: remaining,
            can_book_next: canBookNext,
            source: 'wix'
          },
          upcoming_sessions: upcomingSessions
        });
      }
    });

    return res.json(successResponse({ packages: result }));
  } catch (error) {
    console.error('getPackagesWithRemainingSessions error:', error);
    res.status(500).json(
      errorResponse(error.message || 'Failed to fetch packages with remaining sessions')
    );
  }
};

/**
 * Returns stable A/B/C labels for clients who have MORE THAN ONE package with the same
 * therapist. Computed over ALL package sessions (not a paginated page), so the label for a
 * given package never changes based on the current filter, search, or page in the UI.
 *
 * Response shape:
 *   { labels: { "<clientId>|<psychId>": { "<package_group_id>": "A", "<group2>": "B" } } }
 * Only pairs with >1 distinct package group are included (a lone package needs no label).
 * Ordering is by each group's earliest session date, then group id as a deterministic tie-break.
 */
const getPackageLabels = async (req, res) => {
  try {
    // Pull all package-ish sessions (paginate to avoid the default row cap).
    let all = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('sessions')
        .select('client_id, psychologist_id, package_group_id, scheduled_date, session_type, session_count')
        .or('session_type.eq.package,session_count.gt.1')
        .range(from, from + 999);
      if (error) throw error;
      if (!data || !data.length) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }

    // pair -> { groupId: earliestDate }
    const pairs = {};
    for (const s of all) {
      if (!s.client_id || !s.psychologist_id || !s.package_group_id) continue;
      const isPkg = s.session_type === 'package' || Number(s.session_count) > 1;
      if (!isPkg) continue;
      const pair = `${s.client_id}|${s.psychologist_id}`;
      const d = s.scheduled_date || '9999-12-31';
      pairs[pair] = pairs[pair] || {};
      if (!pairs[pair][s.package_group_id] || d < pairs[pair][s.package_group_id]) {
        pairs[pair][s.package_group_id] = d;
      }
    }

    const labels = {};
    for (const pair of Object.keys(pairs)) {
      const groups = Object.entries(pairs[pair]).sort(
        (a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])
      );
      if (groups.length > 1) {
        labels[pair] = {};
        groups.forEach(([gid], i) => {
          labels[pair][gid] = String.fromCharCode(65 + i); // A, B, C, …
        });
      }
    }

    return res.json(successResponse({ labels }));
  } catch (error) {
    console.error('getPackageLabels error:', error);
    return res.status(500).json(
      errorResponse(error.message || 'Failed to compute package labels')
    );
  }
};

const getEventRegistrations = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('event_registrations')
      .select(
        'id, event_slug, event_title, full_name, email, country_code, phone, whatsapp_e164, session_join_url, created_at'
      )
      .order('created_at', { ascending: false });

    if (error) {
      const msg = error.message || String(error);
      if (msg.includes('does not exist') || msg.includes('schema cache')) {
        return res.status(503).json(
          errorResponse(
            'Event registrations table not found. Run backend/scripts/create-event-registrations.sql in Supabase SQL Editor.'
          )
        );
      }
      return res.status(500).json(errorResponse(msg));
    }

    const bySlug = new Map();
    for (const row of data || []) {
      const slug = row.event_slug || 'unknown';
      if (!bySlug.has(slug)) {
        bySlug.set(slug, {
          event_slug: slug,
          event_title: row.event_title || slug.replace(/-/g, ' '),
          registrations: [],
        });
      }
      const ev = bySlug.get(slug);
      if (row.event_title && row.event_title.length > (ev.event_title?.length || 0)) {
        ev.event_title = row.event_title;
      }
      ev.registrations.push({
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        country_code: row.country_code,
        phone: row.phone,
        whatsapp_e164: row.whatsapp_e164,
        session_join_url: row.session_join_url || null,
        created_at: row.created_at,
      });
    }

    const events = Array.from(bySlug.values());
    res.json(successResponse({ events }));
  } catch (err) {
    console.error('getEventRegistrations:', err);
    res.status(500).json(errorResponse(err.message || 'Failed to load event registrations'));
  }
};

const updateEventRegistration = async (req, res) => {
  try {
    const { registrationId } = req.params;
    const body = req.body || {};
    const patch = {};

    if (body.full_name !== undefined) patch.full_name = String(body.full_name || '').trim();
    if (body.email !== undefined) patch.email = String(body.email || '').trim().toLowerCase();
    if (body.country_code !== undefined) patch.country_code = String(body.country_code || '').trim();
    if (body.phone !== undefined) patch.phone = String(body.phone || '').trim();
    if (body.event_slug !== undefined) patch.event_slug = String(body.event_slug || '').trim();
    if (body.event_title !== undefined) patch.event_title = String(body.event_title || '').trim();

    if (patch.full_name !== undefined && patch.full_name.length < 2) {
      return res.status(400).json(errorResponse('Please provide a valid full name.'));
    }
    if (patch.email !== undefined) {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(patch.email)) {
        return res.status(400).json(errorResponse('Please provide a valid email.'));
      }
    }
    if (patch.phone !== undefined && patch.phone.length < 6) {
      return res.status(400).json(errorResponse('Please provide a valid phone number.'));
    }
    if (patch.event_slug !== undefined && !patch.event_slug) {
      return res.status(400).json(errorResponse('Event slug cannot be empty.'));
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json(errorResponse('No fields provided to update.'));
    }

    const { data, error } = await supabaseAdmin
      .from('event_registrations')
      .update(patch)
      .eq('id', registrationId)
      .select(
        'id, event_slug, event_title, full_name, email, country_code, phone, whatsapp_e164, session_join_url, created_at'
      )
      .single();

    if (error) {
      const msg = error.message || String(error);
      if (error.code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
        return res.status(409).json(errorResponse('This email is already registered for the selected event.'));
      }
      if (msg.includes('not found') || msg.includes('No rows')) {
        return res.status(404).json(errorResponse('Registration not found.'));
      }
      return res.status(500).json(errorResponse(msg));
    }

    return res.json(successResponse({ registration: data }, 'Registration updated successfully'));
  } catch (err) {
    console.error('updateEventRegistration:', err);
    return res.status(500).json(errorResponse(err.message || 'Failed to update registration'));
  }
};

const deleteEventRegistration = async (req, res) => {
  try {
    const { registrationId } = req.params;
    const { error } = await supabaseAdmin
      .from('event_registrations')
      .delete()
      .eq('id', registrationId);

    if (error) {
      return res.status(500).json(errorResponse(error.message || 'Failed to delete registration'));
    }

    return res.json(successResponse(null, 'Registration deleted successfully'));
  } catch (err) {
    console.error('deleteEventRegistration:', err);
    return res.status(500).json(errorResponse(err.message || 'Failed to delete registration'));
  }
};

module.exports = {
  getAllUsers,
  getUserDetails,
  updateUserRole,
  deactivateUser,
  getPlatformStats,
  searchUsers,
  getRecentUsers,
  getRecentBookings,
  getEventRegistrations,
  updateEventRegistration,
  deleteEventRegistration,
  getAllPsychologists,
  createPsychologist,
  updatePsychologist,
  deletePsychologist,
  updateAllPsychologistsAvailability,
  createUser,
  updateUser,
  deleteUser,
  updateSession,
  getPsychologistAvailabilityForReschedule,
  createManualBooking,
  createManualPackageBooking,
  createRecordOnlyBooking,
  createRecordOnlyPackage,
  bookPackageNextSession,
  getPackagesWithRemainingSessions,
  getPackageLabels,
  getRescheduleRequests,
  getPsychologistCalendarEvents
};
