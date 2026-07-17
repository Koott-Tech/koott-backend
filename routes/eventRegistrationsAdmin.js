const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

router.get('/', adminController.getEventRegistrations);
router.put('/:registrationId', adminController.updateEventRegistration);
router.delete('/:registrationId', adminController.deleteEventRegistration);

module.exports = router;
