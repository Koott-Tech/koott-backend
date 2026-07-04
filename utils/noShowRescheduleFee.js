const { supabaseAdmin } = require('../config/supabase');

/**
 * Record the additional payment collected when a NO-SHOW session is rescheduled.
 * The client no-showed (their mistake), so a top-up (usually half) is charged before we
 * put the session back on the calendar. This inserts a payments row as proof/record.
 *
 * Safe to call unconditionally — it no-ops unless a positive amount + receipt are provided.
 *
 * @param {object} opts
 * @param {string} opts.sessionId       - sessions.id the fee is for
 * @param {string|null} opts.clientId
 * @param {string|null} opts.psychologistId
 * @param {number} opts.amount          - fee amount (rupees)
 * @param {string} opts.method          - payment type (cash/upi/bank_transfer/razorpay/…)
 * @param {string} opts.receiptUrl      - uploaded screenshot URL
 * @returns {Promise<{recorded: boolean, error?: string}>}
 */
async function recordNoShowRescheduleFee({ sessionId, clientId, psychologistId, amount, method, receiptUrl }) {
  const feeAmount = Number(amount);
  if (!sessionId || !Number.isFinite(feeAmount) || feeAmount <= 0 || !receiptUrl) {
    return { recorded: false };
  }
  try {
    const { error } = await supabaseAdmin.from('payments').insert([{
      session_id: sessionId,
      client_id: clientId || null,
      psychologist_id: psychologistId || null,
      amount: feeAmount,
      currency: 'INR',
      status: 'completed',
      provider: 'manual',
      payment_method: method || 'cash',
      receipt_url: receiptUrl,
      notes: 'No-show reschedule fee (additional payment collected before rescheduling a no-show session)',
      paid_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);
    if (error) {
      console.warn('[noShowRescheduleFee] payment insert failed:', error.message || error);
      return { recorded: false, error: error.message };
    }
    console.log(`💰 [noShowRescheduleFee] recorded ₹${feeAmount} (${method}) for session ${sessionId}`);
    return { recorded: true };
  } catch (e) {
    console.warn('[noShowRescheduleFee] error:', e.message || e);
    return { recorded: false, error: e.message };
  }
}

module.exports = { recordNoShowRescheduleFee };
