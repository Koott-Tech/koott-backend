/**
 * Public proxy for Supabase Storage objects at /api/images/{bucket}/{key...}
 * Used by the Next app (next/image) and stored URLs. No auth — buckets are
 * expected to be readable only through this allowlist + service role download.
 */
const express = require('express');
const path = require('path');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

const ALLOWED_BUCKETS = new Set([
  'blog-images',
  'counselling-images',
  'profile-pictures',
  'manual-bookings',
  'static-files',
]);

function contentTypeForFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
  };
  return map[ext] || 'application/octet-stream';
}

async function serveImage(req, res) {
  try {
    let rel = req.path || '';
    if (!rel || rel === '/') {
      return res.status(400).json({ error: 'Path required' });
    }
    rel = rel.replace(/^\//, '');
    const firstSlash = rel.indexOf('/');
    if (firstSlash === -1) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const bucket = rel.slice(0, firstSlash);
    let objectKey = rel.slice(firstSlash + 1);
    if (!objectKey) {
      return res.status(400).json({ error: 'Object key required' });
    }

    try {
      objectKey = decodeURIComponent(objectKey);
    } catch {
      return res.status(400).json({ error: 'Invalid encoding' });
    }

    if (!ALLOWED_BUCKETS.has(bucket)) {
      return res.status(403).json({ error: 'Bucket not allowed' });
    }

    const normalized = path.posix.normalize(objectKey);
    if (normalized.startsWith('..') || normalized.includes('/../')) {
      return res.status(400).json({ error: 'Invalid object key' });
    }

    const { data, error } = await supabaseAdmin.storage.from(bucket).download(normalized);

    if (error || !data) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[image-proxy] 404 ${bucket}/${normalized}:`, error?.message || 'no blob');
      }
      return res.status(404).end();
    }

    const buf = Buffer.from(await data.arrayBuffer());
    const ct = contentTypeForFilename(normalized);

    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('Content-Length', String(buf.length));

    if (req.method === 'HEAD') {
      return res.end();
    }
    return res.send(buf);
  } catch (e) {
    console.error('[image-proxy]', e);
    return res.status(500).end();
  }
}

// Express 4: use regex catch-all (plain '*' is not a reliable splat here)
router.get(/.*/, serveImage);
router.head(/.*/, serveImage);

module.exports = router;
