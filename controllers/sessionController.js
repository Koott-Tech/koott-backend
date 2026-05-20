const { supabaseAdmin } = require('../config/supabase');
const { 
  successResponse, 
  errorResponse,
  formatDate,
  formatTime,
  addMinutesToTime
} = require('../utils/helpers');
const { getSessionBookingCreatedAtIso } = require('../utils/sessionBookingCreatedAt');
const { getBookingTimeColumnKey, appendBookingTimeSelectFragment } = require('../utils/sessionsBookingTimeColumn');
const { createRealMeetLink } = require('../utils/meetEventHelper'); // Use real Meet link creation
const meetLinkService = require('../utils/meetLinkService'); // New Meet Link Service
const emailService = require('../utils/emailService');
const availabilityService = require('../utils/availabilityCalendarService');
const { assertClientPackageHasAvailableSlot } = require('../services/packageService');
const { getMeetEventDurationMinutes } = require('../utils/sessionMeetDuration');
const {
  enrichSessionRowDisplayFields,
  hydrateSessionsWixPayloadFromMirror,
} = require('../utils/wixSessionRowEnrichment');

function isHiddenWixListRow(session) {
  const src = String(session?.source || '').toLowerCase();
  if (src !== 'wix') return false;
  const wp = session?.wix_payload;
  const missingSessionId = !wp || typeof wp !== 'object' || !wp.sessionId;
  const isUndefinedWix = !session?.payment_id && missingSessionId;
  const isPackageChild = Number(session?.package_session_number || 1) > 1;
  return isUndefinedWix || isPackageChild;
}

// Book a new session
const bookSession = async (req, res) => {
  try {
    const { psychologist_id, scheduled_date, scheduled_time, price } = req.body;

    // Validate required fields
    if (!psychologist_id || !scheduled_date || !scheduled_time) {
      return res.status(400).json(
        errorResponse('Missing required fields: psychologist_id, scheduled_date, scheduled_time')
      );
    }

    // Get client_id from authenticated user
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if user is a client
    if (userRole !== 'client') {
      return res.status(403).json(
        errorResponse('Only clients can book sessions')
      );
    }

    // req.user.id is already the client ID, no need to lookup
    const clientId = userId;

    // Check if the time slot is available using availability service
    console.log('🔍 Checking time slot availability...');
    const isAvailable = await availabilityService.isTimeSlotAvailable(
      psychologist_id, 
      scheduled_date, 
      scheduled_time
    );

    if (!isAvailable) {
      return res.status(400).json(
        errorResponse('This time slot is not available. Please select another time.')
      );
    }

    console.log('✅ Time slot is available');

    // Get client and psychologist details for Google Calendar
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: clientDetails, error: clientDetailsError } = await supabaseAdmin
      .from('clients')
      .select(`
        first_name, 
        last_name, 
        child_name,
        user:users(email)
      `)
      .eq('id', clientId)
      .single();

    if (clientDetailsError || !clientDetails) {
      console.error('Error fetching client details:', clientDetailsError);
      return res.status(500).json(
        errorResponse('Failed to fetch client details')
      );
    }

    const { data: psychologistDetails, error: psychologistDetailsError } = await supabaseAdmin
      .from('psychologists')
      .select('first_name, last_name, email, google_calendar_credentials')
      .eq('id', psychologist_id)
      .single();

    if (psychologistDetailsError || !psychologistDetails) {
      console.error('Error fetching psychologist details:', psychologistDetailsError);
      return res.status(500).json(
        errorResponse('Failed to fetch psychologist details')
      );
    }

    // TEMPORARY: disable auto Google Meet scheduling for new bookings.
    const DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING = true;

    // Create real Google Meet link using Meet Link Service
    let meetData = null;
    if (DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING) {
      console.log('ℹ️ Google Meet auto-scheduling is temporarily disabled (sessionController.bookSession).');
    } else try {
      console.log('🔄 Creating real Google Meet link...');

      let creds = psychologistDetails.google_calendar_credentials;
      if (typeof creds === 'string') {
        try {
          creds = JSON.parse(creds);
        } catch (_) {
          creds = null;
        }
      }
      let userAuth = null;
      if (creds?.access_token) {
        userAuth = {
          access_token: creds.access_token,
          refresh_token: creds.refresh_token,
          expiry_date: creds.expiry_date
        };
        console.log('✅ Using psychologist Google Calendar OAuth for Meet + calendar event');
      } else {
        console.log('⚠️ Psychologist has no Google Calendar OAuth — event may not appear on their calendar');
      }

      const clientUserEmail = Array.isArray(clientDetails.user)
        ? clientDetails.user[0]?.email
        : clientDetails.user?.email;

      // Prepare session data for Meet link creation (emails → Calendar invites)
      const sessionData = {
        summary: `Therapy Session - ${clientDetails.child_name || clientDetails.first_name} with ${psychologistDetails.first_name}`,
        description: `Online therapy session between ${clientDetails.child_name || clientDetails.first_name} and ${psychologistDetails.first_name} ${psychologistDetails.last_name}`,
        startDate: scheduled_date,
        startTime: scheduled_time,
        endTime: addMinutesToTime(scheduled_time, 50), // 50-minute session
        clientEmail: clientUserEmail,
        psychologistEmail: psychologistDetails.email
      };
      
      // Use the new Meet Link Service for real Meet link creation
      const meetResult = await meetLinkService.generateSessionMeetLink(sessionData, userAuth);
      
      if (meetResult.success) {
        meetData = {
          meetLink: meetResult.meetLink,
          eventId: meetResult.eventId,
          calendarLink: meetResult.eventLink || null,
          method: meetResult.method,
          _refreshedTokens: meetResult.refreshedTokens || null
        };
        
        console.log('✅ Real Google Meet link created successfully!');
        console.log('   Method:', meetResult.method);
        console.log('   Meet Link:', meetResult.meetLink);
        console.log('   Event ID:', meetResult.eventId);
      } else {
        console.log('⚠️ Meet link creation failed, using fallback');
        meetData = {
          meetLink: meetResult.meetLink, // Fallback link
          eventId: null,
          calendarLink: null,
          method: 'fallback'
        };
      }
    } catch (meetError) {
      console.error('❌ Meet link creation failed:', meetError);
      console.log('   Continuing with session creation without Meet link...');
      // Continue with session creation even if meet creation fails
    }

    // Create the session with Google Calendar data
    const sessionData = {
      client_id: clientId,
      psychologist_id,
      scheduled_date,
      scheduled_time,
      status: 'booked',
      session_notes: req.body.notes || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      original_scheduled_date: scheduled_date
    };

    // Add meet data if available
    if (meetData) {
      sessionData.google_calendar_event_id = meetData.eventId;
      sessionData.google_meet_link = meetData.meetLink;
      sessionData.google_meet_join_url = meetData.meetLink;
      sessionData.google_meet_start_url = meetData.meetLink;
      if (meetData.calendarLink) {
        sessionData.google_calendar_link = meetData.calendarLink;
      }
    }

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: session, error: createError } = await supabaseAdmin
      .from('sessions')
      .insert(sessionData)
      .select()
      .single();

    if (createError) {
      console.error('Create session error:', createError);
      
      // Check if it's a unique constraint violation (double booking)
      if (createError.code === '23505' || 
          createError.message?.includes('unique') || 
          createError.message?.includes('duplicate')) {
        console.log('⚠️ Double booking detected - slot was just booked by another user');
        return res.status(409).json(
          errorResponse('This time slot was just booked by another user. Please select another time.')
        );
      }
      
      return res.status(500).json(
        errorResponse('Failed to create session')
      );
    }

    if (meetData?._refreshedTokens) {
      try {
        await supabaseAdmin
          .from('psychologists')
          .update({
            google_calendar_credentials: {
              access_token: meetData._refreshedTokens.access_token,
              refresh_token: meetData._refreshedTokens.refresh_token,
              expiry_date: meetData._refreshedTokens.expiry_date
            }
          })
          .eq('id', psychologist_id);
        console.log('✅ Persisted refreshed Google Calendar OAuth tokens for psychologist');
      } catch (tokenPersistErr) {
        console.error('⚠️ Failed to persist refreshed OAuth tokens:', tokenPersistErr.message);
      }
    }

    // Update availability to block this time slot
    try {
      await availabilityService.updateAvailabilityOnBooking(
        psychologist_id, 
        scheduled_date, 
        scheduled_time
      );
      console.log('✅ Availability updated for booked time slot');
    } catch (availabilityError) {
      console.error('Error updating availability:', availabilityError);
      // Continue even if availability update fails
    }

    // TEMPORARY: Auto booking notifications are disabled.
    // (Disabled: email + WhatsApp on new booking)
    console.log('ℹ️ Booking notifications are temporarily disabled (sessionController.bookSession).');

    res.status(201).json(
      successResponse({
        session,
        message: 'Session booked successfully'
      })
    );

  } catch (error) {
    console.error('Book session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while booking session')
    );
  }
};

// Get all sessions (admin only)
const getAllSessions = async (req, res) => {
  try {
    console.log('getAllSessions called with user:', req.user);
    
    // Check if user is admin, superadmin, or finance
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin' && req.user.role !== 'finance')) {
      console.log('Access denied - user role:', req.user?.role);
      return res.status(403).json(
        errorResponse('Access denied. Admin, Superadmin, or Finance role required.')
      );
    }

    const { supabaseAdmin } = require('../config/supabase');
    const adminBookingTimeCol = await getBookingTimeColumnKey(supabaseAdmin);

    const { page = 1, limit = 10, status, psychologist_id, client_id, date, dateFrom, dateTo, sort = 'created_at', order = 'desc', search = '' } = req.query;

    // ?status=booked&status=rescheduled OR ?status=booked,rescheduled OR ?status=booked
    const normalizeStatusList = (raw) => {
      if (raw == null || raw === '') return [];
      const parts = Array.isArray(raw)
        ? raw.flatMap((x) => String(x).split(','))
        : String(raw).split(',');
      return parts.map((s) => s.trim()).filter(Boolean);
    };

    let statusList = normalizeStatusList(status);

    // Admin Booked tab: include rescheduled (comma may be stripped by proxies; some clients send only booked)
    if (statusList.length === 1 && statusList[0].toLowerCase() === 'booked') {
      statusList = ['booked', 'rescheduled'];
    }

    const applySessionStatusFilter = (q) => {
      if (statusList.length === 0) return q;
      if (statusList.length === 1) return q.eq('status', statusList[0]);
      return q.in('status', statusList);
    };

    // First, get the total count of sessions (without pagination)
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let countQuery = supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .neq('session_type', 'free_assessment'); // Exclude free assessments

    // Apply same filters for count
    countQuery = applySessionStatusFilter(countQuery);
    if (psychologist_id) {
      countQuery = countQuery.eq('psychologist_id', psychologist_id);
    }
    if (client_id) {
      countQuery = countQuery.eq('client_id', client_id);
    }
    if (date) {
      countQuery = countQuery.eq('scheduled_date', date);
    }
    // Date range filter uses booking_created_at when the column exists, else created_at.
    if (dateFrom) {
      countQuery = countQuery.gte(adminBookingTimeCol, `${dateFrom}T00:00:00+05:30`);
    }
    if (dateTo) {
      countQuery = countQuery.lte(adminBookingTimeCol, `${dateTo}T23:59:59.999+05:30`);
    }
    // Note: free_assessment exclusion already applied above

    const { count: sessionsCount, error: countError } = await countQuery;
    console.log('Total sessions count:', sessionsCount);

    // Now fetch the paginated sessions
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    // Exclude free assessments - they have their own page
    // Note: we intentionally do NOT embed `user:users(email)` inside clients
    // here because PostgREST can't resolve the clients→users relationship in
    // this project's schema cache. Email is fetched separately below and
    // reattached as client.user.email so the frontend contract is preserved.
    let query = supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(
          id,
          user_id,
          first_name,
          last_name,
          child_name,
          child_age,
          phone_number
        ),
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          area_of_expertise,
          email
        )
      `)
      .neq('session_type', 'free_assessment'); // Exclude free assessments

    console.log('Supabase query built, executing...');

    // Apply filters
    query = applySessionStatusFilter(query);
    if (psychologist_id) {
      query = query.eq('psychologist_id', psychologist_id);
    }
    if (client_id) {
      query = query.eq('client_id', client_id);
    }
    if (date) {
      query = query.eq('scheduled_date', date);
    }
    // Filter by client booking time column (see getBookingTimeColumnKey).
    if (dateFrom) {
      query = query.gte(adminBookingTimeCol, `${dateFrom}T00:00:00+05:30`);
    }
    if (dateTo) {
      query = query.lte(adminBookingTimeCol, `${dateTo}T23:59:59.999+05:30`);
    }

    // Apply sorting (scheduled_time as tiebreaker so "All" matches Booked-style ordering)
    if (sort && order) {
      const asc = order === 'asc';
      const sortCol = sort === 'created_at' ? adminBookingTimeCol : sort;
      query = query.order(sortCol, { ascending: asc });
      if (sortCol === 'scheduled_date') {
        query = query.order('scheduled_time', { ascending: asc });
      }
    }

    // Don't paginate yet - we need to combine with assessment sessions first
    console.log('Executing query for all sessions (no pagination yet)...');
    const { data: sessions, error } = await query;
    console.log('Query result:', { sessionsCount: sessions?.length, error });

    if (error) {
      console.error('Get all sessions error:', error);
      return res.status(500).json(
        errorResponse(
          `Failed to fetch sessions: ${error.message || 'unknown'}${error.code ? ` [${error.code}]` : ''}${error.details ? ` — ${error.details}` : ''}`
        )
      );
    }

    if (sessions && sessions.length) {
      sessions.forEach((s) => {
        s.booking_created_at = getSessionBookingCreatedAtIso(s);
      });
    }

    // Replace Velo therapist-only stubs on sessions.wix_payload with full payload from wix_bookings when present
    if (sessions && sessions.length) {
      await hydrateSessionsWixPayloadFromMirror(supabaseAdmin, sessions);
    }

    // Wix rows may lack client/psychologist FKs and DB date/price; derive from wix_payload for list UIs
    if (sessions && sessions.length) {
      sessions.forEach((s) => enrichSessionRowDisplayFields(s));
    }

    // Fetch package data for sessions that have package_id
    // Since there's no direct foreign key relationship, fetch separately
    if (sessions && sessions.length > 0) {
      const packageIds = [...new Set(sessions.map(s => s.package_id).filter(Boolean))];
      
      if (packageIds.length > 0) {
        const { data: packages, error: packagesError } = await supabaseAdmin
          .from('packages')
          .select('id, name, package_type, price, description, session_count')
          .in('id', packageIds);

        if (!packagesError && packages) {
          const packagesMap = packages.reduce((acc, pkg) => {
            acc[pkg.id] = pkg;
            return acc;
          }, {});

          // Fetch ALL sessions per package to determine session numbers and completed counts
          const pkgBcf = appendBookingTimeSelectFragment(adminBookingTimeCol);
          const { data: allPackageSessions, error: allPackageSessionsError } = await supabaseAdmin
            .from('sessions')
            .select(`id, package_id, client_id, status, created_at, ${pkgBcf} wix_payload, source`)
            .in('package_id', packageIds)
            .order(adminBookingTimeCol, { ascending: true });

          const completedCountsByClientPackage = {};
          const sessionNumberMap = {};
          if (!allPackageSessionsError && allPackageSessions) {
            const counterByClientPackage = {};
            allPackageSessions.forEach(s => {
              if (s.package_id && s.client_id) {
                const key = `${s.client_id}_${s.package_id}`;
                if (s.status === 'completed') {
                  completedCountsByClientPackage[key] = (completedCountsByClientPackage[key] || 0) + 1;
                }
                counterByClientPackage[key] = (counterByClientPackage[key] || 0) + 1;
                sessionNumberMap[s.id] = counterByClientPackage[key];
              }
            });
          }

          sessions.forEach(session => {
            if (session.package_id && packagesMap[session.package_id]) {
              const pkg = { ...packagesMap[session.package_id] };
              const totalSessions = pkg.session_count || 0;
              const key = `${session.client_id}_${session.package_id}`;
              pkg.completed_sessions = completedCountsByClientPackage[key] || 0;
              pkg.total_sessions = totalSessions;
              pkg.session_number = sessionNumberMap[session.id] || null;
              session.package = pkg;
            }
          });
        }
      }
    }

    // Also fetch assessment sessions for admin dashboard
    let assessmentSessions = [];
    let assessmentSessionsCount = 0;
    try {
      const { supabaseAdmin } = require('../config/supabase');
      
      // First get total count of assessment sessions
      let assessCountQuery = supabaseAdmin
        .from('assessment_sessions')
        .select('*', { count: 'exact', head: true });

      // Apply same filters for count
      assessCountQuery = applySessionStatusFilter(assessCountQuery);
      if (psychologist_id) {
        assessCountQuery = assessCountQuery.eq('psychologist_id', psychologist_id);
      }
      if (client_id) {
        assessCountQuery = assessCountQuery.eq('client_id', client_id);
      }
      if (date) {
        assessCountQuery = assessCountQuery.eq('scheduled_date', date);
      }
      // Use created_at (booking creation date) for date-range filtering — consistent with
      // therapy sessions which filter on booking_created_at. This ensures "today's sessions"
      // counts bookings made today, not appointments scheduled today.
      if (dateFrom) {
        assessCountQuery = assessCountQuery.gte('created_at', `${dateFrom}T00:00:00+05:30`);
      }
      if (dateTo) {
        assessCountQuery = assessCountQuery.lte('created_at', `${dateTo}T23:59:59.999+05:30`);
      }

      const { count: assessCount, error: assessCountError } = await assessCountQuery;
      assessmentSessionsCount = assessCount || 0;
      console.log('Total assessment sessions count:', assessmentSessionsCount);

      // Now fetch all assessment sessions (we'll combine and paginate in memory)
      // assessment_sessions has no FK relationships in the schema cache — use flat select + manual enrichment
      let assessQuery = supabaseAdmin
        .from('assessment_sessions')
        .select('id, client_id, psychologist_id, scheduled_date, scheduled_time, status, amount, created_at, updated_at');

      // Apply same filters as regular sessions
      assessQuery = applySessionStatusFilter(assessQuery);
      if (psychologist_id) {
        assessQuery = assessQuery.eq('psychologist_id', psychologist_id);
      }
      if (client_id) {
        assessQuery = assessQuery.eq('client_id', client_id);
      }
      if (date) {
        assessQuery = assessQuery.eq('scheduled_date', date);
      }
      if (dateFrom) {
        assessQuery = assessQuery.gte('created_at', `${dateFrom}T00:00:00+05:30`);
      }
      if (dateTo) {
        assessQuery = assessQuery.lte('created_at', `${dateTo}T23:59:59.999+05:30`);
      }

      // Apply sorting (match therapy sessions: date + time)
      if (sort && order) {
        const asc = order === 'asc';
        assessQuery = assessQuery.order(sort, { ascending: asc });
        if (sort === 'scheduled_date') {
          assessQuery = assessQuery.order('scheduled_time', { ascending: asc });
        }
      }

      const { data: assessData, error: assessError } = await assessQuery;

      if (assessError) {
        console.error('Error fetching assessment sessions:', assessError);
      } else {
        // Manually enrich with client and psychologist data (no FK relationships in schema cache)
        const clientIds = [...new Set((assessData || []).map(r => r.client_id).filter(Boolean))];
        const psychIds  = [...new Set((assessData || []).map(r => r.psychologist_id).filter(Boolean))];

        let enrichedClients = [];
        let enrichedPsychs  = [];

        if (clientIds.length) {
          const { data } = await supabaseAdmin
            .from('clients')
            .select('id, user_id, first_name, last_name, child_name, child_age, phone_number')
            .in('id', clientIds);
          enrichedClients = data || [];
        }
        if (psychIds.length) {
          const { data } = await supabaseAdmin
            .from('psychologists')
            .select('id, first_name, last_name, area_of_expertise, email')
            .in('id', psychIds);
          enrichedPsychs = data || [];
        }

        const clientMap = new Map(enrichedClients.map(c => [c.id, c]));
        const psychMap  = new Map(enrichedPsychs.map(p => [p.id, p]));

        assessmentSessions = (assessData || []).map(a => ({
          ...a,
          client:       clientMap.get(a.client_id) || null,
          psychologist: psychMap.get(a.psychologist_id) || null,
          session_type: 'assessment',
          type:         'assessment',
          assessment_title: 'Assessment',
        }));

        console.log(`✅ Found ${assessmentSessions.length} assessment sessions for admin dashboard`);
      }
    } catch (assessError) {
      console.error('Error fetching assessment sessions (non-blocking):', assessError);
    }

    // Reattach client email via a separate users lookup (avoids PostgREST
    // clients→users relationship embed which isn't resolvable on this schema).
    try {
      const userIds = new Set();
      for (const s of sessions || []) {
        const uid = s?.client?.user_id;
        if (uid) userIds.add(uid);
      }
      for (const s of assessmentSessions) {
        const uid = s?.client?.user_id;
        if (uid) userIds.add(uid);
      }
      if (userIds.size) {
        const { data: users, error: usersError } = await supabaseAdmin
          .from('users')
          .select('id, email')
          .in('id', [...userIds]);
        if (!usersError && users) {
          const emailById = new Map(users.map((u) => [u.id, u.email]));
          const attach = (s) => {
            if (s?.client && s.client.user_id) {
              s.client.user = { email: emailById.get(s.client.user_id) || null };
            }
          };
          (sessions || []).forEach(attach);
          assessmentSessions.forEach(attach);
        } else if (usersError) {
          console.warn('[getAllSessions] users email lookup failed:', usersError.message || usersError);
        }
      }
    } catch (emailAttachError) {
      console.warn('[getAllSessions] email reattach non-blocking error:', emailAttachError?.message || emailAttachError);
    }

    // Combine regular sessions and assessment sessions
    // Wall-clock date+time are interpreted as Asia/Kolkata (same as admin date filters / product).
    /** Millis for wall-clock sort; missing date → null (caller sorts those last — avoids bare stubs on page 1). */
    const scheduledDateTimeMs = (s) => {
      const d = s?.scheduled_date;
      if (!d) return null;
      const dateOnly = String(d).slice(0, 10);
      const rawT = s.scheduled_time != null ? String(s.scheduled_time) : '00:00:00';
      const t = rawT.split('.')[0].trim();
      const parts = t.split(':');
      const hh = String(parts[0] || '00').padStart(2, '0');
      const mm = String(parts[1] || '00').padStart(2, '0');
      const ss = String((parts[2] || '00').split('.')[0]).padStart(2, '0');
      const ms = new Date(`${dateOnly}T${hh}:${mm}:${ss}+05:30`).getTime();
      if (Number.isFinite(ms)) return ms;
      const fallback = new Date(`${dateOnly}T00:00:00+05:30`).getTime();
      return Number.isFinite(fallback) ? fallback : null;
    };

    const scheduledSortKey = (s) => {
      const ms = scheduledDateTimeMs(s);
      if (ms != null && Number.isFinite(ms)) return ms;
      return sort === 'scheduled_date' && order === 'asc'
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY;
    };

    // Admin "Upcoming" (booked + rescheduled) and Rescheduled tab: show next session from now first,
    // not the earliest calendar day in the range (which buries today's slots behind overdue rows).
    const nearestFirstUpcomingView =
      sort === 'scheduled_date' &&
      order === 'asc' &&
      statusList.length > 0 &&
      statusList.every((s) => s === 'booked' || s === 'rescheduled');

    const nowMs = Date.now();

    let allSessions = [...(sessions || []), ...assessmentSessions]
      .sort((a, b) => {
        if (sort === 'scheduled_date') {
          const aMs = scheduledSortKey(a);
          const bMs = scheduledSortKey(b);
          if (nearestFirstUpcomingView) {
            const aEff = scheduledDateTimeMs(a);
            const bEff = scheduledDateTimeMs(b);
            const aMissing = aEff == null || !Number.isFinite(aEff);
            const bMissing = bEff == null || !Number.isFinite(bEff);
            if (aMissing !== bMissing) return aMissing ? 1 : -1;
            if (aMissing && bMissing) return 0;
            const aPast = aEff < nowMs;
            const bPast = bEff < nowMs;
            if (aPast !== bPast) return aPast ? 1 : -1;
            if (aPast && bPast) return bEff - aEff;
            return aEff - bEff;
          }
          return order === 'asc' ? aMs - bMs : bMs - aMs;
        }
        if (sort === 'created_at') {
          const aIso = getSessionBookingCreatedAtIso(a) || a.created_at;
          const bIso = getSessionBookingCreatedAtIso(b) || b.created_at;
          const aVal = aIso ? new Date(aIso) : new Date(0);
          const bVal = bIso ? new Date(bIso) : new Date(0);
          return order === 'asc' ? aVal - bVal : bVal - aVal;
        }
        return 0;
      });

    // Apply search filtering after relation hydration to keep total count aligned with filters.
    const searchTerm = String(search || '').trim().toLowerCase();
    if (searchTerm) {
      allSessions = allSessions.filter((s) => {
        const sessionId = String(s?.id || '').toLowerCase();
        const clientName = `${s?.client?.first_name || ''} ${s?.client?.last_name || ''}`.toLowerCase();
        const clientEmail = String(s?.client?.user?.email || '').toLowerCase();
        const psychologistName = `${s?.psychologist?.first_name || ''} ${s?.psychologist?.last_name || ''}`.toLowerCase();
        return (
          sessionId.includes(searchTerm) ||
          clientName.includes(searchTerm) ||
          clientEmail.includes(searchTerm) ||
          psychologistName.includes(searchTerm)
        );
      });
    }

    const visibleSessions = allSessions.filter((s) => !isHiddenWixListRow(s));

    // Apply pagination to combined results
    // Note: Since we're combining two different tables, we need to paginate in memory
    const totalSessions = visibleSessions.length;
    const startIndex = (page - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedSessions = visibleSessions.slice(startIndex, endIndex);

    // Commission / net revenue (finance sessions table)
    try {
      const pageIds = paginatedSessions
        .filter((s) => s.session_type !== 'assessment' && s.type !== 'assessment')
        .map((s) => s.id)
        .filter(Boolean);
      if (pageIds.length) {
        const { data: commRows, error: commErr } = await supabaseAdmin
          .from('commission_history')
          .select('session_id, commission_amount, company_revenue, net_company_revenue')
          .in('session_id', pageIds);
        if (!commErr && commRows?.length) {
          const bySession = new Map(commRows.map((c) => [c.session_id, c]));
          for (const s of paginatedSessions) {
            const c = s?.id && bySession.get(s.id);
            if (c) {
              s.commission_amount = c.commission_amount ?? 0;
              s.company_revenue = c.company_revenue ?? 0;
              s.net_company_revenue = c.net_company_revenue ?? 0;
            }
          }
        }
      }
    } catch (commEx) {
      console.warn('[getAllSessions] commission attach non-blocking:', commEx?.message || commEx);
    }

    console.log('Pagination summary:', {
      sessionsCount: sessionsCount || 0,
      assessmentSessionsCount: assessmentSessionsCount || 0,
      totalSessions,
      allSessionsLength: allSessions.length,
      visibleSessionsLength: visibleSessions.length,
      page: parseInt(page),
      limit: parseInt(limit),
      startIndex,
      endIndex,
      paginatedCount: paginatedSessions.length
    });

    res.json(
      successResponse({
        sessions: paginatedSessions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalSessions
        }
      })
    );

  } catch (error) {
    console.error('Get all sessions error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching sessions')
    );
  }
};

// Get sessions for a specific client
const getClientSessions = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { page = 1, limit = 10, status } = req.query;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { supabaseAdmin } = require('../config/supabase');
    let query = supabaseAdmin
      .from('sessions')
      .select(`
        *,
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          area_of_expertise,
          email
        )
      `)
      .eq('client_id', clientId);

    if (status) {
      query = query.eq('status', status);
    }

    // Apply pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + limit - 1).order('scheduled_date', { ascending: false });

    const { data: sessions, error, count } = await query;

    if (error) {
      console.error('Get client sessions error:', error);
      return res.status(500).json(
        errorResponse('Failed to fetch client sessions')
      );
    }

    // Debug: Log session times being returned to frontend
    if (sessions && sessions.length > 0) {
      console.log('🔍 Sessions being returned to dashboard:');
      sessions.forEach((session, index) => {
        console.log(`   Session ${index + 1}:`);
        console.log(`   - Date: ${session.scheduled_date}`);
        console.log(`   - Time: ${session.scheduled_time}`);
        console.log(`   - Status: ${session.status}`);
      });
    }

    res.json(
      successResponse({
        sessions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || sessions.length
        }
      })
    );

  } catch (error) {
    console.error('Get client sessions error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching client sessions')
    );
  }
};

// Get sessions for a specific psychologist
const getPsychologistSessions = async (req, res) => {
  try {
    const { psychologistId } = req.params;
    const { page = 1, limit = 10, status } = req.query;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let query = supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          child_age,
          phone_number
        )
      `)
      .eq('psychologist_id', psychologistId);

    if (status) {
      query = query.eq('status', status);
    }

    // Apply pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + limit - 1).order('scheduled_date', { ascending: false });

    const { data: sessions, error, count } = await query;

    if (error) {
      console.error('Get psychologist sessions error:', error);
      return res.status(500).json(
        errorResponse('Failed to fetch psychologist sessions')
      );
    }

    res.json(
      successResponse({
        sessions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || sessions.length
        }
      })
    );

  } catch (error) {
    console.error('Get psychologist sessions error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching psychologist sessions')
    );
  }
};

// Get session by ID (admin only). Tries sessions table first, then assessment_sessions.
const getSessionById = async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
      return res.status(403).json(
        errorResponse('Access denied. Admin or Superadmin role required.')
      );
    }

    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json(errorResponse('Session ID is required'));
    }

    const { data: session, error } = await supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          child_age,
          phone_number,
          user:users(
            email
          )
        ),
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          area_of_expertise,
          description,
          email
        )
      `)
      .eq('id', sessionId)
      .neq('session_type', 'free_assessment')
      .maybeSingle();

    if (error) {
      console.error('Get session error:', error);
      return res.status(500).json(errorResponse('Failed to fetch session'));
    }

    if (!session) {
      // Not in sessions table — try assessment_sessions
      const { data: assessSession, error: assessError } = await supabaseAdmin
        .from('assessment_sessions')
        .select(`
          *,
          client:clients(
            id,
            first_name,
            last_name,
            child_name,
            child_age,
            phone_number,
            user:users(
              email
            )
          ),
          psychologist:psychologists(
            id,
            first_name,
            last_name,
            area_of_expertise,
            email
          )
        `)
        .eq('id', sessionId)
        .maybeSingle();

      if (assessError || !assessSession) {
        return res.status(404).json(errorResponse('Session not found'));
      }

      const normalized = {
        ...assessSession,
        session_type: 'assessment',
        type: 'assessment',
        booking_created_at: assessSession.created_at || null,
      };
      return res.json(successResponse({ session: normalized }));
    }

    // Debug: Log session data
    console.log('📋 GetSessionById - Session data:', {
      sessionId: session.id,
      package_id: session.package_id,
      hasPackage: !!session.package,
      package: session.package
    });

    // If session has a package_id, calculate package progress
    if (session.package_id) {
      try {
        // If package object doesn't exist, fetch it
        if (!session.package) {
          console.log('⚠️ Package object missing, fetching from packages table...');
          const { data: packageData, error: packageError } = await supabaseAdmin
            .from('packages')
            .select('id, package_type, price, description, session_count')
            .eq('id', session.package_id)
            .single();
          
          if (!packageError && packageData) {
            session.package = packageData;
            console.log('✅ Fetched package data:', packageData);
          } else {
            console.error('❌ Error fetching package:', packageError);
          }
        } else {
          console.log('✅ Package object exists in response:', session.package);
        }
        
        // Count completed sessions for this package
        const { data: packageSessions, error: sessionsError } = await supabaseAdmin
          .from('sessions')
          .select('id, status')
          .eq('package_id', session.package_id)
          .eq('client_id', session.client_id);
        
        if (!sessionsError && packageSessions && session.package) {
          const totalSessions = session.package.session_count || 0;
          const completedSessions = packageSessions.filter(
            s => s.status === 'completed'
          ).length;
          
          // Ensure we have a valid totalSessions (should be > 0 for a valid package)
          if (totalSessions > 0) {
            session.package.completed_sessions = completedSessions;
            session.package.total_sessions = totalSessions;
            session.package.remaining_sessions = Math.max(totalSessions - completedSessions, 0);
            
            console.log('✅ Package progress calculated:', {
              package_id: session.package_id,
              total_sessions: totalSessions,
              completed_sessions: completedSessions,
              remaining_sessions: session.package.remaining_sessions
            });
          } else {
            console.warn('⚠️ Package session_count is 0 or missing:', {
              package_id: session.package_id,
              session_count: session.package.session_count,
              package: session.package
            });
          }
        } else {
          console.warn('⚠️ Could not calculate package progress:', {
            sessionsError: sessionsError,
            hasPackageSessions: !!packageSessions,
            hasPackage: !!session.package,
            package_id: session.package_id
          });
        }
      } catch (packageErr) {
        console.log('Error calculating package progress:', packageErr);
        // Continue without package progress - not critical
      }
    }

    // Debug: Log what we're returning
    console.log('📤 Returning session response:', {
      sessionId: session.id,
      package_id: session.package_id,
      hasPackage: !!session.package,
      package: session.package ? {
        id: session.package.id,
        session_count: session.package.session_count,
        total_sessions: session.package.total_sessions,
        completed_sessions: session.package.completed_sessions
      } : null
    });

    session.booking_created_at = getSessionBookingCreatedAtIso(session);

    res.json(
      successResponse({ session })
    );

  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching session')
    );
  }
};

// Update session status (admin only)
const updateSessionStatus = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json(
        errorResponse('Status is required')
      );
    }

    // Check if session exists
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    const updateData = { status };
    if (notes) {
      updateData.session_notes = notes;
    }

    const { data: updatedSession, error } = await supabaseAdmin
      .from('sessions')
      .update({
        ...updateData,
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          phone_number,
          email
        ),
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          phone,
          email
        )
      `)
      .single();

    if (error) {
      console.error('Update session status error:', error);
      return res.status(500).json(
        errorResponse('Failed to update session status')
      );
    }

    // No WhatsApp, email, or in-app notification for no-show (per product requirement)

    res.json(
      successResponse(updatedSession, 'Session status updated successfully')
    );

  } catch (error) {
    console.error('Update session status error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating session status')
    );
  }
};

// Reschedule session
const rescheduleSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { new_date, new_time } = req.body;

    if (!new_date || !new_time) {
      return res.status(400).json(
        errorResponse('New date and time are required')
      );
    }

    // Check if session exists
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // Check if new date is in the future
    const sessionDate = new Date(new_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (sessionDate <= today) {
      return res.status(400).json(
        errorResponse('New session date must be in the future')
      );
    }

    // Check if new time slot is available
    const { data: availability } = await supabaseAdmin
      .from('availability')
      .select('time_slots')
      .eq('psychologist_id', session.psychologist_id)
      .eq('date', new_date)
      .eq('is_available', true)
      .single();

    if (!availability || !availability.time_slots.includes(new_time)) {
      return res.status(400).json(
        errorResponse('Selected time slot is not available')
      );
    }

    // Check if new time slot is already booked
    const { data: existingSession } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('psychologist_id', session.psychologist_id)
      .eq('scheduled_date', new_date)
      .eq('scheduled_time', new_time)
      .in('status', ['booked', 'rescheduled'])
      .neq('id', sessionId)
      .single();

    if (existingSession) {
      return res.status(400).json(
        errorResponse('This time slot is already booked')
      );
    }

    // COMMENTED OUT: Google Calendar sync (Update Google Calendar event if it exists)
    /* 
    if (session.google_calendar_event_id) {
      try {
        const { data: clientDetails } = await supabaseAdmin
          .from('clients')
          .select('first_name, last_name, child_name')
          .eq('id', session.client_id)
          .single();

        const { data: psychologistDetails } = await supabaseAdmin
          .from('psychologists')
          .select('first_name, last_name')
          .eq('id', session.psychologist_id)
          .single();

        if (clientDetails && psychologistDetails) {
          await googleCalendarService.updateSessionEvent(session.google_calendar_event_id, {
            clientName: clientDetails.child_name || `${clientDetails.first_name} ${clientDetails.last_name}`,
            psychologistName: `${psychologistDetails.first_name} ${psychologistDetails.last_name}`,
            scheduledDate: new_date,
            scheduledTime: new_time,
            duration: 50
          });
        }
    */
    
    let sessionRescheduleNotifyMinutes = session.session_type === 'free_assessment' ? 20 : 50;
    if (session.session_type !== 'free_assessment' && session.package_id) {
      const { data: sessionReschedulePkg } = await supabaseAdmin
        .from('packages')
        .select('package_type')
        .eq('id', session.package_id)
        .maybeSingle();
      sessionRescheduleNotifyMinutes = getMeetEventDurationMinutes(sessionReschedulePkg?.package_type);
    }

    // Get client and psychologist details for email and WhatsApp notifications
    if (true) { // Always fetch for email notifications
      try {
        const { data: clientDetails } = await supabaseAdmin
          .from('clients')
          .select(`
            first_name, 
            last_name, 
            child_name, 
            phone_number,
            user:users(email)
          `)
          .eq('id', session.client_id)
          .single();

        const { data: psychologistDetails } = await supabaseAdmin
          .from('psychologists')
          .select('first_name, last_name, email')
          .eq('id', session.psychologist_id)
          .single();

        // Send reschedule notification emails
        try {
          await emailService.sendRescheduleNotification({
            clientName: clientDetails.child_name || `${clientDetails.first_name} ${clientDetails.last_name}`,
            psychologistName: `${psychologistDetails.first_name} ${psychologistDetails.last_name}`,
            clientEmail: clientDetails.user?.email,
            psychologistEmail: psychologistDetails.email,
            scheduledDate: new_date,
            scheduledTime: new_time,
            sessionId: session.id,
            isFreeAssessment: session.session_type === 'free_assessment',
            durationMinutes: sessionRescheduleNotifyMinutes
          }, session.scheduled_date, session.scheduled_time);
          console.log('Reschedule notification emails sent successfully');
        } catch (emailError) {
          console.error('Error sending reschedule notification emails:', emailError);
          // Continue even if email sending fails
        }

        // Send WhatsApp notification to client
        try {
          const { sendRescheduleConfirmation } = require('../utils/whatsappService');
          const clientPhone = clientDetails.phone_number || null;
          if (clientPhone) {
            const meetLink = session.google_meet_link || session.google_meet_join_url || null;
            const clientResult = await sendRescheduleConfirmation(clientPhone, {
              oldDate: session.scheduled_date,
              oldTime: session.scheduled_time,
              newDate: new_date,
              newTime: new_time,
              newMeetLink: meetLink,
              isFreeAssessment: session.session_type === 'free_assessment',
              durationMinutes: sessionRescheduleNotifyMinutes
            });
            if (clientResult?.success) {
              console.log('✅ Reschedule WhatsApp sent to client');
            } else {
              console.warn('⚠️ Failed to send reschedule WhatsApp to client');
            }
          }
        } catch (waError) {
          console.error('Error sending reschedule WhatsApp:', waError);
          // Continue even if WhatsApp fails
        }
      } catch (googleError) {
        console.error('Error updating Google Calendar event:', googleError);
        // Continue with session update even if Google Calendar fails
      }
    }

    // Update session (reset reminder_sent since it's rescheduled)
    const { data: updatedSession, error } = await supabaseAdmin
      .from('sessions')
      .update({
        scheduled_date: formatDate(new_date),
        scheduled_time: formatTime(new_time),
        status: 'rescheduled',
        reminder_sent: false, // Reset reminder flag when rescheduled
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .select('*')
      .single();

    if (error) {
      console.error('Reschedule session error:', error);
      return res.status(500).json(
        errorResponse('Failed to reschedule session')
      );
    }

    res.json(
      successResponse(updatedSession, 'Session rescheduled successfully')
    );

  } catch (error) {
    console.error('Reschedule session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while rescheduling session')
    );
  }
};

// Get session statistics
const getSessionStats = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let query = supabaseAdmin
      .from('sessions')
      .select('status, scheduled_date, price');

    if (start_date && end_date) {
      query = query.gte('scheduled_date', start_date).lte('scheduled_date', end_date);
    }

    const { data: sessions, error } = await query;

    if (error) {
      console.error('Get session stats error:', error);
      return res.status(500).json(
        errorResponse('Failed to fetch session statistics')
      );
    }

    // Calculate statistics
    const stats = {
      total_sessions: sessions.length,
      total_revenue: sessions.reduce((sum, session) => sum + parseFloat(session.price || 0), 0),
      status_breakdown: {},
      daily_sessions: {}
    };

    sessions.forEach(session => {
      // Status breakdown
      stats.status_breakdown[session.status] = (stats.status_breakdown[session.status] || 0) + 1;
      
      // Daily sessions
      const date = session.scheduled_date;
      stats.daily_sessions[date] = (stats.daily_sessions[date] || 0) + 1;
    });

    res.json(
      successResponse(stats)
    );

  } catch (error) {
    console.error('Get session stats error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching session statistics')
    );
  }
};

// Search sessions
const searchSessions = async (req, res) => {
  try {
    const { 
      query: searchQuery, 
      page = 1, 
      limit = 10,
      status,
      psychologist_id,
      client_id,
      start_date,
      end_date
    } = req.query;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let supabaseQuery = supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name
        ),
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          email
        ),
        package:packages(
          id,
          package_type,
          price
        )
      `);

    // Apply filters
    if (status) {
      supabaseQuery = supabaseQuery.eq('status', status);
    }
    if (psychologist_id) {
      supabaseQuery = supabaseQuery.eq('psychologist_id', psychologist_id);
    }
    if (client_id) {
      supabaseQuery = supabaseQuery.eq('client_id', client_id);
    }
    if (start_date) {
      supabaseQuery = supabaseQuery.gte('scheduled_date', start_date);
    }
    if (end_date) {
      supabaseQuery = supabaseQuery.lte('scheduled_date', end_date);
    }

    // Add pagination
    const offset = (page - 1) * limit;
    supabaseQuery = supabaseQuery.range(offset, offset + limit - 1);

    const { data: sessions, error, count } = await supabaseQuery;

    if (error) {
      console.error('Search sessions error:', error);
      return res.status(500).json(
        errorResponse('Failed to search sessions')
      );
    }

    // Filter by search query if provided
    let filteredSessions = sessions;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filteredSessions = sessions.filter(session => 
        session.client?.first_name?.toLowerCase().includes(query) ||
        session.client?.last_name?.toLowerCase().includes(query) ||
        session.client?.child_name?.toLowerCase().includes(query) ||
        session.psychologist?.first_name?.toLowerCase().includes(query) ||
        session.psychologist?.last_name?.toLowerCase().includes(query) ||
        session.package?.package_type?.toLowerCase().includes(query)
      );
    }

    res.json(
      successResponse({
        sessions: filteredSessions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || filteredSessions.length
        }
      })
    );

  } catch (error) {
    console.error('Search sessions error:', error);
    res.status(500).json(
      errorResponse('Internal server error while searching sessions')
    );
  }
};

// Create session (admin only)
const createSession = async (req, res) => {
  try {
    const { client_id, psychologist_id, package_id, scheduled_date, scheduled_time, notes } = req.body;

    // Validate required fields
    if (!client_id || !psychologist_id || !package_id || !scheduled_date || !scheduled_time) {
      return res.status(400).json(
        errorResponse('Missing required fields: client_id, psychologist_id, package_id, scheduled_date, scheduled_time')
      );
    }

    // Check if client exists
    const { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('id', client_id)
      .single();

    if (clientError || !client) {
      return res.status(404).json(
        errorResponse('Client not found')
      );
    }

    // Check if psychologist exists
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id')
      .eq('id', psychologist_id)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    // Check if package exists
    const { data: package, error: packageError } = await supabaseAdmin
      .from('packages')
      .select('id, price, session_count, package_type')
      .eq('id', package_id)
      .single();

    if (packageError || !package) {
      return res.status(404).json(
        errorResponse('Package not found')
      );
    }

    const quotaCheck = await assertClientPackageHasAvailableSlot(
      supabaseAdmin,
      client_id,
      package
    );
    if (!quotaCheck.ok) {
      return res.status(quotaCheck.httpStatus || 400).json(
        errorResponse(quotaCheck.message)
      );
    }

    // Create session
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([{
        client_id,
        psychologist_id,
        package_id,
        scheduled_date,
        scheduled_time,
        status: 'booked',
        notes: notes || '',
        amount: package.price
      }])
      .select('*')
      .single();

    if (sessionError) {
      console.error('Create session error:', sessionError);
      return res.status(500).json(
        errorResponse('Failed to create session')
      );
    }

    res.status(201).json(
      successResponse(session, 'Session created successfully')
    );

  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating session')
    );
  }
};

// Delete session (admin only)
const deleteSession = async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Check if session exists
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, status')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // Allow deletion of all sessions including completed ones (admin can delete any session)
    // COMMENTED OUT: Google Calendar sync (Delete from Google Calendar if event exists)
    /*
    if (session.google_calendar_event_id) {
      try {
        await googleCalendarService.deleteSessionEvent(session.google_calendar_event_id);
      } catch (googleError) {
        console.error('Error deleting Google Calendar event:', googleError);
        // Continue with session deletion even if Google Calendar fails
      }
    }
    */
    console.log('ℹ️  Google Calendar sync disabled - skipping calendar event deletion');

    // Clear client_packages.first_session_id if this session is referenced (avoids FK violation on delete)
    const { data: refs } = await supabaseAdmin
      .from('client_packages')
      .select('id, client_id, package_id')
      .eq('first_session_id', sessionId);

    if (refs && refs.length > 0) {
      for (const cp of refs) {
        // Try setting to another session in the same package (if any), else null
        const { data: otherSession } = await supabaseAdmin
          .from('sessions')
          .select('id')
          .eq('client_id', cp.client_id)
          .eq('package_id', cp.package_id)
          .neq('id', sessionId)
          .limit(1)
          .maybeSingle();

        const { error: unlinkError } = await supabaseAdmin
          .from('client_packages')
          .update({ first_session_id: otherSession?.id ?? null })
          .eq('id', cp.id);

        if (unlinkError) {
          console.warn('Unlink client_packages first_session_id:', unlinkError?.message);
        }
      }
    }

    // Delete session
    const { error: deleteError } = await supabaseAdmin
      .from('sessions')
      .delete()
      .eq('id', sessionId);

    if (deleteError) {
      console.error('Delete session error:', deleteError);
      if (deleteError.code === '23503') {
        return res.status(400).json(
          errorResponse('Cannot delete session: it is still linked to a package. Unlink it first or try again.')
        );
      }
      return res.status(500).json(
        errorResponse('Failed to delete session')
      );
    }

    res.json(
      successResponse(null, 'Session deleted successfully')
    );

  } catch (error) {
    console.error('Delete session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting session')
    );
  }
};

// Approve or reject reschedule request (psychologist only)
const handleRescheduleRequest = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const { action, reason } = req.body; // action: 'approve' or 'reject'
    const psychologistId = req.user.id;

    console.log('🔄 Handling reschedule request');
    console.log('   - Notification ID:', notificationId);
    console.log('   - Action:', action);
    console.log('   - Psychologist ID:', psychologistId);

    // Validate action
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json(
        errorResponse('Invalid action. Must be "approve" or "reject"')
      );
    }

    // Get the notification and verify it belongs to this psychologist
    // Note: notifications table uses user_id, not psychologist_id
    const { data: notification, error: notificationError } = await supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('id', notificationId)
      .eq('user_id', psychologistId) // Use user_id instead of psychologist_id
      .eq('type', 'warning') // Changed from 'reschedule_request' to 'warning' per schema
      .single();

    if (notificationError || !notification) {
      return res.status(404).json(
        errorResponse('Reschedule request not found or access denied')
      );
    }

    // IMPORTANT: Check if this is a within-24-hours request that requires admin approval
    // Psychologists cannot approve within-24-hours requests - only admin can
    if (notification.type === 'warning' && 
        notification.message?.includes('admin approval') &&
        notification.message?.includes('within 24 hours')) {
      return res.status(403).json(
        errorResponse('This reschedule request requires admin approval. Only administrators can approve requests within 24 hours. Please contact admin for approval.')
      );
    }

    // Parse session_id and date/time from notification message or related_id
    // Message format: "ClientName has requested to reschedule their session from YYYY-MM-DD at HH:MM to YYYY-MM-DD at HH:MM..."
    const sessionId = notification.related_id;
    if (!sessionId) {
      return res.status(400).json(
        errorResponse('Session ID not found in notification')
      );
    }

    // Parse new date/time from message
    const message = notification.message || '';
    const newDateMatch = message.match(/to (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})/);
    const originalDateMatch = message.match(/from (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})/);
    
    if (!newDateMatch || !originalDateMatch) {
      return res.status(400).json(
        errorResponse('Could not parse reschedule date/time from notification message')
      );
    }

    const newDate = newDateMatch[1];
    const newTime = newDateMatch[2] + ':00'; // Add seconds
    const originalDate = originalDateMatch[1];
    const originalTime = originalDateMatch[2] + ':00';

    // Get the session details
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('psychologist_id', psychologistId) // Verify session belongs to psychologist
      .single();

    if (sessionError || !session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    if (action === 'approve') {
      // Check if new time slot is still available
      const { data: conflictingSessions } = await supabaseAdmin
        .from('sessions')
        .select('id')
        .eq('psychologist_id', psychologistId)
        .eq('scheduled_date', newDate)
        .eq('scheduled_time', newTime)
        .in('status', ['booked', 'rescheduled', 'confirmed'])
        .neq('id', session.id);

      if (conflictingSessions && conflictingSessions.length > 0) {
        return res.status(400).json(
          errorResponse('Selected time slot is no longer available')
        );
      }

      // Update session with new date/time
      const { formatDate, formatTime } = require('../utils/helpers');
      const { data: updatedSession, error: updateError } = await supabaseAdmin
        .from('sessions')
        .update({
          scheduled_date: formatDate(newDate),
          scheduled_time: formatTime(newTime),
          status: 'rescheduled',
          reschedule_count: (session.reschedule_count || 0) + 1,
          reminder_sent: false, // Reset reminder flag when rescheduled
          updated_at: new Date().toISOString()
        })
        .eq('id', session.id)
        .select('*')
        .single();

      if (updateError) {
        console.error('Error updating session:', updateError);
        return res.status(500).json(
          errorResponse('Failed to reschedule session')
        );
      }

      // Update receipt with new session date and time
      try {
        const { data: receipt, error: receiptError } = await supabaseAdmin
          .from('receipts')
          .select('id, receipt_details')
          .eq('session_id', session.id)
          .maybeSingle();

        if (!receiptError && receipt) {
          // Update receipt_details JSON with new session date and time
          const updatedReceiptDetails = {
            ...receipt.receipt_details,
            session_date: formatDate(newDate),
            session_time: formatTime(newTime)
          };

          await supabaseAdmin
            .from('receipts')
            .update({
              receipt_details: updatedReceiptDetails,
              updated_at: new Date().toISOString()
            })
            .eq('id', receipt.id);

          console.log('✅ Receipt updated with new session date and time');
        } else if (receiptError && receiptError.code !== 'PGRST116') {
          console.error('Error fetching receipt:', receiptError);
        }
      } catch (receiptUpdateError) {
        console.error('Error updating receipt:', receiptUpdateError);
        // Continue even if receipt update fails
      }

      // Get client user_id for notification
      const { data: client } = await supabaseAdmin
        .from('clients')
        .select('user_id')
        .eq('id', session.client_id)
        .single();

      // Create approval notification for client
      if (client?.user_id) {
      const clientNotificationData = {
          user_id: client.user_id,
        title: 'Reschedule Approved',
          message: `Your reschedule request has been approved. Session moved to ${newDate} at ${newTime}`,
          type: 'success',
          related_id: session.id,
          related_type: 'session',
        is_read: false,
        created_at: new Date().toISOString()
      };

      await supabaseAdmin
        .from('notifications')
        .insert([clientNotificationData]);
      }

      // Mark original request as read and set status to approved
      await supabaseAdmin
        .from('notifications')
        .update({ is_read: true, status: 'approved', is_approved: true })
        .eq('id', notificationId);

      console.log('✅ Reschedule request approved');
      res.json(
        successResponse(updatedSession, 'Reschedule request approved successfully')
      );

    } else {
      // Reject the request
      // Get client user_id for notification
      const { data: client } = await supabaseAdmin
        .from('clients')
        .select('user_id')
        .eq('id', session.client_id)
        .single();

      if (client?.user_id) {
        const rejectionMessage = reason 
          ? `Your reschedule request has been declined. Reason: ${reason}. Your session remains scheduled for ${session.scheduled_date} at ${session.scheduled_time}. For further communication, please contact our operations team via WhatsApp or call.`
          : `Your reschedule request has been declined. Your session remains scheduled for ${session.scheduled_date} at ${session.scheduled_time}. For further communication, please contact our operations team via WhatsApp or call.`;

      const clientNotificationData = {
          user_id: client.user_id,
          title: 'Reschedule Request Declined',
          message: rejectionMessage,
          type: 'error',
          related_id: session.id,
          related_type: 'session',
        is_read: false,
        created_at: new Date().toISOString()
      };

      await supabaseAdmin
        .from('notifications')
        .insert([clientNotificationData]);
      }

      // Mark original request as read and set status to rejected
      await supabaseAdmin
        .from('notifications')
        .update({ is_read: true, status: 'rejected', is_approved: false })
        .eq('id', notificationId);

      console.log('❌ Reschedule request rejected');
      res.json(
        successResponse(null, 'Reschedule request rejected successfully')
      );
    }

  } catch (error) {
    console.error('Handle reschedule request error:', error);
    res.status(500).json(
      errorResponse('Internal server error while handling reschedule request')
    );
  }
};

// Complete session with summary, report, and notes (psychologist or admin for free assessments)
const completeSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { summary, report, summary_notes, completion_date } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;
    const isAdmin = ['admin', 'superadmin'].includes(userRole);

    // Check if session exists
    let sessionQuery = supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          child_age,
          user_id,
          phone_number,
          user:users(email)
        )
      `)
      .eq('id', sessionId);

    // For psychologists, check if session belongs to them
    // For admins, allow completing any session (especially free assessments)
    if (!isAdmin) {
      sessionQuery = sessionQuery.eq('psychologist_id', userId);
    }

    const { data: session, error: sessionError } = await sessionQuery.single();

    if (sessionError || !session) {
      return res.status(404).json(
        errorResponse('Session not found or you do not have permission to complete this session')
      );
    }

    const isFreeAssessment = session.session_type === 'free_assessment';

    // Validate required fields: for admin, summary / report / summary_notes are all optional
    if (!isAdmin) {
      if (!summary || !summary_notes) {
        return res.status(400).json(
          errorResponse('Summary and summary notes are required')
        );
      }
      if (!isFreeAssessment && !report) {
        return res.status(400).json(
          errorResponse('Report is required for regular sessions')
        );
      }
    }

    // Check if session is already completed
    if (session.status === 'completed') {
      return res.status(400).json(
        errorResponse('Session is already completed')
      );
    }

    // Prepare update data (admin may leave summary/report/summary_notes empty)
    const updateData = {
      status: 'completed',
      summary: (summary && summary.trim()) || '',
      summary_notes: (summary_notes && summary_notes.trim()) || '',
      updated_at: new Date().toISOString()
    };

    // Add completion_date if provided (for finance dashboard filtering)
    // If not provided, use scheduled_date as default
    if (completion_date) {
      updateData.completion_date = completion_date;
    } else {
      // Default to scheduled_date if completion_date not provided
      updateData.completion_date = session.scheduled_date || session.original_scheduled_date;
    }

    // Report: for non-free-assessment, set to trimmed value or empty (optional for admin)
    if (!isFreeAssessment) {
      updateData.report = (report && report.trim()) || '';
    }

    // Update session with completion data
    const { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('sessions')
      .update(updateData)
      .eq('id', sessionId)
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          child_age,
          user_id,
          user:users(email)
        )
      `)
      .single();

    if (updateError) {
      console.error('Error updating session:', updateError);
      return res.status(500).json(
        errorResponse('Failed to complete session')
      );
    }

    // If this is a free assessment, also update the free_assessments table status
    if (isFreeAssessment) {
      try {
        const { error: assessmentUpdateError } = await supabaseAdmin
          .from('free_assessments')
          .update({ status: 'completed' })
          .eq('session_id', sessionId);

        if (assessmentUpdateError) {
          console.warn('⚠️ Failed to update free_assessments status:', assessmentUpdateError);
          // Don't fail the request if this update fails
        } else {
          console.log('✅ Free assessment status updated to completed');
        }
      } catch (assessmentError) {
        console.warn('⚠️ Error updating free_assessments status:', assessmentError);
        // Don't fail the request if this update fails
      }
    }

    // Calculate commission (if payment is completed)
    try {
      if (updatedSession.payment_status === 'paid') {
        const commissionService = require('../services/commissionCalculationService');
        await commissionService.calculateAndRecordCommission(sessionId, updatedSession);
      }
    } catch (commissionError) {
      console.error('Error calculating commission:', commissionError);
      // Don't fail the request if commission calculation fails
    }

    // Normalize client (Supabase PostgREST can return FK relation as object or array)
    const client = Array.isArray(session.client) ? session.client[0] : session.client;

    console.log(`📋 Session ${sessionId} updated successfully, proceeding to send notifications...`);
    console.log(`📋 Session client data available:`, {
      hasClient: !!client,
      clientId: client?.id,
      userId: client?.user_id,
      hasPhoneNumber: !!(client?.phone_number)
    });

    // Send completion notification to client
    console.log(`🔔 Starting completion notification process for session ${sessionId}...`);
    try {
      if (client?.user_id) {
        const clientNotificationData = {
          user_id: client.user_id,
          title: 'Session Completed',
          message: `Your session with ${req.user.first_name || 'your psychologist'} has been completed. You can now view the summary and report.`,
          type: 'success',
          related_id: sessionId,
          related_type: 'session'
        };

        console.log(`📬 Creating in-app notification for user ${client.user_id}...`);
        await supabaseAdmin
          .from('notifications')
          .insert([clientNotificationData]);
        console.log(`✅ In-app notification created successfully`);
      }

      // Send WhatsApp notification to client (NO EMAIL for session completion)
      // This applies to ALL sessions including package sessions
      try {
        const { sendSessionCompletionNotification } = require('../utils/whatsappService');
        const clientPhone = client?.phone_number || null;
        
        console.log(`📱 WhatsApp sending attempt for session ${sessionId} (package: ${session.package_id || 'none'})`);
        console.log(`📱 Client data:`, {
          hasClient: !!client,
          clientId: client?.id,
          phoneNumber: clientPhone ? `${String(clientPhone).substring(0, 3)}***` : 'NOT FOUND',
          sessionType: session.session_type,
          isPackage: !!session.package_id
        });
        
        if (clientPhone) {
          // For free assessments, use "our specialist", otherwise use psychologist name
          const psychologistName = isFreeAssessment 
            ? 'our specialist'
            : `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'our specialist';
          // Always use production URL in WhatsApp/email links (never localhost)
          const PRODUCTION_SITE_URL =
            process.env.SITE_URL || process.env.PUBLIC_APP_URL || 'https://www.koott.in';
          const bookingLink = `${PRODUCTION_SITE_URL}/psychologists`;
          const feedbackLink = isFreeAssessment 
            ? `${PRODUCTION_SITE_URL}/profile/sessions?tab=completed`
            : `${PRODUCTION_SITE_URL}/profile/reports`;

          const sessionTypeLabel = session.package_id ? 'package session' : (isFreeAssessment ? 'free assessment' : 'therapy session');
          console.log(`📱 Attempting to send WhatsApp completion for ${sessionTypeLabel} (Session ID: ${sessionId}) to client: ${clientPhone.substring(0, 3)}***`);
          
          // Fetch package information if this is a package session
          let packageInfo = null;
          if (session.package_id) {
            try {
              // Get package data
              const { data: packageData, error: packageError } = await supabaseAdmin
                .from('packages')
                .select('session_count')
                .eq('id', session.package_id)
                .single();
              
              if (!packageError && packageData) {
                // Get all sessions for this package and count completed ones
                const { data: packageSessions, error: sessionsError } = await supabaseAdmin
                  .from('sessions')
                  .select('id, status')
                  .eq('package_id', session.package_id);
                
                if (!sessionsError && packageSessions) {
                  const totalSessions = packageData.session_count || 0;
                  // Count completed sessions (including the one just completed)
                  const completedSessions = packageSessions.filter(s => s.status === 'completed').length;
                  
                  packageInfo = {
                    totalSessions: totalSessions,
                    completedSessions: completedSessions
                  };
                  
                  console.log(`📦 Package info for session ${sessionId}: ${completedSessions}/${totalSessions} completed`);
                }
              }
            } catch (packageInfoError) {
              console.warn(`⚠️ Error fetching package info for session ${sessionId}:`, packageInfoError);
              // Continue without package info - will use regular template
            }
          }
          
          const clientResult = await sendSessionCompletionNotification(clientPhone, {
            psychologistName: psychologistName,
            bookingLink: bookingLink,
            feedbackLink: feedbackLink,
            packageInfo: packageInfo
          });
          if (clientResult?.success) {
            console.log(`✅ Session completion WhatsApp sent to client for ${sessionTypeLabel} (Session ID: ${sessionId})`);
          } else {
            console.warn(`⚠️ Failed to send session completion WhatsApp to client for ${sessionTypeLabel} (Session ID: ${sessionId}). Error: ${clientResult?.error || 'Unknown error'}`);
          }
        } else {
          console.warn(`⚠️ Skipping WhatsApp completion for session ${sessionId} (${session.package_id ? 'package session' : 'regular session'}): Client phone number not found.`);
          console.warn(`⚠️ Session client data:`, client ? { id: client.id, hasPhone: !!client.phone_number } : 'No client data');
        }
      } catch (waError) {
        console.error(`❌ Error sending session completion WhatsApp for session ${sessionId}${session.package_id ? ' (package session)' : ''}:`, waError);
        console.error(`❌ Error stack:`, waError.stack);
        // Don't fail the request if WhatsApp fails
      }
    } catch (notificationError) {
      console.error('Error sending completion notification:', notificationError);
      // Don't fail the request if notification fails
    }

    const completedBy = isAdmin ? 'admin' : 'psychologist';
    console.log(`✅ Session ${sessionId} completed by ${completedBy} ${userId}${isFreeAssessment ? ' (free assessment)' : ''}`);
    
    res.json(
      successResponse(updatedSession, 'Session completed successfully')
    );

  } catch (error) {
    console.error('Error completing session:', error);
    res.status(500).json(
      errorResponse('Internal server error while completing session')
    );
  }
};

// Mark session as no-show (psychologist or admin only — never automatic).
// When session time passes, the session remains booked/pending until psychologist or admin
// explicitly marks it as no-show or completed.
const markSessionAsNoShow = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { reason } = req.body; // Optional reason for no-show
    const userId = req.user.id;
    const userRole = req.user.role;

    // Check if session exists
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          child_age,
          user_id,
          phone_number,
          user:users(email)
        ),
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          phone
        )
      `)
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // Check permissions
    if (userRole === 'psychologist') {
      // Psychologist can only mark their own sessions
      if (session.psychologist_id !== userId) {
        return res.status(403).json(
          errorResponse('You do not have permission to mark this session as no-show')
        );
      }
    } else if (userRole !== 'admin') {
      return res.status(403).json(
        errorResponse('Only psychologists and admins can mark sessions as no-show')
      );
    }

    // Check if session is already completed or no-show
    if (session.status === 'completed') {
      return res.status(400).json(
        errorResponse('Cannot mark a completed session as no-show')
      );
    }
    if (session.status === 'no_show' || session.status === 'noshow') {
      return res.status(400).json(
        errorResponse('Session is already marked as no-show')
      );
    }

    // Update session status
    const { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({
        status: 'no_show',
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          child_age,
          user_id,
          phone_number,
          user:users(email)
        ),
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          phone
        )
      `)
      .single();

    if (updateError) {
      console.error('Error updating session:', updateError);
      return res.status(500).json(
        errorResponse('Failed to mark session as no-show')
      );
    }

    // No WhatsApp, email, or in-app notification for no-show (per product requirement)

    console.log(`✅ Session ${sessionId} marked as no-show by ${userRole} ${userId}`);
    
    res.json(
      successResponse(updatedSession, 'Session marked as no-show successfully')
    );

  } catch (error) {
    console.error('Error marking session as no-show:', error);
    res.status(500).json(
      errorResponse('Internal server error while marking session as no-show')
    );
  }
};

// Get reschedule requests for psychologist's sessions
const getRescheduleRequests = async (req, res) => {
  try {
    // For psychologists, req.user.id IS the psychologist_id (from psychologists table)
    // This is set by the auth middleware - no need to look it up
    const psychologistId = req.user.id;
    const { status } = req.query; // 'pending', 'approved', or undefined for all

    // Get all reschedule request notifications
    // These are notifications where related_type='session' and message/title contains 'reschedule'
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let query = supabaseAdmin
      .from('notifications')
      .select('*')
      .or('type.eq.warning,type.eq.info')
      .eq('related_type', 'session')
      .order('created_at', { ascending: false });

    const { data: allNotifications, error: fetchError } = await query;

    if (fetchError) {
      console.error('Get reschedule requests error:', fetchError);
      return res.status(500).json(
        errorResponse('Failed to fetch reschedule requests')
      );
    }

    // Filter for reschedule-related notifications
    let rescheduleNotifications = (allNotifications || []).filter(notif => 
      (notif.message?.toLowerCase().includes('reschedule') || 
       notif.title?.toLowerCase().includes('reschedule'))
    );

    // Get sessions for these notifications and filter by psychologist_id
    const enrichedRequests = [];
    
    for (const notification of rescheduleNotifications) {
      const sessionId = notification.related_id;
      
      // Get session details
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('*, client:clients(*), psychologist:psychologists(*)')
        .eq('id', sessionId)
        .eq('psychologist_id', psychologistId) // Only sessions for this psychologist
        .single();

      // Only include if session belongs to this psychologist
      if (session) {
        // Filter by status if provided
        if (status === 'pending' && notification.is_read) {
          continue; // Skip if status is pending but notification is read
        } else if (status === 'approved' && !notification.is_read) {
          continue; // Skip if status is approved but notification is not read
        }

        enrichedRequests.push({
          ...notification,
          session: session || null,
          client: session?.client || null,
          psychologist: session?.psychologist || null
        });
      }
    }

    res.json(successResponse(enrichedRequests || [], 'Reschedule requests fetched successfully'));

  } catch (error) {
    console.error('Get reschedule requests error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching reschedule requests')
    );
  }
};

module.exports = {
  bookSession,
  getClientSessions,
  getPsychologistSessions,
  getAllSessions,
  getSessionById,
  updateSessionStatus,
  deleteSession,
  handleRescheduleRequest,
  completeSession,
  markSessionAsNoShow,
  getRescheduleRequests
};
