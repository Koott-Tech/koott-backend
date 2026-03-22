const express = require('express');
const router = express.Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getAllCareers,
  getCareerBySlug,
  getCareerById,
  createCareer,
  updateCareer,
  deleteCareer,
} = require('../controllers/careerController');

// Public routes
router.get('/', getAllCareers);
router.get('/slug/:slug', getCareerBySlug);

// Admin routes
router.get('/admin', authenticateToken, requireAdmin, getAllCareers);
router.get('/admin/:id', authenticateToken, requireAdmin, getCareerById);
router.post('/admin', authenticateToken, requireAdmin, createCareer);
router.put('/admin/:id', authenticateToken, requireAdmin, updateCareer);
router.delete('/admin/:id', authenticateToken, requireAdmin, deleteCareer);

module.exports = router;

