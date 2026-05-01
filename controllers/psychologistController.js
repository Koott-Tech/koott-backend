const { supabaseAdmin } = require('../config/supabase');
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
            child_name,
            child_age,
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
      try {
        let assessQuery = supabaseAdmin
          .from('assessment_sessions')
          .select(`
            id,
            assessment_id,
            assessment_slug,
            client_id,
            psychologist_id,
            scheduled_date,
            scheduled_time,
            status,
            amount,
            payment_id,
            session_number,
            created_at,
            updated_at,
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
            assessment:assessments(
              id,
              slug,
              hero_title,
              seo_title,
              assigned_doctor_ids
            )
          `)
          .or(`psychologist_id.eq.${psychologistId},and(psychologist_id.is.null,status.eq.pending)`);
        
        // Filter by status if provided (but don't filter if status is not provided)
        if (status) {
          assessQuery = assessQuery.eq('status', status);
        }
        
        // Filter by date if provided (but allow null dates for pending sessions)
        if (date) {
          assessQuery = assessQuery.or(`scheduled_date.eq.${date},scheduled_date.is.null`);
        }
        
        let { data: assessData, error: assessError } = await assessQuery.order('created_at', { ascending: false });
        
        if (assessError) {
          console.error('❌ Error fetching assessment sessions:', assessError);
        } else {
          console.log(`✅ Found ${assessData?.length || 0} assessment sessions for psychologist ${psychologistId}`);
          console.log('🔍 Assessment sessions details:', assessData?.map(a => ({
            id: a.id,
            status: a.status,
            psychologist_id: a.psychologist_id,
            scheduled_date: a.scheduled_date,
            scheduled_time: a.scheduled_time,
            assessment_id: a.assessment_id
          })) || []);
          
          // Backfill missing pending assessment sessions so each package has 3 total
          try {
            // Group by stable key (assessment_id + client_id + payment_id)
            // Note: psychologist_id is excluded from grouping since pending sessions have null psychologist_id
            const groups = new Map();
            (assessData || []).forEach(s => {
              const key = `${s.assessment_id}_${s.client_id}_${s.payment_id || 'nopay'}`;
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key).push(s);
            });

            for (const sessions of groups.values()) {
              const any = sessions[0];
              // Only consider booked packages (must have a booked session or a payment_id)
              const hasBooked = sessions.some(s => s.status === 'booked');
              if (!hasBooked) continue;

              const existingNumbers = new Set(sessions.map(s => s.session_number).filter(n => typeof n === 'number'));
              const inserts = [];
              // Ensure first session has session_number 1
              const first = sessions.find(s => s.status === 'booked');
              if (first && (first.session_number == null)) {
                await supabaseAdmin
                  .from('assessment_sessions')
                  .update({ session_number: 1, updated_at: new Date().toISOString() })
                  .eq('id', first.id);
                existingNumbers.add(1);
              }
              // Create missing 2 and 3 - unassigned (psychologist_id = null)
              // Any psychologist can schedule these sessions with any psychologist
              [2,3].forEach(n => {
                if (!existingNumbers.has(n)) {
                  inserts.push({
                    user_id: any.user_id,
                    client_id: any.client_id,
                    assessment_id: any.assessment_id,
                    assessment_slug: any.assessment_slug,
                    psychologist_id: null, // Unassigned - can be assigned to any psychologist when scheduled
                    scheduled_date: null,
                    scheduled_time: null,
                    amount: any.amount,
                    currency: any.currency || 'INR',
                    status: 'pending',
                    payment_id: any.payment_id,
                    session_number: n,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                  });
                }
              });

              if (inserts.length > 0) {
                const { error: insertErr } = await supabaseAdmin
                  .from('assessment_sessions')
                  .insert(inserts);
                if (insertErr) {
                  console.warn('⚠️ Failed to backfill pending assessment sessions:', insertErr);
                }
              }

              // Always fetch the full package (3 sessions) so we have up-to-date data
              let packageQuery = supabaseAdmin
                .from('assessment_sessions')
                .select(`
                  id,
                  assessment_id,
                  assessment_slug,
                  client_id,
                  psychologist_id,
                  scheduled_date,
                  scheduled_time,
                  status,
                  amount,
                  payment_id,
                  session_number,
                  created_at,
                  updated_at,
                  client:clients(
                    id,
                    first_name,
                    last_name,
                    child_name,
                    child_age,
                    phone_number,
                    user:users(email)
                  ),
                  assessment:assessments(
                    id,
                    slug,
                    hero_title,
                    seo_title,
                    assigned_doctor_ids
                  )
                `)
                .eq('assessment_id', any.assessment_id)
                .eq('client_id', any.client_id);

              if (any.payment_id) {
                packageQuery = packageQuery.eq('payment_id', any.payment_id);
              } else {
                packageQuery = packageQuery.is('payment_id', null);
              }

              const { data: fullPackage, error: fullPackageError } = await packageQuery.order('created_at', { ascending: false });
              if (fullPackageError) {
                console.warn('⚠️ Failed to fetch full assessment package:', fullPackageError);
                continue;
              }

              const normalizedFullPackage = fullPackage || [];
              const isSamePackage = (session) => {
                const paymentMatch = any.payment_id
                  ? session.payment_id === any.payment_id
                  : (session.payment_id === null || session.payment_id === undefined);
                return session.assessment_id === any.assessment_id &&
                       session.client_id === any.client_id &&
                       paymentMatch;
              };

              assessData = (assessData || []).filter(s => !isSamePackage(s)).concat(normalizedFullPackage);
            }
          } catch (bfErr) {
            console.warn('⚠️ Error during assessment sessions backfill:', bfErr);
          }

          // Transform assessment sessions to match session format
          assessmentSessions = (assessData || []).map(a => ({
            ...a,
            session_type: 'assessment',
            type: 'assessment',
            // Add client_name for frontend compatibility
            client_name: a.client ? `${a.client.first_name || ''} ${a.client.last_name || ''}`.trim() : 'Client',
            // Add assessment title
            assessment_title: a.assessment?.hero_title || a.assessment?.seo_title || 'Assessment'
          }));
          
          console.log('🔍 Transformed assessment sessions:', assessmentSessions.map(a => ({
            id: a.id,
            status: a.status,
            session_type: a.session_type,
            type: a.type,
            scheduled_date: a.scheduled_date
          })));
        }
      } catch (assessError) {
        console.error('❌ Assessment sessions fetch error:', assessError);
      }

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
    const finalReport = report || ''; // Report is optional

    // Validate required fields
    if (!finalSummary || finalSummary.trim().length === 0) {
      return res.status(400).json(
        errorResponse('Session summary is required')
      );
    }

    // Prepare update data
    const updateData = {
      status: status,
      session_summary: finalSummary.trim(),
      updated_at: new Date().toISOString()
    };

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

        // Send WhatsApp notification to client
        try {
          const { sendSessionCompletionNotification } = require('../utils/whatsappService');
          const clientPhone = client?.phone_number || null;
          
          console.log(`📱 WhatsApp sending attempt for session ${sessionId} (package: ${regularSession.package_id || 'none'})`);
          console.log(`📱 Client data:`, {
            hasClient: !!client,
            clientId: client?.id,
            phoneNumber: clientPhone ? `${String(clientPhone).substring(0, 3)}***` : 'NOT FOUND',
            sessionType: regularSession.session_type,
            isPackage: !!regularSession.package_id
          });
          
          if (clientPhone) {
            const psychologistName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'our specialist';
            const isFreeAssessment = regularSession.session_type === 'free_assessment';
            // Always use production URL in WhatsApp/email links (never localhost)
            const PRODUCTION_SITE_URL =
              process.env.SITE_URL || process.env.PUBLIC_APP_URL || 'https://www.koott.in';
            const bookingLink = `${PRODUCTION_SITE_URL}/psychologists`;
            const feedbackLink = isFreeAssessment 
              ? `${PRODUCTION_SITE_URL}/profile/sessions?tab=completed`
              : `${PRODUCTION_SITE_URL}/profile/reports`;

            const sessionTypeLabel = regularSession.package_id ? 'package session' : (isFreeAssessment ? 'free assessment' : 'therapy session');
            console.log(`📱 Attempting to send WhatsApp completion for ${sessionTypeLabel} (Session ID: ${sessionId}) to client: ${clientPhone.substring(0, 3)}***`);
            
            // Fetch package information if this is a package session
            let packageInfo = null;
            if (regularSession.package_id) {
              try {
                // Get package data
                const { data: packageData, error: packageError } = await supabaseAdmin
                  .from('packages')
                  .select('session_count')
                  .eq('id', regularSession.package_id)
                  .single();
                
                if (!packageError && packageData) {
                  // Get all sessions for this package and count completed ones
                  const { data: packageSessions, error: sessionsError } = await supabaseAdmin
                    .from('sessions')
                    .select('id, status')
                    .eq('package_id', regularSession.package_id);
                  
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
            console.warn(`⚠️ Skipping WhatsApp completion for session ${sessionId} (${regularSession.package_id ? 'package session' : 'regular session'}): Client phone number not found.`);
            console.warn(`⚠️ Session client data:`, client ? { id: client.id, hasPhone: !!client.phone_number } : 'No client data');
          }
        } catch (waError) {
          console.error(`❌ Error sending session completion WhatsApp for session ${sessionId}:`, waError);
          console.error(`❌ Error stack:`, waError.stack);
          // Don't fail the request if WhatsApp fails
        }
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

    // Get current month start and end dates (IST timezone)
    const now = dayjs().tz('Asia/Kolkata');
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

    // Get upcoming sessions for current month (booked/rescheduled sessions from today onwards)
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
  getClientSessionHistory
};
