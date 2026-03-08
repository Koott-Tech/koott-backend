const { supabaseAdmin } = require('../config/supabase');
const { deriveSessionCount, ensureClientPackageRecord } = require('../services/packageService');
const { 
  successResponse, 
  errorResponse,
  formatDate,
  formatTime,
  addMinutesToTime,
  maskPhoneNumber
} = require('../utils/helpers');
const availabilityService = require('../utils/availabilityCalendarService');
const meetLinkService = require('../utils/meetLinkService');
const userInteractionLogger = require('../utils/userInteractionLogger');
const { reserveAssessmentSlot, bookAssessment, getAssessmentSessions } = require('./assessmentBookingController');

// Get client profile
const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let client = null;
    let error = null;

    // New system: client has user_id reference to users table
    if (userRole === 'client' && req.user.user_id) {
      // User ID in token is from users table, client has user_id
      // This means client profile is already loaded in req.user from middleware
      client = req.user;
    } else if (userRole === 'client') {
      // Try new system: lookup by user_id
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: clientByUserId, error: errorByUserId } = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('user_id', req.user.user_id)
        .single();

      if (clientByUserId && !errorByUserId) {
        client = clientByUserId;
      } else {
        // Fallback to old system: lookup by id (backward compatibility)
        const { data: clientById, error: errorById } = await supabaseAdmin
          .from('clients')
          .select('*')
          .eq('id', userId)
          .single();

        if (clientById && !errorById) {
          client = clientById;
        } else {
          error = errorByUserId || errorById;
        }
      }
    } else {
      error = { message: 'User is not a client' };
    }

    if (error || !client) {
      console.error('Get client profile error:', error);
      return res.status(500).json(
        errorResponse('Failed to fetch client profile')
      );
    }

    // Merge with user data if available
    const userData = {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      profile_picture_url: req.user.profile_picture_url,
      google_id: req.user.google_id
    };

    res.json(
      successResponse({ ...userData, ...client })
    );

  } catch (error) {
    console.error('Get client profile error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching profile')
    );
  }
};

/**
 * Get a usable payment credit for the authenticated client by transaction ID.
 * Used when a payment succeeded but the original slot was taken by someone else.
 */
const getPaymentCredit = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json(
        errorResponse('Transaction ID is required')
      );
    }

    if (userRole !== 'client') {
      return res.status(403).json(
        errorResponse('Only clients can access payment credits')
      );
    }

    // Multi-strategy lookup: new system uses user_id, legacy uses id
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let client = null;
    let clientError = null;
    const { data: clientByUserId, error: errorByUserId } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .single();
    if (clientByUserId && !errorByUserId) {
      client = clientByUserId;
    } else {
      const { data: clientById, error: errorById } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('id', userId)
        .single();
      if (clientById && !errorById) {
        client = clientById;
      } else {
        clientError = errorByUserId || errorById;
      }
    }

    if (clientError || !client) {
      console.error('Client profile not found for credit lookup:', clientError);
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    const clientId = client.id;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('id, client_id, psychologist_id, amount, status, transaction_id, session_id, session_type, razorpay_payment_id')
      .eq('transaction_id', transactionId)
      .eq('client_id', clientId)
      .single();

    if (paymentError || !payment) {
      console.error('Payment credit not found:', paymentError);
      return res.status(404).json(
        errorResponse('Payment credit not found')
      );
    }

    // Treat as credit only if payment is still pending, has a Razorpay payment id and no session yet
    if (payment.status !== 'pending' || !payment.razorpay_payment_id || payment.session_id) {
      return res.status(400).json(
        errorResponse('This payment cannot be used as a session credit')
      );
    }

    return res.json(
      successResponse(
        {
          payment_id: payment.id,
          transaction_id: payment.transaction_id,
          psychologist_id: payment.psychologist_id,
          amount: payment.amount,
          session_type: payment.session_type || 'Individual Session',
          status: payment.status
        },
        'Payment credit fetched successfully'
      )
    );
  } catch (error) {
    console.error('Get payment credit error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching payment credit')
    );
  }
};

// Update client profile
const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    
    // HIGH-RISK FIX: Mass assignment protection - explicit allowlist
    const allowedFields = ['first_name', 'last_name', 'phone_number', 'child_name', 'child_age'];
    const updateData = {};
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    // Handle optional last_name - allow clearing it
    if (updateData.last_name !== undefined) {
      if (updateData.last_name === null || updateData.last_name === '' || updateData.last_name.trim() === '') {
        // User wants to clear it - set to empty string
        updateData.last_name = '';
      } else {
        // Trim whitespace if provided
        updateData.last_name = updateData.last_name.trim();
      }
    }
    // If last_name is not in updateData, preserve existing value (don't update it)

    // Handle optional child fields - allow clearing them
    // If child_name is explicitly set to empty string, try to use empty string (database may allow it)
    // If database has NOT NULL constraint and doesn't allow empty string, it will error and we can handle it
    if (updateData.child_name !== undefined) {
      if (updateData.child_name === null || updateData.child_name === '' || updateData.child_name.trim() === '') {
        // User wants to clear it - try empty string first, database will reject if NOT NULL doesn't allow it
        // In that case, we'll get an error and can handle it
        updateData.child_name = '';
      } else {
        // Trim whitespace if provided
        updateData.child_name = updateData.child_name.trim();
      }
    }
    // If child_name is not in updateData, preserve existing value (don't update it)
    
    // Handle optional child_age - allow clearing by setting to null or default; guard against non-numeric/NaN
    if (updateData.child_age !== undefined) {
      if (updateData.child_age === null || updateData.child_age === '' || updateData.child_age === 0) {
        // User wants to clear it - try null first, if database rejects it, use default value 1
        updateData.child_age = null;
      } else {
        const num = Number(updateData.child_age);
        if (!Number.isFinite(num) || num < 0) {
          return res.status(400).json(
            errorResponse('child_age must be a valid non-negative number')
          );
        }
        updateData.child_age = num;
      }
    }
    // If child_age is not in updateData, preserve existing value (don't update it)

    // Use supabaseAdmin to bypass RLS
    const { supabaseAdmin } = require('../config/supabase');

    let client = null;
    let error = null;
    let lastErrorDetails = null;

    if (userRole === 'client') {
      // Attempt updates using different identifiers
      // Priority: 1) user_id (new system), 2) client_id (if available), 3) id as fallback for old system
      const updateAttempts = [
        // New system: client has user_id that references users table
        { column: 'user_id', value: userId },
        // If client_id is available, use it
        req.user.client_id ? { column: 'id', value: req.user.client_id } : null,
        // Old system fallback: try by id (for backward compatibility with old clients)
        { column: 'id', value: userId }
      ].filter(Boolean);

      console.log('Update attempts:', updateAttempts);
      console.log('Update data:', updateData);

      for (const attempt of updateAttempts) {
        try {
          // First check if client exists
          const { data: existingClient, error: checkError } = await supabaseAdmin
            .from('clients')
            .select('*')
            .eq(attempt.column, attempt.value)
            .single();

          if (checkError && checkError.code !== 'PGRST116') {
            console.error(`Error checking client existence (${attempt.column}=${attempt.value}):`, checkError);
            lastErrorDetails = { attempt, error: checkError };
            continue;
          }

          if (!existingClient) {
            console.log(`Client not found with ${attempt.column}=${attempt.value}`);
            lastErrorDetails = { attempt, error: { message: 'Client not found' } };
            continue;
          }

          // Prepare update payload - child_name is already handled above if null/empty
          const updatePayload = {
              ...updateData,
              updated_at: new Date().toISOString()
          };

          // Now attempt the update
          let updatePayloadToUse = { ...updatePayload };
          
          // Handle special cases for child_age and child_name that might need fallback values
          let needsRetry = false;
          let retryPayload = null;
          
          // Check if we need to handle child_age null -> default fallback
          if (updatePayloadToUse.child_age === null && updatePayloadToUse.child_age !== undefined) {
            needsRetry = true;
            retryPayload = { ...updatePayloadToUse, child_age: 1 }; // Default fallback
          }
          
          // Check if we need to handle child_name empty -> default fallback
          if (updatePayloadToUse.child_name === '' && updatePayloadToUse.child_name !== undefined) {
            needsRetry = true;
            retryPayload = retryPayload || { ...updatePayloadToUse };
            retryPayload.child_name = 'Pending'; // Default fallback
          }
          
          if (needsRetry) {
            // Try with original values first
            let { data: updatedClient, error: updateError } = await supabaseAdmin
              .from('clients')
              .update(updatePayloadToUse)
            .eq(attempt.column, attempt.value)
            .select('*')
            .single();

            // If update fails due to NOT NULL constraint, try with default values
            if (updateError && updateError.code === '23502') {
              if (updateError.message?.includes('child_age')) {
                console.log('Null child_age rejected, using default value 1');
              }
              if (updateError.message?.includes('child_name')) {
                console.log('Empty child_name rejected, using default "Pending"');
              }
              
              const retryResult = await supabaseAdmin
                .from('clients')
                .update(retryPayload)
                .eq(attempt.column, attempt.value)
                .select('*')
                .single();
              updatedClient = retryResult.data;
              updateError = retryResult.error;
            }

          if (!updateError && updatedClient) {
            client = updatedClient;
            error = null;
              lastErrorDetails = null;
            break;
          }

          // Record the last error but continue trying other identifiers
          if (updateError) {
            error = updateError;
              lastErrorDetails = { attempt, error: updateError };
              console.error(`Update error (${attempt.column}=${attempt.value}):`, updateError);
            }
          } else {
            // Normal update path (no special handling needed for child fields)
            const { data: updatedClient, error: updateError } = await supabaseAdmin
              .from('clients')
              .update(updatePayloadToUse)
              .eq(attempt.column, attempt.value)
              .select('*')
              .single();

            if (!updateError && updatedClient) {
              client = updatedClient;
              error = null;
              lastErrorDetails = null;
              break;
            }

            // Record the last error but continue trying other identifiers
            if (updateError) {
              error = updateError;
              lastErrorDetails = { attempt, error: updateError };
              console.error(`Update error (${attempt.column}=${attempt.value}):`, updateError);
            }
          }
        } catch (attemptError) {
          error = attemptError;
          lastErrorDetails = { attempt, error: attemptError };
          console.error(`Exception during update attempt (${attempt.column}=${attempt.value}):`, attemptError);
        }
      }
    } else {
      error = { message: 'User is not a client' };
    }

    if (error || !client) {
      const errorMessage = error?.message || 'Unknown error';
      const errorCode = error?.code || 'UNKNOWN_ERROR';
      const errorDetails = lastErrorDetails 
        ? `Failed with ${lastErrorDetails.attempt?.column}=${lastErrorDetails.attempt?.value}: ${lastErrorDetails.error?.message || errorMessage}`
        : errorMessage;
      
      // Sanitize updateData to remove PII
      const sanitizeUpdateData = (data) => {
        if (!data || typeof data !== 'object') return {};
        const sanitized = {};
        const sensitiveKeys = ['first_name', 'last_name', 'phone_number', 'email', 'ssn', 'social_security_number'];
        Object.keys(data).forEach(key => {
          if (sensitiveKeys.includes(key)) {
            sanitized[key] = '[REDACTED]';
          } else {
            sanitized[key] = data[key];
          }
        });
        return sanitized;
      };
      
      const sanitizedUpdateData = sanitizeUpdateData(updateData);
      
      console.error('Update client profile error:', {
        error,
        errorCode,
        errorMessage,
        lastErrorDetails,
        userId,
        userRole,
        updateData: sanitizedUpdateData
      });
      
      return res.status(500).json(
        errorResponse(
          'Failed to update client profile',
          {
            message: errorMessage,
            code: errorCode,
            details: errorDetails
          }
        )
      );
    }

    res.json(
      successResponse(client, 'Profile updated successfully')
    );

  } catch (error) {
    console.error('Update client profile exception:', error);
    res.status(500).json(
      errorResponse(
        'Internal server error while updating profile',
        {
          message: error.message,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      )
    );
  }
};

// Get client sessions
const getSessions = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { page = 1, limit = 5, status } = req.query;

    // Determine client ID based on system (new or old)
    // For new system: req.user.id is users.id, use req.user.client_id (set by middleware)
    // For old system: req.user.id is already clients.id
    let clientId = req.user.client_id || userId;

    // Check if sessions table exists and has proper relationships
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    try {
      let query = supabaseAdmin
        .from('sessions')
        .select(`
          *,
          psychologist:psychologists(
            id,
            first_name,
            last_name,
            area_of_expertise,
            cover_image_url
          )
        `)
        .eq('client_id', clientId);

      // Handle "upcoming" and "pending" status specially (requires date/time filtering)
      const isUpcomingFilter = status === 'upcoming';
      const isPendingFilter = status === 'pending';
      
      if (status && !isUpcomingFilter && !isPendingFilter) {
        // Regular status filter
        query = query.eq('status', status);
      } else if (isUpcomingFilter) {
        // For upcoming: exclude completed/cancelled/no_show statuses
        query = query.not('status', 'in', '(completed,cancelled,no_show,noshow)');
        // Also filter by date: only sessions from today onwards
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        query = query.gte('scheduled_date', today);
      } else if (isPendingFilter) {
        // For pending: sessions that are expired but not marked as completed/cancelled/no_show
        // Include booked, scheduled, rescheduled, reschedule_requested statuses
        query = query.in('status', ['booked', 'scheduled', 'rescheduled', 'reschedule_requested']);
      }

      // Ordering: upcoming sessions by nearest first, others by most recent first
      if (isUpcomingFilter) {
        query = query.order('scheduled_date', { ascending: true })
                     .order('scheduled_time', { ascending: true });
      } else {
        query = query.order('scheduled_date', { ascending: false });
      }

      // For upcoming and pending, fetch a larger batch to filter properly, then paginate client-side
      // For regular queries, use standard pagination
      let sessions, upcomingTotalCount, sessionsCount = 0;
      if (isUpcomingFilter || isPendingFilter) {
        // Fetch larger batch for upcoming (configurable to avoid silent truncation)
        const fetchLimit = parseInt(process.env.SESSIONS_UPCOMING_FETCH_LIMIT, 10) || 500;
        const { data: allSessions, error } = await query.limit(fetchLimit);

        if (error) {
          throw error;
        }
        
        // Filter out expired sessions client-side (can't do complex time math in SQL easily)
        const dayjs = require('dayjs');
        const utc = require('dayjs/plugin/utc');
        const timezone = require('dayjs/plugin/timezone');
        dayjs.extend(utc);
        dayjs.extend(timezone);

        const now = dayjs().tz('Asia/Kolkata');
        const filteredSessions = (allSessions || []).filter(session => {
          if (!session.scheduled_date || !session.scheduled_time) {
            return false;
          }
          
          // Parse session end time (start + 50 minutes)
          const timeStr = session.scheduled_time || '00:00:00';
          const timeOnly = timeStr.split(' ')[0];
          const sessionDateTime = dayjs(`${session.scheduled_date}T${timeOnly}`, 'YYYY-MM-DDTHH:mm:ss').tz('Asia/Kolkata');
          const sessionEndDateTime = sessionDateTime.add(50, 'minute');
          
          if (isUpcomingFilter) {
            // For upcoming: only include if session hasn't ended yet
            return sessionEndDateTime.isAfter(now);
          } else if (isPendingFilter) {
            // For pending: only include if session has ended (expired) but not marked as completed
            return sessionEndDateTime.isBefore(now);
          }
          return false;
        });
        
        // Sort: upcoming by nearest first, pending by most recent first
        if (isUpcomingFilter) {
          filteredSessions.sort((a, b) => {
            const timeA = a.scheduled_time || '00:00:00';
            const timeOnlyA = timeA.split(' ')[0];
            const dateA = dayjs(`${a.scheduled_date}T${timeOnlyA}`, 'YYYY-MM-DDTHH:mm:ss').tz('Asia/Kolkata');
            
            const timeB = b.scheduled_time || '00:00:00';
            const timeOnlyB = timeB.split(' ')[0];
            const dateB = dayjs(`${b.scheduled_date}T${timeOnlyB}`, 'YYYY-MM-DDTHH:mm:ss').tz('Asia/Kolkata');
            
            return dateA - dateB;
          });
        } else if (isPendingFilter) {
          // Sort pending by most recent first (oldest expired sessions first)
          filteredSessions.sort((a, b) => {
            const timeA = a.scheduled_time || '00:00:00';
            const timeOnlyA = timeA.split(' ')[0];
            const dateA = dayjs(`${a.scheduled_date}T${timeOnlyA}`, 'YYYY-MM-DDTHH:mm:ss').tz('Asia/Kolkata');
            
            const timeB = b.scheduled_time || '00:00:00';
            const timeOnlyB = timeB.split(' ')[0];
            const dateB = dayjs(`${b.scheduled_date}T${timeOnlyB}`, 'YYYY-MM-DDTHH:mm:ss').tz('Asia/Kolkata');
            
            return dateB - dateA; // Most recent first
          });
        }
        
        // Store total count for pagination; detect potential truncation
        upcomingTotalCount = filteredSessions.length;
        if (allSessions && allSessions.length >= fetchLimit) {
          console.warn(`⚠️ Sessions upcoming/pending fetch may be truncated (fetched ${fetchLimit}, consider increasing SESSIONS_UPCOMING_FETCH_LIMIT)`);
        }

        // Apply pagination after filtering
        const offset = (page - 1) * limit;
        sessions = filteredSessions.slice(offset, offset + limit);
      } else {
        // Regular pagination for non-upcoming
        // First get total count for pagination
        const countQuery = supabaseAdmin
          .from('sessions')
          .select('*', { count: 'exact', head: true })
          .eq('client_id', clientId)
          .eq('status', status);
        const { count: totalSessionsCount } = await countQuery;
        sessionsCount = totalSessionsCount || 0;
        
        // Then get paginated results
        const offset = (page - 1) * limit;
        query = query.range(offset, offset + limit - 1);
        const { data: fetchedSessions, error } = await query;
        
        if (error) {
          throw error;
        }
        
        sessions = fetchedSessions || [];
        upcomingTotalCount = null; // Not applicable for non-upcoming
      }

      // Also fetch assessment sessions (run in parallel with package fetching for better performance)
      // Only fetch if status filter allows (to reduce unnecessary queries)
      let assessmentSessions = [];
      const shouldFetchAssessments = !status || ['upcoming', 'completed', 'cancelled', 'rescheduled', 'pending'].includes(status);
      
      if (shouldFetchAssessments) {
      try {
        let assessQuery = supabaseAdmin
          .from('assessment_sessions')
          .select(`
            id,
            assessment_id,
            assessment_slug,
            psychologist_id,
            scheduled_date,
            scheduled_time,
            status,
            amount,
            payment_id,
            created_at,
            assessment:assessments(
              id,
              slug,
              hero_title,
              seo_title
            ),
            psychologist:psychologists(
              id,
              first_name,
              last_name,
              area_of_expertise,
              cover_image_url
            )
          `)
          .eq('client_id', clientId);
        
          if (status && status !== 'upcoming') {
            // For non-upcoming, apply status filter directly
            assessQuery = assessQuery.eq('status', status);
          } else if (status === 'upcoming') {
            // For upcoming, exclude completed/cancelled
            assessQuery = assessQuery.not('status', 'in', '(completed,cancelled,no_show,noshow)');
            const today = new Date().toISOString().split('T')[0];
            assessQuery = assessQuery.gte('scheduled_date', today);
        }
        
        const { data: assessData } = await assessQuery.order('scheduled_date', { ascending: false });
        
          // For upcoming, filter out expired assessment sessions
          if (status === 'upcoming' && assessData) {
            const dayjs = require('dayjs');
            const utc = require('dayjs/plugin/utc');
            const timezone = require('dayjs/plugin/timezone');
            dayjs.extend(utc);
            dayjs.extend(timezone);
            const now = dayjs().tz('Asia/Kolkata');
            
            assessmentSessions = (assessData || []).filter(a => {
              if (!a.scheduled_date || !a.scheduled_time) return false;
              const timeStr = a.scheduled_time || '00:00:00';
              const timeOnly = timeStr.split(' ')[0];
              const sessionDateTime = dayjs(`${a.scheduled_date}T${timeOnly}`, 'YYYY-MM-DDTHH:mm:ss').tz('Asia/Kolkata');
              const sessionEndDateTime = sessionDateTime.add(50, 'minute');
              return sessionEndDateTime.isAfter(now);
            }).map(a => ({
              ...a,
              session_type: 'assessment',
              type: 'assessment'
            }));
          } else {
        // Transform assessment sessions to match session format
        assessmentSessions = (assessData || []).map(a => ({
          ...a,
          session_type: 'assessment',
          type: 'assessment'
        }));
          }
      } catch (assessError) {
        console.log('Assessment sessions fetch error (non-blocking):', assessError);
      }
      }

      // Fetch package information for sessions that have package_id (optimized batch query)
      const packageIds = [...new Set((sessions || []).map(s => s.package_id).filter(Boolean))];
      let packagesMap = {};
      
      if (packageIds.length > 0) {
          try {
          // Batch fetch all packages at once
          // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
          const { data: packagesData, error: packagesError } = await supabaseAdmin
              .from('packages')
              .select('id, package_type, price, description, session_count')
            .in('id', packageIds);
            
          if (!packagesError && packagesData) {
            // Create a map for quick lookup
            packagesMap = packagesData.reduce((acc, pkg) => {
              acc[pkg.id] = pkg;
              return acc;
            }, {});
            
            // Batch count completed sessions for all packages at once
            // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
            const { data: allPackageSessions, error: sessionsError } = await supabaseAdmin
                .from('sessions')
              .select('package_id, status')
              .in('package_id', packageIds)
                .eq('client_id', clientId);
              
            if (!sessionsError && allPackageSessions) {
              // Count ONLY completed sessions per package (exclude booked/scheduled/etc)
              // This ensures the count only reflects truly completed sessions, not booked ones
              const completedCounts = allPackageSessions.reduce((acc, s) => {
                // STRICTLY only count sessions with status === 'completed'
                // Do not count 'booked', 'scheduled', 'rescheduled', or any other status
                if (s.status === 'completed' && s.package_id) {
                  acc[s.package_id] = (acc[s.package_id] || 0) + 1;
                }
                return acc;
              }, {});
              
              // Add progress info to each package
              Object.keys(packagesMap).forEach(pkgId => {
                const pkg = packagesMap[pkgId];
                const totalSessions = pkg.session_count || 0;
                const completedSessions = completedCounts[pkgId] || 0;
                pkg.completed_sessions = completedSessions;
                pkg.total_sessions = totalSessions;
                pkg.remaining_sessions = Math.max(totalSessions - completedSessions, 0);
                
                // Debug log for package progress
                if (process.env.NODE_ENV !== 'production') {
                  console.log(`📦 Package ${pkgId} progress: ${completedSessions}/${totalSessions} completed, ${pkg.remaining_sessions} remaining`);
                }
              });
            } else if (sessionsError) {
              console.error('❌ Error fetching package sessions for progress:', sessionsError);
              // Set default values if fetch fails
              Object.keys(packagesMap).forEach(pkgId => {
                const pkg = packagesMap[pkgId];
                const totalSessions = pkg.session_count || 0;
                pkg.completed_sessions = 0;
                pkg.total_sessions = totalSessions;
                pkg.remaining_sessions = totalSessions;
              });
            }
            }
          } catch (err) {
          console.log('Error fetching packages:', err);
        }
      }
      
      // Attach package data to sessions
      const sessionsWithPackages = (sessions || []).map(session => {
        if (session.package_id && packagesMap[session.package_id]) {
          session.package = packagesMap[session.package_id];
        }
        return session;
      });

      // Combine regular sessions and assessment sessions
      // Only sort by date descending for non-upcoming (upcoming already sorted by nearest)
      let allSessions = [...(sessionsWithPackages || []), ...assessmentSessions];
      if (!isUpcomingFilter) {
        allSessions = allSessions.sort((a, b) => new Date(b.scheduled_date) - new Date(a.scheduled_date));
      }

      // Calculate total count for pagination
      // Assessment sessions are already filtered for upcoming, so just use length
      // For non-upcoming, get assessment count separately
      let assessmentCount = 0;
      if (!isUpcomingFilter && status && shouldFetchAssessments) {
        try {
          const { count: assessCount } = await supabaseAdmin
            .from('assessment_sessions')
            .select('*', { count: 'exact', head: true })
            .eq('client_id', clientId)
            .eq('status', status);
          assessmentCount = assessCount || 0;
        } catch (countError) {
          // If count query fails, use length of fetched assessment sessions as fallback
          assessmentCount = assessmentSessions.length;
        }
      } else {
        assessmentCount = assessmentSessions.length;
      }
      
      const totalCount = isUpcomingFilter 
        ? (upcomingTotalCount || 0) + assessmentSessions.length
        : (sessionsCount + assessmentCount);

      res.json(
        successResponse({
          sessions: allSessions,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: totalCount
          }
        })
      );

    } catch (dbError) {
      // If there's any database error, return empty sessions for new clients
      console.log('Database error in sessions query, returning empty sessions for new client:', dbError.message);
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
    console.error('Get client sessions error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching sessions')
    );
  }
};

// Book a new session
const bookSession = async (req, res) => {
  try {
    console.log('🚀 Starting session booking process...');
    const { psychologist_id, package_id, scheduled_date, scheduled_time, price } = req.body;

    // Validate required fields
    if (!psychologist_id || !scheduled_date || !scheduled_time) {
      // Log booking failure
      await userInteractionLogger.logBooking({
        userId: req.user.id,
        userRole: req.user.role,
        psychologistId: psychologist_id,
        packageId: package_id,
        scheduledDate: scheduled_date,
        scheduledTime: scheduled_time,
        price,
        status: 'failure',
        error: new Error('Missing required fields')
      });
      
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

    // Get client profile: try user_id first (new system), then id (legacy)
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let client = null;
    let clientError = null;
    const { data: clientByUserId, error: errorByUserId } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .single();
    if (clientByUserId && !errorByUserId) {
      client = clientByUserId;
    } else {
      const { data: clientById, error: errorById } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('id', userId)
        .single();
      if (clientById && !errorById) {
        client = clientById;
      } else {
        clientError = errorByUserId || errorById;
      }
    }

    if (clientError || !client) {
      console.error('Client profile not found:', clientError);
      return res.status(404).json(
        errorResponse('Client profile not found. Please complete your profile first.')
      );
    }

    const clientId = client.id;

    console.log('🔍 Step 1: Client validation');
    console.log('   - Client ID:', clientId);
    console.log('   - User ID:', userId);
    console.log('   - User Role:', userRole);

    // Step 2: Package validation
    console.log('🔍 Step 2: Package validation');
    console.log('📦 Package ID provided:', package_id);
    console.log('📦 Package ID type:', typeof package_id);
    console.log('📦 Package ID truthiness:', !!package_id);

    let packageData = null;

    // Only validate package if package_id is provided and not null/undefined (and not individual)
    if (package_id && package_id !== 'null' && package_id !== 'undefined' && package_id !== 'individual') {
      console.log('📦 Validating package...');
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: packageDataResult, error: packageError } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('id', package_id)
        .eq('psychologist_id', psychologist_id)
        .single();

      console.log('📦 Package lookup result:', packageDataResult);
      console.log('📦 Package lookup error:', packageError);

      if (!packageDataResult) {
        console.log('❌ Package validation failed');
        return res.status(400).json(
          errorResponse('Package not found or does not belong to this psychologist')
        );
      }

      packageData = packageDataResult;
      console.log('✅ Package validation passed');
    } else {
      console.log('📦 No package validation needed (package_id not provided)');
    }

    // Step 3: Check if the time slot is available using availability service
    console.log('🔍 Step 3: Checking time slot availability...');
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

    // Step 4: Get client and psychologist details for Google Calendar
    console.log('🔍 Step 4: Fetching user details for Google Calendar...');
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: clientDetails, error: clientDetailsError } = await supabaseAdmin
      .from('clients')
      .select(`
        first_name, 
        last_name, 
        child_name,
        phone_number,
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

    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: psychologistDetails, error: psychologistDetailsError } = await supabaseAdmin
      .from('psychologists')
      .select('first_name, last_name, email, phone')
      .eq('id', psychologist_id)
      .single();

    if (psychologistDetailsError || !psychologistDetails) {
      console.error('Error fetching psychologist details:', psychologistDetailsError);
      return res.status(500).json(
        errorResponse('Failed to fetch psychologist details')
      );
    }

    console.log('✅ User details fetched successfully');

    // Step 5: Create Google Calendar event with OAuth2 Meet service
    console.log('🔍 Step 5: Creating Google Calendar event...');
    let meetData = null;
    try {
      const sessionData = {
        summary: `Therapy Session - ${clientDetails?.child_name || 'Client'} with ${psychologistDetails?.first_name || 'Psychologist'}`,
        description: `Therapy session between ${clientDetails?.child_name || 'Client'} and ${psychologistDetails?.first_name || 'Psychologist'}`,
        startDate: scheduled_date,
        startTime: scheduled_time,
        endTime: addMinutesToTime(scheduled_time, 50) // 50-minute session
      };

      const meetResult = await meetLinkService.generateSessionMeetLink(sessionData);
      
      if (meetResult.success) {
        meetData = {
          meetLink: meetResult.meetLink,
          eventId: meetResult.eventId,
          calendarLink: meetResult.eventLink || null,
          method: meetResult.method
        };
        console.log('✅ Real Meet link created successfully:', meetResult);
      } else {
        meetData = {
          meetLink: meetResult.meetLink, // Fallback link
          eventId: null,
          calendarLink: null,
          method: 'fallback'
        };
        console.log('⚠️ Using fallback Meet link:', meetResult.meetLink);
      }
    } catch (meetError) {
      console.error('❌ Meet link creation failed:', meetError);
      // Continue without Meet link if it fails
      meetData = {
        meetLink: 'https://meet.google.com/new?hs=122&authuser=0',
        eventId: null,
        calendarLink: null,
        method: 'error'
      };
    }

    // Step 6: Create session record
    console.log('🔍 Step 6: Creating session record...');
    const sessionData = {
      client_id: clientId,
      psychologist_id,
      scheduled_date: formatDate(scheduled_date),
      scheduled_time: formatTime(scheduled_time),
      status: 'booked',
      google_calendar_event_id: meetData.eventId,
      google_meet_link: meetData.meetLink,
      google_calendar_link: meetData.calendarLink,
      price: price || (packageData?.price || 100), // Default to $100 for individual sessions
      original_scheduled_date: formatDate(scheduled_date)
    };

    // Only add package_id if it's provided and valid (not individual)
    if (package_id && package_id !== 'null' && package_id !== 'undefined' && package_id !== 'individual') {
      sessionData.package_id = package_id;
    }

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (sessionError) {
      console.error('❌ Session creation failed:', sessionError);
      
      // Log booking failure
      await userInteractionLogger.logBooking({
        userId,
        userRole,
        psychologistId: psychologist_id,
        packageId: package_id,
        scheduledDate: scheduled_date,
        scheduledTime: scheduled_time,
        price,
        status: 'failure',
        error: sessionError
      });
      
      // Check if it's a unique constraint violation (double booking)
      if (sessionError.code === '23505' || 
          sessionError.message?.includes('unique') || 
          sessionError.message?.includes('duplicate')) {
        console.log('⚠️ Double booking detected - slot was just booked by another user');
        return res.status(409).json(
          errorResponse('This time slot was just booked by another user. Please select another time.')
        );
      }
      
      return res.status(500).json(
        errorResponse('Failed to create session')
      );
    }

    console.log('✅ Session record created successfully');
    console.log('   - Session ID:', session.id);
    console.log('   - Status:', session.status);
    console.log('   - Price:', session.price);

    // Block the booked slot from availability using the availability service
    try {
      const availabilityService = require('../utils/availabilityCalendarService');
      await availabilityService.updateAvailabilityOnBooking(
        psychologist_id,
        session.scheduled_date,
        session.scheduled_time
      );
      console.log('✅ Availability updated to block booked slot');
    } catch (blockErr) {
      console.warn('⚠️ Failed to update availability after booking:', blockErr?.message);
    }

    // Step 7: If this is a package purchase, create client package record
    if (packageData && packageData.session_count > 1 && packageData.id !== 'individual') {
      console.log('🔍 Step 7: Creating client package record...');
      console.log('📦 Package details:', packageData);
      
      try {
        const clientPackageData = {
          client_id: clientId,
          psychologist_id,
          package_id: packageData.id,
          package_type: packageData.package_type,
          total_sessions: packageData.session_count,
          remaining_sessions: packageData.session_count - 1, // First session already booked
          total_amount: packageData.price,
          amount_paid: packageData.price,
          status: 'active',
          purchased_at: new Date().toISOString(),
          first_session_id: session.id
        };

        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { error: clientPackageError } = await supabaseAdmin
          .from('client_packages')
          .insert([clientPackageData]);

        if (clientPackageError) {
          console.error('❌ Client package creation failed:', clientPackageError);
          // Continue even if client package creation fails
        } else {
          console.log('✅ Client package record created successfully');
          console.log('   - Remaining sessions:', packageData.session_count - 1);
        }
      } catch (packageError) {
        console.error('❌ Exception while creating client package:', packageError);
        // Continue even if client package creation fails
      }
    }

    // Step 8: Send email + WhatsApp notifications
    console.log('🔍 Step 8: Sending email notifications...');
    try {
      const emailService = require('../utils/emailService');
      
      const clientName = clientDetails.child_name || 
                        `${clientDetails.first_name} ${clientDetails.last_name}`.trim();
      const psychologistName = `${psychologistDetails.first_name} ${psychologistDetails.last_name}`.trim();

      await emailService.sendSessionConfirmation({
        clientEmail: clientDetails.user?.email || 'client@placeholder.com',
        psychologistEmail: psychologistDetails?.email || 'psychologist@placeholder.com',
        clientName,
        psychologistName,
        sessionId: session.id,
        scheduledDate: scheduled_date,
        scheduledTime: scheduled_time,
        meetLink: meetData.meetLink,
        price: session.price
      });

      console.log('✅ Email notifications sent successfully');

      // WhatsApp notifications via Business API (best-effort, non-blocking)
      try {
        console.log('📱 Sending WhatsApp notifications via UltraMsg API...');
        const { sendBookingConfirmation, sendWhatsAppTextWithRetry } = require('../utils/whatsappService');
        
        // Send WhatsApp to client
        const clientPhone = clientDetails.phone_number || null;
        if (clientPhone && meetData?.meetLink) {
          // Only include childName if child_name exists and is not empty/null/'Pending'
          const childName = clientDetails.child_name && 
            clientDetails.child_name.trim() !== '' && 
            clientDetails.child_name.toLowerCase() !== 'pending'
            ? clientDetails.child_name 
            : null;
          
          const clientDetails_wa = {
            childName: childName,
            date: scheduled_date,
            time: scheduled_time,
            meetLink: meetData.meetLink,
            psychologistName: psychologistName, // Add psychologist name to WhatsApp message
          };
          const clientWaResult = await sendBookingConfirmation(clientPhone, clientDetails_wa);
          if (clientWaResult?.success) {
            console.log('✅ WhatsApp confirmation sent to client via UltraMsg');
            
            // Log WhatsApp success
            const maskedClientPhone = maskPhoneNumber(clientPhone);
            await userInteractionLogger.logInteraction({
              userId,
              userRole,
              action: 'whatsapp_client_booking',
              status: 'success',
              details: {
                sessionId: session.id,
                maskedClientPhone: maskedClientPhone,
                messageId: clientWaResult.data?.msgId
              }
            });
          } else if (clientWaResult?.skipped) {
            const skipReason = clientWaResult.reason || 'Unknown reason';
            console.log('ℹ️ Client WhatsApp skipped:', skipReason);
            
            // Log WhatsApp skip with reason
            const maskedClientPhone = maskPhoneNumber(clientPhone);
            await userInteractionLogger.logInteraction({
              userId,
              userRole,
              action: 'whatsapp_client_booking',
              status: 'skipped',
              details: {
                sessionId: session.id,
                maskedClientPhone: maskedClientPhone,
                skipReason: skipReason
              }
            });
          } else {
            const failureReason = clientWaResult?.error?.message || 
                                 clientWaResult?.error || 
                                 clientWaResult?.reason || 
                                 'Unknown WhatsApp API error';
            console.warn('⚠️ Client WhatsApp send failed:', failureReason);
            
            // Log WhatsApp failure with detailed reason
            const maskedClientPhone = maskPhoneNumber(clientPhone);
            await userInteractionLogger.logInteraction({
              userId,
              userRole,
              action: 'whatsapp_client_booking',
              status: 'failure',
              details: {
                sessionId: session.id,
                maskedClientPhone: maskedClientPhone,
                failureReason: failureReason,
                errorDetails: clientWaResult?.error || clientWaResult
              },
              error: clientWaResult?.error || new Error(failureReason)
            });
          }
        } else {
          const skipReason = !clientPhone ? 'No client phone number' : 'No Google Meet link available';
          console.log('ℹ️ No client phone or meet link; skipping client WhatsApp');
          
          // Log WhatsApp skip with reason
          const maskedClientPhone = maskPhoneNumber(clientPhone);
          await userInteractionLogger.logInteraction({
            userId,
            userRole,
            action: 'whatsapp_client_booking',
            status: 'skipped',
            details: {
              sessionId: session.id,
              maskedClientPhone: maskedClientPhone,
              hasMeetLink: !!meetData?.meetLink,
              skipReason: skipReason
            }
          });
        }

        // Send WhatsApp to psychologist (single detailed message)
        const psychologistPhone = psychologistDetails.phone || null;
        if (psychologistPhone && meetData?.meetLink) {
          // Format date and time using the same functions as client messages
          const { formatFriendlyTime } = require('../utils/whatsappService');
          const formatBookingDateShort = (dateStr) => {
            if (!dateStr) return '';
            try {
              const d = new Date(`${dateStr}T00:00:00+05:30`);
              return d.toLocaleDateString('en-IN', {
                weekday: 'short',
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                timeZone: 'Asia/Kolkata'
              });
            } catch {
              return dateStr;
            }
          };
          
          const bullet = '•⁠  ⁠';
          const formattedDate = formatBookingDateShort(scheduled_date);
          const formattedTime = formatFriendlyTime(scheduled_time);
          const supportPhone = process.env.SUPPORT_PHONE || process.env.COMPANY_PHONE || '+91 95390 07766';
          
          const psychologistMessage =
            `Hey 👋\n\n` +
            `New session booked with Little Care.\n\n` +
            `${bullet}Client: ${clientName}\n` +
            `${bullet}Date: ${formattedDate}\n` +
            `${bullet}Time: ${formattedTime} (IST)\n\n` +
            `Join link:\n${meetData.meetLink}\n\n` +
            `Please be ready 5 mins early.\n\n` +
            `For help: ${supportPhone}\n\n` +
            `— Little Care 💜`;
          
          const psychologistWaResult = await sendWhatsAppTextWithRetry(psychologistPhone, psychologistMessage);
          if (psychologistWaResult?.success) {
            console.log('✅ WhatsApp notification sent to psychologist via WhatsApp API');
            
            const maskedPsychologistPhone = maskPhoneNumber(psychologistPhone);
            // Log WhatsApp success
            await userInteractionLogger.logInteraction({
              userId,
              userRole,
              action: 'whatsapp_psychologist_booking',
              status: 'success',
              details: {
                sessionId: session.id,
                psychologistPhone: maskedPsychologistPhone,
                psychologistId: psychologist_id,
                messageId: psychologistWaResult.data?.msgId
              }
            });
          } else if (psychologistWaResult?.skipped) {
            const skipReason = psychologistWaResult.reason || 'Unknown reason';
            console.log('ℹ️ Psychologist WhatsApp skipped:', skipReason);
            
            const maskedPsychologistPhone = maskPhoneNumber(psychologistPhone);
            // Log WhatsApp skip with reason
            await userInteractionLogger.logInteraction({
              userId,
              userRole,
              action: 'whatsapp_psychologist_booking',
              status: 'skipped',
              details: {
                sessionId: session.id,
                psychologistPhone: maskedPsychologistPhone,
                psychologistId: psychologist_id,
                skipReason: skipReason
              }
            });
          } else {
            const failureReason = psychologistWaResult?.error?.message || 
                                 psychologistWaResult?.error || 
                                 psychologistWaResult?.reason || 
                                 'Unknown WhatsApp API error';
            console.warn('⚠️ Psychologist WhatsApp send failed:', failureReason);
            
            const maskedPsychologistPhone = maskPhoneNumber(psychologistPhone);
            // Log WhatsApp failure with detailed reason
            await userInteractionLogger.logInteraction({
              userId,
              userRole,
              action: 'whatsapp_psychologist_booking',
              status: 'failure',
              details: {
                sessionId: session.id,
                psychologistPhone: maskedPsychologistPhone,
                psychologistId: psychologist_id,
                failureReason: failureReason,
                errorDetails: psychologistWaResult?.error || psychologistWaResult
              },
              error: psychologistWaResult?.error || new Error(failureReason)
            });
          }
        } else {
          const skipReason = !psychologistPhone ? 'No psychologist phone number' : 'No Google Meet link available';
          console.log('ℹ️ No psychologist phone or meet link; skipping psychologist WhatsApp');
          
          const maskedPsychologistPhone = psychologistPhone ? maskPhoneNumber(psychologistPhone) : null;
          // Log WhatsApp skip with reason
          await userInteractionLogger.logInteraction({
            userId,
            userRole,
            action: 'whatsapp_psychologist_booking',
            status: 'skipped',
            details: {
              sessionId: session.id,
              psychologistPhone: maskedPsychologistPhone,
              psychologistId: psychologist_id,
              hasMeetLink: !!meetData?.meetLink,
              skipReason: skipReason
            }
          });
        }
      } catch (waError) {
        const failureReason = waError?.message || 
                             waError?.response?.data?.message || 
                             waError?.code || 
                             'Unknown WhatsApp service error';
        console.error('❌ WhatsApp notification error:', failureReason);
        console.error('   Full error:', waError);
        
        // Log WhatsApp failure with detailed reason
        await userInteractionLogger.logInteraction({
          userId,
          userRole,
          action: 'whatsapp_notifications',
          status: 'failure',
          details: {
            sessionId: session.id,
            failureReason: failureReason,
            errorCode: waError?.code,
            errorResponse: waError?.response?.data,
            fullError: waError
          },
          error: waError
        });
      }
    } catch (emailError) {
      const failureReason = emailError?.message || 
                           emailError?.response?.data?.message || 
                           emailError?.code || 
                           'Unknown email service error';
      console.error('❌ Error sending email notifications:', failureReason);
      console.error('   Full error:', emailError);
      
      // Log email sending failure with detailed reason
      await userInteractionLogger.logInteraction({
        userId,
        userRole,
        action: 'email_confirmation',
        status: 'failure',
        details: {
          sessionId: session.id,
          clientEmail: clientDetails?.user?.email || clientDetails?.email,
          psychologistEmail: psychologistDetails?.email,
          failureReason: failureReason,
          errorCode: emailError?.code,
          errorResponse: emailError?.response?.data,
          smtpError: emailError?.smtpError,
          fullError: emailError
        },
        error: emailError
      });
      // Continue even if email fails
    }

    console.log('✅ Session booking completed successfully with Meet link and email notifications');
    
    // Log successful booking
    await userInteractionLogger.logBooking({
      userId,
      userRole,
      psychologistId: psychologist_id,
      packageId: package_id,
      scheduledDate: scheduled_date,
      scheduledTime: scheduled_time,
      price: session.price,
      status: 'success',
      sessionId: session.id
    });
    
    res.status(201).json(
      successResponse({
        session,
        meetLink: meetData.meetLink,
        calendarLink: meetData.calendarLink,
        package: packageData && packageData.id !== 'individual' ? {
          type: packageData.package_type,
          remaining_sessions: packageData.session_count - 1,
          total_amount: packageData.price
        } : null
      }, 'Session booked successfully')
    );

    // PRIORITY: Check and send reminder immediately if session is 2 hours away
    // This gives new bookings priority over batch reminder processing
    try {
      const sessionReminderService = require('../services/sessionReminderService');
      // Run asynchronously to not block the response
      sessionReminderService.checkAndSendReminderForSessionId(session.id).catch(err => {
        console.error('❌ Error in priority reminder check:', err);
        // Don't block response - reminder will be sent in next hourly check
      });
    } catch (reminderError) {
      console.error('❌ Error initiating priority reminder check:', reminderError);
      // Don't block response
    }

  } catch (error) {
    console.error('❌ Session booking error:', error);
    
    // Log booking failure
    await userInteractionLogger.logBooking({
      userId: req.user?.id,
      userRole: req.user?.role,
      psychologistId: req.body?.psychologist_id,
      packageId: req.body?.package_id,
      scheduledDate: req.body?.scheduled_date,
      scheduledTime: req.body?.scheduled_time,
      price: req.body?.price,
      status: 'failure',
      error
    });
    
    res.status(500).json(
      errorResponse('Internal server error while booking session')
    );
  }
};

// Cancel a session
const cancelSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId } = req.params;

    // Get client ID
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('id', userId)
      .single();

    if (!client) {
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    // Check if session exists and belongs to client
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('client_id', client.id)
      .single();

    if (!session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // Check if session can be cancelled
    if (session.status !== 'booked') {
      return res.status(400).json(
        errorResponse('Only booked sessions can be cancelled')
      );
    }

    // Check if session is in the future
    const sessionDate = new Date(session.scheduled_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (sessionDate <= today) {
      return res.status(400).json(
        errorResponse('Cannot cancel sessions on or before today')
      );
    }

    // Get client and psychologist details for notifications
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: clientDetails } = await supabaseAdmin
      .from('clients')
      .select('first_name, last_name, child_name, phone_number, email')
      .eq('id', client.id)
      .single();

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologistDetails } = await supabaseAdmin
      .from('psychologists')
      .select('first_name, last_name, phone, email')
      .eq('id', session.psychologist_id)
      .single();

    // Update session status
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: updatedSession, error } = await supabaseAdmin
      .from('sessions')
      .update({
        status: 'canceled',
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .select('*')
      .single();

    if (error) {
      console.error('Cancel session error:', error);
      return res.status(500).json(
        errorResponse('Failed to cancel session')
      );
    }

    // Send email notifications for cancellation
    try {
      console.log('📧 Sending cancellation email notifications...');
      const emailService = require('../utils/emailService');
      
      const clientName = clientDetails?.child_name || `${clientDetails?.first_name || ''} ${clientDetails?.last_name || ''}`.trim();
      const psychologistName = `${psychologistDetails?.first_name || ''} ${psychologistDetails?.last_name || ''}`.trim();
      const sessionDateTime = new Date(`${session.scheduled_date}T${session.scheduled_time}`).toLocaleString('en-IN', { 
        timeZone: 'Asia/Kolkata',
        dateStyle: 'long',
        timeStyle: 'short'
      });

      // Send cancellation email to client
      if (clientDetails?.email) {
        await emailService.sendCancellationNotification({
          to: clientDetails.email,
          clientName,
          psychologistName,
          sessionDate: session.scheduled_date,
          sessionTime: session.scheduled_time,
          sessionId: session.id
        });
      }

      // Send cancellation email to psychologist
      if (psychologistDetails?.email) {
        await emailService.sendCancellationNotification({
          to: psychologistDetails.email,
          clientName,
          psychologistName,
          sessionDate: session.scheduled_date,
          sessionTime: session.scheduled_time,
          sessionId: session.id,
          isPsychologist: true
        });
      }

      console.log('✅ Cancellation emails sent successfully');
    } catch (emailError) {
      console.error('❌ Error sending cancellation emails:', emailError);
      // Continue even if email fails
    }

    // Send WhatsApp notifications for cancellation
    try {
      console.log('📱 Sending WhatsApp notifications for cancellation...');
      const { sendWhatsAppTextWithRetry } = require('../utils/whatsappService');
      
      const clientName = clientDetails?.child_name || `${clientDetails?.first_name || ''} ${clientDetails?.last_name || ''}`.trim();
      const psychologistName = `${psychologistDetails?.first_name || ''} ${psychologistDetails?.last_name || ''}`.trim();
      const sessionDateTime = new Date(`${session.scheduled_date}T${session.scheduled_time}`).toLocaleString('en-IN', { 
        timeZone: 'Asia/Kolkata',
        dateStyle: 'long',
        timeStyle: 'short'
      });

      // Send WhatsApp to client
      if (clientDetails?.phone_number) {
        const clientMessage = `❌ Your therapy session has been cancelled.\n\n` +
          `📅 Date: ${sessionDateTime}\n` +
          `👤 Psychologist: Dr. ${psychologistName}\n\n` +
          `If you need to reschedule, please book a new session. Thank you!`;

        const clientResult = await sendWhatsAppTextWithRetry(clientDetails.phone_number, clientMessage);
        if (clientResult?.success) {
          console.log('✅ Cancellation WhatsApp sent to client');
        } else {
          console.warn('⚠️ Failed to send cancellation WhatsApp to client');
        }
      }

      // Send WhatsApp to psychologist
      if (psychologistDetails?.phone) {
        const bullet = '•⁠  ⁠';
        const psychologistMessage =
          `Hey 👋\n\n` +
          `Session cancelled with Little Care.\n\n` +
          `${bullet}Client: ${clientName}\n` +
          `${bullet}Date: ${sessionDateTime}\n\n` +
          `— Little Care 💜`;

        const psychologistResult = await sendWhatsAppTextWithRetry(psychologistDetails.phone, psychologistMessage);
        if (psychologistResult?.success) {
          console.log('✅ Cancellation WhatsApp sent to psychologist');
        } else {
          console.warn('⚠️ Failed to send cancellation WhatsApp to psychologist');
        }
      }
      
      console.log('✅ WhatsApp notifications sent for cancellation');
    } catch (waError) {
      console.error('❌ Error sending cancellation WhatsApp:', waError);
      // Continue even if WhatsApp fails
    }

    res.json(
      successResponse(updatedSession, 'Session cancelled successfully')
    );

  } catch (error) {
    console.error('Cancel session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while cancelling session')
    );
  }
};

// Request reschedule for a session
const requestReschedule = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId } = req.params;

    // Get client ID
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('id', userId)
      .single();

    if (!client) {
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    // Check if session exists and belongs to client
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('client_id', client.id)
      .single();

    if (sessionError || !session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // Check if session can be rescheduled (allow both booked and rescheduled sessions)
    if (!['booked', 'rescheduled'].includes(session.status)) {
      return res.status(400).json(
        errorResponse('Only booked or rescheduled sessions can be rescheduled')
      );
    }

    // For now, just change the status to indicate reschedule request
    // TODO: Add reschedule_request field to database schema
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({
        status: 'reschedule_requested',
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .select('*')
      .single();

    if (updateError) {
      console.error('Update session status error:', updateError);
      
      // Log reschedule failure
      await userInteractionLogger.logReschedule({
        userId,
        userRole: req.user.role,
        sessionId,
        oldDate: session.scheduled_date,
        oldTime: session.scheduled_time,
        newDate: null,
        newTime: null,
        status: 'failure',
        error: updateError
      });
      
      return res.status(500).json(
        errorResponse('Failed to create reschedule request')
      );
    }

    // Log reschedule request
    await userInteractionLogger.logReschedule({
      userId,
      userRole: req.user.role,
      sessionId,
      oldDate: session.scheduled_date,
      oldTime: session.scheduled_time,
      newDate: null,
      newTime: null,
      status: 'success'
    });

    res.json(
      successResponse(updatedSession, 'Reschedule request sent successfully')
    );

  } catch (error) {
    console.error('Request reschedule error:', error);
    res.status(500).json(
      errorResponse('Internal server error while requesting reschedule')
    );
  }
};

// Get available psychologists
const getAvailablePsychologists = async (req, res) => {
  try {
    const { expertise, date } = req.query;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let query = supabaseAdmin
      .from('psychologists')
      .select(`
        id,
        first_name,
        last_name,
        area_of_expertise,
        description,
        experience_years,
        cover_image_url,
        packages(id, package_type, price, description)
      `);

    // Filter by expertise if provided
    if (expertise) {
      query = query.contains('area_of_expertise', [expertise]);
    }

    const { data: psychologists, error } = await query;

    if (error) {
      console.error('Get psychologists error:', error);
      return res.status(500).json(
        errorResponse('Failed to fetch psychologists')
      );
    }

    // Filter by availability if date is provided
    if (date) {
      const availablePsychologists = [];
      
      for (const psychologist of psychologists) {
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { data: availability } = await supabaseAdmin
          .from('availability')
          .select('time_slots')
          .eq('psychologist_id', psychologist.id)
          .eq('date', date)
          .eq('is_available', true)
          .single();

        if (availability && availability.time_slots.length > 0) {
          psychologist.available_slots = availability.time_slots;
          availablePsychologists.push(psychologist);
        }
      }

      res.json(
        successResponse(availablePsychologists)
      );
    } else {
      res.json(
        successResponse(psychologists)
      );
    }

  } catch (error) {
    console.error('Get psychologists error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching psychologists')
    );
  }
};

// Reschedule session with new date/time selection
const rescheduleSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { new_date, new_time, psychologist_id } = req.body;
    const userId = req.user.id;

    console.log('🔄 Starting session reschedule process');
    console.log('   - Session ID:', sessionId);
    console.log('   - New Date:', new_date);
    console.log('   - New Time:', new_time);
    console.log('   - Psychologist ID:', psychologist_id);

    // Validate required fields
    if (!new_date || !new_time || !psychologist_id) {
      return res.status(400).json(
        errorResponse('Missing required fields: new_date, new_time, psychologist_id')
      );
    }

    // Get client ID (userId is from users.id, so we need to query clients.user_id)
    // First attempt to fetch by user_id, then fall back to id for legacy clients
    let { data: client } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .single();

    // If not found by user_id, try by id (legacy clients)
    if (!client) {
      const { data: legacyClient } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('id', userId)
        .single();
      client = legacyClient;
    }

    if (!client) {
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    // Get existing session and verify ownership
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('client_id', client.id)
      .single();

    if (sessionError || !session) {
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // Validate psychologist_id matches the session
    if (session.psychologist_id !== psychologist_id) {
      return res.status(400).json(
        errorResponse('Psychologist ID does not match the session')
      );
    }

    // Check if session can be rescheduled
    // Allow both 'booked' and 'rescheduled' sessions to be rescheduled again
    // Free assessment sessions can also be rescheduled if they're booked or already rescheduled
    const allowedStatuses = ['booked', 'rescheduled'];
    if (!allowedStatuses.includes(session.status) && session.session_type !== 'free_assessment') {
      return res.status(400).json(
        errorResponse('Only booked or rescheduled sessions can be rescheduled')
      );
    }
    
    // For free assessment sessions, allow rescheduling even if status is not exactly 'booked'
    if (session.session_type === 'free_assessment' && !['booked', 'rescheduled'].includes(session.status)) {
      return res.status(400).json(
        errorResponse('This free assessment session cannot be rescheduled')
      );
    }

    // Validate that new date/time is in the future
    const dayjs = require('dayjs');
    const utc = require('dayjs/plugin/utc');
    const timezone = require('dayjs/plugin/timezone');
    dayjs.extend(utc);
    dayjs.extend(timezone);

    const newSessionDateTime = dayjs(
      `${new_date} ${new_time}`,
      'YYYY-MM-DD HH:mm:ss'
    ).tz('Asia/Kolkata');
    const now = dayjs().tz('Asia/Kolkata');

    if (newSessionDateTime.isBefore(now)) {
      return res.status(400).json(
        errorResponse('New session date and time must be in the future')
      );
    }

    // Check 24-hour rule: if session is within 24 hours (IST), require admin approval
    const sessionDateTime = dayjs(
      `${session.scheduled_date} ${session.scheduled_time}`,
      'YYYY-MM-DD HH:mm:ss'
    ).tz('Asia/Kolkata');
    const hoursUntilSession = sessionDateTime.diff(now, 'hour', true);
    const rescheduleCount = session.reschedule_count || 0;
    
    console.log('🕐 24-hour rule check (IST):', {
      sessionDateTime: sessionDateTime.format('YYYY-MM-DD HH:mm:ss'),
      now: now.format('YYYY-MM-DD HH:mm:ss'),
      hoursUntilSession: hoursUntilSession.toFixed(2),
      rescheduleCount
    });

    // Decide if this reschedule needs admin approval:
    // - Always if within 24 hours
    // - Always from the second reschedule onwards (reschedule_count >= 1),
    //   even if it's still beyond 24 hours
    const requiresApproval = hoursUntilSession <= 24 || rescheduleCount >= 1;

    if (requiresApproval) {
      console.log('⚠️ Session requires admin approval for reschedule', {
        reason: hoursUntilSession <= 24 ? 'within_24_hours' : 'multiple_reschedules',
        hoursUntilSession: hoursUntilSession.toFixed(2),
        rescheduleCount
      });
      
      // Create reschedule request for admin approval
      
      try {
        // Create reschedule request notification for admin
        const { data: clientDetails } = await supabaseAdmin
          .from('clients')
          .select('first_name, last_name, child_name, email')
          .eq('id', client.id)
          .single();

        const { data: psychologistDetails } = await supabaseAdmin
          .from('psychologists')
          .select('first_name, last_name, email')
          .eq('id', session.psychologist_id)
          .single();

        const clientName = clientDetails?.child_name || `${clientDetails?.first_name || ''} ${clientDetails?.last_name || ''}`.trim();
        const psychologistName = `${psychologistDetails?.first_name || ''} ${psychologistDetails?.last_name || ''}`.trim();

        // Get all admin users to send notifications to
        // user_id is NOT NULL in notifications table, so we must have admin users
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { data: adminUsers, error: adminUsersError } = await supabaseAdmin
          .from('users')
          .select('id')
          .in('role', ['admin', 'superadmin']);

        if (adminUsersError || !adminUsers || adminUsers.length === 0) {
          console.error('Error fetching admin users or no admin users found:', adminUsersError);
          // Cannot create notification without user_id (NOT NULL constraint)
          // Log error but don't fail the reschedule request - session status is still updated
          console.warn('⚠️ Cannot create admin notification: No admin users found. Reschedule request will be created but admin may not be notified.');
        }

        // Create admin notifications for reschedule request
        // Schema: user_id (NOT NULL), title, message, type, is_read, related_id, related_type, created_at, updated_at
        // Note: user_role and metadata columns don't exist in the schema, so we store extra info in message
        const adminNotifications = [];
        
        if (adminUsers && adminUsers.length > 0) {
          // Create notification for each admin user
          adminUsers.forEach(admin => {
            // Include all relevant info in the message since metadata column doesn't exist
            const detailedMessage = `${clientName} has requested to reschedule their session from ${session.scheduled_date} at ${session.scheduled_time} to ${new_date} at ${new_time}. This requires admin approval as it's within 24 hours. Session ID: ${session.id}, Client ID: ${client.id}, Psychologist ID: ${session.psychologist_id}`;
            
            adminNotifications.push({
              user_id: admin.id, // NOT NULL - required
          title: 'Reschedule Request (Within 24 Hours)',
              message: detailedMessage,
              type: 'warning', // Must be one of: 'info', 'success', 'warning', 'error' per schema constraint
              related_id: session.id,
              related_type: 'session',
          is_read: false,
              status: 'pending', // Set status for reschedule request filtering
              created_at: new Date().toISOString()
            });
          });
        }

        // Only insert notifications if we have admin users
        if (adminNotifications.length > 0) {
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { error: notificationError } = await supabaseAdmin
          .from('notifications')
            .insert(adminNotifications);

        if (notificationError) {
          console.error('Error creating admin notification:', notificationError);
            // Don't fail the reschedule request if notification fails - session status is still updated
            console.warn('⚠️ Failed to create admin notifications, but reschedule request status is updated');
          } else {
            console.log(`✅ Created ${adminNotifications.length} admin notification(s) for reschedule request`);
          }
        }

        // Send email to admin and meet.littlecare@gmail.com (same template and style as other admin emails)
        const adminEmail = process.env.COMPANY_ADMIN_EMAIL;
        const meetLittleCareEmail = 'meet.littlecare@gmail.com';
        const adminRecipients = [adminEmail, meetLittleCareEmail].filter(Boolean).join(', ');
        if (adminRecipients) {
          try {
            const emailService = require('../utils/emailService');
            await emailService.sendRescheduleRequestNotification({
              to: adminRecipients,
              clientName,
              psychologistName,
              fromDate: session.scheduled_date,
              fromTime: session.scheduled_time,
              toDate: new_date,
              toTime: new_time,
              sessionId: session.id,
              clientId: client.id,
              psychologistId: session.psychologist_id,
              reasonText: req.body.reason || null
            });
            console.log('📧 Reschedule request email sent to admin and meet.littlecare@gmail.com');
          } catch (emailError) {
            console.error('Error sending reschedule request email:', emailError);
            console.warn('⚠️ Reschedule request created but email notification failed');
          }
        }

        // Also create informational notification for psychologist (not for approval - admin approves)
        // Get psychologist user_id
        const { data: psychologistUser } = await supabaseAdmin
          .from('psychologists')
          .select('user_id')
          .eq('id', session.psychologist_id)
          .single();

        if (psychologistUser?.user_id) {
          const psychologistNotification = {
            user_id: psychologistUser.user_id,
            title: 'Reschedule Request (Within 24 Hours)',
            message: `${clientName} has requested to reschedule their session from ${session.scheduled_date} at ${session.scheduled_time} to ${new_date} at ${new_time}. This request is pending admin approval as it's within 24 hours. You will be notified once admin makes a decision.`,
            type: 'info', // Informational only - not for approval
            related_id: session.id,
            related_type: 'session',
            is_read: false,
            created_at: new Date().toISOString()
          };

          // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
          const { error: psychNotificationError } = await supabaseAdmin
            .from('notifications')
            .insert([psychologistNotification]);

          if (psychNotificationError) {
            console.error('Error creating psychologist notification:', psychNotificationError);
          } else {
            console.log('✅ Created informational notification for psychologist');
          }
        }

        // Update session status to indicate reschedule request
        const { error: updateError } = await supabaseAdmin
          .from('sessions')
          .update({
            status: 'reschedule_requested',
            updated_at: new Date().toISOString()
          })
          .eq('id', sessionId);

        if (updateError) {
          console.error('Error updating session status:', updateError);
          return res.status(500).json(
            errorResponse('Failed to update session status')
          );
        }

        return res.json(
          successResponse(
            { 
              session: session,
              requiresApproval: true,
              hoursUntilSession: Math.round(hoursUntilSession * 100) / 100
            },
            'Reschedule request sent to admin for approval'
          )
        );

      } catch (error) {
        console.error('Error creating reschedule request:', error);
        return res.status(500).json(
          errorResponse('Failed to create reschedule request')
        );
      }
    }

    // Beyond 24 hours - proceed with direct reschedule
    console.log('✅ Session is beyond 24 hours, proceeding with direct reschedule');

    // Check if session can be rescheduled (redundant check but catches status changes)
    if (session.status === 'completed' || session.status === 'cancelled') {
      return res.status(400).json(
        errorResponse('Cannot reschedule completed or cancelled sessions')
      );
    }

    // CRITICAL FIX: Check if new time slot is available using availability service
    console.log('🔍 Checking time slot availability using availability service...');
    const isAvailable = await availabilityService.isTimeSlotAvailable(
      psychologist_id, 
      formatDate(new_date), 
      formatTime(new_time)
    );

    if (!isAvailable) {
      return res.status(400).json(
        errorResponse('Selected time slot is not available in psychologist schedule')
      );
    }
    console.log('✅ Time slot is available in psychologist schedule');

    // Check if new time slot is already booked by another session
    const { data: conflictingSessions } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', formatDate(new_date))
      .eq('scheduled_time', formatTime(new_time))
      .in('status', ['booked', 'rescheduled', 'confirmed'])
      .neq('id', sessionId); // Exclude current session

    if (conflictingSessions && conflictingSessions.length > 0) {
      return res.status(400).json(
        errorResponse('Selected time slot is already booked by another session')
      );
    }
    console.log('✅ No conflicting sessions found');

    // Get client and psychologist details for Meet link and notifications
    const { data: clientDetails } = await supabaseAdmin
      .from('clients')
      .select('first_name, last_name, child_name, phone_number, user:users(email)')
      .eq('id', client.id)
      .single();

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologistDetails } = await supabaseAdmin
      .from('psychologists')
      .select('first_name, last_name, phone, email, google_calendar_credentials')
      .eq('id', psychologist_id)
      .single();

    // Update session with new date/time (Meet link will be added later in background)
    // Do NOT update original_scheduled_date — it stays as the first scheduled date forever
    const updateData = {
      scheduled_date: formatDate(new_date),
      scheduled_time: formatTime(new_time),
      status: 'rescheduled',
      reschedule_count: (session.reschedule_count || 0) + 1,
      reminder_sent: false, // Reset reminder flag when rescheduled
      updated_at: new Date().toISOString()
    };

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('sessions')
      .update(updateData)
      .eq('id', sessionId)
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
        .eq('session_id', sessionId)
        .maybeSingle();

      if (!receiptError && receipt) {
        // Update receipt_details JSON with new session date and time
        const updatedReceiptDetails = {
          ...receipt.receipt_details,
          session_date: formatDate(new_date),
          session_time: formatTime(new_time)
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

    // CRITICAL: Return response IMMEDIATELY after session update
    // All heavy operations (Meet link, emails, WhatsApp, availability) will run async
    res.json(
      successResponse(updatedSession, 'Session rescheduled successfully')
    );

    // Continue with background tasks (don't await - let them run async)
    (async () => {
      try {
        // Create new Google Meet link for rescheduled session (async)
        // NOTE: We create a NEW Meet link (not reuse old one) because:
        // 1. The old Meet link is tied to the old calendar event with old date/time
        // 2. Google Calendar events are immutable - can't change date/time of existing event
        // 3. New Meet link ensures calendar event matches the new rescheduled date/time
        // If creation fails, we fall back to the old link (which will still work)
    let meetData = null;
    const meetLinkService = require('../utils/meetLinkService');
    try {
      console.log('🔄 Creating new Google Meet link for rescheduled session...');
      
      // Check if this is a free assessment session
      const isFreeAssessment = session.session_type === 'free_assessment';
      
      // Convert new_time from 12-hour format (e.g., "6:00 PM") to 24-hour format (e.g., "18:00")
      // for Google Calendar API compatibility
      const convertTo24Hour = (time12Hour) => {
        if (!time12Hour || typeof time12Hour !== 'string') {
          return '00:00';
        }
        
        // If already in 24-hour format, return as is
        if (!time12Hour.includes('AM') && !time12Hour.includes('PM')) {
          const [hours, minutes] = time12Hour.split(':');
          return `${hours.padStart(2, '0')}:${minutes || '00'}`;
        }
        
        // Handle 12-hour format with AM/PM
        const [time, period] = time12Hour.split(' ');
        if (!time || !period) {
          return '00:00';
        }
        
        const [hours, minutes] = time.split(':');
        let hour24 = parseInt(hours);
        
        if (period === 'PM' && hour24 !== 12) {
          hour24 += 12;
        } else if (period === 'AM' && hour24 === 12) {
          hour24 = 0;
        }
        
        return `${hour24.toString().padStart(2, '0')}:${minutes || '00'}`;
      };
      
      const newTime24Hour = convertTo24Hour(new_time);
      
      const sessionDataForMeet = {
        summary: isFreeAssessment 
          ? `Free Assessment - ${clientDetails?.child_name || clientDetails?.first_name}`
          : `Therapy Session - ${clientDetails?.child_name || clientDetails?.first_name} with ${psychologistDetails?.first_name}`,
        description: isFreeAssessment
          ? `Rescheduled free 20-minute assessment session`
          : `Rescheduled therapy session between ${clientDetails?.child_name || clientDetails?.first_name} and ${psychologistDetails?.first_name} ${psychologistDetails?.last_name}`,
        startDate: new_date,
        startTime: newTime24Hour,
        endTime: isFreeAssessment 
          ? addMinutesToTime(newTime24Hour, 20)
          : addMinutesToTime(newTime24Hour, 50),
        clientEmail: clientDetails?.email,
        psychologistEmail: psychologistDetails?.email,
        attendees: []
      };

      // Add attendees
      if (clientDetails?.email) {
        sessionDataForMeet.attendees.push(clientDetails.email);
      }
      if (psychologistDetails?.email) {
        sessionDataForMeet.attendees.push(psychologistDetails.email);
      }

          // Get OAuth credentials for Meet link creation
      let userAuth = null;
      if (isFreeAssessment) {
            // For free assessments, use assessment psychologist's OAuth credentials
        const { ensureAssessmentPsychologist } = require('./freeAssessmentController');
        const defaultPsychologist = await ensureAssessmentPsychologist();
        
        if (defaultPsychologist?.id) {
          const { data: assessmentPsychologist } = await supabaseAdmin
            .from('psychologists')
            .select('id, email, google_calendar_credentials')
            .eq('id', defaultPsychologist.id)
            .single();
          
          if (assessmentPsychologist?.google_calendar_credentials) {
            const credentials = assessmentPsychologist.google_calendar_credentials;
            const now = Date.now();
            const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
            
            if (credentials.access_token) {
              const expiryDate = credentials.expiry_date ? new Date(credentials.expiry_date).getTime() : null;
              if (!expiryDate || expiryDate > (now + bufferTime)) {
                userAuth = {
                  access_token: credentials.access_token,
                  refresh_token: credentials.refresh_token,
                  expiry_date: credentials.expiry_date
                };
                console.log('✅ Using assessment psychologist OAuth credentials for Meet link');
              } else if (credentials.refresh_token) {
                userAuth = {
                  access_token: credentials.access_token,
                  refresh_token: credentials.refresh_token,
                  expiry_date: credentials.expiry_date
                };
                console.log('⚠️ Assessment psychologist OAuth token expired, but refresh token available');
              }
            }
          }
        }
          } else {
            // For regular therapy sessions, use the session's psychologist OAuth credentials
            if (psychologistDetails?.google_calendar_credentials) {
              try {
                const credentials = psychologistDetails.google_calendar_credentials;
                const now = Date.now();
                const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
                
                if (credentials.access_token) {
                  const expiryDate = credentials.expiry_date ? new Date(credentials.expiry_date).getTime() : null;
                  if (!expiryDate || expiryDate > (now + bufferTime)) {
                    // Token is valid
                    userAuth = {
                      access_token: credentials.access_token,
                      refresh_token: credentials.refresh_token,
                      expiry_date: credentials.expiry_date
                    };
                    console.log('✅ Using psychologist OAuth credentials for Meet link creation (token valid)');
                  } else if (credentials.refresh_token) {
                    // Token expired but we have refresh token - pass both to service for auto-refresh
                    userAuth = {
                      access_token: credentials.access_token, // May be expired, service will refresh
                      refresh_token: credentials.refresh_token,
                      expiry_date: credentials.expiry_date
                    };
                    console.log('⚠️ Psychologist OAuth token expired, but refresh token available - service will attempt refresh');
                  } else {
                    console.log('⚠️ Psychologist OAuth credentials expired and no refresh token - will use fallback method');
                  }
                }
              } catch (credError) {
                console.warn('⚠️ Error parsing psychologist OAuth credentials:', credError.message);
              }
            } else {
              console.log('ℹ️ Psychologist does not have Google Calendar connected - will use service account method (may not create real Meet link)');
            }
      }

      const meetResult = await meetLinkService.generateSessionMeetLink(sessionDataForMeet, userAuth);
      
          if (meetResult.success && meetResult.meetLink) {
        meetData = {
          meetLink: meetResult.meetLink,
          eventId: meetResult.eventId,
          calendarLink: meetResult.eventLink || null,
        };
        console.log('✅ New Google Meet link created for rescheduled session');
            
            // Update session with new Meet link
            await supabaseAdmin
              .from('sessions')
              .update({
                google_meet_link: meetResult.meetLink,
                google_calendar_event_id: meetResult.eventId || null,
                google_meet_join_url: meetResult.meetLink,
                google_meet_start_url: meetResult.meetLink,
                ...(meetResult.eventLink && { google_calendar_link: meetResult.eventLink })
              })
              .eq('id', sessionId);
      } else {
            console.log('⚠️ Using existing Meet link as fallback');
        meetData = {
          meetLink: session.google_meet_link || null,
          eventId: session.google_calendar_event_id || null,
          calendarLink: null,
        };
      }
    } catch (meetError) {
      console.error('❌ Meet link creation failed:', meetError);
      // Use existing meet link as fallback
      meetData = {
        meetLink: session.google_meet_link || null,
        eventId: session.google_calendar_event_id || null,
        calendarLink: null,
      };
    }

        // CRITICAL FIX: Update availability table - release old slot and block new slot
        // Do this for regular sessions (free assessments handled separately below)
        if (session.session_type !== 'free_assessment') {
      try {
        console.log('🔄 Updating availability table for rescheduled session...');
        
        // Helper function to convert 24-hour time to 12-hour format
        const convertTo12Hour = (time24) => {
          if (!time24) return null;
          // Handle if already in 12-hour format
          if (time24.includes('AM') || time24.includes('PM')) {
            return time24;
          }
          const timeOnly = time24.split(' ')[0]; // Remove any timezone suffix
          const [hours, minutes] = timeOnly.split(':');
          const hour = parseInt(hours, 10);
          const minute = minutes || '00';
          
          if (hour === 0) {
            return `12:${minute} AM`;
          } else if (hour < 12) {
            return `${hour}:${minute} AM`;
          } else if (hour === 12) {
            return `12:${minute} PM`;
          } else {
            return `${hour - 12}:${minute} PM`;
          }
        };

        // Release old slot - add it back to availability
        const oldDate = session.scheduled_date;
        const oldTime = session.scheduled_time;
        const oldTime12Hour = convertTo12Hour(oldTime);
        
        if (oldTime12Hour) {
          // Use limit(1) instead of single() to handle cases where multiple records exist
          const { data: oldAvailRecords } = await supabaseAdmin
            .from('availability')
            .select('id, time_slots')
            .eq('psychologist_id', psychologist_id)
            .eq('date', oldDate)
            .limit(1);
          
          const oldAvail = oldAvailRecords && oldAvailRecords.length > 0 ? oldAvailRecords[0] : null;
          
          if (oldAvailRecords && oldAvailRecords.length > 1) {
            console.warn(`⚠️ Multiple availability records found for psychologist ${psychologist_id} on ${oldDate}, using first one`);
      }

          if (oldAvail && oldAvail.time_slots) {
            const oldSlots = Array.isArray(oldAvail.time_slots) ? oldAvail.time_slots : [];
            // Check if slot is not already in the list (to avoid duplicates)
            const slotExists = oldSlots.some(slot => {
              const slotStr = typeof slot === 'string' ? slot.trim() : String(slot).trim();
              return slotStr.toLowerCase() === oldTime12Hour.toLowerCase();
            });
            
            if (!slotExists) {
              const updatedSlots = [...oldSlots, oldTime12Hour].sort();
              await supabaseAdmin
                .from('availability')
                .update({ 
                  time_slots: updatedSlots,
                  updated_at: new Date().toISOString()
                })
                .eq('id', oldAvail.id);
              console.log(`✅ Released old slot ${oldTime12Hour} on ${oldDate}`);
            }
          }
        }

        // Block new slot - remove it from availability using the service
        await availabilityService.updateAvailabilityOnBooking(
          psychologist_id,
          formatDate(new_date),
          formatTime(new_time)
        );
          console.log(`✅ Blocked new slot ${formatTime(new_time)} on ${formatDate(new_date)}`);
        } catch (availabilityError) {
          console.error('⚠️ Error updating availability table:', availabilityError);
          // Don't fail the reschedule if availability update fails, but log it
          // The session is already updated, so we continue
        }
    }

    // For free assessment sessions, update the timeslot availability and free_assessments table
    if (session.session_type === 'free_assessment') {
      try {
        const oldDate = session.scheduled_date;
        const oldTime = session.scheduled_time;
        const newDate = formatDate(new_date);
        const newTime = formatTime(new_time);

        // Update the free_assessments table to sync with sessions table
        // Use the same formatted date/time as sessions table for consistency
        try {
          const { error: freeAssessmentUpdateError } = await supabaseAdmin
            .from('free_assessments')
            .update({
              scheduled_date: newDate, // Already formatted above
              scheduled_time: newTime,  // Already formatted above
              status: 'rescheduled',
              updated_at: new Date().toISOString()
            })
            .eq('session_id', sessionId);

          if (freeAssessmentUpdateError) {
            console.error('⚠️ Error updating free_assessments table:', freeAssessmentUpdateError);
          } else {
            console.log('✅ Updated free_assessments table with new date/time');
          }
        } catch (freeAssessmentError) {
          console.error('⚠️ Error updating free_assessments table:', freeAssessmentError);
          // Don't fail the reschedule if free_assessments update fails
        }

        // Add back the old slot
        const { data: oldDateConfig } = await supabaseAdmin
          .from('free_assessment_date_configs')
          .select('time_slots')
          .eq('date', oldDate)
          .single();

        if (oldDateConfig && oldDateConfig.time_slots) {
          const oldSlots = Array.isArray(oldDateConfig.time_slots) ? oldDateConfig.time_slots : [];
          if (!oldSlots.includes(oldTime)) {
            oldSlots.push(oldTime);
            oldSlots.sort();
            await supabaseAdmin
              .from('free_assessment_date_configs')
              .update({ time_slots: oldSlots })
              .eq('date', oldDate);
            console.log(`✅ Added back old slot ${oldTime} on ${oldDate}`);
          }
        }

        // Remove the new slot
        const { data: newDateConfig } = await supabaseAdmin
          .from('free_assessment_date_configs')
          .select('time_slots')
          .eq('date', newDate)
          .single();

        if (newDateConfig && newDateConfig.time_slots) {
          const newSlots = Array.isArray(newDateConfig.time_slots) ? newDateConfig.time_slots : [];
          const index = newSlots.indexOf(newTime);
          if (index > -1) {
            newSlots.splice(index, 1);
            await supabaseAdmin
              .from('free_assessment_date_configs')
              .update({ time_slots: newSlots })
              .eq('date', newDate);
            console.log(`✅ Removed booked slot ${newTime} from free assessment config on ${newDate}`);
          }
        }
      } catch (slotError) {
        console.error('⚠️ Error updating free assessment timeslots:', slotError);
        // Don't fail the reschedule if timeslot update fails
      }
    }

    // Create notification for psychologist
    await createRescheduleNotification(session, updatedSession, client.id);

    // Send email notifications
    try {
      const emailService = require('../utils/emailService');
      const clientEmail = clientDetails?.user?.email;
      const psychologistEmail = psychologistDetails?.email;
      
      console.log('📧 Preparing to send reschedule emails...');
      console.log(`   Client Email: ${clientEmail || 'NOT FOUND'}`);
      console.log(`   Psychologist Email: ${psychologistEmail || 'NOT FOUND'}`);
      
      if (!clientEmail && !psychologistEmail) {
        console.warn('⚠️ No email addresses found - skipping email notifications');
      } else {
        await emailService.sendRescheduleNotification(
          {
            clientName: clientDetails?.child_name || `${clientDetails?.first_name || ''} ${clientDetails?.last_name || ''}`.trim(),
            psychologistName: `${psychologistDetails?.first_name || ''} ${psychologistDetails?.last_name || ''}`.trim(),
            clientEmail: clientEmail,
            psychologistEmail: psychologistEmail,
            scheduledDate: updatedSession.scheduled_date,
            scheduledTime: updatedSession.scheduled_time,
            sessionId: updatedSession.id,
            meetLink: meetData?.meetLink,
            isFreeAssessment: session.session_type === 'free_assessment'
          },
          session.scheduled_date,
          session.scheduled_time
        );
        console.log('✅ Reschedule emails sent successfully');
      }
    } catch (emailError) {
      console.error('❌ Error sending reschedule emails:', emailError);
      // Continue even if email fails
    }

      // Send WhatsApp notifications for reschedule
      try {
        console.log('📱 Sending WhatsApp notifications for reschedule...');
        const { sendRescheduleConfirmation, sendWhatsAppTextWithRetry } = require('../utils/whatsappService');
        
        const clientName = clientDetails?.child_name || `${clientDetails?.first_name || ''} ${clientDetails?.last_name || ''}`.trim();
        const psychologistName = `${psychologistDetails?.first_name || ''} ${psychologistDetails?.last_name || ''}`.trim();
        
        // Check if this is a free assessment session
        const isFreeAssessment = session.session_type === 'free_assessment';
        const sessionType = isFreeAssessment ? 'free assessment' : 'therapy session';

        // Helper function to format time to IST 12-hour format (same as whatsappService)
        const formatFriendlyTime = (timeStr) => {
          if (!timeStr) return '';
          try {
            const [h, m] = timeStr.split(':');
            const hours = parseInt(h, 10);
            const minutes = parseInt(m || '0', 10);
            const period = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
            const displayMinutes = minutes.toString().padStart(2, '0');
            return `${displayHours}:${displayMinutes} ${period}`;
          } catch {
            return timeStr;
          }
        };

        // Helper function to format date to friendly format in IST
        const formatFriendlyDate = (dateStr) => {
          if (!dateStr) return '';
          try {
            const d = new Date(`${dateStr}T00:00:00+05:30`);
            return d.toLocaleDateString('en-IN', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
              timeZone: 'Asia/Kolkata'
            });
          } catch {
            return dateStr;
          }
        };

        // Format date and time for WhatsApp messages in IST 12-hour format
        const originalDateFormatted = formatFriendlyDate(session.scheduled_date);
        const originalTimeFormatted = formatFriendlyTime(session.scheduled_time);
        const newDateFormatted = formatFriendlyDate(updatedSession.scheduled_date);
        const newTimeFormatted = formatFriendlyTime(updatedSession.scheduled_time);
        
        const originalDateTime = `${originalDateFormatted} at ${originalTimeFormatted} IST`;
        const newDateTime = `${newDateFormatted} at ${newTimeFormatted} IST`;

      // Send WhatsApp to client using the standardized format
      if (clientDetails?.phone_number) {
        const clientResult = await sendRescheduleConfirmation(clientDetails.phone_number, {
          oldDate: session.scheduled_date,
          oldTime: session.scheduled_time,
          newDate: updatedSession.scheduled_date,
          newTime: updatedSession.scheduled_time,
          newMeetLink: meetData?.meetLink || null
        });
        
        if (clientResult?.success) {
          console.log(`✅ Reschedule WhatsApp sent to client (${sessionType})`);
        } else {
          console.warn('⚠️ Failed to send reschedule WhatsApp to client');
        }
      }

      // Send WhatsApp to psychologist
      if (psychologistDetails?.phone) {
        // Format date in short format for consistency
        const formatBookingDateShort = (dateStr) => {
          if (!dateStr) return '';
          try {
            const d = new Date(`${dateStr}T00:00:00+05:30`);
            return d.toLocaleDateString('en-IN', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              timeZone: 'Asia/Kolkata'
            });
          } catch {
            return dateStr;
          }
        };
        
        const oldDateFormatted = formatBookingDateShort(session.scheduled_date);
        const newDateFormatted = formatBookingDateShort(updatedSession.scheduled_date);
        const oldDateTime = `${oldDateFormatted} at ${originalTimeFormatted} (IST)`;
        const newDateTime = `${newDateFormatted} at ${newTimeFormatted} (IST)`;
        
        const bullet = '•⁠  ⁠';
        const meetLinkLine = meetData?.meetLink ? `Join link:\n${meetData.meetLink}\n\n` : '';
        
        const psychologistMessage =
          `Hey 👋\n\n` +
          `${isFreeAssessment ? 'Free assessment' : 'Session'} rescheduled with Little Care.\n\n` +
          `${bullet}Client: ${clientName}\n` +
          `${bullet}Old: ${oldDateTime}\n` +
          `${bullet}New: ${newDateTime}\n\n` +
          meetLinkLine +
          `Please be ready 5 mins early.\n\n` +
          `For help: +91 95390 07766\n\n` +
          `— Little Care 💜`;

        const psychologistResult = await sendWhatsAppTextWithRetry(psychologistDetails.phone, psychologistMessage);
        if (psychologistResult?.success) {
          console.log(`✅ Reschedule WhatsApp sent to psychologist (${sessionType})`);
        } else {
          console.warn('⚠️ Failed to send reschedule WhatsApp to psychologist');
        }
      }
      
      console.log('✅ WhatsApp notifications sent for reschedule');
    } catch (waError) {
      console.error('❌ Error sending reschedule WhatsApp:', waError);
      // Continue even if WhatsApp fails
    }

    console.log('✅ Session rescheduled successfully');
    
    // PRIORITY: Check and send reminder immediately if rescheduled session is 2 hours away
    // This gives rescheduled bookings priority over batch reminder processing
    try {
      const sessionReminderService = require('../services/sessionReminderService');
      // Run asynchronously to not block the response
      sessionReminderService.checkAndSendReminderForSessionId(updatedSession.id).catch(err => {
        console.error('❌ Error in priority reminder check:', err);
        // Don't block response - reminder will be sent in next hourly check
      });
    } catch (reminderError) {
      console.error('❌ Error initiating priority reminder check:', reminderError);
      // Don't block response
    }
    
    // Log successful reschedule
    await userInteractionLogger.logReschedule({
      userId,
      userRole: req.user.role,
      sessionId,
      oldDate: session.scheduled_date,
      oldTime: session.scheduled_time,
      newDate: formatDate(new_date),
      newTime: formatTime(new_time),
      status: 'success'
    });
      } catch (backgroundError) {
        console.error('❌ Error in background reschedule tasks:', backgroundError);
        // Don't throw - background tasks shouldn't affect the response
      }
    })();

  } catch (error) {
    console.error('Reschedule session error:', error);
    res.status(500).json(
      errorResponse('Internal server error while rescheduling session')
    );
  }
};

// Helper function to get reschedule count for a session
const getRescheduleCount = async (sessionId) => {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('reschedule_count')
      .eq('id', sessionId)
      .single();
    
    return session?.reschedule_count || 0;
  } catch (error) {
    console.error('Error getting reschedule count:', error);
    return 0;
  }
};

// Helper function to create reschedule request
const createRescheduleRequest = async (session, newDate, newTime, clientId, reason) => {
  try {
    // Get client details
    const { data: clientDetails } = await supabaseAdmin
      .from('clients')
      .select('first_name, last_name, child_name')
      .eq('id', clientId)
      .single();

    const clientName = clientDetails?.child_name || 
                      `${clientDetails?.first_name || 'Client'} ${clientDetails?.last_name || ''}`.trim();

    // Create reschedule request notification
    const notificationData = {
      psychologist_id: session.psychologist_id,
      type: 'reschedule_request',
      title: 'Reschedule Request',
      message: `${clientName} has requested to reschedule their session from ${session.scheduled_date} at ${session.scheduled_time} to ${newDate} at ${newTime}. Reason: ${reason}`,
      session_id: session.id,
      client_id: clientId,
      is_read: false,
      created_at: new Date().toISOString(),
      metadata: {
        request_type: 'reschedule',
        new_date: newDate,
        new_time: newTime,
        reason: reason,
        original_date: session.scheduled_date,
        original_time: session.scheduled_time
      }
    };

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { error: notificationError } = await supabaseAdmin
      .from('notifications')
      .insert([notificationData]);

    if (notificationError) {
      console.error('Error creating reschedule request notification:', notificationError);
      return { success: false, error: notificationError };
    }

    console.log('✅ Reschedule request notification created');
    return { 
      success: true, 
      data: { 
        message: 'Reschedule request sent to psychologist',
        notification: notificationData 
      } 
    };

  } catch (error) {
    console.error('Error creating reschedule request:', error);
    return { success: false, error };
  }
};

// Helper function to create reschedule notification
const createRescheduleNotification = async (originalSession, updatedSession, clientId) => {
  try {
    // Get client and psychologist details
    const { data: clientDetails } = await supabaseAdmin
      .from('clients')
      .select('first_name, last_name, child_name')
      .eq('id', clientId)
      .single();

    const clientName = clientDetails?.child_name || 
                      `${clientDetails?.first_name || 'Client'} ${clientDetails?.last_name || ''}`.trim();

    // Get psychologist user_id (required for notifications table)
    // Psychologists can exist standalone or with a linked user_id
    const { data: psychologistUser } = await supabaseAdmin
      .from('psychologists')
      .select('user_id, email')
      .eq('id', updatedSession.psychologist_id)
      .single();

    let targetUserId = psychologistUser?.user_id;

    // If psychologist doesn't have user_id, try to find user by email
    if (!targetUserId && psychologistUser?.email) {
      const { data: userByEmail } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('email', psychologistUser.email)
        .single();

      if (userByEmail?.id) {
        targetUserId = userByEmail.id;
        // Optionally backfill psychologist.user_id for future use
        await supabaseAdmin
          .from('psychologists')
          .update({ user_id: targetUserId, updated_at: new Date().toISOString() })
          .eq('id', updatedSession.psychologist_id);
        console.log('✅ Found and linked user_id for psychologist via email');
      }
    }

    if (!targetUserId) {
      console.warn('⚠️ Cannot create psychologist notification: No user_id found for psychologist. Email and WhatsApp notifications were still sent successfully.');
      return;
    }

    // Format dates for notification message
    const formatDateForNotification = (date, time) => {
      return new Date(`${date}T${time}+05:30`).toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Kolkata'
      });
    };

    const formatTimeForNotification = (time) => {
      const [hours, minutes] = time.split(':');
      const date = new Date();
      date.setHours(parseInt(hours), parseInt(minutes));
      return date.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata'
      });
    };

    // Create notification record using correct schema
    // Schema: user_id (NOT NULL), title, message, type, is_read, related_id, related_type, created_at, updated_at
    const notificationData = {
      user_id: targetUserId, // NOT NULL - required
      title: 'Session Rescheduled',
      message: `${clientName} has rescheduled their session from ${originalSession.scheduled_date} at ${originalSession.scheduled_time} to ${updatedSession.scheduled_date} at ${updatedSession.scheduled_time}`,
      type: 'info', // Must be one of: 'info', 'success', 'warning', 'error' per schema constraint
      related_id: updatedSession.id,
      related_type: 'session',
      is_read: false,
      status: 'approved', // Auto-approved reschedules (outside 24h window)
      created_at: new Date().toISOString()
    };

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { error: notificationError } = await supabaseAdmin
      .from('notifications')
      .insert([notificationData]);

    if (notificationError) {
      console.error('Error creating reschedule notification:', notificationError);
    } else {
      console.log('✅ Reschedule notification created for psychologist');
    }

  } catch (error) {
    console.error('Error creating reschedule notification:', error);
  }
};

// Helper function to send reschedule emails
const sendRescheduleEmails = async (originalSession, updatedSession, psychologistId) => {
  try {
    console.log('📧 Sending reschedule email notifications...');
    
    // Get client and psychologist details for email
    const { data: clientDetails } = await supabaseAdmin
      .from('clients')
      .select('first_name, last_name, child_name, user:users(email)')
      .eq('id', originalSession.client_id)
      .single();

    const { data: psychologistDetails } = await supabaseAdmin
      .from('psychologists')
      .select('first_name, last_name, email')
      .eq('id', psychologistId)
      .single();

    if (clientDetails && psychologistDetails) {
      const emailService = require('../utils/emailService');
      
      const clientName = clientDetails.child_name || 
                        `${clientDetails.first_name} ${clientDetails.last_name}`.trim();
      const psychologistName = `${psychologistDetails.first_name} ${psychologistDetails.last_name}`.trim();

      await emailService.sendRescheduleNotification({
        clientEmail: clientDetails.user?.email,
        psychologistEmail: psychologistDetails.email,
        clientName,
        psychologistName,
        sessionId: updatedSession.id,
        originalDate: originalSession.scheduled_date,
        originalTime: originalSession.scheduled_time,
        newDate: updatedSession.scheduled_date,
        newTime: updatedSession.scheduled_time,
        meetLink: updatedSession.google_meet_link
      });

      console.log('✅ Reschedule emails sent successfully');
    }
  } catch (error) {
    console.error('Error sending reschedule emails:', error);
    // Don't throw - let the reschedule complete even if email fails
  }
};

// Get single session with summary (visible to client)
const getSession = async (req, res) => {
  try {
    // Use client_id if available (new system), otherwise fall back to req.user.id (old system)
    const clientId = req.user.client_id || req.user.id;
    const { sessionId } = req.params;

    console.log(`📋 Getting session ${sessionId} for client ${clientId} (user.id: ${req.user.id}, client_id: ${req.user.client_id})`);

    // Get session with psychologist details, but exclude session_notes
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    // Note: Can't join packages directly due to no FK relationship, so we'll fetch it separately
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select(`
        *,
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          area_of_expertise
        )
      `)
      .eq('id', sessionId)
      .eq('client_id', clientId)
      .single();

    if (sessionError) {
      console.error('Error fetching session:', sessionError);
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // If session has a package_id, fetch package and calculate progress
    // Note: Can't join packages table directly, so fetch separately
    if (session.package_id) {
      try {
        console.log('📦 Fetching package for session:', session.package_id);
        // Fetch package data
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { data: packageData, error: packageError } = await supabaseAdmin
          .from('packages')
          .select('id, package_type, price, description, session_count')
          .eq('id', session.package_id)
          .single();
        
        if (!packageError && packageData) {
          session.package = packageData;
          console.log('✅ Package data fetched:', {
            id: packageData.id,
            session_count: packageData.session_count
          });
          
          // Count completed sessions for this package
          // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
          const { data: packageSessions, error: sessionsError } = await supabaseAdmin
            .from('sessions')
            .select('id, status')
            .eq('package_id', session.package_id)
            .eq('client_id', clientId);
          
          if (!sessionsError && packageSessions) {
            const totalSessions = packageData.session_count || 0;
            const completedSessions = packageSessions.filter(
              s => s.status === 'completed'
            ).length;
            
            // Always set total_sessions from session_count, even if 0 (shouldn't happen but handle it)
            session.package.completed_sessions = completedSessions;
            session.package.total_sessions = totalSessions;
            session.package.remaining_sessions = Math.max(totalSessions - completedSessions, 0);
            
            if (totalSessions > 0) {
              console.log('✅ Package progress calculated in getSession:', {
                package_id: session.package_id,
                total_sessions: totalSessions,
                completed_sessions: completedSessions,
                remaining_sessions: session.package.remaining_sessions
              });
            } else {
              console.warn('⚠️ Package session_count is 0 or missing:', {
                package_id: session.package_id,
                session_count: packageData.session_count,
                total_sessions_set: session.package.total_sessions
              });
            }
          } else {
            // Even if we can't fetch package sessions, set total_sessions from session_count
            const totalSessions = packageData.session_count || 0;
            session.package.total_sessions = totalSessions;
            session.package.completed_sessions = 0;
            session.package.remaining_sessions = totalSessions;
            
            console.error('❌ Error fetching package sessions, but set total_sessions from session_count:', {
              sessionsError: sessionsError,
              total_sessions: totalSessions
            });
          }
        } else {
          console.error('❌ Error fetching package:', packageError);
        }
      } catch (packageErr) {
        console.error('❌ Exception in package fetch/calculation:', packageErr);
      }
    }

    console.log(`✅ Session ${sessionId} retrieved successfully for client ${clientId}`, {
      hasPackage: !!session.package,
      package_id: session.package_id,
      package: session.package ? {
        total_sessions: session.package.total_sessions,
        completed_sessions: session.package.completed_sessions
      } : null
    });
    
    res.json(
      successResponse(session)
    );

  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching session')
    );
  }
};

// Get psychologist packages for client viewing
const getPsychologistPackages = async (req, res) => {
  try {
    const { psychologistId } = req.params;
    console.log(`📦 Getting packages for psychologist ${psychologistId}`);

    // Get packages for this psychologist
    const { data: packages, error: packagesError } = await supabaseAdmin
      .from('packages')
      .select('*')
      .eq('psychologist_id', psychologistId)
      .order('session_count', { ascending: true });

    if (packagesError) {
      console.error('Error fetching packages:', packagesError);
      return res.status(500).json(
        errorResponse('Failed to fetch packages')
      );
    }

    console.log(`✅ Found ${packages?.length || 0} packages for psychologist ${psychologistId}`);
    res.json(
      successResponse({ packages: packages || [] })
    );

  } catch (error) {
    console.error('Error getting psychologist packages:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching packages')
    );
  }
};

// Submit session feedback
const submitSessionFeedback = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId } = req.params;
    const { feedback, rating } = req.body;

    console.log(`📝 User ${userId} submitting feedback for session ${sessionId}`);

    // Validate required fields
    if (!feedback || !rating) {
      return res.status(400).json(
        errorResponse('Feedback and rating are required')
      );
    }

    // Validate rating range
    if (rating < 1 || rating > 5) {
      return res.status(400).json(
        errorResponse('Rating must be between 1 and 5')
      );
    }

    // Get client ID from user_id
    // Use client_id if available (new system), otherwise fall back to req.user.id (old system)
    // Or try lookup by user_id first, then fallback to id for backward compatibility
    let clientId = req.user.client_id || req.user.id;
    
    // If client_id is not in req.user, try to find it
    if (!req.user.client_id) {
      // Try new system first: lookup by user_id
      let { data: client, error: clientError } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('user_id', userId)
        .single();

      // Fallback to old system: lookup by id (backward compatibility)
      if (clientError || !client) {
        ({ data: client, error: clientError } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', userId)
          .single());
      }

      if (clientError || !client) {
        console.error('Error finding client:', clientError);
        return res.status(404).json(
          errorResponse('Client profile not found')
        );
      }

      clientId = client.id;
    }
    console.log(`📝 Client ${clientId} submitting feedback for session ${sessionId}`);

    // Check if session exists and belongs to this client
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, status, client_id')
      .eq('id', sessionId)
      .eq('client_id', clientId)
      .single();

    if (sessionError || !session) {
      console.error('Error finding session:', sessionError);
      return res.status(404).json(
        errorResponse('Session not found')
      );
    }

    // Check if session is completed
    if (session.status !== 'completed') {
      return res.status(400).json(
        errorResponse('Feedback can only be submitted for completed sessions')
      );
    }

    // Check if feedback already exists
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: existingFeedback } = await supabaseAdmin
      .from('sessions')
      .select('feedback')
      .eq('id', sessionId)
      .single();

    if (existingFeedback?.feedback) {
      return res.status(400).json(
        errorResponse('Feedback has already been submitted for this session')
      );
    }

    // Update session with feedback and rating
    // Try with rating first, fallback to feedback only if rating column doesn't exist
    let updateData = {
      feedback: feedback,
      updated_at: new Date().toISOString()
    };
    
    // Try to include rating (may not exist in all database schemas)
    let { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({
        ...updateData,
        rating: rating
      })
      .eq('id', sessionId)
      .select('id, feedback, rating, updated_at')
      .single();

    // If update fails with column error, try without rating (for backward compatibility)
    if (updateError && (
      updateError.code === '42703' || // PostgreSQL: undefined column
      updateError.message?.includes('column') && updateError.message?.includes('does not exist') ||
      updateError.message?.includes('rating')
    )) {
      console.log('⚠️ Rating column not found or error with rating, updating feedback only');
      ({ data: updatedSession, error: updateError } = await supabaseAdmin
        .from('sessions')
        .update(updateData)
        .eq('id', sessionId)
        .select('id, feedback, updated_at')
        .single());
    }

    if (updateError) {
      console.error('Error updating session with feedback:', updateError);
      console.error('Update error details:', JSON.stringify(updateError, null, 2));
      return res.status(500).json(
        errorResponse('Failed to submit feedback')
      );
    }

    console.log(`✅ Feedback submitted successfully for session ${sessionId}`);
    res.json(
      successResponse(updatedSession, 'Feedback submitted successfully')
    );

  } catch (error) {
    console.error('Error submitting feedback:', error);
    res.status(500).json(
      errorResponse('Internal server error while submitting feedback')
    );
  }
};

// Get client packages
const getClientPackages = async (req, res) => {
  try {
    const userId = req.user.id;
    let clientId = null;

    // Try multiple lookup strategies (same pattern as updateProfile)
    // Priority: 1) client_id (from middleware), 2) user_id (new system), 3) id (old system fallback)
    if (req.user.client_id) {
      clientId = req.user.client_id;
    } else {
      // Try new system: lookup by user_id
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: clientByUserId, error: errorByUserId } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (clientByUserId && !errorByUserId) {
        clientId = clientByUserId.id;
      } else {
        // Fallback to old system: lookup by id (backward compatibility)
        const { data: clientById, error: errorById } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', userId)
          .single();

        if (clientById && !errorById) {
          clientId = clientById.id;
        }
      }
    }

    if (!clientId) {
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    const fetchClientPackages = async () => {
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      return await supabaseAdmin
      .from('client_packages')
      .select(`
        *,
        package:packages(
          id,
          package_type,
          description,
          session_count,
          price
        ),
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          area_of_expertise,
          cover_image_url
        )
      `)
      .eq('client_id', clientId)
      .order('purchased_at', { ascending: false });
    };

    let { data: clientPackages, error: packagesError } = await fetchClientPackages();

    if (packagesError) {
      console.error('Error fetching client packages:', packagesError);
      return res.status(500).json(
        errorResponse('Failed to fetch client packages')
      );
    }

    const existingPackageIds = new Set(
      (clientPackages || []).map(pkg => pkg.package_id || pkg.id).filter(Boolean)
    );

    const { data: packageSessions, error: packageSessionsError } = await supabaseAdmin
      .from('sessions')
      .select('id, package_id, psychologist_id, status, scheduled_date, created_at')
      .eq('client_id', clientId)
      .not('package_id', 'is', null);

    if (packageSessionsError) {
      console.error('Error fetching package sessions:', packageSessionsError);
    } else if (packageSessions && packageSessions.length > 0) {
      let backfillAdded = false;
      const sessionsByPackage = packageSessions.reduce((acc, session) => {
        if (!session.package_id) return acc;
        if (!acc.has(session.package_id)) {
          acc.set(session.package_id, []);
        }
        acc.get(session.package_id).push(session);
        return acc;
      }, new Map());

      for (const [packageId, sessionsForPackage] of sessionsByPackage.entries()) {
        if (existingPackageIds.has(packageId)) continue;

        try {
          const { data: packageRecord } = await supabaseAdmin
            .from('packages')
            .select('*')
            .eq('id', packageId)
            .single();

          if (!packageRecord) continue;

          const completedSessions = sessionsForPackage.filter(
            (session) => !['cancelled'].includes(session.status)
          ).length;
          const earliestSession = sessionsForPackage.reduce((earliest, session) => {
            if (!earliest) return session;
            const earliestDate = new Date(earliest.scheduled_date || earliest.created_at || 0);
            const sessionDate = new Date(session.scheduled_date || session.created_at || 0);
            return sessionDate < earliestDate ? session : earliest;
          }, null);

          const psychologistId = earliestSession?.psychologist_id || packageRecord.psychologist_id;

          const { created, error: backfillError } = await ensureClientPackageRecord({
            clientId,
            psychologistId,
            packageId,
            sessionId: earliestSession?.id || null,
            purchasedAt: earliestSession?.created_at || new Date().toISOString(),
            packageData: packageRecord,
            consumedSessions: Math.max(completedSessions, 1)
          });

          if (backfillError) {
            console.error('Failed to backfill client package:', backfillError);
          } else if (created) {
            console.log('✅ Backfilled client package for package_id:', packageId);
            backfillAdded = true;
          }
        } catch (backfillException) {
          console.error('Exception while backfilling client package:', backfillException);
        }
      }

      if (backfillAdded) {
        const refetch = await fetchClientPackages();
        if (!refetch.error && refetch.data) {
          clientPackages = refetch.data;
        }
      }
    }

    // Fetch all package sessions to calculate completed_sessions accurately
    const { data: allPackageSessionsForCount, error: packageSessionsCountError } = await supabaseAdmin
      .from('sessions')
      .select('id, package_id, status')
      .eq('client_id', clientId)
      .not('package_id', 'is', null);

    // Group sessions by package_id and count completed and booked ones
    const completedCountsByPackage = {};
    const bookedCountsByPackage = {};
    if (!packageSessionsCountError && allPackageSessionsForCount) {
      allPackageSessionsForCount.forEach(session => {
        if (session.package_id) {
          if (session.status === 'completed') {
            completedCountsByPackage[session.package_id] = (completedCountsByPackage[session.package_id] || 0) + 1;
          } else if (session.status !== 'cancelled' && session.status !== 'no_show' && session.status !== 'noshow') {
            // Count booked/scheduled/rescheduled sessions (not completed, not cancelled, not no-show)
            bookedCountsByPackage[session.package_id] = (bookedCountsByPackage[session.package_id] || 0) + 1;
          }
        }
      });
    }

    const normalizedPackages = (clientPackages || []).map(pkg => {
      const totalSessions = deriveSessionCount(pkg);
      
      // Calculate completed_sessions by counting actual completed sessions
      const completedSessions = completedCountsByPackage[pkg.package_id] || 0;
      
      // Calculate booked (but not completed) sessions
      const bookedSessions = bookedCountsByPackage[pkg.package_id] || 0;
      
      // Calculate remaining_sessions for display: total - completed (sessions left to complete)
      // This is different from the database remaining_sessions which tracks sessions left to book
      const remainingSessionsForDisplay = Math.max(totalSessions - completedSessions, 0);
      
      // Calculate remaining_sessions_for_booking: total - completed - booked (sessions left to book)
      // This represents how many more sessions can be booked
      // total = completed + booked + remaining_for_booking
      // So: remaining_for_booking = total - completed - booked
      const remainingSessionsForBooking = Math.max(totalSessions - completedSessions - bookedSessions, 0);

      return {
        ...pkg,
        total_sessions: totalSessions,
        completed_sessions: completedSessions,
        remaining_sessions: remainingSessionsForDisplay, // For display: sessions left to complete
        remaining_sessions_for_booking: remainingSessionsForBooking, // For booking logic: sessions left to book (calculated from completed + booked)
        status: remainingSessionsForDisplay === 0 ? 'completed' : (pkg.status || 'active'),
        currency: pkg.currency || 'INR' // Default to INR (can be enhanced to fetch from payment later)
      };
    });

    res.json(
      successResponse({
        clientPackages: normalizedPackages
      })
    );

  } catch (error) {
    console.error('Error getting client packages:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching client packages')
    );
  }
};

// Book remaining session from package
const bookRemainingSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const { package_id, scheduled_date, scheduled_time } = req.body;

    console.log('🚀 Starting remaining session booking process...');
    console.log('   - Package ID:', package_id);
    console.log('   - Scheduled Date:', scheduled_date);
    console.log('   - Scheduled Time:', scheduled_time);

    // Validate required fields
    if (!package_id || !scheduled_date || !scheduled_time) {
      return res.status(400).json(
        errorResponse('Missing required fields: package_id, scheduled_date, scheduled_time')
      );
    }

    // Get client ID - use multi-strategy lookup (same pattern as getClientPackages)
    let clientId = null;

    // Priority: 1) client_id (from middleware), 2) user_id (new system), 3) id (old system fallback)
    if (req.user.client_id) {
      clientId = req.user.client_id;
    } else {
      // Try new system: lookup by user_id
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: clientByUserId, error: errorByUserId } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (clientByUserId && !errorByUserId) {
        clientId = clientByUserId.id;
      } else {
        // Fallback to old system: lookup by id (backward compatibility)
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { data: clientById, error: errorById } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', userId)
          .single();

        if (clientById && !errorById) {
          clientId = clientById.id;
        }
      }
    }

    if (!clientId) {
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    // Get client package and verify ownership
    const { data: clientPackage, error: packageError } = await supabaseAdmin
      .from('client_packages')
      .select(`
        *,
        package:packages(
          id,
          package_type,
          description,
          session_count,
          price,
          psychologist_id
        )
      `)
      .eq('id', package_id)
      .eq('client_id', clientId)
      .single();

    if (packageError || !clientPackage) {
      return res.status(404).json(
        errorResponse('Package not found or access denied')
      );
    }

    const totalSessionsCount = clientPackage.package?.session_count || 0;
    
    // Calculate remaining sessions based on actual completed and booked sessions (same logic as getClientPackages)
    const { data: packageSessionsForCheck, error: sessionsCountError } = await supabaseAdmin
      .from('sessions')
      .select('id, status')
      .eq('package_id', clientPackage.package.id)
      .eq('client_id', clientId);

    let completedCount = 0;
    let bookedCount = 0;
    
    if (!sessionsCountError && packageSessionsForCheck) {
      packageSessionsForCheck.forEach(session => {
        if (session.status === 'completed') {
          completedCount++;
        } else if (session.status !== 'cancelled' && session.status !== 'no_show' && session.status !== 'noshow') {
          // Count booked/scheduled/rescheduled sessions (not completed, not cancelled, not no-show)
          bookedCount++;
        }
      });
    }

    // Calculate remaining sessions for booking: total - completed - booked
    const remainingSessionsForBooking = Math.max(totalSessionsCount - completedCount - bookedCount, 0);

    // Check if package has remaining sessions to book
    if (remainingSessionsForBooking <= 0) {
      return res.status(400).json(
        errorResponse('No remaining sessions in this package')
      );
    }

    const psychologistId = clientPackage.package.psychologist_id;

    // Check if the time slot is available
    const isAvailable = await availabilityService.isTimeSlotAvailable(
      psychologistId, 
      scheduled_date, 
      scheduled_time
    );

    if (!isAvailable) {
      return res.status(400).json(
        errorResponse('This time slot is not available. Please select another time.')
      );
    }

    // Double-check: Verify slot isn't already booked in sessions table (race condition protection)
    const formattedDate = formatDate(scheduled_date);
    const formattedTime = formatTime(scheduled_time);
    const { data: existingSession, error: checkError } = await supabaseAdmin
      .from('sessions')
      .select('id, status')
      .eq('psychologist_id', psychologistId)
      .eq('scheduled_date', formattedDate)
      .eq('scheduled_time', formattedTime)
      .in('status', ['booked', 'scheduled', 'reschedule_requested', 'rescheduled'])
      .maybeSingle();

    if (checkError) {
      console.error('Error checking existing session:', checkError);
      return res.status(500).json(
        errorResponse('Error verifying slot availability')
      );
    }

    if (existingSession) {
      console.log('⚠️ Slot already booked - race condition detected');
      return res.status(409).json(
        errorResponse('This time slot was just booked by another user. Please select another time.')
      );
    }

    // Get client and psychologist details for Google Calendar
    const { data: clientDetails, error: clientDetailsError } = await supabaseAdmin
      .from('clients')
      .select(`
        first_name, 
        last_name, 
        child_name,
        phone_number,
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

    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: psychologistDetails, error: psychologistDetailsError } = await supabaseAdmin
      .from('psychologists')
      .select('first_name, last_name, email')
      .eq('id', psychologistId)
      .single();

    if (psychologistDetailsError || !psychologistDetails) {
      console.error('Error fetching psychologist details:', psychologistDetailsError);
      return res.status(500).json(
        errorResponse('Failed to fetch psychologist details')
      );
    }

    // Create session record first (use fallback Meet link initially to prevent timeout)
    // Meet link will be created asynchronously after response is sent
    const fallbackMeetLink = 'https://meet.google.com/new?hs=122&authuser=0';
    
    const sessionData = {
      client_id: clientId,
      psychologist_id: psychologistId,
      package_id: clientPackage.package.id,
      scheduled_date: formatDate(scheduled_date),
      scheduled_time: formatTime(scheduled_time),
      status: 'booked',
      google_calendar_event_id: null, // Will be updated async
      google_meet_link: fallbackMeetLink, // Fallback initially, will be updated async
      google_calendar_link: null, // Will be updated async
      price: 0, // Free since it's from a package
      original_scheduled_date: formatDate(scheduled_date)
    };

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (sessionError) {
      console.error('Session creation failed:', sessionError);
      
      // Check if it's a duplicate key violation (double booking)
      if (sessionError.code === '23505' || 
          sessionError.message?.includes('unique') || 
          sessionError.message?.includes('duplicate')) {
        console.log('⚠️ Double booking detected - slot was just booked by another user');
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

    // Calculate completed sessions by counting actual completed sessions from database
    // This ensures accuracy regardless of package size (3, 6, 8, etc.)
    const { data: packageSessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select('id, status')
      .eq('package_id', clientPackage.package.id)
      .eq('client_id', clientId);

    const completedSessions = (!sessionsError && packageSessions)
      ? packageSessions.filter(s => s.status === 'completed').length
      : 0;

    // Update remaining sessions in client package
    const { error: updateError } = await supabaseAdmin
      .from('client_packages')
      .update({
        remaining_sessions: updatedRemaining,
        updated_at: new Date().toISOString()
      })
      .eq('id', package_id);

    if (updateError) {
      console.error('Failed to update remaining sessions:', updateError);
      // Continue even if update fails
    }

    // Prepare names for notifications
    const clientName = clientDetails.child_name || 
                      `${clientDetails.first_name} ${clientDetails.last_name}`.trim();
    const psychologistName = `${psychologistDetails.first_name} ${psychologistDetails.last_name}`.trim();

    // Package information for notifications
    const packageInfo = {
      totalSessions: totalSessions,
      completedSessions: completedSessions,
      remainingSessions: updatedRemaining,
      packageType: clientPackage.package?.package_type || null
    };

    // Send response immediately (don't wait for Meet link or notifications)
    res.json(
      successResponse({
        session,
        message: 'Session booked successfully',
        packageInfo: {
          totalSessions,
          completedSessions,
          remainingSessions: updatedRemaining
        }
      })
    );
    
    // All remaining code runs asynchronously (after response is sent)
    // Use setImmediate to ensure response is sent first
    setImmediate(async () => {
      try {
        // Create Meet link asynchronously (after response is sent - doesn't block user)
        console.log('🔄 Creating real Google Meet link for package session (async)...');
        
        const meetSessionData = {
          summary: `Therapy Session - ${clientDetails?.child_name || clientDetails?.first_name || 'Client'} with ${psychologistDetails?.first_name || 'Psychologist'}`,
          description: `Therapy session between ${clientDetails?.child_name || clientDetails?.first_name || 'Client'} and ${psychologistDetails?.first_name || 'Psychologist'} ${psychologistDetails?.last_name || ''}`,
          startDate: scheduled_date,
          startTime: scheduled_time,
          endTime: addMinutesToTime(scheduled_time, 50) // 50-minute session
        };

        // Try to get psychologist OAuth tokens for better Meet link creation
        let userAuth = null;
        const { data: psychologistWithAuth } = await supabaseAdmin
          .from('psychologists')
          .select('google_calendar_credentials')
          .eq('id', psychologistId)
          .single();

        if (psychologistWithAuth?.google_calendar_credentials) {
          const credentials = psychologistWithAuth.google_calendar_credentials;
          userAuth = {
            access_token: credentials.access_token,
            refresh_token: credentials.refresh_token,
            expiry_date: credentials.expiry_date
          };
          console.log('✅ Using psychologist OAuth tokens for Meet link creation');
        }

        const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
        
        if (meetResult.success) {
          const meetData = {
            meetLink: meetResult.meetLink,
            eventId: meetResult.eventId,
            calendarLink: meetResult.eventLink || null,
            method: meetResult.method
          };
          console.log('✅ Real Meet link created successfully (async):', meetResult);
          
          // Update session with real Meet link
          await supabaseAdmin
            .from('sessions')
            .update({
              google_calendar_event_id: meetData.eventId,
              google_meet_link: meetData.meetLink,
              google_meet_join_url: meetData.meetLink,
              google_meet_start_url: meetData.meetLink,
              google_calendar_link: meetData.calendarLink,
              updated_at: new Date().toISOString()
            })
            .eq('id', session.id);
          
          console.log('✅ Session updated with real Meet link');
        } else {
          console.log('⚠️ Meet link creation failed (async), keeping fallback');
        }

        // Send email notifications (use fallback link initially)
        try {
          const emailService = require('../utils/emailService');

          await emailService.sendSessionConfirmation({
            clientEmail: clientDetails.user?.email || clientDetails.email || 'client@placeholder.com',
            psychologistEmail: psychologistDetails?.email || 'psychologist@placeholder.com',
            clientName,
            psychologistName,
            sessionId: session.id,
            scheduledDate: scheduled_date,
            scheduledTime: scheduled_time,
            meetLink: fallbackMeetLink, // Will be updated async if real link is created
            price: null, // null for package sessions (already paid as part of package)
            status: 'booked',
            psychologistId: psychologistId,
            clientId: clientId,
            packageInfo: packageInfo
          });
          console.log('✅ Email notifications sent successfully');
        } catch (emailError) {
          console.error('❌ Error sending email notifications:', emailError);
          // Continue even if email fails
        }

        // Send WhatsApp messages to client and psychologist via UltraMsg
        try {
          console.log('📱 Sending WhatsApp notifications via UltraMsg API...');
          const { sendBookingConfirmation, sendWhatsAppTextWithRetry } = require('../utils/whatsappService');

          // Send WhatsApp to client
          const clientPhone = clientDetails.phone_number || null;
          if (clientPhone && fallbackMeetLink) {
            // Only include childName if child_name exists and is not empty/null/'Pending'
            const childName = clientDetails.child_name && 
              clientDetails.child_name.trim() !== '' && 
              clientDetails.child_name.toLowerCase() !== 'pending'
              ? clientDetails.child_name 
              : null;
            
            const clientDetails_wa = {
              childName: childName,
              date: scheduled_date,
              time: scheduled_time,
              meetLink: fallbackMeetLink, // Will be updated async if real link is created
              psychologistName: psychologistName,
              packageInfo: packageInfo
            };
            const clientWaResult = await sendBookingConfirmation(clientPhone, clientDetails_wa);
            if (clientWaResult?.success) {
              console.log('✅ WhatsApp confirmation sent to client via UltraMsg');
            } else if (clientWaResult?.skipped) {
              console.log('ℹ️ Client WhatsApp skipped:', clientWaResult.reason);
            } else {
              console.warn('⚠️ Client WhatsApp send failed');
            }
          } else {
            console.log('ℹ️ No client phone or meet link; skipping client WhatsApp');
          }

          // Send WhatsApp to psychologist
          const psychologistPhone = psychologistDetails.phone || null;
          if (psychologistPhone && fallbackMeetLink) {
            // Format date and time using the same functions as client messages
            const { formatFriendlyTime } = require('../utils/whatsappService');
            const formatBookingDateShort = (dateStr) => {
              if (!dateStr) return '';
              try {
                const d = new Date(`${dateStr}T00:00:00+05:30`);
                return d.toLocaleDateString('en-IN', {
                  weekday: 'short',
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  timeZone: 'Asia/Kolkata'
                });
              } catch {
                return dateStr;
              }
            };
            
            const bullet = '•⁠  ⁠';
            const formattedDate = formatBookingDateShort(scheduled_date);
            const formattedTime = formatFriendlyTime(scheduled_time);
            const supportPhone = process.env.SUPPORT_PHONE || process.env.COMPANY_PHONE || '+91 95390 07766';
            
            // Package line (only for package sessions)
            let packageLine = '';
            if (packageInfo && packageInfo.totalSessions) {
              const total = packageInfo.totalSessions || 0;
              const completed = packageInfo.completedSessions || 0;
              const remaining = packageInfo.remainingSessions || 0;
              packageLine = `${bullet}Package: ${completed}/${total} sessions completed, ${remaining} remaining\n`;
            }
            
            const psychologistMessage =
              `Hey 👋\n\n` +
              `New session booked with Little Care.\n\n` +
              `${bullet}Client: ${clientName}\n` +
              packageLine +
              `${bullet}Date: ${formattedDate}\n` +
              `${bullet}Time: ${formattedTime} (IST)\n\n` +
              `Join link:\n${fallbackMeetLink}\n\n` +
              `Please be ready 5 mins early.\n\n` +
              `For help: ${supportPhone}\n\n` +
              `— Little Care 💜`;
            
            const psychologistWaResult = await sendWhatsAppTextWithRetry(psychologistPhone, psychologistMessage);
            if (psychologistWaResult?.success) {
              console.log('✅ WhatsApp notification sent to psychologist via UltraMsg');
            } else if (psychologistWaResult?.skipped) {
              console.log('ℹ️ Psychologist WhatsApp skipped:', psychologistWaResult.reason);
            } else {
              console.warn('⚠️ Psychologist WhatsApp send failed');
            }
          } else {
            console.log('ℹ️ No psychologist phone or meet link; skipping psychologist WhatsApp');
          }
          
          console.log('✅ WhatsApp messages sent successfully via UltraMsg');
        } catch (waError) {
          console.error('❌ Error sending WhatsApp messages:', waError);
          // Continue even if WhatsApp sending fails
        }

        console.log('✅ Remaining session booked successfully');
        // PRIORITY: Check and send reminder immediately if remaining session booking is 2 hours away
        // This gives new bookings priority over batch reminder processing
        try {
          const sessionReminderService = require('../services/sessionReminderService');
          // Run asynchronously to not block the response
          sessionReminderService.checkAndSendReminderForSessionId(session.id).catch(err => {
            console.error('❌ Error in priority reminder check:', err);
            // Don't block response - reminder will be sent in next hourly check
          });
        } catch (reminderError) {
          console.error('❌ Error initiating priority reminder check:', reminderError);
          // Don't block response
        }
      } catch (asyncError) {
        console.error('❌ Error in async post-booking operations:', asyncError);
      }
    });

  } catch (error) {
    console.error('Error booking remaining session:', error);
    res.status(500).json(
      errorResponse('Internal server error while booking session')
    );
  }
};

// Reserve a time slot for payment (without creating session)
const reserveTimeSlot = async (req, res) => {
  try {
    const userId = req.user.id;
    const { psychologist_id, scheduled_date, scheduled_time, package_id } = req.body;

    console.log('🔍 Step 1: Client validation');
    // Get client by user_id (new system); fallback to id (legacy)
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (clientError || !client) {
      const fallback = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('id', userId)
        .single();
      client = fallback.data;
      clientError = fallback.error;
    }

    if (clientError || !client) {
      console.log('❌ Client not found');
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    const clientId = client.id;
    console.log('   - Client ID:', clientId);
    console.log('   - User ID:', userId);
    console.log('   - User Role:', req.user.role);

    // Check if time slot is available
    console.log('🔍 Step 2: Checking time slot availability...');
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: existingSessions } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', scheduled_date)
      .eq('scheduled_time', scheduled_time)
      .eq('status', 'booked');

    if (existingSessions && existingSessions.length > 0) {
      console.log('❌ Time slot already booked');
      return res.status(400).json(
        errorResponse('This time slot is already booked')
      );
    }

    console.log('✅ Time slot is available');

    // Get psychologist details first (needed for psychiatrist 15/30 min pricing)
    const { data: psychologistDetails } = await supabaseAdmin
      .from('psychologists')
      .select('*')
      .eq('id', psychologist_id)
      .single();

    if (!psychologistDetails) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    const isPsychiatrist = (psychologistDetails.designation || '').toLowerCase().includes('psychiatrist');

    // Get package details for pricing (skip DB lookup for psychiatrist virtual package IDs)
    let package = null;
    const psychiatristVirtualIds = ['individual-15', 'individual-30'];
    if (package_id && package_id !== 'individual' && !psychiatristVirtualIds.includes(package_id)) {
      console.log('🔍 Looking up package with ID:', package_id);
      const { data: packageData, error: packageError } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('id', package_id)
        .single();
      
      if (packageError) {
        console.error('❌ Package lookup error:', packageError);
        return res.status(404).json(
          errorResponse(`Package not found: ${packageError.message || 'Invalid package ID'}`)
        );
      }
      
      if (!packageData) {
        console.error('❌ Package not found for ID:', package_id);
        return res.status(404).json(
          errorResponse('Selected package not found. Please select a valid package.')
        );
      }
      
        package = packageData;
      console.log('✅ Package found:', {
        id: package.id,
        name: package.name,
        price: package.price,
        session_count: package.session_count
      });
      
      // Validate package has a price
      if (!package.price || package.price <= 0) {
        console.error('❌ Package price is missing or invalid:', package.price);
        return res.status(400).json(
          errorResponse('Selected package has an invalid price. Please contact support.')
        );
      }
    } else if (psychiatristVirtualIds.includes(package_id)) {
      console.log('ℹ️ Psychiatrist individual session (15 or 30 min) selected');
    } else {
      console.log('ℹ️ Individual session selected');
    }

    // Determine price - no fallback, must be explicit
    let price = null;
    
    if (package) {
      // Package booking - use package price
      price = package.price;
      console.log('💰 Using package price:', price);
    } else if (package_id === 'individual-15' && isPsychiatrist) {
      // Psychiatrist 15 min session
      const p = psychologistDetails.psychiatrist_15min_price ?? psychologistDetails.price;
      price = p != null ? parseFloat(p) : null;
      console.log('💰 Using psychiatrist_15min_price:', price);
    } else if (package_id === 'individual-30' && isPsychiatrist) {
      // Psychiatrist 30 min session
      const p = psychologistDetails.psychiatrist_30min_price ?? psychologistDetails.price;
      price = p != null ? parseFloat(p) : null;
      console.log('💰 Using psychiatrist_30min_price:', price);
    } else {
      // Individual session (non-psychiatrist or generic individual)
      if (psychologistDetails.individual_session_price) {
        price = parseFloat(psychologistDetails.individual_session_price);
        console.log('✅ Using individual_session_price field:', price);
      } else if (psychologistDetails.description) {
        const priceMatch = psychologistDetails.description.match(/Individual Session Price: [₹\$](\d+(?:\.\d+)?)/);
        if (priceMatch) {
          price = parseFloat(priceMatch[1]);
          console.log('✅ Extracted individual price from description:', price);
        }
      }

      // Validate individual session price
      if (!price || price <= 0 || isNaN(price)) {
        console.error('❌ Individual session price is missing or invalid:', {
          individual_session_price: psychologistDetails.individual_session_price,
          psychiatrist_15min_price: psychologistDetails.psychiatrist_15min_price,
          psychiatrist_30min_price: psychologistDetails.psychiatrist_30min_price,
          hasDescription: !!psychologistDetails.description
        });
        return res.status(400).json(
          errorResponse('Individual session price is not configured. Please select a package or contact support.')
        );
      }
    }
    
    // Final validation - price must be valid
    if (!price || price <= 0 || isNaN(price)) {
      console.error('❌ Final price validation failed:', price);
      return res.status(400).json(
        errorResponse('Unable to determine session price. Please contact support.')
      );
    }
    
    console.log('💰 Final price:', price);

    res.json({
      success: true,
      data: {
        clientId: clientId,
        psychologistId: psychologist_id,
        scheduledDate: scheduled_date,
        scheduledTime: scheduled_time,
        packageId: package_id,
        price: price,
        package: package,
        psychologist: psychologistDetails
      }
    });

  } catch (error) {
    console.error('❌ Reserve time slot error:', error);
    res.status(500).json(
      errorResponse('Internal server error while reserving time slot')
    );
  }
};

// Get free assessment availability for rescheduling
const getFreeAssessmentAvailabilityForReschedule = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    console.log('📅 Fetching free assessment availability for reschedule');
    console.log('   - Session ID:', sessionId);
    console.log('   - User ID:', userId);

    // Get client ID - userId is from users.id, so we need to query clients.user_id
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!client) {
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    // Get existing session and verify ownership
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('client_id', client.id)
      .single();

    if (sessionError || !session) {
      return res.status(404).json(
        errorResponse('Session not found or access denied')
      );
    }

    // Check if this is a free assessment session
    if (session.session_type !== 'free_assessment') {
      return res.status(400).json(
        errorResponse('This endpoint is only for free assessment sessions')
      );
    }

    // Get current date and next 30 days
    const currentDate = new Date();
    const endDate = new Date();
    endDate.setDate(currentDate.getDate() + 30);

    // Fetch free assessment availability for the next 30 days
    const { data: dateConfigs, error: configError } = await supabaseAdmin
      .from('free_assessment_date_configs')
      .select('date, time_slots')
      .gte('date', currentDate.toISOString().split('T')[0])
      .lte('date', endDate.toISOString().split('T')[0])
      .order('date', { ascending: true });

    if (configError) {
      console.error('Error fetching free assessment configs:', configError);
      return res.status(500).json(
        errorResponse('Failed to fetch free assessment availability')
      );
    }

    console.log('📅 Fetched date configs:', dateConfigs);
    console.log('📅 Sample time_slots structure:', dateConfigs?.[0]?.time_slots);

    // Process availability data
    const availabilityData = {};
    
    for (const config of dateConfigs || []) {
      const date = config.date;
      const timeSlotsObj = config.time_slots || {};
      
      // Convert the object structure to a flat array of time slots
      let allTimeSlots = [];
      
      // Extract time slots from all categories
      Object.values(timeSlotsObj).forEach(categorySlots => {
        if (Array.isArray(categorySlots)) {
          allTimeSlots = allTimeSlots.concat(categorySlots);
        }
      });
      
      console.log(`📅 Date ${date} - All time slots:`, allTimeSlots);
      
      // Skip if no time slots available
      if (allTimeSlots.length === 0) {
        continue;
      }
      
      // Get existing bookings for this date
      const { data: bookedSessions } = await supabaseAdmin
        .from('sessions')
        .select('scheduled_time')
        .eq('scheduled_date', date)
        .eq('session_type', 'free_assessment')
        .in('status', ['booked', 'rescheduled', 'confirmed']);

      const { data: bookedAssessments } = await supabaseAdmin
        .from('free_assessments')
        .select('scheduled_time')
        .eq('scheduled_date', date)
        .eq('status', 'booked');

      // Count bookings per time slot
      const bookingCounts = {};
      
      // Count session bookings
      bookedSessions?.forEach(booking => {
        bookingCounts[booking.scheduled_time] = (bookingCounts[booking.scheduled_time] || 0) + 1;
      });

      // Count assessment bookings
      bookedAssessments?.forEach(booking => {
        bookingCounts[booking.scheduled_time] = (bookingCounts[booking.scheduled_time] || 0) + 1;
      });

      // Filter available slots
      const availableSlots = allTimeSlots
        .filter(timeSlot => {
          const currentBookings = bookingCounts[timeSlot] || 0;
          return currentBookings < 20; // Max 20 bookings per slot
        })
        .map(timeSlot => ({
          time: timeSlot,
          displayTime: timeSlot,
          availableBookings: 20 - (bookingCounts[timeSlot] || 0),
          maxBookings: 20,
          currentBookings: bookingCounts[timeSlot] || 0
        }));

      if (availableSlots.length > 0) {
        availabilityData[date] = {
          availableSlots: availableSlots.length,
          totalSlots: allTimeSlots.length,
          slots: availableSlots
        };
      }
    }

    console.log('✅ Free assessment availability fetched successfully');
    
    res.json(
      successResponse({
        session: session,
        availability: availabilityData,
        dateRange: {
          start: currentDate.toISOString().split('T')[0],
          end: endDate.toISOString().split('T')[0]
        }
      })
    );

  } catch (error) {
    console.error('Get free assessment availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching availability')
    );
  }
};

/**
 * Book a session using an existing payment credit (no new payment).
 * Expects: transaction_id, scheduled_date, scheduled_time, psychologist_id (must match credit).
 */
const bookSessionWithCredit = async (req, res) => {
  try {
    const { psychologist_id, scheduled_date, scheduled_time, transaction_id } = req.body;

    if (!psychologist_id || !scheduled_date || !scheduled_time || !transaction_id) {
      return res.status(400).json(
        errorResponse('Missing required fields: psychologist_id, scheduled_date, scheduled_time, transaction_id')
      );
    }

    const userId = req.user.id;
    const userRole = req.user.role;

    if (userRole !== 'client') {
      return res.status(403).json(
        errorResponse('Only clients can book sessions')
      );
    }

    // Get client profile: try user_id first (new system), then id (legacy)
    let client = null;
    let clientError = null;
    const { data: clientByUserId, error: errorByUserId } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .single();
    if (clientByUserId && !errorByUserId) {
      client = clientByUserId;
    } else {
      const { data: clientById, error: errorById } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('id', userId)
        .single();
      if (clientById && !errorById) {
        client = clientById;
      } else {
        clientError = errorByUserId || errorById;
      }
    }

    if (clientError || !client) {
      console.error('Client profile not found:', clientError);
      return res.status(404).json(
        errorResponse('Client profile not found. Please complete your profile first.')
      );
    }

    const clientId = client.id;

    // Look up the payment credit
    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('transaction_id', transaction_id)
      .eq('client_id', clientId)
      .single();

    if (paymentError || !payment) {
      console.error('Payment credit not found:', paymentError);
      return res.status(404).json(
        errorResponse('Payment credit not found')
      );
    }

    // Credit is valid only if payment is still pending, has a Razorpay payment id and no session yet
    if (payment.status !== 'pending' || !payment.razorpay_payment_id || payment.session_id) {
      return res.status(400).json(
        errorResponse('This payment credit has already been used or is not available')
      );
    }

    if (payment.psychologist_id !== psychologist_id) {
      return res.status(400).json(
        errorResponse('This payment credit is not valid for the selected psychologist')
      );
    }

    // Check time slot availability
    console.log('🔍 Checking time slot availability for credit booking...');
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

    console.log('✅ Time slot is available for credit booking');

    // Pre-check: Verify slot isn't already booked in sessions table (race condition protection)
    const formattedDate = formatDate(scheduled_date);
    const formattedTime = formatTime(scheduled_time);
    const { data: existingSession, error: checkError } = await supabaseAdmin
      .from('sessions')
      .select('id, status')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', formattedDate)
      .eq('scheduled_time', formattedTime)
      .in('status', ['booked', 'scheduled', 'reschedule_requested', 'rescheduled'])
      .maybeSingle();

    if (checkError) {
      console.error('Error checking existing session:', checkError);
      return res.status(500).json(
        errorResponse('Error verifying slot availability')
      );
    }

    if (existingSession) {
      console.log('⚠️ Slot already booked - race condition detected');
      return res.status(409).json(
        errorResponse('This time slot was just booked by another user. Please select another time.')
      );
    }

    // Fetch client and psychologist details for meet link
    const { data: clientDetails, error: clientDetailsError } = await supabaseAdmin
      .from('clients')
      .select(`
        first_name, 
        last_name, 
        child_name,
        phone_number,
        user:users(email)
      `)
      .eq('id', clientId)
      .single();

    if (clientDetailsError || !clientDetails) {
      console.error('Error fetching client details for credit booking:', clientDetailsError);
      return res.status(500).json(
        errorResponse('Failed to fetch client details')
      );
    }

    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: psychologistDetails, error: psychologistDetailsError } = await supabaseAdmin
      .from('psychologists')
      .select('first_name, last_name, email, phone')
      .eq('id', psychologist_id)
      .single();

    if (psychologistDetailsError || !psychologistDetails) {
      console.error('Error fetching psychologist details for credit booking:', psychologistDetailsError);
      return res.status(500).json(
        errorResponse('Failed to fetch psychologist details')
      );
    }

    // Create Google Meet link (same as normal booking)
    let meetData = null;
    try {
      const sessionData = {
        summary: `Therapy Session - ${clientDetails?.child_name || 'Client'} with ${psychologistDetails?.first_name || 'Psychologist'}`,
        description: `Therapy session between ${clientDetails?.child_name || 'Client'} and ${psychologistDetails?.first_name || 'Psychologist'}`,
        startDate: scheduled_date,
        startTime: scheduled_time,
        endTime: addMinutesToTime(scheduled_time, 50)
      };

      const meetResult = await meetLinkService.generateSessionMeetLink(sessionData);
      if (meetResult.success) {
        meetData = {
          meetLink: meetResult.meetLink,
          eventId: meetResult.eventId,
          calendarLink: meetResult.eventLink || null,
          method: meetResult.method
        };
      } else {
        meetData = {
          meetLink: meetResult.meetLink,
          eventId: null,
          calendarLink: null,
          method: meetResult.method || 'fallback'
        };
      }
    } catch (meetError) {
      console.error('⚠️ Error creating Google Meet link for credit booking:', meetError);
    }

    // Create session using the existing payment (formatted date/time already computed above)
    const sessionInsert = {
      client_id: clientId,
      psychologist_id: psychologist_id,
      scheduled_date: formattedDate,
      scheduled_time: formattedTime,
      status: 'booked',
      price: payment.amount,
      payment_id: payment.id,
      original_scheduled_date: formattedDate
    };

    if (meetData) {
      sessionInsert.google_meet_link = meetData.meetLink;
      // Some deployments may not have a separate google_meet_event_id column; 
      // we only store the meet link here to keep compatibility.
    }

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionInsert])
      .select('*')
      .single();

    if (sessionError) {
      console.error('❌ Session creation failed for credit booking:', sessionError);
      // Unique constraint violation (23505): slot/session already exists; return existing session idempotently
      if (sessionError.code === '23505') {
        const { data: existingSession, error: fetchErr } = await supabaseAdmin
          .from('sessions')
          .select('*')
          .eq('client_id', clientId)
          .eq('psychologist_id', psychologist_id)
          .eq('scheduled_date', formattedDate)
          .eq('scheduled_time', formattedTime)
          .maybeSingle();
        if (!fetchErr && existingSession) {
          return res.json(
            successResponse(
              { sessionId: existingSession.id, paymentId: payment.id },
              'Session already exists for this slot (idempotent)'
            )
          );
        }
      }
      return res.status(500).json(
        errorResponse('Failed to create session with existing payment. Please contact support.')
      );
    }

    // Mark payment as fully used
    const { error: updateError } = await supabaseAdmin
      .from('payments')
      .update({
        status: 'success',
        session_id: session.id
      })
      .eq('id', payment.id);

    if (updateError) {
      console.error('⚠️ Failed to update payment status after credit booking:', updateError);
    }

    // Block the booked slot from availability (mirror bookSession)
    try {
      await availabilityService.updateAvailabilityOnBooking(
        psychologist_id,
        formattedDate,
        formattedTime
      );
      console.log('✅ Availability updated to block booked slot for credit booking');
    } catch (blockErr) {
      console.warn('⚠️ Failed to update availability after credit booking:', blockErr?.message);
    }

    // Send email + WhatsApp notifications (mirror bookSession)
    try {
      const emailService = require('../utils/emailService');
      const clientName = clientDetails.child_name ||
        `${clientDetails.first_name || ''} ${clientDetails.last_name || ''}`.trim() || 'Client';
      const psychologistName = `${psychologistDetails.first_name || ''} ${psychologistDetails.last_name || ''}`.trim() || 'Psychologist';

      await emailService.sendSessionConfirmation({
        clientEmail: clientDetails.user?.email || 'client@placeholder.com',
        psychologistEmail: psychologistDetails?.email || 'psychologist@placeholder.com',
        clientName,
        psychologistName,
        sessionId: session.id,
        scheduledDate: formattedDate,
        scheduledTime: formattedTime,
        meetLink: meetData?.meetLink || 'https://meet.google.com/new',
        price: session.price
      });
      console.log('✅ Email notifications sent for credit booking');

      try {
        const { sendBookingConfirmation } = require('../utils/whatsappService');
        const clientPhone = clientDetails.phone_number || null;
        if (clientPhone && meetData?.meetLink) {
          const childName = clientDetails.child_name &&
            clientDetails.child_name.trim() !== '' &&
            clientDetails.child_name.toLowerCase() !== 'pending'
            ? clientDetails.child_name
            : null;
          await sendBookingConfirmation(clientPhone, {
            childName,
            date: formattedDate,
            time: formattedTime,
            meetLink: meetData.meetLink,
            psychologistName
          });
        }
      } catch (waErr) {
        console.warn('⚠️ WhatsApp notification skipped for credit booking:', waErr?.message);
      }
    } catch (notifyErr) {
      console.warn('⚠️ Notification error for credit booking:', notifyErr?.message);
    }

    // Log successful booking
    await userInteractionLogger.logBooking({
      userId: req.user.id,
      userRole: req.user.role,
      psychologistId: psychologist_id,
      packageId: payment.package_id,
      scheduledDate: scheduled_date,
      scheduledTime: scheduled_time,
      price: payment.amount,
      status: 'success',
      sessionId: session.id,
      paymentId: payment.id
    });

    return res.json(
      successResponse(
        {
          sessionId: session.id,
          paymentId: payment.id
        },
        'Session booked successfully using existing payment'
      )
    );
  } catch (error) {
    console.error('Book session with credit error:', error);
    
    // Log failed booking (no await so .catch() handles rejection and response is always sent)
    userInteractionLogger.logBooking({
      userId: req.user?.id,
      userRole: req.user?.role,
      psychologistId: req.body?.psychologist_id,
      packageId: req.body?.package_id,
      scheduledDate: req.body?.scheduled_date,
      scheduledTime: req.body?.scheduled_time,
      price: null,
      status: 'failure',
      error: error
    }).catch(logErr => {
      console.error('Failed to log booking failure:', logErr);
    });
    
    res.status(500).json(
      errorResponse('Internal server error while booking session with existing payment')
    );
  }
};

module.exports = {
  getProfile,
  updateProfile,
  getSessions,
  getSession,
  bookSession,
  cancelSession,
  getAvailablePsychologists,
  getPsychologistPackages,
  requestReschedule,
  rescheduleSession,
  submitSessionFeedback,
  getClientPackages,
  bookRemainingSession,
  reserveTimeSlot,
  getFreeAssessmentAvailabilityForReschedule,
  reserveAssessmentSlot,
  bookAssessment,
  getAssessmentSessions,
  getPaymentCredit,
  bookSessionWithCredit
};
