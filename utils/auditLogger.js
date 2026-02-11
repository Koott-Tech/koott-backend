/**
 * Audit Logger Service
 * 
 * Logs all admin actions for security and compliance purposes.
 * Stores audit logs in database for long-term retention.
 */

const { supabaseAdmin } = require('../config/supabase');

/**
 * Redact PII from audit log object
 * @param {Object} auditLog - Audit log object
 * @returns {Object} Redacted audit log
 */
// Recursive PII redaction function
function redactPII(obj, depth = 0, visited = new WeakSet()) {
  // Prevent infinite recursion
  if (depth > 10) return '[MAX_DEPTH]';
  
  // Handle null/undefined
  if (obj === null || obj === undefined) return obj;
  
  // Handle primitives
  if (typeof obj !== 'object') {
    // Check if string looks like email or IP
    if (typeof obj === 'string') {
      // Email pattern
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(obj)) {
        const emailParts = obj.split('@');
        if (emailParts.length === 2) {
          const local = emailParts[0];
          const domain = emailParts[1];
          const maskedLocal = local.length > 2 
            ? local.substring(0, 1) + '***' + local.substring(local.length - 1)
            : '***';
          return `${maskedLocal}@${domain}`;
        }
        return '***@***';
      }
      // IP pattern
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(obj)) {
        const ipParts = obj.split('.');
        if (ipParts.length === 4) {
          return `${ipParts[0]}.${ipParts[1]}.xxx.xxx`;
        }
        return 'xxx.xxx.xxx.xxx';
      }
    }
    return obj;
  }
  
  // Handle circular references
  if (visited.has(obj)) return '[CIRCULAR]';
  visited.add(obj);
  
  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => redactPII(item, depth + 1, visited));
  }
  
  // Handle objects
  const redacted = {};
  const sensitiveKeys = ['user_email', 'email', 'ip_address', 'ip', 'user_id', 'password', 'token', 'secret'];
  
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(sk => lowerKey.includes(sk.toLowerCase()))) {
      // Redact sensitive keys
      if (lowerKey.includes('email')) {
        if (typeof value === 'string' && value.includes('@')) {
          const emailParts = value.split('@');
          if (emailParts.length === 2) {
            const local = emailParts[0];
            const maskedLocal = local.length > 2 
              ? local.substring(0, 1) + '***' + local.substring(local.length - 1)
              : '***';
            redacted[key] = `${maskedLocal}@${emailParts[1]}`;
          } else {
            redacted[key] = '***@***';
          }
        } else {
          redacted[key] = '[REDACTED]';
        }
      } else if (lowerKey.includes('ip')) {
        if (typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
          const ipParts = value.split('.');
          redacted[key] = `${ipParts[0]}.${ipParts[1]}.xxx.xxx`;
        } else {
          redacted[key] = 'xxx.xxx.xxx.xxx';
        }
      } else {
        redacted[key] = '[REDACTED]';
      }
    } else {
      // Recursively redact nested objects
      redacted[key] = redactPII(value, depth + 1, visited);
    }
  }
  
  return redacted;
}

class AuditLogger {
  /**
   * Log an admin action
   * @param {Object} params
   * @param {string} params.userId - Admin user ID
   * @param {string} params.userEmail - Admin user email
   * @param {string} params.userRole - Admin user role
   * @param {string} params.action - Action performed (e.g., 'UPDATE_USER_ROLE', 'DELETE_USER')
   * @param {string} params.resource - Resource affected (e.g., 'user', 'session', 'payment')
   * @param {string} params.resourceId - ID of affected resource
   * @param {string} params.endpoint - API endpoint called
   * @param {string} params.method - HTTP method
   * @param {Object} params.details - Additional details about the action
   * @param {string} params.ip - IP address of requester
   * @param {string} params.userAgent - User agent string
   */
  async logAction({
    userId,
    userEmail,
    userRole,
    action,
    resource,
    resourceId,
    endpoint,
    method,
    details = {},
    ip,
    userAgent
  }) {
    try {
      // Handle null userId for failed authentication attempts
      // For failed logins, userId will be null, but we still want to log the attempt
      // If user_id column has NOT NULL constraint, we'll skip the insert but log to console
      const auditLog = {
        user_id: userId,
        user_email: userEmail,
        user_role: userRole,
        action: action,
        resource: resource,
        resource_id: resourceId,
        endpoint: endpoint,
        method: method,
        details: details,
        ip_address: ip,
        user_agent: userAgent,
        timestamp: new Date().toISOString()
      };

      // Try to insert into audit_logs table if it exists
      // SECURITY: Fail secure - if audit logging fails, we should know about it
      try {
        // Note: user_id column is nullable, so failed login attempts (null user_id) 
        // can be inserted into the database. This is the expected behavior.
        // If schema changes to require user_id, we'll catch the error and log to console as fallback.
        const { error } = await supabaseAdmin
          .from('audit_logs')
          .insert([auditLog]);

        if (error) {
          // Handle NOT NULL constraint violation for user_id (fallback for schema changes)
          // Note: Currently user_id is nullable, so this shouldn't happen, but kept as safety net
          if (error.code === '23502' && error.message.includes('user_id')) {
            // user_id is required but we don't have it (failed login attempt)
            // Log to console for security monitoring, but don't fail the request
            const redacted = redactPII({
              action,
              user_email: userEmail,
              user_role: userRole,
              endpoint,
              ip_address: ip,
              reason: 'user_id is null (failed authentication attempt)'
            });
            console.warn('⚠️ Audit log skipped (null user_id):', JSON.stringify(redacted, null, 2));
            // Return success since we've logged it to console
            return { success: true, loggedToConsole: true };
          }
          
          // Table might not exist - this is a critical security issue
          if (error.code === '42P01') { // Table doesn't exist
            console.error('🚨 CRITICAL: audit_logs table not found! Run migration: create_audit_logs_table.sql');
            const redacted = redactPII(auditLog);
            console.error('🚨 Audit log (console only, redacted):', JSON.stringify(redacted, null, 2));
            // Don't throw - allow request to continue, but log critical error
            // In production, you might want to send alert to monitoring system
            return { success: false, error: 'Audit logs table not found', fallbackLogged: true };
          } else {
            // Other database errors - log and alert
            console.error('🚨 CRITICAL: Failed to write audit log:', error.message || error);
            const redacted = redactPII(auditLog);
            const redactedError = redactPII(error);
            console.error('🚨 Audit log (console only, redacted):', JSON.stringify(redacted, null, 2));
            console.error('🚨 Error details (redacted):', JSON.stringify(redactedError, null, 2));
            // Consider sending alert to monitoring system
            return { success: false, error: error.message || 'Failed to write audit log', fallbackLogged: true };
          }
        } else {
          // Success - return success only after successful DB insert
          console.log(`📋 Audit logged: ${action} by ${userEmail ? redactPII({ user_email: userEmail }).user_email : 'unknown'} (${userRole})`);
          return { success: true };
        }
      } catch (dbError) {
        // Critical error - log and alert
        console.error('🚨 CRITICAL: Exception writing audit log:', dbError.message || dbError);
        const redacted = redactPII(auditLog);
        const redactedError = redactPII(dbError);
        console.error('🚨 Audit log (console only, redacted):', JSON.stringify(redacted, null, 2));
        console.error('🚨 Error details (redacted):', JSON.stringify(redactedError, null, 2));
        // In production, send alert to monitoring system
        // Don't throw - allow request to continue, but ensure monitoring is aware
        return { success: false, error: dbError.message || 'Exception writing audit log', fallbackLogged: true };
      }
    } catch (error) {
      console.error('❌ Error logging audit:', error);
      // Don't throw - audit logging failure shouldn't break the request
      return { success: false, error: error.message, fallbackLogged: true };
    }
  }

  /**
   * Log admin action from request object
   * Convenience method that extracts info from req object
   */
  async logRequest(req, action, resource, resourceId, details = {}) {
    if (!req.user) {
      return { success: false, error: 'No user in request' };
    }

    // MEDIUM-RISK FIX: Include request ID for correlation
    const requestId = req.requestId || req.headers['x-request-id'] || 'unknown';
    const enrichedDetails = {
      ...details,
      requestId: requestId
    };

    return this.logAction({
      userId: req.user.id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: action,
      resource: resource,
      resourceId: resourceId,
      endpoint: req.path || req.url,
      method: req.method,
      details: enrichedDetails,
      ip: (() => {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
          const first = String(xff).split(',')[0].trim();
          if (first) return first;
        }
        return req.ip || req.socket?.remoteAddress || null;
      })(),
      userAgent: req.headers['user-agent'] || 'Unknown'
    });
  }
}

// Singleton instance
const auditLogger = new AuditLogger();

module.exports = auditLogger;


