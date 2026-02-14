const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { supabaseAdmin } = require('../config/supabase');

class TimeBlockingService {
  constructor() {
    this.calendar = google.calendar({ version: 'v3' });
  }

  /**
   * Create OAuth2 client for psychologist
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
   * Day-of-week to Google Calendar BYDAY (iCal): 0=Sunday -> SU, 1=Monday -> MO, etc.
   */
  static getRRULEByDay(dayOfWeek) {
    const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    return days[dayOfWeek] || 'SU';
  }

  /**
   * Create a recurring block event on Google Calendar (full-day or time range, e.g. every Sunday 11 AM–3 PM).
   * Used when psychologist adds a recurring block (e.g. "block every Sunday" or "block 11 AM–3 PM every Sunday").
   * @param {string} psychologistId - Psychologist ID
   * @param {Object} block - { day_of_week: 0-6, block_entire_day: boolean, time_slots?: string[] }
   * @param {string} reason - Display reason (e.g. "Recurring block")
   * @returns {Promise<{ success: boolean, eventId?: string, error?: string }>}
   */
  async createRecurringBlockCalendarEvent(psychologistId, block, reason = 'Recurring block') {
    try {
      const { data: psychologist, error: psychError } = await supabaseAdmin
        .from('psychologists')
        .select('id, google_calendar_credentials')
        .eq('id', psychologistId)
        .single();

      if (psychError || !psychologist || !psychologist.google_calendar_credentials) {
        return { success: false, error: 'Google Calendar not connected' };
      }

      const credentials = typeof psychologist.google_calendar_credentials === 'string'
        ? JSON.parse(psychologist.google_calendar_credentials)
        : psychologist.google_calendar_credentials;

      if (credentials.scope && credentials.scope.includes('calendar.readonly')) {
        return { success: false, error: 'Google Calendar is read-only. Reconnect with full access.' };
      }

      const oauth2Client = this.createOAuthClient(credentials);
      const dayOfWeek = Number(block.day_of_week);
      const byDay = TimeBlockingService.getRRULEByDay(dayOfWeek);
      const blockEntireDay = !!block.block_entire_day;
      const timeSlots = Array.isArray(block.time_slots) ? block.time_slots.filter(Boolean) : [];

      // First occurrence date must fall on the chosen day (e.g. a Sunday). Reference: 2020-01-05 = Sunday.
      const refSunday = new Date('2020-01-05T00:00:00Z');
      const startDate = new Date(refSunday);
      startDate.setUTCDate(refSunday.getUTCDate() + dayOfWeek);
      const startDateStr = startDate.toISOString().split('T')[0];

      let event;

      if (blockEntireDay) {
        const endDate = new Date(startDate);
        endDate.setUTCDate(endDate.getUTCDate() + 1);
        const endDateStr = endDate.toISOString().split('T')[0];
        event = {
          summary: `🚫 BLOCKED - ${reason}`,
          description: `Recurring block by psychologist (e.g. leave) - ${reason}. Synced from Little Care.`,
          start: { date: startDateStr },
          end: { date: endDateStr },
          recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${byDay}`],
          colorId: '11',
          transparency: 'opaque',
          visibility: 'private'
        };
      } else if (timeSlots.length > 0) {
        // Check if slots form a continuous range (each slot is 1 hour after the previous)
        const parseMinutes = (s) => {
          const t = String(s).trim().substring(0, 5);
          const [h, m] = t.split(':').map(Number);
          return (h || 0) * 60 + (m || 0);
        };
        const sorted = [...timeSlots].map(parseMinutes).sort((a, b) => a - b);
        const isContinuous = sorted.every((m, i) => i === 0 || m - sorted[i - 1] === 60);

        if (isContinuous) {
          // Single event for continuous range: e.g. 11:00–15:00 (slots 11, 12, 13, 14)
          const firstSlot = String(timeSlots[0]).trim().substring(0, 5);
          const lastSlot = String(timeSlots[timeSlots.length - 1]).trim().substring(0, 5);
          const [lastH, lastM] = lastSlot.split(':').map(Number);
          const endH = lastH + 1;
          const endSlot = `${String(endH).padStart(2, '0')}:${String(lastM || 0).padStart(2, '0')}`;
          const startDateTime = `${startDateStr}T${firstSlot}:00`;
          const endDateTime = `${startDateStr}T${endSlot}:00`;
          event = {
            summary: `🚫 BLOCKED - ${reason}`,
            description: `Recurring block by psychologist - ${reason}. Synced from Little Care.`,
            start: { dateTime: startDateTime, timeZone: 'Asia/Kolkata' },
            end: { dateTime: endDateTime, timeZone: 'Asia/Kolkata' },
            recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${byDay}`],
            colorId: '11',
            transparency: 'opaque',
            visibility: 'private'
          };
          const response = await this.calendar.events.insert({
            auth: oauth2Client,
            calendarId: 'primary',
            resource: event
          });
          const eventId = response.data.id;
          console.log(`✅ Recurring block GCal event created for psychologist ${psychologistId}, day ${dayOfWeek}, eventId=${eventId}`);
          return { success: true, eventId };
        }

        // Non-contiguous slots (e.g. 8, 9, 13): create one recurring event per slot so only those hours are blocked
        const eventIds = [];
        for (const slot of timeSlots) {
          const startSlot = String(slot).trim().substring(0, 5);
          const [h, m] = startSlot.split(':').map(Number);
          const endH = (h || 0) + 1;
          const endSlot = `${String(endH).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
          const slotEvent = {
            summary: `🚫 BLOCKED - ${reason}`,
            description: `Recurring block by psychologist - ${reason}. Synced from Little Care.`,
            start: { dateTime: `${startDateStr}T${startSlot}:00`, timeZone: 'Asia/Kolkata' },
            end: { dateTime: `${startDateStr}T${endSlot}:00`, timeZone: 'Asia/Kolkata' },
            recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${byDay}`],
            colorId: '11',
            transparency: 'opaque',
            visibility: 'private'
          };
          const response = await this.calendar.events.insert({
            auth: oauth2Client,
            calendarId: 'primary',
            resource: slotEvent
          });
          eventIds.push(response.data.id);
        }
        console.log(`✅ Recurring block GCal: ${eventIds.length} events for psychologist ${psychologistId}, day ${dayOfWeek}`);
        return { success: true, eventIds };
      } else {
        return { success: false, error: 'No time range specified for partial-day block' };
      }

      // Single event path (blockEntireDay or continuous range) already returned above
      if (event) {
        const response = await this.calendar.events.insert({
          auth: oauth2Client,
          calendarId: 'primary',
          resource: event
        });
        const eventId = response.data.id;
        console.log(`✅ Recurring block GCal event created for psychologist ${psychologistId}, day ${dayOfWeek}, eventId=${eventId}`);
        return { success: true, eventId };
      }
    } catch (error) {
      console.error('Error creating recurring block calendar event:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a recurring block event from Google Calendar (deletes the entire series).
   * @param {string} psychologistId - Psychologist ID
   * @param {string} eventId - Google Calendar event ID (recurring event id)
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async deleteRecurringBlockCalendarEvent(psychologistId, eventId) {
    if (!eventId) return { success: true };
    try {
      const { data: psychologist, error: psychError } = await supabaseAdmin
        .from('psychologists')
        .select('id, google_calendar_credentials')
        .eq('id', psychologistId)
        .single();

      if (psychError || !psychologist || !psychologist.google_calendar_credentials) {
        return { success: false, error: 'Psychologist or Google Calendar not found' };
      }

      const credentials = typeof psychologist.google_calendar_credentials === 'string'
        ? JSON.parse(psychologist.google_calendar_credentials)
        : psychologist.google_calendar_credentials;
      const oauth2Client = this.createOAuthClient(credentials);

      await this.calendar.events.delete({
        auth: oauth2Client,
        calendarId: 'primary',
        eventId: eventId
      });

      console.log(`✅ Recurring block GCal event deleted for psychologist ${psychologistId}, eventId=${eventId}`);
      return { success: true };
    } catch (error) {
      console.error('Error deleting recurring block calendar event:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new TimeBlockingService();
