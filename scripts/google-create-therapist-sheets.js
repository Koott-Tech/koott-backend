#!/usr/bin/env node
/**
 * Creates the master Drive folder and one spreadsheet per therapist, each with a header row.
 *
 * Idempotent: re-running finds what already exists by name instead of creating duplicates,
 * so it is safe to run again when a new therapist joins.
 *
 * Usage:  node scripts/google-create-therapist-sheets.js [--dry]
 */
require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');
const { supabaseAdmin: db } = require('../config/supabase');

const MASTER_FOLDER = 'Koott Session Records';
const DRY = process.argv.includes('--dry');
const MAP_FILE = `${__dirname}/../.therapist-sheets.json`;

// One row per completed session. Order matters — the sync writes by index, so new columns go
// on the END, never in the middle, or every existing sheet shifts out of alignment.
const COLUMNS = [
  'Session ID', 'Date', 'Time', 'Client', 'Client Email',
  'Age Group', 'Gender', 'Location',
  'Partner Age Group', 'Partner Gender', 'Partner Location',
  'Session Type', 'Client Status',
  'Main Concern', 'Concern Duration', 'Why Now', 'Awareness',
  'Tried Therapy Before', 'Hesitation', 'Opening Statement',
  'Summary to Client', 'Note to Therapist', 'To Operation',
  'Status', 'Completion Date', 'Price', 'Therapist Payout',
  'Therapist: First/Follow-up',
];

const monthTab = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const esc = (s) => String(s).replace(/'/g, "\\'");

async function auth() {
  const o = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:5001/api/oauth2/callback'
  );
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  await o.getAccessToken();
  return o;
}

async function findOrCreateFolder(drive, name) {
  const { data } = await drive.files.list({
    q: `name='${esc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
  });
  if (data.files.length) return { id: data.files[0].id, created: false };
  if (DRY) return { id: '(dry-run)', created: true };
  const { data: made } = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return { id: made.id, created: true };
}

// Header formatting + placement, applied to a spreadsheet whether we just made it or found an
// existing one. Kept separate so a re-run repairs files that were half-built by an earlier
// failure rather than skipping them.
async function ensureSheetSetup(drive, sheets, id, tab) {
  const { data: meta } = await sheets.spreadsheets.get({
    spreadsheetId: id,
    fields: 'sheets(properties(sheetId,title))',
  });
  let sheet = meta.sheets.find((s) => s.properties.title === tab);
  if (!sheet) {
    const { data: added } = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    sheet = { properties: added.replies[0].addSheet.properties };
  }
  // A new spreadsheet's first tab is NOT sheetId 0 when it was created with a title, which is
  // what broke the first run — read the real id rather than assuming.
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `'${tab}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [COLUMNS] },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [
        { updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount' } },
        { repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold' } },
      ],
    },
  });
}

async function ensureInFolder(drive, id, folderId) {
  const { data } = await drive.files.get({ fileId: id, fields: 'parents' });
  if ((data.parents || []).includes(folderId)) return;
  await drive.files.update({
    fileId: id,
    addParents: folderId,
    removeParents: (data.parents || []).join(','),
    fields: 'id,parents',
  });
}

async function findOrCreateSheet(drive, sheets, name, folderId) {
  const tab = monthTab();
  const { data } = await drive.files.list({
    q: `name='${esc(name)}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id,name)',
  });

  if (data.files.length) {
    const id = data.files[0].id;
    if (!DRY) {
      await ensureSheetSetup(drive, sheets, id, tab);
      await ensureInFolder(drive, id, folderId);
    }
    return { id, created: false };
  }
  if (DRY) return { id: '(dry-run)', created: true };

  const { data: made } = await sheets.spreadsheets.create({
    requestBody: { properties: { title: name }, sheets: [{ properties: { title: tab } }] },
    fields: 'spreadsheetId',
  });
  const id = made.spreadsheetId;
  await ensureSheetSetup(drive, sheets, id, tab);
  await ensureInFolder(drive, id, folderId);
  return { id, created: true };
}

(async () => {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.error('\n  GOOGLE_REFRESH_TOKEN is not set locally. Add it to .env first.\n');
    process.exit(1);
  }
  const o = await auth();
  const drive = google.drive({ version: 'v3', auth: o });
  const sheets = google.sheets({ version: 'v4', auth: o });

  const who = await drive.about.get({ fields: 'user(emailAddress)' });
  console.log(`\nAuthorized as ${who.data.user.emailAddress}${DRY ? '   [DRY RUN]' : ''}\n`);

  const folder = await findOrCreateFolder(drive, MASTER_FOLDER);
  console.log(`Master folder "${MASTER_FOLDER}"  ${folder.created ? 'CREATED' : 'already existed'}  ${folder.id}\n`);

  const { data: ps } = await db.from('psychologists').select('id, first_name, last_name').order('first_name');
  const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
  let created = 0, existed = 0;

  for (const p of ps) {
    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim().replace(/\s+/g, ' ');
    if (!name) { console.log('  skipped a psychologist with no name'); continue; }
    const title = `${name} — Sessions`;
    try {
      const r = await findOrCreateSheet(drive, sheets, title, folder.id);
      map[p.id] = { name, spreadsheetId: r.id };
      r.created ? created++ : existed++;
      console.log(`  ${r.created ? 'created ' : 'existed '} ${title.padEnd(36)} ${r.id}`);
    } catch (e) {
      console.log(`  FAILED  ${title}: ${e?.response?.data?.error?.message || e.message}`);
    }
  }

  if (!DRY) fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 1));
  console.log(`\n${created} created, ${existed} already existed, ${ps.length} therapists total`);
  console.log(`Mapping saved to ${MAP_FILE}`);
  console.log(`Folder: https://drive.google.com/drive/folders/${folder.id}\n`);
})().catch(e => { console.error('\nFAILED:', e?.response?.data?.error?.message || e.message, '\n'); process.exit(1); });
