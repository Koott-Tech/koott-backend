const express = require('express');
const router = express.Router();
const wixBookingsController = require('../controllers/wixBookingsController');

// Wix event/webhook target for near real-time mirroring into Supabase.
router.post('/wix/realtime-sync', wixBookingsController.realtimeSyncFromWix);

module.exports = router;
