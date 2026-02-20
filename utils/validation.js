const { body, validationResult } = require('express-validator');

// Validation result handler
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation Error',
      message: 'Please check your input',
      details: errors.array()
    });
  }
  next();
};

// Client registration validation (only clients can register)
const validateClientRegistration = [
  body('email')
    .isEmail()
    .withMessage('Please provide a valid email address'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
  handleValidationErrors
];

// User login validation
const validateUserLogin = [
  body('email')
    .isEmail()
    .withMessage('Please provide a valid email address'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  handleValidationErrors
];

// Client profile validation
const validateClientProfile = [
  body('first_name')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('First name must be between 1 and 50 characters'),
  body('last_name')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 50 })
    .withMessage('Last name must be at most 50 characters'),
  body('phone_number')
    .matches(/^\+?[\d\s\-\(\)]+$/)
    .withMessage('Please provide a valid phone number'),
  // Make child fields optional - allow null, empty, or valid values
  body('child_name')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Child name must be between 2 and 50 characters if provided'),
  body('child_age')
    .optional({ nullable: true, checkFalsy: true })
    .custom((value) => {
      // Explicitly reject 0 while allowing null/undefined/empty string
      if (value === 0 || value === '0') {
        throw new Error('Child age cannot be 0');
      }
      return true;
    })
    .isInt({ min: 1, max: 18 })
    .withMessage('Child age must be between 1 and 18 years if provided'),
  handleValidationErrors
];

// Psychologist profile validation
// Normalize area_of_expertise: frontend may send comma-separated string; we accept string or array
const normalizeAreaOfExpertise = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const arr = value.split(',').map(s => s.trim()).filter(Boolean);
    return arr;
  }
  return [];
};

// Partial update: validate only fields that are present (PUT can send only changed fields)
const validatePsychologistProfile = [
  body('first_name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('First name must be between 2 and 50 characters'),
  body('last_name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Last name must be between 2 and 50 characters'),
  body('phone')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Phone is required when provided'),
  body('ug_college')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Undergraduate college is required when provided'),
  body('pg_college')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Postgraduate college is required when provided'),
  body('mphil_college')
    .optional()
    .trim(),
  body('phd_college')
    .optional()
    .trim(),
  body('designation')
    .optional()
    .isIn(['fulltime', 'parttime'])
    .withMessage('Designation must be either fulltime or parttime'),
  body('area_of_expertise')
    .optional()
    .custom((value) => {
      const arr = normalizeAreaOfExpertise(value);
      if (arr.length === 0) throw new Error('At least one area of expertise is required when provided');
      return true;
    })
    .customSanitizer((value) => (value === undefined || value === null ? undefined : normalizeAreaOfExpertise(value))),
  body('area_of_expertise.*')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Each expertise area must be between 2 and 100 characters'),
  body('description')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 0, max: 1000 })
    .withMessage('Description (about) must be at most 1000 characters'),
  body('experience_years')
    .optional(),
  body('cover_image_url')
    .optional()
    .trim(),
  body('personality_traits')
    .optional(),
  body('display_order')
    .optional(),
  body('faq_question_1')
    .optional()
    .trim(),
  body('faq_answer_1')
    .optional()
    .trim(),
  body('faq_question_2')
    .optional()
    .trim(),
  body('faq_answer_2')
    .optional()
    .trim(),
  body('faq_question_3')
    .optional()
    .trim(),
  body('faq_answer_3')
    .optional()
    .trim(),
  handleValidationErrors
];

// Package validation
const validatePackage = [
  body('package_type')
    .isIn(['individual', 'package_2', 'package_4'])
    .withMessage('Invalid package type'),
  body('price')
    .isFloat({ min: 0 })
    .withMessage('Price must be a positive number'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description must not exceed 500 characters'),
  handleValidationErrors
];

// Session booking validation
const validateSessionBooking = [
  body('psychologist_id')
    .isUUID()
    .withMessage('Invalid psychologist ID'),
  body('package_id')
    .isUUID()
    .withMessage('Invalid package ID'),
  body('scheduled_date')
    .isISO8601()
    .withMessage('Invalid date format'),
  body('scheduled_time')
    .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('Invalid time format (HH:MM)'),
  handleValidationErrors
];

// Session update validation
const validateSessionUpdate = [
  body('status')
    .optional()
    .isIn(['booked', 'noshow', 'rescheduled', 'canceled', 'completed'])
    .withMessage('Invalid session status'),
  body('feedback')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Feedback must not exceed 1000 characters'),
  body('session_summary')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Session summary must not exceed 2000 characters'),
  body('session_notes')
    .optional()
    .trim()
    .isLength({ max: 5000 })
    .withMessage('Session notes must not exceed 5000 characters'),
  handleValidationErrors
];

// Availability validation
const validateAvailability = [
  body('date')
    .isISO8601()
    .withMessage('Invalid date format'),
  body('time_slots')
    .isArray({ min: 1 })
    .withMessage('At least one time slot is required'),
  body('time_slots.*')
    .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('Invalid time slot format (HH:MM)'),
  handleValidationErrors
];

module.exports = {
  handleValidationErrors,
  validateClientRegistration,
  validateUserLogin,
  validateClientProfile,
  validatePsychologistProfile,
  validatePackage,
  validateSessionBooking,
  validateSessionUpdate,
  validateAvailability
};
