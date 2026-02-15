const { supabaseAdmin } = require('../config/supabase');
const { getRecurringBlocksForPsychologist, filterSlotsByRecurringBlocks } = require('./recurringBlocksHelper');

/**
 * Generate default time slots: continuous 1-hour slots from 8:00 AM to 10:00 PM IST
 * (sessions are 1 hour each, so 8:00 AM means 8:00–9:00, 9:00 AM means 9:00–10:00, etc.)
 * Returns array of time strings in 12-hour format (e.g. "8:00 AM", "1:00 PM").
 *
 * Daily availability (addNextDayAvailability) uses these slots. Exact list added per day:
 * 8:00 AM, 9:00 AM, 10:00 AM, 11:00 AM, 12:00 PM, 1:00 PM, 2:00 PM, 3:00 PM,
 * 4:00 PM, 5:00 PM, 6:00 PM, 7:00 PM, 8:00 PM, 9:00 PM (14 slots; last ends at 10:00 PM).
 */
const generateDefaultTimeSlots = () => {
  const slots = [];

  // Generate 1-hour slots from 08:00 to 22:00 (end exclusive)
  // i.e. last slot starts at 21:00 and ends at 22:00 (10 PM)
  for (let hour = 8; hour < 22; hour++) {
    const period = hour < 12 ? 'AM' : 'PM';
    let displayHour = hour % 12;
    if (displayHour === 0) displayHour = 12; // 0 -> 12 AM/PM

    const label = `${displayHour}:00 ${period}`;
    slots.push(label);
  }

  return slots;
};

/**
 * Generate availability records for a date range
 * @param {string} psychologistId - The psychologist ID
 * @param {Date} startDate - Start date (inclusive)
 * @param {Date} endDate - End date (inclusive)
 * @returns {Array} Array of availability records
 */
const generateAvailabilityRecords = (psychologistId, startDate, endDate) => {
  const records = [];
  const timeSlots = generateDefaultTimeSlots();
  const currentDate = new Date(startDate);
  
  while (currentDate <= endDate) {
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const day = String(currentDate.getDate()).padStart(2, '0');
    const dateString = `${year}-${month}-${day}`;
    
    records.push({
      psychologist_id: psychologistId,
      date: dateString,
      time_slots: timeSlots,
      is_available: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return records;
};

/**
 * Set default availability for a psychologist (3 weeks from today)
 * @param {string} psychologistId - The psychologist ID
 * @returns {Promise<Object>} Result object with success status and message
 */
const setDefaultAvailability = async (psychologistId) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Calculate end date (3 weeks from today)
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 21); // 3 weeks = 21 days
    
    // Generate availability records
    let availabilityRecords = generateAvailabilityRecords(psychologistId, today, endDate);
    
    if (availabilityRecords.length === 0) {
      return { success: false, message: 'No availability records to create' };
    }
    
    // Apply recurring blocks so blocked days have empty/reduced slots (DB reflects blocked days for Wix etc.)
    const recurringBlocks = await getRecurringBlocksForPsychologist(psychologistId);
    availabilityRecords = availabilityRecords.map((r) => ({
      ...r,
      time_slots: filterSlotsByRecurringBlocks(r.time_slots, r.date, recurringBlocks)
    }));
    
    // Check which dates already exist
    const existingDates = new Set();
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: existingAvailability } = await supabaseAdmin
      .from('availability')
      .select('date')
      .eq('psychologist_id', psychologistId)
      .gte('date', today.toISOString().split('T')[0])
      .lte('date', endDate.toISOString().split('T')[0]);
    
    if (existingAvailability) {
      existingAvailability.forEach(avail => {
        existingDates.add(avail.date);
      });
    }
    
    // Filter out dates that already exist
    const newRecords = availabilityRecords.filter(record => !existingDates.has(record.date));
    
    if (newRecords.length === 0) {
      return { success: true, message: 'All dates already have availability', created: 0 };
    }
    
    // Insert new availability records
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { error: insertError } = await supabaseAdmin
      .from('availability')
      .insert(newRecords);
    
    if (insertError) {
      console.error('Error inserting default availability:', insertError);
      return { success: false, message: 'Failed to create default availability', error: insertError };
    }
    
    console.log(`✅ Created ${newRecords.length} default availability records for psychologist ${psychologistId}`);
    return { success: true, message: `Created ${newRecords.length} availability records`, created: newRecords.length };
    
  } catch (error) {
    console.error('Error setting default availability:', error);
    return { success: false, message: 'Error setting default availability', error: error.message };
  }
};

/**
 * Add next day availability (called daily at 12 AM)
 * Adds availability for the day that is 3 weeks from today
 * @returns {Promise<Object>} Result object
 */
const addNextDayAvailability = async () => {
  try {
    // Get all active psychologists
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: psychologists, error: psychError } = await supabaseAdmin
      .from('psychologists')
      .select('id');
    
    if (psychError) {
      console.error('Error fetching psychologists:', psychError);
      return { success: false, message: 'Failed to fetch psychologists' };
    }
    
    if (!psychologists || psychologists.length === 0) {
      return { success: true, message: 'No psychologists found', updated: 0 };
    }
    
    // Calculate the date that is 3 weeks from today
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 21);
    targetDate.setHours(0, 0, 0, 0);
    
    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, '0');
    const day = String(targetDate.getDate()).padStart(2, '0');
    const dateString = `${year}-${month}-${day}`;
    
    const defaultTimeSlots = generateDefaultTimeSlots();
    let successCount = 0;
    let skipCount = 0;
    
    // Add availability for each psychologist (apply recurring blocks so blocked days have empty/reduced slots)
    for (const psych of psychologists) {
      // Check if availability already exists for this date
      const { data: existing } = await supabaseAdmin
        .from('availability')
        .select('id')
        .eq('psychologist_id', psych.id)
        .eq('date', dateString)
        .single();
      
      if (existing) {
        skipCount++;
        continue;
      }
      
      // Apply recurring blocks: full-day block -> empty slots; partial block -> filtered slots; no block -> full default
      const recurringBlocks = await getRecurringBlocksForPsychologist(psych.id);
      const timeSlotsToInsert = filterSlotsByRecurringBlocks([...defaultTimeSlots], dateString, recurringBlocks);
      
      const { error: insertError } = await supabaseAdmin
        .from('availability')
        .insert({
          psychologist_id: psych.id,
          date: dateString,
          time_slots: timeSlotsToInsert,
          is_available: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error(`Error adding availability for psychologist ${psych.id}:`, insertError);
      } else {
        successCount++;
      }
    }
    
    console.log(`✅ Daily availability update: ${successCount} added, ${skipCount} skipped`);
    return { 
      success: true, 
      message: `Updated ${successCount} psychologists, ${skipCount} already had availability`,
      updated: successCount,
      skipped: skipCount
    };
    
  } catch (error) {
    console.error('Error in addNextDayAvailability:', error);
    return { success: false, message: 'Error adding next day availability', error: error.message };
  }
};

/**
 * Clean up past availability records
 * Removes all availability records for dates before today
 * This should be run daily to prevent database bloat
 * @returns {Promise<Object>} Result object with deletion count
 */
const cleanupPastAvailability = async () => {
  try {
    // Get today's date in YYYY-MM-DD format
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    
    console.log(`🧹 Starting cleanup of past availability records (before ${todayStr})...`);
    
    // Count records before deletion (for logging)
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { count: totalCount, error: countError } = await supabaseAdmin
      .from('availability')
      .select('id', { count: 'exact', head: true })
      .lt('date', todayStr);
    
    if (countError) {
      console.error('Error counting past availability records:', countError);
      // Continue with deletion even if count fails
      console.log('⚠️  Could not count records, proceeding with deletion...');
    }
    
    if (totalCount === 0) {
      console.log('✅ No past availability records to clean up');
      return { 
        success: true, 
        message: 'No past availability records found',
        deleted: 0 
      };
    }
    
    console.log(`   Found ${totalCount} past availability records to delete`);
    
    // Delete records in batches to avoid timeout with large datasets
    const batchSize = 500;
    let deletedCount = 0;
    let hasMore = true;
    let offset = 0;
    
    while (hasMore) {
      // Get batch of IDs to delete
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: batch, error: fetchError } = await supabaseAdmin
        .from('availability')
        .select('id')
        .lt('date', todayStr)
        .range(offset, offset + batchSize - 1);
      
      if (fetchError) {
        console.error('Error fetching batch for deletion:', fetchError);
        return { success: false, message: 'Failed to fetch records for deletion', error: fetchError };
      }
      
      if (!batch || batch.length === 0) {
        hasMore = false;
        break;
      }
      
      // Delete this batch
      const idsToDelete = batch.map(record => record.id);
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { error: deleteError } = await supabaseAdmin
        .from('availability')
        .delete()
        .in('id', idsToDelete);
      
      if (deleteError) {
        console.error('Error deleting batch:', deleteError);
        return { success: false, message: 'Failed to delete batch', error: deleteError };
      }
      
      deletedCount += batch.length;
      offset += batchSize;
      
      // Log progress every 500 records
      if (deletedCount % 500 === 0) {
        console.log(`   🧹 Deleted ${deletedCount} records...`);
      }
      
      // If batch is smaller than batchSize, we're done
      if (batch.length < batchSize) {
        hasMore = false;
      }
    }
    
    console.log(`✅ Cleanup completed: Deleted ${deletedCount} past availability records`);
    return {
      success: true,
      message: `Successfully deleted ${deletedCount} past availability records`,
      deleted: deletedCount
    };
    
  } catch (error) {
    console.error('Error in cleanupPastAvailability:', error);
    return { 
      success: false, 
      message: 'Error cleaning up past availability', 
      error: error.message 
    };
  }
};

/**
 * Update all existing psychologists with default availability
 * @returns {Promise<Object>} Result object
 */
const updateAllPsychologistsAvailability = async () => {
  try {
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { data: psychologists, error: psychError } = await supabaseAdmin
      .from('psychologists')
      .select('id');
    
    if (psychError) {
      console.error('Error fetching psychologists:', psychError);
      return { success: false, message: 'Failed to fetch psychologists' };
    }
    
    if (!psychologists || psychologists.length === 0) {
      return { success: true, message: 'No psychologists found', updated: 0 };
    }
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const psych of psychologists) {
      const result = await setDefaultAvailability(psych.id);
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
        console.error(`Failed to set availability for psychologist ${psych.id}:`, result.message);
      }
    }
    
    return {
      success: true,
      message: `Updated ${successCount} psychologists, ${errorCount} errors`,
      updated: successCount,
      errors: errorCount
    };
    
  } catch (error) {
    console.error('Error updating all psychologists availability:', error);
    return { success: false, message: 'Error updating all psychologists', error: error.message };
  }
};

/**
 * Sync future availability rows for a psychologist for a given day-of-week to match recurring blocks.
 * Called when a recurring block is added/updated (so blocked days get empty/reduced slots in DB)
 * or deleted (so that day gets default slots back).
 * @param {string} psychologistId - Psychologist ID
 * @param {number} dayOfWeek - 0-6 (Sunday-Saturday)
 * @param {{ useDefaultSlots?: boolean }} options - If true (e.g. after block delete), refill from default slots; else filter existing slots
 * @returns {Promise<{ updated: number }>}
 */
const syncFutureAvailabilityForRecurringBlockDay = async (psychologistId, dayOfWeek, options = {}) => {
  const { useDefaultSlots = false } = options;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    const recurringBlocks = await getRecurringBlocksForPsychologist(psychologistId);
    const defaultSlots = generateDefaultTimeSlots();
    const { data: rows, error } = await supabaseAdmin
      .from('availability')
      .select('id, date, time_slots')
      .eq('psychologist_id', psychologistId)
      .gte('date', todayStr);
    if (error || !rows || rows.length === 0) return { updated: 0 };
    const getDayOfWeek = (dateStr) => {
      const d = new Date(dateStr + 'T12:00:00');
      return Number.isNaN(d.getTime()) ? null : d.getDay();
    };
    let updated = 0;
    for (const row of rows) {
      if (getDayOfWeek(row.date) !== dayOfWeek) continue;
      const baseSlots = useDefaultSlots ? defaultSlots : (row.time_slots || []);
      const newSlots = filterSlotsByRecurringBlocks(baseSlots, row.date, recurringBlocks);
      if (JSON.stringify(newSlots) === JSON.stringify(row.time_slots || [])) continue;
      const { error: updateErr } = await supabaseAdmin
        .from('availability')
        .update({ time_slots: newSlots, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!updateErr) updated++;
    }
    return { updated };
  } catch (err) {
    console.error('Error syncing future availability for recurring block day:', err);
    return { updated: 0 };
  }
};

module.exports = {
  generateDefaultTimeSlots,
  generateAvailabilityRecords,
  setDefaultAvailability,
  addNextDayAvailability,
  cleanupPastAvailability,
  updateAllPsychologistsAvailability,
  syncFutureAvailabilityForRecurringBlockDay
};

