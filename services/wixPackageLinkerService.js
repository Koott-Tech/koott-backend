/**
 * Wix Package Linker Service
 *
 * Koott uses Wix promo codes to handle multi-session packages:
 *   - Session 1: booked at full package price (e.g. ₹3000), session_count = 3
 *   - Sessions 2 & 3: booked at ₹0 via a 100% promo code
 *
 * Because promo-code sessions have paymentDetails.state = 'UNDEFINED' and price = 0,
 * they're indistinguishable from free bookings at the Wix layer. This service
 * links them back to their parent paid session so we can track package completion.
 *
 * Detection: price = 0 AND wix_payload.paymentDetails.state = 'UNDEFINED'
 *            AND session_type != 'free_assessment'
 * Linking:   find the most recent non-zero session by the same client + psychologist
 *            that has session_count > 1 and no package_group_id (i.e. it's a parent)
 */

const { supabaseAdmin } = require('../config/supabase');

const LOG_PREFIX = '[wixPackageLinker]';

/**
 * Returns true if a sessions-table row looks like a promo-code package follow-up
 * or a manually-booked unpaid session:
 * price = 0, but Wix had a real catalog rate and UNDEFINED/NOT_PAID payment state.
 */
function isPromoFollowUp(session) {
  const price = parseFloat(session.price ?? 0);
  if (price > 0) return false;
  if (session.session_type === 'free_assessment') return false;

  const payload = session.wix_payload;
  if (!payload) return false;

  const paymentState = String(payload?.paymentDetails?.state || '').toUpperCase();
  // UNDEFINED = promo code makes it free
  // NOT_PAID = manually booked through Wix admin without payment
  // OFFLINE = payment collected offline
  return paymentState === 'UNDEFINED' || paymentState === 'NOT_PAID' || paymentState === 'OFFLINE' || paymentState === '';
}

/**
 * For a batch of zero-price candidate sessions (already fetched from DB),
 * find each one's parent paid session and write package_group_id.
 */
async function processCandidates(candidates) {
  let linked = 0;
  let errors = 0;

  for (const session of candidates) {
    try {
      // Look for the most recent paid session by same client + psychologist
      // that is itself a parent (package_group_id IS NULL) and has session_count > 1
      const { data: parents } = await supabaseAdmin
        .from('sessions')
        .select('id, session_count, session_type, scheduled_date')
        .eq('client_id', session.client_id)
        .eq('psychologist_id', session.psychologist_id)
        .gt('price', 0)
        .gt('session_count', 1)
        .is('package_group_id', null)
        .lte('scheduled_date', session.scheduled_date)
        .order('scheduled_date', { ascending: false })
        .limit(1);

      let parent = parents?.[0] ?? null;

      // Fallback: any non-zero paid session by same pair, even session_count = 1.
      // Covers cases where session_count wasn't extracted from the title.
      if (!parent) {
        const { data: fallback } = await supabaseAdmin
          .from('sessions')
          .select('id, session_count, scheduled_date')
          .eq('client_id', session.client_id)
          .eq('psychologist_id', session.psychologist_id)
          .gt('price', 0)
          .is('package_group_id', null)
          .lte('scheduled_date', session.scheduled_date)
          .order('scheduled_date', { ascending: false })
          .limit(1);

        parent = fallback?.[0] ?? null;
      }

      const parentId = parent?.id ?? null;
      if (!parentId) {
        console.log(`${LOG_PREFIX} no parent found for session ${session.id} (client=${session.client_id}, psych=${session.psychologist_id})`);
        continue;
      }

      // GUARD: never link into a package that is already full.
      // Parent membership was inferred from (client + therapist + most recent paid package),
      // with no knowledge of which Wix order actually paid for the package. When a client buys
      // the same package twice, the OLDER package would otherwise swallow sessions belonging to
      // the newer one — producing "3/3 complete" when only the first session of each had run.
      const parentTotal = Number(parent.session_count) || 0;
      if (parentTotal > 1) {
        const { data: siblings } = await supabaseAdmin
          .from('sessions')
          .select('id, status')
          .eq('package_group_id', parentId);
        const used = (siblings || []).filter(
          (s) => !['cancelled', 'deleted', 'refunded'].includes(String(s.status || '').toLowerCase())
        ).length;
        // +1 because the parent itself may not carry the group id yet (set below).
        const consumed = Math.max(used, 1);
        if (consumed >= parentTotal) {
          console.warn(
            `${LOG_PREFIX} SKIP session ${session.id}: parent ${parentId} is full (${consumed}/${parentTotal}). ` +
            `This session likely belongs to a newer package — leaving it unlinked for review.`
          );
          continue;
        }
      }

      // Copy the parent's session_count onto the follow-up. This is CRITICAL: finance splits
      // the package doctor fee by session_count, so a NULL count on a follow-up defaults to 1
      // and massively over-credits it. Follow-ups must inherit the package total.
      const childUpdate = { package_group_id: parentId, session_type: 'package' };
      if (parent.session_count && parent.session_count > 1) {
        childUpdate.session_count = parent.session_count;
      }
      const { error: updateError } = await supabaseAdmin
        .from('sessions')
        .update(childUpdate)
        .eq('id', session.id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      // Ensure the parent is marked as package type AND carries its own group id, so the
      // parent and its follow-ups all share one package_group_id (otherwise the parent stays
      // null-grouped and finance/book-next treat it as a separate one-off).
      await supabaseAdmin
        .from('sessions')
        .update({ session_type: 'package', package_group_id: parentId })
        .eq('id', parentId)
        .is('package_group_id', null);

      console.log(`${LOG_PREFIX} linked session ${session.id} → parent ${parentId}`);
      linked++;
    } catch (err) {
      errors++;
      console.error(`${LOG_PREFIX} error linking session ${session.id}:`, err.message || err);
    }
  }

  return { linked, errors };
}

/**
 * Called after each Wix sync. Finds any newly upserted zero-price sessions
 * that have client_id + psychologist_id resolved and links them.
 *
 * @param {string[]} wixBookingIds - the wix_booking_id values just synced
 */
async function linkPackageSessions(wixBookingIds) {
  if (!wixBookingIds?.length) return { linked: 0, errors: 0 };

  const { data: candidates, error } = await supabaseAdmin
    .from('sessions')
    .select('id, wix_booking_id, client_id, psychologist_id, price, scheduled_date, session_type, package_group_id, wix_payload')
    .in('wix_booking_id', wixBookingIds)
    .is('package_group_id', null)
    .not('client_id', 'is', null)
    .not('psychologist_id', 'is', null);

  if (error) {
    console.error(`${LOG_PREFIX} failed to fetch candidates:`, error.message);
    return { linked: 0, errors: 1 };
  }

  const promoCandidates = (candidates || []).filter(isPromoFollowUp);
  if (!promoCandidates.length) return { linked: 0, errors: 0 };

  console.log(`${LOG_PREFIX} found ${promoCandidates.length} promo follow-up candidate(s)`);
  const result = await processCandidates(promoCandidates);
  if (result.linked > 0) {
    console.log(`${LOG_PREFIX} linked ${result.linked} session(s), errors: ${result.errors}`);
  }
  return result;
}

/**
 * One-time retroactive pass over all unlinked zero-price sessions in the DB.
 * Safe to call multiple times (skips already-linked rows).
 */
async function retroactivelyLinkAllPackageSessions() {
  console.log(`${LOG_PREFIX} starting retroactive link pass...`);

  const { data: all, error } = await supabaseAdmin
    .from('sessions')
    .select('id, wix_booking_id, client_id, psychologist_id, price, scheduled_date, session_type, package_group_id, wix_payload')
    .is('package_group_id', null)
    .not('client_id', 'is', null)
    .not('psychologist_id', 'is', null)
    .or('price.eq.0,price.is.null')
    .neq('status', 'cancelled')
    .eq('source', 'wix');

  if (error) {
    console.error(`${LOG_PREFIX} retroactive fetch failed:`, error.message);
    return { linked: 0, errors: 1 };
  }

  const promoCandidates = (all || []).filter(isPromoFollowUp);
  console.log(`${LOG_PREFIX} retroactive: ${promoCandidates.length} candidate(s) from ${all?.length ?? 0} zero-price sessions`);

  if (!promoCandidates.length) return { linked: 0, errors: 0 };

  const result = await processCandidates(promoCandidates);
  console.log(`${LOG_PREFIX} retroactive complete — linked: ${result.linked}, errors: ${result.errors}`);
  return result;
}

/**
 * Get a summary of package groups for display.
 * Returns all sessions that are part of a package group, grouped by parent.
 *
 * @param {string} parentSessionId
 */
async function getPackageGroupSummary(parentSessionId) {
  const { data: sessions } = await supabaseAdmin
    .from('sessions')
    .select('id, scheduled_date, scheduled_time, status, price, package_group_id')
    .or(`id.eq.${parentSessionId},package_group_id.eq.${parentSessionId}`)
    .order('scheduled_date', { ascending: true });

  if (!sessions?.length) return null;

  const parent = sessions.find(s => s.id === parentSessionId);
  const followUps = sessions.filter(s => s.package_group_id === parentSessionId);

  return {
    parentId: parentSessionId,
    totalSessions: sessions.length,
    completedSessions: sessions.filter(s => s.status === 'completed').length,
    sessions: sessions.map((s, idx) => ({
      ...s,
      sessionNumber: idx + 1,
      isParent: s.id === parentSessionId,
    })),
  };
}

module.exports = {
  linkPackageSessions,
  retroactivelyLinkAllPackageSessions,
  getPackageGroupSummary,
};
