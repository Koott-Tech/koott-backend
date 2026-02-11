/**
 * Request Signing Middleware
 * 
 * Validates request signatures for critical operations to prevent replay attacks.
 * Uses HMAC with timestamp and nonce.
 */

const crypto = require('crypto');

/**
 * Generate request signature
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @param {Object} body - Request body
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @param {string} nonce - Unique nonce
 * @param {string} secret - Signing secret
 * @returns {string} - HMAC signature
 */
function generateSignature(method, path, body, timestamp, nonce, secret) {
  const bodyString = body ? JSON.stringify(body) : '';
  const message = `${method}:${path}:${bodyString}:${timestamp}:${nonce}`;
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Verify request signature
 * @param {Object} req - Express request object
 * @param {string} secret - Signing secret
 * @returns {{valid: boolean, error?: string}}
 */
function verifySignature(req, secret) {
  const signature = req.headers['x-request-signature'];
  const timestamp = req.headers['x-request-timestamp'];
  const nonce = req.headers['x-request-nonce'];

  if (!signature || !timestamp || !nonce) {
    return { valid: false, error: 'Missing signature headers' };
  }

  // Check timestamp first (prevent replay attacks - 5 minute window)
  const requestTime = parseInt(timestamp, 10);
  const now = Date.now();
  const timeDiff = Math.abs(now - requestTime);

  if (timeDiff > 5 * 60 * 1000) { // 5 minutes
    return { valid: false, error: 'Request timestamp too old or too far in future' };
  }

  // Replay check: reject if nonce already seen (do not cache nonce until signature is verified)
  if (verifySignature._nonceCache && verifySignature._nonceCache.has(nonce)) {
    return { valid: false, error: 'Replay detected' };
  }

  // Verify signature
  const expectedSignature = generateSignature(
    req.method,
    req.path || req.url,
    req.body,
    requestTime,
    nonce,
    secret
  );

  if (signature.length !== expectedSignature.length) {
    return { valid: false, error: 'Invalid signature' };
  }
  try {
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, error: 'Invalid signature' };
    }
  } catch (e) {
    return { valid: false, error: 'Invalid signature' };
  }

  // Cache nonce only after signature verification succeeds (prevents DoS from caching nonces of invalid requests)
  if (verifySignature._nonceCache) {
    verifySignature._nonceCache.set(nonce, true);
    setTimeout(() => verifySignature._nonceCache.delete(nonce), 5 * 60 * 1000);
  }
  return { valid: true };
}
verifySignature._nonceCache = new Map();

/**
 * Request signing middleware for critical operations
 * Only applies to specified routes
 */
const requireRequestSignature = (req, res, next) => {
  // Get signing secret from environment
  const signingSecret = process.env.REQUEST_SIGNING_SECRET;

  if (!signingSecret) {
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod') {
      console.error('❌ REQUEST_SIGNING_SECRET required in production');
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Request signing is required in production'
      });
    }
    console.warn('⚠️ REQUEST_SIGNING_SECRET not configured. Request signing disabled.');
    return next();
  }

  // Verify signature
  const verification = verifySignature(req, signingSecret);

  if (!verification.valid) {
    // Log security event
    const auditLogger = require('../utils/auditLogger');
    auditLogger.logAction({
      userId: req.user?.id || 'unknown',
      userEmail: req.user?.email || 'unknown',
      userRole: req.user?.role || 'unknown',
      action: 'REQUEST_SIGNATURE_INVALID',
      resource: 'admin_route',
      resourceId: null,
      endpoint: req.path || req.url,
      method: req.method,
      details: {
        error: verification.error,
        ip: req.ip
      },
      ip: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'] || 'Unknown'
    }).catch(err => {
      console.error('Error logging signature failure:', err);
    });

    return res.status(401).json({
      error: 'Invalid request signature',
      message: verification.error || 'Request signature verification failed'
    });
  }

  next();
};

/**
 * Generate signature headers for client requests
 * This is a helper function for clients to generate signatures
 */
function generateSignatureHeaders(method, path, body, secret) {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = generateSignature(method, path, body, timestamp, nonce, secret);

  return {
    'X-Request-Signature': signature,
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce
  };
}

module.exports = {
  requireRequestSignature,
  generateSignatureHeaders,
  generateSignature,
  verifySignature
};

