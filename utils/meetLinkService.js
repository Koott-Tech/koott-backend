const { google } = require('googleapis');
const crypto = require('crypto');
const fs = require('fs').promises;

// Shared redirect URI constant
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:5001/api/oauth2/callback';
if (!process.env.GOOGLE_OAUTH_REDIRECT_URI) {
  console.warn('⚠️ GOOGLE_OAUTH_REDIRECT_URI not set, using default localhost. Set this in production!');
}

// Logging toggle for production
const DEBUG_MEET = process.env.DEBUG_MEET === 'true';
const log = (...args) => DEBUG_MEET && console.log(...args);
const logError = (...args) => console.error(...args); // Always log errors

class MeetLinkService {
  constructor() {
    this.oauth2Client = null;
    this.serviceAccount = null;
    this.oauthTokens = null;
    this.tokensLoaded = false;
    this.serviceAccountReady = null; // Promise that resolves when service account is initialized
    
    // Initialize service account and create readiness promise
    this.serviceAccountReady = this.initializeAuth().then(() => {
      log('✅ Service account initialized');
      return true;
    }).catch(error => {
      log('❌ Error initializing auth:', error.message || error);
      console.error('Failed to initialize Meet link auth:', error);
      // Still resolve to allow fallback behavior
      return false;
    });
    
    // Load OAuth tokens asynchronously - but track when done
    this.loadOAuthTokensFromFile().catch(error => {
      log('❌ Error loading OAuth tokens from file:', error.message || error);
      console.error('Failed to load OAuth tokens:', error);
    });
  }

  // Helper: Format time consistently (HH:MM -> HH:MM:SS)
  formatTime(time) {
    if (!time) return '00:00:00';
    
    // Validate and normalize input: H:MM(:SS)? or HH:MM(:SS)?
    const timePattern = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
    const match = time.match(timePattern);
    
    if (!match) {
      // Invalid format, return default
      return '00:00:00';
    }
    
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = match[3] || '00';
    const secondsInt = parseInt(seconds, 10);
    
    // Validate ranges
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || secondsInt < 0 || secondsInt > 59) {
      return '00:00:00';
    }
    
    // Zero-pad hour and minute to two digits, use validated seconds
    const paddedHours = String(hours).padStart(2, '0');
    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(secondsInt).padStart(2, '0');
    
    return `${paddedHours}:${paddedMinutes}:${paddedSeconds}`;
  }

  // Helper: Build normalized return object
  createResult(success, meetLink, method, eventId = null, eventLink = null, error = null, note = null) {
    return {
      success,
      meetLink: meetLink || null, // Return null when no valid link available
      method: method || 'fallback',
      eventId,
      eventLink,
      error,
      note: note || null
    };
  }

  async initializeAuth() {
    try {
      // Load service account for fallback
      this.serviceAccount = require('../google-service-account.json');
      log('✅ Meet Link Service initialized');
    } catch (error) {
      logError('❌ Failed to initialize Meet Link Service:', error.message);
    }
  }

  // Wait for tokens to be loaded (fixes race condition)
  async ensureTokensLoaded() {
    if (this.tokensLoaded) return;
    // Wait up to 2 seconds for tokens to load
    const maxWait = 2000;
    const start = Date.now();
    while (!this.tokensLoaded && (Date.now() - start) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Refresh OAuth token using refresh token (using modern getAccessToken instead of deprecated refreshAccessToken)
   */
  async refreshOAuthToken(refreshToken) {
    try {
      log('🔄 Refreshing OAuth token...');
      
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        GOOGLE_OAUTH_REDIRECT_URI
      );

      oauth2Client.setCredentials({
        refresh_token: refreshToken
      });

      // Use getAccessToken() instead of deprecated refreshAccessToken()
      const tokenResponse = await oauth2Client.getAccessToken();
      
      // Handle different response formats from getAccessToken()
      // It can return: { token: string } or { credentials: object } or just the token string
      let credentials;
      if (tokenResponse && typeof tokenResponse === 'object') {
        if (tokenResponse.credentials) {
          credentials = tokenResponse.credentials;
        } else if (tokenResponse.token) {
          // If it returns { token: string }, we need to get credentials from the client
          credentials = oauth2Client.credentials;
        } else {
          // Try to use the response as credentials directly
          credentials = tokenResponse;
        }
      } else {
        // If it returns just a token string, get credentials from the client
        credentials = oauth2Client.credentials;
      }
      
      // Validate that we have valid credentials with access_token
      if (!credentials || !credentials.access_token) {
        throw new Error('Token refresh returned invalid credentials - no access_token found');
      }
      
      log('✅ OAuth token refreshed successfully');
      return {
        success: true,
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token || refreshToken,
        expiryDate: credentials.expiry_date
      };
    } catch (error) {
      logError('❌ Token refresh failed:', error.message);
      // Log more details for debugging
      if (error.message && error.message.includes('access_token')) {
        logError('   This usually means the refresh token is invalid or expired');
      }
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Load OAuth tokens from file on startup
   */
  async loadOAuthTokensFromFile() {
    try {
      const tokenData = await fs.readFile('./oauth-tokens.json', 'utf8');
      const tokens = JSON.parse(tokenData);
      
      // Check if tokens are still valid (not expired)
      const now = Date.now();
      if (tokens.expiryDate && tokens.expiryDate > now) {
        this.oauthTokens = tokens;
        log('✅ OAuth tokens loaded from file');
      } else {
        log('⚠️ OAuth tokens in file are expired');
        // Try to refresh if we have a refresh token
        if (tokens.refreshToken) {
          log('🔄 Attempting to refresh expired tokens...');
          const refreshResult = await this.refreshOAuthToken(tokens.refreshToken);
          if (refreshResult.success) {
            this.oauthTokens = {
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiryDate: refreshResult.expiryDate,
              storedAt: Date.now()
            };
            // Save refreshed tokens to file
            await fs.writeFile('./oauth-tokens.json', JSON.stringify(this.oauthTokens, null, 2));
            log('✅ OAuth tokens refreshed and saved');
          } else {
            log('❌ Token refresh failed, will need new OAuth authorization');
          }
        } else {
          log('❌ No refresh token available, will need new OAuth authorization');
        }
      }
      this.tokensLoaded = true;
    } catch (error) {
      log('ℹ️ No OAuth tokens file found (this is normal on first run)');
      this.tokensLoaded = true; // Mark as loaded even if file doesn't exist
    }
  }

  /**
   * Store and manage OAuth tokens
   */
  async storeOAuthTokens(tokens) {
    try {
      // Store tokens in memory and file for persistence
      this.oauthTokens = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
        storedAt: Date.now()
      };
      
      // Also store in file for persistence across server restarts
      const tokenData = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
        storedAt: Date.now()
      };
      
      await fs.writeFile('./oauth-tokens.json', JSON.stringify(tokenData, null, 2));
      log('✅ OAuth tokens stored in memory and file');
      
      return true;
    } catch (error) {
      logError('❌ Failed to store OAuth tokens:', error.message);
      return false;
    }
  }

  /**
   * Get valid OAuth token (refresh if needed)
   */
  async getValidOAuthToken() {
    try {
      // Ensure tokens are loaded first
      await this.ensureTokensLoaded();
      
      if (!this.oauthTokens) {
        log('⚠️ No OAuth tokens available');
        return null;
      }

      const now = Date.now();
      const expiryTime = this.oauthTokens.expiryDate;
      
      // Check if token expires in next 5 minutes
      if (expiryTime && (expiryTime - now) < 5 * 60 * 1000) {
        log('🔄 Token expires soon, checking refresh options...');
        
        if (this.oauthTokens.refreshToken) {
          log('🔄 Attempting token refresh...');
          const refreshResult = await this.refreshOAuthToken(this.oauthTokens.refreshToken);
          if (refreshResult.success) {
            this.oauthTokens = {
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiryDate: refreshResult.expiryDate,
              storedAt: Date.now()
            };
            log('✅ Token refreshed successfully');
          } else {
            log('❌ Token refresh failed, will use service account fallback');
            return null;
          }
        } else {
          log('⚠️ No refresh token available - this is normal for Google OAuth');
          log('🔄 Will use service account fallback for reliability');
          return null;
        }
      }

      return this.oauthTokens.accessToken;
    } catch (error) {
      logError('❌ Error getting valid OAuth token:', error.message);
      return null;
    }
  }
  async createMeetLinkWithOAuth(oauthToken, sessionData, userAuth = null) {
    try {
      log('🔄 Creating Meet link with OAuth token via Calendar API...');
      
      // Create OAuth2 client
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        GOOGLE_OAUTH_REDIRECT_URI
      );

      // If userAuth is provided, check if token needs refresh and set refresh token
      let accessToken = oauthToken;
      if (userAuth?.refresh_token) {
        // Set both access and refresh tokens so OAuth client can auto-refresh if needed
        oauth2Client.setCredentials({
          access_token: oauthToken,
          refresh_token: userAuth.refresh_token,
          expiry_date: userAuth.expiry_date
        });
        
        // Check if token is expired or expires soon (within 5 minutes)
        const now = Date.now();
        const expiryDate = userAuth.expiry_date ? new Date(userAuth.expiry_date).getTime() : null;
        const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
        
        if (expiryDate && expiryDate <= (now + bufferTime)) {
          log('🔄 Access token expired or expires soon, refreshing...');
          try {
            // Use getAccessToken() which automatically refreshes if needed
            // Returns { token, res } where token is the access token string
            const { token } = await oauth2Client.getAccessToken();
            accessToken = token;
            
            // Get updated credentials from OAuth client after refresh
            const updatedCredentials = oauth2Client.credentials;
            log('✅ Token refreshed automatically');
            
            // Update userAuth with new token (caller should save this to database)
            if (userAuth && updatedCredentials && updatedCredentials.access_token) {
              userAuth.access_token = updatedCredentials.access_token || token;
              userAuth.expiry_date = updatedCredentials.expiry_date;
              userAuth.refresh_token = updatedCredentials.refresh_token || userAuth.refresh_token;
            } else if (userAuth && token) {
              // Fallback: use the token from getAccessToken() directly
              userAuth.access_token = token;
            }
          } catch (refreshError) {
            logError('❌ Auto-refresh failed:', refreshError.message);
            logError('   Refresh error details:', {
              message: refreshError.message,
              code: refreshError.code,
              response: refreshError.response?.data || 'No response data'
            });
            // Continue with original token - might still work if just expired
            // But log that we're proceeding with potentially expired token
            log('⚠️ Proceeding with original token (may be expired)');
          }
        }
      } else {
        // Just set access token if no refresh token available
        oauth2Client.setCredentials({
          access_token: oauthToken
        });
      }

      // Update credentials with refreshed token if it was refreshed
      // Guard against null userAuth to prevent TypeError
      if (accessToken !== oauthToken && userAuth) {
        oauth2Client.setCredentials({
          access_token: accessToken,
          refresh_token: userAuth.refresh_token || undefined,
          expiry_date: userAuth.expiry_date || undefined
        });
      } else if (accessToken !== oauthToken && !userAuth) {
        // If userAuth is null, only set access token
        oauth2Client.setCredentials({
          access_token: accessToken
        });
      }
      
      // Create Meet link using Calendar API with conference data
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      // Build attendees array - OAuth can use attendees
      const attendees = [];
      
      if (sessionData.clientEmail) {
        attendees.push({ email: sessionData.clientEmail });
      }
      
      if (sessionData.psychologistEmail) {
        attendees.push({ email: sessionData.psychologistEmail });
      }
      
      if (Array.isArray(sessionData.attendees) && sessionData.attendees.length > 0) {
        sessionData.attendees.forEach(email => {
          if (email && !attendees.find(a => a.email === email)) {
            attendees.push({ email });
          }
        });
      }

      const event = {
        summary: sessionData.summary || 'Therapy Session',
        description: sessionData.description || 'Therapy session with Google Meet',
        start: {
          dateTime: `${sessionData.startDate}T${this.formatTime(sessionData.startTime)}`,
          timeZone: 'Asia/Kolkata'
        },
        end: {
          dateTime: `${sessionData.startDate}T${this.formatTime(sessionData.endTime)}`,
          timeZone: 'Asia/Kolkata'
        },
        attendees: attendees.length > 0 ? attendees : undefined,
        // Make meeting open to anyone with the link (no waiting room)
        visibility: 'public',
        guestsCanInviteOthers: true,
        guestsCanSeeOtherGuests: true,
        anyoneCanAddSelf: true, // Allows anyone with the link to join without approval
        conferenceData: {
          createRequest: {
            requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
            conferenceSolutionKey: {
              type: 'hangoutsMeet'
            }
          }
        }
      };

      log('📅 Creating calendar event with Meet link...');
      // Mask attendee emails for logging
      const maskEmail = (email) => {
        if (!email || typeof email !== 'string' || !email.includes('@')) return '***@***';
        const [local, domain] = email.split('@');
        const maskedLocal = local.length > 2 
          ? local.substring(0, 1) + '***' + local.substring(local.length - 1)
          : '***';
        return `${maskedLocal}@${domain}`;
      };
      log('   👥 Attendees:', attendees.length > 0 ? `${attendees.length} attendee(s)` : 'None');
      const createdEvent = await calendar.events.insert({
        calendarId: 'primary',
        resource: event,
        conferenceDataVersion: 1,
        // Important: we do NOT want Google to email attendees
        // (those mails come from assessment.koott@gmail.com).
        // Our own Nodemailer emails already go out from the Little Care address.
        sendUpdates: 'none'
      });

      log('✅ Real Meet link created with OAuth via Calendar API');
      const meetLink = createdEvent.data.conferenceData?.entryPoints?.[0]?.uri;
      log('Meet Link:', meetLink);
      
      const result = this.createResult(
        true,
        meetLink,
        'oauth_calendar',
        createdEvent.data.id,
        createdEvent.data.htmlLink
      );
      
      // Add refreshed tokens to result if they were refreshed
      if (userAuth && userAuth.access_token !== oauthToken) {
        result.refreshedTokens = {
          access_token: userAuth.access_token,
          refresh_token: userAuth.refresh_token,
          expiry_date: userAuth.expiry_date
        };
      }
      
      return result;

    } catch (error) {
      logError('❌ OAuth Meet creation failed:', error.message);
      
      // Extract detailed error information
      const errorDetails = {
        message: error.message,
        code: error.code,
        status: error.response?.status || 'No status',
        hasRefreshToken: !!userAuth?.refresh_token,
        tokenExpired: userAuth?.expiry_date ? (new Date(userAuth.expiry_date).getTime() < Date.now()) : 'unknown'
      };
      
      // Log Google API error details if available
      if (error.response?.data?.error) {
        const googleError = error.response.data.error;
        errorDetails.googleError = {
          code: googleError.code,
          message: googleError.message,
          errors: googleError.errors || []
        };
        
        // Log each error in the errors array
        if (googleError.errors && Array.isArray(googleError.errors)) {
          googleError.errors.forEach((err, index) => {
            logError(`   Error ${index + 1}:`, {
              domain: err.domain,
              reason: err.reason,
              message: err.message,
              locationType: err.locationType,
              location: err.location
            });
          });
        }
      }
      
      logError('   OAuth error details:', errorDetails);
      
      // Log the event data that was sent (for debugging) - mask attendee emails
      const maskEmail = (email) => {
        if (!email || typeof email !== 'string' || !email.includes('@')) return '***@***';
        const [local, domain] = email.split('@');
        const maskedLocal = local.length > 2 
          ? local.substring(0, 1) + '***' + local.substring(local.length - 1)
          : '***';
        return `${maskedLocal}@${domain}`;
      };
      const maskedAttendees = (sessionData.attendees || []).map(a => {
        if (typeof a === 'string') return maskEmail(a);
        if (a && a.email) return maskEmail(a.email);
        return '***@***';
      });
      logError('   Event data that was sent:', {
        summary: sessionData.summary,
        startDate: sessionData.startDate,
        startTime: sessionData.startTime,
        endTime: sessionData.endTime,
        attendees: maskedAttendees
      });
      
      return this.createResult(false, null, 'oauth_calendar', null, null, error.message);
    }
  }

  /**
   * Create a Meet link using Calendar API with conference data
   * This works for users without OAuth tokens (service account)
   */
  async createMeetLinkWithCalendar(sessionData) {
    try {
      log('🔄 Creating Meet link with Calendar API...');
      
      // Wait for service account to be initialized
      if (this.serviceAccountReady) {
        await this.serviceAccountReady;
      }
      
      if (!this.serviceAccount) {
        logError('❌ Service account not available');
        return this.createResult(
          false,
          null,
          'service_account_not_available',
          null,
          null,
          'Service account not initialized'
        );
      }
      
      // Create service account auth
      const auth = new google.auth.JWT({
        email: this.serviceAccount.client_email,
        key: this.serviceAccount.private_key,
        scopes: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/calendar.events'
        ]
      });

      await auth.authorize();
      
      const calendar = google.calendar({ version: 'v3', auth });

      // Build attendees list for description (service accounts can't use attendees field)
      const attendeeEmails = [];
      
      if (sessionData.clientEmail) {
        attendeeEmails.push(sessionData.clientEmail);
      }
      
      if (sessionData.psychologistEmail) {
        attendeeEmails.push(sessionData.psychologistEmail);
      }
      
      if (Array.isArray(sessionData.attendees) && sessionData.attendees.length > 0) {
        sessionData.attendees.forEach(email => {
          if (email && !attendeeEmails.includes(email)) {
            attendeeEmails.push(email);
          }
        });
      }

      // Service accounts CANNOT use attendees field - detect upfront and skip it
      const canUseAttendees = false; // Service account limitation
      
      // Do not put PII (attendee emails) in description; use non-identifying reference
      let description = sessionData.description || 'Therapy session with Google Meet';
      if (attendeeEmails.length > 0) {
        description += `\n\nAttendees: see guest list in calendar.\n\nJoin via the Google Meet link above.`;
      }

      // Create event WITHOUT attendees field (service account limitation)
      const event = {
        summary: sessionData.summary || 'Therapy Session',
        description: description,
        start: {
          dateTime: `${sessionData.startDate}T${this.formatTime(sessionData.startTime)}`,
          timeZone: 'Asia/Kolkata'
        },
        end: {
          dateTime: `${sessionData.startDate}T${this.formatTime(sessionData.endTime)}`,
          timeZone: 'Asia/Kolkata'
        },
        // Make meeting open to anyone with the link (no waiting room)
        visibility: 'public',
        guestsCanInviteOthers: true,
        guestsCanSeeOtherGuests: true,
        anyoneCanAddSelf: true, // Allows anyone with the link to join without approval
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID()
          }
        }
      };

      // Mask attendee emails for logging
      const maskEmail = (email) => {
        if (!email || typeof email !== 'string' || !email.includes('@')) return '***@***';
        const [local, domain] = email.split('@');
        const maskedLocal = local.length > 2 
          ? local.substring(0, 1) + '***' + local.substring(local.length - 1)
          : '***';
        return `${maskedLocal}@${domain}`;
      };
      log('🔍 Calendar API Event Data:', {
        summary: event.summary,
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        attendeesCount: attendeeEmails.length || 0,
        conferenceData: event.conferenceData ? 'present' : 'none'
      });

      // Service account cannot use attendees - create event without them
      log('⚠️ Service account cannot use attendees field - creating event without attendees');
      log('   📧 Meet link will be shared via email/WhatsApp instead');
      log('   📝 Attendees documented in event description');
      
      const result = await calendar.events.insert({
        calendarId: 'primary',
        conferenceDataVersion: 1,
        requestBody: event
        // No attendees, no sendUpdates - service account limitation
      });
      
      log('✅ Calendar event created (without attendees - service account limitation)');

      log('✅ Calendar event created:', result.data.id);
      
      // Try to extract Meet link immediately from the created event
      let eventData = result.data;
      
      log('🔍 Checking for Meet link in created event...');
      log('   - Has conferenceData:', !!eventData.conferenceData);
      log('   - Has entryPoints:', !!eventData.conferenceData?.entryPoints);
      log('   - Has hangoutLink:', !!eventData.hangoutLink);
      
      // Check if Meet link is already available
      const immediateLink = this.extractMeetLink(eventData);
      if (immediateLink) {
        log('✅ REAL Meet link found immediately:', immediateLink);
        return this.createResult(
          true,
          immediateLink,
          'calendar_service_account',
          eventData.id,
          eventData.htmlLink
        );
      }
      
      // If no immediate Meet link, wait for conference with exponential backoff
      log('⏳ No immediate Meet link, waiting for conference...');
      const meetLink = await this.waitForConferenceReady(eventData.id, calendar);
      
      if (meetLink) {
        log('✅ Real Meet link created with Calendar:', meetLink);
        return this.createResult(
          true,
          meetLink,
          'calendar_service_account',
          eventData.id,
          eventData.htmlLink
        );
      }
      
      // Service account limitation - cannot create Meet conferences
      log('⚠️ Conference timeout - Service account limitation detected');
      log('⚠️ Service accounts CANNOT create Google Meet conferences via Calendar API');
      log('⚠️ Solution: Use OAuth tokens (psychologist Google Calendar connection) for real Meet links');
      
      return this.createResult(
        false,
        null,
        'service_account_limitation',
        eventData.id,
        eventData.htmlLink,
        'Service accounts cannot create Meet conferences - OAuth required for real Meet links'
      );

    } catch (error) {
      logError('❌ Calendar Meet creation failed:', error.message);
      
      const errorMsg = error.message || '';
      if (errorMsg.includes('Bad Request') || errorMsg.includes('insufficient authentication')) {
        log('🔍 Service account cannot create Meet conferences - this is expected');
        log('💡 OAuth tokens are required for real Meet link creation');
        return this.createResult(
          false,
          null,
          'service_account_limitation',
          null,
          null,
          'Service account cannot create Meet conferences'
        );
      }
      
      return this.createResult(
        false,
        null,
        'calendar_error',
        null,
        null,
        error.message
      );
    }
  }

  // Helper: Extract Meet link from event data
  extractMeetLink(eventData) {
    // Check entryPoints first
    if (eventData.conferenceData?.entryPoints) {
      const meetEntry = eventData.conferenceData.entryPoints.find(ep => 
        ep.entryPointType === 'video' || 
        ep.uri?.includes('meet.google.com') ||
        ep.uri?.includes('hangouts.google.com')
      );
      if (meetEntry?.uri) {
        return meetEntry.uri;
      }
    }
    
    // Check hangoutLink as fallback
    if (eventData.hangoutLink) {
      return eventData.hangoutLink;
    }
    
    return null;
  }

  /**
   * Wait for conference to be ready and extract Meet link
   * Uses exponential backoff for better reliability
   */
  async waitForConferenceReady(eventId, calendar, timeoutMs = 30000) {
    try {
      log('⏳ Waiting for conference to be ready...');
      
      const start = Date.now();
      let attempts = 0;
      const baseInterval = 1000; // Start with 1 second
      
      while (Date.now() - start < timeoutMs) {
        attempts++;
        
        // Exponential backoff: 1s, 2s, 4s, 6s, 8s, then cap at 8s
        const waitTime = Math.min(baseInterval * Math.pow(2, Math.min(attempts - 1, 2)), 8000);
        if (attempts > 3) {
          // After 3 attempts, use fixed 8s interval
          const fixedInterval = 8000;
          await new Promise(resolve => setTimeout(resolve, fixedInterval));
        } else if (attempts > 1) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        log(`   🔍 Attempt ${attempts}: Checking conference status...`);
        
        const { data } = await calendar.events.get({ 
          calendarId: 'primary', 
          eventId, 
          conferenceDataVersion: 1 
        });
        
        const status = data.conferenceData?.createRequest?.status?.statusCode;
        log(`   📊 Conference Status: ${status || 'pending'}`);
        
        // Check for Meet link (even if status is pending)
        const meetLink = this.extractMeetLink(data);
        if (meetLink) {
          log('   🔗 Meet link found:', meetLink);
          return meetLink;
        }
        
        if (status === 'failure') {
          throw new Error('Conference creation failed');
        }
        
        if (status === 'success') {
          log('   🎉 Conference status is success, but no Meet link found yet');
          // Continue waiting as link might populate shortly
        }
      }
      
      log(`⏰ Conference still pending after ${timeoutMs}ms, returning null`);
      return null;
      
    } catch (error) {
      logError('❌ Error waiting for conference:', error);
      return null;
    }
  }

  /**
   * Delete a calendar event by ID (e.g. on rollback).
   * Uses userAuth if provided (event on user's primary calendar), else service account (primary).
   */
  async deleteCalendarEvent(eventId, userAuth = null) {
    if (!eventId) return { success: false, error: 'No eventId provided' };
    try {
      let calendar;
      if (userAuth?.access_token) {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          GOOGLE_OAUTH_REDIRECT_URI
        );
        
        // Check if token is expired and refresh if needed
        const now = Date.now();
        const expiryDate = userAuth.expiry_date ? new Date(userAuth.expiry_date).getTime() : null;
        const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
        
        if (expiryDate && expiryDate <= (now + bufferTime)) {
          log('🔄 Access token expired or expires soon, refreshing before delete...');
          try {
            oauth2Client.setCredentials({
              access_token: userAuth.access_token,
              refresh_token: userAuth.refresh_token,
              expiry_date: userAuth.expiry_date
            });
            const { token } = await oauth2Client.getAccessToken();
            const updatedCredentials = oauth2Client.credentials;
            
            // Update userAuth with refreshed tokens
            if (updatedCredentials && updatedCredentials.access_token) {
              userAuth.access_token = updatedCredentials.access_token || token;
              userAuth.expiry_date = updatedCredentials.expiry_date;
              userAuth.refresh_token = updatedCredentials.refresh_token || userAuth.refresh_token;
            } else if (token) {
              userAuth.access_token = token;
            }
            log('✅ Token refreshed before delete');
          } catch (refreshError) {
            logError('❌ Token refresh failed before delete:', refreshError.message);
            // Continue with original token - might still work
          }
        }
        
        oauth2Client.setCredentials({
          access_token: userAuth.access_token,
          refresh_token: userAuth.refresh_token,
          expiry_date: userAuth.expiry_date
        });
        calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      } else if (this.serviceAccount) {
        const auth = new google.auth.JWT({
          email: this.serviceAccount.client_email,
          key: this.serviceAccount.private_key,
          scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events']
        });
        await auth.authorize();
        calendar = google.calendar({ version: 'v3', auth });
      } else {
        return { success: false, error: 'No auth available to delete event' };
      }
      
      await calendar.events.delete({ calendarId: 'primary', eventId });
      log('✅ Calendar event deleted:', eventId);
      return { success: true };
    } catch (error) {
      logError('❌ deleteCalendarEvent failed:', error.message);
      
      // Check for 401/invalid-auth errors and return clear message
      if (error.code === 401 || error.message?.includes('invalid') || error.message?.includes('expired')) {
        return { success: false, error: 'access_token expired' };
      }
      
      return { success: false, error: error.message };
    }
  }

  /**
   * Create a Meet link using the best available method
   * Priority: OAuth (if available) > Service Account > Fallback
   */
  async createMeetLink(sessionData, userAuth = null) {
    try {
      log('🔄 Creating Meet link with best available method...');
      
      // Ensure OAuth tokens are loaded
      await this.ensureTokensLoaded();
      
      // Priority 1: Try OAuth method (if userAuth provided or stored tokens available)
      let oauthToken = null;
      if (userAuth?.access_token) {
        oauthToken = userAuth.access_token;
        log('   🔑 Using provided OAuth token...');
      } else {
        oauthToken = await this.getValidOAuthToken();
        if (oauthToken) {
          log('   🔑 Using stored OAuth token...');
        }
      }
      
      if (oauthToken) {
        log('   🔑 Trying OAuth method...');
        const oauthResult = await this.createMeetLinkWithOAuth(oauthToken, sessionData, userAuth);
        
        if (oauthResult.success) {
          return oauthResult;
        }
        
        log('   ⚠️ OAuth method failed, trying Calendar method...');
      } else {
        log('   ⚠️ No OAuth token available, trying Calendar method...');
      }
      
      // Priority 2: Fall back to Calendar API method (service account)
      log('   📅 Trying Calendar API method...');
      const calendarResult = await this.createMeetLinkWithCalendar(sessionData);
      
      if (calendarResult.success) {
        return calendarResult;
      }
      
      // Priority 3: Fallback link
      log('   ⚠️ Both methods failed, returning fallback...');
      return this.createResult(
        false,
        null,
        'fallback',
        null,
        null,
        'Manual Meet creation required - both OAuth and Calendar methods failed'
      );
      
    } catch (error) {
      logError('❌ All Meet creation methods failed:', error.message);
      return this.createResult(
        false,
        null,
        'fallback',
        null,
        null,
        error.message
      );
    }
  }

  /**
   * Generate a unique Meet link for a session
   * This is the main method that should be called
   */
  async generateSessionMeetLink(sessionData, userAuth = null) {
    try {
      log('🔄 Generating session Meet link...');
      log('   📅 Session ID:', sessionData?.id || sessionData?.session_id);
      log('   🔑 User Auth:', userAuth ? 'Available' : 'Not available');
      
      // Prepare session data - include emails for attendees (KEY to bypassing host approval)
      const meetSessionData = {
        summary: sessionData.summary || 'Therapy Session',
        description: sessionData.description || 'Therapy session',
        startDate: sessionData.startDate,
        startTime: sessionData.startTime,
        endTime: sessionData.endTime,
        startISO: sessionData.startISO || `${sessionData.startDate}T${sessionData.startTime}`,
        endISO: sessionData.endISO || `${sessionData.startDate}T${sessionData.endTime}`,
        // Pass through email addresses - these will be added as attendees
        clientEmail: sessionData.clientEmail,
        psychologistEmail: sessionData.psychologistEmail,
        attendees: sessionData.attendees // Support both formats
      };
      
      // Create Meet link
      const result = await this.createMeetLink(meetSessionData, userAuth);
      
      log('✅ Meet link generation result:', result);
      
      return result;
      
    } catch (error) {
      logError('❌ Session Meet link generation failed:', error.message);
      return this.createResult(
        false,
        null,
        'fallback',
        null,
        null,
        error.message
      );
    }
  }
}

module.exports = new MeetLinkService();