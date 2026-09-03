#!/usr/bin/env node
/**
 * Backfill one therapist's completed sessions into their Google Sheet, month by month.
 *
 * Usage: node scripts/backfill-therapist-sheet.js "<name fragment>" [fromYmd] [toYmd]
 *
 * Writes a whole month in ONE values.update rather than a call per row: the Sheets API allows
 * roughly 60 writes/minute per user, so 123 individual appends would take minutes and risk a
 * 429. Re-running is safe — rows are matched on session id and overwritten in place.
 */
require('dotenv').config();
const { supabaseAdmin: db } = require('../config/supabase');
const { google } = require('googleapis');
const { computeSessionDoctorWallet } = require('../utils/sessionCommission');
const svc = require('../services/sessionSheetSyncService');

const [, , nameFrag, fromYmd = '2026-08-01', toYmd = '2026-12-31'] = process.argv;
if (!nameFrag) { console.error('give a therapist name fragment'); process.exit(1); }

function gclients() {
  const o = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:5001/api/oauth2/callback');
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return { sheets: google.sheets({ version: 'v4', auth: o }) };
}

(async () => {
  // Accept an id OR a name fragment. Three therapists share the first name "Aswathy", so the
  // bulk runner passes ids — a name match would refuse them all as ambiguous.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameFrag);
  const q = db.from('psychologists').select('id, first_name, last_name');
  const { data: ps } = isUuid ? await q.eq('id', nameFrag) : await q.ilike('first_name', `%${nameFrag}%`);
  if (!ps?.length) { console.error('no therapist matched'); process.exit(1); }
  if (ps.length > 1) {
    console.error('ambiguous:', ps.map(x => `${x.first_name} ${x.last_name || ''}`.trim()).join(' | '));
    process.exit(1);
  }
  const p = ps[0];
  const name = `${p.first_name || ''} ${p.last_name || ''}`.trim().replace(/\s+/g, ' ');

  const { data: sessions } = await db.from('sessions').select('*')
    .eq('psychologist_id', p.id).eq('status', 'completed')
    .gte('scheduled_date', fromYmd).lte('scheduled_date', toYmd)
    .order('scheduled_date');
  console.log(`\n${name}: ${sessions.length} completed sessions ${fromYmd} .. ${toYmd}`);
  if (!sessions.length) return;

  // Resolve clients + emails once, not per row.
  const cids = [...new Set(sessions.map(s => s.client_id).filter(Boolean))];
  const cmap = {}, emap = {};
  for (let i = 0; i < cids.length; i += 100) {
    const { data } = await db.from('clients')
      .select('id,first_name,last_name,user_id,sex,age,age_group,location,partner_sex,partner_age_group,partner_location')
      .in('id', cids.slice(i, i + 100));
    (data || []).forEach(c => { cmap[c.id] = c; });
  }
  const uids = [...new Set(Object.values(cmap).map(c => c.user_id).filter(Boolean))];
  for (let i = 0; i < uids.length; i += 100) {
    const { data } = await db.from('users').select('id,email').in('id', uids.slice(i, i + 100));
    (data || []).forEach(u => { emap[u.id] = u.email; });
  }
  const { data: cfg } = await db.from('doctor_commissions')
    .select('*').eq('psychologist_id', p.id).eq('is_active', true).maybeSingle();
  const chmap = {};
  for (let i = 0; i < sessions.length; i += 100) {
    const { data } = await db.from('commission_history').select('*')
      .in('session_id', sessions.slice(i, i + 100).map(s => s.id));
    (data || []).forEach(h => { chmap[h.session_id] = h; });
  }

  const spreadsheetId = await svc.ensureSpreadsheet(p.id, name);
  console.log(`spreadsheet ${spreadsheetId}`);

  const byMonth = {};
  sessions.forEach(s => {
    const tab = svc.monthTabFor(s.completion_date || s.scheduled_date);
    (byMonth[tab] = byMonth[tab] || []).push(s);
  });

  const { sheets } = gclients();
  for (const tab of Object.keys(byMonth).sort()) {
    const rows = byMonth[tab].map(s => {
      const c = cmap[s.client_id];
      const payout = computeSessionDoctorWallet(s, cfg, chmap[s.id] || null, { isFirstSession: undefined });
      return svc.buildRow(s, c, c ? emap[c.user_id] : null, payout);
    });
    await svc.ensureMonthTab(spreadsheetId, tab);
    // Layout changed: row 1 headers, row 2 TOTAL, data from row 3. Sheets written under the
    // old layout have a data row sitting where TOTAL now goes, so clear the body before
    // rewriting rather than leaving a stray row behind.
    // Rewrite the header every run. ensureMonthTab only writes it when it CREATES a tab, so
    // tabs made before the Company column was added kept a 27-wide header over 28-wide rows.
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${tab}'!A1`, valueInputOption: 'RAW',
      requestBody: { values: [svc.COLUMNS] },
    });
    await sheets.spreadsheets.values.clear({
      spreadsheetId, range: `'${tab}'!A${svc.FIRST_DATA_ROW - 1}:AB`,
    });
    await svc.writeTotalsRow(spreadsheetId, tab);
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${tab}'!A${svc.FIRST_DATA_ROW}`, valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
    console.log(`  ${tab}: ${rows.length} rows written`);
    const ids = byMonth[tab].map(s => s.id);
    for (let i = 0; i < ids.length; i += 100) {
      await db.from('sessions').update({ sheet_synced_at: new Date().toISOString() })
        .in('id', ids.slice(i, i + 100));
    }
  }
  console.log(`\nhttps://docs.google.com/spreadsheets/d/${spreadsheetId}\n`);
})().catch(e => { console.error('FAILED:', e?.response?.data?.error?.message || e.message); process.exit(1); });
