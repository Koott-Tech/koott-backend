/**
 * Image URL Converter Utility
 * 
 * Converts existing Supabase direct URLs to proxy URLs and vice versa
 */

/**
 * Convert Supabase storage URL to proxy URL
 * @param {string} supabaseUrl - Direct Supabase storage URL
 * @param {string} frontendUrl - Frontend URL (default: https://www.koott.in)
 * @returns {string|null} Proxy URL or null if invalid
 */
function convertToProxyUrl(supabaseUrl, frontendUrl = 'https://www.koott.in') {
  if (!supabaseUrl || typeof supabaseUrl !== 'string') {
    return null;
  }

  // Check if it's already a proxy URL
  if (supabaseUrl.includes('/api/images/')) {
    return supabaseUrl; // Already a proxy URL
  }

  // Extract bucket and path from Supabase URL
  // Pattern: https://{project_id}.supabase.co/storage/v1/object/public/{bucket}/{path}
  const supabasePattern = /https:\/\/[^.]+\.supabase\.co\/storage\/v1\/object\/public\/([^\/]+)\/(.+)/;
  const match = supabaseUrl.match(supabasePattern);

  if (!match) {
    return null; // Not a valid Supabase storage URL
  }

  const bucket = match[1];
  const filePath = match[2];

  // Construct proxy URL
  return `${frontendUrl}/api/images/${bucket}/${filePath}`;
}

/**
 * Convert proxy URL back to Supabase direct URL (if needed)
 * @param {string} proxyUrl - Proxy URL
 * @param {string} supabaseUrl - Supabase project URL
 * @returns {string|null} Direct Supabase URL or null if invalid
 */
function convertToSupabaseUrl(proxyUrl, supabaseUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') {
    return null;
  }
  
  // Validate supabaseUrl parameter
  if (!supabaseUrl || typeof supabaseUrl !== 'string') {
    return null;
  }

  // Check if it's already a Supabase URL
  if (proxyUrl.includes('.supabase.co/storage/')) {
    return proxyUrl; // Already a Supabase URL
  }

  // Extract bucket and path from proxy URL
  // Pattern: {domain}/api/images/{bucket}/{path}
  const proxyPattern = /\/api\/images\/([^\/]+)\/(.+)/;
  const match = proxyUrl.match(proxyPattern);

  if (!match) {
    return null; // Not a valid proxy URL
  }

  const bucket = match[1];
  const filePath = match[2];

  // Extract project ID from Supabase URL (safe now that supabaseUrl is validated)
  const projectId = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  if (!projectId) {
    return null;
  }

  // Construct Supabase URL
  return `https://${projectId}.supabase.co/storage/v1/object/public/${bucket}/${filePath}`;
}

/**
 * Convert image URL based on environment setting
 * Uses proxy if USE_IMAGE_PROXY is enabled, otherwise returns original
 * @param {string} imageUrl - Image URL (can be either format)
 * @param {string} frontendUrl - Frontend URL
 * @returns {string} Converted URL
 */
function convertImageUrl(imageUrl, frontendUrl = 'https://www.koott.in') {
  // Validate and coerce input to string
  if (!imageUrl) return '';
  if (typeof imageUrl !== 'string') {
    const imageUrlString = String(imageUrl);
    if (!imageUrlString) return '';
    imageUrl = imageUrlString;
  }

  // If proxy is enabled, convert to proxy URL
  if (process.env.USE_IMAGE_PROXY === 'true') {
    const proxyUrl = convertToProxyUrl(imageUrl, frontendUrl);
    return proxyUrl || imageUrl; // Return original if conversion fails
  }

  // Otherwise return as-is (or convert to Supabase URL if it's a proxy URL)
  if (imageUrl.includes('/api/images/')) {
    const supabaseUrl = convertToSupabaseUrl(imageUrl, process.env.SUPABASE_URL);
    return supabaseUrl || imageUrl;
  }

  return imageUrl;
}

/**
 * Extract file path from Supabase URL
 * Useful for getting just the path part for database storage
 * @param {string} supabaseUrl - Supabase storage URL
 * @returns {string|null} File path or null
 */
function extractFilePath(supabaseUrl) {
  if (typeof supabaseUrl !== 'string' || !supabaseUrl.trim()) return null;
  const pattern = /\/storage\/v1\/object\/public\/[^\/]+\/(.+)/;
  const match = supabaseUrl.match(pattern);
  return match ? match[1] : null;
}

/**
 * Extract bucket name from Supabase URL
 * @param {string} supabaseUrl - Supabase storage URL
 * @returns {string|null} Bucket name or null
 */
function extractBucketName(supabaseUrl) {
  if (typeof supabaseUrl !== 'string' || !supabaseUrl.trim()) return null;
  const pattern = /\/storage\/v1\/object\/public\/([^\/]+)\//;
  const match = supabaseUrl.match(pattern);
  return match ? match[1] : null;
}

module.exports = {
  convertToProxyUrl,
  convertToSupabaseUrl,
  convertImageUrl,
  extractFilePath,
  extractBucketName
};

