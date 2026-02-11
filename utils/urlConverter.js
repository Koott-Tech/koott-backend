/**
 * URL Converter Utility
 * 
 * Converts absolute URLs in database to relative URLs for development/production compatibility
 */

/**
 * Convert absolute proxy URL to relative URL
 * Converts: https://www.little.care/api/images/... → /api/images/...
 * Or: http://localhost:3000/api/images/... → /api/images/...
 * @param {string} url - Absolute URL
 * @returns {string} Relative URL
 */
function convertToRelativeUrl(url) {
  if (!url || typeof url !== 'string') return url;
  
  // If it's already a relative URL, return as-is
  if (url.startsWith('/')) return url;
  
  // Extract the path from absolute URL
  try {
    const urlObj = new URL(url);
    return urlObj.pathname + (urlObj.search || '') + (urlObj.hash || '');
  } catch (e) {
    // If URL parsing fails, try regex
    const match = url.match(/\/api\/images\/.+/);
    if (match) {
      return match[0];
    }
    // If no match, return original (might be external URL)
    return url;
  }
}

/**
 * Convert image URL to relative format if it's a proxy URL
 * Useful for converting database URLs to work in any environment
 * @param {string} imageUrl - Image URL (absolute or relative)
 * @returns {string} Relative URL
 */
function normalizeImageUrl(imageUrl) {
  // Validate input is string
  if (!imageUrl) return imageUrl;
  if (typeof imageUrl !== 'string') {
    const imageUrlString = String(imageUrl);
    if (!imageUrlString) return '';
    imageUrl = imageUrlString;
  }
  
  // If it's already relative, return as-is
  if (imageUrl.startsWith('/')) return imageUrl;
  
  // If it's a proxy URL (little.care or localhost), convert to relative
  if (imageUrl.includes('/api/images/')) {
    return convertToRelativeUrl(imageUrl);
  }
  
  // Otherwise return as-is (might be external URL)
  return imageUrl;
}

module.exports = {
  convertToRelativeUrl,
  normalizeImageUrl
};

