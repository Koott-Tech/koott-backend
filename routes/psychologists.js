const express = require('express');
const router = express.Router();
const psychologistController = require('../controllers/psychologistController');
const sessionController = require('../controllers/sessionController');
const { authenticateToken, requirePsychologist } = require('../middleware/auth');
const { 
  validatePsychologistProfile,
  validateAvailability
} = require('../utils/validation');
const multer = require('multer');
const path = require('path');
const { supabaseAdmin } = require('../config/supabase');

const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];
    if (!file.mimetype || !allowedMimes.includes(file.mimetype)) {
      return cb(new Error('Only images, PDFs, DOC, DOCX, and TXT files are allowed'));
    }
    cb(null, true);
  }
});

// All routes require authentication and psychologist role
router.use(authenticateToken);
router.use(requirePsychologist);

// File upload for session attachments
router.post('/upload/file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const crypto = require('crypto');
    const uuid = crypto.randomUUID();
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf', '.doc', '.docx', '.txt'];
    const ext = allowedExtensions.includes(rawExt) ? rawExt : '.bin';
    const filename = `${uuid}${ext}`;
    const objectPath = `${filename}`;

    const bucket = 'session-attachments';

    // Upload to Supabase Storage
    let { error: uploadError } = await supabaseAdmin.storage
      .from(bucket)
      .upload(objectPath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    // Auto-heal bucket creation
    if (uploadError && (uploadError.statusCode === '404' || /bucket not found/i.test(uploadError.message || ''))) {
      console.warn(`[upload/file] Bucket "${bucket}" missing — creating it now...`);
      const { error: createErr } = await supabaseAdmin.storage.createBucket(bucket, {
        public: true,
        allowedMimeTypes: [
          'image/jpeg', 'image/png', 'image/webp', 'image/gif',
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'text/plain'
        ],
        fileSizeLimit: 15 * 1024 * 1024,
      });
      if (createErr && !/already exists|already_exists/i.test(createErr.message || '')) {
        console.error('[upload/file] createBucket failed:', createErr);
        return res.status(500).json({ success: false, error: `Storage bucket "${bucket}" missing and could not be created` });
      }

      // Retry upload
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

    const publicUrl = `/api/images/${bucket}/${objectPath}`;

    return res.json({
      success: true,
      url: publicUrl,
      bucket,
      path: objectPath,
      filename: req.file.originalname
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ success: false, error: 'Failed to upload file' });
  }
});


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
