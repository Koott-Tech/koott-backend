/**
 * Mirrors completed sessions into per-therapist Google Sheets.
 *
 * Layout: one spreadsheet per therapist inside a master Drive folder, one TAB per month.
 * Everything is created on demand — the first completion of a month makes that month's tab,
 * the first completion by a new therapist makes their spreadsheet. Nobody touches Drive.
 *
 * Rows are keyed on session id in column A, so re-completing or editing a session UPDATES its
 * row instead of appending a second one. Sessions here get edited often enough that append-only
 * would have produced duplicates within days.
 */
const { google } = require('googleapis');
const { supabaseAdmin } = require('../config/supabase');
const { computeSessionDoctorWallet } = require('../utils/sessionCommission');

const MASTER_FOLDER = process.env.GSHEET_MASTER_FOLDER_NAME || 'Koott Session Records';

// Column ORDER IS THE CONTRACT — the writer addresses cells by index. New columns go on the
// END, never in the middle, or every existing sheet shifts out of alignment.
const COLUMNS = [
  'Session ID', 'Date', 'Time', 'Client', 'Client Email',
  'Age Group', 'Gender', 'Location',
  'Partner Age Group', 'Partner Gender', 'Partner Location',
  'Session Type', 'Client Status',
  'Main Concern', 'Concern Duration', 'Why Now', 'Awareness',
  'Tried Therapy Before', 'Hesitation', 'Opening Statement',
  'Summary to Client', 'Note to Therapist', 'To Operation',
  'Status', 'Completion Date', 'Price', 'Therapist Payout', 'Company',
  // Appended, never inserted — the writer addresses cells by index, so a new column in the
  // middle would shift every existing sheet out of alignment.
  'Therapist: First/Follow-up',
];

// Row 1 = headers, row 2 = live totals, data from row 3. The totals are SUM formulas rather
// than numbers we recompute, so they stay correct when a row is appended or edited without
// the writer having to touch them.
const HEADER_ROW = 1;
const TOTALS_ROW = 2;
const FIRST_DATA_ROW = 3;
const TOTAL_COLUMNS = { price: 'Z', payout: 'AA', company: 'AB' };

const monthTabFor = (ymd) => String(ymd || '').slice(0, 7);
const esc = (s) => String(s).replace(/'/g, "\\'");

let clients = null;
function google_() {
  if (clients) return clients;
  const o = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI
  );
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  clients = { drive: google.drive({ version: 'v3', auth: o }), sheets: google.sheets({ version: 'v4', auth: o }) };
  return clients;
}

async function ensureFolder() {
  const { drive } = google_();
  const { data } = await drive.files.list({
    q: `name='${esc(MASTER_FOLDER)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });
  if (data.files.length) return data.files[0].id;
  const { data: made } = await drive.files.create({
    requestBody: { name: MASTER_FOLDER, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return made.id;
}

/** Spreadsheet id for a therapist, cached in therapist_sheets so we never search Drive twice. */
async function ensureSpreadsheet(psychologistId, therapistName) {
  const { drive, sheets } = google_();
  const { data: row } = await supabaseAdmin
    .from('therapist_sheets').select('spreadsheet_id').eq('psychologist_id', psychologistId).maybeSingle();
  if (row?.spreadsheet_id) return row.spreadsheet_id;

  const title = `${therapistName} — Sessions`;
  const { data: found } = await drive.files.list({
    q: `name='${esc(title)}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id)',
  });

  let id = found.files[0]?.id;
  if (!id) {
    const folderId = await ensureFolder();
    const { data: made } = await sheets.spreadsheets.create({
      requestBody: { properties: { title } }, fields: 'spreadsheetId',
    });
    id = made.spreadsheetId;
    const { data: meta } = await drive.files.get({ fileId: id, fields: 'parents' });
    await drive.files.update({
      fileId: id, addParents: folderId,
      removeParents: (meta.parents || []).join(','), fields: 'id',
    });
  }
  await supabaseAdmin.from('therapist_sheets')
    .upsert({ psychologist_id: psychologistId, spreadsheet_id: id }, { onConflict: 'psychologist_id' });
  return id;
}

/** Month tab, with a frozen bold header. Returns nothing — callers only need it to exist. */
async function ensureMonthTab(spreadsheetId, tab) {
  const { sheets } = google_();
  const { data: meta } = await sheets.spreadsheets.get({
    spreadsheetId, fields: 'sheets(properties(sheetId,title))',
  });
  const existing = meta.sheets.find((s) => s.properties.title === tab);
  if (existing) return;

  // A spreadsheet created with a named tab does NOT get sheetId 0 — read the id back rather
  // than assuming, or the formatting call fails with "No sheet with id: 0".
  const { data: added } = await sheets.spreadsheets.batchUpdate({
    spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
  });
  const sheetId = added.replies[0].addSheet.properties.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${tab}'!A${HEADER_ROW}`, valueInputOption: 'RAW',
    requestBody: { values: [COLUMNS] },
  });
  await writeTotalsRow(spreadsheetId, tab);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: TOTALS_ROW } },
        fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: TOTALS_ROW },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold' } },
    ] },
  });
}

/** TOTAL row directly under the header. Open-ended ranges so appends are counted automatically. */
async function writeTotalsRow(spreadsheetId, tab) {
  const { sheets } = google_();
  const row = new Array(COLUMNS.length).fill('');
  row[0] = 'TOTAL';
  const { price, payout, company } = TOTAL_COLUMNS;
  row[25] = `=SUM(${price}${FIRST_DATA_ROW}:${price})`;
  row[26] = `=SUM(${payout}${FIRST_DATA_ROW}:${payout})`;
  row[27] = `=SUM(${company}${FIRST_DATA_ROW}:${company})`;
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${tab}'!A${TOTALS_ROW}`,
    valueInputOption: 'USER_ENTERED',   // RAW would store the formula as literal text
    requestBody: { values: [row] },
  });
}

/**
 * The completion popup concatenates extra blocks onto `report` before saving:
 *
 *   <therapist note>\n\n--- Message to Operations ---\n...\n\n--- Client Opening Statement ---\n...
 *
 * The sheet already has its own To Operation and Opening Statement columns, so keeping the
 * appended copy would duplicate them — and 399 of 400 reports are nothing BUT those blocks,
 * which made the note column read as boilerplate. Keep only what the therapist actually typed.
 */
function therapistNoteOnly(report) {
  const text = String(report || '');
  const cut = text.search(/\n*---\s/);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * Pull one appended block back out of `report`.
 *
 * Sessions completed before the dedicated columns existed have their operations message and
 * opening statement ONLY inside report. Simply stripping them would have emptied both sheet
 * columns and lost the text altogether, so read them back when the real column is null.
 */
function sectionFromReport(report, heading) {
  const text = String(report || '');
  const re = new RegExp(`---\\s*${heading}\\s*---\\n?([\\s\\S]*?)(?=\\n*---\\s|$)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function buildRow(session, client, email, payout) {
  const c = client || {};
  return [
    session.id,
    session.scheduled_date || '',
    String(session.scheduled_time || '').slice(0, 5),
    `${c.first_name || ''} ${c.last_name || ''}`.trim(),
    email || '',
    c.age_group || (c.age ? String(c.age) : ''),
    c.sex || '',
    c.location || '',
    c.partner_age_group || '',
    c.partner_sex || '',
    c.partner_location || '',
    session.session_type || '',
    session.client_status || '',
    session.condition || '',
    session.concern_duration || '',
    session.therapy_trigger || '',
    session.therapy_awareness || '',
    session.tried_therapy_before || '',
    session.therapy_hesitation || '',
    session.client_opening_statement || sectionFromReport(session.report, 'Client Opening Statement'),
    session.summary || '',
    therapistNoteOnly(session.report),
    session.to_operation || sectionFromReport(session.report, 'Message to Operations'),
    session.status || '',
    session.completion_date || '',
    session.price ?? '',
    payout ?? '',
    // What Koott keeps. Derived here rather than left to a sheet formula so the number
    // survives someone editing the payout cell by hand.
    (session.price === null || session.price === undefined)
      ? ''
      : Math.round((Number(session.price) - Number(payout || 0)) * 100) / 100,
    // The therapist's own answer, mirrored purely as a record. The Therapist Payout column
    // above is priced off the system's own first/follow-up derivation, not this — the two
    // can legitimately disagree, and that disagreement is exactly what this is here to show.
    session.therapist_session_sequence === 'first' ? 'First'
      : session.therapist_session_sequence === 'followup' ? 'Follow-up'
      : '',
  ];
}

/** Append, or overwrite in place when this session already has a row. */
async function upsertRow(spreadsheetId, tab, row) {
  const { sheets } = google_();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${tab}'!A:A`,
  });
  const ids = (data.values || []).map((r) => r[0]);
  const at = ids.indexOf(row[0]);            // column A holds the session id
  if (at >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${tab}'!A${at + 1}`, valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    return 'updated';
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `'${tab}'!A${FIRST_DATA_ROW}`, valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] },
  });
  return 'appended';
}

/**
 * Mirror one session. NEVER throws — a Google outage must not fail a completion, and the
 * nightly sweep picks up whatever this missed.
 */
async function syncSessionToSheet(sessionId) {
  try {
    if (!process.env.GOOGLE_REFRESH_TOKEN) return { ok: false, reason: 'no google token' };

    const { data: s } = await supabaseAdmin.from('sessions').select('*').eq('id', sessionId).maybeSingle();
    if (!s || !s.psychologist_id) return { ok: false, reason: 'session not found' };

    const { data: p } = await supabaseAdmin.from('psychologists')
      .select('id, first_name, last_name').eq('id', s.psychologist_id).maybeSingle();
    if (!p) return { ok: false, reason: 'therapist not found' };

    const { data: c } = s.client_id
      ? await supabaseAdmin.from('clients')
          .select('first_name,last_name,user_id,sex,age,age_group,location,partner_sex,partner_age_group,partner_location')
          .eq('id', s.client_id).maybeSingle()
      : { data: null };
    let email = null;
    if (c?.user_id) {
      const { data: u } = await supabaseAdmin.from('users').select('email').eq('id', c.user_id).maybeSingle();
      email = u?.email || null;
    }

    const { data: cfg } = await supabaseAdmin.from('doctor_commissions')
      .select('*').eq('psychologist_id', s.psychologist_id).eq('is_active', true).maybeSingle();
    const { data: ch } = await supabaseAdmin.from('commission_history')
      .select('*').eq('session_id', s.id).maybeSingle();
    const payout = computeSessionDoctorWallet(s, cfg, ch, { isFirstSession: undefined });

    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim().replace(/\s+/g, ' ');
    const tab = monthTabFor(s.completion_date || s.scheduled_date);
    if (!tab) return { ok: false, reason: 'no date' };

    const spreadsheetId = await ensureSpreadsheet(p.id, name);
    await ensureMonthTab(spreadsheetId, tab);
    const action = await upsertRow(spreadsheetId, tab, buildRow(s, c, email, payout));

    await supabaseAdmin.from('sessions')
      .update({ sheet_synced_at: new Date().toISOString() }).eq('id', s.id);

    return { ok: true, action, tab, spreadsheetId };
  } catch (err) {
    console.error('[sheetSync] failed for', sessionId, err?.message || err);
    return { ok: false, reason: err?.message || String(err) };
  }
}

module.exports = { syncSessionToSheet, ensureSpreadsheet, ensureMonthTab, upsertRow, buildRow, writeTotalsRow, therapistNoteOnly, sectionFromReport, COLUMNS, monthTabFor, FIRST_DATA_ROW };
