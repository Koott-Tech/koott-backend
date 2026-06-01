const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { authenticateToken, requireClient } = require('../middleware/auth');
const { 
  validateClientProfile 
} = require('../utils/validation');
const { getClientReceipts, downloadReceipt, getReceiptByOrderId } = require('../controllers/receiptController');

// All routes require authentication and client role
router.use(authenticateToken);
router.use(requireClient);

// Profile management
router.get('/profile', clientController.getProfile);
router.put('/profile', validateClientProfile, clientController.updateProfile);

// Session management
router.get('/sessions', clientController.getSessions);
router.get('/sessions/:sessionId', clientController.getSession);
// SECURITY FIX: Direct booking endpoint disabled - all bookings must go through payment flow
// This prevents booking without payment and ensures consistent booking flow
// router.post('/book-session', clientController.bookSession); // DISABLED - Use payment flow instead
router.put('/sessions/:sessionId/cancel', clientController.cancelSession);
router.post('/sessions/:sessionId/reschedule-request', clientController.requestReschedule);
router.put('/sessions/:sessionId/reschedule', clientController.rescheduleSession);
router.post('/sessions/:sessionId/feedback', clientController.submitSessionFeedback);

// Psychologist discovery
router.get('/psychologists', clientController.getAvailablePsychologists);
router.get('/psychologists/:psychologistId/packages', clientController.getPsychologistPackages);

// Book remaining session from package
router.post('/book-remaining-session', clientController.bookRemainingSession);

// Reserve time slot for payment
router.post('/reserve-slot', clientController.reserveTimeSlot);

// Assessment booking
router.post('/assessments/reserve-slot', clientController.reserveAssessmentSlot);
router.post('/assessments/book', clientController.bookAssessment);
router.get('/assessments/sessions', clientController.getAssessmentSessions);

// Get client packages
router.get('/packages', clientController.getClientPackages);

// Payment credit and booking with existing payment
router.get('/payment-credit/:transactionId', clientController.getPaymentCredit);
router.post('/book-session-with-credit', clientController.bookSessionWithCredit);

// Get all receipts for a client
router.get('/receipts', getClientReceipts);

// Download a specific receipt as PDF
router.get('/receipts/:receiptId/download', downloadReceipt);

// Get receipt by Razorpay order ID
router.get('/receipts/order/:orderId', getReceiptByOrderId);

module.exports = router;
