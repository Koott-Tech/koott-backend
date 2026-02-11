const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const googleCalendarService = require('../utils/googleCalendarService');

class CalendarSyncService {
  constructor() {
    this.isRunning = false;
    // Track last sync time per psychologist to avoid unnecessary syncs
    this.lastSyncTimes = new Map();
    // Sync interval in minutes (configurable via env, default 15 minutes)
    this.syncIntervalMinutes = parseInt(process.env.CALENDAR_SYNC_INTERVAL_MINUTES) || 15;
  }

  /**
   * Start the calendar sync service
   * Runs at configurable intervals (default 15 minutes) to sync Google Calendar events
   * Optimized to reduce server load by staggering syncs and skipping recently synced psychologists
   */
  start() {
    console.log(`🔄 Starting Google Calendar sync service (interval: ${this.syncIntervalMinutes} minutes)...`);
    
    // Run at configurable interval (default 15 minutes - good balance between responsiveness and server load)
    cron.schedule(`*/${this.syncIntervalMinutes} * * * *`, async () => {
      if (this.isRunning) {
        console.log('⏭️  Calendar sync already running, skipping...');
        return;
      }
      
      await this.syncAllPsychologists();
    });

    // Also run immediately on startup
    setTimeout(() => {
      this.syncAllPsychologists();
    }, 5000); // Wait 5 seconds after startup
  }

  /**
   * Sync calendar events for all psychologists with Google Calendar credentials
   */
  async syncAllPsychologists() {
    this.isRunning = true;
    console.log('🔄 Starting calendar sync for all psychologists...');

    try {
      // Get all psychologists with Google Calendar credentials
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: psychologists, error } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, google_calendar_credentials')
        .not('google_calendar_credentials', 'is', null);

      if (error) {
        console.error('Error fetching psychologists:', error);
        return;
      }

      if (!psychologists || psychologists.length === 0) {
        console.log('ℹ️  No psychologists with Google Calendar credentials found');
        return;
      }

      console.log(`📅 Found ${psychologists.length} psychologists with Google Calendar credentials`);

      const syncResults = [];
      const errors = [];
      const skipped = [];

      // OPTIMIZATION: Process psychologists in parallel batches (concurrency limit: 3)
      // This is faster than sequential but still respects rate limits
      const concurrencyLimit = 3;
      const now = Date.now();
      const fiveMinutesAgo = now - (5 * 60 * 1000);
      
      // Filter out recently synced psychologists first
      const psychologistsToSync = psychologists.filter(psychologist => {
        const lastSync = this.lastSyncTimes.get(psychologist.id);
        if (lastSync && lastSync > fiveMinutesAgo) {
          const minutesSinceSync = Math.floor((now - lastSync) / (60 * 1000));
          skipped.push({
            psychologist: `${psychologist.first_name} ${psychologist.last_name}`,
            reason: `Synced ${minutesSinceSync} minutes ago`
          });
          return false;
        }
        return true;
      });
      
      // Process in batches with concurrency limit
      for (let i = 0; i < psychologistsToSync.length; i += concurrencyLimit) {
        const batch = psychologistsToSync.slice(i, i + concurrencyLimit);
        
        // Process batch in parallel
        const batchPromises = batch.map(async (psychologist) => {
          try {
            const result = await this.syncPsychologistCalendar(psychologist);
            this.lastSyncTimes.set(psychologist.id, now);
            return { success: true, result };
          } catch (error) {
            console.error(`❌ Error syncing calendar for ${psychologist.first_name} ${psychologist.last_name}:`, error.message);
            return { 
              success: false, 
              psychologist: `${psychologist.first_name} ${psychologist.last_name}`,
              error: error.message 
            };
          }
        });
        
        const batchResults = await Promise.all(batchPromises);
        
        // Process results
        batchResults.forEach((batchResult) => {
          if (batchResult.success) {
            syncResults.push(batchResult.result);
          } else {
            errors.push({
              psychologist: batchResult.psychologist,
              error: batchResult.error
            });
          }
        });
        
        // Small delay between batches (reduced from 2s per psychologist to 1s per batch)
        if (i + concurrencyLimit < psychologistsToSync.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log(`✅ Calendar sync completed. ${syncResults.length} successful, ${skipped.length} skipped, ${errors.length} errors`);
      
      if (errors.length > 0) {
        console.error('❌ Sync errors:', errors);
      }
      
      if (skipped.length > 0) {
        console.log(`ℹ️  Skipped ${skipped.length} psychologists (recently synced)`);
      }

    } catch (error) {
      console.error('❌ Error in calendar sync service:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Sync calendar events for a specific psychologist
   * @param {Object} psychologist - Psychologist object with Google Calendar credentials
   */
  async syncPsychologistCalendar(psychologist) {
    // OPTIMIZATION: Use incremental sync with sync tokens
    // Get stored sync token from credentials (if exists)
    const storedSyncToken = psychologist.google_calendar_credentials?.syncToken || null;
    
    // Date range only needed for full sync (when no sync token)
    // Sync for 3 weeks (21 days) to match availability window - daily availability service maintains 3 weeks
    const syncDays = parseInt(process.env.CALENDAR_SYNC_DAYS) || 21;
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + syncDays);
    endDate.setHours(23, 59, 59, 999);

    // Sync calendar events (incremental if sync token exists, full sync otherwise)
    const syncResult = await googleCalendarService.syncCalendarEvents(
      psychologist,
      startDate,
      endDate,
      storedSyncToken
    );
    
    // Store the next sync token for future incremental syncs
    if (syncResult.success && syncResult.nextSyncToken) {
      try {
        // Update sync token in google_calendar_credentials
        const updatedCredentials = {
          ...psychologist.google_calendar_credentials,
          syncToken: syncResult.nextSyncToken,
          lastSyncAt: new Date().toISOString()
        };
        
        // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
        const { error: updateError } = await supabaseAdmin
          .from('psychologists')
          .update({ 
            google_calendar_credentials: updatedCredentials
          })
          .eq('id', psychologist.id);
        
        if (updateError) {
          console.error(`❌ Failed to update credentials for psychologist ${psychologist.id}:`, updateError);
          throw updateError;
        }
        
        // Removed verbose sync logs - only keep summary at the end
      } catch (tokenError) {
        console.error(`⚠️ Failed to store sync token for ${psychologist.first_name} ${psychologist.last_name}:`, tokenError.message);
        throw tokenError;
      }
    }

    if (!syncResult.success) {
      // Handle sync token expiration (410 error) - clear token and retry with full sync
      if (syncResult.error && (syncResult.error.includes('410') || syncResult.error.includes('Sync token'))) {
        console.warn(`⚠️ Sync token expired for ${psychologist.first_name} ${psychologist.last_name}, clearing token and doing full sync`);
        
        // Clear sync token from credentials
        try {
          const clearedCredentials = { ...psychologist.google_calendar_credentials };
          delete clearedCredentials.syncToken;
          
          // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
          const { data: clearData, error: clearError, count } = await supabaseAdmin
            .from('psychologists')
            .update({ google_calendar_credentials: clearedCredentials })
            .eq('id', psychologist.id)
            .select('id');
          
          if (clearError) {
            console.error('❌ Error clearing sync token:', {
              psychologistId: psychologist.id,
              error: clearError.message,
              code: clearError.code,
              details: clearError
            });
            throw clearError; // Re-throw to be caught by outer catch
          } else if (!clearData || (count !== undefined && count === 0)) {
            console.warn('⚠️ Clear sync token update returned no rows:', {
              psychologistId: psychologist.id
            });
          }
        } catch (clearError) {
          console.error('❌ Failed to clear sync token:', {
            psychologistId: psychologist.id,
            error: clearError.message || clearError,
            code: clearError.code
          });
          // Continue with retry even if clearing failed
        }
        
        // Retry with full sync (no sync token)
        const retryResult = await googleCalendarService.syncCalendarEvents(
          psychologist,
          startDate,
          endDate,
          null // Full sync
        );
        
        if (retryResult.success && retryResult.nextSyncToken) {
          // Store new sync token
          const updatedCredentials = {
            ...psychologist.google_calendar_credentials,
            syncToken: retryResult.nextSyncToken,
            lastSyncAt: new Date().toISOString()
          };
          
          // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
          const { data: updateData, error: updateError } = await supabaseAdmin
            .from('psychologists')
            .update({ google_calendar_credentials: updatedCredentials })
            .eq('id', psychologist.id)
            .select('id');
          
          if (updateError) {
            console.error('❌ Error updating sync token:', {
              psychologistId: psychologist.id,
              error: updateError.message,
              code: updateError.code,
              details: updateError
            });
            // Continue processing but log the error
          } else if (!updateData || updateData.length === 0) {
            console.warn('⚠️ Sync token update returned no rows:', {
              psychologistId: psychologist.id
            });
          }
        }
        
        // Use retry result
        if (!retryResult.success) {
          throw new Error(retryResult.error);
        }
        
        // Continue with retry result
        return this.processSyncResult(psychologist, retryResult);
      }
      
      // Handle token expiration gracefully
      if (syncResult.error && syncResult.error.includes('expired')) {
        console.warn('⚠️ Google Calendar sync skipped due to expired tokens for psychologist:', psychologist.email);
        console.warn('💡 Psychologist needs to reconnect Google Calendar in settings');
        return {
          success: true,
          message: 'Calendar sync skipped - Google Calendar connection expired',
          blockedSlots: [],
          errors: ['Google Calendar connection has expired. Please reconnect in settings.']
        };
      }
      throw new Error(syncResult.error);
    }
    
    return this.processSyncResult(psychologist, syncResult);
  }

  /**
   * Process sync result and block conflicting slots
   * @param {Object} psychologist - Psychologist object
   * @param {Object} syncResult - Sync result from googleCalendarService
   * @returns {Promise<Object>} Processed sync result
   */
  async processSyncResult(psychologist, syncResult) {

    // Helper function to normalize time format to HH:MM (24-hour)
    const normalizeTimeTo24Hour = (timeStr) => {
      if (!timeStr) return null;
      
      // If already in HH:MM format (24-hour), return as is
      const hhmmMatch = String(timeStr).match(/^(\d{1,2}):(\d{2})$/);
      if (hhmmMatch) {
        return `${hhmmMatch[1].padStart(2, '0')}:${hhmmMatch[2]}`;
      }
      
      // If in HH:MM-HH:MM format, extract first part
      const rangeMatch = String(timeStr).match(/^(\d{1,2}):(\d{2})-/);
      if (rangeMatch) {
        return `${rangeMatch[1].padStart(2, '0')}:${rangeMatch[2]}`;
      }
      
      // If in 12-hour format (e.g., "2:30 PM" or "2:30PM")
      const ampmMatch = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (ampmMatch) {
        let hours = parseInt(ampmMatch[1], 10);
        const minutes = ampmMatch[2];
        const period = ampmMatch[3].toUpperCase();
        
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        
        return `${hours.toString().padStart(2, '0')}:${minutes}`;
      }
      
      // Try to extract HH:MM from any string
      const extractMatch = String(timeStr).match(/(\d{1,2}):(\d{2})/);
      if (extractMatch) {
        return `${extractMatch[1].padStart(2, '0')}:${extractMatch[2]}`;
      }
      
      return null;
    };

    // OPTIMIZATION: Batch fetch all availability records at once instead of one-by-one
    // Get all unique dates from events first
    const eventDates = new Set();
    const eventData = [];
    
    // Helper function to convert UTC date to IST (Asia/Kolkata)
    const toIST = (date) => {
      if (!date) return null;
      // Convert to IST timezone explicitly
      const istString = new Date(date).toLocaleString('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      
      // Parse the IST string back to components
      const [datePart, timePart] = istString.split(', ');
      const [month, day, year] = datePart.split('/');
      const [hour, minute, second] = timePart.split(':');
      
      // Create date string in YYYY-MM-DD format
      const dateStr = `${year}-${month}-${day}`;
      
      // Get time components as numbers
      const hourNum = parseInt(hour, 10);
      const minuteNum = parseInt(minute, 10);
      
      return {
        dateStr,
        year,
        month,
        day,
        hour: hourNum,
        minute: minuteNum,
        minutesFromMidnight: hourNum * 60 + minuteNum
      };
    };

    for (const event of syncResult.externalEvents) {
      try {
        // Convert event start and end times to IST explicitly
        const eventStartIST = toIST(event.start);
        const eventEndIST = toIST(event.end);
        
        if (!eventStartIST || !eventEndIST) {
          console.warn(`⚠️ Could not convert event "${event.title}" to IST`);
          continue;
        }
        
        const eventDate = eventStartIST.dateStr;
        const eventStartMinutes = eventStartIST.minutesFromMidnight;
        let eventEndMinutes = eventEndIST.minutesFromMidnight;
        
        // Handle events that span midnight or multiple days (use IST date strings for correct day boundaries)
        const startDateStr = eventStartIST.dateStr;
        const endDateStr = eventEndIST.dateStr;
        const isMultiDayEvent = startDateStr !== endDateStr;
        
        if (isMultiDayEvent) {
          // Multi-day event: need to process for both start date and end date
          // For start date: event blocks from start time until end of day (23:59)
          // For end date: event blocks from start of day (00:00) until end time
          
          // Process start date
          const startDateEndMinutes = 24 * 60 - 1; // End of day (23:59)
          eventDates.add(eventStartIST.dateStr);
          eventData.push({
            date: eventStartIST.dateStr,
            time: `${String(eventStartIST.hour).padStart(2, '0')}:${String(eventStartIST.minute).padStart(2, '0')}`,
            title: event.title,
            startMinutes: eventStartMinutes, // Minutes from midnight (0-1439) in IST
            endMinutes: startDateEndMinutes, // Block until end of day
            startTime: new Date(event.start),
            endTime: new Date(event.end),
            isMultiDay: true,
            isStartDate: true
          });
          
          // Process end date (if different from start date)
          if (eventEndIST.dateStr !== eventStartIST.dateStr) {
            const endDateStartMinutes = 0; // Start of day (00:00)
            eventDates.add(eventEndIST.dateStr);
            eventData.push({
              date: eventEndIST.dateStr,
              time: `00:00`,
              title: event.title,
              startMinutes: endDateStartMinutes, // Block from start of day
              endMinutes: eventEndIST.minutesFromMidnight, // Until event end time
              startTime: new Date(event.start),
              endTime: new Date(event.end),
              isMultiDay: true,
              isStartDate: false
            });
          }
        } else {
          // Single-day event
          let normalizedEndMinutes = eventEndMinutes;
          let spansMidnight = false;
          
          if (eventEndMinutes < eventStartMinutes) {
            // Event spans midnight on same day (unusual but possible)
            spansMidnight = true;
            normalizedEndMinutes = eventEndMinutes + (24 * 60);
          }
        
          eventDates.add(eventDate);
          eventData.push({
            date: eventDate,
            time: `${String(eventStartIST.hour).padStart(2, '0')}:${String(eventStartIST.minute).padStart(2, '0')}`,
            title: event.title,
            startMinutes: eventStartMinutes, // Minutes from midnight (0-1439) in IST
            endMinutes: eventEndMinutes, // Keep original 0-1439 range
            normalizedEndMinutes: normalizedEndMinutes, // For overlap calculations when spans midnight
            spansMidnight: spansMidnight,
            startTime: new Date(event.start),
            endTime: new Date(event.end),
            isMultiDay: false
          });
        }
      } catch (error) {
        console.error(`Error processing event "${event.title}":`, error);
        continue; // Skip invalid events
      }
    }
    
    // Batch fetch all availability records for all dates at once
    const availabilityMap = new Map();
    if (eventDates.size > 0) {
      const datesArray = Array.from(eventDates);
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: availabilityRecords, error: availError } = await supabaseAdmin
        .from('availability')
        .select('id, date, time_slots')
        .eq('psychologist_id', psychologist.id)
        .in('date', datesArray);
      
      if (availError) {
        console.error(`⚠️ Error batch fetching availability:`, availError.message);
      } else if (availabilityRecords) {
        // Create a map for O(1) lookup
        availabilityRecords.forEach(avail => {
          availabilityMap.set(avail.date, avail);
        });
      }
    }
    
    // Process events and collect updates
    const blockedSlots = [];
    const errors = [];
    const updatesToApply = new Map(); // Map of availability.id -> updated time_slots
    
    for (const eventInfo of eventData) {
      try {
        const availability = availabilityMap.get(eventInfo.date);
        
        if (!availability) {
          // Removed verbose log - no availability record is expected for some dates
          continue; // No availability record for this date
        }
        
        // Check if we already have an update pending for this availability record
        let currentSlots = updatesToApply.has(availability.id) 
          ? updatesToApply.get(availability.id)
          : [...availability.time_slots];
        
        // Helper function to convert slot time to minutes from midnight
        const slotToMinutes = (slotStr) => {
          const normalizedSlot = normalizeTimeTo24Hour(slotStr);
          if (!normalizedSlot) {
            // Removed verbose log - slot normalization errors are handled silently
            return null;
          }
          
          const [hours, minutes] = normalizedSlot.split(':').map(Number);
          return hours * 60 + minutes;
        };
        
        // Remove ALL conflicting time slots that fall within the event duration
        const slotsToBlock = [];
        const updatedSlots = currentSlots.filter(slot => {
          const slotMinutes = slotToMinutes(slot);
          
          if (slotMinutes === null) {
            return true; // Keep slots we can't parse (shouldn't happen)
          }
          
          // Check if slot overlaps with event duration
          // Slots are typically 1 hour long (60 minutes)
          // We need to check if the slot INTERVAL overlaps with the event INTERVAL
          // Slot: [slotMinutes, slotMinutes + 60)
          // Event: [eventInfo.startMinutes, effectiveEnd)
          // Overlap occurs if: slotStart < eventEnd AND slotEnd > eventStart
          const SLOT_DURATION_MINUTES = 60; // 1-hour slots
          const slotEndMinutes = slotMinutes + SLOT_DURATION_MINUTES;
          
          // Use effective end minutes for midnight-spanning events
          const effectiveEnd = eventInfo.spansMidnight && eventInfo.normalizedEndMinutes !== undefined
            ? eventInfo.normalizedEndMinutes
            : eventInfo.endMinutes;
          
          const overlaps = slotMinutes < effectiveEnd && slotEndMinutes > eventInfo.startMinutes;
          
          if (overlaps) {
            slotsToBlock.push({
              slot,
              slotMinutes,
              eventStart: eventInfo.startMinutes,
              eventEnd: effectiveEnd
            });
            return false; // Remove this slot
          }
          
          return true; // Keep this slot
        });
        
        if (slotsToBlock.length > 0) {
          updatesToApply.set(availability.id, updatedSlots);
          
          // Add all blocked slots to the report
          slotsToBlock.forEach(({ slot }) => {
            blockedSlots.push({
              date: eventInfo.date,
              time: slot,
              reason: eventInfo.title
            });
          });
          
          // Removed verbose slot-by-slot logs - only keep summary at the end
        }
      } catch (error) {
        console.error(`Error processing event "${eventInfo.title}":`, error);
        errors.push({
          event: eventInfo.title,
          error: error.message
        });
      }
    }
    
    // OPTIMIZATION: Batch update all availability records at once
    if (updatesToApply.size > 0) {
      const updatePromises = [];
      const now = new Date().toISOString();
      
      for (const [availabilityId, updatedSlots] of updatesToApply.entries()) {
        // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
        updatePromises.push(
          supabaseAdmin
            .from('availability')
            .update({ 
              time_slots: updatedSlots,
              updated_at: now
            })
            .eq('id', availabilityId)
        );
      }
      
      // Execute all updates in parallel
      await Promise.all(updatePromises);
      
      if (blockedSlots.length > 0) {
        // Summary log only (no verbose details)
        console.log(`✅ Blocked ${blockedSlots.length} time slot(s) across ${updatesToApply.size} date(s) for ${psychologist.first_name} ${psychologist.last_name}`);
      }
    }

    return {
      psychologistId: psychologist.id,
      psychologistName: `${psychologist.first_name} ${psychologist.last_name}`,
      syncedAt: syncResult.syncedAt,
      totalExternalEvents: syncResult.externalEvents.length,
      blockedSlots: blockedSlots,
      errors: errors
    };
  }

  /**
   * Manually sync a specific psychologist's calendar
   * @param {string} psychologistId - Psychologist ID
   * @param {Date} startDate - Start date for sync
   * @param {Date} endDate - End date for sync
   */
  async syncPsychologistById(psychologistId, startDate, endDate) {
    try {
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: psychologist, error } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, google_calendar_credentials')
        .eq('id', psychologistId)
        .single();

      if (error || !psychologist) {
        throw new Error('Psychologist not found');
      }

      if (!psychologist.google_calendar_credentials) {
        throw new Error('Psychologist has no Google Calendar credentials');
      }

      const result = await this.syncPsychologistCalendar(psychologist);
      
      // Update last sync time for manual syncs too
      this.lastSyncTimes.set(psychologistId, Date.now());
      
      return result;
    } catch (error) {
      console.error(`Error syncing psychologist ${psychologistId}:`, error);
      throw error;
    }
  }

  /**
   * Stop the calendar sync service
   */
  stop() {
    console.log('🛑 Stopping Google Calendar sync service...');
    cron.destroy();
  }
}

module.exports = new CalendarSyncService();
