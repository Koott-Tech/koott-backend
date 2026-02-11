/**
 * Request ID Middleware
 * 
 * Generates unique request ID for correlation and tracking
 * Adds X-Request-ID header to response
 */

const crypto = require('crypto');

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestIdMiddleware = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const requestId = (incoming && typeof incoming === 'string' && UUID_V4_REGEX.test(incoming.trim()))
    ? incoming.trim()
    : crypto.randomUUID();
  
  // Attach to request for use in handlers
  req.requestId = requestId;
  
  // Add to response header
  res.setHeader('X-Request-ID', requestId);
  
  // Add to response locals for logging
  res.locals.requestId = requestId;
  
  next();
};

module.exports = requestIdMiddleware;

