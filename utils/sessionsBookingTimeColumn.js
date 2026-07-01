/**
 * Prefer sessions.booking_created_at when the column exists (post-migration).
 * Before migration, Postgres returns 42703 — fall back to created_at everywhere.
 */
let cachedKey = null;

async function getBookingTimeColumnKey(supabaseAdmin) {
  if (cachedKey) return cachedKey;
  const { error } = await supabaseAdmin.from('sessions').select('booking_created_at').limit(1);
  if (error?.code === '42703' || String(error?.message || '').includes('booking_created_at does not exist')) {
    cachedKey = 'created_at';
    console.warn(
      '[sessions] column booking_created_at is missing — using created_at. Apply supabase migration 20260501143000_sessions_booking_created_at.sql when ready.'
    );
    return cachedKey;
  }
  if (error) {
    console.warn('[sessions] could not probe booking_created_at:', error.message || error);
    cachedKey = 'created_at';
    return cachedKey;
  }
  cachedKey = 'booking_created_at';
  return cachedKey;
}

/** @param {'booking_created_at'|'created_at'} col */
function appendBookingTimeSelectFragment(col) {
  return col === 'booking_created_at' ? 'booking_created_at,' : '';
}

/**
 * Whether sessions.original_psychologist_id exists (post-migration
 * 20260701120000_session_original_psychologist.sql). Probed once and cached.
 */
let cachedHasOriginalPsych = null;

async function hasOriginalPsychologistColumn(supabaseAdmin) {
  if (cachedHasOriginalPsych != null) return cachedHasOriginalPsych;
  const { error } = await supabaseAdmin.from('sessions').select('original_psychologist_id').limit(1);
  if (error?.code === '42703' || String(error?.message || '').includes('does not exist')) {
    cachedHasOriginalPsych = false;
    console.warn(
      '[sessions] column original_psychologist_id is missing — "Transferred From" will not persist. Apply supabase migration 20260701120000_session_original_psychologist.sql.'
    );
    return cachedHasOriginalPsych;
  }
  cachedHasOriginalPsych = !error;
  return cachedHasOriginalPsych;
}

module.exports = {
  getBookingTimeColumnKey,
  appendBookingTimeSelectFragment,
  hasOriginalPsychologistColumn,
};
