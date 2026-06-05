const express = require('express');
const router = express.Router();
const psychologistController = require('../controllers/psychologistController');
const sessionController = require('../controllers/sessionController');
const { authenticateToken, requirePsychologist } = require('../middleware/auth');
const { 
  validatePsychologistProfile,
  validateAvailability
} = require('../utils/validation');

// All routes require authentication and psychologist role
router.use(authenticateToken);
router.use(requirePsychologist);

// Profile management
router.get('/profile', psychologistController.getProfile);
router.put('/profile', validatePsychologistProfile, psychologistController.updateProfile);

// Session management
router.get('/sessions', psychologistController.getSessions);
router.get('/clients/:clientId/session-history', psychologistController.getClientSessionHistory);
router.get('/stats/monthly', psychologistController.getMonthlyStats);
router.put('/sessions/:sessionId', psychologistController.updateSession);
router.post('/sessions/:sessionId/complete', psychologistController.completeSession);
router.put('/sessions/:sessionId/no-show', sessionController.markSessionAsNoShow);
router.delete('/sessions/:sessionId', psychologistController.deleteSession);
// Assessment session scheduling
router.post('/assessment-sessions/:assessmentSessionId/schedule', psychologistController.scheduleAssessmentSession);
router.delete('/assessment-sessions/:assessmentSessionId', psychologistController.deleteAssessmentSession);

// Availability management
router.get('/availability', psychologistController.getAvailability);
router.post('/availability', validateAvailability, psychologistController.addAvailability);
router.put('/availability', validateAvailability, psychologistController.updateAvailability);
router.delete('/availability/:availabilityId', psychologistController.deleteAvailability);

// Recurring blocks (e.g. block every Sunday - applies to all future weeks, only this psychologist)
router.get('/recurring-blocks', psychologistController.getRecurringBlocks);
router.post('/recurring-blocks', psychologistController.addRecurringBlock);
router.delete('/recurring-blocks/:blockId', psychologistController.deleteRecurringBlock);

// Private note password — per-therapist password that gates summary_notes access
router.get('/private-notes/status', psychologistController.getPrivateNotePasswordStatus);
router.post('/private-notes/setup', psychologistController.setupPrivateNotePassword);
router.post('/private-notes/change', psychologistController.changePrivateNotePassword);
router.post('/private-notes/verify', psychologistController.verifyPrivateNotePassword);
router.post('/private-notes/reset', psychologistController.resetPrivateNotePassword);

module.exports = router;
