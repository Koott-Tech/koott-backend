const { supabaseAdmin } = require('../config/supabase');
const { computeSessionDoctorWallet } = require('../utils/sessionCommission');
const { getClientDisplayName } = require('../utils/sessionTitleFormatter');
const { 
  successResponse, 
  errorResponse,
  formatDate,
  formatTime
} = require('../utils/helpers');
const { getSessionBookingCreatedAtIso } = require('../utils/sessionBookingCreatedAt');
const assessmentSessionService = require('../services/assessmentSessionService');
const {
  getRecurringBlocksForPsychologist,
  filterSlotsByRecurringBlocks,
  getDayName
} = require('../utils/recurringBlocksHelper');
const timeBlockingService = require('../utils/timeBlockingService');
const { syncFutureAvailabilityForRecurringBlockDay } = require('../utils/defaultAvailabilityService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Convert 12-hour time to 24-hour format for comparison
 * Handles both "5:00 PM" and "17:00" formats
 */
function convertSlotTimeTo24Hour(timeStr) {
  if (!timeStr) return null;
  
  const time = typeof timeStr === 'string' ? timeStr.trim() : String(timeStr).trim();
  
  // If already in 24-hour format (no AM/PM), extract HH:MM
  if (!time.includes('AM') && !time.includes('PM')) {
    // Extract first 5 characters (HH:MM) if longer string
    const match = time.match(/(\d{1,2}):(\d{2})/);
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = match[2];
      return `${String(hours).padStart(2, '0')}:${minutes}`;
    }
    return time.substring(0, 5);
  }
  
  // Parse 12-hour format (e.g., "5:00 PM" or "5:00PM")
  const match = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  
  let hour24 = parseInt(match[1]);
  const minutes = match[2];
  const period = match[3].toUpperCase();
  
  if (period === 'PM' && hour24 !== 12) {
    hour24 += 12;
  } else if (period === 'AM' && hour24 === 12) {
    hour24 = 0;
  }
  
  return `${String(hour24).padStart(2, '0')}:${minutes}`;
}

// Get psychologist profile
const getProfile = async (req, res) => {
  try {
    const psychologistId = req.user.id;

    // Check if psychologist profile exists in psychologists table
    try {
      const { data: psychologist, error } = await supabaseAdmin
        .from('psychologists')
        .select('*')
        .eq('id', psychologistId)
        .single();

      if (error) {
        // If psychologist profile doesn't exist, return a default profile
        if (error.code === 'PGRST116' || error.message.includes('No rows returned')) {
          console.log('Psychologist profile not found, returning default profile');
          return res.json(
            successResponse({
              id: psychologistId,
              email: req.user.email || 'pending@example.com',
              first_name: 'Pending',
              last_name: 'Profile',
              ug_college: 'Pending',
              pg_college: 'Pending',
              phd_college: null,
              area_of_expertise: [],
              description: 'Profile setup pending',
              experience_years: 0,
              cover_image_url: null,
              phone: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
          );
        }
        
        // If there's a database relationship error, return default profile
        if (error.code === 'PGRST200' || error.message.includes('relationship') || error.message.includes('schema cache')) {
          console.log('Database relationships not fully established, returning default psychologist profile');
          return res.json(
            successResponse({
              id: psychologistId,
              email: req.user.email || 'pending@example.com',
              first_name: 'Pending',
              last_name: 'Profile',
              ug_college: 'Pending',
              pg_college: 'Pending',
              phd_college: null,
              area_of_expertise: [],
              description: 'Profile setup pending',
              experience_years: 0,
              cover_image_url: null,
              phone: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
          );
        }
        
        console.error('Get psychologist profile error:', error);
        return res.status(500).json(
          errorResponse('Failed to fetch psychologist profile')
        );
      }

      res.json(
        successResponse(psychologist)
      );

    } catch (dbError) {
      // If there's any database error, return default profile
      console.log('Database error in psychologist profile query, returning default profile:', dbError.message);
      return res.json(
        successResponse({
          id: psychologistId,
          email: req.user.email || 'pending@example.com',
          first_name: 'Pending',
          last_name: 'Profile',
          ug_college: 'Pending',
          pg_college: 'Pending',
          phd_college: null,
          area_of_expertise: [],
          description: 'Profile setup pending',
          experience_years: 0,
          cover_image_url: null,
          phone: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      );
    }

  } catch (error) {
    console.error('Get psychologist profile error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching profile')
    );
  }
};

// Update psychologist profile
const updateProfile = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    
    // HIGH-RISK FIX: Mass assignment protection - explicit allowlist
    const allowedFields = [
      'first_name', 'last_name', 'phone', 'ug_college', 'pg_college', 'mphil_college', 'phd_college',
      'area_of_expertise', 'description', 'experience_years', 'profile_picture_url',
      'personality_traits', 'display_order', 'faq_question_1', 'faq_answer_1',
      'faq_question_2', 'faq_answer_2', 'faq_question_3', 'faq_answer_3'
    ];
    const updateData = {};
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });
    updateData.updated_at = new Date().toISOString();

    const { data: psychologist, error } = await supabaseAdmin
      .from('psychologists')
      .update(updateData)
      .eq('id', psychologistId)
      .select('*')
      .single();

    if (error) {
      console.error('Update psychologist profile error:', error);
      return res.status(500).json(
        errorResponse('Failed to update psychologist profile')
      );
    }

    res.json(
      successResponse(psychologist, 'Profile updated successfully')
    );

  } catch (error) {
    console.error('Update psychologist profile error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating profile')
    );
  }
};

// Get psychologist sessions
const getSessions = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { page = 1, limit = 10, status, date } = req.query;

    // Check if sessions table exists and has proper relationships
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    try {
      let query = supabaseAdmin
        .from('sessions')
        .select(`
          *,
          client:clients(
            id,
            first_name,
            last_name,
            phone_number,
            user:users(
              email
            )
          )
        `)
        .eq('psychologist_id', psychologistId);

      // Filter by status if provided
      if (status) {
        query = query.eq('status', status);
      }

      // Filter by date if provided
      if (date) {
        query = query.eq('scheduled_date', date);
      }

      // Add pagination and ordering
      const offset = (page - 1) * limit;
      query = query.range(offset, offset + limit - 1).order('scheduled_date', { ascending: false });

      const { data: sessions, error, count } = await query;

      const enrichedRegular = (sessions || []).map((s) => ({
        ...s,
        booking_created_at: getSessionBookingCreatedAtIso(s),
      }));

      // Attach package info and session index (e.g. "2/3") for package sessions
      if (enrichedRegular.length > 0) {
        const packageIds = [...new Set(enrichedRegular.map(s => s.package_id).filter(Boolean))];
        if (packageIds.length > 0) {
          const { data: packages } = await supabaseAdmin
            .from('packages')
            .select('id, package_type, session_count')
            .in('id', packageIds);
          const packagesMap = (packages || []).reduce((acc, p) => { acc[p.id] = p; return acc; }, {});

          const { data: allPackageSessions } = await supabaseAdmin
            .from('sessions')
            .select('id, client_id, package_id, scheduled_date')
            .eq('psychologist_id', psychologistId)
            .in('package_id', packageIds)
            .order('scheduled_date', { ascending: true, nullsFirst: false });

          const sessionToPackageInfo = {};
          if (allPackageSessions && allPackageSessions.length > 0) {
            const byKey = {};
            allPackageSessions.forEach(s => {
              const key = `${s.client_id}_${s.package_id}`;
              if (!byKey[key]) byKey[key] = [];
              byKey[key].push(s);
            });
            Object.values(byKey).forEach(arr => {
              const pkg = arr[0] && packagesMap[arr[0].package_id];
              const totalFromPackage = pkg?.session_count || 0;
              const totalSessions = totalFromPackage > 0 ? totalFromPackage : arr.length;
              arr.forEach((s, i) => {
                const p = packagesMap[s.package_id];
                sessionToPackageInfo[s.id] = {
                  package_type: p?.package_type || 'Package',
                  session_count: p?.session_count || totalSessions,
                  session_index: i + 1,
                  total_sessions: totalSessions
                };
              });
            });
          }
          enrichedRegular.forEach(s => {
            if (s.package_id && sessionToPackageInfo[s.id]) {
              const info = sessionToPackageInfo[s.id];
              s.package = {
                package_type: info.package_type,
                session_count: info.session_count,
                session_index: info.session_index,
                session_number: info.session_index,
                total_sessions: info.total_sessions
              };
            }
          });
        }
      }

      // Also fetch assessment sessions assigned to this psychologist OR unassigned pending sessions
      // Unassigned pending sessions (psychologist_id = null) can be scheduled by any psychologist
      let assessmentSessions = [];

      // ── Wix package session numbering ────────────────────────────────────────
      // Wix parent sessions (original booking) have package_session_number=null.
      // Admin follow-ups (book-next) get 2, 3, … so null → infer as #1.
      // Also propagate session_count across sibling sessions (same client+psychologist)
      // because admin-created follow-up rows sometimes have session_count=null.
      const wixPkgSessions = enrichedRegular.filter(
        s => s.session_type === 'package' && !s.package_id
      );
      if (wixPkgSessions.length > 0) {
        // Group by client_id + psychologist_id to find siblings
        const groups = {};
        wixPkgSessions.forEach(s => {
          const key = `${s.client_id}_${s.psychologist_id}`;
          if (!groups[key]) groups[key] = [];
          groups[key].push(s);
        });

        Object.values(groups).forEach(grp => {
          // Find the best session_count across all siblings (prefer the highest non-null value)
          const bestCount = grp.reduce((best, s) => {
            const c = parseInt(s.session_count, 10);
            return (!isNaN(c) && c > best) ? c : best;
          }, 0);

          grp.forEach(s => {
            // Propagate session_count
            if (bestCount > 0 && !(parseInt(s.session_count, 10) > 0)) {
              s.session_count = bestCount;
            }
            // Infer session #1 for parent Wix session (null pkg number)
            if (
              s.source === 'wix' &&
              (s.package_session_number === null || s.package_session_number === undefined)
            ) {
              s.package_session_number = 1;
            }
          });
        });
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Commission: attach doctor_wallet to each regular session ──────────
      // Priority: 1) commission_history  2) therapist_commission > 0  3) doctor_commissions rates
      try {
        const regularSessionIds = enrichedRegular.map(s => s.id).filter(Boolean);

        // Fetch commission_history rows for these sessions (batch)
        let commissionHistoryMap = {};
        if (regularSessionIds.length > 0) {
          const { data: chRows } = await supabaseAdmin
            .from('commission_history')
            .select('session_id, commission_amount, session_amount')
            .in('session_id', regularSessionIds);
          (chRows || []).forEach(r => { commissionHistoryMap[r.session_id] = r; });
        }

        // Fetch doctor_commissions config for this psychologist
        const { data: dcRows } = await supabaseAdmin
          .from('doctor_commissions')
          .select('commission_amount_individual, commission_amount_package, commission_amounts, doctor_commission_first_session, doctor_commission_followup, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages')
          .eq('psychologist_id', psychologistId)
          .eq('is_active', true)
          .limit(1);
        const dc = dcRows?.[0] || null;

        enrichedRegular.forEach(s => {
          s.doctor_wallet = computeSessionDoctorWallet(s, dc, commissionHistoryMap[s.id] || null);
        });
      } catch (commErr) {
        console.warn('[psychologist/sessions] commission calc error (non-fatal):', commErr.message);
      }
      // ────────────────────────────────────────────────────────────────────────

      // Combine regular sessions and assessment sessions
      // Sort: pending sessions first (for scheduling), then by date
      const allSessions = [...enrichedRegular, ...assessmentSessions]
        .sort((a, b) => {
          // Pending sessions (null dates) come first
          if (!a.scheduled_date && b.scheduled_date) return -1;
          if (a.scheduled_date && !b.scheduled_date) return 1;
          if (!a.scheduled_date && !b.scheduled_date) {
            // Both pending — order by booking instant when available (Wix), else created_at
            const tb = getSessionBookingCreatedAtIso(b) || b.created_at;
            const ta = getSessionBookingCreatedAtIso(a) || a.created_at;
            return new Date(tb || 0) - new Date(ta || 0);
          }
          // Both have dates, sort by date descending
          return new Date(b.scheduled_date) - new Date(a.scheduled_date);
        });

      console.log(`🔍 Total sessions returned: ${allSessions.length} (regular: ${enrichedRegular.length}, assessment: ${assessmentSessions.length})`);
      console.log(`🔍 Pending assessment sessions in response:`, allSessions.filter(s => 
        (s.session_type === 'assessment' || s.type === 'assessment') && s.status === 'pending'
      ).map(s => ({
        id: s.id,
        status: s.status,
        psychologist_id: s.psychologist_id,
        scheduled_date: s.scheduled_date
      })));

      res.json(
        successResponse({
          sessions: allSessions,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: (count || 0) + assessmentSessions.length
          }
        })
      );

    } catch (dbError) {
      // If there's any database error, return empty sessions
      console.log('Database error in sessions query, returning empty sessions for psychologist:', dbError.message);
      return res.json(
        successResponse({
          sessions: [],
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: 0
          }
        })
      );
    }

  } catch (error) {
    console.error('Get psychologist sessions error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching sessions')
    );
  }
};

// Update session (for session notes, summary, etc.)
const updateSession = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { sessionId } = req.params;
    const updateData = req.body;

    // SECURITY FIX: Define allowed statuses to prevent invalid status values
    const ALLOWED_STATUSES = ['booked', 'rescheduled', 'completed', 'no_show', 'cancelled'];

    // Check if session exists and belongs to psychologist
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('psychologist_id', psychologistId)
      .single();

    if (!session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // SECURITY FIX: Validate status if provided
    if (updateData.status !== undefined) {
      if (!ALLOWED_STATUSES.includes(updateData.status)) {
        return res.status(400).json(
          errorResponse(`Invalid session status. Allowed values: ${ALLOWED_STATUSES.join(', ')}`)
        );
      }

      // SECURITY FIX: Require session summary when marking as completed
      if (updateData.status === 'completed' && !updateData.session_summary) {
        return res.status(400).json(
          errorResponse('Session summary is required to mark session as completed')
        );
      }
    }

    // Only allow updating certain fields
    const allowedUpdates = {
      session_notes: updateData.session_notes,
      session_summary: updateData.session_summary,
      status: updateData.status
    };

    // Remove undefined values
    Object.keys(allowedUpdates).forEach(key => 
      allowedUpdates[key] === undefined && delete allowedUpdates[key]
    );

    const { data: updatedSession, error } = await supabaseAdmin
      .from('sessions')
      .update({
        ...allowedUpdates,
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .select('*')
      .single();

    if (error) {
      console.error('Update session error:', error);
      return res.status(500).json(
        errorResponse('Failed to update session')
      );
    }

    res.json(
      successResponse(updatedSession, 'Session updated successfully')
    );

  } catch (error) {
    console.error('Update session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating session')
    );
  }
};

// Get availability
const getAvailability = async (req, res) => {
  try {
    // SECURITY FIX: Always use authenticated psychologist's ID, ignore query parameters
    // This prevents IDOR vulnerability where psychologists could view other psychologists' availability
    const psychologistId = req.user.id;
    const { date, start_date, end_date, page = 1, limit = 10 } = req.query;

    // Check if availability table exists and has proper relationships
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    try {
      // First get total count for pagination
      let countQuery = supabaseAdmin
        .from('availability')
        .select('*', { count: 'exact', head: true })
        .eq('psychologist_id', psychologistId);

      if (date) {
        countQuery = countQuery.eq('date', date);
      } else if (start_date && end_date) {
        countQuery = countQuery.gte('date', start_date).lte('date', end_date);
      }

      const { count, error: countError } = await countQuery;

      // Build main query with pagination
      let query = supabaseAdmin
        .from('availability')
        .select('*')
        .eq('psychologist_id', psychologistId);

      if (date) {
        query = query.eq('date', date);
      } else if (start_date && end_date) {
        query = query.gte('date', start_date).lte('date', end_date);
      }

      // Order by date ascending
      query = query.order('date', { ascending: true });

      // Apply pagination
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 10;
      const offset = (pageNum - 1) * limitNum;
      query = query.range(offset, offset + limitNum - 1);

      const { data: availability, error } = await query;

      if (error) {
        // If there's a database relationship error, return empty availability
        if (error.code === 'PGRST200' || error.message.includes('relationship') || error.message.includes('schema cache')) {
          console.log('Database relationships not fully established, returning empty availability for psychologist');
          return res.json(
            successResponse({
              availability: [],
              pagination: {
                page: parseInt(page) || 1,
                limit: parseInt(limit) || 10,
                total: 0,
                totalPages: 0
              }
            })
          );
        }
        
        console.error('Get availability error:', error);
        return res.status(500).json(
          errorResponse('Failed to fetch availability')
        );
      }

      // Calculate pagination info
      const totalPages = count ? Math.ceil(count / limitNum) : 0;

      // Get booked sessions to filter out from availability
      let bookedSessionsQuery = supabaseAdmin
        .from('sessions')
        .select('scheduled_date, scheduled_time')
        .eq('psychologist_id', psychologistId)
        .in('status', ['booked', 'rescheduled', 'confirmed']);

      if (date) {
        bookedSessionsQuery = bookedSessionsQuery.eq('scheduled_date', date);
      } else if (start_date && end_date) {
        bookedSessionsQuery = bookedSessionsQuery.gte('scheduled_date', start_date).lte('scheduled_date', end_date);
      }

      const { data: bookedSessions, error: sessionsError } = await bookedSessionsQuery;

      // Also get booked assessment sessions
      let bookedAssessmentSessionsQuery = supabaseAdmin
        .from('assessment_sessions')
        .select('scheduled_date, scheduled_time')
        .eq('psychologist_id', psychologistId)
        .in('status', ['booked', 'reserved']);

      if (date) {
        bookedAssessmentSessionsQuery = bookedAssessmentSessionsQuery.eq('scheduled_date', date);
      } else if (start_date && end_date) {
        bookedAssessmentSessionsQuery = bookedAssessmentSessionsQuery.gte('scheduled_date', start_date).lte('scheduled_date', end_date);
      }

      const { data: bookedAssessmentSessions, error: assessmentSessionsError } = await bookedAssessmentSessionsQuery;

      // Helper function to convert 24-hour time to 12-hour format for comparison
      const convertTo12Hour = (time24) => {
        if (!time24) return null;
        const timeStr = typeof time24 === 'string' ? time24 : String(time24);
        const timeOnly = timeStr.split(' ')[0]; // Remove timezone if present
        const [hours, minutes = '00'] = timeOnly.split(':');
        const hourNum = parseInt(hours, 10);
        if (isNaN(hourNum)) return null;
        
        const minuteStr = minutes.padStart(2, '0');
        if (hourNum === 0) return `12:${minuteStr} AM`;
        if (hourNum === 12) return `12:${minuteStr} PM`;
        if (hourNum > 12) return `${hourNum - 12}:${minuteStr} PM`;
        return `${hourNum}:${minuteStr} AM`;
      };

      // Create a map of booked times by date: { 'YYYY-MM-DD': Set(['9:00 PM', '21:00', ...]) }
      // Store both 12-hour and 24-hour formats for matching
      const bookedTimesByDate = new Map();
      [...(bookedSessions || []), ...(bookedAssessmentSessions || [])].forEach(session => {
        if (!session.scheduled_date || !session.scheduled_time) return;
        const dateKey = session.scheduled_date;
        const time24 = typeof session.scheduled_time === 'string' 
          ? session.scheduled_time.substring(0, 5) 
          : String(session.scheduled_time).substring(0, 5);
        const time12 = convertTo12Hour(session.scheduled_time);
        
        if (!bookedTimesByDate.has(dateKey)) {
          bookedTimesByDate.set(dateKey, new Set());
        }
        // Add both formats for matching
        bookedTimesByDate.get(dateKey).add(time24);
        if (time12) {
          bookedTimesByDate.get(dateKey).add(time12);
          // Also add variations like "9:00PM", "9:00 PM", "09:00 PM"
          bookedTimesByDate.get(dateKey).add(time12.replace(' ', ''));
          if (time12.includes(':')) {
            const [hour, rest] = time12.split(':');
            const paddedHour = hour.padStart(2, '0');
            bookedTimesByDate.get(dateKey).add(`${paddedHour}:${rest}`);
            bookedTimesByDate.get(dateKey).add(`${paddedHour}:${rest.replace(' ', '')}`);
          }
        }
      });

      // Fetch recurring blocks (e.g. block every Sunday) for this psychologist
      const recurringBlocks = await getRecurringBlocksForPsychologist(psychologistId);

      // Filter out booked slots from availability, then apply recurring blocks
      const filteredAvailability = (availability || []).map(dayAvailability => {
        const bookedTimes = bookedTimesByDate.get(dayAvailability.date) || new Set();
        let availableSlots = (dayAvailability.time_slots || []).filter(slot => {
          const slotStr = typeof slot === 'string' ? slot.trim() : String(slot).trim();
          if (!slotStr) return false;
          
          // Check if slot matches any booked time format
          const slotNormalized = slotStr.toLowerCase();
          const isBooked = Array.from(bookedTimes).some(bookedTime => {
            const bookedStr = String(bookedTime).trim();
            const bookedNormalized = bookedStr.toLowerCase();
            
            // Exact match
            if (slotNormalized === bookedNormalized) return true;
            
            // Match without spaces (e.g., "9:00PM" vs "9:00 PM")
            if (slotNormalized.replace(/\s+/g, '') === bookedNormalized.replace(/\s+/g, '')) return true;
            
            // Extract time components for both slot and booked time
            const slotTimeMatch = slotStr.match(/(\d{1,2}):(\d{2})/);
            const bookedTimeMatch = bookedStr.match(/(\d{1,2}):(\d{2})/);
            
            if (!slotTimeMatch || !bookedTimeMatch) return false;
            
            const slotHour = parseInt(slotTimeMatch[1], 10);
            const slotMin = slotTimeMatch[2];
            const bookedHour = parseInt(bookedTimeMatch[1], 10);
            const bookedMin = bookedTimeMatch[2];
            
            // Check AM/PM for both
            const slotPeriod = slotStr.match(/\s*(AM|PM)/i)?.[1]?.toUpperCase();
            const bookedPeriod = bookedStr.match(/\s*(AM|PM)/i)?.[1]?.toUpperCase();
            
            // Convert both to 24-hour format for accurate comparison
            let slotHour24 = slotHour;
            let bookedHour24 = bookedHour;
            
            // Convert slot to 24-hour
            if (slotPeriod === 'PM' && slotHour !== 12) {
              slotHour24 = slotHour + 12;
            } else if (slotPeriod === 'AM' && slotHour === 12) {
              slotHour24 = 0;
            }
            
            // Convert booked to 24-hour
            if (bookedPeriod === 'PM' && bookedHour !== 12) {
              bookedHour24 = bookedHour + 12;
            } else if (bookedPeriod === 'AM' && bookedHour === 12) {
              bookedHour24 = 0;
            }
            
            // If booked time is already in 24-hour format (no period), use it directly
            if (!bookedPeriod && bookedHour >= 0 && bookedHour <= 23) {
              bookedHour24 = bookedHour;
            }
            
            // Compare in 24-hour format
            if (slotHour24 === bookedHour24 && slotMin === bookedMin) {
              return true;
            }
            
            return false;
          });
          
          return !isBooked;
        });
        // Apply recurring blocks (e.g. block every Sunday) - only this psychologist affected
        availableSlots = filterSlotsByRecurringBlocks(availableSlots, dayAvailability.date, recurringBlocks);

        return {
          ...dayAvailability,
          time_slots: availableSlots
        };
      });

      // Get psychologist's Google Calendar credentials to check for blocked slots
      const { data: psychologist, error: psychError } = await supabaseAdmin
        .from('psychologists')
        .select('google_calendar_credentials')
        .eq('id', psychologistId)
        .single();

      if (psychError || !psychologist) {
        console.log('Psychologist not found or no Google Calendar credentials');
        const totalPages = count ? Math.ceil(count / limitNum) : 0;
        return res.json(
          successResponse({
            availability: filteredAvailability || [],
            pagination: {
              page: pageNum,
              limit: limitNum,
              total: count || 0,
              totalPages: totalPages
            }
          })
        );
      }

      // If Google Calendar is connected, check for blocked slots
      if (psychologist.google_calendar_credentials) {
        try {
          const googleCalendarService = require('../utils/googleCalendarService');
          
          // Determine date range for Google Calendar check
          let calendarStartDate, calendarEndDate;
          if (date) {
            calendarStartDate = new Date(date);
            calendarEndDate = new Date(date);
          } else if (start_date && end_date) {
            calendarStartDate = new Date(start_date);
            calendarEndDate = new Date(end_date);
          } else {
            // Default to current month if no date range specified
            const now = new Date();
            calendarStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
            calendarEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          }

          // Get Google Calendar busy slots (all events including external Google Meet sessions)
          const result = await googleCalendarService.getBusyTimeSlots(
            psychologist.google_calendar_credentials,
            calendarStartDate,
            calendarEndDate
          );
          const busySlots = result.busySlots || [];

          // Filter logic:
          // 1. Block ALL events in Google Calendar (system events, external events, etc.)
          //    - If an event corresponds to a session in our database, it's already blocked by the session
          //    - If an event doesn't correspond to a session, it should still block (orphaned system event or external event)
          // 2. Exclude only public holidays
          // 3. Exclude cancelled/deleted events
          const externalSlots = busySlots.filter(slot => {
            // Skip cancelled or deleted events
            if (slot.status === 'cancelled') {
              return false;
            }
            
            const title = (slot.title || '').toLowerCase();
            
            // Exclude only public holidays (common patterns)
            const isPublicHoliday = 
              title.includes('holiday') ||
              title.includes('public holiday') ||
              title.includes('national holiday') ||
              title.includes('festival') ||
              title.includes('celebration') ||
              title.includes('observance');
            
            // Block ALL events that are NOT public holidays
            // Note: System events will also block, but if they correspond to sessions in our DB,
            // those sessions will already block the slot (no double-blocking issue)
            return !isPublicHoliday;
          });

          console.log(`📅 Found ${busySlots.length} total Google Calendar events, ${externalSlots.length} external events (including Google Meet sessions) to block`);

          // Process availability data to remove external Google Calendar events (already filtered booked sessions above)
          const processedAvailability = filteredAvailability.map(dayAvailability => {
            // Get all external events for this date (including multi-day events)
            const dayExternalEvents = externalSlots.filter(slot => {
              // Extract dates in IST timezone to avoid day boundary issues
              const slotStartDate = dayjs(slot.start).tz('Asia/Kolkata').format('YYYY-MM-DD');
              const slotEndDate = dayjs(slot.end).tz('Asia/Kolkata').format('YYYY-MM-DD');
              
              // Include event if:
              // 1. Event starts on this date, OR
              // 2. Event ends on this date (multi-day event)
              return slotStartDate === dayAvailability.date || slotEndDate === dayAvailability.date;
            });

            // Get already booked times for this date (from database sessions)
            const bookedTimesForDate = bookedTimesByDate.get(dayAvailability.date) || new Set();
            
            // Convert external events to time slots and add to blocked times
            // An event might span multiple time slots, so we need to check overlap
            const googleCalendarBlockedTimes = new Set();
            dayExternalEvents.forEach(event => {
              // Extract dates in IST timezone to avoid day boundary issues
              const eventStartTz = dayjs(event.start).tz('Asia/Kolkata');
              const eventEndTz = dayjs(event.end).tz('Asia/Kolkata');
              const eventStartDate = eventStartTz.format('YYYY-MM-DD');
              const eventEndDate = eventEndTz.format('YYYY-MM-DD');
              const isMultiDayEvent = eventStartDate !== eventEndDate;
              
              // For each time slot in availability, check if it overlaps with this event
              (dayAvailability.time_slots || []).forEach(slot => {
                // Store original slot format for blocking (normalized to HH:MM for consistency)
                const slotTime = typeof slot === 'string' ? slot.substring(0, 5) : String(slot).substring(0, 5);
                
                // Convert slot time to 24-hour format (handles both "5:00 PM" and "17:00" formats)
                const time24Hour = convertSlotTimeTo24Hour(slot);
                if (!time24Hour) return; // Skip invalid times
                
                const [slotHour, slotMinute] = time24Hour.split(':').map(Number);
                
                // Create slot start and end times using timezone-aware dayjs (Asia/Kolkata)
                const slotStart = dayjs(`${dayAvailability.date} ${String(slotHour).padStart(2, '0')}:${String(slotMinute).padStart(2, '0')}:00`).tz('Asia/Kolkata');
                const slotEnd = slotStart.add(60, 'minutes'); // 1-hour slot
                
                // Parse event times with timezone support (already parsed above, reuse)
                // eventStartTz and eventEndTz are already defined above
                
                // Check if slot overlaps with event
                let overlaps = false;
                
                if (isMultiDayEvent) {
                  // Multi-day event: check if this date is the start date or end date
                  if (dayAvailability.date === eventStartDate) {
                    // On start date: block from event start time until end of day
                    const endOfDay = dayjs(`${dayAvailability.date} 23:59:59`).tz('Asia/Kolkata');
                    overlaps = slotStart.isBefore(eventEndTz) && slotEnd.isAfter(eventStartTz) && slotStart.isBefore(endOfDay);
                  } else if (dayAvailability.date === eventEndDate) {
                    // On end date: block from start of day until event end time
                    const startOfDay = dayjs(`${dayAvailability.date} 00:00:00`).tz('Asia/Kolkata');
                    overlaps = slotStart.isBefore(eventEndTz) && slotEnd.isAfter(startOfDay);
                  }
                } else {
                  // Single-day event: standard overlap check using timezone-aware comparisons
                  overlaps = slotStart.isBefore(eventEndTz) && slotEnd.isAfter(eventStartTz);
                }
                
                if (overlaps) {
                  googleCalendarBlockedTimes.add(slotTime);
                }
              });
            });

            // Combine booked times and Google Calendar blocked times
            const allBlockedTimes = new Set([...bookedTimesForDate, ...googleCalendarBlockedTimes]);

            // Remove all blocked time slots from availability (booked sessions + external Google Calendar events)
            const availableSlots = (dayAvailability.time_slots || []).filter(slot => {
              const slotTime = typeof slot === 'string' ? slot.substring(0, 5) : String(slot).substring(0, 5);
              return !allBlockedTimes.has(slotTime);
            });

            return {
              ...dayAvailability,
              time_slots: availableSlots,
              blocked_slots: Array.from(allBlockedTimes),
              total_blocked: allBlockedTimes.size,
              external_events: dayExternalEvents.length,
              booked_sessions: bookedTimesForDate.size,
              google_calendar_blocked: googleCalendarBlockedTimes.size
            };
          });

          const totalPages = count ? Math.ceil(count / limitNum) : 0;
          res.json(
            successResponse({
              availability: processedAvailability,
              pagination: {
                page: pageNum,
                limit: limitNum,
                total: count || 0,
                totalPages: totalPages
              }
            })
          );

        } catch (calendarError) {
          console.error('Error checking Google Calendar for blocked slots:', calendarError);
          // Return filtered availability (booked sessions already removed) without Google Calendar data if it fails
          const totalPages = count ? Math.ceil(count / limitNum) : 0;
          res.json(
            successResponse({
              availability: filteredAvailability || [],
              pagination: {
                page: pageNum,
                limit: limitNum,
                total: count || 0,
                totalPages: totalPages
              }
            })
          );
        }
      } else {
        // No Google Calendar connected, return filtered availability (booked sessions already removed)
        const totalPages = count ? Math.ceil(count / limitNum) : 0;
        res.json(
          successResponse({
            availability: filteredAvailability || [],
            pagination: {
              page: pageNum,
              limit: limitNum,
              total: count || 0,
              totalPages: totalPages
            }
          })
        );
      }

    } catch (dbError) {
      // If there's any database error, return empty availability
      console.log('Database error in availability query, returning empty availability for psychologist:', dbError.message);
      return res.json(
        successResponse({
          availability: [],
          pagination: {
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 10,
            total: 0,
            totalPages: 0
          }
        })
      );
      }
  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching availability')
    );
  }
};

// Update availability
const updateAvailability = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { date, time_slots } = req.body;

    // Check for conflicts with Google Calendar
    let filteredTimeSlots = time_slots;
    let blockedSlots = [];
    
    try {
      const { data: psychologist } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, google_calendar_credentials')
        .eq('id', psychologistId)
        .single();

      if (psychologist && psychologist.google_calendar_credentials) {
        const googleCalendarService = require('../utils/googleCalendarService');
        const conflictingSlots = [];
        
        for (const timeSlot of time_slots) {
          const [hours, minutes] = timeSlot.split(':');
          const slotStart = new Date(date);
          slotStart.setHours(parseInt(hours), parseInt(minutes), 0, 0);
          
          const slotEnd = new Date(slotStart);
          slotEnd.setHours(slotEnd.getHours() + 1); // Assuming 1-hour sessions
          
          const hasConflict = await googleCalendarService.hasTimeConflict(
            psychologist.google_calendar_credentials,
            slotStart,
            slotEnd
          );
          
          if (hasConflict) {
            conflictingSlots.push(timeSlot);
          }
        }
        
        // Filter out conflicting time slots
        filteredTimeSlots = time_slots.filter(slot => !conflictingSlots.includes(slot));
        blockedSlots = conflictingSlots;
        
        if (conflictingSlots.length > 0) {
          console.log(`⚠️  Blocked ${conflictingSlots.length} conflicting slots: ${conflictingSlots.join(', ')}`);
        }
      }
    } catch (googleError) {
      console.error('Error checking Google Calendar conflicts:', googleError);
      // Continue without blocking if Google Calendar check fails
    }

    // Check if availability already exists for this date
    const { data: existingAvailability } = await supabaseAdmin
      .from('availability')
      .select('id')
      .eq('psychologist_id', psychologistId)
      .eq('date', date)
      .single();

    let result;
    if (existingAvailability) {
      // Update existing availability with filtered slots
      const { data: updatedAvailability, error } = await supabaseAdmin
        .from('availability')
        .update({
          time_slots: filteredTimeSlots,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingAvailability.id)
        .select('*')
        .single();

      if (error) {
        console.error('Update availability error:', error);
        return res.status(500).json(
          errorResponse('Failed to update availability')
        );
      }
      result = updatedAvailability;
    } else {
      // Create new availability with filtered slots
      const { data: newAvailability, error } = await supabaseAdmin
        .from('availability')
        .insert([{
          psychologist_id: psychologistId,
          date,
          time_slots: filteredTimeSlots
        }])
        .select('*')
        .single();

      if (error) {
        console.error('Create availability error:', error);
        return res.status(500).json(
          errorResponse('Failed to create availability')
        );
      }
      result = newAvailability;
    }

    const message = blockedSlots.length > 0 
      ? `Availability updated. ${blockedSlots.length} slot(s) blocked due to Google Calendar conflicts: ${blockedSlots.join(', ')}`
      : 'Availability updated successfully';

    res.json(
      successResponse({
        ...result,
        blocked_slots: blockedSlots,
        blocked_count: blockedSlots.length
      }, message)
    );

  } catch (error) {
    console.error('Update availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating availability')
    );
  }
};

// Add new availability
const addAvailability = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { date, time_slots, is_available = true } = req.body;

    // Validate required fields
    if (!date || !time_slots || time_slots.length === 0) {
      return res.status(400).json(
        errorResponse('Date and time slots are required')
      );
    }

    // Check if availability already exists for this date
    const { data: existingAvailability } = await supabaseAdmin
      .from('availability')
      .select('id')
      .eq('psychologist_id', psychologistId)
      .eq('date', date)
      .single();

    if (existingAvailability) {
      return res.status(400).json(
        errorResponse('Availability already exists for this date. Use update instead.')
      );
    }

    // Check for conflicts with Google Calendar
    let filteredTimeSlots = time_slots;
    let blockedSlots = [];
    
    try {
      const { data: psychologist } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, google_calendar_credentials')
        .eq('id', psychologistId)
        .single();

      if (psychologist && psychologist.google_calendar_credentials) {
        const googleCalendarService = require('../utils/googleCalendarService');
        const conflictingSlots = [];
        
        for (const timeSlot of time_slots) {
          const [hours, minutes] = timeSlot.split(':');
          const slotStart = new Date(date);
          slotStart.setHours(parseInt(hours), parseInt(minutes), 0, 0);
          
          const slotEnd = new Date(slotStart);
          slotEnd.setHours(slotEnd.getHours() + 1); // Assuming 1-hour sessions
          
          const hasConflict = await googleCalendarService.hasTimeConflict(
            psychologist.google_calendar_credentials,
            slotStart,
            slotEnd
          );
          
          if (hasConflict) {
            conflictingSlots.push(timeSlot);
          }
        }
        
        // Filter out conflicting time slots
        filteredTimeSlots = time_slots.filter(slot => !conflictingSlots.includes(slot));
        blockedSlots = conflictingSlots;
        
        if (conflictingSlots.length > 0) {
          console.log(`⚠️  Blocked ${conflictingSlots.length} conflicting slots: ${conflictingSlots.join(', ')}`);
        }
      }
    } catch (googleError) {
      console.error('Error checking Google Calendar conflicts:', googleError);
      // Continue without blocking if Google Calendar check fails
    }

    // Create new availability with filtered slots
    const { data: newAvailability, error } = await supabaseAdmin
      .from('availability')
      .insert([{
        psychologist_id: psychologistId,
        date,
        time_slots: filteredTimeSlots,
        is_available,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select('*')
      .single();

    if (error) {
      console.error('Create availability error:', error);
      return res.status(500).json(
        errorResponse('Failed to create availability')
      );
    }

    const message = blockedSlots.length > 0 
      ? `Availability created. ${blockedSlots.length} slot(s) blocked due to Google Calendar conflicts: ${blockedSlots.join(', ')}`
      : 'Availability created successfully';

    res.status(201).json(
      successResponse({
        ...newAvailability,
        blocked_slots: blockedSlots,
        blocked_count: blockedSlots.length
      }, message)
    );

  } catch (error) {
    console.error('Add availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating availability')
    );
  }
};

// Delete availability
const deleteAvailability = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const availabilityId = req.params.availabilityId;

    // Check if availability exists and belongs to this psychologist
    const { data: existingAvailability, error: checkError } = await supabaseAdmin
      .from('availability')
      .select('id')
      .eq('id', availabilityId)
      .eq('psychologist_id', psychologistId)
      .single();

    if (checkError || !existingAvailability) {
      return res.status(404).json(
        errorResponse('Availability not found or access denied')
      );
    }

    // Delete the availability
    const { error: deleteError } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('id', availabilityId);

    if (deleteError) {
      console.error('Delete availability error:', deleteError);
      return res.status(500).json(
        errorResponse('Failed to delete availability')
      );
    }

    res.json(
      successResponse(null, 'Availability deleted successfully')
    );

  } catch (error) {
    console.error('Delete availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting availability')
    );
  }
};

// Recurring blocks (e.g. block every Sunday as leave) - only affects this psychologist
const getRecurringBlocks = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { data: blocks, error } = await supabaseAdmin
      .from('psychologist_recurring_blocks')
      .select('*')
      .eq('psychologist_id', psychologistId)
      .order('day_of_week', { ascending: true });

    if (error) {
      console.error('Get recurring blocks error:', error);
      return res.status(500).json(errorResponse('Failed to fetch recurring blocks'));
    }
    res.json(successResponse(blocks || [], 'Recurring blocks fetched'));
  } catch (err) {
    console.error('Get recurring blocks error:', err);
    res.status(500).json(errorResponse('Internal server error while fetching recurring blocks'));
  }
};

const addRecurringBlock = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { day_of_week, block_entire_day = true, time_slots } = req.body;

    if (day_of_week == null || day_of_week < 0 || day_of_week > 6) {
      return res.status(400).json(errorResponse('day_of_week must be 0 (Sunday) through 6 (Saturday)'));
    }

    const { normalizeTimeSlotsForStorage } = require('../utils/recurringBlocksHelper');
    const dayNum = Number(day_of_week);
    const normalizedSlots = normalizeTimeSlotsForStorage(time_slots);
    const payload = {
      psychologist_id: psychologistId,
      day_of_week: dayNum,
      block_entire_day: !!block_entire_day,
      time_slots: normalizedSlots
    };

    // If updating an existing block, remove old Google Calendar event(s) first (may be comma-separated for specific slots)
    const { data: existing } = await supabaseAdmin
      .from('psychologist_recurring_blocks')
      .select('id, google_calendar_event_id')
      .eq('psychologist_id', psychologistId)
      .eq('day_of_week', dayNum)
      .maybeSingle();

    if (existing?.google_calendar_event_id) {
      const ids = String(existing.google_calendar_event_id).split(',').map((id) => id.trim()).filter(Boolean);
      for (const eventId of ids) {
        await timeBlockingService.deleteRecurringBlockCalendarEvent(psychologistId, eventId);
      }
    }

    // Create recurring event(s) on Google Calendar (full-day, range, or one per specific slot) when GCal connected
    if (payload.block_entire_day || (payload.time_slots && payload.time_slots.length > 0)) {
      const gcalResult = await timeBlockingService.createRecurringBlockCalendarEvent(
        psychologistId,
        { day_of_week: dayNum, block_entire_day: payload.block_entire_day, time_slots: payload.time_slots },
        'Recurring block'
      );
      if (gcalResult.success) {
        if (gcalResult.eventIds && gcalResult.eventIds.length > 0) {
          payload.google_calendar_event_id = gcalResult.eventIds.join(',');
        } else if (gcalResult.eventId) {
          payload.google_calendar_event_id = gcalResult.eventId;
        }
      }
    }

    const { data: block, error } = await supabaseAdmin
      .from('psychologist_recurring_blocks')
      .upsert(payload, {
        onConflict: 'psychologist_id,day_of_week',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) {
      console.error('Add recurring block error:', error);
      return res.status(500).json(errorResponse(error.message || 'Failed to add recurring block'));
    }
    // Sync future availability so blocked day has empty/reduced slots in DB (Wix etc. see it as blocked)
    await syncFutureAvailabilityForRecurringBlockDay(psychologistId, dayNum, { useDefaultSlots: false });
    res.json(successResponse(block, 'Recurring block saved. It will apply to all future weeks.'));
  } catch (err) {
    console.error('Add recurring block error:', err);
    res.status(500).json(errorResponse('Internal server error while adding recurring block'));
  }
};

const deleteRecurringBlock = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const blockId = req.params.blockId;

    const { data: block } = await supabaseAdmin
      .from('psychologist_recurring_blocks')
      .select('id, google_calendar_event_id, day_of_week')
      .eq('id', blockId)
      .eq('psychologist_id', psychologistId)
      .single();

    if (block?.google_calendar_event_id) {
      const ids = String(block.google_calendar_event_id).split(',').map((id) => id.trim()).filter(Boolean);
      for (const eventId of ids) {
        await timeBlockingService.deleteRecurringBlockCalendarEvent(psychologistId, eventId);
      }
    }

    const { error } = await supabaseAdmin
      .from('psychologist_recurring_blocks')
      .delete()
      .eq('id', blockId)
      .eq('psychologist_id', psychologistId);

    if (error) {
      console.error('Delete recurring block error:', error);
      return res.status(500).json(errorResponse('Failed to delete recurring block'));
    }
    // Restore default slots for that day in future availability (so Wix etc. see it as available again)
    if (block?.day_of_week != null) {
      await syncFutureAvailabilityForRecurringBlockDay(psychologistId, block.day_of_week, { useDefaultSlots: true });
    }
    res.json(successResponse(null, 'Recurring block removed'));
  } catch (err) {
    console.error('Delete recurring block error:', err);
    res.status(500).json(errorResponse('Internal server error while deleting recurring block'));
  }
};

// Complete session with summary and notes
const completeSession = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { sessionId } = req.params;
    // Accept both frontend format (summary, report, summary_notes) and backend format (session_summary, session_notes)
    const { 
      summary, 
      report, 
      summary_notes,
      session_summary, 
      session_notes, 
      status = 'completed' 
    } = req.body;

    // Use frontend format if provided, otherwise fall back to backend format
    const finalSummary = summary || session_summary;
    const finalNotes = summary_notes || session_notes;
    const finalReport = report || '';

    // Only the "Message to Team" (report) is required — it's what's sent to operations.
    // The client-visible summary and therapist notes are optional.
    if (!finalReport || finalReport.trim().length === 0) {
      return res.status(400).json(
        errorResponse('Message to Team (report) is required')
      );
    }

    // Prepare update data
    const updateData = {
      status: status,
      updated_at: new Date().toISOString()
    };
    // Store the client-visible summary only if provided (now optional)
    if (finalSummary && finalSummary.trim().length > 0) {
      updateData.session_summary = finalSummary.trim();
    }

    // Add session notes if provided (optional)
    if (finalNotes && finalNotes.trim().length > 0) {
      updateData.session_notes = finalNotes.trim();
    }

    // Add report if provided (stored in summary_notes or as a separate field if the schema supports it)
    // For now, append report to summary_notes if report is provided separately
    if (finalReport && finalReport.trim().length > 0) {
      updateData.session_notes = (updateData.session_notes || '') + 
        (updateData.session_notes ? '\n\n--- Report ---\n' : '') + 
        finalReport.trim();
    }

    // First, try to find it as a regular session with client data (for notifications)
    const { data: regularSession } = await supabaseAdmin
      .from('sessions')
      .select(`
        *,
        client:clients(
          id,
          first_name,
          last_name,
          child_name,
          user_id,
          phone_number,
          user:users(email)
        )
      `)
      .eq('id', sessionId)
      .eq('psychologist_id', psychologistId)
      .single();

    if (regularSession) {
      // Normalize client (Supabase PostgREST can return FK relation as object or array)
      const client = Array.isArray(regularSession.client) ? regularSession.client[0] : regularSession.client;

      // Update regular session
      let { data: updatedSession, error } = await supabaseAdmin
        .from('sessions')
        .update(updateData)
        .eq('id', sessionId)
        .eq('psychologist_id', psychologistId)
        .select('*')
        .single();

      // Backward-compatible fallback for older schemas that may not have notes/summary columns.
      if (error && String(error.message || '').includes("session_notes")) {
        const retryPayload = { ...updateData };
        delete retryPayload.session_notes;

        ({ data: updatedSession, error } = await supabaseAdmin
          .from('sessions')
          .update(retryPayload)
          .eq('id', sessionId)
          .eq('psychologist_id', psychologistId)
          .select('*')
          .single());
      }

      if (error && String(error.message || '').includes("session_summary")) {
        const retryPayload = { ...updateData };
        delete retryPayload.session_summary;

        ({ data: updatedSession, error } = await supabaseAdmin
          .from('sessions')
          .update(retryPayload)
          .eq('id', sessionId)
          .eq('psychologist_id', psychologistId)
          .select('*')
          .single());
      }

      if (error) {
        console.error('Complete session error:', error);
        return res.status(500).json(
          errorResponse('Failed to complete session')
        );
      }

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
        // Create in-app notification
        if (client?.user_id) {
          const clientNotificationData = {
            user_id: client.user_id,
            title: 'Session Completed',
            message: `Your session has been completed. You can now view the summary and report.`,
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

        // ── TEMPORARILY DISABLED: client follow-up WhatsApp on completion ──
        // No completion message is sent to the client for now (per request).
        // To re-enable, uncomment the block below.
        console.log(`⏸️ session_follow_up_v2 to client is temporarily disabled (session ${sessionId})`);
        /*
        try {
          const interaktService = require('../utils/interaktService');
          const clientPhone = client?.phone_number || null;
          if (clientPhone) {
            const psychologistName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'your therapist';
            const clientName = getClientDisplayName(client, 'there');
            const therapistNote = (updatedSession?.summary && String(updatedSession.summary).trim()) || '';
            const completedAt = updatedSession?.completion_date || updatedSession?.updated_at || new Date().toISOString();

            const result = await interaktService.sendSessionFollowUp(clientPhone, {
              clientName, psychologistName, completedAt, therapistNote,
            });
            if (result?.success) console.log(`✅ session_follow_up_v2 sent to client for session ${sessionId}`);
            else console.warn(`⚠️ session_follow_up_v2 to client failed for session ${sessionId}:`, result?.error || result?.reason);
          } else {
            console.warn(`⚠️ Skipping session_follow_up_v2 for session ${sessionId}: client phone not found.`);
          }
        } catch (waError) {
          console.error(`❌ Error sending session_follow_up_v2 for session ${sessionId}:`, waError.message);
        }
        */
      } catch (notificationError) {
        console.error('Error sending completion notification:', notificationError);
        // Don't fail the request if notification fails
      }

      return res.json(
        successResponse(updatedSession, 'Session completed successfully with summary and notes')
      );
    }

    // If not found in regular sessions, check assessment sessions
    const { data: assessmentSession, error: assessCheckError } = await supabaseAdmin
      .from('assessment_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('psychologist_id', psychologistId)
      .single();

    if (assessCheckError || !assessmentSession) {
      return res.status(404).json(
        errorResponse('Session not found or you do not have permission to complete this session')
      );
    }

    // Update assessment session
    const { data: updatedAssessmentSession, error: assessUpdateError } = await supabaseAdmin
      .from('assessment_sessions')
      .update(updateData)
      .eq('id', sessionId)
      .eq('psychologist_id', psychologistId)
      .select('*')
      .single();

    if (assessUpdateError) {
      console.error('Complete assessment session error:', assessUpdateError);
      return res.status(500).json(
        errorResponse('Failed to complete assessment session')
      );
    }

    console.log('✅ Assessment session completed successfully:', updatedAssessmentSession.id);

    res.json(
      successResponse(updatedAssessmentSession, 'Assessment session completed successfully with summary and notes')
    );

  } catch (error) {
    console.error('Complete session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while completing session')
    );
  }
};

// Schedule pending assessment session (for psychologists)
const scheduleAssessmentSession = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { assessmentSessionId } = req.params;
    // SECURITY FIX: Remove target_psychologist_id from request body - force self-assignment
    const { scheduled_date, scheduled_time } = req.body;

    if (!scheduled_date || !scheduled_time) {
      return res.status(400).json(
        errorResponse('Missing required fields: scheduled_date, scheduled_time')
      );
    }

    // Fetch assessment session by ID (allow reassignment to another psychologist)
    const { data: assessmentSession, error: fetchError } = await supabaseAdmin
      .from('assessment_sessions')
      .select('*')
      .eq('id', assessmentSessionId)
      .single();

    if (fetchError || !assessmentSession) {
      return res.status(404).json(
        errorResponse('Assessment session not found')
      );
    }

    // Check if session is in pending status
    if (assessmentSession.status !== 'pending') {
      return res.status(400).json(
        errorResponse(`Cannot schedule session. Current status: ${assessmentSession.status}`)
      );
    }

    // SECURITY FIX: Force self-assignment to prevent arbitrary reassignment
    // Psychologists can only schedule sessions for themselves
    const targetPsychologistId = psychologistId;

    // Check conflicts for TARGET psychologist
    const { data: conflictingAssessmentSessions } = await supabaseAdmin
      .from('assessment_sessions')
      .select('id')
      .eq('psychologist_id', targetPsychologistId)
      .eq('scheduled_date', scheduled_date)
      .eq('scheduled_time', scheduled_time)
      .in('status', ['reserved', 'booked']);

    // Also check regular therapy sessions for target psychologist
    const { data: conflictingRegularSessions } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('psychologist_id', targetPsychologistId)
      .eq('scheduled_date', scheduled_date)
      .eq('scheduled_time', scheduled_time)
      .in('status', ['booked', 'rescheduled', 'confirmed']);

    const hasConflict = (conflictingAssessmentSessions && conflictingAssessmentSessions.length > 0) ||
                       (conflictingRegularSessions && conflictingRegularSessions.length > 0);

    if (hasConflict) {
      return res.status(400).json(
        errorResponse('This time slot is already booked for you. Please select another time.')
      );
    }

    // Update the assessment session with scheduled date/time and change status to booked
    const { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('assessment_sessions')
      .update({
        scheduled_date,
        scheduled_time,
        status: 'booked',
        psychologist_id: targetPsychologistId,
        updated_at: new Date().toISOString()
      })
      .eq('id', assessmentSessionId)
      .eq('status', 'pending')
      .select('*')
      .single();

    if (updateError || !updatedSession) {
      console.error('Error scheduling assessment session:', updateError);
      return res.status(500).json(
        errorResponse('Failed to schedule assessment session')
      );
    }

    console.log('✅ Assessment session scheduled successfully by psychologist:', updatedSession.id);

    // Block the booked slot from availability (best-effort)
    // Use targetPsychologistId (the psychologist the session is assigned to), not the logged-in psychologist
    try {
      const hhmm = (scheduled_time || '').substring(0,5);
      const { data: avail } = await supabaseAdmin
        .from('availability')
        .select('id, time_slots')
        .eq('psychologist_id', targetPsychologistId)
        .eq('date', scheduled_date)
        .single();
      if (avail && Array.isArray(avail.time_slots)) {
        const filtered = avail.time_slots.filter(t => (typeof t === 'string' ? t.substring(0,5) : String(t).substring(0,5)) !== hhmm);
        if (filtered.length !== avail.time_slots.length) {
          await supabaseAdmin
            .from('availability')
            .update({ time_slots: filtered, updated_at: new Date().toISOString() })
            .eq('id', avail.id);
          console.log('✅ Availability updated to block scheduled assessment slot', { date: scheduled_date, time: hhmm });
        }
      }
    } catch (blockErr) {
      console.warn('⚠️ Failed to update availability after scheduling:', blockErr?.message);
    }

    let sessionWithMeet = updatedSession;
    try {
      const { session: enrichedSession } = await assessmentSessionService.finalizeAssessmentSessionBooking(updatedSession.id, {
        durationMinutes: 50
      });
      if (enrichedSession) {
        sessionWithMeet = enrichedSession;
      }
    } catch (notifyError) {
      console.error('⚠️ Failed to finalize assessment session notifications:', notifyError?.message || notifyError);
    }

    res.json(
      successResponse(sessionWithMeet, 'Assessment session scheduled successfully')
    );

  } catch (error) {
    console.error('Schedule assessment session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while scheduling assessment session')
    );
  }
};

// Delete a regular therapy session (owned by psychologist)
const deleteSession = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const { sessionId } = req.params;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('sessions')
      .select('id, payment_id')
      .eq('id', sessionId)
      .eq('psychologist_id', psychologistId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json(
        errorResponse('Session not found or access denied')
      );
    }

    // Delete related payment records (if any)
    try {
      await supabaseAdmin
        .from('payments')
        .delete()
        .eq('session_id', sessionId);
    } catch (payErr) {
      console.warn('⚠️  Failed to delete related payments for session:', sessionId, payErr?.message);
    }

    const { error: delError } = await supabaseAdmin
      .from('sessions')
      .delete()
      .eq('id', sessionId);

    if (delError) {
      console.error('Delete session error:', delError);
      return res.status(500).json(
        errorResponse('Failed to delete session')
      );
    }

    res.json(successResponse(null, 'Session deleted successfully'));
  } catch (error) {
    console.error('Delete session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting session')
    );
  }
};

// Delete an assessment session (owned by psychologist or admin)
const deleteAssessmentSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { assessmentSessionId } = req.params;

    // Check if session exists
    let query = supabaseAdmin
      .from('assessment_sessions')
      .select('id, psychologist_id, status')
      .eq('id', assessmentSessionId);

    // If not admin, only allow deletion of sessions owned by the psychologist
    if (userRole !== 'admin' && userRole !== 'superadmin') {
      query = query.eq('psychologist_id', userId);
    }

    const { data: existing, error: fetchError } = await query.single();

    if (fetchError || !existing) {
      return res.status(404).json(
        errorResponse('Assessment session not found or access denied')
      );
    }

    // Only allow deletion of sessions that are not completed (unless admin)
    if (existing.status === 'completed' && userRole !== 'admin' && userRole !== 'superadmin') {
      return res.status(400).json(
        errorResponse('Cannot delete completed assessment sessions')
      );
    }

    // Delete related payment records (if any)
    try {
      await supabaseAdmin
        .from('payments')
        .delete()
        .eq('assessment_session_id', assessmentSessionId);
    } catch (payErr) {
      console.warn('⚠️  Failed to delete related payments for assessment session:', assessmentSessionId, payErr?.message);
    }

    const { error: delError } = await supabaseAdmin
      .from('assessment_sessions')
      .delete()
      .eq('id', assessmentSessionId);

    if (delError) {
      console.error('Delete assessment session error:', delError);
      return res.status(500).json(
        errorResponse('Failed to delete assessment session')
      );
    }

    res.json(successResponse(null, 'Assessment session deleted successfully'));
  } catch (error) {
    console.error('Delete assessment session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting assessment session')
    );
  }
};

// Get monthly stats (completed and upcoming sessions for current month)
const getMonthlyStats = async (req, res) => {
  try {
    const psychologistId = req.user.id;

    // Current month boundaries in UTC calendar (aligned with finance / admin date presets).
    const now = dayjs.utc();
    const monthStart = now.startOf('month').format('YYYY-MM-DD');
    const monthEnd = now.endOf('month').format('YYYY-MM-DD');

    // Get completed sessions for current month
    const { count: completedCount, error: completedError } = await supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .eq('psychologist_id', psychologistId)
      .eq('status', 'completed')
      .gte('scheduled_date', monthStart)
      .lte('scheduled_date', monthEnd);

    if (completedError) {
      console.error('Error fetching completed sessions:', completedError);
    }

    // Upcoming sessions: appointment date from UTC “today” through end of UTC month (operational calendar).
    const today = now.format('YYYY-MM-DD');
    const { count: upcomingCount, error: upcomingError } = await supabaseAdmin
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .eq('psychologist_id', psychologistId)
      .in('status', ['booked', 'rescheduled', 'reschedule_requested', 'scheduled'])
      .gte('scheduled_date', today)
      .lte('scheduled_date', monthEnd);

    if (upcomingError) {
      console.error('Error fetching upcoming sessions:', upcomingError);
    }

    res.json(
      successResponse({
        completed_sessions: completedCount || 0,
        upcoming_sessions: upcomingCount || 0,
        month: now.format('MMMM YYYY'),
        month_start: monthStart,
        month_end: monthEnd
      })
    );

  } catch (error) {
    console.error('Error in getMonthlyStats:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching monthly stats')
    );
  }
};

// Get client's completed session history (for any psychologist viewing a session with this client)
// Private notes (summary_notes) are only included when the session was conducted by the current psychologist
const getClientSessionHistory = async (req, res) => {
  try {
    const currentPsychologistId = req.user.id;
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json(errorResponse('Client ID is required'));
    }

    const { data: sessions, error } = await supabaseAdmin
      .from('sessions')
      .select(`
        id,
        client_id,
        psychologist_id,
        scheduled_date,
        scheduled_time,
        status,
        session_summary,
        session_notes,
        summary,
        report,
        summary_notes,
        psychologist:psychologists(
          id,
          first_name,
          last_name
        )
      `)
      .eq('client_id', clientId)
      .eq('status', 'completed')
      .order('scheduled_date', { ascending: false })
      .order('scheduled_time', { ascending: false });

    if (error) {
      console.error('getClientSessionHistory error:', error);
      return res.status(500).json(errorResponse('Failed to fetch session history'));
    }

    const REPORT_SEP = '\n\n--- Report ---\n';

    const list = (sessions || []).map((s) => {
      const isOwnSession = s.psychologist_id === currentPsychologistId;
      let summary = s.summary ?? s.session_summary ?? null;
      let report = s.report ?? null;
      let privateNotes = s.summary_notes ?? null;
      const combinedNotes = s.session_notes?.trim() || null;

      if (combinedNotes && (report == null || privateNotes == null)) {
        const idx = combinedNotes.indexOf(REPORT_SEP);
        if (idx >= 0) {
          const before = combinedNotes.slice(0, idx).trim();
          const after = combinedNotes.slice(idx + REPORT_SEP.length).trim();
          if (privateNotes == null && before) privateNotes = before;
          if (report == null && after) report = after;
        } else if (privateNotes == null) {
          privateNotes = combinedNotes;
        }
      }

      const psychologistName = s.psychologist
        ? [s.psychologist.first_name, s.psychologist.last_name].filter(Boolean).join(' ').trim()
        : 'Psychologist';

      return {
        id: s.id,
        client_id: s.client_id,
        psychologist_id: s.psychologist_id,
        scheduled_date: s.scheduled_date,
        scheduled_time: s.scheduled_time,
        status: s.status,
        summary: summary && summary.trim() ? summary.trim() : null,
        report: report && report.trim() ? report.trim() : null,
        summary_notes: isOwnSession && privateNotes && privateNotes.trim() ? privateNotes.trim() : null,
        psychologist_name: psychologistName,
        psychologist: s.psychologist
      };
    });

    res.json(successResponse({ sessions: list }, 'Session history retrieved'));
  } catch (err) {
    console.error('getClientSessionHistory error:', err);
    res.status(500).json(errorResponse('Internal server error while fetching session history'));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Private Note Password — per-therapist password that gates access to
// sessions.summary_notes (private clinical notes). Distinct from login password.
// Backed by psychologists.private_note_password_hash (bcrypt).
// ─────────────────────────────────────────────────────────────────────────────
const bcrypt = require('bcryptjs');

// Column may not exist yet — wrap reads so we return a clear message.
async function fetchPsychologistPasswordRow(psychologistId) {
  const { data, error } = await supabaseAdmin
    .from('psychologists')
    .select('id, private_note_password_hash')
    .eq('id', psychologistId)
    .single();
  if (error) {
    if (error.code === '42703' || /column .* does not exist/i.test(error.message || '')) {
      const e = new Error('Private note password column missing. Apply migration 20260603_psychologist_private_note_password.sql in Supabase.');
      e.code = 'MIGRATION_REQUIRED';
      throw e;
    }
    throw error;
  }
  return data;
}

/** GET /psychologists/private-notes/status → { hasPassword } */
const getPrivateNotePasswordStatus = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const row = await fetchPsychologistPasswordRow(psychologistId);
    res.json(successResponse({ hasPassword: !!row.private_note_password_hash }));
  } catch (err) {
    if (err.code === 'MIGRATION_REQUIRED') {
      return res.status(503).json(errorResponse(err.message));
    }
    console.error('getPrivateNotePasswordStatus error:', err);
    res.status(500).json(errorResponse('Failed to read private note password status'));
  }
};

/** POST /psychologists/private-notes/setup  body:{ password } — first-time set */
const setupPrivateNotePassword = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const password = String(req.body?.password || '');
    if (password.length < 6) {
      return res.status(400).json(errorResponse('Password must be at least 6 characters'));
    }
    const row = await fetchPsychologistPasswordRow(psychologistId);
    if (row.private_note_password_hash) {
      return res.status(400).json(errorResponse('Password already set. Use change endpoint.'));
    }
    const hash = await bcrypt.hash(password, 12);
    const { error: updErr } = await supabaseAdmin
      .from('psychologists')
      .update({ private_note_password_hash: hash, updated_at: new Date().toISOString() })
      .eq('id', psychologistId);
    if (updErr) throw updErr;
    res.json(successResponse({ hasPassword: true }, 'Private note password set'));
  } catch (err) {
    if (err.code === 'MIGRATION_REQUIRED') {
      return res.status(503).json(errorResponse(err.message));
    }
    console.error('setupPrivateNotePassword error:', err);
    res.status(500).json(errorResponse('Failed to set private note password'));
  }
};

/** POST /psychologists/private-notes/change  body:{ currentPassword, newPassword } */
const changePrivateNotePassword = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json(errorResponse('New password must be at least 6 characters'));
    }
    const row = await fetchPsychologistPasswordRow(psychologistId);
    if (!row.private_note_password_hash) {
      return res.status(400).json(errorResponse('No password set. Use setup endpoint.'));
    }
    const ok = await bcrypt.compare(currentPassword, row.private_note_password_hash);
    if (!ok) {
      return res.status(400).json(errorResponse('Current password is incorrect'));
    }
    const hash = await bcrypt.hash(newPassword, 12);
    const { error: updErr } = await supabaseAdmin
      .from('psychologists')
      .update({ private_note_password_hash: hash, updated_at: new Date().toISOString() })
      .eq('id', psychologistId);
    if (updErr) throw updErr;
    res.json(successResponse({ hasPassword: true }, 'Private note password changed'));
  } catch (err) {
    if (err.code === 'MIGRATION_REQUIRED') {
      return res.status(503).json(errorResponse(err.message));
    }
    console.error('changePrivateNotePassword error:', err);
    res.status(500).json(errorResponse('Failed to change private note password'));
  }
};

/** POST /psychologists/private-notes/verify  body:{ password } → { valid } */
const verifyPrivateNotePassword = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const password = String(req.body?.password || '');
    const row = await fetchPsychologistPasswordRow(psychologistId);
    if (!row.private_note_password_hash) {
      return res.status(400).json(errorResponse('No password set'));
    }
    const ok = await bcrypt.compare(password, row.private_note_password_hash);
    if (!ok) {
      return res.status(400).json(errorResponse('Incorrect password'));
    }
    res.json(successResponse({ valid: true }));
  } catch (err) {
    if (err.code === 'MIGRATION_REQUIRED') {
      return res.status(503).json(errorResponse(err.message));
    }
    console.error('verifyPrivateNotePassword error:', err);
    res.status(500).json(errorResponse('Failed to verify password'));
  }
};

/** POST /psychologists/private-notes/reset  body:{ loginPassword, newPassword }
 *  Reset using the therapist's login password as proof of identity.
 */
const resetPrivateNotePassword = async (req, res) => {
  try {
    const psychologistId = req.user.id;
    const loginPassword = String(req.body?.loginPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json(errorResponse('New password must be at least 6 characters'));
    }
    const { data: row, error } = await supabaseAdmin
      .from('psychologists')
      .select('id, password_hash')
      .eq('id', psychologistId)
      .single();
    if (error || !row) {
      return res.status(404).json(errorResponse('Therapist not found'));
    }
    const ok = await bcrypt.compare(loginPassword, row.password_hash || '');
    if (!ok) {
      return res.status(400).json(errorResponse('Login password is incorrect'));
    }
    const hash = await bcrypt.hash(newPassword, 12);
    const { error: updErr } = await supabaseAdmin
      .from('psychologists')
      .update({ private_note_password_hash: hash, updated_at: new Date().toISOString() })
      .eq('id', psychologistId);
    if (updErr) {
      if (updErr.code === '42703' || /column .* does not exist/i.test(updErr.message || '')) {
        return res.status(503).json(errorResponse('Private note password column missing. Apply migration 20260603_psychologist_private_note_password.sql in Supabase.'));
      }
      throw updErr;
    }
    res.json(successResponse({ hasPassword: true }, 'Private note password reset'));
  } catch (err) {
    console.error('resetPrivateNotePassword error:', err);
    res.status(500).json(errorResponse('Failed to reset private note password'));
  }
};

module.exports = {
  getProfile,
  updateProfile,
  getSessions,
  updateSession,
  completeSession,
  scheduleAssessmentSession,
  getAvailability,
  addAvailability,
  updateAvailability,
  deleteAvailability,
  getRecurringBlocks,
  addRecurringBlock,
  deleteRecurringBlock,
  deleteSession,
  deleteAssessmentSession,
  getMonthlyStats,
  getClientSessionHistory,
  // Private note password
  getPrivateNotePasswordStatus,
  setupPrivateNotePassword,
  changePrivateNotePassword,
  verifyPrivateNotePassword,
  resetPrivateNotePassword,
};
