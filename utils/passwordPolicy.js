/**
 * Password Policy Validation
 * 
 * Enforces strong password requirements to prevent weak passwords.
 */

// Common weak passwords to blacklist
const COMMON_PASSWORDS = [
  'password', 'password123', '123456', '12345678', '123456789',
  'qwerty', 'abc123', 'monkey', '1234567', 'letmein', 'trustno1',
  'dragon', 'baseball', 'iloveyou', 'master', 'sunshine', 'ashley',
  'bailey', 'passw0rd', 'shadow', '123123', '654321', 'superman',
  'qazwsx', 'michael', 'football', 'welcome', 'jesus', 'ninja',
  'mustang', 'password1', '1234567890', 'adobe123', 'admin', 'root'
];

/**
 * Shared pattern detection logic for sequential and common patterns
 * @param {string} password - Password to check
 * @returns {boolean} - True if password contains weak patterns
 */
function hasSequentialOrCommonPattern(password) {
  if (!password || typeof password !== 'string') return false;
  
  const passwordLower = password.toLowerCase();
  
  // Check against common passwords
  if (COMMON_PASSWORDS.includes(passwordLower)) {
    return true;
  }
  
  // Check for repeated characters (e.g., "aaaaaa")
  if (/(.)\1{3,}/.test(password)) {
    return true;
  }
  
  // Check for sequential characters (e.g., "12345", "abcde", "23456")
  const sequentialPatterns = [
    /01234|12345|23456|34567|45678|56789/i,
    /abcdef|bcdefg|cdefgh|defghi|efghij|fghijk|ghijkl|hijklm|ijklmn|jklmno|klmnop|lmnopq|mnopqr|nopqrs|opqrst|pqrstu|qrstuv|rstuvw|stuvwx|tuvwxy|uvwxyz/i,
    /qwerty/i
  ];
  
  return sequentialPatterns.some(pattern => pattern.test(password));
}

/**
 * Validate password against policy
 * @param {string} password - Password to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
function validatePassword(password) {
  const errors = [];

  if (!password || typeof password !== 'string') {
    return { valid: false, errors: ['Password is required'] };
  }

  // Minimum length: 8 characters
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  // Maximum length: 128 characters (prevent DoS)
  if (password.length > 128) {
    errors.push('Password must be at most 128 characters');
  }

  // Require uppercase letter
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  // Require lowercase letter
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  // Require number
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  // Require special character
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character (!@#$%^&*...)');
  }

  // Check for weak patterns using shared logic
  if (hasSequentialOrCommonPattern(password)) {
    const passwordLower = password.toLowerCase();
    if (COMMON_PASSWORDS.includes(passwordLower)) {
      errors.push('Password is too common. Please choose a more unique password');
    } else if (/(.)\1{3,}/.test(password)) {
      errors.push('Password contains too many repeated characters');
    } else {
      errors.push('Password contains sequential characters');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

/**
 * Get password strength score (0-85)
 * @param {string} password - Password to score
 * @returns {number} - Strength score (0-85)
 */
function getPasswordStrength(password) {
  if (typeof password !== 'string') return 0;
  if (!password) return 0;

  let score = 0;

  // Length bonus (max 25 points)
  if (password.length >= 8) score += 10;
  if (password.length >= 12) score += 10;
  if (password.length >= 16) score += 5;

  // Character variety (max 40 points)
  if (/[a-z]/.test(password)) score += 10;
  if (/[A-Z]/.test(password)) score += 10;
  if (/[0-9]/.test(password)) score += 10;
  if (/[^a-zA-Z0-9]/.test(password)) score += 10;

  // Complexity bonus (max 20 points)
  const uniqueChars = new Set(password).size;
  if (uniqueChars >= password.length * 0.5) score += 10;
  if (uniqueChars >= password.length * 0.7) score += 10;

  // Penalties using shared pattern detection
  if (hasSequentialOrCommonPattern(password)) {
    const passwordLower = password.toLowerCase();
    if (COMMON_PASSWORDS.includes(passwordLower)) {
      score -= 50;
    } else if (/(.)\1{3,}/.test(password)) {
      score -= 20;
    } else {
      score -= 30; // Sequential pattern penalty
    }
  }

  return Math.max(0, Math.min(85, score));
}

module.exports = {
  validatePassword,
  getPasswordStrength,
  COMMON_PASSWORDS
};

