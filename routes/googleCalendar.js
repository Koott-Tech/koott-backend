const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, requirePsychologist } = require('../middleware/auth');
const router = express.Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// Connect Google Calendar
router.post('/connect', authenticateToken, requirePsychologist, async (req, res) => {
  try {
    const { code, redirect_uri } = req.body;
    const psychologist_id = req.user.id;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Authorization code is required'
      });
    }

    // Exchange authorization code for tokens
    const oAuth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      redirect_uri || GOOGLE_REDIRECT_URI
    );

    const { tokens } = await oAuth2Client.getToken(code);

    // Fetch the Google account email that authorised the OAuth so we can store it.
    // This is used later to correctly identify the calendar owner vs the notification email.
    let oauthEmail = null;
    try {
      oAuth2Client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
      const { data: userInfo } = await oauth2.userinfo.get();
      oauthEmail = userInfo.email || null;
    } catch (e) {
      console.warn('[googleCalendar] could not fetch OAuth account email (non-fatal):', e.message);
    }

    // Store tokens in database
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { error } = await supabaseAdmin
      .from('psychologists')
      .update({
        google_calendar_credentials: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          scope: tokens.scope,
          token_type: tokens.token_type,
          expiry_date: tokens.expiry_date,
          connected_at: new Date().toISOString(),
          oauth_email: oauthEmail,   // actual Google account these tokens belong to
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', psychologist_id);

    if (error) {
      console.error('Error storing Google Calendar credentials:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to save Google Calendar credentials'
      });
    }

    res.json({
      success: true,
      message: 'Google Calendar connected successfully'
    });

  } catch (error) {
    console.error('Error connecting Google Calendar:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to connect Google Calendar'
    });
  }
});

// Disconnect Google Calendar
router.post('/disconnect', authenticateToken, requirePsychologist, async (req, res) => {
  try {
    const psychologist_id = req.user.id;

    // Remove Google Calendar credentials
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { error } = await supabaseAdmin
      .from('psychologists')
      .update({
        google_calendar_credentials: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', psychologist_id);

    if (error) {
      console.error('Error removing Google Calendar credentials:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to disconnect Google Calendar'
      });
    }

    res.json({
      success: true,
      message: 'Google Calendar disconnected successfully'
    });

  } catch (error) {
    console.error('Error disconnecting Google Calendar:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to disconnect Google Calendar'
    });
  }
});

// Get Google Calendar connection status
router.get('/status', authenticateToken, requirePsychologist, async (req, res) => {
  try {
    const psychologist_id = req.user.id;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologist, error } = await supabaseAdmin
      .from('psychologists')
      .select('google_calendar_credentials')
      .eq('id', psychologist_id)
      .single();

    if (error) {
      console.error('Error fetching psychologist data:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch connection status'
      });
    }

    const isConnected = psychologist?.google_calendar_credentials !== null;
    const lastSync = psychologist?.google_calendar_credentials?.connected_at;

    res.json({
      success: true,
      connected: isConnected,  // Use 'connected' to match frontend
      isConnected,
      lastSync,
      credentials: isConnected ? {
        connected_at: psychologist.google_calendar_credentials.connected_at,
        scope: psychologist.google_calendar_credentials.scope
      } : null
    });

  } catch (error) {
    console.error('Error checking Google Calendar status:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to check connection status'
    });
  }
});

// Get Google Calendar events
router.get('/events', authenticateToken, requirePsychologist, async (req, res) => {
  try {
    const psychologist_id = req.user.id;
    const { timeMin, timeMax } = req.query;

    // Get psychologist's Google Calendar credentials
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologist, error } = await supabaseAdmin
      .from('psychologists')
      .select('google_calendar_credentials')
      .eq('id', psychologist_id)
      .single();

    if (error || !psychologist?.google_calendar_credentials) {
      return res.status(400).json({
        success: false,
        message: 'Google Calendar not connected'
      });
    }

    // Setup OAuth2 client with stored credentials
    const oAuth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET
    );

    oAuth2Client.setCredentials({
      access_token: psychologist.google_calendar_credentials.access_token,
      refresh_token: psychologist.google_calendar_credentials.refresh_token
    });

    // Create calendar API client
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

    // Determine time window
    const effectiveTimeMin = timeMin || new Date().toISOString();
    const effectiveTimeMax = timeMax || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch list of calendars to include events across all calendars (primary + secondary/subscribed)
    const calendarListResp = await calendar.calendarList.list({
      minAccessRole: 'reader'
    });
    const calendars = calendarListResp.data.items || [];
    
    // Debug: Log the raw calendar list response
    console.log('🔍 Raw calendarList response:', JSON.stringify(calendarListResp.data, null, 2));
    console.log('🔍 OAuth token scopes:', psychologist.google_calendar_credentials.scope);

    // Always include primary as a fallback if calendar list is empty
    let calendarsToQuery = calendars.length > 0
      ? calendars
      : [{ id: 'primary', summary: 'Primary' }];

    // CRITICAL: Always ensure primary calendar is included
    const hasPrimary = calendarsToQuery.some(cal => cal.id === 'primary' || cal.primary === true);
    if (!hasPrimary) {
      console.log('⚠️ Primary calendar missing from calendarList, adding it explicitly');
      calendarsToQuery.unshift({ id: 'primary', summary: 'Primary Calendar', accessRole: 'owner' });
    }

    // Debug: Log all calendars being queried
    console.log('📅 Calendars to query:', calendarsToQuery.map(c => ({
      id: c.id,
      summary: c.summary,
      accessRole: c.accessRole,
      primary: c.primary
    })));

    const aggregatedEvents = [];

    // Fetch events from each calendar in parallel (limit concurrency via Promise.all)
    await Promise.all(
      calendarsToQuery.map(async (cal) => {
        try {
          const resp = await calendar.events.list({
            calendarId: cal.id,
            timeMin: effectiveTimeMin,
            timeMax: effectiveTimeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 2500,
            showDeleted: false,
            showHiddenInvitations: true,
            conferenceDataVersion: 1,
            alwaysIncludeEmail: true
          });

          const items = resp.data.items || [];
          console.log(`📅 Calendar ${cal.id} (${cal.summary}): ${items.length} events`);
          
          // Debug: Log details of events from primary calendar
          if (cal.id === 'phonixer321@gmail.com' || cal.primary) {
            console.log('🔍 Primary calendar events:', items.map(evt => ({
              id: evt.id,
              summary: evt.summary,
              start: evt.start,
              end: evt.end,
              status: evt.status,
              hangoutLink: evt.hangoutLink,
              conferenceData: evt.conferenceData
            })));
          }
          
          // Tag each event with its source calendar for UI filtering/debugging
          items.forEach((evt) => {
            aggregatedEvents.push({
              ...evt,
              _sourceCalendar: {
                id: cal.id,
                summary: cal.summary,
                accessRole: cal.accessRole
              }
            });
          });
        } catch (err) {
          // Log and continue with other calendars
          console.error(`Error fetching events for calendar ${cal.id}:`, err?.message || err);
        }
      })
    );

    // Build a set of calendar IDs we queried
    const calendarIdSet = new Set(calendarsToQuery.map(c => c.id));
    if (!calendarIdSet.has('primary')) {
      calendarIdSet.add('primary');
    }

    // Fallback: also fetch FreeBusy to catch private or hidden-invitation events
    try {
      const fbResp = await calendar.freebusy.query({
        requestBody: {
          timeMin: effectiveTimeMin,
          timeMax: effectiveTimeMax,
          items: Array.from(calendarIdSet).map((id) => ({ id }))
        }
      });

      const fbCalendars = fbResp.data.calendars || {};
      // For each busy block, if we don't already have an overlapping event, synthesize a placeholder
      for (const [calId, calData] of Object.entries(fbCalendars)) {
        const busyBlocks = calData.busy || [];
        for (const block of busyBlocks) {
          const bStart = new Date(block.start);
          const bEnd = new Date(block.end);
          // Check if any aggregated event overlaps this busy block for the same calendar
          const overlapExists = aggregatedEvents.some((evt) => {
            const eStart = new Date(evt.start?.dateTime || evt.start?.date || 0);
            const eEnd = new Date(evt.end?.dateTime || evt.end?.date || 0);
            const sameCal = (evt._sourceCalendar?.id || 'primary') === calId;
            return sameCal && eStart < bEnd && eEnd > bStart;
          });

          if (!overlapExists) {
            aggregatedEvents.push({
              id: `freebusy-${calId}-${bStart.toISOString()}-${bEnd.toISOString()}`,
              summary: 'Busy (private/hidden)',
              start: { dateTime: bStart.toISOString() },
              end: { dateTime: bEnd.toISOString() },
              transparency: 'opaque',
              _sourceCalendar: { id: calId, summary: 'FreeBusy', accessRole: 'freeBusyReader' },
              _source: 'google_freebusy'
            });
          }
        }
      }
    } catch (fbErr) {
      console.error('Error fetching FreeBusy data:', fbErr?.message || fbErr);
    }

    // Sort aggregated events by start time
    aggregatedEvents.sort((a, b) => {
      const aStart = new Date(a.start?.dateTime || a.start?.date || 0).getTime();
      const bStart = new Date(b.start?.dateTime || b.start?.date || 0).getTime();
      return aStart - bStart;
    });

    // Optional debug payload
    const includeDebug = String(req.query.debug).toLowerCase() === 'true';
    const debugInfo = includeDebug ? {
      calendars: calendarsToQuery.map(c => ({ id: c.id, summary: c.summary, accessRole: c.accessRole })),
      requestedWindow: { timeMin: effectiveTimeMin, timeMax: effectiveTimeMax },
      totals: {
        calendars: calendarsToQuery.length,
        aggregated: aggregatedEvents.length
      },
      sample: aggregatedEvents.slice(0, 5).map(e => ({
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        hangoutLink: e.hangoutLink,
        conferenceData: !!e.conferenceData,
        sourceCalendar: e._sourceCalendar,
        source: e._source
      }))
    } : undefined;

    res.json({
      success: true,
      events: aggregatedEvents,
      total: aggregatedEvents.length,
      debug: debugInfo
    });

  } catch (error) {
    console.error('Error fetching Google Calendar events:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch calendar events'
    });
  }
});

module.exports = router;
