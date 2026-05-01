/**
 * Booking data audit:
 * - Validates package usage (total/completed/remaining) per client package
 *   via both:
 *   (a) package_id model, and
 *   (b) package_group_id parent/follow-up model
 * - Flags mismatches in package session numbering
 * - Summarizes session-type distribution (including couple sessions)
 *
 * Run from backend dir:
 *   node scripts/audit-bookings-data.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabaseAdmin } = require('../config/supabase');

const COMPLETED_STATUSES = new Set(['complete', 'completed']);
const ACTIVE_BOOKING_STATUSES = new Set(['booked', 'rescheduled', 'complete', 'completed']);

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  console.log('Starting bookings data audit...\n');

  const [{ data: sessions, error: sessionsErr }, { data: packages, error: packagesErr }] = await Promise.all([
    supabaseAdmin
      .from('sessions')
      .select('id, client_id, psychologist_id, package_id, package_group_id, package_session_number, session_count, status, session_type, scheduled_date, scheduled_time, created_at')
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('packages')
      .select('id, name, package_type, session_count')
  ]);

  if (sessionsErr) {
    console.error('Failed to fetch sessions:', sessionsErr.message);
    process.exit(1);
  }
  if (packagesErr) {
    console.error('Failed to fetch packages:', packagesErr.message);
    process.exit(1);
  }

  const packageById = new Map((packages || []).map((p) => [p.id, p]));
  const allSessions = sessions || [];

  console.log(`Total sessions: ${allSessions.length}`);

  const sessionTypeCounts = {};
  for (const s of allSessions) {
    const t = s.session_type || '(null)';
    sessionTypeCounts[t] = (sessionTypeCounts[t] || 0) + 1;
  }

  console.log('\nSession type distribution:');
  Object.entries(sessionTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => console.log(`  - ${type}: ${count}`));

  const coupleTypeMatches = allSessions.filter((s) => norm(s.session_type).includes('couple'));
  console.log(`\nDetected couple-session records: ${coupleTypeMatches.length}`);

  const packageSessionsByPackageId = allSessions.filter((s) => !!s.package_id);
  const packageSessionsByGroup = allSessions.filter((s) => !!s.package_group_id);
  const packageRowsByType = allSessions.filter((s) => norm(s.session_type).includes('package'));
  console.log(`Package rows by session_type: ${packageRowsByType.length}`);
  console.log(`Package-linked sessions by package_id: ${packageSessionsByPackageId.length}`);
  console.log(`Package-linked sessions by package_group_id: ${packageSessionsByGroup.length}`);

  // Group by (client_id + package_id): one purchased package lifecycle for a client
  const usageByClientPackage = new Map();
  for (const s of packageSessionsByPackageId) {
    const key = `${s.client_id || 'null'}::${s.package_id}`;
    if (!usageByClientPackage.has(key)) {
      usageByClientPackage.set(key, {
        key,
        client_id: s.client_id,
        package_id: s.package_id,
        sessions: []
      });
    }
    usageByClientPackage.get(key).sessions.push(s);
  }

  const audits = [];
  for (const item of usageByClientPackage.values()) {
    const pkg = packageById.get(item.package_id);
    const configuredTotal = safeNum(pkg?.session_count, 0);
    const bookedOrDone = item.sessions.filter((s) => ACTIVE_BOOKING_STATUSES.has(norm(s.status))).length;
    const completed = item.sessions.filter((s) => COMPLETED_STATUSES.has(norm(s.status))).length;
    const remaining = Math.max(0, configuredTotal - bookedOrDone);

    const numbers = item.sessions
      .map((s) => safeNum(s.package_session_number, 0))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    const uniqueNumbers = new Set(numbers);
    let gapFound = false;
    if (numbers.length > 0) {
      for (let i = 1; i <= Math.max(...numbers); i++) {
        if (!uniqueNumbers.has(i)) {
          gapFound = true;
          break;
        }
      }
    }

    audits.push({
      ...item,
      package_name: pkg?.name || '(unknown package)',
      package_type: pkg?.package_type || null,
      configured_total: configuredTotal,
      booked_or_done: bookedOrDone,
      completed,
      remaining,
      total_rows: item.sessions.length,
      has_duplicate_session_numbers: uniqueNumbers.size !== numbers.length,
      has_gaps_in_session_numbers: gapFound,
      has_overbooked_rows: configuredTotal > 0 ? bookedOrDone > configuredTotal : false
    });
  }

  console.log(`\nClient-package groups found via package_id: ${audits.length}`);

  const mismatches = audits.filter(
    (a) =>
      a.has_duplicate_session_numbers ||
      a.has_gaps_in_session_numbers ||
      a.has_overbooked_rows ||
      (a.configured_total > 0 && a.total_rows > a.configured_total)
  );

  console.log(`Problematic client-package groups: ${mismatches.length}`);

  // Print sample of package-of-3 specifically (package_id model)
  const packageOf3Groups = audits.filter((a) => a.configured_total === 3);
  console.log(`\nPackage-of-3 client groups via package_id: ${packageOf3Groups.length}`);
  packageOf3Groups.slice(0, 25).forEach((a, idx) => {
    console.log(
      `  ${idx + 1}. client=${a.client_id}, package=${a.package_id} (${a.package_name}), ` +
      `booked_or_done=${a.booked_or_done}, completed=${a.completed}, remaining=${a.remaining}`
    );
  });
  if (packageOf3Groups.length > 25) {
    console.log(`  ...and ${packageOf3Groups.length - 25} more package-of-3 groups`);
  }

  if (mismatches.length > 0) {
    console.log('\nTop mismatches (up to 30):');
    mismatches.slice(0, 30).forEach((m, idx) => {
      console.log(
        `  ${idx + 1}. client=${m.client_id}, package=${m.package_id}, total=${m.configured_total}, ` +
        `rows=${m.total_rows}, booked_or_done=${m.booked_or_done}, completed=${m.completed}, remaining=${m.remaining}, ` +
        `dupNos=${m.has_duplicate_session_numbers}, gapNos=${m.has_gaps_in_session_numbers}, overbooked=${m.has_overbooked_rows}`
      );
    });
    if (mismatches.length > 30) {
      console.log(`  ...and ${mismatches.length - 30} more mismatches`);
    }
  }

  // ---- package_group_id model (Wix parent/follow-up model) ----
  const parentCandidates = allSessions.filter(
    (s) => norm(s.session_type).includes('package') && !s.package_group_id
  );
  const childrenByParent = new Map();
  for (const s of allSessions) {
    if (!s.package_group_id) continue;
    if (!childrenByParent.has(s.package_group_id)) childrenByParent.set(s.package_group_id, []);
    childrenByParent.get(s.package_group_id).push(s);
  }

  const groupAudits = parentCandidates.map((parent) => {
    const totalConfigured = safeNum(parent.session_count, 0);
    const groupRows = [parent, ...(childrenByParent.get(parent.id) || [])];
    const bookedOrDone = groupRows.filter((s) => ACTIVE_BOOKING_STATUSES.has(norm(s.status))).length;
    const completed = groupRows.filter((s) => COMPLETED_STATUSES.has(norm(s.status))).length;
    const remaining = Math.max(0, totalConfigured - bookedOrDone);

    return {
      parent_id: parent.id,
      client_id: parent.client_id,
      psychologist_id: parent.psychologist_id,
      total_configured: totalConfigured,
      rows_in_group: groupRows.length,
      booked_or_done: bookedOrDone,
      completed,
      remaining,
      has_overbooked_rows: totalConfigured > 0 ? bookedOrDone > totalConfigured : false
    };
  });

  const packageGroupsWithCount = groupAudits.filter((g) => g.total_configured > 1);
  console.log(`\nPackage parent groups via package_group_id/session_count>1: ${packageGroupsWithCount.length}`);

  const packageOf3ViaGroup = packageGroupsWithCount.filter((g) => g.total_configured === 3);
  console.log(`Package-of-3 groups via package_group_id/session_count: ${packageOf3ViaGroup.length}`);
  packageOf3ViaGroup.slice(0, 25).forEach((g, idx) => {
    console.log(
      `  ${idx + 1}. parent=${g.parent_id}, client=${g.client_id}, ` +
      `booked_or_done=${g.booked_or_done}, completed=${g.completed}, remaining=${g.remaining}`
    );
  });
  if (packageOf3ViaGroup.length > 25) {
    console.log(`  ...and ${packageOf3ViaGroup.length - 25} more package-of-3 groups`);
  }

  const groupMismatches = packageGroupsWithCount.filter(
    (g) => g.has_overbooked_rows || g.rows_in_group > g.total_configured
  );
  console.log(`Problematic package groups via package_group_id model: ${groupMismatches.length}`);
  if (groupMismatches.length > 0) {
    groupMismatches.slice(0, 30).forEach((g, idx) => {
      console.log(
        `  ${idx + 1}. parent=${g.parent_id}, total=${g.total_configured}, rows=${g.rows_in_group}, ` +
        `booked_or_done=${g.booked_or_done}, completed=${g.completed}, remaining=${g.remaining}, overbooked=${g.has_overbooked_rows}`
      );
    });
  }

  // Global sanity
  const nullPackageRows = allSessions.filter((s) => norm(s.session_type).includes('package') && !s.package_id).length;
  console.log(`\nRows labeled package but missing package_id: ${nullPackageRows}`);

  console.log('\nAudit complete.');
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});

