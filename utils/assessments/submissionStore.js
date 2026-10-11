/**
 * Persistence for completed assessment questionnaires.
 *
 * Storing the submission is what makes the Kalyana Raman couple comparison possible: the two
 * partners answer at different times, so the first partner's responses have to survive until
 * the second one finishes. It also gives the practice a record of what was actually answered,
 * which the consent form already tells the client is kept.
 *
 * Everything here fails soft. A submission that cannot be stored must still produce the report
 * and reach the psychologist - losing the client's twenty minutes of work because a database
 * call failed is a far worse outcome than a missing row.
 */
const { supabaseAdmin } = require('../../config/supabase');

const TABLE = 'assessment_submissions';

/** Kalyana Raman pairs two submissions; the code is what links them. */
function makeCoupleCode() {
  // No 0/O/1/I: this gets read off a screen and typed by the other partner.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Record one submission. Returns the stored row's id, or null when storage was unavailable -
 * callers must treat null as "carry on", never as a failure.
 */
async function save({ assessment, participant, answers, scores = null, consent = null,
                      partner = null, coupleCode = null }) {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .insert({
        assessment,
        partner,
        couple_code: coupleCode,
        name: participant.name,
        email: participant.email,
        phone: participant.phone,
        dob: participant.dob,
        sex: participant.sex,
        address: participant.address,
        assessment_date: participant.date,
        answers,
        scores,
        consent,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  } catch (e) {
    console.error(`[assessments/store] could not save ${assessment} submission:`, e.message);
    return null;
  }
}

/**
 * The other partner's submission for this couple code, if they have already answered.
 * Returns null when nobody has, or when the lookup failed.
 */
async function findPartner(coupleCode, thisPartner) {
  if (!coupleCode) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select('partner, name, email, phone, dob, sex, address, assessment_date, answers')
      .eq('assessment', 'kalyana_raman')
      .eq('couple_code', String(coupleCode).trim().toUpperCase())
      .neq('partner', thisPartner)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return data && data.length ? data[0] : null;
  } catch (e) {
    console.error('[assessments/store] partner lookup failed:', e.message);
    return null;
  }
}

module.exports = { save, findPartner, makeCoupleCode, TABLE };
