const express = require('express');
const router = express.Router();
const wixBookingsController = require('../controllers/wixBookingsController');

// Wix Webhook Endpoint
// This should be called by Wix Velo events.js onBookingCreated
router.post('/booking', wixBookingsController.handleWixWebhook);

module.exports = router;
