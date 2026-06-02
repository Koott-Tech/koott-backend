/**
 * Daily Calendar Conflict Monitor Service
 * Runs every day at 1:00 AM to check for conflicts between Google Calendar events
 * and availability slots for all psychologists with synced calendars.
 * Results are logged to console only.
 */

const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const googleCalendarService = require('../utils/googleCalendarService');
const calendarSyncService = require('./calendarSyncService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

class CalendarConflictMonitorService {
  constructor() {
    this.isRunning = false;
  }

  /**
   * Start the daily conflict monitor service
   * Runs every day at 1:00 AM
   */
  start() {
    console.log('🔍 Starting Daily Calendar Conflict Monitor Service...');
    console.log('   Schedule: Every day at 1:00 AM');
    console.log('   Notifications: Console logs only\n');

    // Run every day at 1:00 AM
    // Cron format: '0 1 * * *' = minute 0, hour 1, every day, every month, every day of week
    cron.schedule('0 1 * * *', async () => {
      if (this.isRunning) {
        console.log('⏭️  Calendar conflict check already running, skipping...');
        return;
      }

      this.isRunning = true;
      console.log('🕐 Running daily calendar conflict check (1:00 AM)...');

      try {
        await this.checkForConflicts();
      } catch (error) {
        console.error('❌ Error in calendar conflict check:', error);
      } finally {
        this.isRunning = false;
      }
    });

    console.log('✅ Calendar Conflict Monitor Service started');
  }

  /**
   * Convert 12-hour time to 24-hour format (matches availabilityController logic)
   */
  convertTo24Hour(timeStr) {
    if (!timeStr) return null;
    
    const time = typeof timeStr === 'string' ? timeStr.trim() : String(timeStr).trim();
    
    // If already in 24-hour format (no AM/PM), extract HH:MM
    if (!time.includes('AM') && !time.includes('PM')) {
      // Extract first 5 characters (HH:MM) if longer string
      const match = time.match(/(\d{1,2}):(\d{2})/);
      if (match) {
        const hours = parseInt(match[1]);
        const minutes = match[2];
        return `${String(hours).padStart(2, '0')}:${minutes}`;
      }
      return time.substring(0, 5);
    }
    
    // Parse 12-hour format (e.g., "5:00 PM" or "5:00PM")
    const match = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;
    
    let hour24 = parseInt(match[1]);
    const minutes = match[2];
    const period = match[3].toUpperCase();
    
    if (period === 'PM' && hour24 !== 12) {
      hour24 += 12;
    } else if (period === 'AM' && hour24 === 12) {
      hour24 = 0;
    }
    
    return `${String(hour24).padStart(2, '0')}:${minutes}`;
  }

  /**
   * Format time to HH:MM
   */
  formatTime(date) {
    return dayjs(date).utc().tz('Asia/Kolkata').format('HH:mm');
  }

  /**
   * Format date to YYYY-MM-DD
   */
  formatDate(date) {
    return dayjs(date).utc().tz('Asia/Kolkata').format('YYYY-MM-DD');
  }

  /**
   * Check if a time slot conflicts with calendar events
   */
  isTimeSlotBlocked(timeSlot12Hour, calendarEvents, dateStr) {
    const time24Hour = this.convertTo24Hour(timeSlot12Hour);
    if (!time24Hour) return false;
    
    const [hours, minutes] = time24Hour.split(':').map(Number);
    // Parse the slot time directly in IST timezone (not convert to IST)
    const slotStart = dayjs.tz(`${dateStr} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`, 'Asia/Kolkata');
    const slotEnd = slotStart.add(60, 'minutes');

    return calendarEvents.some(event => {
      // event.start and event.end are Date objects from getBusyTimeSlots
      // Date objects are stored internally as UTC milliseconds
      // Parse as UTC first, then convert to IST for accurate timezone handling
      const eventStart = dayjs(event.start).utc().tz('Asia/Kolkata');
      const eventEnd = dayjs(event.end).utc().tz('Asia/Kolkata');
      
      // Check for actual overlap
      return slotStart.isBefore(eventEnd) && slotEnd.isAfter(eventStart);
    });
  }

  /**
   * Get availability slots for a psychologist on a specific date
   */
  async getAvailabilitySlots(psychologistId, date) {
    try {
      const { data: availability, error } = await supabaseAdmin
        .from('availability')
        .select('*')
        .eq('psychologist_id', psychologistId)
        .eq('date', date)
        .single();

      if (error || !availability || !availability.is_available) {
        return [];
      }

      const timeSlots = availability.time_slots || [];
      return Array.isArray(timeSlots) ? timeSlots : [];
    } catch (error) {
      console.error(`Error fetching availability for psychologist ${psychologistId} on ${date}:`, error);
      return [];
    }
  }

  /**
   * Check a single psychologist for conflicts
   */
  async checkPsychologistConflicts(psychologist) {
    const conflicts = [];

    try {
      if (!psychologist.google_calendar_credentials) {
        return conflicts;
      }

      const credentials = typeof psychologist.google_calendar_credentials === 'string'
        ? JSON.parse(psychologist.google_calendar_credentials)
        : psychologist.google_calendar_credentials;

      if (!credentials.access_token) {
        return conflicts;
      }

      // Get date range (next 21 days)
      const startDate = dayjs().tz('Asia/Kolkata').startOf('day');
      const endDate = startDate.add(21, 'days').endOf('day');

      // Get Google Calendar events
      const calendarResult = await googleCalendarService.getBusyTimeSlots(
        credentials,
        startDate.toDate(),
        endDate.toDate()
      );

      const calendarEvents = calendarResult.busySlots || [];
      // Filter out cancelled events and exclude certain event titles (like recurring meetings)
      const excludedEventTitles = ['Weekly Meeting', 'weekly meeting', 'WEEKLY MEETING'];
      const activeEvents = calendarEvents.filter(e => 
        e.status !== 'cancelled' && 
        !excludedEventTitles.some(excluded => e.title && e.title.includes(excluded))
      );

      // Check each day in the date range
      let currentDate = startDate;
      while (currentDate.isBefore(endDate)) {
        const dateStr = this.formatDate(currentDate);
        
        // Get availability slots for this date
        const availabilitySlots = await this.getAvailabilitySlots(psychologist.id, dateStr);
        
        // Get calendar events for this date (convert to IST first for accurate date comparison)
        const dayEvents = activeEvents.filter(event => {
          // Parse as UTC first, then convert to IST for accurate timezone handling
          const eventStartIST = dayjs(event.start).utc().tz('Asia/Kolkata');
          const eventDate = eventStartIST.format('YYYY-MM-DD');
          return eventDate === dateStr;
        });

        // Check if any availability slots conflict with calendar events
        for (const slot of availabilitySlots) {
          const slotTime = typeof slot === 'string' ? slot : slot.time || slot;
          
          if (this.isTimeSlotBlocked(slotTime, dayEvents, dateStr)) {
            // Find conflicting events
            const time24Hour = this.convertTo24Hour(slotTime);
            if (!time24Hour) continue; // Skip invalid times
            const [hours, minutes] = time24Hour.split(':').map(Number);
            // Parse the slot time directly in IST timezone (not convert to IST)
            const slotStart = dayjs.tz(`${dateStr} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`, 'Asia/Kolkata');
            const slotEnd = slotStart.add(60, 'minutes');
            
            const conflictingEvents = dayEvents.filter(event => {
              // Parse as UTC first, then convert to IST for accurate timezone handling
              const eventStart = dayjs(event.start).utc().tz('Asia/Kolkata');
              const eventEnd = dayjs(event.end).utc().tz('Asia/Kolkata');
              return slotStart.isBefore(eventEnd) && slotEnd.isAfter(eventStart);
            }).map(e => ({
              title: e.title,
              start: dayjs(e.start).utc().tz('Asia/Kolkata').format('HH:mm'),
              end: dayjs(e.end).utc().tz('Asia/Kolkata').format('HH:mm'),
              status: e.status || 'confirmed'
            }));
            
            if (conflictingEvents.length > 0) {
              conflicts.push({
                type: 'slot_not_blocked',
                date: dateStr,
                time: slotTime,
                time24Hour: time24Hour,
                issue: 'Availability slot is showing as available but has conflicting Google Calendar event',
                conflictingEvents: conflictingEvents
              });
            }
          }
        }

        // Reverse check: Calendar events that should block slots but might not be in availability
        // Exclude certain event titles (like recurring meetings)
        const excludedEventTitles = ['Weekly Meeting', 'weekly meeting', 'WEEKLY MEETING'];
        for (const event of dayEvents) {
          if (event.status === 'cancelled') continue;
          if (excludedEventTitles.some(excluded => event.title && event.title.includes(excluded))) continue;
          
          // Parse as UTC first, then convert to IST for accurate timezone handling
          const eventStart = dayjs(event.start).utc().tz('Asia/Kolkata');
          const eventEnd = dayjs(event.end).utc().tz('Asia/Kolkata');
          const eventStartTime = eventStart.format('HH:mm');
          const eventEndTime = eventEnd.format('HH:mm');
          
          // Check if this event time overlaps with any available slot
          const overlappingSlots = availabilitySlots.filter(slot => {
            const slotTime = typeof slot === 'string' ? slot : slot.time || slot;
            const time24Hour = this.convertTo24Hour(slotTime);
            if (!time24Hour) return false;
            
            const [hours, minutes] = time24Hour.split(':').map(Number);
            // Parse the slot time directly in IST timezone (not convert to IST)
            const slotStart = dayjs.tz(`${dateStr} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`, 'Asia/Kolkata');
            const slotEnd = slotStart.add(60, 'minutes');
            
            return slotStart.isBefore(eventEnd) && slotEnd.isAfter(eventStart);
          });
          
          if (overlappingSlots.length > 0) {
            conflicts.push({
              type: 'calendar_event_not_blocking',
              date: dateStr,
              eventTitle: event.title,
              eventStart: eventStartTime,
              eventEnd: eventEndTime,
              eventStatus: event.status || 'confirmed',
              issue: 'Google Calendar event exists but availability slots are still showing as available',
              overlappingSlots: overlappingSlots.map(s => typeof s === 'string' ? s : s.time || s)
            });
          }
        }

        currentDate = currentDate.add(1, 'day');
      }

    } catch (error) {
      console.error(`Error checking psychologist ${psychologist.email}:`, error);
    }

    return conflicts;
  }

  /**
   * Main function to check for conflicts
   */
  async checkForConflicts() {
    console.log('🔍 Checking for calendar sync conflicts...\n');

    try {
      // Get all psychologists with Google Calendar credentials
      const { data: psychologists, error } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, email, google_calendar_credentials')
        .not('google_calendar_credentials', 'is', null);

      if (error) {
        throw new Error(`Failed to fetch psychologists: ${error.message}`);
      }

      // Filter out assessment accounts
      const validPsychologists = (psychologists || []).filter(p => {
        const email = p.email?.toLowerCase() || '';
        return !email.includes('assessment') && !email.includes('koottassesment');
      });

      console.log(`📋 Found ${validPsychologists.length} psychologists with Google Calendar to check\n`);

      if (validPsychologists.length === 0) {
        console.log('✅ No psychologists with Google Calendar found - nothing to check');
        return;
      }

      let totalConflicts = 0;
      const psychologistsWithConflicts = [];

      // Step 1: Sync Google Calendar and block slots for each psychologist BEFORE checking conflicts
      console.log(`\n🔄 Step 1: Syncing Google Calendar and blocking slots...\n`);
      for (const psychologist of validPsychologists) {
        try {
          console.log(`🔄 Syncing calendar for: ${psychologist.first_name} ${psychologist.last_name} (ID: ${psychologist.id})...`);
          
          // Sync calendar events and block conflicting slots
          // syncPsychologistCalendar handles date range internally (21 days by default)
          await calendarSyncService.syncPsychologistCalendar(psychologist);
          
          console.log(`   ✅ Calendar synced and slots blocked`);
        } catch (syncError) {
          console.error(`   ⚠️  Error syncing calendar for ${psychologist.first_name} ${psychologist.last_name}:`, syncError.message);
          // Continue with conflict check even if sync fails
        }
      }

      // Step 2: Check for conflicts after syncing
      console.log(`\n🔍 Step 2: Checking for conflicts after sync...\n`);
      for (const psychologist of validPsychologists) {
        console.log(`🔍 Checking: ${psychologist.first_name} ${psychologist.last_name} (ID: ${psychologist.id})...`);
        
        const conflicts = await this.checkPsychologistConflicts(psychologist);
        
        if (conflicts.length > 0) {
          console.log(`   ⚠️  Found ${conflicts.length} conflict(s)`);
          totalConflicts += conflicts.length;
          psychologistsWithConflicts.push({
            psychologist,
            conflicts
          });
        } else {
          console.log(`   ✅ No conflicts found`);
        }
      }

      // Summary
      console.log(`\n${'='.repeat(80)}`);
      console.log(`📊 CHECK SUMMARY`);
      console.log(`${'='.repeat(80)}`);
      console.log(`✅ Psychologists Checked: ${validPsychologists.length}`);
      console.log(`⚠️  Psychologists with Conflicts: ${psychologistsWithConflicts.length}`);
      console.log(`🚨 Total Conflicts: ${totalConflicts}`);
      console.log(`${'='.repeat(80)}\n`);

    } catch (error) {
      console.error('❌ Error checking for conflicts:', error);
      throw error;
    }
  }

  /**
   * Manually trigger conflict check (for testing/admin use)
   */
  async triggerConflictCheck() {
    console.log('🔍 Manually triggering calendar conflict check...');
    await this.checkForConflicts();
  }

  /**
   * Stop the service
   */
  stop() {
    console.log('🛑 Stopping Calendar Conflict Monitor Service...');
    this.isRunning = false;
  }
}

// Export singleton instance
const dailyCalendarConflictAlert = new CalendarConflictMonitorService();

module.exports = dailyCalendarConflictAlert;
