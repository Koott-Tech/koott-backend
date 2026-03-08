const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// Generate JWT token - all roles get 30 days (admin, finance, psychologist, superadmin, client, etc.)
const generateToken = (userId, role) => {
  const expiresIn = process.env.JWT_EXPIRES_IN || '30d';

  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};

// Hash password
const hashPassword = async (password) => {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
};

// Compare password
const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

// Generate UUID
const generateUUID = () => {
  return uuidv4();
};

// Format date for database
const formatDate = (date) => {
  // Use local date directly without timezone conversion
  const inputDate = new Date(date);
  return inputDate.toISOString().split('T')[0];
};

// Format time for database
const formatTime = (time) => {
  if (typeof time === 'string') {
    // If it's already a string, ensure it has seconds format (HH:MM:SS)
    if (time.length === 5) {
      return time + ':00'; // Add seconds if missing
    }
    return time;
  }
  return time.toTimeString().slice(0, 8); // Include seconds (HH:MM:SS)
};

// Format time for display: 12-hour with AM/PM, no seconds (e.g. "10:00 AM")
const formatTimeForDisplay = (timeStr) => {
  if (!timeStr) return '';
  const str = String(timeStr).trim();
  const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return str;
  const hour = parseInt(match[1], 10);
  const minute = match[2];
  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minute} ${period}`;
};

// Check if date is in the future
const isFutureDate = (date) => {
  const inputDate = new Date(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return inputDate > today;
};

// Check if time slot is available
const isTimeSlotAvailable = (timeSlot, bookedSlots) => {
  return !bookedSlots.includes(timeSlot);
};

// Calculate session price based on package
const calculateSessionPrice = (packageType, basePrice) => {
  const multipliers = {
    'individual': 1,
    'package_2': 0.9, // 10% discount
    'package_4': 0.8  // 20% discount
  };
  
  return basePrice * (multipliers[packageType] || 1);
};

// Generate invoice number
const generateInvoiceNumber = () => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `INV-${timestamp}-${random}`;
};

// Sanitize phone number
const sanitizePhoneNumber = (phone) => {
  return phone.replace(/[^\d+]/g, '');
};

// Mask phone number for logging (keep last 2-4 digits)
const maskPhoneNumber = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return null;
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) {
    return '***';
  }
  const keepDigits = Math.min(4, Math.max(2, Math.floor(digits.length * 0.2)));
  return '***' + digits.slice(-keepDigits);
};

// Validate email format
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Format currency
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
};

// Get time slots between start and end time
const getTimeSlots = (startTime, endTime, interval = 30) => {
  const slots = [];
  const start = new Date(`2000-01-01T${startTime}`);
  const end = new Date(`2000-01-01T${endTime}`);
  
  while (start < end) {
    slots.push(start.toTimeString().slice(0, 5));
    start.setMinutes(start.getMinutes() + interval);
  }
  
  return slots;
};

// Check if user can access resource
const canAccessResource = (userRole, resourceOwnerId, userId) => {
  if (userRole === 'superadmin') return true;
  if (userRole === 'admin') return true;
  if (userRole === 'finance') return true; // Finance can access financial resources
  return resourceOwnerId === userId;
};

// Generate random string
const generateRandomString = (length = 8) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Pagination helper
const getPaginationParams = (page = 1, limit = 10) => {
  const offset = (page - 1) * limit;
  return { offset, limit, page: parseInt(page), limit: parseInt(limit) };
};

// Response wrapper
const successResponse = (data, message = 'Success') => {
  return {
    success: true,
    message,
    data
  };
};

const errorResponse = (message, error = null, statusCode = 400) => {
  return {
    success: false,
    message,
    error,
    statusCode
  };
};

// Add minutes to time string (HH:MM format)
// Returns time in HH:MM:SS format for Google Calendar API
// Handles day rollover (e.g., 23:00 + 60 minutes = 00:00:00)
const addMinutesToTime = (timeString, minutes) => {
  try {
    // Handle both HH:MM and HH:MM:SS formats
    const timeParts = timeString.split(':');
    const hours = parseInt(timeParts[0]);
    const mins = parseInt(timeParts[1] || '0');
    
    const totalMinutes = hours * 60 + mins + minutes;
    let newHours = Math.floor(totalMinutes / 60);
    const newMins = totalMinutes % 60;
    
    // Handle day rollover (24 hours = next day, reset to 00)
    if (newHours >= 24) {
      newHours = newHours % 24;
    }
    
    // Always return HH:MM:SS format for Google Calendar API
    return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}:00`;
  } catch (error) {
    console.error('Error adding minutes to time:', error);
    return timeString; // Return original if error
  }
};

module.exports = {
  generateToken,
  hashPassword,
  comparePassword,
  generateUUID,
  formatDate,
  formatTime,
  formatTimeForDisplay,
  isFutureDate,
  isTimeSlotAvailable,
  calculateSessionPrice,
  generateInvoiceNumber,
  sanitizePhoneNumber,
  maskPhoneNumber,
  isValidEmail,
  formatCurrency,
  getTimeSlots,
  canAccessResource,
  generateRandomString,
  getPaginationParams,
  successResponse,
  errorResponse,
  addMinutesToTime
};
