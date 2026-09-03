#!/usr/bin/env node
/**
 * One-time re-authorization to add Drive access to the backend's Google token.
 *
 * The existing GOOGLE_REFRESH_TOKEN was granted for Calendar only, and a token cannot gain
 * scopes after the fact — it has to be re-issued. This asks for the calendar scopes AND
 * drive.file together, so the replacement token does everything the old one did plus Drive.
 * Requesting only the new scope would silently break Meet links.
 *
 * Usage:  node scripts/google-reauthorize.js
 */
require('dotenv').config();
const readline = require('readline');
const { google } = require('googleapis');

// drive.file grants access ONLY to files this app creates — it cannot read anything else in
// the account's Drive, and it is enough for the Sheets API on spreadsheets we made ourselves.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file',
];

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI ||
  process.env.GOOGLE_REDIRECT_URI ||
  'http://localhost:3000/oauth2callback';

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

if (!CLIENT_ID) fail('GOOGLE_CLIENT_ID is not set. Copy it from Render into your local .env first.');
if (!CLIENT_SECRET) fail('GOOGLE_CLIENT_SECRET is not set. Copy it from Render into your local .env first.');

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const url = oauth2.generateAuthUrl({
  access_type: 'offline',   // required, or Google returns no refresh token
  prompt: 'consent',        // forces a NEW refresh token even if one was issued before
  scope: SCOPES,
});

console.log('\n─────────────────────────────────────────────────────────────');
console.log(' STEP 1  Open this link and sign in as the account that should');
console.log('         OWN the session spreadsheets:\n');
console.log(url);
console.log('\n         If you see "Google hasn\'t verified this app", click');
console.log('         Advanced -> Go to ... (unsafe). That is expected.');
console.log('\n STEP 2  After approving you land on a URL like:');
console.log(`           ${REDIRECT_URI}?code=4/0AbCd...&scope=...`);
console.log('         Copy the value of code= (up to the & if there is one).');
console.log('─────────────────────────────────────────────────────────────\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the code here: ', async (raw) => {
  rl.close();
  const code = decodeURIComponent(String(raw || '').trim());
  if (!code) fail('No code entered.');
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      fail('Google returned no refresh token. Revoke the app at ' +
           'myaccount.google.com/permissions and run this again.');
    }
    const granted = String(tokens.scope || '').split(' ');
    const missing = SCOPES.filter((s) => !granted.includes(s));

    console.log('\n─────────────────────────────────────────────────────────────');
    console.log(' Scopes granted:');
    granted.forEach((s) => console.log('   ✓ ' + s));
    if (missing.length) {
      console.log('\n ✗ MISSING — do not use this token:');
      missing.forEach((s) => console.log('   ✗ ' + s));
      console.log('\n   Add them on the OAuth consent screen and run this again.');
    } else {
      console.log('\n Set this on Render as GOOGLE_REFRESH_TOKEN:\n');
      console.log(tokens.refresh_token);
      console.log('\n Calendar keeps working — the old scopes are included above.');
    }
    console.log('─────────────────────────────────────────────────────────────\n');
  } catch (err) {
    fail(`Token exchange failed: ${err?.response?.data?.error_description || err.message}`);
  }
});
