// Blog content processing utilities for backend
const path = require('path');

/**
 * Process and validate structured content
 * @param {Array} structuredContent - Array of content blocks
 * @returns {Array|null} Processed structured content or null
 */
const processStructuredContent = (structuredContent) => {
  if (!Array.isArray(structuredContent)) {
    return null;
  }

  return structuredContent.map(block => {
    if (!block || typeof block !== 'object' || !block.type) {
      return {
        type: 'paragraph',
        content: 'Invalid content block'
      };
    }

    switch (block.type) {
      case 'paragraph':
        return {
          type: 'paragraph',
          content: sanitizeText(block.content || '')
        };
      
      case 'heading':
        return {
          type: 'heading',
          level: Math.min(Math.max(parseInt(block.level) || 2, 1), 6),
          content: sanitizeText(block.content || '')
        };
      
      case 'image':
        return {
          type: 'image',
          src: sanitizeUrl(block.src || ''),
          alt: sanitizeText(block.alt || ''),
          caption: sanitizeText(block.caption || '')
        };
      
      case 'bulletList':
        return {
          type: 'bulletList',
          items: Array.isArray(block.items) 
            ? block.items.map(item => sanitizeText(item))
            : []
        };
      
      case 'numberedList':
        return {
          type: 'numberedList',
          items: Array.isArray(block.items) 
            ? block.items.map(item => sanitizeText(item))
            : []
        };
      
      case 'spacer':
        return {
          type: 'spacer'
        };
      
      case 'quote':
        return {
          type: 'quote',
          content: sanitizeText(block.content || ''),
          author: sanitizeText(block.author || '')
        };
      
      default:
        return {
          type: 'paragraph',
          content: sanitizeText(block.content || '')
        };
    }
  });
};

/**
 * Sanitize text content
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
const sanitizeText = (text) => {
  if (typeof text !== 'string') {
    return '';
  }

  // Remove potentially dangerous HTML tags
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/<link\b[^<]*(?:(?!<\/link>)<[^<]*)*<\/link>/gi, '')
    .replace(/<meta\b[^<]*(?:(?!<\/meta>)<[^<]*)*<\/meta>/gi, '')
    .trim();
};

/**
 * Sanitize URL
 * @param {string} url - URL to sanitize
 * @returns {string} Sanitized URL
 */
const sanitizeUrl = (url) => {
  if (typeof url !== 'string' || !url.trim()) {
    return '';
  }

  const trimmedUrl = url.trim();

  // If it's a relative path, validate and normalize to prevent path traversal
  if (trimmedUrl.startsWith('/') || trimmedUrl.startsWith('./') || trimmedUrl.startsWith('../')) {
    // Normalize the path and check for path traversal
    const normalized = path.posix.normalize(trimmedUrl);
    const segments = normalized.split('/').filter(Boolean);
    const hasParent = segments.some(seg => seg === '..') || normalized.startsWith('/../') || normalized.startsWith('/..');
    if (hasParent || normalized.includes('../') || normalized.startsWith('../')) {
      console.warn('⚠️ Path traversal detected in image src:', trimmedUrl);
      return '';
    }
    // Reject absolute paths that might escape
    if (normalized.startsWith('/') && normalized !== '/') {
      // Allow root-relative paths but validate they don't escape
      return normalized;
    }
    return normalized;
  }

  // Normalize URL by adding protocol if missing
  let normalizedUrl = trimmedUrl;
  
  // If it already has a protocol, validate it
  if (trimmedUrl.match(/^https?:\/\//i)) {
    normalizedUrl = trimmedUrl;
  } else if (trimmedUrl.startsWith('//')) {
    // Protocol-relative URL, add https:
    normalizedUrl = `https:${trimmedUrl}`;
  } else if (trimmedUrl.includes('.') && !trimmedUrl.includes(' ')) {
    // Looks like a domain, add https://
    normalizedUrl = `https://${trimmedUrl}`;
  }

  // Validate the normalized URL
  try {
    const parsedUrl = new URL(normalizedUrl);
    
    // Only allow http and https protocols
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return '';
    }

    return parsedUrl.toString();
  } catch (error) {
    // If URL parsing still fails, return empty string
    return '';
  }
};

/**
 * Validate structured content format
 * @param {Array} structuredContent - Array of content blocks
 * @returns {Object} Validation result
 */
const validateStructuredContent = (structuredContent) => {
  const errors = [];

  if (!Array.isArray(structuredContent)) {
    errors.push('Content must be an array of blocks');
    return { isValid: false, errors };
  }

  if (structuredContent.length === 0) {
    errors.push('Content cannot be empty');
    return { isValid: false, errors };
  }

  structuredContent.forEach((block, index) => {
    if (!block || typeof block !== 'object') {
      errors.push(`Block ${index} is invalid`);
      return;
    }

    if (!block.type) {
      errors.push(`Block ${index} is missing type`);
      return;
    }

    switch (block.type) {
      case 'paragraph':
        if (!block.content || typeof block.content !== 'string') {
          errors.push(`Block ${index} (paragraph) is missing content`);
        }
        break;

      case 'heading':
        if (!block.content || typeof block.content !== 'string') {
          errors.push(`Block ${index} (heading) is missing content`);
        }
        if (block.level && (block.level < 1 || block.level > 6)) {
          errors.push(`Block ${index} (heading) has invalid level`);
        }
        break;

      case 'image':
        if (!block.src || typeof block.src !== 'string') {
          errors.push(`Block ${index} (image) is missing src`);
        }
        break;

      case 'bulletList':
      case 'numberedList':
        if (!Array.isArray(block.items)) {
          errors.push(`Block ${index} (${block.type}) is missing items array`);
        } else if (block.items.length === 0) {
          errors.push(`Block ${index} (${block.type}) has empty items array`);
        }
        break;

      case 'spacer':
        // Spacer blocks have no required fields
        break;

      case 'quote':
        if (!block.content || typeof block.content !== 'string') {
          errors.push(`Block ${index} (quote) is missing content`);
        }
        break;

      default:
        errors.push(`Block ${index} has unknown type: ${block.type}`);
    }
  });

  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 * Calculate estimated reading time for structured content
 * @param {Array} structuredContent - Array of content blocks
 * @returns {number} Estimated reading time in minutes
 */
const calculateReadingTime = (structuredContent) => {
  if (!Array.isArray(structuredContent)) return 5;

  let wordCount = 0;

  structuredContent.forEach(block => {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
      case 'quote':
        if (block.content) {
          wordCount += block.content.split(/\s+/).length;
        }
        break;

      case 'bulletList':
      case 'numberedList':
        if (Array.isArray(block.items)) {
          block.items.forEach(item => {
            wordCount += item.split(/\s+/).length;
          });
        }
        break;

      case 'spacer':
        // Spacer blocks don't contribute to reading time
        break;
    }
  });

  // Average reading speed: 200 words per minute
  const readingTime = Math.ceil(wordCount / 200);
  return Math.max(readingTime, 1); // Minimum 1 minute
};

/**
 * Extract images from structured content
 * @param {Array} structuredContent - Array of content blocks
 * @returns {Array} Array of image objects
 */
const extractImagesFromContent = (structuredContent) => {
  if (!Array.isArray(structuredContent)) return [];

  return structuredContent
    .filter(block => block.type === 'image')
    .map(block => ({
      src: block.src,
      alt: block.alt,
      caption: block.caption
    }));
};

/**
 * Convert HTML content to structured content
 * @param {string} htmlContent - HTML content
 * @returns {Array} Structured content blocks
 */
const htmlToStructuredContent = (htmlContent) => {
  if (!htmlContent || typeof htmlContent !== 'string') {
    return [];
  }

  // This is a simplified HTML parser
  // In production, you might want to use a proper HTML parser like cheerio
  const blocks = [];
  
  // Split content by HTML tags and process
  const tagRegex = /<(h[1-6]|p|ul|ol|blockquote|img|a)[^>]*>.*?<\/\1>/gi;
  const matches = htmlContent.match(tagRegex) || [];

  matches.forEach(match => {
    const block = parseHtmlBlock(match);
    if (block) {
      blocks.push(block);
    }
  });

  return blocks;
};

/**
 * Parse individual HTML block
 * @param {string} htmlBlock - HTML block string
 * @returns {Object|null} Structured block or null
 */
const parseHtmlBlock = (htmlBlock) => {
  // This is a simplified parser
  // In production, use a proper HTML parser
  
  if (htmlBlock.startsWith('<p')) {
    const content = htmlBlock.replace(/<[^>]*>/g, '').trim();
    return content ? { type: 'paragraph', content } : null;
  }

  if (htmlBlock.match(/<h[1-6]/)) {
    const levelMatch = htmlBlock.match(/<h([1-6])/);
    const content = htmlBlock.replace(/<[^>]*>/g, '').trim();
    return content ? { 
      type: 'heading', 
      level: parseInt(levelMatch[1]), 
      content 
    } : null;
  }

  if (htmlBlock.startsWith('<ul')) {
    // Parse list items
    const items = [];
    const liMatches = htmlBlock.match(/<li[^>]*>.*?<\/li>/gi) || [];
    liMatches.forEach(li => {
      const content = li.replace(/<[^>]*>/g, '').trim();
      if (content) items.push(content);
    });
    return items.length > 0 ? { type: 'bulletList', items } : null;
  }

  if (htmlBlock.startsWith('<ol')) {
    // Parse list items
    const items = [];
    const liMatches = htmlBlock.match(/<li[^>]*>.*?<\/li>/gi) || [];
    liMatches.forEach(li => {
      const content = li.replace(/<[^>]*>/g, '').trim();
      if (content) items.push(content);
    });
    return items.length > 0 ? { type: 'numberedList', items } : null;
  }

  if (htmlBlock.startsWith('<img')) {
    const srcMatch = htmlBlock.match(/src=["']([^"']*)["']/);
    const altMatch = htmlBlock.match(/alt=["']([^"']*)["']/);
    return srcMatch ? {
      type: 'image',
      src: srcMatch[1],
      alt: altMatch ? altMatch[1] : ''
    } : null;
  }

  return null;
};

module.exports = {
  processStructuredContent,
  validateStructuredContent,
  calculateReadingTime,
  extractImagesFromContent,
  htmlToStructuredContent,
  sanitizeText,
  sanitizeUrl
};
