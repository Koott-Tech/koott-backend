require('dotenv').config();

const { supabaseAdmin } = require('../config/supabase');

const START_DATE = '2026-07-01';
const EXCLUDED_NAME_PARTS = ['sreerag', 'rajina'];
const COMPLETED_STATUSES = ['completed'];
const DRY_RUN = process.env.DRY_RUN === '1';

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function isExcludedPsychologist(psychologist) {
  const name = norm(`${psychologist?.first_name || ''} ${psychologist?.last_name || ''}`);
  return EXCLUDED_NAME_PARTS.some((part) => name.includes(part));
}

function isCoupleLike(session, pkg) {
  const text = norm(`${session.session_type || ''} ${pkg?.package_type || ''} ${pkg?.name || ''}`);
  return text.includes('couple') || text.includes('cpl');
}

function isPackageLike(session) {
  return Boolean(session.package_id) ||
    (parseInt(session.session_count, 10) || 1) > 1 ||
    norm(session.session_type).includes('package');
}

function packageCount(session, pkg) {
  return Math.max(
    1,
    parseInt(session.session_count || pkg?.session_count, 10) ||
      parseInt(String(pkg?.package_type || '').match(/\d+/)?.[0], 10) ||
      3
  );
}

function packageKey(session, pkg) {
  const count = packageCount(session, pkg);
  if (isCoupleLike(session, pkg)) return `couple_package_${count}`;
  return `package_${count}`;
}

function getPackageTotalPrice(session, pkg, groupSessions) {
  const count = packageCount(session, pkg);
  const pkgPrice = Number(pkg?.price || 0);
  if (pkgPrice > 0) return pkgPrice;

  const groupPaidPrice = Math.max(
    0,
    ...(groupSessions || []).map((s) => Number(s.price || s.amount || 0)).filter((v) => v > 0)
  );
  if (groupPaidPrice > 0) return groupPaidPrice;

  const ownPrice = Number(session.price || session.amount || 0);
  if (ownPrice > 0) return ownPrice;

  const cfg = session.__commissionConfig || {};
  const companyTotal = Number(cfg.commission_amounts?.[packageKey(session, pkg)] || 0);
  const doctorTotal = getPackageDoctorTotal(session, pkg, cfg);
  return (doctorTotal + companyTotal) || count;
}

function getPackageDoctorTotal(session, pkg, cfg) {
  const key = packageKey(session, pkg);
  const count = packageCount(session, pkg);
  const packages = cfg?.doctor_commission_packages || {};
  return Number(
    packages[`${key}_first_session`] ??
    packages[`${key}_followup`] ??
    packages[`package_${count}_first_session`] ??
    packages[`package_${count}_followup`] ??
    cfg?.doctor_commission_first_session_package ??
    cfg?.doctor_commission_followup_package ??
    0
  );
}

function getPackageCompanyTotal(session, pkg, cfg) {
  const key = packageKey(session, pkg);
  const count = packageCount(session, pkg);
  const amounts = cfg?.commission_amounts || {};
  return Number(
    amounts[key] ??
    amounts[`package_${count}`] ??
    cfg?.commission_amount_package ??
    0
  );
}

function clientFirstSessionMap(sessions) {
  const byClient = new Map();
  for (const session of sessions) {
    if (!session.client_id) continue;
    const list = byClient.get(session.client_id) || [];
    list.push(session);
    byClient.set(session.client_id, list);
  }

  const firstIds = new Set();
  for (const list of byClient.values()) {
    list.sort((a, b) => {
      const aTime = new Date(a.created_at || `${a.scheduled_date || ''}T${a.scheduled_time || '00:00'}`).getTime();
      const bTime = new Date(b.created_at || `${b.scheduled_date || ''}T${b.scheduled_time || '00:00'}`).getTime();
      return aTime - bTime;
    });
    if (list[0]?.id) firstIds.add(list[0].id);
  }
  return firstIds;
}

async function fetchClientHistory(clientIds) {
  if (!clientIds.length) return [];

  const pageSize = 1000;
  const rows = [];

  for (let i = 0; i < clientIds.length; i += 100) {
    const chunk = clientIds.slice(i, i + 100);
    let from = 0;

    while (true) {
      const { data, error } = await supabaseAdmin
        .from('sessions')
        .select('id, client_id, created_at, scheduled_date, scheduled_time, status')
        .in('client_id', chunk)
        .in('status', ['booked', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'])
        .range(from, from + pageSize - 1);

      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }

  return rows;
}

async function fetchExistingCommissionHistory(sessionIds) {
  const rows = [];
  for (let i = 0; i < sessionIds.length; i += 100) {
    const chunk = sessionIds.slice(i, i + 100);
    const { data, error } = await supabaseAdmin
      .from('commission_history')
      .select('id, session_id, session_amount, commission_amount, payment_status, notes, created_at, updated_at')
      .in('session_id', chunk);

    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

function chooseCommissionKeeper(rows) {
  return [...rows].sort((a, b) => {
    const aPaid = String(a.payment_status || '').toLowerCase() === 'paid' ? 1 : 0;
    const bPaid = String(b.payment_status || '').toLowerCase() === 'paid' ? 1 : 0;
    if (aPaid !== bPaid) return bPaid - aPaid;

    const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
    const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
    return bTime - aTime;
  })[0];
}

function calculateSplit(session, pkg, cfg, groupSessions, firstSessionIds) {
  const isPackage = isPackageLike(session);
  const isCouple = isCoupleLike(session, pkg);

  if (isPackage) {
    const count = packageCount(session, pkg);
    const totalPrice = getPackageTotalPrice(session, pkg, groupSessions);
    const doctorTotal = getPackageDoctorTotal(session, pkg, cfg);
    const companyTotal = getPackageCompanyTotal(session, pkg, cfg);
    const sessionAmount = money(totalPrice / count);
    const doctorWallet = money(doctorTotal / count);
    const companyCommission = money(companyTotal > 0 ? companyTotal / count : sessionAmount - doctorWallet);
    return { sessionAmount, doctorWallet, companyCommission };
  }

  const amount = money(Number(session.price || session.amount || 0));
  const packages = cfg?.doctor_commission_packages || {};
  let doctorWallet;

  if (isCouple) {
    doctorWallet = Number(packages.couple_session ?? packages.cpl_session ?? 0);
  } else if (firstSessionIds.has(session.id)) {
    doctorWallet = Number(cfg?.doctor_commission_first_session ?? cfg?.doctor_commission_individual ?? 0);
  } else {
    doctorWallet = Number(cfg?.doctor_commission_followup ?? cfg?.doctor_commission_individual ?? cfg?.doctor_commission_first_session ?? 0);
  }

  doctorWallet = money(doctorWallet);
  const companyCommission = money(Math.max(0, amount - doctorWallet));
  return { sessionAmount: amount, doctorWallet, companyCommission };
}

async function fetchAllSessions() {
  const pageSize = 1000;
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select(`
        id, psychologist_id, client_id, session_type, session_count, package_id,
        package_group_id, package_session_number, scheduled_date, scheduled_time,
        completion_date, status, price, amount, payment_id, therapist_commission,
        created_at
      `)
      .gte('scheduled_date', START_DATE)
      .in('status', COMPLETED_STATUSES)
      .range(from, from + pageSize - 1)
      .order('scheduled_date', { ascending: true });

    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

async function main() {
  const sessions = await fetchAllSessions();
  const psychIds = [...new Set(sessions.map((s) => s.psychologist_id).filter(Boolean))];
  const packageIds = [...new Set(sessions.map((s) => s.package_id).filter(Boolean))];
  const sessionIds = sessions.map((s) => s.id);

  const [{ data: psychologists, error: psychError }, { data: configs, error: configError }] = await Promise.all([
    supabaseAdmin.from('psychologists').select('id, first_name, last_name, email').in('id', psychIds),
    supabaseAdmin
      .from('doctor_commissions')
      .select('*')
      .eq('is_active', true)
      .in('psychologist_id', psychIds)
  ]);
  if (psychError) throw psychError;
  if (configError) throw configError;

  const packages = packageIds.length
    ? (await supabaseAdmin.from('packages').select('id, name, package_type, session_count, price').in('id', packageIds)).data || []
    : [];

  const existing = sessionIds.length ? await fetchExistingCommissionHistory(sessionIds) : [];

  const psychById = new Map((psychologists || []).map((p) => [p.id, p]));
  const configByPsych = new Map((configs || []).map((c) => [c.psychologist_id, c]));
  const packageById = new Map((packages || []).map((p) => [p.id, p]));
  const existingGroups = new Map();
  for (const row of existing || []) {
    const list = existingGroups.get(row.session_id) || [];
    list.push(row);
    existingGroups.set(row.session_id, list);
  }

  const duplicateLosers = [];
  const existingBySession = new Map();
  for (const [sessionId, rows] of existingGroups.entries()) {
    const keeper = chooseCommissionKeeper(rows);
    existingBySession.set(sessionId, keeper);
    duplicateLosers.push(...rows.filter((row) => row.id !== keeper.id));
  }
  const groupMap = new Map();
  for (const session of sessions) {
    const groupKey = session.package_group_id || session.package_id;
    if (!groupKey) continue;
    const list = groupMap.get(groupKey) || [];
    list.push(session);
    groupMap.set(groupKey, list);
  }

  const clientIds = [...new Set(sessions.map((s) => s.client_id).filter(Boolean))];
  const clientHistory = await fetchClientHistory(clientIds);
  const firstSessionIds = clientFirstSessionMap(clientHistory);
  const summary = {
    startDate: START_DATE,
    completedSessionsFound: sessions.length,
    updatedCommissionHistory: 0,
    insertedCommissionHistory: 0,
    skippedManualEdits: 0,
    updatedSessionDoctorWallet: 0,
    verifiedOnly: DRY_RUN,
    mismatches: [],
    duplicateCommissionRowsFound: duplicateLosers.length,
    duplicateCommissionRowsDeleted: 0,
    skippedExcluded: 0,
    skippedMissingConfig: 0,
    skippedNoPsychologist: 0,
    byTherapist: {}
  };

  if (!DRY_RUN && duplicateLosers.length > 0) {
    for (let i = 0; i < duplicateLosers.length; i += 100) {
      const ids = duplicateLosers.slice(i, i + 100).map((row) => row.id);
      const { error } = await supabaseAdmin
        .from('commission_history')
        .delete()
        .in('id', ids);
      if (error) throw error;
      summary.duplicateCommissionRowsDeleted += ids.length;
    }
  }

  for (const session of sessions) {
    const psychologist = psychById.get(session.psychologist_id);
    if (!psychologist) {
      summary.skippedNoPsychologist += 1;
      continue;
    }

    const therapistName = `${psychologist.first_name || ''} ${psychologist.last_name || ''}`.trim();
    if (isExcludedPsychologist(psychologist)) {
      summary.skippedExcluded += 1;
      continue;
    }

    const cfg = configByPsych.get(session.psychologist_id);
    if (!cfg) {
      summary.skippedMissingConfig += 1;
      continue;
    }

    const existingCommission = existingBySession.get(session.id);
    session.__commissionConfig = cfg;
    const pkg = packageById.get(session.package_id);
    const groupSessions = groupMap.get(session.package_group_id || session.package_id) || [session];
    const split = calculateSplit(session, pkg, cfg, groupSessions, firstSessionIds);

    const commissionPayload = {
      psychologist_id: session.psychologist_id,
      session_id: session.id,
      session_amount: split.sessionAmount,
      commission_amount: split.companyCommission,
      payment_status: existingCommission?.payment_status || 'pending',
      updated_at: new Date().toISOString()
    };

    if (DRY_RUN) {
      const existingSessionAmount = money(Number(existingCommission?.session_amount || 0));
      const existingCompanyCommission = money(Number(existingCommission?.commission_amount || 0));
      const existingDoctorWallet = money(Number(session.therapist_commission || 0));
      const mismatch = !existingCommission ||
        existingSessionAmount !== split.sessionAmount ||
        existingCompanyCommission !== split.companyCommission ||
        existingDoctorWallet !== split.doctorWallet;

      if (mismatch) {
        summary.mismatches.push({
          session_id: session.id,
          therapist: therapistName,
          expected: split,
          actual: {
            sessionAmount: existingCommission ? existingSessionAmount : null,
            companyCommission: existingCommission ? existingCompanyCommission : null,
            doctorWallet: existingDoctorWallet
          }
        });
      }
    } else if (existingCommission) {
      // NEVER overwrite a hand-edited row. Finance corrections made in the payout UI are
      // tagged MANUAL_COMMISSION_EDIT; recomputing them from config silently reverted the
      // edit, which is why saved values reappeared as the old numbers after a refresh.
      if (String(existingCommission.notes || '').includes('MANUAL_COMMISSION_EDIT')) {
        summary.skippedManualEdits = (summary.skippedManualEdits || 0) + 1;
      } else {
        const { error } = await supabaseAdmin
          .from('commission_history')
          .update(commissionPayload)
          .eq('id', existingCommission.id);
        if (error) throw error;
        summary.updatedCommissionHistory += 1;
      }
    } else {
      const { error } = await supabaseAdmin
        .from('commission_history')
        .insert({ ...commissionPayload, created_at: new Date().toISOString() });
      if (error) throw error;
      summary.insertedCommissionHistory += 1;
    }

    if (!DRY_RUN) {
      const { error: sessionUpdateError } = await supabaseAdmin
        .from('sessions')
        .update({
          therapist_commission: split.doctorWallet,
          updated_at: new Date().toISOString()
        })
        .eq('id', session.id);
      if (sessionUpdateError) throw sessionUpdateError;
      summary.updatedSessionDoctorWallet += 1;
    }

    if (!summary.byTherapist[therapistName]) {
      summary.byTherapist[therapistName] = {
        sessions: 0,
        doctorWallet: 0,
        companyCommission: 0,
        gross: 0
      };
    }
    summary.byTherapist[therapistName].sessions += 1;
    summary.byTherapist[therapistName].doctorWallet = money(summary.byTherapist[therapistName].doctorWallet + split.doctorWallet);
    summary.byTherapist[therapistName].companyCommission = money(summary.byTherapist[therapistName].companyCommission + split.companyCommission);
    summary.byTherapist[therapistName].gross = money(summary.byTherapist[therapistName].gross + split.sessionAmount);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
