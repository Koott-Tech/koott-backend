const { supabaseAdmin } = require('../config/supabase');
const { getBookingTimeColumnKey } = require('../utils/sessionsBookingTimeColumn');
const meetLinkService = require('../utils/meetLinkService');
const googleCalendarService = require('../utils/googleCalendarService');
const { fetchWixDiscover, extractBookingsList } = require('../utils/wixDiscoverClient');
const { discoverRowToDb, discoverRowToSessionDb, wixBookingCreatedIso } = require('../utils/wixBookingMapper');
const { resolveClientsForBookings } = require('../services/wixClientResolverService');
const { linkPackageSessions: linkWixBookingsPackages } = require('../services/wixPackageLinkingService');
const { resolvePsychologistsForBookings } = require('../services/wixPsychologistResolverService');
const { processNewWixSessions, processOneSession } = require('../services/wixMeetNotifyService');
const { linkPackageSessions } = require('../services/wixPackageLinkerService');
const { fetchSessionInfoBatch } = require('../services/wixOrderEnrichmentService');
const { hydrateBareTherapistBookings } = require('../utils/wixBookingPayloadHydration');

const DEFAULT_WIX_SYNC_LIMIT = Number.parseInt(
  process.env.WIX_DISCOVER_BOOKING_LIMIT || '100',
  10
) || 100;

async function sessionRowsForSchema(sessionRows) {
  const btc = await getBookingTimeColumnKey(supabaseAdmin);
  if (btc === 'booking_created_at') return sessionRows;
  return sessionRows.map(({ booking_created_at: _omit, ...r }) => r);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function parseSyncCreatedAfter(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  const d = dateOnly ? new Date(`${dateOnly[1]}T00:00:00.000+05:30`) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getSyncCreatedAfter(options = {}) {
  return (
    parseSyncCreatedAfter(options.createdAfter) ||
    parseSyncCreatedAfter(process.env.WIX_SYNC_CREATED_AFTER) ||
    parseSyncCreatedAfter(process.env.WIX_SYNC_OLDEST_DATE)
  );
}

function filterBookingsCreatedAfter(bookings, createdAfterIso) {
  const list = Array.isArray(bookings) ? bookings : [];
  if (!createdAfterIso) {
    return { bookings: list, skippedOlder: 0, skippedMissingCreatedAt: 0 };
  }

  const floorMs = new Date(createdAfterIso).getTime();
  if (!Number.isFinite(floorMs)) {
    return { bookings: list, skippedOlder: 0, skippedMissingCreatedAt: 0 };
  }

  let skippedOlder = 0;
  let skippedMissingCreatedAt = 0;
  const filtered = list.filter((b) => {
    const createdIso = wixBookingCreatedIso(b);
    if (!createdIso) {
      skippedMissingCreatedAt += 1;
      return false;
    }
    const createdMs = new Date(createdIso).getTime();
    if (!Number.isFinite(createdMs) || createdMs < floorMs) {
      skippedOlder += 1;
      return false;
    }
    return true;
  });

  return { bookings: filtered, skippedOlder, skippedMissingCreatedAt };
}

function syncFilterMeta(createdAfterIso, stats) {
  if (!createdAfterIso) return {};
  return {
    createdAfter: createdAfterIso,
    skippedOlder: stats?.skippedOlder || 0,
    skippedMissingCreatedAt: stats?.skippedMissingCreatedAt || 0,
  };
}

function istDateFromIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Used to classify psychologist rows that never show up as a therapist on mirrored Wix rows. */
function bookingDisplayNameProbablySamePsychologist(bookingDisplayNameRaw, psychologist) {
  const raw = String(bookingDisplayNameRaw || '')
    .toLowerCase()
    .replace(/^dr\.?\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return false;
  const fn = String(psychologist.first_name || '')
    .trim()
    .toLowerCase();
  const ln = String(psychologist.last_name || '')
    .trim()
    .toLowerCase();
  const tokens = [fn, ln].filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => (t.length <= 2 ? raw.includes(t) : raw.includes(t)));
}

/**
 * Fetch wix_booking_ids that must be excluded from Wix sync upserts.
 * Two categories:
 *  1. locally_modified=true  → admin edited fields (therapist, price, notes, etc.)
 *  2. Terminal statuses       → completed/no_show/cancelled/refunded/deleted
 *     (status-only changes don't set locally_modified so they don't appear as "Edited locally")
 */
async function getLocallyModifiedWixIds() {
  const TERMINAL = ['completed', 'no_show', 'cancelled', 'refunded', 'deleted'];
  try {
    const [
      { data: wixEdited },
      { data: wixTerminal },
      { data: sessEdited },
      { data: sessTerminal },
    ] = await Promise.all([
      supabaseAdmin.from('wix_bookings').select('wix_booking_id').eq('locally_modified', true),
      supabaseAdmin.from('wix_bookings').select('wix_booking_id').in('status', TERMINAL),
      supabaseAdmin.from('sessions').select('wix_booking_id').eq('locally_modified', true).not('wix_booking_id', 'is', null),
      supabaseAdmin.from('sessions').select('wix_booking_id').in('status', TERMINAL).not('wix_booking_id', 'is', null),
    ]);

    const ids = new Set();
    for (const r of [...(wixEdited || []), ...(wixTerminal || []), ...(sessEdited || []), ...(sessTerminal || [])]) {
      if (r.wix_booking_id) ids.add(r.wix_booking_id);
    }
    return ids;
  } catch (err) {
    console.warn('[getLocallyModifiedWixIds] error:', err.message || err);
    return new Set();
  }
}

/**
 * Upsert an already-enriched booking object (from Velo webhook) directly.
 * Skips discover re-fetch and avoids the Wix index eventual-consistency gap.
 */
async function upsertEnrichedBookings(rawBookings, options = {}) {
  const shouldSync = String(process.env.WIX_SYNC_AUTOSTART || 'true').toLowerCase() !== 'false';
  if (!shouldSync) {
    console.log('[upsertEnrichedBookings] skipped: WIX_SYNC_AUTOSTART is false');
    return { upserted: 0, sessionsUpserted: 0, sessionMirrorSkipped: false };
  }

  const list = Array.isArray(rawBookings) ? rawBookings : rawBookings ? [rawBookings] : [];
  const createdAfter = options.skipCreatedAfterFilter ? null : getSyncCreatedAfter(options);
  const filterStats = filterBookingsCreatedAfter(list, createdAfter);
  const listToSync = filterStats.bookings;

  if (!listToSync.length && list.length > 0) {
    console.log(
      `[upsertEnrichedBookings] skipped all ${list.length} booking(s) before createdAfter=${createdAfter}`
    );
    return {
      upserted: 0,
      sessionsUpserted: 0,
      sessionMirrorSkipped: false,
      ...syncFilterMeta(createdAfter, filterStats),
    };
  }

  // Drop unpaid bookings at the raw level — Wix UNDEFINED status = payment not completed
  const paidBookings = listToSync.filter(b => {
    const s = String(b?.status || '').trim().toUpperCase();
    return s !== 'UNDEFINED' && s !== '';
  });

  const deduped = dedupeBookings(paidBookings);
  const dedupedHydrated = await hydrateBareTherapistBookings(supabaseAdmin, deduped);

  let rows = dedupedHydrated
    .map(discoverRowToDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
  const sessionRows = dedupedHydrated
    .map(discoverRowToSessionDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));

  if (!rows.length) {
    return { upserted: 0, sessionsUpserted: 0, sessionMirrorSkipped: false };
  }

  rows = await applyMaxPriceGuard(rows);

  // Sync protection: selectively sync locally-modified bookings so admin edits are preserved
  const locallyModifiedIds = await getLocallyModifiedWixIds();
  // Drop pending (unpaid) bookings — Wix UNDEFINED status means payment not completed
  rows = rows.filter((r) => r.status !== 'pending');
  if (!rows.length) {
    return { upserted: 0, sessionsUpserted: 0, sessionMirrorSkipped: false };
  }

  // Preserve admin-edited fields for locally-modified/terminal bookings
  const existingIds = rows.map(r => r.wix_booking_id).filter(Boolean);
  if (existingIds.length) {
    const { data: existing } = await supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id, wix_session_id, therapist_name, price, currency, location, title, session_type, session_count, package_session_number, package_group_id, tags, client_first_name, client_last_name, client_full_name, client_email, client_phone, locally_modified, status')
      .in('wix_booking_id', existingIds);
    if (existing?.length) {
      const existingMap = new Map(existing.map(e => [e.wix_booking_id, e]));
      rows = rows.map(r => {
        const prev = existingMap.get(r.wix_booking_id);
        if (!prev) return r;
        
        const isLocallyModifiedOrTerminal = locallyModifiedIds.has(r.wix_booking_id);
        if (isLocallyModifiedOrTerminal) {
          // Keep admin-edited columns, but allow status and time updates.
          const merged = {
            ...r,
            therapist_name: prev.therapist_name,
            price: prev.price,
            currency: prev.currency,
            location: prev.location,
            title: prev.title,
            session_type: prev.session_type,
            session_count: prev.session_count,
            package_session_number: prev.package_session_number,
            package_group_id: prev.package_group_id,
            tags: prev.tags,
            client_first_name: prev.client_first_name,
            client_last_name: prev.client_last_name,
            client_full_name: prev.client_full_name,
            client_email: prev.client_email,
            client_phone: prev.client_phone,
            locally_modified: prev.locally_modified || ['completed', 'no_show', 'cancelled', 'refunded', 'deleted'].includes(prev.status),
          };
          if (prev.wix_session_id && !r.wix_session_id) {
            merged.wix_session_id = prev.wix_session_id;
          }
          return merged;
        } else {
          // Not locally modified - just preserve wix_session_id
          if (prev.wix_session_id && !r.wix_session_id) {
            return { ...r, wix_session_id: prev.wix_session_id };
          }
          return r;
        }
      });
    }
  }

  const { data, error } = await supabaseAdmin
    .from('wix_bookings')
    .upsert(rows, { onConflict: 'wix_booking_id' })
    .select('wix_booking_id');

  if (error) {
    const err = new Error(error.message || 'Supabase upsert failed');
    err.code = error.code;
    throw err;
  }

  let sessionsUpserted = 0;
  let sessionMirrorSkipped = false;
  if (sessionRows.length) {
    // Skip pending sessions (Wix UNDEFINED = payment not completed) — don't save to sessions table
    let filteredSessionRows = sessionRows.filter(r => r.status !== 'pending');

    if (filteredSessionRows.length > 0) {
      const upsertSessions = await sessionRowsForSchema(filteredSessionRows);

      // Prevent PostgREST upsert from resetting existing fields (google_meet_link, client_id, psychologist_id, etc.) back to default/null
      const wixBookingIds = upsertSessions.map(r => r.wix_booking_id).filter(Boolean);
      if (wixBookingIds.length > 0) {
        const { data: existing } = await supabaseAdmin
          .from('sessions')
          .select('wix_booking_id, client_id, psychologist_id, google_meet_link, google_meet_join_url, google_meet_start_url, google_calendar_event_id, notified_at, status, session_type, session_count, price, booking_created_at, scheduled_date, scheduled_time')
          .in('wix_booking_id', wixBookingIds);
        if (existing?.length) {
          const existingMap = new Map(existing.map(e => [e.wix_booking_id, e]));
          upsertSessions.forEach(row => {
            const prev = existingMap.get(row.wix_booking_id);
            if (prev) {
              const isCancelledNow = (row.status === 'cancelled' || row.status === 'deleted') && 
                                     (prev.status !== 'cancelled' && prev.status !== 'deleted');
              const isRescheduledNow = (row.scheduled_date && row.scheduled_time) &&
                                       (row.scheduled_date !== prev.scheduled_date || row.scheduled_time !== prev.scheduled_time);

              if (isCancelledNow || isRescheduledNow) {
                const oldEventId = prev.google_calendar_event_id;
                if (oldEventId) {
                  deleteSessionCalendarEventHelper(prev.psychologist_id, oldEventId).catch(err => {
                    console.warn(`[upsertEnrichedBookings] failed to delete calendar event for booking ${row.wix_booking_id}:`, err);
                  });
                }
              }

              if (isRescheduledNow) {
                // Clear calendar/meet links and reset notified_at to null so new links are created
                row.google_calendar_event_id = null;
                row.google_meet_link = null;
                row.google_meet_join_url = null;
                row.google_meet_start_url = null;
                row.google_calendar_link = null;
                row.notified_at = null;
              } else {
                // Preserve existing fields as usual
                Object.assign(row, preserveResolvedSessionShape(row, prev));
                if (prev.google_meet_link) row.google_meet_link = prev.google_meet_link;
                if (prev.google_meet_join_url) row.google_meet_join_url = prev.google_meet_join_url;
                if (prev.google_meet_start_url) row.google_meet_start_url = prev.google_meet_start_url;
                if (prev.google_calendar_event_id) row.google_calendar_event_id = prev.google_calendar_event_id;
                // Preserve notified_at — never let a sync upsert clear this after it's been stamped
                if (prev.notified_at) row.notified_at = prev.notified_at;
                // If admin soft-deleted this session (cancelled + notified_at set), lock status too
                // so Wix sync can't resurrect it back to 'booked'
                if (prev.notified_at && prev.status === 'cancelled') row.status = 'cancelled';
              }

              if (prev.client_id) row.client_id = prev.client_id;
              if (prev.psychologist_id) row.psychologist_id = prev.psychologist_id;

              // Price guard: keep whichever price is higher — Wix payloads sometimes omit the
              // actual charge (e.g. Razorpay paid outside Wix), causing sync to overwrite a
              // correct higher price with the catalog rate.
              const prevPrice = parseFloat(prev.price ?? 0);
              const newPrice  = parseFloat(row.price ?? 0);
              if (prevPrice > newPrice && prevPrice > 0) {
                row.price  = prev.price;
                row.amount = prev.price;
              }
              // Preserve booking_created_at — never let re-syncs overwrite the original booking
              // date with the current sync timestamp when the Wix payload lacks createdDate.
              if (prev.booking_created_at) row.booking_created_at = prev.booking_created_at;
            }
          });
        }
      }

      const { data: sessionData, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .upsert(upsertSessions, { onConflict: 'wix_booking_id' })
        .select('id,wix_booking_id');
      if (sessionError) {
        require('fs').appendFileSync('scratch/log.txt', `[${new Date().toISOString()}] Sessions upsert FAILED: ${sessionError.message}\n`);
        const msg = String(sessionError.message || '');
        const recoverable =
          msg.includes("Could not find the 'source' column") ||
          msg.includes("Could not find the 'wix_booking_id' column") ||
          msg.includes("Could not find the 'wix_payload' column") ||
          msg.includes("Could not find the 'booking_created_at' column") ||
          msg.includes('no unique or exclusion constraint matching the ON CONFLICT specification');
        if (recoverable) {
          sessionMirrorSkipped = true;
          console.warn('[upsertEnrichedBookings] sessions mirror skipped (run bridge migration)');
        } else {
          const err = new Error(sessionError.message || 'Sessions upsert failed');
          err.code = sessionError.code;
          throw err;
        }
      } else {
        sessionsUpserted = sessionData?.length ?? filteredSessionRows.length;
      }
    }
  }

  // Resolve/create user+client rows and link them to sessions
  let clientsResolved = 0;
  try {
    const m = await resolveClientsForBookings(dedupedHydrated);
    clientsResolved = m.size;
    var tempPasswordMap = m._wixIdToTempPassword;
  } catch (err) {
    console.warn('[upsertEnrichedBookings] client resolve non-blocking error:', err.message || err);
  }
  let psychologistsResolved = 0;
  try {
    const m = await resolvePsychologistsForBookings(dedupedHydrated);
    psychologistsResolved = m.size;
  } catch (err) {
    console.warn('[upsertEnrichedBookings] psychologist resolve non-blocking error:', err.message || err);
  }

  // Link ₹0 follow-up sessions under their parent package booking (wix_bookings table)
  try {
    const r = await linkWixBookingsPackages();
    if (r.childrenLinked > 0) {
      console.log(`[upsertEnrichedBookings] linked ${r.childrenLinked} package children across ${r.packagesProcessed} packages`);
    }
  } catch (err) {
    console.warn('[upsertEnrichedBookings] package linking non-blocking error:', err.message || err);
  }

  const wixBookingIds = dedupedHydrated.map((b) => b.id != null ? String(b.id) : null).filter(Boolean);

  // Enrich bookings with exact session type/count from Wix eCommerce Order API
  // (same data Zapier receives — e.g. "Individual 4-Session Pack")
  if (wixBookingIds.length) {
    enrichBookingsFromOrders(wixBookingIds).catch((err) => {
      console.warn('[upsertEnrichedBookings] order enrichment non-blocking error:', err.message || err);
    });
  }

  // Link zero-price promo sessions to their parent paid package session
  if (wixBookingIds.length) {
    linkPackageSessions(wixBookingIds).catch((err) => {
      console.warn('[upsertEnrichedBookings] package linker non-blocking error:', err.message || err);
    });
  }

  // Fire-and-forget: create Google Meet links + send WhatsApp for new Wix sessions
  if (wixBookingIds.length) {
    processNewWixSessions(wixBookingIds, tempPasswordMap).catch((err) => {
      console.warn('[upsertEnrichedBookings] meet+notify non-blocking error:', err.message || err);
    });
  }

  return {
    upserted: data?.length ?? rows.length,
    sessionsUpserted,
    clientsResolved,
    psychologistsResolved,
    sessionMirrorSkipped,
    ...syncFilterMeta(createdAfter, filterStats),
  };
}

/**
 * Post-upsert enrichment: call Wix eCommerce Orders API to get the exact
 * session type and count from order description lines (e.g. "Individual 4-Session Pack").
 * Updates both wix_bookings and sessions tables with the correct values.
 */
async function enrichBookingsFromOrders(wixBookingIds) {
  if (!wixBookingIds.length) return;

  const infoMap = await fetchSessionInfoBatch(wixBookingIds);
  if (!infoMap.size) return;

  let updated = 0;
  for (const [bookingId, info] of infoMap) {
    try {
      // Update wix_bookings with session type, count, and order ID
      const wbUpdate = {
        session_type: info.sessionType,
        session_count: info.sessionCount,
      };
      if (info.orderId) wbUpdate.wix_order_id = info.orderId;
      if (info.orderNumber) wbUpdate.wix_order_number = info.orderNumber;
      if (info.price && info.price > 0) {
        wbUpdate.price = info.price;
      }

      const { error: wbErr } = await supabaseAdmin
        .from('wix_bookings')
        .update(wbUpdate)
        .eq('wix_booking_id', bookingId);

      if (wbErr) {
        console.warn(`[enrichBookingsFromOrders] wix_bookings update failed for ${bookingId}:`, wbErr.message);
        continue;
      }

      // Update sessions table too
      const sessionUpdate = {
        session_type: info.sessionType,
        session_count: info.sessionCount,
      };
      if (info.price && info.price > 0) {
        sessionUpdate.price = info.price;
        sessionUpdate.amount = info.price;
      }

      const { error: sessErr } = await supabaseAdmin
        .from('sessions')
        .update(sessionUpdate)
        .eq('wix_booking_id', bookingId);

      if (sessErr && !sessErr.message?.includes('0 rows')) {
        console.warn(`[enrichBookingsFromOrders] sessions update failed for ${bookingId}:`, sessErr.message);
      }

      updated++;
      console.log(
        `[enrichBookingsFromOrders] ${bookingId} → ${info.sessionType} (${info.sessionCount} sessions) from "${info.descriptionLine}"`
      );
    } catch (err) {
      console.warn(`[enrichBookingsFromOrders] error for ${bookingId}:`, err.message || err);
    }
  }

  if (updated) {
    console.log(`[enrichBookingsFromOrders] enriched ${updated}/${wixBookingIds.length} bookings from eCommerce API`);
  }
}
function bookingDedupKey(b) {
  const schedule = b?.scheduleId || '';
  const session = b?.sessionId || '';
  const start = b?.startTime || '';
  const email = b?.client?.email || '';
  const contact = b?.contactId || b?.client?.contactId || '';
  const title = b?.title || '';
  // Use a stable natural key so Wix duplicate rows collapse to one canonical booking.
  return `${schedule}|${session}|${start}|${email}|${contact}|${title}`.toLowerCase();
}

function statusRank(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s || s === 'undefined' || s === 'null') return 0;
  if (s.includes('cancel')) return 1;
  if (s.includes('book') || s.includes('pending')) return 2;
  if (s.includes('confirm')) return 3;
  if (s.includes('complete')) return 4;
  return 2;
}

function bookingTimestamp(b) {
  const raw = b?.createdDate || b?.startTime;
  const t = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function dedupeBookings(bookings) {
  const byKey = new Map();
  for (const booking of bookings) {
    const key = bookingDedupKey(booking);
    if (!key.replace(/\|/g, '')) {
      byKey.set(`id:${booking?.id || Math.random()}`, booking);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, booking);
      continue;
    }
    const existingRank = statusRank(existing?.status);
    const currentRank = statusRank(booking?.status);
    const existingTs = bookingTimestamp(existing);
    const currentTs = bookingTimestamp(booking);
    if (currentRank > existingRank || (currentRank === existingRank && currentTs >= existingTs)) {
      byKey.set(key, booking);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Protect rows whose price/session_type was previously resolved correctly.
 * Wix payment API returns inconsistent data — sometimes `paymentDetails` is empty
 * for the same booking on subsequent fetches. This guard ensures we never
 * downgrade a price that was previously set higher (e.g. 8699 → 1999).
 */
async function applyMaxPriceGuard(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.wix_booking_id).filter(Boolean);
  const { data: existing } = await supabaseAdmin
    .from('wix_bookings')
    .select('wix_booking_id, price, session_type, session_count')
    .in('wix_booking_id', ids);

  if (!existing?.length) return rows;
  const existingMap = new Map(existing.map((e) => [e.wix_booking_id, e]));

  return rows.map((row) => {
    const prev = existingMap.get(row.wix_booking_id);
    if (!prev) return row;

    const newPrice  = parseFloat(row.price ?? 0);
    const prevPrice = parseFloat(prev.price ?? 0);

    // Keep whichever price is higher
    if (prevPrice > newPrice && prevPrice > 0) {
      row = { ...row, price: prev.price, currency: row.currency || prev.currency };
    }

    // Keep the better session_type: package > individual > null
    const typeRank = { package: 2, individual: 1 };
    const newRank  = typeRank[row.session_type]  ?? 0;
    const prevRank = typeRank[prev.session_type] ?? 0;
    if (prevRank > newRank) {
      row = { ...row, session_type: prev.session_type, session_count: prev.session_count ?? row.session_count };
    }

    return row;
  });
}

function preserveResolvedSessionShape(row, prev) {
  if (!prev) return row;

  const prevCount = Number(prev.session_count || 1);
  const nextCount = Number(row.session_count || 1);
  const prevType = String(prev.session_type || '').toLowerCase();
  const nextType = String(row.session_type || '').toLowerCase();

  const shouldKeepPrevType =
    (prevType === 'package' && nextType === 'individual') ||
    (prevType === 'couple' && nextType === 'individual') ||
    (prevType === 'assessment' && nextType === 'individual') ||
    (prevType === 'discovery' && nextType === 'individual');

  if (shouldKeepPrevType) {
    row = { ...row, session_type: prev.session_type };
  }

  if (prevCount > nextCount && prevCount > 1) {
    row = { ...row, session_count: prev.session_count };
  }

  return row;
}

async function performWixSync(options = {}) {
  const shouldSync = String(process.env.WIX_SYNC_AUTOSTART || 'true').toLowerCase() !== 'false';
  if (!shouldSync) {
    console.log('[performWixSync] skipped: WIX_SYNC_AUTOSTART is false');
    return { upserted: 0, sessionsUpserted: 0 };
  }

  const r = await fetchWixDiscover({
    limit: process.env.WIX_DISCOVER_BOOKING_LIMIT || DEFAULT_WIX_SYNC_LIMIT,
  });
  if (!r.ok) {
    const err = new Error(r.json?.error || r.json?.message || `Wix discover failed (HTTP ${r.status})`);
    err.httpStatus = r.status;
    throw err;
  }

  const { bookings, extractionTried } = extractBookingsList(r.json);

  const createdAfter = getSyncCreatedAfter(options);
  const filterStats = filterBookingsCreatedAfter(bookings, createdAfter);
  if (createdAfter) {
    console.log(
      `[performWixSync] filtering Wix bookings created >= ${createdAfter} (${istDateFromIso(createdAfter)} IST): ` +
        `${filterStats.bookings.length}/${bookings.length} kept`
    );
  }
  // Drop unpaid bookings at the raw level — Wix UNDEFINED status = payment not completed
  const filteredBookings = filterStats.bookings.filter(b => {
    const s = String(b?.status || '').trim().toUpperCase();
    return s !== 'UNDEFINED' && s !== '';
  });

  const dedupedBookings = dedupeBookings(filteredBookings);
  const dedupedHydratedBookings = await hydrateBareTherapistBookings(supabaseAdmin, dedupedBookings);
  if (!dedupedHydratedBookings.length) {
    return {
      upserted: 0,
      sessionsUpserted: 0,
      extractionTried,
      fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
      ...syncFilterMeta(createdAfter, filterStats),
    };
  }

  let rows = dedupedHydratedBookings
    .map(discoverRowToDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
  const sessionRows = dedupedHydratedBookings
    .map(discoverRowToSessionDb)
    .filter(Boolean)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)));
  if (!rows.length) {
    return {
      upserted: 0,
      sessionsUpserted: 0,
      extractionTried,
      fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
      ...syncFilterMeta(createdAfter, filterStats),
    };
  }

  // Never overwrite a previously-correct higher price with Wix's inconsistent lower value
  rows = await applyMaxPriceGuard(rows);

  // Sync protection: skip locally-modified bookings
  const locallyModifiedIds = await getLocallyModifiedWixIds();
  if (locallyModifiedIds.size) {
    const before = rows.length;
    rows = rows.filter((r) => !locallyModifiedIds.has(r.wix_booking_id));
    if (rows.length < before) {
      console.log(`[performWixSync] skipped ${before - rows.length} locally-modified booking(s)`);
    }
  }
  if (!rows.length) {
    return {
      upserted: 0,
      sessionsUpserted: 0,
      extractionTried,
      fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
      ...syncFilterMeta(createdAfter, filterStats),
    };
  }

  // Drop pending (unpaid) bookings — Wix UNDEFINED status means payment not completed
  rows = rows.filter((r) => r.status !== 'pending');

  // Preserve wix_session_id if already set — prevents sync from overwriting with null.
  const syncExistingIds = rows.map(r => r.wix_booking_id).filter(Boolean);
  if (syncExistingIds.length) {
    const { data: syncExisting } = await supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id, wix_session_id')
      .in('wix_booking_id', syncExistingIds);
    if (syncExisting?.length) {
      const syncExistingMap = new Map(syncExisting.map(e => [e.wix_booking_id, e]));
      rows = rows.map(r => {
        const prev = syncExistingMap.get(r.wix_booking_id);
        if (prev?.wix_session_id && !r.wix_session_id) {
          return { ...r, wix_session_id: prev.wix_session_id };
        }
        return r;
      });
    }
  }

  const { data, error } = await supabaseAdmin
    .from('wix_bookings')
    .upsert(rows, { onConflict: 'wix_booking_id' })
    .select('wix_booking_id');

  if (error) {
    const err = new Error(error.message || 'Supabase upsert failed');
    err.code = error.code;
    throw err;
  }

  let clientsResolved = 0;
  try {
    const wixIdToClientId = await resolveClientsForBookings(dedupedBookings);
    clientsResolved = wixIdToClientId.size;
    var tempPasswordMapSync = wixIdToClientId._wixIdToTempPassword;
  } catch (clientResolveError) {
    console.warn(
      '[performWixSync] client auto-provision skipped:',
      clientResolveError?.message || clientResolveError
    );
  }
  let psychologistsResolved = 0;
  try {
    const wixIdToPsychologistId = await resolvePsychologistsForBookings(dedupedBookings);
    psychologistsResolved = wixIdToPsychologistId.size;
  } catch (psychResolveError) {
    console.warn(
      '[performWixSync] psychologist auto-provision skipped:',
      psychResolveError?.message || psychResolveError
    );
  }

  let filteredSessionRows = sessionRows;
  if (locallyModifiedIds.size) {
    filteredSessionRows = sessionRows.filter(r => !locallyModifiedIds.has(r.wix_booking_id));
  }
  // Skip pending sessions (Wix UNDEFINED = payment not completed) — don't save to sessions table
  filteredSessionRows = filteredSessionRows.filter(r => r.status !== 'pending');

  let sessionData = null;
  let sessionError = null;

  if (filteredSessionRows.length > 0) {
    const upsertSessions = await sessionRowsForSchema(filteredSessionRows);

    // Prevent PostgREST upsert from resetting existing fields (google_meet_link, client_id, psychologist_id, etc.) back to default/null
    const wixBookingIds = upsertSessions.map(r => r.wix_booking_id).filter(Boolean);
    if (wixBookingIds.length > 0) {
      const { data: existing } = await supabaseAdmin
        .from('sessions')
        .select('wix_booking_id, client_id, psychologist_id, google_meet_link, google_meet_join_url, google_meet_start_url, google_calendar_event_id, notified_at, session_type, session_count, price, booking_created_at')
        .in('wix_booking_id', wixBookingIds);
      if (existing?.length) {
        const existingMap = new Map(existing.map(e => [e.wix_booking_id, e]));
        upsertSessions.forEach(row => {
          const prev = existingMap.get(row.wix_booking_id);
          if (prev) {
            Object.assign(row, preserveResolvedSessionShape(row, prev));
            if (prev.client_id) row.client_id = prev.client_id;
            if (prev.psychologist_id) row.psychologist_id = prev.psychologist_id;
            if (prev.google_meet_link) row.google_meet_link = prev.google_meet_link;
            if (prev.google_meet_join_url) row.google_meet_join_url = prev.google_meet_join_url;
            if (prev.google_meet_start_url) row.google_meet_start_url = prev.google_meet_start_url;
            if (prev.google_calendar_event_id) row.google_calendar_event_id = prev.google_calendar_event_id;
            // Preserve notified_at — never let a sync upsert clear this after it's been stamped
            if (prev.notified_at) row.notified_at = prev.notified_at;
            // Price guard: keep whichever price is higher
            const prevPrice = parseFloat(prev.price ?? 0);
            const newPrice  = parseFloat(row.price ?? 0);
            if (prevPrice > newPrice && prevPrice > 0) {
              row.price  = prev.price;
              row.amount = prev.price;
            }
            // Preserve booking_created_at — never overwrite with sync timestamp
            if (prev.booking_created_at) row.booking_created_at = prev.booking_created_at;
          }
        });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('sessions')
      .upsert(upsertSessions, { onConflict: 'wix_booking_id' })
      .select('id,wix_booking_id,status');
    sessionData = data;
    sessionError = error;
  }

  if (sessionError) {
    const msg = String(sessionError.message || '');
    const missingBridgeColumn =
      msg.includes("Could not find the 'source' column") ||
      msg.includes("Could not find the 'wix_booking_id' column") ||
      msg.includes("Could not find the 'wix_payload' column") ||
      msg.includes("Could not find the 'booking_created_at' column");
    const missingConflictConstraint =
      msg.includes('no unique or exclusion constraint matching the ON CONFLICT specification');

    if (missingBridgeColumn || missingConflictConstraint) {
      console.warn(
        '[performWixSync] sessions mirror skipped: run sessions wix bridge migration (missing columns or unique index on wix_booking_id)'
      );
      return {
        upserted: data?.length ?? rows.length,
        sessionsUpserted: 0,
        clientsResolved,
        psychologistsResolved,
        sessionMirrorSkipped: true,
        extractionTried,
        fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
        ...syncFilterMeta(createdAfter, filterStats),
      };
    }

    const err = new Error(sessionError.message || 'Sessions upsert failed');
    err.code = sessionError.code;
    throw err;
  }

  // Re-run both resolvers now that sessions rows exist — the first pass above ran before
  // the session upsert so those UPDATEs affected 0 rows. This second pass sets the IDs.
  try {
    await resolveClientsForBookings(dedupedBookings);
  } catch (err) {
    console.warn('[performWixSync] client resolve (post-upsert) non-blocking error:', err.message || err);
  }
  try {
    await resolvePsychologistsForBookings(dedupedBookings);
  } catch (err) {
    console.warn('[performWixSync] psychologist resolve (post-upsert) non-blocking error:', err.message || err);
  }

  // Link ₹0 follow-up sessions under their parent package booking (wix_bookings table)
  try {
    const r = await linkWixBookingsPackages();
    if (r.childrenLinked > 0) {
      console.log(`[performWixSync] linked ${r.childrenLinked} package children across ${r.packagesProcessed} packages`);
    }
  } catch (err) {
    console.warn('[performWixSync] package linking non-blocking error:', err.message || err);
  }

  const wixBookingIds = dedupedBookings.map((b) => b.id != null ? String(b.id) : null).filter(Boolean);

  // Enrich bookings with exact session type/count from Wix eCommerce Order API
  if (wixBookingIds.length) {
    enrichBookingsFromOrders(wixBookingIds).catch((err) => {
      console.warn('[performWixSync] order enrichment non-blocking error:', err.message || err);
    });
  }

  // Link zero-price promo sessions to their parent paid package session
  if (wixBookingIds.length) {
    const { linkPackageSessions } = require('../services/wixPackageLinkerService');
    linkPackageSessions(wixBookingIds).catch((err) => {
      console.warn('[performWixSync] package linker non-blocking error:', err.message || err);
    });
  }

  // Fire-and-forget: create Google Meet links + send notifications for new Wix sessions.
  // Runs after both resolvers so client_id and psychologist_id are guaranteed set.
  if (wixBookingIds.length) {
    processNewWixSessions(wixBookingIds, tempPasswordMapSync).catch((err) => {
      console.warn('[performWixSync] meet+notify non-blocking error:', err.message || err);
    });
  }

  return {
    upserted: data?.length ?? rows.length,
    sessionsUpserted: sessionData?.length ?? sessionRows.length,
    clientsResolved,
    psychologistsResolved,
    sessionMirrorSkipped: false,
    extractionTried,
    fetchedAt: r.json?.fetchedAt || new Date().toISOString(),
    ...syncFilterMeta(createdAfter, filterStats),
  };
}

/**
 * POST /admin/wix/sync
 * Fetch live discover payload and upsert all booking rows into `wix_bookings`.
 */
async function syncWixBookings(req, res) {
  try {
    // Manual sync (admin button): always pass null so ALL bookings are fetched, not just future ones.
    // The old default of new Date().toISOString() caused 0 synced every time because every booking
    // was created before "right now". The createdAfter filter is only appropriate for automated
    // interval syncs; for manual sync we want a full re-fetch.
    const requestedCreatedAfter =
      req.body?.createdAfter ||
      req.query?.createdAfter ||
      null;
    const result = await performWixSync({ createdAfter: requestedCreatedAfter });

    return res.json({
      success: true,
      message: `Synced ${result.upserted} Wix booking(s)`,
      data: {
        upserted: result.upserted,
        sessionsUpserted: result.sessionsUpserted,
        clientsResolved: result.clientsResolved,
        psychologistsResolved: result.psychologistsResolved,
        sessionMirrorSkipped: Boolean(result.sessionMirrorSkipped),
        extractionTried: result.extractionTried,
        fetchedAt: result.fetchedAt,
        createdAfter: result.createdAfter || null,
        skippedOlder: result.skippedOlder || 0,
        skippedMissingCreatedAt: result.skippedMissingCreatedAt || 0,
      },
    });
  } catch (e) {
    if (e.code === 'WIX_CONFIG_MISSING') {
      return res.status(503).json({ success: false, error: e.message });
    }
    if (e.code === '42P01') {
      return res.status(500).json({
        success: false,
        error: e.message,
        hint: 'Table wix_bookings missing — run the migration in supabase/migrations/20260420120000_wix_bookings.sql',
      });
    }
    if (e.httpStatus) {
      return res.status(e.httpStatus >= 400 && e.httpStatus < 600 ? e.httpStatus : 502).json({
        success: false,
        error: e.message,
      });
    }
    console.error('[syncWixBookings]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * GET /admin/wix/bookings?page=1&limit=10&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&search=
 * List mirrored rows. Date params are interpreted as UTC calendar days (frontend presets).
 * Date bounds use IST midnight (Asia/Kolkata) on `created_at` to mirror Wix “today”.
 * Note: column is mirror first-sync time; payload.createdDate is the Wix creation instant for display.
 */
async function listWixBookings(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10));
    const { dateFrom, dateTo, search, session_type, status } = req.query;
    const fromIdx = (page - 1) * limit;
    const toIdx = fromIdx + limit - 1;

    const getEffectiveStatus = (row) => {
      const linked = String(row?.session_status || '').toLowerCase();
      const primary = String(row?.status || '').toLowerCase();
      return linked || primary;
    };

    const getStartTimeMs = (row) => {
      const iso = row?.start_time;
      if (!iso) return 0;
      const ms = new Date(iso).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };

    const matchesStatusFilter = (row) => {
      const normalizedStatus = String(status || '').toLowerCase();
      if (!normalizedStatus || normalizedStatus === 'all') return true;

      const effective = getEffectiveStatus(row);
      const startMs = getStartTimeMs(row);
      const now = Date.now();
      const activeStatuses = new Set(['booked', 'scheduled', 'rescheduled', 'reschedule_requested', 'confirmed']);

      if (normalizedStatus === 'booked') {
        // Upcoming = all booked/active sessions regardless of whether start time is past or future
        return activeStatuses.has(effective);
      }
      if (normalizedStatus === 'pending') {
        // Pending = booked sessions whose start time has already passed (past-due)
        return activeStatuses.has(effective) && startMs > 0 && startMs < now;
      }
      if (normalizedStatus === 'no_show') {
        return effective === 'no_show' || effective === 'noshow';
      }

      return effective === normalizedStatus;
    };

    let q = supabaseAdmin.from('wix_bookings').select('*');

    if (session_type && session_type !== 'all') {
      q = q.eq('session_type', session_type);
    }

    // For date filtering: ALWAYS check both start_time (when the session happens) and created_at (when it was booked).
    // Previously this was only for the 'Upcoming' tab, causing packages/completed sessions to disappear if created in a past month.
    if (dateFrom && dateTo) {
      q = q.or(
        `and(start_time.gte.${dateFrom}T00:00:00.000+05:30,start_time.lte.${dateTo}T23:59:59.999+05:30),` +
        `and(created_at.gte.${dateFrom}T00:00:00.000+05:30,created_at.lte.${dateTo}T23:59:59.999+05:30)`
      );
    } else {
      if (dateFrom) q = q.gte('created_at', `${dateFrom}T00:00:00.000+05:30`);
      if (dateTo) q = q.lte('created_at', `${dateTo}T23:59:59.999+05:30`);
    }

    const term = typeof search === 'string' ? search.trim().replace(/,/g, '') : '';
    if (term) {
      const esc = term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%${esc}%`;
      q = q.or(
        `client_email.ilike.${pattern},client_full_name.ilike.${pattern},client_first_name.ilike.${pattern},therapist_name.ilike.${pattern},title.ilike.${pattern}`
      );
    }

    // Newest Wix bookings on top
    q = q
      .order('created_at', { ascending: false, nullsFirst: false })
      .order('start_time', { ascending: false, nullsFirst: false });

    const { data: bookingsData, error: bookingsError } = await q;

    if (bookingsError) {
      console.error('[listWixBookings]', bookingsError);
      return res.status(500).json({
        success: false,
        error: bookingsError.message || 'Failed to list wix_bookings',
        hint:
          bookingsError.code === '42P01'
            ? 'Table wix_bookings missing — run the migration in supabase/migrations/20260420120000_wix_bookings.sql'
            : undefined,
      });
    }

    // Manually fetch session IDs to avoid missing FK relationship error
    const wixBookingIds = bookingsData.map(b => b.wix_booking_id).filter(Boolean);
    let sessionMap = new Map();
    if (wixBookingIds.length > 0) {
      const { data: sessionsData } = await supabaseAdmin
        .from('sessions')
        .select('id, wix_booking_id, package_id, client_id, psychologist_id, package_session_number, session_count, status, google_meet_link, google_meet_join_url, google_meet_start_url, google_calendar_link')
        .in('wix_booking_id', wixBookingIds);
      
      if (sessionsData) {
        sessionsData.forEach(s => {
          sessionMap.set(s.wix_booking_id, s);
        });
      }
    }

    const allVisibleRows = dedupeBookings((bookingsData || []).map((row) => ({
      id: row.wix_booking_id,
      status: row.status,
      createdDate: row.payload?.createdDate || row.created_at,
      startTime: row.start_time,
      scheduleId: row.schedule_id,
      sessionId: row.wix_session_id,
      title: row.title,
      contactId: row.contact_id,
      client: { email: row.client_email, contactId: row.contact_id },
      session_id: sessionMap.get(row.wix_booking_id)?.id || null,
      __row: row,
    })))
      .map((x) => {
        const row = x.__row || x;
        // Attach session_status from the linked sessions table so matchesStatusFilter
        // uses the platform's ground truth (e.g. completed) not Wix's stale status.
        const linkedSession = sessionMap.get(row.wix_booking_id);
        return linkedSession?.status ? { ...row, session_status: linkedSession.status } : row;
      })
      .filter((row) => {
        // Match finance sessions page logic: only exclude deleted rows and
        // UNDEFINED-state rows (no wix_session_id). Package children are real
        // sessions and must be counted (finance counts them too via sessions table).
        return row.status !== 'deleted' && !!row.wix_session_id;
      });

    const statusFilteredRows = allVisibleRows.filter(matchesStatusFilter);
    const totalVisible = statusFilteredRows.length;
    const dedupedData = statusFilteredRows.slice(fromIdx, toIdx + 1);

    // Compute total *sessions* (a Package of 3 = 3 sessions, children of a package = 0)
    // by aggregating session_count and package linkage across the same date range.
    let totalSessions = totalVisible;
    try {
      let aggQ = supabaseAdmin
        .from('wix_bookings')
        .select('session_type, session_count, package_parent_booking_id, package_session_number, status, wix_session_id, wix_order_number, price');
      if (session_type && session_type !== 'all') aggQ = aggQ.eq('session_type', session_type);
      if (isUpcomingWixTab && dateFrom && dateTo) {
        aggQ = aggQ.or(
          `and(start_time.gte.${dateFrom}T00:00:00.000+05:30,start_time.lte.${dateTo}T23:59:59.999+05:30),` +
          `and(created_at.gte.${dateFrom}T00:00:00.000+05:30,created_at.lte.${dateTo}T23:59:59.999+05:30)`
        );
      } else {
        if (dateFrom) aggQ = aggQ.gte('created_at', `${dateFrom}T00:00:00.000+05:30`);
        if (dateTo) aggQ = aggQ.lte('created_at', `${dateTo}T23:59:59.999+05:30`);
      }
      const { data: rowsForCount } = await aggQ;
      if (Array.isArray(rowsForCount)) {
        // Same logic as allVisibleRows filter: exclude deleted + no wix_session_id only
        totalSessions = rowsForCount.filter(
          (r) => r.status !== 'deleted' && !!r.wix_session_id
        ).length;
      }
    } catch { /* fall back to count */ }

    return res.json({
      success: true,
      data: {
        bookings: dedupedData.map((row) => {
          const linkedSession = sessionMap.get(row.wix_booking_id) || null;
          if (!linkedSession) return row;
          return {
            ...row,
            session_id: linkedSession.id || null,
            package_id: linkedSession.package_id || null,
            client_id: linkedSession.client_id || null,
            psychologist_id: linkedSession.psychologist_id || null,
            package_session_number: row.package_session_number ?? linkedSession.package_session_number ?? null,
            session_count: row.session_count ?? linkedSession.session_count ?? null,
            session_status: linkedSession.status || null,
            google_meet_link: linkedSession.google_meet_link || null,
            google_meet_join_url: linkedSession.google_meet_join_url || null,
            google_meet_start_url: linkedSession.google_meet_start_url || null,
            google_calendar_link: linkedSession.google_calendar_link || null,
          };
        }),
        pagination: {
          page,
          limit,
          total: totalVisible,
          totalPages: Math.max(1, Math.ceil(totalVisible / limit)),
          totalSessions,
        },
      },
    });
  } catch (e) {
    console.error('[listWixBookings]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * GET /admin/wix/orphans
 * Detect suspicious bookings:
 *   1. ₹0 rows that should be linked to a package but aren't
 *   2. Duplicate bookings (same client + same start_time)
 *   3. Children whose parent package no longer exists
 *   4. Packages with more children than session_count - 1
 */
async function listWixOrphans(req, res) {
  try {
    const { data: all } = await supabaseAdmin
      .from('wix_bookings')
      .select('wix_booking_id, client_email, client_full_name, therapist_name, price, currency, session_type, session_count, session_index, package_parent_booking_id, start_time, status, contact_id, service_id, payload')
      .order('start_time', { ascending: true });

    const rows = all || [];
    const packages = rows.filter(r => r.session_type === 'package');
    const orphans = [];

    // 1. Eligible ₹0 rows that aren't linked
    rows.forEach(r => {
      if (r.package_parent_booking_id) return;
      if (r.session_type === 'package') return;
      if (parseFloat(r.price ?? 0) > 0) return;
      const matchPkg = packages.find(p =>
        p.client_email?.toLowerCase() === r.client_email?.toLowerCase() &&
        (r.start_time || '') >= (p.start_time || '')
      );
      if (matchPkg) {
        orphans.push({
          ...r,
          orphanReason: 'eligible-but-unlinked',
          orphanDetail: `Free session that matches ${matchPkg.client_email}'s Package of ${matchPkg.session_count}, but linker did not pick it up (cap reached, or sync timing).`,
        });
      }
    });

    // 2. Duplicate bookings (same client_email + same start_time within 1 minute)
    const byKey = {};
    rows.forEach(r => {
      const k = `${(r.client_email||'').toLowerCase()}|${r.start_time?.slice(0,16) || ''}`;
      if (!k.replace('|','')) return;
      (byKey[k] = byKey[k] || []).push(r);
    });
    Object.values(byKey).forEach(group => {
      if (group.length > 1) {
        // Skip the first (the "primary"); rest are duplicates
        group.slice(1).forEach(r => orphans.push({
          ...r,
          orphanReason: 'duplicate-booking',
          orphanDetail: `Same client + same start time as another booking. Wix appears to have created a duplicate.`,
        }));
      }
    });

    // 3. Children whose parent doesn't exist
    const pkgIds = new Set(packages.map(p => p.wix_booking_id));
    rows.forEach(r => {
      if (r.package_parent_booking_id && !pkgIds.has(r.package_parent_booking_id)) {
        orphans.push({
          ...r,
          orphanReason: 'dangling-child',
          orphanDetail: `Linked to parent ${r.package_parent_booking_id} which doesn't exist.`,
        });
      }
    });

    // 4. Packages with too many children
    packages.forEach(p => {
      const childCount = rows.filter(r => r.package_parent_booking_id === p.wix_booking_id).length;
      const cap = (p.session_count || 1) - 1;
      if (childCount > cap) {
        orphans.push({
          ...p,
          orphanReason: 'package-overflow',
          orphanDetail: `Package of ${p.session_count} but has ${childCount} children (max should be ${cap}).`,
        });
      }
    });

    // Dedup by wix_booking_id keeping first reason
    const seen = new Set();
    const dedupedOrphans = orphans.filter(o => {
      if (seen.has(o.wix_booking_id)) return false;
      seen.add(o.wix_booking_id);
      return true;
    });

    return res.json({
      success: true,
      data: {
        orphans: dedupedOrphans,
        summary: {
          total: dedupedOrphans.length,
          eligibleButUnlinked: dedupedOrphans.filter(o => o.orphanReason === 'eligible-but-unlinked').length,
          duplicateBookings: dedupedOrphans.filter(o => o.orphanReason === 'duplicate-booking').length,
          danglingChildren: dedupedOrphans.filter(o => o.orphanReason === 'dangling-child').length,
          packageOverflow: dedupedOrphans.filter(o => o.orphanReason === 'package-overflow').length,
        },
      },
    });
  } catch (e) {
    console.error('[listWixOrphans]', e);
    return res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * POST /admin/wix/backfill-clients
 * One-time backfill: create/resolve users+clients from existing wix_bookings rows.
 */
async function backfillWixClients(req, res) {
  try {
    const limit = Math.min(5000, Math.max(100, parseInt(String(req.body?.limit || '2000'), 10) || 2000));
    const { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .select(
        'wix_booking_id,client_email,client_first_name,client_last_name,client_phone,title,start_time,status,contact_id'
      )
      .not('client_email', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to read wix_bookings' });
    }

    const bookings = (data || [])
      .filter((r) => r.client_email)
      .map((r) => ({
        id: r.wix_booking_id,
        status: r.status,
        title: r.title,
        startTime: r.start_time,
        contactId: r.contact_id,
        client: {
          email: r.client_email,
          firstName: r.client_first_name,
          lastName: r.client_last_name,
          phone: r.client_phone,
          contactId: r.contact_id,
        },
      }));

    const wixIdToClientId = await resolveClientsForBookings(bookings);
    return res.json({
      success: true,
      message: `Backfilled ${wixIdToClientId.size} Wix client account(s)`,
      data: {
        scanned: bookings.length,
        resolved: wixIdToClientId.size,
      },
    });
  } catch (e) {
    console.error('[backfillWixClients]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * GET /admin/wix/therapists
 * List therapists discovered from wix_bookings and matched psychologist rows.
 */
async function listWixTherapists(req, res) {
  try {
    const pageSize = Math.min(2000, Math.max(200, parseInt(String(req.query.page_size || '2000'), 10) || 2000));
    const maxBookingsParsed = req.query.max_bookings != null ? parseInt(String(req.query.max_bookings), 10) : NaN;
    const maxBookings =
      Number.isFinite(maxBookingsParsed) && maxBookingsParsed > 0
        ? Math.min(500000, maxBookingsParsed)
        : null;

    const summary = new Map();
    let bookingsScanned = 0;
    let bookingRowsWithNoTherapistIdentity = 0;
    let offset = 0;

    while (true) {
      const remainingBudget =
        maxBookings == null ? pageSize : Math.min(pageSize, maxBookings - bookingsScanned);
      if (remainingBudget <= 0) break;

      const pageEnd = offset + remainingBudget - 1;

      const { data: rows, error } = await supabaseAdmin
        .from('wix_bookings')
        .select('therapist_name,created_at,payload')
        .order('id', { ascending: true })
        .range(offset, pageEnd);

      if (error) {
        return res.status(500).json({ success: false, error: error.message || 'Failed to read wix_bookings' });
      }

      const batch = rows || [];
      if (batch.length === 0) break;

      for (const r of batch) {
        const payload = r.payload || {};
        const t = payload.therapist || {};
        const name = String(r.therapist_name || t.name || t.displayName || t.fullName || '').trim();
        const email = String(t.email || '').trim().toLowerCase() || null;
        const phone = String(t.phone || '').trim() || null;
        if (!name && !email) {
          bookingRowsWithNoTherapistIdentity += 1;
          continue;
        }
        const key = `${name.toLowerCase()}|${email || ''}`;
        const existing = summary.get(key);
        if (!existing) {
          summary.set(key, {
            name: name || null,
            email,
            phone,
            bookingsCount: 1,
            latestBookingAt: r.created_at || null,
            psychologist: null,
          });
        } else {
          existing.bookingsCount += 1;
          if ((r.created_at || '') > (existing.latestBookingAt || '')) {
            existing.latestBookingAt = r.created_at;
          }
        }
      }

      bookingsScanned += batch.length;
      offset += batch.length;

      if (batch.length < remainingBudget) break;
      if (maxBookings != null && bookingsScanned >= maxBookings) break;
    }

    const therapists = Array.from(summary.values());
    const staffEmailByName = new Map();
    try {
      const discover = await fetchWixDiscover({
        limit: process.env.WIX_DISCOVER_BOOKING_LIMIT || DEFAULT_WIX_SYNC_LIMIT,
      });
      const staffSample = discover?.json?.sections?.staff?.sample;
      if (Array.isArray(staffSample)) {
        for (const s of staffSample) {
          const n = String(s?.name || '').trim().toLowerCase();
          const e = String(s?.email || '').trim().toLowerCase();
          if (n && e) staffEmailByName.set(n, e);
        }
      }
    } catch (_e) {
      // Non-blocking; list should still work from mirrored data.
    }
    const { count: psychologistTableCount, error: psychCountErr } = await supabaseAdmin
      .from('psychologists')
      .select('*', { count: 'exact', head: true });
    if (psychCountErr) {
      console.warn('[listWixTherapists] psychologist count:', psychCountErr.message || psychCountErr);
    }

    const { data: psychologists } = await supabaseAdmin
      .from('psychologists')
      .select('id,email,first_name,last_name,phone,designation,profile_picture_url,created_at,google_calendar_credentials')
      .limit(5000);

    const psychByEmail = new Map();
    const psychByName = new Map();
    for (const p of psychologists || []) {
      const email = String(p.email || '').trim().toLowerCase();
      if (email) psychByEmail.set(email, p);
      const nameKey = `${String(p.first_name || '').trim().toLowerCase()} ${String(p.last_name || '').trim().toLowerCase()}`.trim();
      if (nameKey) psychByName.set(nameKey, p);
    }

    const mapped = therapists
      .map((t) => {
        const nameKey = String(t.name || '').trim().toLowerCase();
        const inferredEmail = t.email || staffEmailByName.get(nameKey) || null;
        const matched = (inferredEmail && psychByEmail.get(inferredEmail)) || psychByName.get(nameKey) || null;
        return {
          ...t,
          email: inferredEmail || t.email || matched?.email || null,
          psychologist: matched
            ? {
                id: matched.id,
                email: matched.email,
                phone: matched.phone,
                firstName: matched.first_name,
                lastName: matched.last_name,
                designation: matched.designation,
                profilePictureUrl: matched.profile_picture_url,
                createdAt: matched.created_at,
                google_calendar_connected: !!matched.google_calendar_credentials,
              }
            : null,
        };
      })
      .sort((a, b) => (b.latestBookingAt || '').localeCompare(a.latestBookingAt || ''));

    // Final dedupe pass:
    // 1) If linked to psychologist, dedupe by psychologist.id
    // 2) Else dedupe by normalized name
    const dedupedMap = new Map();
    for (const row of mapped) {
      const linkedPsychId = row?.psychologist?.id || null;
      const normalizedName = String(row?.name || '').trim().toLowerCase();
      const key = linkedPsychId ? `psych:${linkedPsychId}` : `name:${normalizedName}`;

      if (!dedupedMap.has(key)) {
        dedupedMap.set(key, { ...row });
        continue;
      }

      const existing = dedupedMap.get(key);
      existing.bookingsCount = (existing.bookingsCount || 0) + (row.bookingsCount || 0);
      if ((row.latestBookingAt || '') > (existing.latestBookingAt || '')) {
        existing.latestBookingAt = row.latestBookingAt;
      }
      // Prefer rows that have richer contact fields
      if (!existing.email && row.email) existing.email = row.email;
      if (!existing.phone && row.phone) existing.phone = row.phone;
      if (!existing.psychologist && row.psychologist) existing.psychologist = row.psychologist;
    }

    const data = Array.from(dedupedMap.values()).sort((a, b) =>
      (b.latestBookingAt || '').localeCompare(a.latestBookingAt || '')
    );

    const psychologistIdsLinkedFromBookingList = new Set(
      data.map((row) => row.psychologist?.id).filter(Boolean)
    );
    const bookingTherapistEmails = new Set(
      therapists.map((t) => String(t.email || '').trim().toLowerCase()).filter(Boolean)
    );
    const bookingTherapistNamesLower = therapists
      .map((t) => String(t.name || '').trim().toLowerCase())
      .filter(Boolean);

    const psychologistPresentInMirrorBookingFields = (p) => {
      const em = String(p.email || '').trim().toLowerCase();
      if (em && bookingTherapistEmails.has(em)) return true;
      const nameKey =
        `${String(p.first_name || '').trim().toLowerCase()} ${String(p.last_name || '').trim().toLowerCase()}`.trim();
      if (nameKey.length >= 4 && bookingTherapistNamesLower.includes(nameKey)) return true;
      return bookingTherapistNamesLower.some((bn) =>
        bookingDisplayNameProbablySamePsychologist(bn, p)
      );
    };

    /** Profiles that never appear linked (still may show UNLINKED on this page if their name/email appears on rows). */
    const psychologistsWithoutGreenProfileLinkFromMirror = (psychologists || []).filter(
      (p) => !psychologistIdsLinkedFromBookingList.has(p.id)
    );

    /** Best-effort “never appears as therapist on mirrored Wix rows” vs “might be an UNLINKED card above”. */
    const psychologistsProbablyMissingFromBookingMirror = (psychologists || []).filter((p) => {
      if (psychologistIdsLinkedFromBookingList.has(p.id)) return false;
      return !psychologistPresentInMirrorBookingFields(p);
    });

    const psychologistsUnlinkedButPresentOnBookingList = psychologistsWithoutGreenProfileLinkFromMirror.filter((p) =>
      psychologistPresentInMirrorBookingFields(p)
    ).length;

    const truncationWarning =
      psychologistTableCount != null &&
      (psychologists || []).length < psychologistTableCount;

    return res.json({
      success: true,
      data: {
        therapists: data,
        total: data.length,
        meta: {
          bookingsScanned,
          bookingRowsWithNoTherapistIdentity,
          distinctTherapistIdentitiesAfterDedupe: data.length,
          psychologistProfilesLinkedMatched: psychologistIdsLinkedFromBookingList.size,
          psychologistsTableCount:
            psychologistTableCount == null ? null : Number(psychologistTableCount),
          psychologistsLoadedForMatching: (psychologists || []).length,
          psychologistsUnlinkedShowingOnPageEstimated: psychologistsUnlinkedButPresentOnBookingList,
          psychologistsProbablyMissingFromSyncedWixBookings: psychologistsProbablyMissingFromBookingMirror.length,
          samplePsychologistsProbablyMissingFromMirror: psychologistsProbablyMissingFromBookingMirror.slice(0, 20).map(
            (p) => ({
              id: p.id,
              displayName:
                `${p.first_name || ''} ${p.last_name || ''}`.trim() ||
                (p.email ? p.email.split('@')[0] : 'Unknown'),
              email: p.email || null,
            })
          ),
          psychMatchListMayBeIncomplete: truncationWarning || false,
          maxBookingsCap: maxBookings,
          scanCompletesWholeMirror: maxBookings == null,
        },
      },
    });
  } catch (e) {
    console.error('[listWixTherapists]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * POST /integrations/wix/realtime-sync
 * Secure webhook-style endpoint for Wix events; triggers immediate discover sync.
 * Header: x-wix-webhook-key: <WIX_WEBHOOK_SECRET>
 */
async function realtimeSyncFromWix(req, res) {
  try {
    const syncTriggeredAt = new Date().toISOString();
    const expected = process.env.WIX_WEBHOOK_SECRET || process.env.WIX_DISCOVER_API_KEY || '';
    const given = req.headers['x-wix-webhook-key'] || req.headers['X-Wix-Webhook-Key'];

    if (!expected) {
      return res.status(503).json({ success: false, error: 'WIX_WEBHOOK_SECRET is not configured' });
    }
    if (!given || given !== expected) {
      return res.status(401).json({ success: false, error: 'Unauthorized webhook request' });
    }

    const body = req.body || {};
    const eventType = body.eventType || 'unknown';
    const enriched = body.booking || null;
    const rawEventPayload = body.eventPayload || null;
    const enrichedList = Array.isArray(body.bookings) ? body.bookings : enriched ? [enriched] : [];

    // Merge variant/package data from the raw Wix event (same data Zapier receives)
    // into the enriched booking so the mapper can detect package types.
    if (rawEventPayload && enrichedList.length) {
      const rawVariants =
        rawEventPayload.selectedVariants ||
        rawEventPayload.bookedEntity?.selectedVariants ||
        rawEventPayload.formInfo?.variantSelections ||
        rawEventPayload.variantSelections ||
        null;
      if (rawVariants) {
        for (const eb of enrichedList) {
          if (!eb.variantSelections) eb.variantSelections = rawVariants;
        }
        console.log(`[realtimeSyncFromWix] merged variant data from raw event:`, JSON.stringify(rawVariants).slice(0, 200));
      }
    }

    let directUpsert = { upserted: 0, sessionsUpserted: 0 };
    if (enrichedList.length) {
      try {
        directUpsert = await upsertEnrichedBookings(enrichedList);
        console.log(
          `[realtimeSyncFromWix] ${eventType}: direct upsert ${directUpsert.upserted} booking(s)`
        );

        // Trigger notifications immediately if something was upserted
        if (directUpsert.upserted > 0 || directUpsert.sessionsUpserted > 0) {
          processNewWixSessions().catch(err => {
            console.error('[realtimeSyncFromWix] Notification trigger failed:', err);
          });
        }
      } catch (err) {
        console.error('[realtimeSyncFromWix] direct upsert failed:', err.message || err);
      }
    }

    // Respond fast to Wix; reconcile in background to survive Wix index lag.
    res.json({
      success: true,
      message: `Realtime sync accepted (${eventType})`,
      data: { direct: directUpsert, reconcile: 'scheduled' },
    });

    // Fire-and-forget reconciliation: discover may lag by a few seconds after
    // booking.created, so pull twice with a short backoff to catch stragglers.
    (async () => {
      const delays = [3000, 15000];
      for (const d of delays) {
        try {
          await sleep(d);
          const r = await performWixSync({ createdAfter: syncTriggeredAt });
          console.log(
            `[realtimeSyncFromWix] reconcile(+${d}ms): synced ${r.upserted} booking(s)`
          );
        } catch (err) {
          if (err.code !== 'WIX_CONFIG_MISSING') {
            console.error(`[realtimeSyncFromWix] reconcile(+${d}ms) failed:`, err.message || err);
          }
        }
      }
    })().catch(() => {});
    return;
  } catch (e) {
    console.error('[realtimeSyncFromWix]', e);
    return res.status(500).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * GET /admin/wix/bookings/:id
 * Return a single wix_bookings row by Supabase id (not wix_booking_id).
 */
async function getWixBookingDetails(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }
    return res.json({ success: true, data: { booking: data } });
  } catch (e) {
    console.error('[getWixBookingDetails]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * PATCH /admin/wix/bookings/:id
 * Edit a wix_bookings row. Sets locally_modified = true so Wix sync won't overwrite.
 */
async function editWixBooking(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body || {};

    // Sanitise: only allow editing known columns
    const allowed = ['status', 'title', 'start_time', 'end_time', 'notes', 'price', 'currency', 'therapist_name'];
    const safeUpdates = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) safeUpdates[key] = updates[key];
    }
    safeUpdates.locally_modified = true;
    safeUpdates.synced_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .update(safeUpdates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    // Mirror to sessions if exists
    if (data.wix_booking_id) {
      const sessionUpdates = { locally_modified: true };
      if (safeUpdates.status) sessionUpdates.status = safeUpdates.status;
      if (safeUpdates.title) sessionUpdates.notes = safeUpdates.title;
      if (safeUpdates.session_type) sessionUpdates.session_type = safeUpdates.session_type;
      if (safeUpdates.price) {
        sessionUpdates.price = safeUpdates.price;
        sessionUpdates.amount = safeUpdates.price;
      }
      if (safeUpdates.start_time) {
        sessionUpdates.scheduled_date = safeUpdates.start_time.split('T')[0];
        sessionUpdates.scheduled_time = safeUpdates.start_time.split('T')[1]?.split('.')[0];
      }
      await supabaseAdmin.from('sessions').update(sessionUpdates).eq('wix_booking_id', data.wix_booking_id);
    }

    return res.json({ success: true, message: 'Wix booking updated', data: { booking: data } });
  } catch (e) {
    console.error('[editWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * DELETE /admin/wix/bookings/:id
 * Soft-delete: sets status='deleted' + locally_modified=true so sync won't re-create.
 */
async function deleteWixBooking(req, res) {
  try {
    const { id } = req.params;
    const updates = { status: 'deleted', locally_modified: true, synced_at: new Date().toISOString() };

    let { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .update(updates)
      .eq('id', id)
      .select('id, wix_booking_id')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    if (!data) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }

    // Mirror to sessions
    if (data.wix_booking_id) {
      await supabaseAdmin
        .from('sessions')
        .update({ status: 'cancelled', locally_modified: true })
        .eq('wix_booking_id', data.wix_booking_id);

      // Clean up calendar events (Koott + Wix Native)
      deleteCalendarEventsForWixBooking(data.wix_booking_id, { force: true }).catch(err => {
        console.warn('[deleteWixBooking] calendar event cleanup failed:', err);
      });
    }

    return res.json({ success: true, message: 'Wix booking deleted', data: { booking: data } });
  } catch (e) {
    console.error('[deleteWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * PATCH /admin/wix/bookings/:id/complete
 * Mark a Wix booking as completed. Does NOT set locally_modified so Wix admin panel
 * won't show "Edited locally". Sync protection is handled via terminal status exclusion.
 */
async function completeWixBooking(req, res) {
  try {
    const { id } = req.params;
    const updates = { status: 'completed', synced_at: new Date().toISOString() };

    let { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    if (!data) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }

    // Mirror to sessions (no locally_modified — terminal status protects from sync)
    if (data.wix_booking_id) {
      await supabaseAdmin
        .from('sessions')
        .update({ status: 'completed' })
        .eq('wix_booking_id', data.wix_booking_id);
    }

    // Send session_follow_up_v2 WhatsApp to client (Interakt template)
    try {
      const interaktService = require('../utils/interaktService');
      const clientPhone = data.client_phone || null;
      if (clientPhone) {
        // Use the Wix-supplied full name, skipping common placeholder strings
        const { isPlaceholderName } = require('../utils/sessionTitleFormatter');
        const pickName = (...candidates) => candidates.find((v) => v && !isPlaceholderName(v));
        const clientName = pickName(
          data.client_full_name,
          [data.client_first_name, data.client_last_name].filter(Boolean).join(' ').trim(),
          data.client_first_name,
        ) || 'there';
        const therapistName = data.therapist_name || 'your therapist';

        // Pull therapist note + completion timestamp from the linked sessions row
        // (in case it was completed via the regular flow with a summary)
        let therapistNote = '';
        let completedAt = data.updated_at || new Date().toISOString();
        if (data.wix_booking_id) {
          const { data: linkedSess } = await supabaseAdmin
            .from('sessions')
            .select('summary, summary_notes, completion_date, updated_at')
            .eq('wix_booking_id', data.wix_booking_id)
            .maybeSingle();
          if (linkedSess) {
            therapistNote = (linkedSess.summary && String(linkedSess.summary).trim()) || '';
            completedAt = linkedSess.completion_date || linkedSess.updated_at || completedAt;
          }
        }

        const result = await interaktService.sendSessionFollowUp(clientPhone, {
          clientName, psychologistName: therapistName, completedAt, therapistNote,
        });
        if (result?.success) {
          console.log(`✅ [completeWixBooking] session_follow_up_v2 sent to client ${clientName}`);
        } else {
          console.warn(`⚠️ [completeWixBooking] session_follow_up_v2 failed:`, result?.error || result?.reason);
        }
      }
    } catch (waErr) {
      console.error('[completeWixBooking] session_follow_up_v2 error:', waErr.message);
      // Don't fail the request if WhatsApp fails
    }

    return res.json({ success: true, message: 'Wix booking marked as completed', data: { booking: data } });
  } catch (e) {
    console.error('[completeWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * PATCH /admin/wix/bookings/:id/no-show
 * Mark a Wix booking as no-show. No locally_modified — terminal status protects from sync.
 */
async function noShowWixBooking(req, res) {
  try {
    const { id } = req.params;
    const updates = { status: 'no_show', synced_at: new Date().toISOString() };

    let { data, error } = await supabaseAdmin
      .from('wix_bookings')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'Wix booking not found' });

    // Mirror to sessions (no locally_modified — terminal status protects from sync)
    if (data.wix_booking_id) {
      await supabaseAdmin
        .from('sessions')
        .update({ status: 'no_show' })
        .eq('wix_booking_id', data.wix_booking_id);
    }

    return res.json({ success: true, message: 'Wix booking marked as no-show', data: { booking: data } });
  } catch (e) {
    console.error('[noShowWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * PATCH /admin/wix/bookings/:id/cancel-refund
 * Cancel a Wix booking and mark it as refunded.
 * - wix_bookings.status  → 'cancelled'
 * - sessions.status      → 'refunded'  (finance treats this as a refund, not a mere cancel)
 * - Removes the therapist's Google Calendar event so the slot opens up for new bookings
 */
async function cancelRefundWixBooking(req, res) {
  try {
    const { id } = req.params;

    // 1. Fetch the wix_booking row (need wix_booking_id + calendar info + client/therapist details for emails)
    const { data: booking, error: fetchErr } = await supabaseAdmin
      .from('wix_bookings')
      .select('id, wix_booking_id, psychologist_id, google_calendar_event_id, status, client_full_name, client_first_name, client_email, therapist_name, start_time')
      .eq('id', id)
      .single();

    if (fetchErr || !booking) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }

    // 2. Update wix_bookings → cancelled (no locally_modified — terminal status protects from sync)
    const { error: wbErr } = await supabaseAdmin
      .from('wix_bookings')
      .update({ status: 'cancelled', synced_at: new Date().toISOString() })
      .eq('id', id);
    if (wbErr) return res.status(500).json({ success: false, error: wbErr.message });

    // 3. Update sessions → refunded (finance counts refunds separately from cancels)
    let sessionRow = null;
    if (booking.wix_booking_id) {
      const { data: sess } = await supabaseAdmin
        .from('sessions')
        .update({ status: 'refunded' })
        .eq('wix_booking_id', booking.wix_booking_id)
        .select('id, psychologist_id, google_calendar_event_id, google_calendar_credentials_snapshot')
        .single();
      sessionRow = sess || null;
    }

    // 4. Delete Google Calendar event (Koott + Wix Native) so the therapist's slot reopens
    if (booking.wix_booking_id) {
      deleteCalendarEventsForWixBooking(booking.wix_booking_id, { force: true }).catch(err => {
        console.warn('[cancelRefundWixBooking] calendar event cleanup failed:', err);
      });
    }

    // 5. Send cancellation emails to BOTH client and therapist
    (async () => {
      try {
        const emailService = require('../utils/emailService');
        const clientEmail = booking.client_email || null;
        const clientName = booking.client_full_name || booking.client_first_name || 'Client';
        const psychologistName = booking.therapist_name || 'Therapist';
        // Pull therapist email by id
        let psychEmail = null;
        if (booking.psychologist_id) {
          const { data: psych } = await supabaseAdmin
            .from('psychologists')
            .select('email')
            .eq('id', booking.psychologist_id)
            .single();
          psychEmail = psych?.email || null;
        }
        // Date/time from start_time ISO (IST)
        let sessionDate = null, sessionTime = null;
        if (booking.start_time) {
          const d = new Date(booking.start_time);
          const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
          sessionDate = ist.toISOString().slice(0, 10);
          sessionTime = ist.toISOString().slice(11, 19);
        }

        if (clientEmail) {
          await emailService.sendCancellationNotification({
            to: clientEmail,
            clientName, psychologistName,
            sessionDate, sessionTime,
            sessionId: booking.wix_booking_id,
            isPsychologist: false,
          });
          console.log(`✅ [cancelRefundWixBooking] cancellation email sent to client ${clientEmail}`);
        }
        if (psychEmail) {
          await emailService.sendCancellationNotification({
            to: psychEmail,
            clientName, psychologistName,
            sessionDate, sessionTime,
            sessionId: booking.wix_booking_id,
            isPsychologist: true,
          });
          console.log(`✅ [cancelRefundWixBooking] cancellation email sent to therapist ${psychEmail}`);
        }
      } catch (mailErr) {
        console.error('[cancelRefundWixBooking] email send failed (non-fatal):', mailErr.message || mailErr);
      }
    })();

    return res.json({
      success: true,
      message: 'Booking cancelled and marked as refunded. Calendar event removed. Emails sent.',
      data: { wix_booking_id: booking.wix_booking_id, calendarEventRemoved: !!calEventId },
    });
  } catch (e) {
    console.error('[cancelRefundWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * POST /admin/wix/bookings/:id/book-next-session
 * Book the next session in a Wix package.
 * - Creates a sessions row (for meet/notification pipeline)
 * - Creates a wix_bookings mirror row so the session appears in the Wix Discover page
 * - Fires meet + email + WhatsApp notifications async
 *
 * :id = wix_bookings.id (UUID PK, NOT wix_booking_id)
 * Body: { scheduled_date, scheduled_time }
 */
async function bookWixNextSession(req, res) {
  try {
    const { id } = req.params;
    const { scheduled_date, scheduled_time } = req.body;

    if (!id || !scheduled_date || !scheduled_time) {
      return res.status(400).json({ success: false, error: 'Missing required fields: id (param), scheduled_date, scheduled_time' });
    }

    // ── 1. Fetch original wix_booking row ────────────────────────────────
    const { data: wixRow, error: wixError } = await supabaseAdmin
      .from('wix_bookings')
      .select('id, wix_booking_id, session_type, session_count, package_session_number, package_group_id, therapist_name, client_full_name, client_email, client_first_name, client_last_name, client_phone, contact_id, service_id, title, tags, currency, payload')
      .eq('id', id)
      .single();

    if (wixError || !wixRow) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }

    // ── 2. Fetch linked session for client_id / psychologist_id ─────────
    const { data: linkedSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, client_id, psychologist_id, session_type, package_group_id')
      .eq('wix_booking_id', wixRow.wix_booking_id)
      .single();

    if (sessionError || !linkedSession) {
      return res.status(404).json({ success: false, error: 'Linked session not found. Client/psychologist may not yet be resolved — try again in a minute.' });
    }
    if (!linkedSession.client_id || !linkedSession.psychologist_id) {
      return res.status(400).json({ success: false, error: 'Client or psychologist not yet resolved for this session. Please wait for the sync to complete.' });
    }

    // ── 3. Determine next package_session_number ─────────────────────────
    // Count existing non-deleted wix_booking rows for this package group.
    const packageGroupId = linkedSession.package_group_id || wixRow.package_group_id || null;
    let nextSessionNumber = (wixRow.package_session_number || 1) + 1;
    if (packageGroupId) {
      const { data: existingRows } = await supabaseAdmin
        .from('wix_bookings')
        .select('package_session_number')
        .eq('package_group_id', packageGroupId)
        .neq('status', 'deleted');
      if (existingRows && existingRows.length > 0) {
        const maxNum = Math.max(...existingRows.map(r => r.package_session_number || 1));
        nextSessionNumber = maxNum + 1;
      }
    }
    const totalSessions = wixRow.session_count
      || wixRow.payload?.creditsAvailable
      || wixRow.payload?.detectedSessionCount
      || wixRow.payload?.pricingPlanInfo?.credits?.available
      || 0;

    // ── 4. Build IST start/end times for the wix_bookings mirror ─────────
    // Convert scheduled_date + scheduled_time to ISO strings in UTC (subtract IST offset)
    let startTimeIso = null;
    let endTimeIso = null;
    try {
      // scheduled_time is 'HH:MM:00', scheduled_date is 'YYYY-MM-DD'
      const startLocal = new Date(`${scheduled_date}T${scheduled_time}+05:30`);
      if (!isNaN(startLocal.getTime())) {
        startTimeIso = startLocal.toISOString();
        // Use original Wix session duration to compute end time if available
        const originalPayload = wixRow.payload || {};
        const origStart = originalPayload.startTime;
        const origEnd = originalPayload.endTime;
        let durMin = 50;
        if (origStart && origEnd) {
          const d = Math.round((new Date(origEnd) - new Date(origStart)) / 60000);
          if (d > 0) durMin = d;
        }
        endTimeIso = new Date(startLocal.getTime() + durMin * 60000).toISOString();
      }
    } catch (_) { /* non-critical */ }

    // ── 5. Create wix_bookings mirror row FIRST (sessions.wix_booking_id FK requires it) ──
    const syntheticWixBookingId = `admin_manual_${Date.now()}`;
    const now = new Date().toISOString();

    // Always 'package' for follow-ups — we're inside bookWixNextSession so it's always a package.
    // Use wixRow (wix_bookings ground truth) first; linkedSession.session_type can be stale/null.
    const sessionType = wixRow.session_type === 'couple' ? 'couple'
      : (wixRow.session_type === 'package' || totalSessions > 1) ? 'package'
      : linkedSession.session_type || 'package';

    const wixBookingsMirror = {
      wix_booking_id: syntheticWixBookingId,
      wix_session_id: syntheticWixBookingId,
      status: 'booked',
      session_type: sessionType,
      session_count: totalSessions,
      package_session_number: nextSessionNumber,
      package_group_id: packageGroupId,
      therapist_name: wixRow.therapist_name || null,
      client_full_name: wixRow.client_full_name || null,
      client_first_name: wixRow.client_first_name || null,
      client_last_name: wixRow.client_last_name || null,
      client_email: wixRow.client_email || null,
      client_phone: wixRow.client_phone || null,
      contact_id: wixRow.contact_id || null,
      service_id: wixRow.service_id || null,
      title: wixRow.title || null,
      tags: wixRow.tags || null,
      start_time: startTimeIso,
      end_time: endTimeIso,
      price: '0',          // already paid via original package purchase
      currency: wixRow.currency || null,
      locally_modified: true,
      payload: {
        bookingType: sessionType,
        startTime: startTimeIso,
        endTime: endTimeIso,
        therapist: wixRow.therapist_name || null,
        isAdminManual: true,
        sourceWixBookingId: wixRow.wix_booking_id,
        // These two fields drive deriveSessionType → "Package (2/3)"
        planSessionNumber: nextSessionNumber,
        creditsAvailable: totalSessions,
      },
      created_at: now,
      updated_at: now,
      synced_at: now,
    };

    const { error: mirrorError } = await supabaseAdmin
      .from('wix_bookings')
      .insert(wixBookingsMirror);

    if (mirrorError) {
      console.error('[bookWixNextSession] wix_bookings mirror insert failed:', mirrorError.message);
      return res.status(500).json({ success: false, error: 'Failed to create booking record: ' + mirrorError.message });
    }
    console.log(`[bookWixNextSession] wix_bookings mirror created for session ${nextSessionNumber}/${totalSessions}`);

    // ── 6. Create sessions row (FK to wix_bookings now satisfied) ────────
    const { data: created, error: createError } = await supabaseAdmin
      .from('sessions')
      .insert({
        source: 'wix',
        wix_booking_id: syntheticWixBookingId,
        client_id: linkedSession.client_id,
        psychologist_id: linkedSession.psychologist_id,
        session_type: sessionType,       // same resolved value as mirror row
        package_group_id: packageGroupId,
        package_session_number: nextSessionNumber,
        scheduled_date,
        scheduled_time,
        original_scheduled_date: scheduled_date,
        original_scheduled_time: scheduled_time,
        status: 'booked',
        price: 0,                        // already paid via original package
        session_notes: wixRow.client_full_name ? `Package follow-up for ${wixRow.client_full_name}` : 'Package follow-up (Wix)',
        created_at: now,
        updated_at: now,
        booking_created_at: now,
      })
      .select()
      .single();

    if (createError) {
      // Roll back the mirror row to avoid orphan wix_bookings record
      await supabaseAdmin.from('wix_bookings').delete().eq('wix_booking_id', syntheticWixBookingId);
      console.error('[bookWixNextSession] sessions insert error:', createError);
      return res.status(500).json({ success: false, error: 'Failed to create session: ' + (createError.message || String(createError)) });
    }

    // ── 7. Fire meet + email + WhatsApp notifications async ──────────────
    // Don't await — respond to admin immediately, notifications go in background
    setImmediate(() => {
      processOneSession(created).catch((err) => {
        console.error('[bookWixNextSession] notification error (non-fatal):', err.message || err);
      });
    });

    console.log(`[bookWixNextSession] Created session ${nextSessionNumber}/${totalSessions} for package ${packageGroupId}`);
    return res.json({ success: true, message: 'Next session booked successfully', data: { session: created } });
  } catch (e) {
    console.error('[bookWixNextSession]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * POST /admin/wix/bookings/:id/transfer
 * Transfer a Wix booking to a different therapist.
 * Optionally change date/time too.
 * - Removes old calendar event from old therapist
 * - Creates new GMeet under new therapist's credentials
 * - Updates wix_bookings row (therapist_name, psychologist_id, meet fields, optionally start_time)
 * - If a linked platform session exists (via wix_booking_id), updates that too
 */
async function transferWixBooking(req, res) {
  try {
    const { id } = req.params;
    const { new_psychologist_id, new_date, new_time } = req.body;

    if (!new_psychologist_id) {
      return res.status(400).json({ success: false, error: 'new_psychologist_id is required' });
    }

    // NOTE: wix_bookings does NOT have psychologist_id / client_id / package_id / google_* columns.
    // The therapist link + Google Meet/Calendar data live on the linked `sessions` row.

    // 1. Fetch the wix booking (only real columns)
    const { data: booking, error: fetchErr } = await supabaseAdmin
      .from('wix_bookings')
      .select('id, wix_booking_id, therapist_name, client_full_name, client_first_name, client_email, session_type, start_time, end_time, payload')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr || !booking) {
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }

    // 2. Fetch new psychologist
    const { data: newPsych, error: psychErr } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email, google_calendar_credentials')
      .eq('id', new_psychologist_id)
      .single();

    if (psychErr || !newPsych) {
      return res.status(404).json({ success: false, error: 'New psychologist not found' });
    }

    // 3. Fetch the linked platform session (source of old psychologist + calendar/meet data)
    let linkedSession = null;
    if (booking.wix_booking_id) {
      const { data } = await supabaseAdmin
        .from('sessions')
        .select('id, psychologist_id, google_calendar_event_id, google_meet_link')
        .eq('wix_booking_id', booking.wix_booking_id)
        .maybeSingle();
      linkedSession = data || null;
    }

    // 4. Delete old calendar event from old therapist (non-fatal)
    let calendarEventRemoved = false;
    if (linkedSession?.google_calendar_event_id) {
      try {
        let oldUserAuth = null;
        if (linkedSession.psychologist_id) {
          const { data: oldPsych } = await supabaseAdmin
            .from('psychologists')
            .select('google_calendar_credentials')
            .eq('id', linkedSession.psychologist_id)
            .maybeSingle();
          const creds = oldPsych?.google_calendar_credentials;
          if (creds?.access_token) {
            oldUserAuth = { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date };
          }
        }
        const eventIds = String(linkedSession.google_calendar_event_id).split(',').map(e => e.trim()).filter(Boolean);
        for (const eid of eventIds) {
          const del = await meetLinkService.deleteCalendarEvent(eid, oldUserAuth);
          if (del?.success) { calendarEventRemoved = true; console.log('✅ [transferWixBooking] deleted old cal event:', eid); }
          else console.warn('[transferWixBooking] calendar delete non-fatal:', del?.error);
        }
      } catch (calErr) {
        console.warn('[transferWixBooking] old calendar delete failed (non-fatal):', calErr.message || calErr);
      }
    }

    // 4. Build new start_time ISO if date/time provided
    let newStartTimeIso = booking.start_time;
    if (new_date && new_time) {
      const timeClean = String(new_time).split('.')[0].trim();
      newStartTimeIso = `${new_date}T${timeClean.length === 5 ? timeClean + ':00' : timeClean}+05:30`;
    }

    // 5. Create new GMeet under new therapist (non-fatal)
    let newMeetData = { meetLink: null, eventId: null, calendarLink: null };
    try {
      const clientName = booking.client_full_name || booking.client_first_name || 'Client';
      const newPsychName = `${newPsych.first_name || ''} ${newPsych.last_name || ''}`.trim();

      let startDate, startTime;
      if (new_date && new_time) {
        startDate = new_date;
        startTime = String(new_time).split('.')[0].trim();
      } else if (booking.start_time) {
        const d = new Date(booking.start_time);
        const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
        startDate = ist.toISOString().slice(0, 10);
        startTime = ist.toISOString().slice(11, 19);
      }

      // Match the calendar event length to the booking's real slot length so Wix
      // blocks the correct duration (50 / 60 / 80 / 90 / 120 min).
      const durationMinutes = getWixBookingDurationMin(booking);
      const addMins = (t, m) => {
        const [h, min] = t.split(':').map(Number);
        const total = h * 60 + min + m;
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
      };

      const meetSessionData = {
        summary: `Koott Session — ${clientName} & ${newPsychName}`,
        description: `Therapy session\nClient: ${clientName}\nTherapist: ${newPsychName}`,
        startDate,
        startTime,
        endTime: startTime ? addMins(startTime, durationMinutes) : undefined,
        clientEmail: booking.client_email || null,
        psychologistEmail: newPsych.email || null,
      };

      let newUserAuth = null;
      const newCreds = newPsych.google_calendar_credentials;
      if (newCreds?.access_token) {
        newUserAuth = { access_token: newCreds.access_token, refresh_token: newCreds.refresh_token, expiry_date: newCreds.expiry_date };
      }

      const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, newUserAuth);
      if (meetResult?.eventId) newMeetData.eventId = meetResult.eventId;
      if (meetResult?.eventLink || meetResult?.calendarLink) newMeetData.calendarLink = meetResult.eventLink || meetResult.calendarLink;
      if (meetResult?.meetLink && !meetResult.meetLink.includes('meet.google.com/new')) {
        newMeetData.meetLink = meetResult.meetLink;
        console.log('✅ [transferWixBooking] new Meet link:', meetResult.method);
      }
    } catch (meetErr) {
      console.error('❌ [transferWixBooking] Meet creation failed (non-fatal):', meetErr.message || meetErr);
    }

    // 6. Update wix_bookings row (only real columns). therapist_name reflects the new psych;
    //    mark locally_modified so the next Wix sync doesn't overwrite the transfer.
    const newPsychName = `${newPsych.first_name || ''} ${newPsych.last_name || ''}`.trim();
    const timeChanged = newStartTimeIso !== booking.start_time;
    const durationMin = getWixBookingDurationMin(booking);
    const wbUpdates = {
      therapist_name: newPsychName,
      locally_modified: true,
      synced_at: new Date().toISOString(),
      ...(timeChanged ? {
        start_time: newStartTimeIso,
        end_time: new Date(new Date(newStartTimeIso).getTime() + durationMin * 60000).toISOString(),
      } : {}),
    };

    const { error: wbErr } = await supabaseAdmin.from('wix_bookings').update(wbUpdates).eq('id', booking.id);
    if (wbErr) return res.status(500).json({ success: false, error: wbErr.message });

    // 7. Also update linked platform session if one exists (carries psychologist + meet/calendar)
    if (linkedSession?.id) {
      const sessionUpdates = {
        psychologist_id: new_psychologist_id,
        // Fix 1 — shield the session from the next Wix sync / calendar cleanup.
        locally_modified: true,
        updated_at: new Date().toISOString(),
      };
      if (newMeetData.eventId) sessionUpdates.google_calendar_event_id = newMeetData.eventId;
      if (newMeetData.meetLink) {
        sessionUpdates.google_meet_link = newMeetData.meetLink;
        sessionUpdates.google_meet_join_url = newMeetData.meetLink;
        sessionUpdates.google_meet_start_url = newMeetData.meetLink;
      }
      if (newMeetData.calendarLink) sessionUpdates.google_calendar_link = newMeetData.calendarLink;
      if (new_date) sessionUpdates.scheduled_date = new_date;
      if (new_time) {
        const t = String(new_time).split('.')[0].trim();
        sessionUpdates.scheduled_time = t.length === 5 ? `${t}:00` : t;
      }
      await supabaseAdmin.from('sessions').update(sessionUpdates).eq('id', linkedSession.id);
    }

    return res.json({
      success: true,
      message: 'Wix booking transferred successfully',
      data: { calendarEventRemoved, newMeetLink: newMeetData.meetLink },
    });
  } catch (e) {
    console.error('[transferWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

async function rescheduleWixBooking(req, res) {
  try {
    const { id } = req.params;
    const { new_date, new_time } = req.body;

    console.log(`🔁 [rescheduleWixBooking] id=${id} → ${new_date} ${new_time}`);

    if (!new_date || !new_time) {
      return res.status(400).json({ success: false, error: 'new_date and new_time are required' });
    }

    // NOTE: wix_bookings does NOT have psychologist_id / client_id / google_* columns.
    // Therapist + Google Meet/Calendar live on the linked `sessions` row (when one exists);
    // wix_bookings only mirrors Wix fields (start_time, end_time, therapist_name, payload, ...).

    // 1. Fetch the wix booking — three strategies:
    //    (a) UUID primary key of wix_bookings
    //    (b) wix_booking_id string (Wix's own ID)
    //    (c) sessions.id → derive wix_booking_id → fetch wix_booking
    const BOOKING_SELECT = 'id, wix_booking_id, therapist_name, client_full_name, client_first_name, client_email, client_phone, session_type, start_time, end_time, payload';
    let booking = null;

    const { data: b1 } = await supabaseAdmin
      .from('wix_bookings')
      .select(BOOKING_SELECT)
      .eq('id', id)
      .maybeSingle();
    booking = b1 || null;

    if (!booking) {
      const { data: b2 } = await supabaseAdmin
        .from('wix_bookings')
        .select(BOOKING_SELECT)
        .eq('wix_booking_id', id)
        .maybeSingle();
      booking = b2 || null;
    }

    if (!booking) {
      // id may be a sessions.id UUID — resolve via sessions table
      const { data: sessionRow } = await supabaseAdmin
        .from('sessions')
        .select('wix_booking_id')
        .eq('id', id)
        .maybeSingle();
      if (sessionRow?.wix_booking_id) {
        const { data: b3 } = await supabaseAdmin
          .from('wix_bookings')
          .select(BOOKING_SELECT)
          .eq('wix_booking_id', sessionRow.wix_booking_id)
          .maybeSingle();
        booking = b3 || null;
      }
    }

    if (!booking) {
      console.warn('[rescheduleWixBooking] booking not found for id:', id);
      return res.status(404).json({ success: false, error: 'Wix booking not found' });
    }

    // 2. Fetch the linked platform session (source of psychologist + calendar/meet data)
    let linkedSession = null;
    if (booking.wix_booking_id) {
      const { data } = await supabaseAdmin
        .from('sessions')
        .select('id, psychologist_id, google_calendar_event_id, google_meet_link')
        .eq('wix_booking_id', booking.wix_booking_id)
        .maybeSingle();
      linkedSession = data || null;
    }

    // 3. Resolve the psychologist — prefer the linked session's id, fall back to matching therapist_name
    let psych = null;
    if (linkedSession?.psychologist_id) {
      const { data } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, email, phone, google_calendar_credentials')
        .eq('id', linkedSession.psychologist_id)
        .maybeSingle();
      psych = data || null;
    }
    if (!psych && booking.therapist_name) {
      const parts = String(booking.therapist_name).trim().split(/\s+/);
      const fn = parts[0] || '';
      const ln = parts.slice(1).join(' ') || '';
      let q = supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, email, phone, google_calendar_credentials')
        .ilike('first_name', fn);
      if (ln) q = q.ilike('last_name', ln);
      const { data } = await q.maybeSingle();
      psych = data || null;
    }

    // 4. Build new start/end ISO (IST). Duration from payload or default 50 min.
    //    (Computed before any calendar op so the move/create uses the new time.)
    const timeClean = String(new_time).split('.')[0].trim();          // HH:MM or HH:MM:SS
    const timeHms = timeClean.length === 5 ? `${timeClean}:00` : timeClean;
    const durationMin = getWixBookingDurationMin(booking);
    const newStartTimeIso = `${new_date}T${timeHms}+05:30`;
    const newEndTimeIso = new Date(new Date(newStartTimeIso).getTime() + durationMin * 60000).toISOString();

    // 5. Move the calendar event to the new time on the therapist's calendar.
    //    Strategy (mirrors the platform reschedule): try to PATCH the existing event
    //    so the SAME Meet link is preserved and the event simply shifts to the new
    //    date/time (old slot freed, attendees notified via sendUpdates:'all').
    //    Only if there is no existing event, or the patch fails, do we delete the old
    //    one and create a fresh event. Everything here is awaited — no fire-and-forget
    //    cleanup that could race the create and delete the new event.
    let newMeetData = { meetLink: null, eventId: null, calendarLink: null };
    const addMins = (t, m) => {
      const [h, min] = t.split(':').map(Number);
      const total = h * 60 + min + m;
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
    };
    try {
      const clientName = booking.client_full_name || booking.client_first_name || 'Client';
      const psychName = psych ? `${psych.first_name || ''} ${psych.last_name || ''}`.trim() : (booking.therapist_name || 'Therapist');
      const meetSessionData = {
        summary: `Koott Session — ${clientName} & ${psychName}`,
        description: `Therapy session (rescheduled)\nClient: ${clientName}\nTherapist: ${psychName}`,
        startDate: new_date,
        startTime: timeClean.slice(0, 5),
        endTime: addMins(timeClean.slice(0, 5), durationMin),
        clientEmail: booking.client_email || null,
        psychologistEmail: psych?.email || null,
      };
      const creds = psych?.google_calendar_credentials;
      const userAuth = creds?.access_token
        ? { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date }
        : null;

      const primaryEventId = linkedSession?.google_calendar_event_id
        ? String(linkedSession.google_calendar_event_id).split(',').map(e => e.trim()).filter(Boolean)[0]
        : null;

      let meetResult = null;
      if (primaryEventId) {
        const upd = await meetLinkService.updateCalendarEvent(primaryEventId, meetSessionData, userAuth);
        if (upd?.success && upd.meetLink) {
          meetResult = { meetLink: upd.meetLink, eventId: upd.eventId };
          console.log('✅ [rescheduleWixBooking] event moved to new time; Meet link preserved:', upd.meetLink);
        } else {
          console.warn('⚠️ [rescheduleWixBooking] updateCalendarEvent failed, will delete + recreate:', upd?.error);
          // Old event couldn't be patched — remove it so it doesn't linger on the
          // therapist/client calendars, then fall through to create a fresh one.
          try {
            await meetLinkService.deleteCalendarEvent(primaryEventId, userAuth);
            console.log('✅ [rescheduleWixBooking] old calendar event deleted before recreate:', primaryEventId);
          } catch (delErr) {
            console.warn('⚠️ [rescheduleWixBooking] old event delete failed (non-fatal):', delErr.message || delErr);
          }
        }
      }

      if (!meetResult) {
        const created = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
        if (created?.eventId) {
          const link = created.meetLink && !created.meetLink.includes('meet.google.com/new') ? created.meetLink : null;
          meetResult = { meetLink: link, eventId: created.eventId, calendarLink: created.eventLink || created.calendarLink };
          console.log('✅ [rescheduleWixBooking] new calendar event created on therapist calendar:', created.eventId);
        } else {
          console.warn('⚠️ [rescheduleWixBooking] could not create replacement calendar event:', created?.error);
        }
      }

      if (meetResult) {
        newMeetData.eventId = meetResult.eventId || null;
        newMeetData.meetLink = meetResult.meetLink || null;
        newMeetData.calendarLink = meetResult.calendarLink || null;
      }
    } catch (meetErr) {
      console.error('[rescheduleWixBooking] calendar move/create failed (non-fatal):', meetErr.message || meetErr);
    }

    // 7. Update wix_bookings row (only real columns). Mark locally_modified so the next
    //    Wix sync does not overwrite the new time.
    const wbUpdates = {
      start_time: newStartTimeIso,
      end_time: newEndTimeIso,
      locally_modified: true,
      synced_at: new Date().toISOString(),
    };
    const { error: wbErr } = await supabaseAdmin.from('wix_bookings').update(wbUpdates).eq('id', booking.id);
    if (wbErr) return res.status(500).json({ success: false, error: wbErr.message });

    // Fix 3 — durability check: a rescheduled slot is only "held" if there is a live
    // calendar event blocking it (Wix reads the therapist's Google Calendar for
    // availability). If we ended up without an event id, the slot is NOT blocked and
    // Wix can resell it → log loudly so it can be caught before a double-booking.
    if (!newMeetData.eventId) {
      console.error(`🚨 [rescheduleWixBooking] NO calendar event for rescheduled slot ${new_date} ${timeHms} (session ${linkedSession?.id || '-'}). Slot is NOT blocked in Google Calendar — Wix may resell it.`);
    }

    // 8. Update the linked platform session (carries psychologist + meet/calendar)
    if (linkedSession?.id) {
      const sessionUpdates = {
        scheduled_date: new_date,
        scheduled_time: timeHms,
        status: 'rescheduled',
        reminder_sent: false, // reset so the new time gets a fresh reminder
        // Fix 1 — shield the session from the next Wix sync (and its calendar cleanup),
        // so the rescheduled event/time is never overwritten or cancelled.
        locally_modified: true,
        updated_at: new Date().toISOString(),
      };
      // Only overwrite meet/calendar fields if we successfully created a new event;
      // otherwise keep the existing ones so the session isn't left without a link.
      if (newMeetData.eventId) sessionUpdates.google_calendar_event_id = newMeetData.eventId;
      if (newMeetData.meetLink) {
        sessionUpdates.google_meet_link = newMeetData.meetLink;
        sessionUpdates.google_meet_join_url = newMeetData.meetLink;
        sessionUpdates.google_meet_start_url = newMeetData.meetLink;
      }
      if (newMeetData.calendarLink) sessionUpdates.google_calendar_link = newMeetData.calendarLink;
      await supabaseAdmin.from('sessions').update(sessionUpdates).eq('id', linkedSession.id);
    }
    console.log('✅ [rescheduleWixBooking] booking + session updated:', booking.id);

    // 9. Notify client + therapist (email + WhatsApp) — non-fatal, fire-and-forget
    (async () => {
      try {
        const emailService = require('../utils/emailService');
        const interaktService = require('../utils/interaktService');

        // Old date/time derived from the previous start_time (UTC → IST)
        let oldDate = null, oldTime = null;
        if (booking.start_time) {
          const ist = new Date(new Date(booking.start_time).getTime() + 5.5 * 3600 * 1000);
          oldDate = ist.toISOString().slice(0, 10);
          oldTime = ist.toISOString().slice(11, 19);
        }

        const clientName = booking.client_full_name || booking.client_first_name || 'Client';
        const psychName = psych ? `${psych.first_name || ''} ${psych.last_name || ''}`.trim() : (booking.therapist_name || 'Therapist');
        const meetLink = newMeetData.meetLink || linkedSession?.google_meet_link || null;

        await emailService.sendRescheduleNotification({
          clientName,
          psychologistName: psychName,
          clientEmail: booking.client_email || null,
          psychologistEmail: psych?.email || null,
          scheduledDate: new_date,
          scheduledTime: timeHms,
          sessionId: linkedSession?.id || booking.id,
          meetLink,
          isFreeAssessment: false,
          durationMinutes: durationMin,
        }, oldDate, oldTime);
        console.log('✅ [rescheduleWixBooking] reschedule emails sent');

        const clientPhone = booking.client_phone || null;
        if (clientPhone) {
          const waClient = await interaktService.sendRescheduleNotification(clientPhone, {
            recipientName: clientName,
            otherPartyName: psychName,
            date: new_date,
            time: timeHms,
            meetLink,
          });
          if (waClient?.success) console.log('✅ [rescheduleWixBooking] WhatsApp sent to client');
          else console.warn('⚠️ [rescheduleWixBooking] client WhatsApp failed:', waClient?.error || waClient?.reason);
        }

        const psychPhone = psych?.phone || null;
        if (psychPhone) {
          const waPsych = await interaktService.sendRescheduleNotification(psychPhone, {
            recipientName: psychName,
            otherPartyName: clientName,
            date: new_date,
            time: timeHms,
            meetLink,
          });
          if (waPsych?.success) console.log('✅ [rescheduleWixBooking] WhatsApp sent to psychologist');
          else console.warn('⚠️ [rescheduleWixBooking] psychologist WhatsApp failed:', waPsych?.error || waPsych?.reason);
        }
      } catch (notifErr) {
        console.error('❌ [rescheduleWixBooking] notification error (non-fatal):', notifErr.message || notifErr);
      }
    })();

    return res.json({
      success: true,
      message: 'Wix booking rescheduled successfully',
      data: { newMeetLink: newMeetData.meetLink },
    });
  } catch (e) {
    console.error('[rescheduleWixBooking]', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}

/**
 * Helper to delete a session's Google Calendar event.
 */
async function deleteSessionCalendarEventHelper(psychologistId, eventIdStr) {
  if (!psychologistId || !eventIdStr) return;
  try {
    const { data: psych } = await supabaseAdmin
      .from('psychologists')
      .select('google_calendar_credentials')
      .eq('id', psychologistId)
      .maybeSingle();

    const creds = psych?.google_calendar_credentials;
    const userAuth = creds?.access_token
      ? { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date }
      : null;

    if (!userAuth) {
      console.warn('[deleteSessionCalendarEventHelper] no therapist Google credentials found for psychologist:', psychologistId);
      return;
    }

    const eventIds = String(eventIdStr).split(',').map(e => e.trim()).filter(Boolean);
    for (const eid of eventIds) {
      try {
        await meetLinkService.deleteCalendarEvent(eid, userAuth);
        console.log(`[deleteSessionCalendarEventHelper] deleted event ${eid}`);
      } catch (err) {
        console.warn(`[deleteSessionCalendarEventHelper] failed to delete event ${eid}:`, err.message || err);
      }
    }
  } catch (err) {
    console.error('[deleteSessionCalendarEventHelper] error:', err);
  }
}

/**
 * Helper to search for and delete the Wix Native Event at a given time slot.
 */
/**
 * Resolve a Wix booking's true slot length in minutes so the Google Calendar event
 * matches it (Wix blocks availability by the calendar event length). Most authoritative
 * source is the booking's own end_time − start_time; then payload.sessionDurationMin;
 * else default 50. Handles 50/60/80/90/120-min sessions correctly.
 */
function getWixBookingDurationMin(booking) {
  if (booking?.start_time && booking?.end_time) {
    const d = Math.round((new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / 60000);
    if (Number.isFinite(d) && d > 0 && d <= 600) return d;
  }
  const fromPayload = parseInt(booking?.payload?.sessionDurationMin, 10);
  if (Number.isFinite(fromPayload) && fromPayload > 0) return fromPayload;
  return 50;
}

async function deleteWixNativeEventHelper(psychologistId, startTimeStr, endTimeStr, clientDetails, excludeEventIds = []) {
  if (!psychologistId || !startTimeStr || !endTimeStr) return;
  try {
    const { data: psych } = await supabaseAdmin
      .from('psychologists')
      .select('google_calendar_credentials')
      .eq('id', psychologistId)
      .maybeSingle();

    const creds = psych?.google_calendar_credentials;
    const userAuth = creds?.access_token
      ? { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date }
      : null;

    if (!userAuth) {
      console.warn('[deleteWixNativeEventHelper] no credentials for psychologist:', psychologistId);
      return;
    }

    const startTime = new Date(startTimeStr);
    const endTime = new Date(endTimeStr);

    const searchResult = await googleCalendarService.getCalendarEvents(creds, 'primary', startTime, endTime);
    const events = searchResult.events || [];

    const clientNameLower = String(clientDetails.client_full_name || clientDetails.client_first_name || '').toLowerCase().trim();
    const clientPhoneClean = String(clientDetails.client_phone || '').replace(/\D/g, '');

    for (const ev of events) {
      const summaryLower = String(ev.summary || '').toLowerCase();
      
      if (excludeEventIds.includes(ev.id)) continue;

      let isWixEvent = false;
      if (clientNameLower && summaryLower.includes(clientNameLower)) {
        isWixEvent = true;
      } else if (clientDetails.client_first_name && summaryLower.includes(String(clientDetails.client_first_name).toLowerCase().trim())) {
        isWixEvent = true;
      }

      if (!isWixEvent && clientPhoneClean.length >= 8) {
        const last8 = clientPhoneClean.slice(-8);
        if (summaryLower.replace(/\D/g, '').includes(last8)) {
          isWixEvent = true;
        }
      }

      if (isWixEvent) {
        console.log(`[deleteWixNativeEventHelper] Found Wix Native Event: "${ev.summary}" (ID: ${ev.id}). Deleting...`);
        const delResult = await meetLinkService.deleteCalendarEvent(ev.id, userAuth);
        if (delResult?.success) {
          console.log(`[deleteWixNativeEventHelper] Deleted Wix Native Event: ${ev.id}`);
        } else {
          console.warn(`[deleteWixNativeEventHelper] Failed to delete event ${ev.id}:`, delResult?.error);
        }
      }
    }
  } catch (err) {
    console.error('[deleteWixNativeEventHelper] error:', err);
  }
}

/**
 * Helper to delete all calendar events (Koott + Wix Native) associated with a Wix booking.
 *
 * Fix 2 — SAFETY GUARD: this must only run when the booking is genuinely being
 * cancelled/deleted. It is NEVER safe to run for an active session, because the
 * Wix-native cleanup deletes events by time-window+name and would wipe the live
 * calendar block for the slot — which makes Wix (whose availability is driven by the
 * therapist's Google Calendar) resell the slot. The previous reschedule race that
 * caused triple-bookings came from exactly this. Active or locally_modified sessions
 * are skipped.
 */
const ACTIVE_SESSION_STATUSES = ['booked', 'rescheduled', 'reschedule_requested', 'confirmed', 'scheduled', 'upcoming'];
async function deleteCalendarEventsForWixBooking(wixBookingId, { force = false } = {}) {
  if (!wixBookingId) return;
  try {
    const { data: booking } = await supabaseAdmin
      .from('wix_bookings')
      .select('therapist_name, client_full_name, client_first_name, client_phone, start_time, end_time')
      .eq('wix_booking_id', wixBookingId)
      .maybeSingle();

    if (!booking) return;

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('psychologist_id, google_calendar_event_id, status, locally_modified')
      .eq('wix_booking_id', wixBookingId)
      .maybeSingle();

    if (!session) return;

    // Guard: never tear down calendar events for a session that is still active or
    // locally protected, unless the caller explicitly forces it (delete/cancel actions).
    if (!force) {
      const status = String(session.status || '').toLowerCase();
      if (session.locally_modified || ACTIVE_SESSION_STATUSES.includes(status)) {
        console.warn(`[deleteCalendarEventsForWixBooking] SKIP cleanup for active/protected session (status=${status}, locally_modified=${!!session.locally_modified}) wix_booking_id=${wixBookingId}`);
        return;
      }
    }

    const oldEventId = session.google_calendar_event_id;
    const eventIds = oldEventId ? String(oldEventId).split(',').map(e => e.trim()).filter(Boolean) : [];

    await deleteSessionCalendarEventHelper(session.psychologist_id, oldEventId);

    if (booking.start_time && booking.end_time) {
      await deleteWixNativeEventHelper(session.psychologist_id, booking.start_time, booking.end_time, {
        client_full_name: booking.client_full_name,
        client_first_name: booking.client_first_name,
        client_phone: booking.client_phone
      }, eventIds);
    }
  } catch (err) {
    console.error('[deleteCalendarEventsForWixBooking] error:', err);
  }
}

module.exports = {
  performWixSync,
  upsertEnrichedBookings,
  syncWixBookings,
  listWixBookings,
  listWixOrphans,
  listWixTherapists,
  backfillWixClients,
  realtimeSyncFromWix,
  getWixBookingDetails,
  editWixBooking,
  deleteWixBooking,
  completeWixBooking,
  noShowWixBooking,
  cancelRefundWixBooking,
  bookWixNextSession,
  handleWixWebhook,
  transferWixBooking,
  rescheduleWixBooking,
};

/**
 * POST /api/wix/webhook/booking
 * Wix Velo Webhook handler for instant sync.
 */
async function handleWixWebhook(req, res) {
  try {
    const { booking, bookingId } = req.body;
    console.log(`[WixWebhook] Received booking event for ID: ${bookingId || booking?.id}`);

    if (!booking) {
      return res.status(400).json({ success: false, error: 'Missing booking object in payload' });
    }

    // 1. Sync the booking to Supabase immediately
    const syncResult = await upsertEnrichedBookings(booking, { skipCreatedAfterFilter: true });
    console.log(`[WixWebhook] Sync completed: ${syncResult.upserted} upserted`);

    // 2. Trigger the notification service immediately (Meet link + Email/WA)
    // This runs in the background so the webhook returns quickly
    processNewWixSessions().catch(err => {
      console.error('[WixWebhook] Notification trigger failed:', err);
    });

    return res.json({ 
      success: true, 
      message: 'Webhook processed and sync triggered',
      bookingId: bookingId || booking?.id 
    });
  } catch (e) {
    console.error('[handleWixWebhook] Error:', e);
    return res.status(500).json({ success: false, error: e.message || String(e) });
  }
}
