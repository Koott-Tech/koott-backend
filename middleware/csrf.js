/**
 * CSRF Protection Middleware
 * 
 * Validates Origin/Referer headers for state-changing operations
 * Only applies to POST/PUT/DELETE/PATCH methods
 */

const validateCSRF = (req, res, next) => {
  // Only validate state-changing methods
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return next();
  }

  // Safe boundary-aware public path check (avoids partial matches like /auth/login-admin)
  const isPublicPath = (path) => {
    const p = req.path || '';
    return p === path || p.startsWith(path + '/');
  };
  const publicPaths = ['/payment/webhook'];
  if (publicPaths.some(path => isPublicPath(path))) {
    return next();
  }

  // Get allowed origins from environment
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
    : [];

  if (allowedOrigins.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('⚠️ CSRF: ALLOWED_ORIGINS not configured - failing closed');
      return res.status(403).json({
        error: 'Forbidden',
        message: 'CSRF protection requires ALLOWED_ORIGINS in production'
      });
    }
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // Check Origin header first (more reliable)
  if (origin) {
    try {
      const originHost = new URL(origin).origin;
      if (allowedOrigins.some(allowed => {
        try {
          return new URL(allowed).origin === originHost;
        } catch {
          return allowed === originHost;
        }
      })) {
        return next();
      }
    } catch (e) {
      // Invalid origin URL format - reject
      console.warn('🚨 CSRF: Invalid origin URL format:', origin);
    }
  }

  // Fallback to Referer header
  if (referer) {
    try {
      const refererHost = new URL(referer).origin;
      if (allowedOrigins.some(allowed => {
        try {
          return new URL(allowed).origin === refererHost;
        } catch {
          return allowed === refererHost;
        }
      })) {
        return next();
      }
    } catch (e) {
      // Invalid referer URL
    }
  }

  // CSRF check failed
  console.warn('🚨 CSRF validation failed:', {
    method: req.method,
    path: req.path,
    origin,
    referer,
    ip: req.ip
  });

  return res.status(403).json({
    error: 'Forbidden',
    message: 'CSRF validation failed'
  });
};

module.exports = validateCSRF;

