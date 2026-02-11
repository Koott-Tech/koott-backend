const Razorpay = require('razorpay');
const crypto = require('crypto');

// Get frontend URL from environment variables
const getFrontendUrl = () => {
  // If RAZORPAY_SUCCESS_URL is explicitly set, extract base URL from it
  if (process.env.RAZORPAY_SUCCESS_URL) {
    try {
      const url = new URL(process.env.RAZORPAY_SUCCESS_URL);
      const baseUrl = `${url.protocol}//${url.host}`;
      console.log('🔧 Using RAZORPAY_SUCCESS_URL base:', baseUrl);
      return baseUrl;
    } catch (error) {
      console.warn('⚠️ Invalid RAZORPAY_SUCCESS_URL format, using default');
    }
  }
  
  // Prefer explicit full URL override (production-safe)
  if (process.env.FRONTEND_URL) {
    try {
      const url = new URL(process.env.FRONTEND_URL);
      const baseUrl = `${url.protocol}//${url.host}`;
      console.log('🔧 Using FRONTEND_URL:', baseUrl);
      return baseUrl;
    } catch (error) {
      console.warn('⚠️ Invalid FRONTEND_URL format, falling through');
    }
  }

  // FRONTEND_PORT localhost fallback only for non-production
  if (process.env.NODE_ENV !== 'production' && process.env.FRONTEND_PORT) {
    const frontendPort = process.env.FRONTEND_PORT;
    const baseUrl = `http://localhost:${frontendPort}`;
    console.log('🔧 Using FRONTEND_PORT from env:', frontendPort);
    return baseUrl;
  }

  if (process.env.NODE_ENV === 'development') {
    // Default to 3000 in development
    const frontendPort = '3000';
    console.log('🔧 Using default development port:', frontendPort);
    return `http://localhost:${frontendPort}`;
  }
  
  // Production URL from environment (no hardcoded fallback)
  const productionUrl = process.env.PRODUCTION_URL || process.env.NEXT_PUBLIC_PRODUCTION_URL;
  if (!productionUrl || typeof productionUrl !== 'string' || !productionUrl.startsWith('http')) {
    console.error('❌ PRODUCTION_URL or NEXT_PUBLIC_PRODUCTION_URL must be set to a valid URL in production.');
    throw new Error('Production URL not configured. Set PRODUCTION_URL or NEXT_PUBLIC_PRODUCTION_URL.');
  }
  console.log('🔧 Using production URL from env');
  return productionUrl.trim();
};

// Razorpay Configuration
const RAZORPAY_CONFIG = {
  // Test Environment (for development)
  test: {
    keyId: process.env.RAZORPAY_TEST_KEY_ID || '',
    keySecret: process.env.RAZORPAY_TEST_KEY_SECRET || '',
  },
  // Production Environment (for live payments)
  production: {
    keyId: process.env.RAZORPAY_PROD_KEY_ID,
    keySecret: process.env.RAZORPAY_PROD_KEY_SECRET,
  }
};

// Get current environment config
const getRazorpayConfig = () => {
  // Read from environment variable (defaults to test mode for safety)
  // Set RAZORPAY_USE_PRODUCTION=true in .env to enable live payments
  const useProduction = process.env.RAZORPAY_USE_PRODUCTION;
  const isProduction = useProduction === 'true' || useProduction === '1' || useProduction === 'yes';
  
  // Get fresh frontend URL each time (not cached)
  const frontendBaseUrl = getFrontendUrl();
  
  const config = {
    ...(isProduction ? RAZORPAY_CONFIG.production : RAZORPAY_CONFIG.test),
    successUrl: process.env.RAZORPAY_SUCCESS_URL || `${frontendBaseUrl}/payment/success`,
    failureUrl: process.env.RAZORPAY_FAILURE_URL || `${frontendBaseUrl}/payment/failure`
  };
  
  console.log('🔧 Razorpay Environment:', isProduction ? 'PRODUCTION (LIVE PAYMENTS)' : 'TEST MODE (SAFE FOR TESTING)');
  console.log('🔧 RAZORPAY_USE_PRODUCTION:', process.env.RAZORPAY_USE_PRODUCTION || 'not set (defaulting to TEST mode)');
  console.log('🔧 NODE_ENV:', process.env.NODE_ENV);
  console.log('🔧 FRONTEND_PORT:', process.env.FRONTEND_PORT || 'not set (using default 3000)');
  console.log('🔧 Frontend Base URL:', frontendBaseUrl);
  console.log('🔧 Using Test Credentials:', !isProduction);
  console.log('🔧 Success URL:', config.successUrl);
  console.log('🔧 Failure URL:', config.failureUrl);
  
  if (!isProduction) {
    console.log('✅ Using Razorpay TEST mode - payments will not be charged');
  } else {
    console.log('⚠️  Using Razorpay PRODUCTION mode - REAL MONEY will be charged!');
  }
  
  return config;
};

// Initialize Razorpay instance
const getRazorpayInstance = () => {
  const config = getRazorpayConfig();
  
  if (!config.keyId || !config.keySecret) {
    throw new Error('Razorpay credentials not configured. Please set RAZORPAY_TEST_KEY_ID and RAZORPAY_TEST_KEY_SECRET or RAZORPAY_PROD_KEY_ID and RAZORPAY_PROD_KEY_SECRET');
  }
  
  return new Razorpay({
    key_id: config.keyId,
    key_secret: config.keySecret,
  });
};

// Generate transaction ID (receipt ID for Razorpay)
const generateTransactionId = () => {
  // Use cryptographically secure randomness
  const randomBytes = crypto.randomBytes(8); // 8 bytes = 16 hex characters
  const randomHex = randomBytes.toString('hex');
  return 'TXN_' + Date.now() + '_' + randomHex;
};

// Verify Razorpay payment signature (constant-time comparison)
const verifyPaymentSignature = (orderId, paymentId, signature, secret) => {
  try {
    const payload = orderId + '|' + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload.toString())
      .digest('hex');
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const incomingBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== incomingBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, incomingBuf);
  } catch (error) {
    console.error('❌ Error verifying payment signature:', error);
    return false;
  }
};

// Verify Razorpay webhook signature (constant-time comparison)
const verifyWebhookSignature = (webhookBody, signature, secret) => {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(webhookBody)
      .digest('hex');
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const incomingBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== incomingBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, incomingBuf);
  } catch (error) {
    console.error('❌ Error verifying webhook signature:', error);
    return false;
  }
};

module.exports = {
  getRazorpayConfig,
  getRazorpayInstance,
  generateTransactionId,
  verifyPaymentSignature,
  verifyWebhookSignature
};

