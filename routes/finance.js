const express = require('express');
const router = express.Router();
const { authenticateToken, requireFinance } = require('../middleware/auth');
const financeController = require('../controllers/financeController');
const sessionController = require('../controllers/sessionController');
const adminController = require('../controllers/adminController');
const { createRateLimiters } = require('../middleware/security');

// Apply rate limiting
const { generalLimiter } = createRateLimiters();

// All finance routes require authentication and finance role
router.use(authenticateToken);
router.use(requireFinance);
router.use(generalLimiter);

/**
 * Finance Routes
 * All routes are protected with:
 * - Authentication (JWT token)
 * - Finance role check
 * - Rate limiting
 * - Audit logging (in controllers)
 */

// Dashboard
router.get('/dashboard', financeController.getDashboard);

// Sessions Management
router.get('/sessions', financeController.getSessions);
router.get('/doctors/:psychologistId/bookings', financeController.getDoctorBookings);
// Full per-therapist financial profile (every session + commission split + payout state)
router.get('/doctors/:psychologistId/profile', financeController.getDoctorFinanceProfile);
router.get('/sessions/all', sessionController.getAllSessions); // Use same method as admin for consistency
router.get('/sessions/:sessionId', financeController.getSessionDetails);
router.put('/sessions/:sessionId', adminController.updateSession);
router.put('/sessions/:sessionId/commission', financeController.updateSessionCommission);
router.patch('/sessions/:sessionId/verify-payment', sessionController.verifyPayment);
router.patch('/sessions/:sessionId/cancel-refund', sessionController.cancelRefundSession);
router.delete('/sessions/:sessionId', sessionController.deleteSession);
router.get('/psychologists', financeController.getPsychologistOptions);
router.get('/clients', financeController.getClientOptions);
router.post('/receipts/send-email', financeController.sendReceiptEmail);

// Revenue Management
router.get('/revenue', financeController.getRevenue);

// Commission Management
router.get('/commissions', financeController.getCommissions);
router.put('/commissions/:psychologistId', financeController.updateCommissionRate);

// Expense Management
router.get('/expenses', financeController.getExpenses);
router.post('/expenses', financeController.createExpense);
router.put('/expenses/:expenseId', financeController.updateExpense);
router.delete('/expenses/:expenseId', financeController.deleteExpense);
router.post('/expenses/:expenseId/approve', financeController.approveExpense);

// Income Management
router.get('/income', financeController.getIncome);
router.post('/income', financeController.createIncome);
router.put('/income/:incomeId', financeController.updateIncome);
router.delete('/income/:incomeId', financeController.deleteIncome);

// Financial Reports
// router.get('/reports', financeController.getReports);
// router.post('/reports/generate', financeController.generateReport);
// router.get('/reports/:reportId', financeController.getReport);

// Financial Forecasting
// router.get('/forecasting', financeController.getForecasting);
// router.get('/forecasting/revenue', financeController.getRevenueForecast);
// router.get('/forecasting/expenses', financeController.getExpenseForecast);

// Analytics & Insights
// router.get('/analytics', financeController.getAnalytics);
// router.get('/analytics/revenue', financeController.getRevenueAnalytics);
// router.get('/analytics/expenses', financeController.getExpenseAnalytics);

// Settings & Configuration
// router.get('/settings', financeController.getSettings);
// router.put('/settings', financeController.updateSettings);
router.get('/settings/categories', financeController.getExpenseCategories);
router.post('/settings/categories', financeController.createExpenseCategory);
router.get('/settings/income-sources', financeController.getIncomeSources);
router.post('/settings/income-sources', financeController.createIncomeSource);

// Payouts & Payments
router.get('/payouts', financeController.getPayouts);
router.get('/payouts/pending', financeController.getPendingPayouts);
router.get('/payouts/doctors', financeController.getDoctorPayouts);
router.get('/payouts/:payoutId', financeController.getPayoutDetails);
router.post('/payouts', financeController.processPayout);
router.post('/payouts/mark-paid', financeController.markPayoutAsPaid);

module.exports = router;
