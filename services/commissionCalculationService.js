const { supabaseAdmin } = require('../config/supabase');

/**
 * Commission Calculation Service
 * Automatically calculates commission and company revenue when sessions are completed
 */

/**
 * Calculate and record commission for a completed session
 * @param {string} sessionId - Session ID
 * @param {Object} sessionData - Session data (optional, will fetch if not provided)
 * @returns {Promise<Object>} Commission calculation result
 */
async function calculateAndRecordCommission(sessionId, sessionData = null) {
  try {
    // Fetch session data if not provided
    let session = sessionData;
    if (!session) {
      const { data, error } = await supabaseAdmin
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

      if (error || !data) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      session = data;
    }

    // Only calculate for completed sessions
    if (session.status !== 'completed') {
      console.log(`⏭️  Skipping commission calculation for session ${sessionId} - status: ${session.status}`);
      return null;
    }

    // Check if payment exists and is successful (for paid sessions)
    // Free sessions (price = 0) don't need payment check
    const sessionAmount = parseFloat(session.price) || 0;
    if (sessionAmount > 0 && session.payment_id) {
      const { data: payment } = await supabaseAdmin
        .from('payments')
        .select('status')
        .eq('id', session.payment_id)
        .single();

      if (!payment || payment.status !== 'success') {
        console.log(`⏭️  Skipping commission calculation for session ${sessionId} - payment not successful`);
        return null;
      }
    }

    const psychologistId = session.psychologist_id;

    // Check if commission already calculated
    const { data: existingCommission } = await supabaseAdmin
      .from('commission_history')
      .select('id')
      .eq('session_id', sessionId)
      .single();

    if (existingCommission) {
      console.log(`⏭️  Commission already calculated for session ${sessionId}`);
      return existingCommission;
    }

    // Determine session type
    const sessionTypeText = String(session.session_type || '').toLowerCase();
    const isCoupleSession = sessionTypeText.includes('couple') || sessionTypeText.includes('cpl');
    const sessionType = session.package_id || session.session_type === 'Package Session' ? 'package' : (isCoupleSession ? 'couple' : 'individual');
    const clientId = session.client_id;
    let packageType = 'package';
    let isInitialCommissionSession = false;

    // Get doctor's commission (fixed amount per session type) including first/follow-up fields
    const { data: commissionRecord } = await supabaseAdmin
      .from('doctor_commissions')
      .select('commission_amount_individual, commission_amount_package, commission_percentage, commission_amounts, doctor_commission_first_session, doctor_commission_followup, doctor_commission_individual, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages')
      .eq('psychologist_id', psychologistId)
      .eq('is_active', true)
      .order('effective_from', { ascending: false })
      .limit(1)
      .single();

    // Get fixed commission amount based on session type
    let commissionAmount = 0;
    
    if (commissionRecord) {
      // Get package type if it's a package session
      if (sessionType === 'package' && session.package_id) {
        // Fetch package to get its type
        const { data: packageData } = await supabaseAdmin
          .from('packages')
          .select('package_type')
          .eq('id', session.package_id)
          .single();
        
        if (packageData) {
          packageType = packageData.package_type || 'package';
        }
      }

      // Use JSONB commission_amounts if available (company-facing fixed fallback amounts)
      if (commissionRecord.commission_amounts && typeof commissionRecord.commission_amounts === 'object') {
        const amt = commissionRecord.commission_amounts;
        if (sessionType === 'package') {
          commissionAmount =
            parseFloat(amt[packageType] ?? amt.package ?? 0);
        } else if (sessionType === 'couple') {
          commissionAmount = parseFloat(amt.couple ?? amt.couple_session ?? amt.individual ?? 0);
        } else {
          commissionAmount = parseFloat(amt.individual ?? 0);
        }
      } else if (sessionType === 'package') {
        if (commissionRecord.commission_amount_package !== null) {
          commissionAmount = parseFloat(commissionRecord.commission_amount_package) || 0;
        }
      } else if (
        commissionRecord.commission_amount_individual !== null &&
        commissionRecord.commission_amount_individual !== undefined
      ) {
        commissionAmount = parseFloat(commissionRecord.commission_amount_individual) || 0;
      } else if (commissionRecord.commission_percentage && parseFloat(commissionRecord.commission_percentage) > 0) {
        const commissionPercentage = parseFloat(commissionRecord.commission_percentage);
        commissionAmount = (sessionAmount * commissionPercentage) / 100;
      }
    }

    // Determine initial vs follow-up for commission selection
    if (sessionType === 'package' && session.package_id && clientId) {
      const { data: packageSessions } = await supabaseAdmin
        .from('sessions')
        .select('id, created_at, scheduled_date')
        .eq('package_id', session.package_id)
        .eq('client_id', clientId);

      const ordered = (packageSessions || []).sort((a, b) => {
        const aDate = new Date(a.created_at || a.scheduled_date || 0).getTime();
        const bDate = new Date(b.created_at || b.scheduled_date || 0).getTime();
        return aDate - bDate;
      });

      const firstPackageSessionId = ordered[0]?.id || null;
      isInitialCommissionSession = firstPackageSessionId === sessionId;
    } else if (clientId) {
      const { data: priorSessions } = await supabaseAdmin
        .from('sessions')
        .select('id')
        .eq('client_id', clientId)
        .neq('id', sessionId)
        .neq('session_type', 'free_assessment')
        .gt('price', 0)
        .limit(1);

      isInitialCommissionSession = !priorSessions || priorSessions.length === 0;
    }

    // Apply initial vs follow-up session logic:
    let finalCommissionAmount = commissionAmount;

    if (sessionType === 'couple') {
      const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
      const doctorCoupleCommission =
        parseFloat(
          doctorCommissionPackages.couple_session ??
            doctorCommissionPackages.cpl_session ??
            commissionRecord?.doctor_commission_individual ??
            0
        ) || 0;
      finalCommissionAmount = Math.max(0, sessionAmount - doctorCoupleCommission);
    } else if (sessionType === 'individual') {
      if (isInitialCommissionSession) {
        if (
          commissionRecord?.doctor_commission_first_session !== null &&
          commissionRecord?.doctor_commission_first_session !== undefined
        ) {
          const doctorCommissionFirst = parseFloat(commissionRecord.doctor_commission_first_session) || 0;
          finalCommissionAmount = Math.max(0, sessionAmount - doctorCommissionFirst);
        } else {
          finalCommissionAmount = commissionAmount;
        }
      } else if (
        commissionRecord?.doctor_commission_followup !== null &&
        commissionRecord?.doctor_commission_followup !== undefined
      ) {
        const doctorCommissionFollowup = parseFloat(commissionRecord.doctor_commission_followup) || 0;
        finalCommissionAmount = Math.max(0, sessionAmount - doctorCommissionFollowup);
      } else {
        finalCommissionAmount = commissionAmount;
      }
    } else if (sessionType === 'package') {
      const doctorCommissionPackages = commissionRecord?.doctor_commission_packages || {};
      let doctorCommissionAmount = null;
      
      if (isInitialCommissionSession) {
        const packageFirstSessionKey = `${packageType}_first_session`;
        if (doctorCommissionPackages[packageFirstSessionKey] !== null && doctorCommissionPackages[packageFirstSessionKey] !== undefined) {
          doctorCommissionAmount = parseFloat(doctorCommissionPackages[packageFirstSessionKey]) || 0;
        } else if (commissionRecord?.doctor_commission_first_session_package !== null && commissionRecord?.doctor_commission_first_session_package !== undefined) {
          doctorCommissionAmount = parseFloat(commissionRecord.doctor_commission_first_session_package) || 0;
        }
      } else {
        const packageFollowupKey = `${packageType}_followup`;
        if (doctorCommissionPackages[packageFollowupKey] !== null && doctorCommissionPackages[packageFollowupKey] !== undefined) {
          doctorCommissionAmount = parseFloat(doctorCommissionPackages[packageFollowupKey]) || 0;
        } else if (commissionRecord?.doctor_commission_followup_package !== null && commissionRecord?.doctor_commission_followup_package !== undefined) {
          doctorCommissionAmount = parseFloat(commissionRecord.doctor_commission_followup_package) || 0;
        }
      }
      
      if (doctorCommissionAmount === null) {
        throw new Error(`Doctor commission not configured for ${isInitialCommissionSession ? 'initial' : 'follow-up'} package type: ${packageType}.`);
      }
      
      // Package commissions are credited per completed session.
      finalCommissionAmount = Math.max(0, sessionAmount - doctorCommissionAmount);
    } else {
      // safe fallback
      finalCommissionAmount = Math.max(0, commissionAmount);
    }

    // Commission calculation (Fixed Amount System):
    // finalCommissionAmount = commission amount based on first/follow-up = what COMPANY gets as commission
    // doctorWalletAmount = sessionAmount - finalCommissionAmount = what DOCTOR gets
    const doctorWalletAmount = Math.max(0, sessionAmount - finalCommissionAmount);
    const companyCommission = finalCommissionAmount; // Company gets this commission amount

    // Net company revenue equals company commission (no GST deduction)
    const netCompanyRevenue = companyCommission;

    // Create commission history record
    // commission_amount = final commission amount (first session = 1x, follow-up = 2x) = what COMPANY gets
    // company_revenue = commission_amount (what company receives as commission)
    // Note: doctor_wallet = session_amount - commission_amount (calculated, not stored)
    const { data: commissionHistoryRecord, error: commissionError } = await supabaseAdmin
      .from('commission_history')
      .insert([{
        psychologist_id: psychologistId,
        session_id: sessionId,
        session_type: sessionType,
        package_id: session.package_id || null,
        session_date: session.scheduled_date,
        session_amount: sessionAmount,
        commission_percentage: 0, // Not used in fixed amount system
        commission_amount: finalCommissionAmount, // Final commission (1x for first, 2x for follow-up) = what COMPANY gets
        commission_amount_fixed: commissionAmount, // Store base fixed amount (before first/follow-up multiplier)
        company_revenue: companyCommission, // Company gets this commission amount
        net_company_revenue: netCompanyRevenue,
        payment_status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (commissionError) {
      console.error('Error creating commission record:', commissionError);
      throw commissionError;
    }

    console.log(`✅ Commission calculated for session ${sessionId}:`);
    console.log(`   Session type: ${sessionType}`);
    console.log(`   Session order: ${isInitialCommissionSession ? 'Initial Session' : 'Follow-up Session'}`);
    console.log(`   Session amount: ₹${sessionAmount.toFixed(2)}`);
    console.log(`   Base commission: ₹${commissionAmount.toFixed(2)}`);
    if (sessionType === 'individual') {
      if (isInitialCommissionSession && commissionRecord?.doctor_commission_first_session !== null && commissionRecord?.doctor_commission_first_session !== undefined) {
        console.log(`   Using first session doctor commission (individual): ₹${parseFloat(commissionRecord.doctor_commission_first_session).toFixed(2)}`);
      } else if (!isInitialCommissionSession && commissionRecord?.doctor_commission_followup !== null && commissionRecord?.doctor_commission_followup !== undefined) {
        console.log(`   Using follow-up doctor commission (individual): ₹${parseFloat(commissionRecord.doctor_commission_followup).toFixed(2)}`);
      }
    } else {
      if (isInitialCommissionSession && commissionRecord?.doctor_commission_first_session_package !== null && commissionRecord?.doctor_commission_first_session_package !== undefined) {
        console.log(`   Using first session doctor commission (package): ₹${parseFloat(commissionRecord.doctor_commission_first_session_package).toFixed(2)}`);
      } else if (!isInitialCommissionSession && commissionRecord?.doctor_commission_followup_package !== null && commissionRecord?.doctor_commission_followup_package !== undefined) {
        console.log(`   Using follow-up doctor commission (package): ₹${parseFloat(commissionRecord.doctor_commission_followup_package).toFixed(2)}`);
      }
    }
    console.log(`   Final company commission: ₹${finalCommissionAmount.toFixed(2)}`);
    console.log(`   Doctor wallet: ₹${doctorWalletAmount.toFixed(2)}`);
    console.log(`   Net company revenue: ₹${netCompanyRevenue.toFixed(2)}`);

    return commissionHistoryRecord;

  } catch (error) {
    console.error('Error calculating commission:', error);
    throw error;
  }
}

/**
 * Recalculate commission for a session (if needed)
 * @param {string} sessionId - Session ID
 */
async function recalculateCommission(sessionId) {
  try {
    // Delete existing commission records
    await supabaseAdmin
      .from('commission_history')
      .delete()
      .eq('session_id', sessionId);

    // Recalculate
    return await calculateAndRecordCommission(sessionId);
  } catch (error) {
    console.error('Error recalculating commission:', error);
    throw error;
  }
}

/**
 * Calculate commission for multiple sessions (batch processing)
 * @param {Array<string>} sessionIds - Array of session IDs
 */
async function calculateCommissionsBatch(sessionIds) {
  const results = [];
  for (const sessionId of sessionIds) {
    try {
      const result = await calculateAndRecordCommission(sessionId);
      results.push({ sessionId, success: true, data: result });
    } catch (error) {
      results.push({ sessionId, success: false, error: error.message });
    }
  }
  return results;
}

module.exports = {
  calculateAndRecordCommission,
  recalculateCommission,
  calculateCommissionsBatch
};

