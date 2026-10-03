/**
 * Bandwidth instrumentation. Entirely inert unless BANDWIDTH_AUDIT=true.
 *
 * Answers one question: of the bandwidth this service burns, how much is outbound traffic we
 * initiate (Supabase, Wix, Google, Meta) versus responses we send to clients, and which
 * host/route is responsible.
 *
 * Reports are AGGREGATED on an interval — never one line per request, which would make the
 * Render log both unreadable and expensive.
 *
 * Privacy: records method, hostname, a coarsened path, status, byte counts and duration.
 * Query strings are dropped wholesale (they carry tokens and ids), as are all headers and all
 * request/response bodies. Nothing user-identifying is recorded: no emails, phone numbers,
 * client or session content, message bodies.
 */

const ENABLED = String(process.env.BANDWIDTH_AUDIT || '').toLowerCase() === 'true';

const outbound = new Map(); // host -> { requests, down, up }
const inbound = new Map();  // "METHOD /route" -> { calls, bytes }

/** uuids / long ids / digit runs → placeholders, so routes group instead of fragmenting. */
function coarsenPath(pathname) {
  return String(pathname || '')
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d{3,}/g, '/:id')
    .replace(/\/[A-Za-z0-9_-]{24,}/g, '/:key');
}

function fmt(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)}GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function addOutbound(host, up, down) {
  const prev = outbound.get(host) || { requests: 0, down: 0, up: 0 };
  prev.requests += 1;
  prev.up += up;
  prev.down += down;
  outbound.set(host, prev);
}

function addInbound(key, bytes) {
  const prev = inbound.get(key) || { calls: 0, bytes: 0 };
  prev.calls += 1;
  prev.bytes += bytes;
  inbound.set(key, prev);
}

/* ---------------------------------------------------------------- *
 * inbound: response bytes per Express route
 * ---------------------------------------------------------------- */

/**
 * Counts bytes written to the socket (not Content-Length), so streamed and compressed
 * responses are measured accurately. Mount AFTER compression() to get billed wire bytes.
 * Returns a pass-through middleware when the audit is off.
 */
function responseSizeMeter() {
  if (!ENABLED) return (req, res, next) => next();

  return function responseSizeMeterMiddleware(req, res, next) {
    let bytes = 0;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    const count = (chunk, encoding) => {
      if (!chunk || typeof chunk === 'function') return;
      bytes += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    };

    res.write = (chunk, encoding, cb) => { count(chunk, encoding); return origWrite(chunk, encoding, cb); };
    res.end = (chunk, encoding, cb) => {
      count(chunk, encoding);
      const route = coarsenPath(req.baseUrl ? `${req.baseUrl}${req.path}` : req.path);
      addInbound(`${req.method} ${route}`, bytes);
      return origEnd(chunk, encoding, cb);
    };

    next();
  };
}

/* ---------------------------------------------------------------- *
 * outbound: bytes to/from every external host
 * ---------------------------------------------------------------- */

/** Patches global fetch — covers @supabase/supabase-js (REST, Storage, Auth) and the Wix calls. */
function installOutboundFetchMeter() {
  if (!ENABLED || typeof globalThis.fetch !== 'function' || globalThis.__bwFetchPatched) return;
  globalThis.__bwFetchPatched = true;

  const origFetch = globalThis.fetch;

  globalThis.fetch = async function meteredFetch(input, init) {
    const urlStr = typeof input === 'string' ? input : (input?.url || String(input));
    let host = 'unknown';
    try { host = new URL(urlStr).host; } catch { /* leave as unknown */ }

    let up = 0;
    const body = init?.body ?? (typeof input === 'object' ? input?.body : undefined);
    if (typeof body === 'string') up = Buffer.byteLength(body);
    else if (Buffer.isBuffer(body)) up = body.length;
    else if (body && typeof body.byteLength === 'number') up = body.byteLength;

    const res = await origFetch(input, init);

    // Measure without consuming the caller's body.
    let down = 0;
    try {
      down = (await res.clone().arrayBuffer()).byteLength;
    } catch {
      const declared = res.headers.get('content-length');
      down = declared ? Number(declared) : 0;
    }

    addOutbound(host, up, down);
    return res;
  };
}

/** Patches http(s).request — covers googleapis, nodemailer, razorpay, WhatsApp/Gupshup/Interakt. */
function installHttpMeter() {
  if (!ENABLED || globalThis.__bwHttpPatched) return;
  globalThis.__bwHttpPatched = true;

  for (const modName of ['http', 'https']) {
    const m = require(modName);
    const orig = m.request.bind(m);
    m.request = function meteredRequest(...args) {
      const req = orig(...args);
      let up = 0;
      let down = 0;

      const origWrite = req.write.bind(req);
      req.write = (chunk, enc, cb) => {
        if (chunk) up += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8');
        return origWrite(chunk, enc, cb);
      };
      const origEnd = req.end.bind(req);
      req.end = (chunk, enc, cb) => {
        if (chunk && typeof chunk !== 'function') {
          up += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8');
        }
        return origEnd(chunk, enc, cb);
      };

      req.on('response', (res) => {
        res.on('data', (d) => { down += d.length; });
        res.on('end', () => {
          const host = String(req.getHeader?.('host') || req.host || 'unknown');
          addOutbound(host, up, down);
        });
      });

      return req;
    };
  }
}

/* ---------------------------------------------------------------- *
 * aggregated report
 * ---------------------------------------------------------------- */

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

function buildReport() {
  const out = [...outbound.entries()]
    .map(([host, v]) => ({ host, ...v }))
    .sort((a, b) => (b.down + b.up) - (a.down + a.up));

  const inn = [...inbound.entries()]
    .map(([route, v]) => ({ route, ...v }))
    .sort((a, b) => b.bytes - a.bytes);

  const lines = [];
  lines.push('');
  lines.push('================ BANDWIDTH REPORT (cumulative since boot) ================');
  lines.push('');
  lines.push('OUTBOUND (service-initiated)');
  lines.push(`  ${pad('host', 34)}${padL('requests', 10)}${padL('downloaded', 14)}${padL('uploaded', 12)}`);
  if (!out.length) {
    lines.push('  (none)');
  } else {
    for (const r of out.slice(0, 20)) {
      lines.push(`  ${pad(r.host, 34)}${padL(r.requests, 10)}${padL(fmt(r.down), 14)}${padL(fmt(r.up), 12)}`);
    }
    const totalDown = out.reduce((a, r) => a + r.down, 0);
    const totalUp = out.reduce((a, r) => a + r.up, 0);
    const totalReq = out.reduce((a, r) => a + r.requests, 0);
    lines.push(`  ${pad('TOTAL', 34)}${padL(totalReq, 10)}${padL(fmt(totalDown), 14)}${padL(fmt(totalUp), 12)}`);
  }

  lines.push('');
  lines.push('INBOUND (responses sent to clients)');
  lines.push(`  ${pad('route', 44)}${padL('calls', 10)}${padL('response bytes', 16)}`);
  if (!inn.length) {
    lines.push('  (none)');
  } else {
    for (const r of inn.slice(0, 20)) {
      lines.push(`  ${pad(r.route.slice(0, 43), 44)}${padL(r.calls, 10)}${padL(fmt(r.bytes), 16)}`);
    }
    const totalBytes = inn.reduce((a, r) => a + r.bytes, 0);
    const totalCalls = inn.reduce((a, r) => a + r.calls, 0);
    lines.push(`  ${pad('TOTAL', 44)}${padL(totalCalls, 10)}${padL(fmt(totalBytes), 16)}`);
  }
  lines.push('');
  lines.push('=========================================================================');
  return lines.join('\n');
}

/** Print an aggregated report every `everyMs`. Totals are cumulative, not per-window. */
function startBandwidthRollup(everyMs = 5 * 60 * 1000) {
  if (!ENABLED) return () => {};
  console.log(`[bandwidth] audit enabled — aggregated report every ${Math.round(everyMs / 60000)} min`);
  const timer = setInterval(() => console.log(buildReport()), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Install everything. Safe and near-free to call when the audit is off. */
function install({ reportEveryMs = 5 * 60 * 1000 } = {}) {
  if (!ENABLED) return () => {};
  installOutboundFetchMeter();
  installHttpMeter();
  return startBandwidthRollup(reportEveryMs);
}

module.exports = {
  ENABLED,
  install,
  responseSizeMeter,
  installOutboundFetchMeter,
  installHttpMeter,
  startBandwidthRollup,
  buildReport,
  coarsenPath,
  _totals: () => ({ outbound, inbound }),
};
