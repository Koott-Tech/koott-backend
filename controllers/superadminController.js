const { supabaseAdmin } = require('../config/supabase');
const { 
  successResponse, 
  errorResponse,
  hashPassword
} = require('../utils/helpers');
const { validatePassword } = require('../utils/passwordPolicy');
const auditLogger = require('../utils/auditLogger');

// Create admin user
const createAdmin = async (req, res) => {
  try {
    let { email, password, first_name, last_name } = req.body;

    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json(
        errorResponse('Email, password, first name, and last name are required')
      );
    }

    // SECURITY FIX: Validate and normalize email
    email = email.trim().toLowerCase();
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return res.status(400).json(
        errorResponse('Valid email address is required')
      );
    }

    // SECURITY FIX: Validate password policy BEFORE hashing
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json(
        errorResponse('Password does not meet requirements', passwordValidation.errors)
      );
    }

    // Check if user already exists (use normalized email)
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

    // Hash password (after validation)
    const hashedPassword = await hashPassword(password);

    // Create admin user
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert([{
        email,
        password_hash: hashedPassword,
        role: 'admin'
      }])
      .select('id, email, role, created_at')
      .single();

    if (userError) {
      console.error('Create admin user error:', userError);
      return res.status(500).json(
        errorResponse('Failed to create admin user')
      );
    }

    // SECURITY FIX: Audit log admin creation (with error handling for resilience)
    auditLogger.logRequest(req, 'CREATE_ADMIN', 'user', user.id, {
      target_user_email: user.email,
      target_user_role: user.role,
      created_by: req.user.id,
      created_by_email: req.user.email
    }).catch(err => {
      console.error('Failed to log CREATE_ADMIN audit:', err);
      // Don't throw - audit logging failure shouldn't break the request
    });

    res.status(201).json(
      successResponse(user, 'Admin user created successfully')
    );

  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json(
      errorResponse('Internal server error while creating admin user')
    );
  }
};

// Delete user (superadmin only)
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // CRITICAL FIX: TOCTOU protection - Re-verify superadmin role from DB before operation
    const { data: freshSuperAdminUser } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (!freshSuperAdminUser || freshSuperAdminUser.role !== 'superadmin') {
      return res.status(403).json(
        errorResponse('Privilege revoked. Superadmin access required.')
      );
    }

    // Check if user exists - store role and email for audit log
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, role, email')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json(
        errorResponse('User not found')
      );
    }

    // Prevent deleting superadmin
    if (user.role === 'superadmin') {
      return res.status(403).json(
        errorResponse('Cannot delete superadmin user')
      );
    }

    // Store user info for audit log before deletion
    const deletedUserRole = user.role;
    const deletedUserEmail = user.email;

    // If client, delete all related data first
    if (user.role === 'client') {
      // Find client record (for new system, client.id != user.id)
      const { data: clientRecord } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();

      // Explicitly handle null clientRecord
      if (!clientRecord) {
        console.error(`❌ Client record not found for user_id: ${userId}`);
        return res.status(404).json(
          errorResponse('Client profile not found for this user')
        );
      }

      const clientId = clientRecord.id;

      console.log(`🗑️  Deleting all related data for client_id: ${clientId}`);

      // Validate clientId format before proceeding
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!clientId || !uuidRegex.test(clientId)) {
        return res.status(400).json(errorResponse('Invalid client ID format'));
      }

      // Use RPC function for atomic transaction-based cascade delete
      // Falls back to sequential deletes if RPC doesn't exist
      const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('delete_client_cascade', {
        p_client_id: clientId
      });

      if (rpcError) {
        if (rpcError.code === '42883') {
          // Function doesn't exist - fallback to sequential deletes
          console.warn('⚠️ delete_client_cascade RPC function not found; falling back to non-atomic deletes. Run the DB migration or contact DBA to create this function.');
          
          // Fallback: sequential deletes (not atomic, but better than nothing)
          // 1. Delete messages (via conversations)
          const { data: conversations, error: conversationsError } = await supabaseAdmin
            .from('conversations')
            .select('id')
            .eq('client_id', clientId);

          if (conversationsError) {
            console.error('❌ Error fetching conversations:', conversationsError);
            return res.status(500).json(errorResponse('Failed to fetch conversations for deletion'));
          }

          if (conversations && conversations.length > 0) {
            const conversationIds = conversations.map(c => c.id);
            const { error: messagesDeleteError } = await supabaseAdmin
              .from('messages')
              .delete()
              .in('conversation_id', conversationIds);
            if (messagesDeleteError) {
              console.error('❌ Error deleting messages:', messagesDeleteError);
              return res.status(500).json(errorResponse('Failed to delete messages'));
            }
          }

          // 2. Delete conversations
          const { error: conversationsDeleteError } = await supabaseAdmin
            .from('conversations')
            .delete()
            .eq('client_id', clientId);
          if (conversationsDeleteError) {
            console.error('❌ Error deleting conversations:', conversationsDeleteError);
            return res.status(500).json(errorResponse('Failed to delete conversations'));
          }

          // 3. Delete receipts (via sessions)
          const { data: sessions, error: sessionsError } = await supabaseAdmin
            .from('sessions')
            .select('id')
            .eq('client_id', clientId);

          if (sessionsError) {
            console.error('❌ Error fetching sessions:', sessionsError);
            return res.status(500).json(errorResponse('Failed to fetch sessions for deletion'));
          }

          if (sessions && sessions.length > 0) {
            const sessionIds = sessions.map(s => s.id);
            const { error: receiptsDeleteError } = await supabaseAdmin
              .from('receipts')
              .delete()
              .in('session_id', sessionIds);
            if (receiptsDeleteError) {
              console.error('❌ Error deleting receipts:', receiptsDeleteError);
              return res.status(500).json(errorResponse('Failed to delete receipts'));
            }
          }

          // 4. Delete payments
          const { error: paymentsDeleteError } = await supabaseAdmin
            .from('payments')
            .delete()
            .eq('client_id', clientId);
          if (paymentsDeleteError) {
            console.error('❌ Error deleting payments:', paymentsDeleteError);
            return res.status(500).json(errorResponse('Failed to delete payments'));
          }

          // 5. Delete sessions
          const { error: sessionsDeleteError } = await supabaseAdmin
            .from('sessions')
            .delete()
            .eq('client_id', clientId);
          if (sessionsDeleteError) {
            console.error('❌ Error deleting sessions:', sessionsDeleteError);
            return res.status(500).json(errorResponse('Failed to delete sessions'));
          }

          // 6. Delete assessment sessions
          const { error: assessmentSessionsDeleteError } = await supabaseAdmin
            .from('assessment_sessions')
            .delete()
            .eq('client_id', clientId);
          if (assessmentSessionsDeleteError) {
            console.error('❌ Error deleting assessment sessions:', assessmentSessionsDeleteError);
            return res.status(500).json(errorResponse('Failed to delete assessment sessions'));
          }

          // 7. Delete free assessments
          const { error: freeAssessmentsDeleteError } = await supabaseAdmin
            .from('free_assessments')
            .delete()
            .eq('client_id', clientId);
          if (freeAssessmentsDeleteError) {
            console.error('❌ Error deleting free assessments:', freeAssessmentsDeleteError);
            return res.status(500).json(errorResponse('Failed to delete free assessments'));
          }

          // 8. Delete client packages
          const { error: clientPackagesDeleteError } = await supabaseAdmin
            .from('client_packages')
            .delete()
            .eq('client_id', clientId);
          if (clientPackagesDeleteError) {
            console.error('❌ Error deleting client packages:', clientPackagesDeleteError);
            return res.status(500).json(errorResponse('Failed to delete client packages'));
          }

          // 9. Delete client profile
          const { error: clientDeleteError } = await supabaseAdmin.from('clients').delete().eq('id', clientId);
          if (clientDeleteError) {
            console.error('❌ Error deleting client:', clientDeleteError);
            return res.status(500).json(errorResponse('Failed to delete client profile'));
          }
          console.log(`   ✅ Deleted client profile (sequential mode)`);
        } else {
          // Other RPC error
          console.error('❌ Error calling delete_client_cascade RPC:', rpcError);
          return res.status(500).json(errorResponse('Failed to delete client data'));
        }
      } else {
        // RPC succeeded
        console.log(`   ✅ Deleted client profile and all related data (atomic transaction)`);
      }
    }

    // Delete user account
    const { error } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) {
      console.error('Delete user error:', error);
      return res.status(500).json(
        errorResponse('Failed to delete user')
      );
    }

    console.log(`   ✅ Deleted user account`);

    // SECURITY FIX: Audit log user deletion (with error handling for resilience)
    auditLogger.logRequest(req, 'DELETE_USER', 'user', userId, {
      target_user_email: deletedUserEmail,
      target_user_role: deletedUserRole,
      deleted_by: req.user.id,
      deleted_by_email: req.user.email
    }).catch(err => {
      console.error('Failed to log DELETE_USER audit:', err);
      // Don't throw - audit logging failure shouldn't break the request
    });

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

// Get comprehensive platform analytics
const getPlatformAnalytics = async (req, res) => {
  try {
    // SECURITY FIX: Add pagination and date filtering
    const { start_date, end_date, limit, offset } = req.query;
    
    // Validate and set pagination defaults
    const queryLimit = Math.min(parseInt(limit) || 1000, 10000); // Default 1000, max 10000
    const queryOffset = parseInt(offset) || 0;

    // SECURITY FIX: Validate date inputs to prevent silent query errors
    if (start_date) {
      const startDateObj = new Date(start_date);
      if (isNaN(startDateObj.getTime())) {
        return res.status(400).json(
          errorResponse('Invalid start_date format. Use ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)')
        );
      }
    }
    if (end_date) {
      const endDateObj = new Date(end_date);
      if (isNaN(endDateObj.getTime())) {
        return res.status(400).json(
          errorResponse('Invalid end_date format. Use ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)')
        );
      }
    }
    // Validate date range (end_date should be after start_date if both provided)
    if (start_date && end_date) {
      const startDateObj = new Date(start_date);
      const endDateObj = new Date(end_date);
      if (endDateObj < startDateObj) {
        return res.status(400).json(
          errorResponse('end_date must be after or equal to start_date')
        );
      }
    }

    // Build queries for full counts (no pagination for aggregates)
    // Use supabaseAdmin to bypass RLS (superadmin endpoint, proper auth already checked)
    let usersCountQuery = supabaseAdmin.from('users').select('*', { count: 'exact', head: true });
    let sessionsCountQuery = supabaseAdmin.from('sessions').select('*', { count: 'exact', head: true });
    // Use RPC for DB-side aggregation to avoid loading all prices into memory
    let totalRevenueQuery = supabaseAdmin.rpc('get_total_revenue', {
      p_start_date: start_date || null,
      p_end_date: end_date || null
    });
    let psychologistsCountQuery = supabaseAdmin.from('psychologists').select('*', { count: 'exact', head: true });
    let clientsCountQuery = supabaseAdmin.from('clients').select('*', { count: 'exact', head: true });

    // Build paginated queries for detailed data
    let usersQuery = supabaseAdmin.from('users').select('role, created_at', { count: 'exact' });
    let sessionsQuery = supabaseAdmin.from('sessions').select('status, scheduled_date, price, created_at', { count: 'exact' });
    let psychologistsQuery = supabaseAdmin.from('psychologists').select('area_of_expertise, created_at', { count: 'exact' });
    let clientsQuery = supabaseAdmin.from('clients').select('child_age, created_at', { count: 'exact' });

    // Apply date filtering if provided
    // Note: totalRevenueQuery uses RPC with date parameters, so no need to chain filters
    if (start_date) {
      usersCountQuery = usersCountQuery.gte('created_at', start_date);
      sessionsCountQuery = sessionsCountQuery.gte('scheduled_date', start_date);
      psychologistsCountQuery = psychologistsCountQuery.gte('created_at', start_date);
      clientsCountQuery = clientsCountQuery.gte('created_at', start_date);
      usersQuery = usersQuery.gte('created_at', start_date);
      sessionsQuery = sessionsQuery.gte('scheduled_date', start_date);
      psychologistsQuery = psychologistsQuery.gte('created_at', start_date);
      clientsQuery = clientsQuery.gte('created_at', start_date);
    }
    if (end_date) {
      usersCountQuery = usersCountQuery.lte('created_at', end_date);
      sessionsCountQuery = sessionsCountQuery.lte('scheduled_date', end_date);
      psychologistsCountQuery = psychologistsCountQuery.lte('created_at', end_date);
      clientsCountQuery = clientsCountQuery.lte('created_at', end_date);
      usersQuery = usersQuery.lte('created_at', end_date);
      sessionsQuery = sessionsQuery.lte('scheduled_date', end_date);
      psychologistsQuery = psychologistsQuery.lte('created_at', end_date);
      clientsQuery = clientsQuery.lte('created_at', end_date);
    }

    // Apply pagination only to detailed queries
    usersQuery = usersQuery.range(queryOffset, queryOffset + queryLimit - 1);
    sessionsQuery = sessionsQuery.range(queryOffset, queryOffset + queryLimit - 1);
    psychologistsQuery = psychologistsQuery.range(queryOffset, queryOffset + queryLimit - 1);
    clientsQuery = clientsQuery.range(queryOffset, queryOffset + queryLimit - 1);

    // Get comprehensive statistics - full counts and paginated data
    const [
      { count: usersCount, error: usersCountError },
      { count: sessionsCount, error: sessionsCountError },
      { data: revenueResult, error: revenueError },
      { count: psychologistsCount, error: psychologistsCountError },
      { count: clientsCount, error: clientsCountError },
      { data: users, error: usersError, count: usersPaginatedCount },
      { data: sessions, error: sessionsError, count: sessionsPaginatedCount },
      { data: psychologists, error: psychologistsError, count: psychologistsPaginatedCount },
      { data: clients, error: clientsError, count: clientsPaginatedCount }
    ] = await Promise.all([
      usersCountQuery,
      sessionsCountQuery,
      totalRevenueQuery,
      psychologistsCountQuery,
      clientsCountQuery,
      usersQuery,
      sessionsQuery,
      psychologistsQuery,
      clientsQuery
    ]);

    // Treat get_total_revenue RPC missing (42883) as non-fatal: use revenue 0 and continue
    if (revenueError && revenueError.code === '42883') {
      console.warn('⚠️ get_total_revenue RPC function not found; using revenue 0. Run the DB migration or contact DBA to create this function.');
    }
    const revenueFatal = revenueError && revenueError.code !== '42883';
    if (usersCountError || sessionsCountError || revenueFatal || psychologistsCountError || clientsCountError ||
        usersError || sessionsError || psychologistsError || clientsError) {
      console.error('Analytics data fetch error:', {
        usersCountError, sessionsCountError, revenueError: revenueFatal ? revenueError : null, psychologistsCountError, clientsCountError,
        usersError, sessionsError, psychologistsError, clientsError
      });
      return res.status(500).json(
        errorResponse('Failed to fetch analytics data')
      );
    }

    // Extract total revenue from RPC result (DB-side aggregation); 0 when RPC missing (42883)
    const totalRevenue = (revenueError && revenueError.code === '42883')
      ? 0
      : (revenueResult && typeof revenueResult === 'number'
          ? revenueResult
          : (revenueResult?.total || revenueResult?.[0]?.total || 0));

    // Calculate comprehensive analytics
    const analytics = {
      overview: {
        total_users: usersCount || 0,
        total_sessions: sessionsCount || 0,
        total_revenue: totalRevenue,
        pagination: {
          limit: queryLimit,
          offset: queryOffset,
          users_returned: users?.length || 0,
          sessions_returned: sessions?.length || 0,
          psychologists_returned: psychologists?.length || 0,
          clients_returned: clients?.length || 0
        }
      },
      users: {
        by_role: {},
        growth: {
          this_month: 0,
          this_quarter: 0,
          this_year: 0
        }
      },
      sessions: {
        by_status: {},
        by_month: {},
        revenue_trends: {}
      },
      psychologists: {
        total: psychologistsCount || psychologists?.length || 0,
        expertise_distribution: {},
        performance_metrics: {}
      },
      clients: {
        age_distribution: {},
        growth_trends: {}
      },
      platform_health: {
        session_completion_rate: 0,
        average_session_price: 0,
        user_retention_rate: 0
      }
    };

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const currentQuarter = Math.floor(currentMonth / 3);

    // User analytics
    (users || []).forEach(user => {
      analytics.users.by_role[user.role] = (analytics.users.by_role[user.role] || 0) + 1;
      
      const userDate = new Date(user.created_at);
      if (userDate.getMonth() === currentMonth && userDate.getFullYear() === currentYear) {
        analytics.users.growth.this_month++;
      }
      if (userDate.getFullYear() === currentYear && Math.floor(userDate.getMonth() / 3) === currentQuarter) {
        analytics.users.growth.this_quarter++;
      }
      if (userDate.getFullYear() === currentYear) {
        analytics.users.growth.this_year++;
      }
    });

    // Session analytics
    (sessions || []).forEach(session => {
      analytics.sessions.by_status[session.status] = (analytics.sessions.by_status[session.status] || 0) + 1;
      
      const sessionDate = new Date(session.scheduled_date);
      const monthKey = `${sessionDate.getFullYear()}-${sessionDate.getMonth() + 1}`;
      analytics.sessions.by_month[monthKey] = (analytics.sessions.by_month[monthKey] || 0) + 1;
      
      const revenueKey = `${sessionDate.getFullYear()}-${sessionDate.getMonth() + 1}`;
      analytics.sessions.revenue_trends[revenueKey] = (analytics.sessions.revenue_trends[revenueKey] || 0) + parseFloat(session.price || 0);
    });

    // Psychologist analytics
    (psychologists || []).forEach(psychologist => {
      psychologist.area_of_expertise?.forEach(expertise => {
        analytics.psychologists.expertise_distribution[expertise] = (analytics.psychologists.expertise_distribution[expertise] || 0) + 1;
      });
    });

    // Client analytics
    (clients || []).forEach(client => {
      const ageGroup = client.child_age <= 5 ? '0-5' : 
                      client.child_age <= 12 ? '6-12' : '13-18';
      analytics.clients.age_distribution[ageGroup] = (analytics.clients.age_distribution[ageGroup] || 0) + 1;
    });

    // Platform health metrics
    const completedSessions = analytics.sessions.by_status['completed'] || 0;
    const totalBookedSessions = (analytics.sessions.by_status['booked'] || 0) + 
                               (analytics.sessions.by_status['rescheduled'] || 0) + 
                               completedSessions;
    
    analytics.platform_health.session_completion_rate = totalBookedSessions > 0 ? 
      (completedSessions / totalBookedSessions * 100).toFixed(2) : 0;
    
    analytics.platform_health.average_session_price = analytics.overview.total_sessions > 0 ? 
      (analytics.overview.total_revenue / analytics.overview.total_sessions).toFixed(2) : 0;

    res.json(
      successResponse(analytics)
    );

  } catch (error) {
    console.error('Get platform analytics error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching platform analytics')
    );
  }
};

// System maintenance functions
const systemMaintenance = async (req, res) => {
  try {
    const { action, confirm } = req.body;

    if (!action) {
      return res.status(400).json(
        errorResponse('Action is required')
      );
    }

    // SECURITY FIX: Require explicit confirmation for destructive actions
    if (confirm !== true) {
      return res.status(400).json(
        errorResponse('Confirmation required. Set confirm: true for destructive operations')
      );
    }

    // SECURITY FIX: Explicit allowlist of safe actions
    const ALLOWED_ACTIONS = ['cleanup_old_sessions', 'recalculate_stats'];
    if (!ALLOWED_ACTIONS.includes(action)) {
      return res.status(400).json(
        errorResponse(`Invalid action specified. Allowed actions: ${ALLOWED_ACTIONS.join(', ')}`)
      );
    }

    let result;
    switch (action) {
      case 'cleanup_old_sessions':
        // Clean up sessions older than 1 year
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        
        // SECURITY FIX: Use supabaseAdmin for delete operations (bypasses RLS)
        const { error: cleanupError } = await supabaseAdmin
          .from('sessions')
          .delete()
          .lt('scheduled_date', oneYearAgo.toISOString().split('T')[0])
          .in('status', ['completed', 'canceled', 'noshow']);

        if (cleanupError) {
          console.error('Cleanup error:', cleanupError);
          return res.status(500).json(
            errorResponse('Failed to cleanup old sessions')
          );
        }

        result = { message: 'Old sessions cleaned up successfully' };
        break;

      case 'recalculate_stats':
        // This would trigger a recalculation of all statistics
        result = { message: 'Statistics recalculation triggered' };
        break;

      default:
        // This should not be reached due to allowlist check above, but keep for safety
        return res.status(400).json(
          errorResponse('Invalid action specified')
        );
    }

    // SECURITY FIX: Audit log maintenance operations (with error handling for resilience)
    auditLogger.logRequest(req, 'SYSTEM_MAINTENANCE', 'system', null, {
      maintenance_action: action,
      performed_by: req.user.id,
      performed_by_email: req.user.email,
      result: result
    }).catch(err => {
      console.error('Failed to log SYSTEM_MAINTENANCE audit:', err);
      // Don't throw - audit logging failure shouldn't break the request
    });

    res.json(
      successResponse(result, 'System maintenance completed successfully')
    );

  } catch (error) {
    console.error('System maintenance error:', error);
    res.status(500).json(
      errorResponse('Internal server error during system maintenance')
    );
  }
};

// Get system logs (placeholder for future implementation)
const getSystemLogs = async (req, res) => {
  try {
    const { level, start_date, end_date, limit = 100 } = req.query;

    // This is a placeholder - in a real system you'd have a logs table
    // For now, we'll return a mock response
    const mockLogs = [
      {
        id: 1,
        level: 'INFO',
        message: 'System startup completed',
        timestamp: new Date().toISOString(),
        source: 'system'
      },
      {
        id: 2,
        level: 'INFO',
        message: 'Database connection established',
        timestamp: new Date().toISOString(),
        source: 'database'
      }
    ];

    res.json(
      successResponse({
        logs: mockLogs,
        total: mockLogs.length
      })
    );

  } catch (error) {
    console.error('Get system logs error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching system logs')
    );
  }
};

module.exports = {
  createAdmin,
  deleteUser,
  getPlatformAnalytics,
  systemMaintenance,
  getSystemLogs
};
