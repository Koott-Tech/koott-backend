// Use supabaseAdmin from config for consistency and RLS bypass
const { supabaseAdmin } = require('../config/supabase');
// Alias for storage operations (same client, just for clarity)
const supabase = supabaseAdmin;

const path = require('path');
const BLOG_IMAGES_BUCKET = 'blog-images';
const COUNSELLING_IMAGES_BUCKET = 'counselling-images';

/**
 * Sanitize file path for storage: reject empty/absolute, posix-normalize, detect '..'.
 * Uses '/' for splitting so it works with path.posix.normalize() on all platforms.
 * @param {string} filePath - Raw file path
 * @returns {{ valid: boolean, normalizedPath?: string, error?: string }}
 */
function sanitizeFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'Path is required' };
  }
  const trimmed = filePath.trim();
  if (trimmed === '' || path.isAbsolute(trimmed)) {
    return { valid: false, error: 'Empty or absolute path not allowed' };
  }
  let normalizedPath = trimmed.replace(/^\/+/, '');
  normalizedPath = path.posix.normalize(normalizedPath);
  const segments = normalizedPath.split('/');
  if (segments.includes('..')) {
    return { valid: false, error: 'Path traversal not allowed' };
  }
  return { valid: true, normalizedPath };
}

/**
 * Upload image to blog images bucket
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} fileName - Unique file name
 * @param {string} mimeType - File MIME type
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
async function uploadBlogImage(fileBuffer, fileName, mimeType) {
  try {
    const { data, error } = await supabase.storage
      .from(BLOG_IMAGES_BUCKET)
      .upload(fileName, fileBuffer, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: false // Don't overwrite existing files
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return { success: false, error: error.message };
    }

    return { success: true, data: data };
  } catch (error) {
    console.error('Upload error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete image from blog images bucket
 * @param {string} filePath - File path in bucket
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteBlogImage(filePath) {
  try {
    const { error } = await supabase.storage
      .from(BLOG_IMAGES_BUCKET)
      .remove([filePath]);

    if (error) {
      console.error('Supabase delete error:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('Delete error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get secure URL for blog image (uses proxy with signed URLs)
 * Since buckets are now private, we always use proxy URLs which generate signed URLs on-the-fly
 * @param {string} filePath - File path in bucket
 * @returns {string} Proxy URL (which will generate signed URL when accessed)
 */
function getBlogImageUrl(filePath) {
  const result = sanitizeFilePath(filePath);
  if (!result.valid) {
    if (result.error && result.error.includes('traversal')) {
      console.warn('⚠️ Path traversal detected in blog image path:', filePath);
    }
    return null;
  }
  return `/api/images/${BLOG_IMAGES_BUCKET}/${result.normalizedPath}`;
}

/**
 * Generate signed URL for blog image (for direct access if needed)
 * @param {string} filePath - File path in bucket
 * @param {number} expiresIn - Expiration time in seconds (default: 1 hour)
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
async function getBlogImageSignedUrl(filePath, expiresIn = 3600) {
  const result = sanitizeFilePath(filePath);
  if (!result.valid) {
    if (result.error && result.error.includes('traversal')) {
      console.warn('⚠️ Path traversal detected in blog image signed URL path:', filePath);
    }
    return { success: false, error: result.error || 'Invalid file path' };
  }
  const normalizedPath = result.normalizedPath;
  try {
    const { data, error } = await supabase.storage
      .from(BLOG_IMAGES_BUCKET)
      .createSignedUrl(normalizedPath, expiresIn);
    
    if (error) {
      console.error('Error creating signed URL:', error);
      return { success: false, error: error.message };
    }
    if (!data || !data.signedUrl) {
      console.error('getBlogImageSignedUrl: missing data or signedUrl');
      return { success: false, error: 'Failed to generate signed URL' };
    }
    return { success: true, url: data.signedUrl };
  } catch (error) {
    console.error('Error generating signed URL:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Generate unique filename for blog image
 * @param {string} originalName - Original filename
 * @param {string} blogTitle - Blog title for context
 * @returns {string} Unique filename
 */
function generateUniqueFileName(originalName, blogTitle) {
  const timestamp = Date.now();
  const extension = originalName.split('.').pop().toLowerCase();
  const slug = blogTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .substring(0, 30); // Limit length
    
  return `blog-${slug}-${timestamp}.${extension}`;
}

/**
 * Validate image file
 * @param {object} file - File object
 * @returns {{valid: boolean, error?: string}}
 */
function validateImageFile(file) {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
  const maxSize = 5 * 1024 * 1024; // 5MB

  if (!file) {
    return { valid: false, error: 'No file provided' };
  }

  if (!allowedTypes.includes(file.mimetype)) {
    return { valid: false, error: 'Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed' };
  }

  if (file.size > maxSize) {
    return { valid: false, error: 'File too large. Maximum size is 5MB' };
  }

  return { valid: true };
}

/**
 * Upload image to counselling images bucket
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} fileName - Unique file name
 * @param {string} mimeType - File MIME type
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
async function uploadCounsellingImage(fileBuffer, fileName, mimeType) {
  try {
    const { data, error } = await supabase.storage
      .from(COUNSELLING_IMAGES_BUCKET)
      .upload(fileName, fileBuffer, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: true // Allow overwriting for counselling pages
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return { success: false, error: error.message };
    }

    return { success: true, data: data };
  } catch (error) {
    console.error('Upload error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete image from counselling images bucket
 * @param {string} filePath - File path in bucket
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteCounsellingImage(filePath) {
  try {
    const { error } = await supabase.storage
      .from(COUNSELLING_IMAGES_BUCKET)
      .remove([filePath]);

    if (error) {
      console.error('Supabase delete error:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('Delete error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get secure URL for counselling image (uses proxy with signed URLs)
 * Since buckets are now private, we always use proxy URLs which generate signed URLs on-the-fly
 * @param {string} filePath - File path in bucket
 * @returns {string} Proxy URL (which will generate signed URL when accessed)
 */
function getCounsellingImageUrl(filePath) {
  const result = sanitizeFilePath(filePath);
  if (!result.valid) {
    if (result.error && result.error.includes('traversal')) {
      console.warn('⚠️ Path traversal detected in counselling image path:', filePath);
    }
    return null;
  }
  return `/api/images/${COUNSELLING_IMAGES_BUCKET}/${result.normalizedPath}`;
}

/**
 * Generate signed URL for counselling image (for direct access if needed)
 * @param {string} filePath - File path in bucket
 * @param {number} expiresIn - Expiration time in seconds (default: 1 hour)
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
async function getCounsellingImageSignedUrl(filePath, expiresIn = 3600) {
  const result = sanitizeFilePath(filePath);
  if (!result.valid) {
    if (result.error && result.error.includes('traversal')) {
      console.warn('⚠️ Path traversal detected in counselling image signed URL path:', filePath);
    }
    return { success: false, error: result.error || 'Invalid file path' };
  }
  const normalizedPath = result.normalizedPath;
  try {
    const { data, error } = await supabase.storage
      .from(COUNSELLING_IMAGES_BUCKET)
      .createSignedUrl(normalizedPath, expiresIn);
    
    if (error) {
      console.error('Error creating signed URL:', error);
      return { success: false, error: error.message };
    }
    
    if (!data || !data.signedUrl) {
      console.error('getCounsellingImageSignedUrl: missing data or signedUrl');
      return { success: false, error: 'Signed URL missing' };
    }
    
    return { success: true, url: data.signedUrl };
  } catch (error) {
    console.error('Error generating signed URL:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Generate unique filename for counselling image
 * @param {string} originalName - Original filename
 * @param {string} slug - Page slug for context
 * @param {string} imageType - Type of image (hero, right, mobile, etc)
 * @returns {string} Unique filename
 */
function generateCounsellingFileName(originalName, slug, imageType) {
  const timestamp = Date.now();
  const extension = originalName.split('.').pop().toLowerCase();
  const cleanSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
    
  return `${cleanSlug}-${imageType}-${timestamp}.${extension}`;
}

module.exports = {
  uploadBlogImage,
  deleteBlogImage,
  getBlogImageUrl,
  getBlogImageSignedUrl,
  generateUniqueFileName,
  validateImageFile,
  uploadCounsellingImage,
  deleteCounsellingImage,
  getCounsellingImageUrl,
  generateCounsellingFileName
};
