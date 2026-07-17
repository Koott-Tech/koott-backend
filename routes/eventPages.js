const express = require('express');
const router = express.Router();
const { authenticateToken, requireEventOrganizer } = require('../middleware/auth');
const validateCSRF = require('../middleware/csrf');
const {
  getPublicBySlug,
  listPublic,
  listAdmin,
  getByIdAdmin,
  createPage,
  updatePage,
  deletePage,
} = require('../controllers/eventPagesController');

router.get('/public', listPublic);
router.get('/public/:slug', getPublicBySlug);

const adminLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: 'Too many requests' },
});

router.use(adminLimiter);
router.use(validateCSRF);
router.use(authenticateToken);
router.use(requireEventOrganizer);

router.get('/admin', listAdmin);
router.get('/admin/:id', getByIdAdmin);
router.post('/admin', createPage);
router.put('/admin/:id', updatePage);
router.delete('/admin/:id', deletePage);

module.exports = router;
