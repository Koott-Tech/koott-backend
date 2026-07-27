const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const sessionController = require('../controllers/sessionController');
const wixDiscoverController = require('../controllers/wixDiscoverController');
const wixBookingsController = require('../controllers/wixBookingsController');
const { authenticateToken, requireAdmin, requireEventOrganizer } = require('../middleware/auth');
const { createRateLimiters } = require('../middleware/security');
const multer = require('multer');
const path = require('path');
const { supabaseAdmin } = require('../config/supabase');

// Admin-specific rate limiter (stricter than general API)
// Note: This runs BEFORE authentication, so we can only use IP
const adminLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 1000 : 100, // 1000 in dev, 100 in prod per 15 minutes per IP
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

// File uploads (admin & event organizer)
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

router.post('/upload/image', requireEventOrganizer, upload.single('file'), async (req, res) => {
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

    // Caller can choose which bucket to upload into via ?bucket= or form-data field `bucket`.
    // Allowlist: only these buckets can be targeted from this endpoint.
    const ALLOWED_BUCKETS = ['profile-pictures', 'manual-bookings', 'blog-images', 'counselling-images', 'events-poster', 'certificate-templates'];
    const requestedBucket = String(req.body?.bucket || req.query?.bucket || 'profile-pictures').toLowerCase();
    const bucket = ALLOWED_BUCKETS.includes(requestedBucket) ? requestedBucket : 'profile-pictures';
    // manual-bookings is a private (sensitive) bucket — payment proofs/IDs.
    const isPrivate = bucket === 'manual-bookings';

    // Upload to Supabase Storage using admin client (bypasses RLS)
    let { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(objectPath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    // Auto-heal: if the bucket doesn't exist yet, create it and retry once.
    if (uploadError && (uploadError.statusCode === '404' || /bucket not found/i.test(uploadError.message || ''))) {
      console.warn(`[upload/image] Bucket "${bucket}" missing — creating it now...`);
      const { error: createErr } = await supabaseAdmin.storage.createBucket(bucket, {
        public: !isPrivate,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
        fileSizeLimit: 10 * 1024 * 1024,
      });
      if (createErr && !/already exists|already_exists/i.test(createErr.message || '')) {
        console.error('[upload/image] createBucket failed:', createErr);
        return res.status(500).json({ success: false, error: `Storage bucket "${bucket}" missing and could not be created: ${createErr.message}` });
      }
      console.log(`✅ [upload/image] Bucket "${bucket}" created. Retrying upload...`);
      ({ error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(objectPath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        }));
    }

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
// File uploads for documents (materials, etc.)
const uploadDoc = multer({
  storage: memoryStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB for docs
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/pdf', 
      'application/msword', 
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain'
    ];
    if (!file.mimetype || !allowedMimes.includes(file.mimetype)) {
      return cb(new Error('Only PDF, DOC, DOCX, PPT, PPTX and TXT files are allowed'));
    }
    cb(null, true);
  }
});

router.post('/upload/document', requireEventOrganizer, uploadDoc.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const crypto = require('crypto');
    const uuid = crypto.randomUUID();
    const allowedExtensions = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.txt'];
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const ext = allowedExtensions.includes(rawExt) ? rawExt : '.pdf';
    const filename = `${uuid}${ext}`;
    
    // Always store materials in the event-materials bucket
    const bucket = 'event-materials';
    const objectPath = filename;

    let { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(objectPath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError && (uploadError.statusCode === '404' || /bucket not found/i.test(uploadError.message || ''))) {
      const { error: createErr } = await supabaseAdmin.storage.createBucket(bucket, {
        public: true,
        fileSizeLimit: 25 * 1024 * 1024,
      });
      if (createErr && !/already exists|already_exists/i.test(createErr.message || '')) {
        return res.status(500).json({ success: false, error: `Bucket "${bucket}" creation failed: ${createErr.message}` });
      }
      ({ error: uploadError } = await supabaseAdmin.storage
        .from(bucket)
        .upload(objectPath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        }));
    }

    if (uploadError) return res.status(500).json({ success: false, error: 'Failed to upload document' });

    const publicUrl = `/api/images/${bucket}/${objectPath}`;

    return res.json({
      success: true,
      url: publicUrl,
      bucket,
      path: objectPath,
      filename: req.file.originalname
    });
  } catch (error) {
    console.error('Document upload error:', error);
    return res.status(500).json({ success: false, error: 'Failed to upload document' });
  }
});

// Psychologists accessible by both Admin and Event Organizer (for dropdowns)
router.get('/psychologists', requireEventOrganizer, adminController.getAllPsychologists);

// All remaining routes require Admin
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
router.get('/wix/orphans', wixBookingsController.listWixOrphans);
router.get('/wix/bookings/:id', wixBookingsController.getWixBookingDetails);
router.patch('/wix/bookings/:id', wixBookingsController.editWixBooking);
router.delete('/wix/bookings/:id', wixBookingsController.deleteWixBooking);
router.patch('/wix/bookings/:id/complete', wixBookingsController.completeWixBooking);
router.patch('/wix/bookings/:id/no-show', wixBookingsController.noShowWixBooking);
router.patch('/wix/bookings/:id/cancel-refund', wixBookingsController.cancelRefundWixBooking);
router.post('/wix/bookings/:id/book-next-session', wixBookingsController.bookWixNextSession);
router.post('/wix/bookings/:id/transfer', wixBookingsController.transferWixBooking);
router.post('/wix/bookings/:id/reschedule', wixBookingsController.rescheduleWixBooking);
router.post('/wix/bookings/:id/cancel-only', wixBookingsController.cancelOnlyWixBooking);
router.get('/wix/therapists', wixBookingsController.listWixTherapists);
router.post('/wix/backfill-clients', wixBookingsController.backfillWixClients);

// Workshop / marketing event registrations (Supabase table event_registrations)
// Moved to eventRegistrationsAdmin.js to allow event_organizer access

// Psychologist management (GET moved above requireAdmin)
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
router.get('/wix/platform-sessions', sessionController.getWixDiscoverPlatformSessions);
router.get('/sessions/all', sessionController.getAllSessions);
router.get('/sessions/:sessionId', sessionController.getSessionById);

// Session rescheduling
router.put('/sessions/:sessionId', adminController.updateSession);
router.put('/sessions/:sessionId/no-show', sessionController.markSessionAsNoShow);
router.post('/sessions/:sessionId/complete', sessionController.completeSession);
router.patch('/sessions/:sessionId/cancel-refund', sessionController.cancelRefundSession);
router.patch('/sessions/:sessionId/verify-payment', sessionController.verifyPayment);
router.post('/sessions/:sessionId/transfer', sessionController.transferSession);
router.delete('/sessions/:sessionId', sessionController.deleteSession);
router.get('/psychologists/:psychologistId/availability', adminController.getPsychologistAvailabilityForReschedule);

// Manual booking (admin only - for edge cases)
router.post('/bookings/manual', adminController.createManualBooking);

// Manual package booking (admin only): schedule ALL N sessions of a package upfront
router.post('/bookings/manual-package', adminController.createManualPackageBooking);

// Record-only booking (admin only): add session record only, no Meet creation, no notifications
router.post('/bookings/record-only', adminController.createRecordOnlyBooking);
// Record-only PACKAGE (admin only): record N already-happened sessions of a package, rest bookable later
router.post('/bookings/record-only-package', adminController.createRecordOnlyPackage);

// Book next package session (admin only - for clients who prefer admin to book remaining sessions)
router.post('/bookings/book-package-next-session', adminController.bookPackageNextSession);

// Packages with remaining sessions (admin only - for Packages tab)
router.get('/bookings/packages-with-remaining', adminController.getPackagesWithRemainingSessions);

// Stable A/B/C labels for clients with multiple packages from the same therapist.
// Computed over ALL package sessions (not a paginated page) so labels are consistent
// regardless of the current filter/page.
router.get('/bookings/package-labels', adminController.getPackageLabels);

// Reschedule request handling
router.get('/reschedule-requests', adminController.getRescheduleRequests);

// Assessment session rescheduling (admin can reschedule directly)

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

// Manual trigger for the overbooking crawler (admin only, for testing).
// Scans all therapists for future same-slot double-bookings and emails ops if any found.
router.post('/trigger-overbooking-crawler', async (req, res) => {
  try {
    const overbookingCrawlerService = require('../services/overbookingCrawlerService');
    const result = await overbookingCrawlerService.trigger();
    res.json({
      success: true,
      message: result.clashes > 0
        ? `Found ${result.clashes} overbooked slot(s); alert email sent.`
        : 'No overbookings found; no email sent.',
      data: result,
    });
  } catch (error) {
    console.error('Error triggering overbooking crawler:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// End of admin routes

module.exports = router;
