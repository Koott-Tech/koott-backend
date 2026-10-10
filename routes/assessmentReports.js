const express = require('express');
const router = express.Router();
const c = require('../controllers/assessmentReportsController');

// Public: these pages are filled in by clients, not by signed-in staff.
router.get('/questions', c.getQuestions);
router.post('/big-five', c.submitBigFive);
router.post('/dass-21', c.submitDass21);
router.post('/kalyana-raman', c.submitKalyanaRaman);

module.exports = router;
