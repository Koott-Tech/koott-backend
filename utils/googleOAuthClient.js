const { google } = require('googleapis');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, '../tokens.json');

// Service Account paths for different environments
const SERVICE_ACCOUNT_PATHS = [
  '/etc/secrets/google-service-account.json', // Render secret file path
  path.join(__dirname, '../google-service-account.json'), // Local development
  path.join(__dirname, '../key.json') // Alternative local path
];

/**
 * Ensures the service account calendar timezone is set to IST
 * @param {Object} calendarClient Google Calendar client
 */
const ensureServiceAccountCalendarIsIST = async (calendarClient) => {
  try {
    console.log('🌏 Setting service account calendar timezone to IST...');
    
    // Try to update the CalendarList entry first (more likely to work)
    try {
      await calendarClient.calendarList.update({
        calendarId: 'primary',
        requestBody: { timeZone: 'Asia/Kolkata' }
      });
      console.log('✅ CalendarList timezone set to Asia/Kolkata');
    } catch (calListError) {
      console.warn('⚠️ Could not set CalendarList timezone:', calListError.message);
    }

    // Try to set the calendar's default timezone (may not work for service accounts)
    try {
      await calendarClient.calendars.patch({
        calendarId: 'primary',
        requestBody: { timeZone: 'Asia/Kolkata' }
      });
      console.log('✅ Calendar timezone set to Asia/Kolkata');
    } catch (calError) {
      console.warn('⚠️ Could not set calendar timezone:', calError.message);
      console.log('💡 This is normal for service accounts - timezone will be handled in event creation');
    }

  } catch (error) {
    console.warn('⚠️ Timezone setting failed:', error.message);
  }
};

/**
 * Creates and returns a Google Calendar client using service account or OAuth2
 * @param {boolean} requireMeet - If true, forces OAuth2 authentication for Meet conferences
 * @returns {Object} Google Calendar client instance
 */
const calendar = async (requireMeet = false) => {
  try {
    // Skip service account if Meet conferences are required
    if (requireMeet) {
      console.log('🎥 Meet conference required - skipping service account, using OAuth2');
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      console.log('🔑 Using service account from environment variable');
      console.log('⚠️ WARNING: Service accounts cannot create Meet conferences - only calendar events');
      console.log('⚠️ For Meet links, OAuth2 user authentication is required');
      
      const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      
      const auth = new google.auth.JWT({
        email: serviceAccountKey.client_email,
        key: serviceAccountKey.private_key,
        scopes: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/calendar.events'
        ]
      });

      await auth.authorize();
      console.log('🔐 Google service account authenticated successfully (env var)');
      
      const calendarClient = google.calendar({ version: 'v3', auth });
      // Note: Service accounts don't need calendar timezone setting - handled in event creation
      return calendarClient;
    }

    // Try service account from file (Render secret files or local)
    for (const filePath of SERVICE_ACCOUNT_PATHS) {
      if (existsSync(filePath)) {
        console.log('🔑 Using service account from file:', filePath);
        const serviceAccountKey = JSON.parse(readFileSync(filePath, 'utf8'));
        
        const auth = new google.auth.JWT({
          email: serviceAccountKey.client_email,
          key: serviceAccountKey.private_key,
          scopes: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.events'
          ]
        });

        await auth.authorize();
        console.log('🔐 Google service account authenticated successfully (file)');
        
        const calendarClient = google.calendar({ version: 'v3', auth });
        // Note: Service accounts don't need calendar timezone setting - handled in event creation
        return calendarClient;
      }
    }

    // Fallback to OAuth2 (development)
    console.log('🔑 Using OAuth2 client (development)');
    return google.calendar({ version: 'v3', auth: getOAuth2Client() });

  } catch (error) {
    console.error('❌ Error initializing Google Calendar client:', error.message);
    console.warn('⚠️ Falling back to mock calendar client');
    return createMockCalendarClient();
  }
};

function getOAuth2Client() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  
  // Try to load tokens from file first
  if (existsSync(TOKENS_PATH)) {
    try {
      const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
      oAuth2Client.setCredentials(tokens);
      console.log('✅ OAuth tokens loaded from file');
    } catch (error) {
      console.log('⚠️ Error reading tokens file:', error.message);
    }
  }
  
  // Fallback: Try to load tokens from environment variables
  console.log('🔍 Checking OAuth environment variables...');
  console.log('   GOOGLE_OAUTH_ACCESS_TOKEN exists:', !!process.env.GOOGLE_OAUTH_ACCESS_TOKEN);
  console.log('   GOOGLE_OAUTH_REFRESH_TOKEN exists:', !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
  console.log('   GOOGLE_OAUTH_EXPIRY_DATE exists:', !!process.env.GOOGLE_OAUTH_EXPIRY_DATE);
  
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN && process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    try {
      const accessToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
      const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
      
      // Check if token appears truncated (OAuth tokens are usually 200+ characters)
      if (accessToken.length < 150) {
        console.log('⚠️ WARNING: Access token appears truncated!');
        console.log('   Token length:', accessToken.length);
        console.log('   Expected length: 200+ characters');
        console.log('   Token ends with:', accessToken.slice(-20));
        console.log('   💡 Solution: Use Render Secret Files instead of environment variables');
      }
      
      const envTokens = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expiry_date: parseInt(process.env.GOOGLE_OAUTH_EXPIRY_DATE) || Date.now() + 3600000
      };
      oAuth2Client.setCredentials(envTokens);
      console.log('✅ OAuth tokens loaded from environment variables');
      console.log('   Access token length:', envTokens.access_token.length);
      console.log('   Refresh token length:', envTokens.refresh_token.length);
      console.log('   Expiry date:', new Date(envTokens.expiry_date).toISOString());
    } catch (error) {
      console.log('⚠️ Error loading tokens from environment:', error.message);
    }
  } else {
    console.log('⚠️ OAuth environment variables not found or incomplete');
  }
  
  oAuth2Client.on('tokens', (tokens) => {
    try {
      const prev = existsSync(TOKENS_PATH) ? JSON.parse(readFileSync(TOKENS_PATH, 'utf8')) : {};
      const newTokens = { ...prev, ...tokens };
      writeFileSync(TOKENS_PATH, JSON.stringify(newTokens, null, 2));
      console.log('✅ Tokens updated and saved');
    } catch (error) {
      console.error('❌ Error saving tokens:', error.message);
    }
  });
  
  return oAuth2Client;
}

// Mock calendar client for fallback
function createMockCalendarClient() {
  return {
    events: {
      insert: async () => ({ data: { id: 'mock-event-id', hangoutLink: 'https://meet.google.com/mock-link' } }),
      get: async () => ({ data: { hangoutLink: 'https://meet.google.com/mock-link' } })
    }
  };
}

/**
 * Scopes this backend cannot work without, regardless of what GOOGLE_SCOPES says.
 *
 * On 17 Sep 2026 the shared refresh token was re-issued through this flow while GOOGLE_SCOPES
 * held only the two calendar scopes. Calendar kept working, so nothing looked broken — but the
 * token silently lost Drive, and every completed session has failed to reach its therapist's
 * Google Sheet since ("Request had insufficient authentication scopes"). 2,000+ sessions
 * accumulated before anyone noticed.
 *
 * Re-authorizing must never be able to drop a capability again, so the required set is unioned
 * in here rather than left to an env var. drive.file grants access only to files this app
 * created — it cannot read anything else in the account's Drive.
 */
const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file',
];

function authUrl() {
  const oauth2 = getOAuth2Client();
  const configured = (process.env.GOOGLE_SCOPES || '').split(/[\s,]+/).filter(Boolean);
  const scopes = [...new Set([...configured, ...REQUIRED_SCOPES])];

  const added = REQUIRED_SCOPES.filter((sc) => !configured.includes(sc));
  if (added.length) {
    console.log(
      '[google-oauth] adding required scope(s) missing from GOOGLE_SCOPES: ' +
        added.map((sc) => sc.replace('https://www.googleapis.com/auth/', '')).join(', ')
    );
  }

  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });
}

async function exchangeCode(code) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  // tokens persist via the 'tokens' event handler
  return tokens;
}

module.exports = {
  REQUIRED_SCOPES,
  getOAuth2Client,
  calendar,
  authUrl,
  exchangeCode
};
