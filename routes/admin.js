const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const assessmentBookingController = require('../controllers/assessmentBookingController');
const sessionController = require('../controllers/sessionController');
const wixDiscoverController = require('../controllers/wixDiscoverController');
const wixBookingsController = require('../controllers/wixBookingsController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { createRateLimiters } = require('../middleware/security');
const multer = require('multer');
const path = require('path');
const { supabaseAdmin } = require('../config/supabase');

// Admin-specific rate limiter (stricter than general API)
// Note: This runs BEFORE authentication, so we can only use IP
const adminLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes per IP
  message: {
    error: 'Too many admin requests',
    message: 'Rate limit exceeded for admin operations. Please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false, // Count all requests
  keyGenerator: (req) => {
    // Use IP only (user ID not available before authentication)
    return `admin-${req.ip}`;
  }
});

// All routes require authentication and admin role
// Apply rate limiting first, then authentication, then authorization
// Note: IP filtering is handled by Cloudflare, not application-level
const validateCSRF = require('../middleware/csrf');
router.use(adminLimiter);
router.use(validateCSRF); // MEDIUM-RISK FIX: CSRF protection
router.use(authenticateToken);
router.use(requireAdmin);

// User management
router.get('/users', adminController.getAllUsers);
router.get('/users/:userId', adminController.getUserDetails);
router.put('/users/:userId/role', adminController.updateUserRole);
router.put('/users/:userId/deactivate', adminController.deactivateUser);

// Platform statistics
router.get('/stats/platform', adminController.getPlatformStats);
router.get('/stats/dashboard', adminController.getPlatformStats); // Alias for dashboard

// User search
router.get('/search/users', adminController.searchUsers);

// Recent data for dashboard
router.get('/recent-users', adminController.getRecentUsers);
router.get('/recent-bookings', adminController.getRecentBookings);

// Wix Velo `/_functions/discover` — inspect payload (admin tooling; no Supabase writes)
router.get('/wix/discover-inspect', wixDiscoverController.discoverInspect);

// Wix → Supabase mirror (`wix_bookings`)
router.post('/wix/sync', wixBookingsController.syncWixBookings);
router.get('/wix/bookings', wixBookingsController.listWixBookings);
router.get('/wix/bookings/:id', wixBookingsController.getWixBookingDetails);
router.patch('/wix/bookings/:id', wixBookingsController.editWixBooking);
router.delete('/wix/bookings/:id', wixBookingsController.deleteWixBooking);
router.patch('/wix/bookings/:id/complete', wixBookingsController.completeWixBooking);
router.patch('/wix/bookings/:id/no-show', wixBookingsController.noShowWixBooking);
router.get('/wix/therapists', wixBookingsController.listWixTherapists);
router.post('/wix/backfill-clients', wixBookingsController.backfillWixClients);

// Workshop / marketing event registrations (Supabase table event_registrations)
router.get('/event-registrations', adminController.getEventRegistrations);
router.put('/event-registrations/:registrationId', adminController.updateEventRegistration);
router.delete('/event-registrations/:registrationId', adminController.deleteEventRegistration);

// Psychologist management
router.get('/psychologists', adminController.getAllPsychologists);
router.post('/psychologists', adminController.createPsychologist);
router.put('/psychologists/:psychologistId', adminController.updatePsychologist);
router.delete('/psychologists/:psychologistId', adminController.deletePsychologist);

// Availability management
router.post('/availability/update-all', adminController.updateAllPsychologistsAvailability);

// User management
router.post('/users', adminController.createUser);
router.put('/users/:userId', adminController.updateUser);
router.delete('/users/:userId', adminController.deleteUser);

// Session management
router.get('/sessions/all', sessionController.getAllSessions);
router.get('/sessions/:sessionId', sessionController.getSessionById);

// Session rescheduling
router.put('/sessions/:sessionId', adminController.updateSession);
router.put('/sessions/:sessionId/no-show', sessionController.markSessionAsNoShow);
router.post('/sessions/:sessionId/complete', sessionController.completeSession); // Allow admins to complete sessions (especially free assessments)
router.delete('/sessions/:sessionId', sessionController.deleteSession); // Delete session (admin only)
router.get('/psychologists/:psychologistId/availability', adminController.getPsychologistAvailabilityForReschedule);

// Manual booking (admin only - for edge cases)
router.post('/bookings/manual', adminController.createManualBooking);

// Record-only booking (admin only): add session record only, no Meet creation, no notifications
router.post('/bookings/record-only', adminController.createRecordOnlyBooking);

// Book next package session (admin only - for clients who prefer admin to book remaining sessions)
router.post('/bookings/book-package-next-session', adminController.bookPackageNextSession);

// Packages with remaining sessions (admin only - for Packages tab)
router.get('/bookings/packages-with-remaining', adminController.getPackagesWithRemainingSessions);

// Reschedule request handling
router.get('/reschedule-requests', adminController.getRescheduleRequests);

// Assessment session rescheduling (admin can reschedule directly)
router.put('/assessment-sessions/:assessmentSessionId/reschedule', assessmentBookingController.rescheduleAssessmentSession);
router.delete('/assessment-sessions/:assessmentSessionId', assessmentBookingController.deleteAssessmentSession);

// Psychologist calendar events
router.get('/psychologists/:psychologistId/calendar-events', adminController.getPsychologistCalendarEvents);

// Manual trigger for session reminders (admin only, for testing)
router.post('/trigger-session-reminders', async (req, res) => {
  try {
    const sessionReminderService = require('../services/sessionReminderService');
    await sessionReminderService.triggerReminderCheck();
    res.json({
      success: true,
      message: 'Session reminder check triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering session reminders:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Manual trigger for calendar conflict check (admin only, for testing)
router.post('/trigger-calendar-conflict-check', async (req, res) => {
  try {
    const dailyCalendarConflictAlert = require('../services/dailyCalendarConflictAlert');
    await dailyCalendarConflictAlert.triggerConflictCheck();
    res.json({
      success: true,
      message: 'Calendar conflict check triggered successfully'
    });
  } catch (error) {
    console.error('Error triggering calendar conflict check:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// File uploads (admin only)
// Store in Supabase Storage bucket 'psychologists' and return public URL
const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB to accommodate high‑res formats
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!file.mimetype || !allowedMimes.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WebP and GIF images are allowed'));
    }
    cb(null, true);
  }
});

// Note: keep route definitions after middleware so auth applies
router.post('/upload/image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // HIGH-RISK FIX: Path traversal protection - generate UUID filename, ignore client-supplied name
    const crypto = require('crypto');
    const uuid = crypto.randomUUID();
    // Supported image extensions (must match fileFilter mimetypes)
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const ext = allowedExtensions.includes(rawExt) ? rawExt : '.jpg';
    const filename = `${uuid}${ext}`;
    const objectPath = `${filename}`; // flat path; change to folders if needed

    const bucket = 'profile-pictures';

    // Upload to Supabase Storage using admin client (bypasses RLS)
    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(objectPath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase Storage upload error:', uploadError);
      return res.status(500).json({ success: false, error: 'Failed to upload to storage' });
    }

    // Generate secure relative proxy URL (works in both dev and production)
    // Profile pictures use proxy URL for consistency and security
    const publicUrl = `/api/images/${bucket}/${objectPath}`;

    return res.json({
      success: true,
      url: publicUrl,
      bucket,
      path: objectPath,
      filename
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ success: false, error: 'Failed to upload file' });
  }
});

module.exports = router;
