/**
 * Fill display fields on `sessions` rows when DB joins/columns are empty but `wix_payload`
 * still carries Velo/Wix booking data (nested shapes vary).
 */

const { therapistNameFromBooking } = require('./wixBookingMapper');
const {
  isBareTherapistEnvelope,
  mergeBareTherapistIntoExisting,
  hasBookingPayloadSemantics,
} = require('./wixBookingPayloadHydration');

function parsePayload(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return typeof o === 'object' && o !== null ? o : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

/** @returns {string|null} ISO instant */
function pickWixStartInstant(p) {
  if (!p || typeof p !== 'object') return null;
  const candidates = [
    p.startTime,
    p.start,
    p.sessionInfo?.start,
    p.rawBookedEntity?.singleSession?.start,
    p.rawBookedEntity?.start,
    p.bookedSessionInfo?.start,
    p.bookedSessionInfo?.session?.start,
    p.slot?.startDate,
    p.rawBookedEntity?.slot?.startDate,
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function splitHumanName(name) {
  const s = String(name || '').trim();
  if (!s) return { first_name: null, last_name: null };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function pickWixClientFromPayload(p) {
  if (!p || typeof p !== 'object') return null;
  const c =
    p.client ||
    p.formInfo?.contactDetails ||
    p.contactDetails ||
    p.customerInfo ||
    p.rawFormInfo?.contactDetails ||
    null;
  if (!c || typeof c !== 'object') return null;
  const first = c.firstName ?? c.first_name ?? null;
  const last = c.lastName ?? c.last_name ?? null;
  const full =
    c.fullName ||
    [first, last].filter(Boolean).join(' ').trim() ||
    c.name ||
    null;
  const email = c.email ?? null;
  if (!first && !last && !full && !email) return null;
  const fn = first || (full ? splitHumanName(full).first_name : null);
  const ln = last || (full ? splitHumanName(full).last_name : null);
  return {
    first_name: fn || null,
    last_name: ln || null,
    email,
    _fromWixPayload: true,
  };
}

function pickWixPrice(p) {
  if (!p || typeof p !== 'object') return null;
  const finalPaid = p.paymentDetails?.balance?.finalPrice?.amount;
  if (finalPaid != null && finalPaid !== '') {
    const n = Number.parseFloat(String(finalPaid));
    if (Number.isFinite(n)) return n;
  }
  const plan =
    p.pricingPlanInfo?.priceDetails?.price ??
    p.pricingPlanInfo?.price?.value ??
    p.pricingPlanInfo?.totalPrice ??
    null;
  if (plan != null && plan !== '') {
    const n = Number.parseFloat(String(plan));
    if (Number.isFinite(n)) return n;
  }
  const rate = p.rawBookedEntity?.rate?.defaultVariedPrice?.amount;
  if (rate != null && rate !== '') {
    const n = Number.parseFloat(String(rate));
    if (Number.isFinite(n)) return n;
  }
  if (p.price != null && p.price !== '') {
    const n = Number.parseFloat(String(p.price));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickWixOrderLabel(p) {
  if (!p || typeof p !== 'object') return null;
  const n =
    p.orderNumber ??
    p.orderId ??
    p.invoiceNumber ??
    p.rawBookedEntity?.orderId ??
    null;
  if (n == null || n === '') return null;
  return String(n);
}

/**
 * Velo often saves only `{ id, name, image }` on `sessions.wix_payload`. Merge the full
 * booking from `wix_bookings.payload` when available so list APIs can show schedule/client/price.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object[]} sessions
 */
async function hydrateSessionsWixPayloadFromMirror(supabaseAdmin, sessions) {
  if (!supabaseAdmin || !sessions?.length) return;

  const needKeys = [];
  const keyToSessions = new Map();

  for (const s of sessions) {
    const p = parsePayload(s.wix_payload);
    if (!p || !isBareTherapistEnvelope(p)) continue;
    const key =
      p.id != null && String(p.id).trim() !== ''
        ? String(p.id).trim()
        : s.wix_booking_id != null
          ? String(s.wix_booking_id).trim()
          : null;
    if (!key) continue;
    if (!keyToSessions.has(key)) {
      keyToSessions.set(key, []);
      needKeys.push(key);
    }
    keyToSessions.get(key).push(s);
  }

  if (!needKeys.length) return;

  const existingByKey = new Map();
  const chunkSize = 150;
  for (let i = 0; i < needKeys.length; i += chunkSize) {
    const chunk = needKeys.slice(i, i + chunkSize);
    const { data: rows, error } = await supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id, payload')
      .in('wix_booking_id', chunk);

    if (error) {
      console.warn('[hydrateSessionsWixPayloadFromMirror] wix_bookings lookup failed:', error.message || error);
      continue;
    }
    for (const r of rows || []) {
      const k = r?.wix_booking_id;
      const pl = r?.payload;
      if (k != null && pl && typeof pl === 'object' && hasBookingPayloadSemantics(pl)) {
        existingByKey.set(String(k), pl);
      }
    }
  }

  let merged = 0;
  for (const key of needKeys) {
    const full = existingByKey.get(key);
    if (!full) continue;
    for (const s of keyToSessions.get(key) || []) {
      const bare = parsePayload(s.wix_payload);
      s.wix_payload = mergeBareTherapistIntoExisting(full, bare);
      merged += 1;
    }
  }
  if (merged > 0) {
    console.log(`[hydrateSessionsWixPayloadFromMirror] merged ${merged} session row(s) from wix_bookings.payload`);
  }
}

/**
 * Mutates `session` in place: fills scheduled_date/time, client, psychologist, price,
 * wix_order_number from `wix_payload` when missing.
 */
function enrichSessionRowDisplayFields(session) {
  if (!session || typeof session !== 'object') return;

  const src = String(session.source || '').toLowerCase();
  const p = parsePayload(session.wix_payload);
  if (!p) return;
  if (src !== 'wix' && !session.wix_booking_id) return;

  const startIso = pickWixStartInstant(p);
  if (startIso) {
    const d = new Date(startIso);
    if (!Number.isNaN(d.getTime())) {
      if (!session.scheduled_date) {
        try {
          session.scheduled_date = new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          })
            .format(d)
            .slice(0, 10);
        } catch {
          session.scheduled_date = startIso.slice(0, 10);
        }
      }
      if (!session.scheduled_time) {
        try {
          const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }).formatToParts(d);
          const h = parts.find((x) => x.type === 'hour')?.value || '00';
          const m = parts.find((x) => x.type === 'minute')?.value || '00';
          const sec = parts.find((x) => x.type === 'second')?.value || '00';
          session.scheduled_time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${sec.padStart(2, '0')}`;
        } catch {
          session.scheduled_time = startIso.slice(11, 19);
        }
      }
    }
  }

  const priceFromWix = pickWixPrice(p);
  if ((session.price == null || session.price === '' || Number(session.price) === 0) && priceFromWix != null) {
    session.price = priceFromWix;
  }

  const orderLabel = pickWixOrderLabel(p);
  if (!session.wix_order_number && orderLabel) {
    session.wix_order_number = orderLabel;
  }

  const existingClient = session.client;
  const hasClientNames =
    existingClient &&
    (`${existingClient.first_name || ''} ${existingClient.last_name || ''}`.trim() !== '' ||
      (existingClient.child_name && String(existingClient.child_name).trim() !== ''));

  if (!hasClientNames) {
    const fromWix = pickWixClientFromPayload(p);
    if (fromWix) {
      session.client = {
        ...existingClient,
        id: existingClient?.id ?? null,
        user_id: existingClient?.user_id ?? null,
        first_name: existingClient?.first_name || fromWix.first_name,
        last_name: existingClient?.last_name || fromWix.last_name,
        child_name: existingClient?.child_name ?? null,
        phone_number: existingClient?.phone_number ?? null,
        user: existingClient?.user || (fromWix.email ? { email: fromWix.email } : undefined),
      };
    }
  }

  const existingPsych = session.psychologist;
  const hasPsychName =
    existingPsych &&
    `${existingPsych.first_name || ''} ${existingPsych.last_name || ''}`.trim() !== '';

  if (!hasPsychName) {
    let tName = therapistNameFromBooking(p);
    if (!tName && p && typeof p === 'object') {
      tName =
        p.staffMember?.name ||
        p.staff?.name ||
        p.provider?.name ||
        p.resource?.name ||
        (typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null) ||
        null;
    }
    if (tName && String(tName).trim()) {
      const { first_name, last_name } = splitHumanName(tName);
      session.psychologist = {
        ...existingPsych,
        id: existingPsych?.id ?? null,
        first_name: existingPsych?.first_name || first_name,
        last_name: existingPsych?.last_name || last_name,
        email: existingPsych?.email ?? null,
      };
    }
  }
}

module.exports = {
  enrichSessionRowDisplayFields,
  hydrateSessionsWixPayloadFromMirror,
  parsePayload,
  pickWixStartInstant,
};
