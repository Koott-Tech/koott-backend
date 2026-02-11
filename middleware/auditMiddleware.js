/**
 * Audit Middleware
 * 
 * Automatically logs admin actions for security and compliance.
 * This middleware should be applied to admin routes.
 */

const auditLogger = require('../utils/auditLogger');

/**
 * Middleware to log admin actions
 * Extracts action name from route and logs it
 */
const auditAdminAction = (action, resource = 'unknown') => {
  const SENSITIVE_KEYS = new Set([
    'password', 'pass', 'passwd', 'pwd', 'password_hash', 'token', 'access_token', 'refresh_token',
    'api_key', 'apikey', 'secret', 'secret_key', 'ssn', 'social_security_number', 'credit_card',
    'card_number', 'cardnum', 'cvv', 'cvc', 'iban', 'routing_number', 'bank_account', 'auth', 'authorization'
  ]);
  const isSensitive = (key) => {
    const lower = (key || '').toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) return true;
    if (lower.includes('password') || lower.includes('secret') || lower.includes('token')) return true;
    if (lower.endsWith('_token') || lower.includes('card')) return true;
    return false;
  };

  // Recursive sanitizer that traverses nested objects and arrays
  const sanitizeObject = (obj, depth = 0, visited = new WeakSet()) => {
    // Prevent infinite recursion
    if (depth > 10) return '[MAX_DEPTH]';
    
    // Handle null/undefined
    if (obj === null || obj === undefined) return obj;
    
    // Handle primitives
    if (typeof obj !== 'object') return obj;
    
    // Handle circular references
    if (visited.has(obj)) return '[CIRCULAR]';
    visited.add(obj);
    
    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeObject(item, depth + 1, visited));
    }
    
    // Handle objects
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitive(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeObject(value, depth + 1, visited);
      }
    }
    return sanitized;
  };

  return (req, res, next) => {
    let logged = false;
    const finishHandler = () => {
      if (logged) return;
      logged = true;
      const statusCode = res.statusCode;
      if (statusCode >= 200 && statusCode < 300) {
        const resourceId = req.params.id ||
          req.params.userId ||
          req.params.sessionId ||
          req.params.paymentId ||
          req.body?.id ||
          null;
        const sanitizedBody = req.body && Object.keys(req.body).length > 0
          ? sanitizeObject(req.body)
          : {};
        try {
          auditLogger.logRequest(req, action, resource, resourceId, {
            statusCode,
            method: req.method,
            ...(Object.keys(sanitizedBody).length > 0 ? { body: sanitizedBody } : {})
          }).catch(err => {
            console.error('auditLogger.logRequest failed:', err?.message || err);
          });
        } catch (err) {
          console.error('auditLogger.logRequest failed:', err?.message || err);
        }
      }
    };
    res.on('finish', finishHandler);
    res.on('close', finishHandler);
    next();
  };
};

module.exports = {
  auditAdminAction
};


