// Lazy load supabaseAdmin to avoid requiring it before dotenv is loaded
let _supabaseAdmin = null;
function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    _supabaseAdmin = require('../config/supabase').supabaseAdmin;
  }
  return _supabaseAdmin;
}

class SecurityMonitor {
  constructor() {
    this.metrics = {
      requestsBlocked: 0,
      suspiciousIPs: new Set(),
      botDetections: 0,
      memoryAlerts: 0,
      authFailures: 0,
      startTime: new Date()
    };
    
    // Don't load metrics in constructor - wait until dotenv is loaded
    // loadMetrics() will be called after server starts
  }

  // Track blocked requests
  trackBlockedRequest(req, reason) {
    this.metrics.requestsBlocked++;
    this.metrics.suspiciousIPs.add(req.ip);
    
    this.logSecurityEvent({
      type: 'BLOCKED_REQUEST',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      reason: reason,
      timestamp: new Date().toISOString(),
      url: req.url,
      method: req.method
    });
  }

  // Track bot detection
  trackBotDetection(req, userAgent) {
    this.metrics.botDetections++;
    
    this.logSecurityEvent({
      type: 'BOT_DETECTED',
      ip: req.ip,
      userAgent: userAgent,
      timestamp: new Date().toISOString(),
      url: req.url
    });
  }

  // Track memory alerts
  trackMemoryAlert(memoryUsageMB) {
    this.metrics.memoryAlerts++;
    
    this.logSecurityEvent({
      type: 'MEMORY_ALERT',
      memoryUsage: memoryUsageMB,
      timestamp: new Date().toISOString()
    });
  }

  // Track authentication failures
  trackAuthFailure(req, email, reason) {
    this.metrics.authFailures++;
    
    this.logSecurityEvent({
      type: 'AUTH_FAILURE',
      ip: req.ip,
      email: email,
      reason: reason,
      timestamp: new Date().toISOString()
    });
  }

  // Log security events to database
  async logSecurityEvent(event) {
    // Mask email for logging
    const maskEmail = (email) => {
      if (!email || typeof email !== 'string' || !email.includes('@')) return null;
      const [local, domain] = email.split('@');
      const maskedLocal = local.length > 2 
        ? local.substring(0, 1) + '***' + local.substring(local.length - 1)
        : '***';
      return `${maskedLocal}@${domain}`;
    };
    
    // Prepare database entry
    const logEntry = {
      event_type: event.type,
      ip_address: event.ip || null,
      user_agent: event.userAgent || null,
      email: maskEmail(event.email), // Use masked email
      reason: event.reason || null,
      url: event.url || null,
      method: event.method || null,
      memory_usage_mb: event.memoryUsage || null,
      event_data: {
        // Store any additional event data (sanitized)
        ...(event.userAgent ? { userAgent: event.userAgent } : {}),
        ...(event.url ? { url: event.url } : {}),
        ...(event.method ? { method: event.method } : {})
        // Note: email removed from event_data to avoid PII leakage
      },
      timestamp: event.timestamp || new Date().toISOString()
    };

    // Insert into database (non-blocking)
    getSupabaseAdmin()
      .from('security_logs')
      .insert([logEntry])
      .then(({ error }) => {
        if (error) {
          // Table might not exist (42P01 = PostgreSQL, PGRST205 = PostgREST)
          if (error.code === '42P01' || error.code === 'PGRST205') {
            // Log once at debug level; table may be optional or project uses audit_logs
            if (process.env.NODE_ENV !== 'production') {
              console.warn('ℹ️ security_logs table not found; log saved to console only.');
            }
          } else {
            // Other database errors - log but don't break
            console.error('🚨 Failed to write security log to database:', error);
            console.error('🚨 Security log (console only):', JSON.stringify(logEntry, null, 2));
          }
        } else {
          // Only log in non-production to reduce noise
          if (process.env.NODE_ENV !== 'production') {
            console.log(`🔒 Security log saved: ${event.type} - IP: ${event.ip || 'N/A'}`);
          }
        }
      })
      .catch((err) => {
        console.error('🚨 Exception writing security log:', err);
        console.error('🚨 Security log (console only):', JSON.stringify(logEntry, null, 2));
      });

    // Console warning for critical events
    if (event.type === 'BLOCKED_REQUEST' || event.type === 'MEMORY_ALERT') {
      console.warn(`🚨 Security Alert: ${event.type} - IP: ${event.ip || 'N/A'}`);
    }
  }

  // Load existing logs from database (for backward compatibility)
  async loadLogs(limit = 1000) {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('security_logs')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') {
          // Table doesn't exist yet - return empty array
          return [];
        }
        console.error('Failed to load security logs from database:', error);
        return [];
      }

      // Convert database format to old format; explicit fields override event_data (mirror getRecentEvents)
      const explicitKeys = ['id', 'type', 'ip', 'userAgent', 'email', 'reason', 'url', 'method', 'memoryUsage', 'timestamp'];
      return (data || []).map(log => {
        const sanitizedEventData = {};
        if (log.event_data) {
          for (const [key, value] of Object.entries(log.event_data)) {
            if (!explicitKeys.includes(key)) sanitizedEventData[key] = value;
          }
        }
        return {
          ...sanitizedEventData,
          id: log.id,
          type: log.event_type,
          ip: log.ip_address,
          userAgent: log.user_agent,
          email: log.email,
          reason: log.reason,
          url: log.url,
          method: log.method,
          memoryUsage: log.memory_usage_mb,
          timestamp: log.timestamp
        };
      });
    } catch (error) {
      console.error('Failed to load security logs:', error);
      return [];
    }
  }

  // Load metrics from database (aggregate from security_logs)
  async loadMetrics() {
    try {
      // Check if environment variables are loaded
      // If not, skip loading metrics (will retry later)
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        // Environment variables not loaded yet - this is expected on startup
        // Don't log as error, just return silently
        return;
      }

      // Get metrics from database
      const oneWeekAgo = new Date();
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

      const supabaseAdmin = getSupabaseAdmin();

      // Count blocked requests
      const { count: blockedCount, error: blockedError } = await supabaseAdmin
        .from('security_logs')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'BLOCKED_REQUEST')
        .gte('timestamp', oneWeekAgo.toISOString());
      if (blockedError && blockedError.code !== '42P01' && blockedError.code !== 'PGRST205') {
        console.error('Failed to count blocked requests:', blockedError);
      }

      // Count bot detections
      const { count: botCount, error: botError } = await supabaseAdmin
        .from('security_logs')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'BOT_DETECTED')
        .gte('timestamp', oneWeekAgo.toISOString());
      if (botError && botError.code !== '42P01' && botError.code !== 'PGRST205') {
        console.error('Failed to count bot detections:', botError);
      }

      // Count memory alerts
      const { count: memoryCount, error: memoryError } = await supabaseAdmin
        .from('security_logs')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'MEMORY_ALERT')
        .gte('timestamp', oneWeekAgo.toISOString());
      if (memoryError && memoryError.code !== '42P01' && memoryError.code !== 'PGRST205') {
        console.error('Failed to count memory alerts:', memoryError);
      }

      // Count auth failures
      const { count: authCount, error: authError } = await supabaseAdmin
        .from('security_logs')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'AUTH_FAILURE')
        .gte('timestamp', oneWeekAgo.toISOString());
      if (authError && authError.code !== '42P01' && authError.code !== 'PGRST205') {
        console.error('Failed to count auth failures:', authError);
      }

      // Get unique suspicious IPs
      const { data: ipData, error: ipError } = await supabaseAdmin
        .from('security_logs')
        .select('ip_address')
        .eq('event_type', 'BLOCKED_REQUEST')
        .gte('timestamp', oneWeekAgo.toISOString())
        .not('ip_address', 'is', null);
      if (ipError && ipError.code !== '42P01' && ipError.code !== 'PGRST205') {
        console.error('Failed to get suspicious IPs:', ipError);
      }

      const uniqueIPs = new Set((ipData || []).map(log => log.ip_address).filter(Boolean));

      // Update metrics
      this.metrics.requestsBlocked = blockedCount || 0;
      this.metrics.botDetections = botCount || 0;
      this.metrics.memoryAlerts = memoryCount || 0;
      this.metrics.authFailures = authCount || 0;
      this.metrics.suspiciousIPs = uniqueIPs;
    } catch (error) {
      // Only log errors if environment variables are loaded (avoid startup noise)
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        // Environment is loaded but query failed - this is a real error
        if (process.env.NODE_ENV === 'development') {
          console.error('Failed to load security metrics from database:', error.message);
        }
      }
      // Keep default metrics if database query fails
    }
  }

  // Save metrics (no longer needed - metrics are calculated from database)
  saveMetrics() {
    // Metrics are now calculated from database, no need to save separately
    // This method is kept for backward compatibility
  }

  // Get security summary
  getSecuritySummary() {
    const uptime = Date.now() - this.metrics.startTime.getTime();
    const uptimeHours = uptime / (1000 * 60 * 60);
    
    return {
      uptime: `${uptimeHours.toFixed(2)} hours`,
      totalRequestsBlocked: this.metrics.requestsBlocked,
      uniqueSuspiciousIPs: this.metrics.suspiciousIPs.size,
      botDetections: this.metrics.botDetections,
      memoryAlerts: this.metrics.memoryAlerts,
      authFailures: this.metrics.authFailures,
      requestsBlockedPerHour: (this.metrics.requestsBlocked / uptimeHours).toFixed(2),
      suspiciousIPs: Array.from(this.metrics.suspiciousIPs).slice(0, 10) // Top 10
    };
  }

  // Get recent security events from database
  async getRecentEvents(limit = 50) {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('security_logs')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') {
          // Table doesn't exist yet
          return [];
        }
        console.error('Failed to get recent security events:', error);
        return [];
      }

      // Convert database format to old format for backward compatibility
      // Ensure explicit fields override event_data to prevent overwriting
      return (data || []).map(log => {
        // Extract non-conflicting fields from event_data
        const sanitizedEventData = {};
        if (log.event_data) {
          const explicitFields = ['id', 'type', 'ip', 'userAgent', 'email', 'reason', 'url', 'method', 'memoryUsage', 'timestamp'];
          for (const [key, value] of Object.entries(log.event_data)) {
            if (!explicitFields.includes(key)) {
              sanitizedEventData[key] = value;
            }
          }
        }
        
        return {
          ...sanitizedEventData, // Spread sanitized event_data first
          id: log.id,
          type: log.event_type,
          ip: log.ip_address,
          userAgent: log.user_agent,
          email: log.email,
          reason: log.reason,
          url: log.url,
          method: log.method,
          memoryUsage: log.memory_usage_mb,
          timestamp: log.timestamp
        };
      });
    } catch (error) {
      console.error('Failed to get recent security events:', error);
      return [];
    }
  }

  // Clean old logs (now handled by cleanup job, kept for backward compatibility)
  async cleanOldLogs() {
    // Cleanup is now handled by securityLogsCleanupJob.js
    // This method is kept for backward compatibility but does nothing
    console.log('ℹ️ Security logs cleanup is now handled by securityLogsCleanupJob.js');
  }
}

// Create singleton instance
const securityMonitor = new SecurityMonitor();

// Module-level interval ID for cleanup
let securityMonitorIntervalId = null;

/**
 * Initialize security monitor
 * Extracts startup logic for explicit initialization
 * @returns {Promise<void>}
 */
async function initializeSecurityMonitor() {
  try {
    // Initial load
    await securityMonitor.loadMetrics();
    
    // Set up periodic refresh (every 5 minutes) and store interval ID
    securityMonitorIntervalId = setInterval(() => {
      securityMonitor.loadMetrics().catch(err => {
        // Silently fail - metrics are not critical for operation
        if (process.env.NODE_ENV === 'development') {
          console.error('Failed to refresh security metrics:', err);
        }
      });
    }, 5 * 60 * 1000);
  } catch (err) {
    // Silently fail on first load - it's expected if dotenv isn't loaded yet
    if (process.env.NODE_ENV === 'development') {
      console.error('Failed to initialize security monitor:', err);
    }
  }
}

/**
 * Stop security monitor (for graceful shutdown)
 * @returns {Promise<void>}
 */
async function stopSecurityMonitor() {
  if (securityMonitorIntervalId) {
    clearInterval(securityMonitorIntervalId);
    securityMonitorIntervalId = null;
  }
  // Cancel any in-flight loadMetrics promise if needed
  // (Note: Promises can't be cancelled, but we've stopped scheduling new ones)
}

module.exports = securityMonitor;
module.exports.initializeSecurityMonitor = initializeSecurityMonitor;
module.exports.stopSecurityMonitor = stopSecurityMonitor;
