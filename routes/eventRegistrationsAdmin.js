const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

router.get('/', adminController.getEventRegistrations);
router.post('/', adminController.createEventRegistration);
router.put('/:registrationId', adminController.updateEventRegistration);
router.delete('/:registrationId', adminController.deleteEventRegistration);

module.exports = router;
