const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const securityMonitor = require('../utils/securityMonitor');
const securityNotifications = require('../utils/securityNotifications');

// Advanced Rate Limiting Strategies
const createRateLimiters = () => {
  // 1. General API Rate Limiter (More lenient for legitimate devices and international users)
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === 'production' ? 150 : 500, // Increased from 100 to 150 for international users
    message: {
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip successful requests
    skipSuccessfulRequests: true,
    // Skip failed requests (to avoid penalizing legitimate users)
    skipFailedRequests: false,
    // Custom key generator for better tracking
    // Use IP only for payment endpoints to avoid blocking legitimate duplicate requests
    keyGenerator: (req) => {
      const path = req.path || (req.url ? req.url.split('?')[0] : '');
      if (path.startsWith('/payment/')) {
        // For payment endpoints, use IP only (Razorpay may send multiple requests with same IP)
        return req.ip || 'unknown';
      }
      // For other endpoints, use IP + User-Agent
      return `${req.ip}-${req.headers['user-agent']?.slice(0, 50) || 'unknown'}`;
    },
    // Payment endpoints are subject to rate limiting here; signature verification happens in the webhook handler and a separate webhookLimiter is used for webhook routes.
    // Use strict path matching instead of includes() to prevent bypass
    skip: (req) => {
      const url = req.url || req.path || '';
      const path = req.path || url.split('?')[0];
      
      // Strict path matching for payment endpoints
      // Note: Signature verification happens in webhook handler, not here
      // These endpoints use a dedicated webhookLimiter with higher threshold (see route setup)
      // Do not bypass rate limiting based on unverified header presence
      const paymentPaths = ['/payment/success', '/payment/failure', '/payment/verify', '/payment/status'];
      if (paymentPaths.some(p => path === p || path.startsWith(p + '/'))) {
        // Apply rate limiting - webhook handler will verify signature
        return false;
      }
      
      // Allow health check and status endpoints
      if (path === '/health' || path === '/status' || path.startsWith('/health/') || path.startsWith('/status/')) {
        return true;
      }
      return false;
    },
    // Track blocked requests using the new handler approach
    handler: (req, res, next, options) => {
      securityMonitor.trackBlockedRequest(req, 'RATE_LIMIT_EXCEEDED');
      
      // Create security alert for rate limit exceeded
      securityNotifications.createAlert('rate_limit_exceeded', 'high', {
        ip: req.ip,
        userAgent: req.headers['user-agent'] || '',
        url: req.url,
        method: req.method,
        limit: options.max,
        windowMs: options.windowMs,
        action: 'BLOCKED'
      });
      
      res.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: '15 minutes'
      });
    }
  });

  // 2. Strict Auth Rate Limiter
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Only 5 login attempts per 15 minutes
    message: {
      error: 'Too many authentication attempts',
      message: 'Too many login attempts. Please try again in 15 minutes.',
      retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      return `auth-${req.ip}-${req.body?.email || 'unknown'}`;
    }
  });

  // 3. File Upload Rate Limiter
  const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // Only 10 uploads per hour
    message: {
      error: 'Upload limit exceeded',
      message: 'Too many file uploads. Please try again in 1 hour.',
      retryAfter: '1 hour'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true
  });

  // 4. Password Reset Rate Limiter
  const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // Only 3 password reset attempts per hour
    message: {
      error: 'Password reset limit exceeded',
      message: 'Too many password reset attempts. Please try again in 1 hour.',
      retryAfter: '1 hour'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      return `password-reset-${req.ip}-${req.body?.email || 'unknown'}`;
    }
  });

  // 5. Email Verification Rate Limiter
  const emailVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 3, // Only 3 email verification attempts per 15 minutes
    message: {
      error: 'Email verification limit exceeded',
      message: 'Too many email verification attempts. Please try again in 15 minutes.',
      retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      return `email-verify-${req.ip}-${req.body?.email || 'unknown'}`;
    }
  });

  return {
    generalLimiter,
    authLimiter,
    uploadLimiter,
    passwordResetLimiter,
    emailVerificationLimiter
  };
};

// Slow Down Middleware (Progressive Delays)
const createSlowDown = () => {
  return slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 25, // Allow 25 requests per 15 minutes, then start adding delays
    delayMs: (used, req) => {
      const delayAfter = req.slowDown.limit;
      return (used - delayAfter) * 500;
    },
    maxDelayMs: 20000, // Maximum delay of 20 seconds
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      // Use a simple key generator to avoid IPv6 issues
      const ip = req.ip || req.connection.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent']?.slice(0, 50) || 'unknown';
      return `${ip}-${userAgent}`;
    }
  });
};

// Request Size Limiter
const requestSizeLimiter = (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'] || '0');
  const maxSize = 5 * 1024 * 1024; // 5MB

  if (contentLength > maxSize) {
    return res.status(413).json({
      error: 'Request too large',
      message: 'Request size exceeds 5MB limit',
      maxSize: '5MB'
    });
  }

  next();
};

// Memory Usage Monitor
const memoryMonitor = (req, res, next) => {
  const memUsage = process.memoryUsage();
  const memUsageMB = memUsage.heapUsed / 1024 / 1024;

  // Log high memory usage
  if (memUsageMB > 500) { // 500MB threshold
    console.warn(`⚠️ High memory usage: ${memUsageMB.toFixed(2)}MB`);
    securityMonitor.trackMemoryAlert(memUsageMB);
    
    // Create memory alert
    securityNotifications.createAlert('high_memory_usage', 'medium', {
      memoryUsage: memUsageMB,
      threshold: 500,
      action: 'MONITORING'
    });
  }

  // Block requests if memory usage is too high
  if (memUsageMB > 1000) { // 1GB threshold
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Server is experiencing high load. Please try again later.',
      retryAfter: '5 minutes'
    });
  }

  next();
};

// Note: Bot detection and IP filtering are handled by Cloudflare at the edge.
// App-level bot detection and IP filtering have been removed to avoid:
// - False positives blocking legitimate users
// - Breaking privacy browsers and assistive devices
// - Duplicating Cloudflare's superior bot management
// - Causing issues for traveling admins
//
// Configure bot management and IP filtering in Cloudflare dashboard instead.

// Request Validation Middleware
const requestValidator = (req, res, next) => {
  // Validate request method
  const allowedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
  if (!allowedMethods.includes(req.method)) {
    return res.status(405).json({
      error: 'Method not allowed',
      message: `HTTP method ${req.method} is not allowed`
    });
  }

  next();
};

module.exports = {
  createRateLimiters,
  createSlowDown,
  requestSizeLimiter,
  memoryMonitor,
  requestValidator
};
