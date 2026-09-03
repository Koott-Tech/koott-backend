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
      const { data: meta } = await sheets.spreadsheets.get({
        spreadsheetId: l.spreadsheet_id, fields: 'sheets(properties(sheetId,title))',
      });
      for (const sh of meta.sheets) {
        const tab = sh.properties.title;
        const { data: head } = await sheets.spreadsheets.values.get({
          spreadsheetId: l.spreadsheet_id, range: `'${tab}'!A1:AB2`,
        });
        const hdr = (head.values || [])[0] || [];
        const totalRow = (head.values || [])[1] || [];
        if (hdr.length === svc.COLUMNS.length && totalRow[0] === 'TOTAL') { already++; continue; }

        await sheets.spreadsheets.values.update({
          spreadsheetId: l.spreadsheet_id, range: `'${tab}'!A1`,
          valueInputOption: 'RAW', requestBody: { values: [svc.COLUMNS] },
        });
        await sleep(PAUSE_MS);
        await svc.writeTotalsRow(l.spreadsheet_id, tab);
        await sleep(PAUSE_MS);
        await sheets.spreadsheets.batchUpdate({
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
        });
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
