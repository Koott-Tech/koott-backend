/**
 * Storage access at /api/images/{bucket}/{key...}
 * Used by the Next app (next/image) and by URLs stored in the database.
 *
 * BANDWIDTH: this route used to download every object into this process and send the bytes
 * on (`.download()` → `arrayBuffer()` → `res.send(buf)`). That made Render a file CDN: every
 * byte crossed the network twice (Supabase → Render → client) and counted against Render
 * bandwidth in both directions, with no cache in front of it.
 *
 * Objects in PUBLIC buckets are already world-readable directly from Supabase's CDN, so
 * proxying them bought nothing. Those now get a 302 to the Supabase public URL and the bytes
 * never touch this process.
 *
 * SENSITIVE buckets still proxy, deliberately — see the note on SENSITIVE_BUCKETS below.
 */
const express = require('express');
const path = require('path');
const { supabaseAdmin } = require('../config/supabase');

const router = express.Router();

/**
 * Public buckets: created with `public: true` and holding non-sensitive marketing/profile
 * assets. Serving these from Supabase directly is not a disclosure change — the same bytes
 * are already fetchable from the Supabase public URL without any credential.
 *   blog-images, counselling-images  → utils/storageService.js (public: true)
 *   profile-pictures                 → routes/admin.js (isPrivate === false), routes/psychologists.js
 *   event-materials                  → routes/admin.js (public: true)
 *
 * All four verified against production on 2026-10-03 by probing the Supabase public URL with
 * a non-existent key: a public bucket answers NoSuchKey, a non-public one NoSuchBucket.
 */
const PUBLIC_BUCKETS = new Set([
  'blog-images',
  'counselling-images',
  'profile-pictures',
  'event-materials',
]);

/**
 * Sensitive buckets: still proxied byte-for-byte, i.e. unchanged from before.
 *
 *   manual-bookings     — payment proofs / ID documents (routes/admin.js:77 marks it private)
 *   session-attachments — clinical session attachments
 *
 * These are NOT switched to redirects or signed URLs in this change, on purpose. This route
 * has no authentication of its own (it is hit by <img> tags and next/image, which cannot send
 * an Authorization header), so there is no caller identity here to authorise a signed URL
 * against. Adding auth is a separate, deliberate change that needs the frontend to fetch these
 * through an authenticated client instead of an <img> src.
 *
 * Known issue, pre-existing and unchanged by this commit: `session-attachments` is created
 * with `public: true` in routes/psychologists.js, so its objects are already reachable
 * directly from Supabase by anyone holding the URL. Proxying them here does not prevent that.
 * Locking that bucket down is tracked separately.
 */
const SENSITIVE_BUCKETS = new Set([
  'manual-bookings',
  'session-attachments',
  // Verified against production: `static-files` is NOT a public bucket (a public-URL probe
  // returns NoSuchBucket). Redirecting it would hand the client a Supabase error page instead
  // of a clean 404, so it stays on the proxy path, which 404s exactly as it does today.
  'static-files',
]);

const ALLOWED_BUCKETS = new Set([...PUBLIC_BUCKETS, ...SENSITIVE_BUCKETS]);

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
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

/** Parse `/bucket/object/key.ext` → { bucket, objectKey } or an error response shape. */
function parseRequestPath(reqPath) {
  let rel = reqPath || '';
  if (!rel || rel === '/') return { error: { status: 400, body: { error: 'Path required' } } };
  rel = rel.replace(/^\//, '');

  const firstSlash = rel.indexOf('/');
  if (firstSlash === -1) return { error: { status: 400, body: { error: 'Invalid path' } } };

  const bucket = rel.slice(0, firstSlash);
  let objectKey = rel.slice(firstSlash + 1);
  if (!objectKey) return { error: { status: 400, body: { error: 'Object key required' } } };

  try {
    objectKey = decodeURIComponent(objectKey);
  } catch {
    return { error: { status: 400, body: { error: 'Invalid encoding' } } };
  }

  if (!ALLOWED_BUCKETS.has(bucket)) {
    return { error: { status: 403, body: { error: 'Bucket not allowed' } } };
  }

  const normalized = path.posix.normalize(objectKey);
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    return { error: { status: 400, body: { error: 'Invalid object key' } } };
  }

  return { bucket, objectKey: normalized };
}

/** Byte-for-byte proxy — retained for sensitive buckets only. */
async function proxyObject(req, res, bucket, objectKey) {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(objectKey);

  if (error || !data) {
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[image-proxy] 404 ${bucket}/${objectKey}:`, error?.message || 'no blob');
    }
    return res.status(404).end();
  }

  const buf = Buffer.from(await data.arrayBuffer());

  res.setHeader('Content-Type', contentTypeForFilename(objectKey));
  // Sensitive object: must not be stored by a shared/CDN cache.
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Length', String(buf.length));

  if (req.method === 'HEAD') return res.end();
  return res.send(buf);
}

async function serveImage(req, res) {
  try {
    const parsed = parseRequestPath(req.path);
    if (parsed.error) {
      return res.status(parsed.error.status).json(parsed.error.body);
    }
    const { bucket, objectKey } = parsed;

    if (SENSITIVE_BUCKETS.has(bucket)) {
      return proxyObject(req, res, bucket, objectKey);
    }

    // Public bucket: hand the client straight to Supabase. getPublicUrl is a pure string
    // build — it makes no network call, so nothing is fetched into this process.
    const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(objectKey);
    const publicUrl = data?.publicUrl;

    if (!publicUrl) {
      console.error(`[image-proxy] could not build public URL for ${bucket}/${objectKey}`);
      return res.status(404).end();
    }

    // Cache the redirect itself so repeat views do not even reach this service. 302 (not 301)
    // keeps it reversible: flipping a bucket back to proxying takes effect immediately rather
    // than being pinned in browser caches forever.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
    return res.redirect(302, publicUrl);
  } catch (e) {
    console.error('[image-proxy]', e);
    return res.status(500).end();
  }
}

// Express 4: use regex catch-all (plain '*' is not a reliable splat here)
router.get(/.*/, serveImage);
router.head(/.*/, serveImage);

module.exports = router;
module.exports.PUBLIC_BUCKETS = PUBLIC_BUCKETS;
module.exports.SENSITIVE_BUCKETS = SENSITIVE_BUCKETS;
