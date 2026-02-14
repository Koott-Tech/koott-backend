/**
 * Helper for psychologist recurring availability blocks (e.g. block every Sunday).
 * Used when returning availability so blocked slots are excluded per psychologist.
 */

const { supabaseAdmin } = require('../config/supabase');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Get day of week from date string (YYYY-MM-DD). 0 = Sunday, 6 = Saturday (JavaScript convention).
 */
function getDayOfWeekFromDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  return d.getDay();
}

/**
 * Normalize time slot to 24h HH:MM for comparison.
 * Handles: "08:00", "8:00", "8:00 AM", "1:00 PM", "13:00", "21:00" etc.
 * Default availability stores 12h ("8:00 AM", "9:00 PM"); recurring blocks store 24h ("08:00", "21:00").
 */
function normalizeSlotTime(slot) {
  if (!slot) return null;
  const s = String(slot).trim();
  const match = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = match[2];
  const period = (match[3] || '').toUpperCase();

  if (period === 'PM' && h !== 12) h += 12;
  else if (period === 'AM' && h === 12) h = 0;
  else if (!period && h >= 0 && h <= 23) { /* already 24h */ }
  else if (!period && h >= 1 && h <= 12) { /* assume 24h if no AM/PM, leave as-is */ }

  const hStr = String(h).padStart(2, '0');
  return `${hStr}:${m}`;
}

/**
 * Normalize an array of time_slots for storage (24h, two-digit hours).
 * Use when saving recurring blocks so only intended slots are blocked (e.g. 08:00-16:00, not 20:00).
 */
function normalizeTimeSlotsForStorage(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const out = slots.map(normalizeSlotTime).filter(Boolean);
  return out.length ? out : null;
}

/**
 * Check if a time slot is blocked by recurring blocks for a given day of week.
 * @param {Array} recurringBlocks - From getRecurringBlocksForPsychologist
 * @param {number} dayOfWeek - 0-6 (Sunday-Saturday)
 * @param {string} timeSlot - e.g. "09:00" or "09:00:00"
 * @returns {boolean}
 */
function isSlotBlockedByRecurring(recurringBlocks, dayOfWeek, timeSlot) {
  if (!recurringBlocks || recurringBlocks.length === 0) return false;
  const block = recurringBlocks.find(b => b.day_of_week === dayOfWeek);
  if (!block) return false;
  if (block.block_entire_day) return true;
  const slots = block.time_slots || [];
  const normalized = normalizeSlotTime(timeSlot);
  if (!normalized) return false;
  return slots.some(s => normalizeSlotTime(s) === normalized);
}

/**
 * Fetch recurring blocks for a psychologist.
 * @param {string} psychologistId
 * @returns {Promise<Array>}
 */
async function getRecurringBlocksForPsychologist(psychologistId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('psychologist_recurring_blocks')
      .select('*')
      .eq('psychologist_id', psychologistId);

    if (error) {
      // Table may not exist yet (migration not run)
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return [];
      }
      console.error('Error fetching recurring blocks:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Error fetching recurring blocks:', err);
    return [];
  }
}

/**
 * Filter availability time_slots for a single day by recurring blocks.
 * @param {Array<string>} timeSlots - e.g. ["09:00", "10:00", ...]
 * @param {string} dateStr - YYYY-MM-DD
 * @param {Array} recurringBlocks - From getRecurringBlocksForPsychologist
 * @returns {Array<string>} Filtered slots (excluding blocked)
 */
function filterSlotsByRecurringBlocks(timeSlots, dateStr, recurringBlocks) {
  if (!timeSlots || timeSlots.length === 0) return [];
  if (!recurringBlocks || recurringBlocks.length === 0) return timeSlots;

  const dayOfWeek = getDayOfWeekFromDate(dateStr);
  if (dayOfWeek == null) return timeSlots;

  return timeSlots.filter(slot => !isSlotBlockedByRecurring(recurringBlocks, dayOfWeek, slot));
}

/**
 * Get day name for display (0 -> "Sunday", etc.).
 */
function getDayName(dayOfWeek) {
  return DAYS[dayOfWeek] ?? '';
}

module.exports = {
  getDayOfWeekFromDate,
  normalizeSlotTime,
  normalizeTimeSlotsForStorage,
  isSlotBlockedByRecurring,
  getRecurringBlocksForPsychologist,
  filterSlotsByRecurringBlocks,
  getDayName,
  DAYS
};
