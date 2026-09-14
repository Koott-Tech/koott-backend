#!/usr/bin/env node
/**
 * Rewrite the header + TOTAL row on EVERY tab of every therapist sheet.
 *
 * The creation script gave every therapist a tab for the then-current month. Therapists with
 * no sessions that month never had it rewritten, so those tabs kept the pre-Company 27-column
 * header and no totals row. This brings them all to the same shape.
 *
 * Throttled: Sheets allows ~60 writes/minute per user, and the unthrottled bulk run tripped it.
 */
require('dotenv').config();
const { google } = require('googleapis');
const { supabaseAdmin: db } = require('../config/supabase');
const svc = require('../services/sessionSheetSyncService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = Number(process.env.SHEET_REPAIR_PAUSE_MS || 1300); // ~46 writes/min, safely under

// A1-style letter for a 1-based column number (1 -> A, 28 -> AB, 29 -> AC).
const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
// The header check must read as many columns as COLUMNS has. It was hard-coded to AB (28), so
// once a 29th column was added the length comparison could never pass and every tab was
// rewritten on every run — harmless to the data, but a wasted write against the rate limit.
const LAST_COL = colLetter(svc.COLUMNS.length);

// Sheets allows 60 reads and 60 writes a minute per user, shared with every other job on the
// account. Without a retry, one quota error skipped that therapist's whole sheet and the run
// carried on as if nothing happened — three sheets were missed that way when a verification
// ran at the same time. Back off and retry quota errors instead.
async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const msg = e?.response?.data?.error?.message || e.message || '';
      const quota = /quota|rate limit/i.test(msg) || e?.code === 429 || e?.response?.status === 429;
      if (!quota || attempt >= 6) throw e;
      const wait = 15000 * attempt;
      console.log(`  quota hit on ${label}, waiting ${wait / 1000}s (attempt ${attempt})`);
      await sleep(wait);
    }
  }
}

(async () => {
  const o = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:5001/api/oauth2/callback');
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const sheets = google.sheets({ version: 'v4', auth: o });

  const { data: links } = await db.from('therapist_sheets').select('psychologist_id, spreadsheet_id');
  let fixed = 0, already = 0, failed = 0;

  for (const l of links) {
    const { data: p } = await db.from('psychologists')
      .select('first_name,last_name').eq('id', l.psychologist_id).maybeSingle();
    const name = `${p?.first_name || ''} ${p?.last_name || ''}`.trim();
    try {
      const { data: meta } = await withRetry(() => sheets.spreadsheets.get({
        spreadsheetId: l.spreadsheet_id, fields: 'sheets(properties(sheetId,title))',
      }), `${name} tabs`);
      for (const sh of meta.sheets) {
        const tab = sh.properties.title;
        const { data: head } = await withRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: l.spreadsheet_id, range: `'${tab}'!A1:${LAST_COL}2`,
        }), `${name} / ${tab} header`);
        const hdr = (head.values || [])[0] || [];
        const totalRow = (head.values || [])[1] || [];
        if (hdr.length === svc.COLUMNS.length && totalRow[0] === 'TOTAL') { already++; continue; }

        await withRetry(() => sheets.spreadsheets.values.update({
          spreadsheetId: l.spreadsheet_id, range: `'${tab}'!A1`,
          valueInputOption: 'RAW', requestBody: { values: [svc.COLUMNS] },
        }), `${name} / ${tab} write header`);
        await sleep(PAUSE_MS);
        await withRetry(() => svc.writeTotalsRow(l.spreadsheet_id, tab), `${name} / ${tab} totals`);
        await sleep(PAUSE_MS);
        await withRetry(() => sheets.spreadsheets.batchUpdate({
          spreadsheetId: l.spreadsheet_id,
          requestBody: { requests: [
            { updateSheetProperties: {
                properties: { sheetId: sh.properties.sheetId, gridProperties: { frozenRowCount: 2 } },
                fields: 'gridProperties.frozenRowCount' } },
            { repeatCell: {
                range: { sheetId: sh.properties.sheetId, startRowIndex: 0, endRowIndex: 2 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: 'userEnteredFormat.textFormat.bold' } },
          ] },
        }), `${name} / ${tab} format`);
        await sleep(PAUSE_MS);
        fixed++;
        console.log(`  fixed   ${name} / ${tab}`);
      }
    } catch (e) {
      failed++;
      console.log(`  FAILED  ${name}: ${(e?.response?.data?.error?.message || e.message).slice(0, 70)}`);
    }
  }
  console.log(`\n${fixed} tabs repaired, ${already} already correct, ${failed} sheets failed`);
})().catch(e => { console.error(e.message); process.exit(1); });
