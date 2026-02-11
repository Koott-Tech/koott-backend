const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

class GoogleCalendarService {
  constructor() {
    this.calendar = google.calendar({ version: 'v3' });
  }

  /**
   * Create OAuth2 client for psychologist
   * @param {Object} credentials - Psychologist's Google OAuth credentials
   * @returns {OAuth2Client}
   */
  createOAuthClient(credentials) {
    const oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      scope: credentials.scope
    });

    return oauth2Client;
  }

  /**
   * Fetch calendar events for a specific time range
   * @param {Object} credentials - Psychologist's Google OAuth credentials
   * @param {string} calendarId - Calendar ID (default: 'primary')
   * @param {Date} timeMin - Start time
   * @param {Date} timeMax - End time
   * @param {string} syncToken - Optional sync token for incremental sync
   * @param {number} retryCount - Internal retry counter (prevents infinite recursion)
   * @returns {Promise<Object>} Object with events array and nextSyncToken
   */
  async getCalendarEvents(credentials, calendarId = 'primary', timeMin, timeMax, syncToken = null, retryCount = 0) {
    try {
      const oauth2Client = this.createOAuthClient(credentials);
      
      const requestParams = {
        auth: oauth2Client,
        calendarId: calendarId,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: true, // Include deleted events when using sync token
        maxResults: 2500
      };

      // If syncToken provided, use incremental sync (only changes)
      if (syncToken) {
        requestParams.syncToken = syncToken;
      } else {
        // Full sync: use time range
        requestParams.timeMin = timeMin.toISOString();
        requestParams.timeMax = timeMax.toISOString();
        requestParams.showDeleted = false;
      }
      
      const response = await this.calendar.events.list(requestParams);

      return {
        events: response.data.items || [],
        nextSyncToken: response.data.nextSyncToken || null
      };
    } catch (error) {
      console.error('Error fetching calendar events:', error);
      
      // Handle sync token expiration (410 error) - need full sync
      if (error.code === 410) {
        console.warn('⚠️ Sync token expired, falling back to full sync');
        // Validate and normalize timeMin/timeMax before retry
        const safeTimeMin = timeMin && timeMin instanceof Date ? timeMin : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago
        const safeTimeMax = timeMax && timeMax instanceof Date ? timeMax : new Date(); // Now
        // Retry without sync token (full sync)
        return this.getCalendarEvents(credentials, calendarId, safeTimeMin, safeTimeMax, null, retryCount);
      }
      
      // Handle token refresh if needed (with retry guard)
      if (error.code === 401) {
        if (retryCount >= 1) {
          // Already retried once - prevent infinite recursion
          console.error('❌ Token refresh retry limit reached, aborting');
          throw new Error('Token refresh failed after retry');
        }
        const updatedCredentials = await this.refreshAccessToken(credentials);
        // Retry the request with refreshed credentials
        return this.getCalendarEvents(updatedCredentials, calendarId, timeMin, timeMax, syncToken, retryCount + 1);
      }
      
      throw error;
    }
  }

  /**
   * Refresh access token if expired
   * @param {Object} credentials - Psychologist's Google OAuth credentials
   * @returns {Promise<Object>} Updated credentials
   */
  async refreshAccessToken(credentials) {
    try {
      const oauth2Client = this.createOAuthClient(credentials);
      const { credentials: newCredentials } = await oauth2Client.refreshAccessToken();
      
      // Validate that newCredentials exists and has access_token
      if (!newCredentials || !newCredentials.access_token) {
        throw new Error('Token refresh returned invalid credentials');
      }
      
      return {
        ...credentials,
        access_token: newCredentials.access_token,
        refresh_token: newCredentials.refresh_token || credentials.refresh_token,
        expiry_date: newCredentials.expiry_date || credentials.expiry_date
      };
    } catch (error) {
      console.error('Error refreshing access token:', error);
      
      // Handle specific token expiration errors
      if (error.message && error.message.includes('invalid_grant')) {
        console.error('🚨 Google Calendar refresh token has expired or been revoked');
        console.error('💡 The psychologist needs to reconnect their Google Calendar');
        throw new Error('Google Calendar connection has expired. Please reconnect your Google Calendar in settings.');
      }
      
      throw error;
    }
  }

  /**
   * Check if a specific time slot conflicts with existing calendar events
   * @param {Object} credentials - Psychologist's Google OAuth credentials
   * @param {Date} startTime - Session start time
   * @param {Date} endTime - Session end time
   * @param {string} calendarId - Calendar ID (default: 'primary')
   * @returns {Promise<boolean>} True if there's a conflict
   */
  async hasTimeConflict(credentials, startTime, endTime, calendarId = 'primary') {
    try {
      const events = await this.getCalendarEvents(credentials, calendarId, startTime, endTime);
      
      return events.some(event => {
        const eventStart = new Date(event.start.dateTime || event.start.date);
        const eventEnd = new Date(event.end.dateTime || event.end.date);
        
        // Check for overlap
        return (startTime < eventEnd && endTime > eventStart);
      });
    } catch (error) {
      console.error('Error checking time conflict:', error);
      // If we can't check, assume no conflict to avoid blocking legitimate bookings
      return false;
    }
  }

  /**
   * Get all busy time slots for a date range
   * @param {Object} credentials - Psychologist's Google OAuth credentials
   * @param {Date} timeMin - Start time
   * @param {Date} timeMax - End time
   * @param {string} calendarId - Calendar ID (default: 'primary')
   * @param {string} syncToken - Optional sync token for incremental sync
   * @returns {Promise<Object>} Object with busySlots array and nextSyncToken
   */
  async getBusyTimeSlots(credentials, timeMin, timeMax, calendarId = 'primary', syncToken = null) {
    try {
      const result = await this.getCalendarEvents(credentials, calendarId, timeMin, timeMax, syncToken);
      const events = result.events;
      
      const busySlots = events.map(event => ({
        start: new Date(event.start.dateTime || event.start.date),
        end: new Date(event.end.dateTime || event.end.date),
        title: event.summary || 'Busy',
        source: 'google_calendar',
        eventId: event.id,
        hangoutsLink: event.hangoutsLink || null, // Google Meet link
        conferenceData: event.conferenceData || null, // Conference data (includes Meet links)
        location: event.location || null,
        description: event.description || null,
        status: event.status || null // 'confirmed', 'cancelled', etc.
      }));
      
      return {
        busySlots: busySlots,
        nextSyncToken: result.nextSyncToken
      };
    } catch (error) {
      console.error('Error getting busy time slots:', error);
      return {
        busySlots: [],
        nextSyncToken: null
      };
    }
  }

  /**
   * Sync calendar events and update psychologist's blocked times
   * @param {Object} psychologist - Psychologist object with Google credentials
   * @param {Date} startDate - Start date for sync
   * @param {Date} endDate - End date for sync
   * @returns {Promise<Object>} Sync result
   */
  /**
   * Sync calendar events and update psychologist's blocked times
   * Uses incremental sync with sync tokens for efficiency
   * @param {Object} psychologist - Psychologist object with Google credentials
   * @param {Date} startDate - Start date for sync (used for full sync only)
   * @param {Date} endDate - End date for sync (used for full sync only)
   * @param {string} syncToken - Optional sync token for incremental sync
   * @returns {Promise<Object>} Sync result with nextSyncToken
   */
  async syncCalendarEvents(psychologist, startDate, endDate, syncToken = null) {
    try {
      if (!psychologist.google_calendar_credentials) {
        throw new Error('Psychologist has no Google Calendar credentials');
      }

      // Get sync token from stored credentials if not provided
      const storedSyncToken = syncToken || psychologist.google_calendar_credentials.syncToken || null;
      
      const result = await this.getBusyTimeSlots(
        psychologist.google_calendar_credentials,
        startDate,
        endDate,
        'primary',
        storedSyncToken
      );

      const busySlots = result.busySlots;
      const nextSyncToken = result.nextSyncToken;

      // Filter logic:
      // 1. Block ALL events in Google Calendar (system events, external events, etc.)
      //    - If an event corresponds to a session in our database, it's already blocked by the session
      //    - If an event doesn't correspond to a session, it should still block (orphaned system event or external event)
      // 2. Exclude only public holidays
      // 3. Exclude cancelled/deleted events
      const externalEvents = busySlots.filter(slot => {
        // Skip cancelled or deleted events
        if (slot.status === 'cancelled') {
          return false;
        }
        
        const title = (slot.title || '').toLowerCase();
        
        // Exclude only public holidays (common patterns)
        const isPublicHoliday = 
          title.includes('holiday') ||
          title.includes('public holiday') ||
          title.includes('national holiday') ||
          title.includes('festival') ||
          title.includes('celebration') ||
          title.includes('observance');
        
        // Block ALL events that are NOT public holidays
        // Note: System events will also block, but if they correspond to sessions in our DB,
        // those sessions will already block the slot (no double-blocking issue)
        return !isPublicHoliday;
      });

      return {
        success: true,
        externalEvents: externalEvents,
        totalEvents: busySlots.length,
        syncedAt: new Date(),
        nextSyncToken: nextSyncToken,
        isIncremental: !!storedSyncToken // Indicates if this was an incremental sync
      };
    } catch (error) {
      console.error('Error syncing calendar events:', error);
      return {
        success: false,
        error: error.message,
        externalEvents: [],
        totalEvents: 0,
        syncedAt: new Date(),
        nextSyncToken: null,
        isIncremental: false
      };
    }
  }
}

module.exports = new GoogleCalendarService();
