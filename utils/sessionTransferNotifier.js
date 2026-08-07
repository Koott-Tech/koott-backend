/**
 * Transfer notifications, shared by BOTH transfer endpoints.
 *
 * There are two ways a session changes therapist — `transferSession` (admin-booked / platform)
 * and `transferWixBooking` (Wix). They used to notify differently: the platform path sent a
 * generic "session confirmation" and the Wix path sent NOTHING AT ALL, so a client could have
 * their therapist and time changed without ever being told. Both now call this, so the two
 * cannot drift apart again.
 *
 * The transfer dialog can change the date/time too, so callers pass the FINAL slot plus the
 * previous one; the email shows the reschedule only when the slot actually moved.
 */
const emailService = require('./emailService');

/**
 * Notify the client and the new therapist. Never throws — a failed email must not roll back a
 * transfer that has already been applied. Returns what was sent so callers can log/stamp it.
 */
async function notifySessionTransfer({
  clientName,
  clientEmail,
  oldPsychologistName,
  newPsychologistName,
  newPsychologistEmail,
  sessionDate,
  sessionTime,
  oldSessionDate = null,
  oldSessionTime = null,
  meetLink = null,
  label = 'transfer',
}) {
  const results = { client: false, psychologist: false, errors: [] };

  const base = {
    clientName: clientName || 'Client',
    oldPsychologistName: oldPsychologistName || null,
    newPsychologistName: newPsychologistName || 'your therapist',
    sessionDate,
    sessionTime,
    oldSessionDate,
    oldSessionTime,
    meetLink,
  };

  if (clientEmail) {
    try {
      await emailService.sendTransferNotification({ ...base, to: clientEmail, isPsychologist: false });
      results.client = true;
      console.log(`✅ [${label}] transfer email sent to client:`, clientEmail);
    } catch (err) {
      results.errors.push(`client: ${err.message}`);
      console.error(`❌ [${label}] transfer email to client failed:`, err.message);
    }
  } else {
    results.errors.push('client: no email address on record');
    console.warn(`⚠️ [${label}] no client email — transfer notification skipped`);
  }

  if (newPsychologistEmail) {
    try {
      await emailService.sendTransferNotification({ ...base, to: newPsychologistEmail, isPsychologist: true });
      results.psychologist = true;
      console.log(`✅ [${label}] transfer email sent to new therapist:`, newPsychologistEmail);
    } catch (err) {
      results.errors.push(`psychologist: ${err.message}`);
      console.error(`❌ [${label}] transfer email to new therapist failed:`, err.message);
    }
  } else {
    results.errors.push('psychologist: no email address on record');
    console.warn(`⚠️ [${label}] no new-therapist email — transfer notification skipped`);
  }

  return results;
}

module.exports = { notifySessionTransfer };
