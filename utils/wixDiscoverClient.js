/**
 * Calls the published Wix Velo HTTP function `/_functions/discover`
 * (see koott WIX_DASHBOARD_NOTES.md). Credentials stay server-side only.
 */

function getWixDiscoverConfig() {
  const siteUrl = (process.env.WIX_SITE_URL || '').replace(/\/$/, '');
  const apiKey =
    process.env.WIX_DISCOVER_API_KEY ||
    process.env.DASHBOARD_API_KEY ||
    process.env.WIX_DASHBOARD_API_KEY ||
    '';
  return { siteUrl, apiKey };
}

/**
 * @param {string} siteUrl
 * @param {{ limit?: number|string }} [query]
 */
function discoverEndpoint(siteUrl, query = {}) {
  const url = new URL('/_functions/discover', `${siteUrl}/`);
  const lim = query.limit ?? process.env.WIX_DISCOVER_BOOKING_LIMIT;
  if (lim != null && String(lim).trim() !== '') {
    const n = parseInt(String(lim), 10);
    if (Number.isFinite(n) && n > 0) {
      url.searchParams.set('limit', String(n));
    }
  }
  return url.toString();
}

/**
 * @param {{ limit?: number|string }} [options] — forwarded as `?limit=` if Velo supports it (see koott/wix-velo/http-functions.js)
 * @returns {Promise<{ ok: boolean, status: number, endpoint: string, json: object }>}
 */
async function fetchWixDiscover(options = {}) {
  const { siteUrl, apiKey } = getWixDiscoverConfig();
  if (!siteUrl || !apiKey) {
    const err = new Error(
      'Missing Wix discover config. Set WIX_SITE_URL and WIX_DISCOVER_API_KEY (or DASHBOARD_API_KEY) on the backend.'
    );
    err.code = 'WIX_CONFIG_MISSING';
    throw err;
  }

  const endpoint = discoverEndpoint(siteUrl, { limit: options.limit });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 55_000);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { 'x-dashboard-key': apiKey },
      signal: controller.signal,
    });

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {
        _nonJsonBody: true,
        preview: text.slice(0, 800),
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      endpoint,
      json,
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Best-effort: discover payload shape depends on your Velo `discover` implementation.
 * Handles common patterns (koott probe + raw Wix-style nesting).
 */
function extractBookingsList(discoverJson) {
  const sections = discoverJson?.sections;
  const bookingsSection = sections?.bookings;
  const tried = [];

  const tryPush = (label, arr) => {
    tried.push({ label, length: Array.isArray(arr) ? arr.length : null });
    return Array.isArray(arr) && arr.length ? arr : null;
  };

  let list =
    tryPush('sections.bookings.sample', bookingsSection?.sample) ||
    tryPush('sections.bookings.items', bookingsSection?.items) ||
    tryPush('sections.bookings.data', bookingsSection?.data);

  const raw = bookingsSection?.raw;
  if (!list && raw && typeof raw === 'object') {
    list =
      tryPush('sections.bookings.raw.bookings', raw.bookings) ||
      tryPush('sections.bookings.raw.items', raw.items) ||
      tryPush('sections.bookings.raw.data.bookings', raw.data?.bookings) ||
      tryPush('sections.bookings.raw.data', raw.data);
  }

  if (!list && discoverJson?.bookings && Array.isArray(discoverJson.bookings)) {
    list = discoverJson.bookings;
    tried.push({ label: 'root.bookings', length: list.length });
  }

  if (!list && raw && typeof raw === 'object') {
    const scored = collectScoredObjectArrays(raw, '', 0, 5);
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top?.array?.length) {
      list = top.array;
      tried.push({ label: `scored:${top.path}`, length: list.length, score: top.score });
    }
  }

  if (!list) {
    const deep = findLargestObjectArray(discoverJson, 0, 4);
    if (deep?.array?.length) {
      list = deep.array;
      tried.push({ label: `deep:${deep.path}`, length: list.length });
    }
  }

  return { bookings: list || [], extractionTried: tried };
}

function bookingLikenessScore(arr) {
  if (!Array.isArray(arr) || !arr.length || typeof arr[0] !== 'object' || arr[0] === null) {
    return 0;
  }
  const keys = Object.keys(arr[0]).map((k) => k.toLowerCase());
  const blob = JSON.stringify(arr[0]).toLowerCase();
  let s = arr.length;
  for (const k of keys) {
    if (k.includes('book')) s += 40;
    if (k.includes('slot') || k.includes('session')) s += 15;
    if (k.includes('staff') || k.includes('service')) s += 10;
    if (k.includes('contact') || k.includes('form')) s += 10;
  }
  if (blob.includes('contactdetails') || blob.includes('forminfo')) s += 35;
  if (blob.includes('confirmed') || blob.includes('booking')) s += 20;
  return s;
}

function collectScoredObjectArrays(value, path, depth, maxDepth, out = []) {
  if (depth > maxDepth || value == null) return out;
  if (Array.isArray(value)) {
    const score = bookingLikenessScore(value);
    if (score > 0) out.push({ path: path || '[]', array: value, score });
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    collectScoredObjectArrays(v, p, depth + 1, maxDepth, out);
  }
  return out;
}

function findLargestObjectArray(value, depth, maxDepth) {
  if (depth > maxDepth || value == null) return null;
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === 'object' && value[0] !== null) {
      return { path: '[]', array: value, depth };
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  let best = null;
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
      const score = bookingLikenessScore(v);
      const cur = { path: k, array: v, depth, score };
      if (!best || score > best.score || (score === best.score && v.length > best.array.length)) {
        best = cur;
      }
    }
    const nested = findLargestObjectArray(v, depth + 1, maxDepth);
    if (nested && nested.array?.length) {
      const path = `${k}.${nested.path}`;
      const nestedScore = bookingLikenessScore(nested.array);
      const cur = { path, array: nested.array, depth: nested.depth, score: nestedScore };
      if (!best || cur.score > best.score || (cur.score === best.score && cur.array.length > best.array.length)) {
        best = cur;
      }
    }
  }
  return best;
}

function typeTag(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `array[${typeTag(v[0])}]` : 'array[]';
  return typeof v;
}

/**
 * Merged dot-path catalog across all booking objects (union of keys).
 */
function buildFieldCatalog(bookings, maxPaths = 400) {
  const paths = new Map();

  function walk(obj, prefix, depth) {
    if (depth > 14 || paths.size >= maxPaths) return;
    if (obj === null || obj === undefined) {
      const p = prefix || '(root)';
      if (!paths.has(p)) paths.set(p, { types: new Set(['nullish']), examples: [] });
      paths.get(p).types.add('nullish');
      return;
    }
    if (Array.isArray(obj)) {
      const p = prefix || '(root)';
      const entry = paths.get(p) || { types: new Set(), examples: [] };
      entry.types.add(`array(len=${obj.length})`);
      if (obj.length && typeof obj[0] === 'object' && obj[0] !== null) {
        walk(obj[0], `${prefix}[]`, depth + 1);
      } else if (obj.length) {
        if (entry.examples.length < 2) entry.examples.push(obj[0]);
      }
      paths.set(p, entry);
      return;
    }
    if (typeof obj !== 'object') {
      const p = prefix || '(root)';
      const entry = paths.get(p) || { types: new Set(), examples: [] };
      entry.types.add(typeof obj);
      if (entry.examples.length < 2) entry.examples.push(obj);
      paths.set(p, entry);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      walk(v, p, depth + 1);
    }
  }

  for (const b of bookings) {
    if (b && typeof b === 'object') walk(b, '', 0);
  }

  return [...paths.entries()]
    .map(([path, { types, examples }]) => ({
      path,
      types: [...types].join(' | '),
      examplePreview: summarizeValue(examples[0]),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function summarizeValue(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') {
    const s = v.length > 120 ? `${v.slice(0, 117)}...` : v;
    return JSON.stringify(s);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const j = JSON.stringify(v);
    return j.length > 160 ? `${j.slice(0, 157)}...` : j;
  } catch {
    return String(v);
  }
}

/** High-signal paths often present on Wix Bookings payloads (best-effort). */
function summarizeBookingHuman(booking) {
  if (!booking || typeof booking !== 'object') return {};
  const pick = (obj, pathList) => {
    for (const path of pathList) {
      const v = path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  const therapistName =
    pick(booking, [
      'therapist.name',
      'therapist.displayName',
      'therapist.fullName',
      'staffMember.name',
      'staff.name',
      'provider.name',
    ]) ||
    (typeof booking.therapist === 'string' ? booking.therapist : undefined);

  const clientFirst = pick(booking, [
    'client.firstName',
    'formInfo.contactDetails.firstName',
    'contactDetails.firstName',
  ]);
  const clientLast = pick(booking, ['client.lastName', 'formInfo.contactDetails.lastName', 'contactDetails.lastName']);
  const clientFull =
    pick(booking, ['client.fullName', 'formInfo.contactDetails.fullName']) ||
    [clientFirst, clientLast].filter(Boolean).join(' ').trim() ||
    undefined;

  return {
    ids: {
      bookingId: pick(booking, ['id', '_id', 'bookingId']),
      sessionId: pick(booking, ['sessionId', 'rawBookedEntity.singleSession.sessionId']),
      scheduleId: pick(booking, ['scheduleId', 'rawBookedEntity.scheduleId']),
      revision: pick(booking, ['revision']),
    },
    createdDate: pick(booking, ['createdDate', '_createdDate', 'createdAt']),
    schedule: {
      start: pick(booking, [
        'startTime',
        'start',
        'startDate',
        'slot.startDate',
        'sessionInfo.start',
        'rawBookedEntity.singleSession.start',
      ]),
      end: pick(booking, [
        'endTime',
        'end',
        'endDate',
        'slot.endDate',
        'sessionInfo.end',
        'rawBookedEntity.singleSession.end',
      ]),
      timezone: pick(booking, ['timezone', 'slot.timezone']),
    },
    /** Service / offering label from Velo-normalized booking (often same as therapist title on Wix) */
    title: pick(booking, ['title', 'rawBookedEntity.title']),
    tags: pick(booking, ['tags']),
    sessionType: pick(booking, [
      'sessionType',
      'session.type',
      'service.name',
      'bookedEntity.tag',
    ]),
    status: pick(booking, ['status', 'bookingStatus', 'paymentStatus']),
    client: {
      name: clientFull || clientFirst,
      firstName: clientFirst,
      lastName: clientLast,
      email: pick(booking, [
        'client.email',
        'formInfo.contactDetails.email',
        'contactDetails.email',
        'customerInfo.email',
      ]),
      phone: pick(booking, [
        'client.phone',
        'formInfo.contactDetails.phone',
        'contactDetails.phone',
        'customerInfo.phone',
      ]),
      contactId: pick(booking, [
        'client.contactId',
        'formInfo.contactDetails.contactId',
        'contactId',
        'client.id',
      ]),
    },
    staff: {
      name: therapistName,
      id: pick(booking, ['therapist.id', 'therapistId', 'staffMember.id', 'staff.id', 'provider.id']),
    },
    service: {
      name: pick(booking, ['service.name', 'bookedEntity.name', 'rawBookedEntity.title']),
      id: pick(booking, ['serviceId', 'service.id', 'rawBookedEntity.serviceId', 'bookedEntity.id']),
    },
    price: (() => {
      if (booking.price != null || booking.currency) {
        return { amount: booking.price, currency: booking.currency };
      }
      const r = booking.rawBookedEntity?.rate?.defaultVariedPrice;
      if (r && (r.amount != null || r.currency)) {
        return { amount: r.amount, currency: r.currency };
      }
      return undefined;
    })(),
    location: pick(booking, ['location', 'rawBookedEntity.location.locationType']),
  };
}

function summarizeSections(discoverJson) {
  const sections = discoverJson?.sections;
  if (!sections || typeof sections !== 'object') return {};
  return Object.fromEntries(
    Object.entries(sections).map(([key, sec]) => [
      key,
      sec?.ok === false
        ? { ok: false, error: sec?.error || sec?.message || 'error' }
        : {
            ok: sec?.ok !== false,
            count: sec?.count,
            sampleLen: Array.isArray(sec?.sample) ? sec.sample.length : undefined,
          },
    ])
  );
}

module.exports = {
  getWixDiscoverConfig,
  discoverEndpoint,
  fetchWixDiscover,
  extractBookingsList,
  buildFieldCatalog,
  summarizeBookingHuman,
  summarizeSections,
};
