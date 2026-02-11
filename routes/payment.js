const express = require('express');
const router = express.Router();
const { 
  createPaymentOrder,
  createCashPayment,
  handlePaymentFailure, 
  getPaymentStatus 
} = require('../controllers/paymentController');
const { handleRazorpayWebhook } = require('../controllers/razorpayWebhookController');
const { getBookingStatusByOrderId, verifyPaymentSignature } = require('../controllers/paymentStatusController');
const { authenticateToken } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// Rate limiter for booking-status endpoint (prevent enumeration)
const bookingStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per 15 minutes per IP
  message: {
    success: false,
    message: 'Too many requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter for verify-signature endpoint
const verifySignatureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per 15 minutes per IP
  message: {
    success: false,
    message: 'Too many requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Create payment order (requires authentication)
router.post('/create-order', authenticateToken, createPaymentOrder);

// Create cash payment (requires authentication)
router.post('/cash', authenticateToken, createCashPayment);

// Razorpay webhook (PRIMARY SOURCE OF TRUTH - no authentication required)
// This is where sessions are created after payment
router.post('/webhook', handleRazorpayWebhook);

// Payment status endpoints (read-only, for frontend polling)
router.get('/booking-status/:orderId', bookingStatusLimiter, getBookingStatusByOrderId); // Public - used by success page
router.post('/verify-signature', verifySignatureLimiter, verifyPaymentSignature); // Optional verification (doesn't create session)

// Legacy endpoints (kept for backward compatibility)
router.post('/failure', handlePaymentFailure);

// Get payment status (requires authentication)
router.get('/status/:transactionId', authenticateToken, getPaymentStatus);

module.exports = router;
