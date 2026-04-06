/**
 * Receipt service: generate and store receipts (PDF + DB).
 * Keeps session creation and payment layers from depending on payment controller.
 */

const { supabaseAdmin } = require('../config/supabase');
const userInteractionLogger = require('../utils/userInteractionLogger');
const { getMeetEventDurationMinutes, formatDurationHuman } = require('../utils/sessionMeetDuration');

/**
 * Generate receipt PDF and store receipt details in database (without storing PDF file)
 * PDF is generated, sent via email/WhatsApp, then discarded
 */
const generateAndStoreReceipt = async (sessionData, paymentData, clientData, psychologistData) => {
  const { generateReceiptPDF } = require('../controllers/paymentController');
  try {
    const receiptNumber = `R-${sessionData.id.toString().padStart(4, '0')}`;
    const sessionIdStr = sessionData.id.toString();
    const numericDigits = sessionIdStr.replace(/-/g, '').replace(/[^0-9]/g, '');
    const last6Digits = numericDigits.slice(-6).padStart(6, '0');
    const shortReceiptNumber = `RCP-${last6Digits}`;

    let packageId = paymentData.package_id;
    if (!packageId && sessionData && sessionData.package_id) {
      packageId = sessionData.package_id;
      console.log('🔍 Using package_id from sessionData:', packageId);
    }
    console.log('🔍 Receipt generation - Checking package_id:', {
      paymentData_package_id: paymentData.package_id,
      sessionData_package_id: sessionData?.package_id,
      final_package_id: packageId,
      package_id_type: typeof packageId,
      package_id_null: packageId === null,
      package_id_undefined: packageId === undefined
    });

    const isPackage = packageId &&
      packageId !== null &&
      packageId !== undefined &&
      String(packageId).toLowerCase() !== 'null' &&
      String(packageId).toLowerCase() !== 'undefined' &&
      String(packageId).toLowerCase() !== 'individual';
    console.log('🔍 Receipt generation - isPackage:', isPackage);

    let packageSessionCount = 1;
    let packageName = null;
    let packageType = null;
    let sessionNumberInPackage = null;
    let packagePositionLabel = null;
    let sessionDurationLabel = null;
    let durationMinutes = null;

    if (isPackage && packageId) {
      try {
        console.log('🔍 Fetching package data for package_id:', packageId);
        const { data: packageData, error: packageError } = await supabaseAdmin
          .from('packages')
          .select('session_count, name, package_type, price')
          .eq('id', packageId)
          .single();
        console.log('🔍 Package data fetch result:', {
          packageData,
          packageError,
          session_count: packageData?.session_count
        });
        if (!packageError && packageData) {
          if (packageData.session_count) {
            packageSessionCount = packageData.session_count;
          }
          packageName = packageData.name || null;
          packageType = packageData.package_type || null;
          durationMinutes = getMeetEventDurationMinutes(packageType);
          const dur = formatDurationHuman(durationMinutes);
          if (dur) {
            sessionDurationLabel = `${dur} per session`;
          }

          if (sessionData.client_id) {
            const { data: orderedSessions, error: ordErr } = await supabaseAdmin
              .from('sessions')
              .select('id')
              .eq('package_id', packageId)
              .eq('client_id', sessionData.client_id)
              .order('created_at', { ascending: true });
            if (!ordErr && orderedSessions?.length) {
              const idx = orderedSessions.findIndex((s) => s.id === sessionData.id);
              if (idx >= 0) {
                sessionNumberInPackage = idx + 1;
                if (packageSessionCount > 1) {
                  packagePositionLabel = `Session ${sessionNumberInPackage} of ${packageSessionCount}`;
                }
              }
            }
          }

          console.log('✅ Package receipt context:', {
            packageSessionCount,
            packagePositionLabel,
            sessionDurationLabel
          });
        } else {
          console.warn('⚠️ Could not get package row:', { error: packageError, data: packageData });
        }
      } catch (err) {
        console.error('❌ Error fetching package for receipt:', err);
      }
    } else {
      console.log('ℹ️ Not a package, using default session count: 1');
      durationMinutes = getMeetEventDurationMinutes(null);
      const dur = formatDurationHuman(durationMinutes);
      if (dur) {
        sessionDurationLabel = dur;
      }
    }

    const paymentAmountNum = Number(paymentData.amount);
    const unitPriceForDisplay =
      isPackage && packageSessionCount > 1 && Number.isFinite(paymentAmountNum)
        ? Math.round((paymentAmountNum / packageSessionCount) * 100) / 100
        : paymentAmountNum;

    const razorpayResponse = paymentData.razorpay_response || paymentData.razorpay_params || {};
    let paymentMethod = razorpayResponse.method || razorpayResponse.payment_method;
    if (!paymentMethod) {
      if (paymentData.payment_method === 'cash') paymentMethod = 'cash';
      else if (paymentData.transaction_id) paymentMethod = 'online';
      else paymentMethod = 'cash';
    }
    let paymentModeText = 'Cash Payment';
    if (paymentMethod && paymentMethod !== 'cash') {
      const methodMap = {
        netbanking: 'Net Banking',
        card: 'Card Payment',
        credit_card: 'Card Payment',
        debit_card: 'Card Payment',
        upi: 'UPI Payment',
        wallet: 'Wallet Payment',
        online: 'Online Payment'
      };
      paymentModeText = methodMap[paymentMethod.toLowerCase()] || 'Online Payment';
    }
    const currency = razorpayResponse.currency || paymentData.razorpay_params?.currency || 'INR';
    let itemDescription = packageName || (isPackage ? 'Package' : 'Individual Therapy');
    if (!packageName && isPackage && packageSessionCount > 1) {
      itemDescription = `Package · ${packageSessionCount} sessions`;
    }
    const quantity = isPackage ? packageSessionCount.toString() : '1';
    console.log('🔍 Receipt details being set:', {
      isPackage,
      itemDescription,
      quantity,
      packageSessionCount,
      package_id: paymentData.package_id,
      packagePositionLabel,
      sessionDurationLabel
    });

    const receiptDetails = {
      receipt_number: shortReceiptNumber,
      receipt_number_long: receiptNumber,
      session_date: sessionData.scheduled_date,
      session_time: sessionData.scheduled_time,
      session_status: sessionData.status || 'booked',
      psychologist_name: `${psychologistData.first_name} ${psychologistData.last_name}`,
      psychologist_email: psychologistData.email || null,
      psychologist_phone: psychologistData.phone || null,
      client_name: `${clientData.first_name || ''} ${clientData.last_name || ''}`.trim() || 'N/A',
      client_email: clientData.user?.email || null,
      client_phone: clientData.phone_number || null,
      transaction_id: paymentData.transaction_id,
      amount: paymentData.amount,
      payment_date: paymentData.completed_at || new Date().toISOString(),
      payment_method: paymentModeText,
      currency,
      item_description: itemDescription,
      quantity,
      is_package: isPackage,
      package_id: packageId || null,
      package_type: packageType || null,
      package_session_label: packagePositionLabel,
      session_duration_label: sessionDurationLabel,
      duration_minutes: durationMinutes,
      session_number_in_package: sessionNumberInPackage,
      total_sessions_in_package: isPackage ? packageSessionCount : null,
      unit_price: unitPriceForDisplay,
      unit_price_display: Number.isFinite(unitPriceForDisplay) ? String(unitPriceForDisplay) : String(paymentData.amount),
      line_total_amount: paymentData.amount
    };
    console.log('✅ Final receiptDetails to store:', {
      item_description: receiptDetails.item_description,
      quantity: receiptDetails.quantity,
      is_package: receiptDetails.is_package,
      package_id: receiptDetails.package_id
    });

    const pdfBuffer = await generateReceiptPDF(receiptDetails);
    console.log('✅ PDF generated successfully, size:', pdfBuffer.length, 'bytes');

    const receiptData = {
      session_id: sessionData.id,
      payment_id: paymentData.id,
      receipt_number: receiptNumber,
      short_receipt_number: shortReceiptNumber,
      receipt_details: receiptDetails,
      file_path: null,
      file_url: null,
      file_size: null,
      created_at: new Date().toISOString()
    };
    console.log('📄 Storing receipt data - session_id:', receiptData.session_id, 'receipt_number:', receiptData.receipt_number);

    const { data: insertedReceipt, error: receiptError } = await supabaseAdmin
      .from('receipts')
      .insert(receiptData)
      .select('id')
      .single();

    if (receiptError) {
      console.error('❌ Error storing receipt details:', receiptError);
      throw receiptError;
    }
    console.log('✅ Receipt details stored successfully in database, receipt ID:', insertedReceipt?.id);

    if (clientData?.id) {
      userInteractionLogger.logReceipt({
        userId: clientData.id,
        userRole: 'client',
        paymentId: paymentData.id,
        sessionId: sessionData.id,
        amount: paymentData.amount,
        status: 'success',
        action: 'generate'
      }).catch(err => console.error('Error logging receipt:', err));
    }

    return {
      success: true,
      receiptId: insertedReceipt?.id,
      receiptNumber: shortReceiptNumber,
      receiptNumberLong: receiptNumber,
      pdfBuffer,
      receiptDetails
    };
  } catch (error) {
    console.error('❌ Error in generateAndStoreReceipt:', error);
    throw error;
  }
};

module.exports = {
  generateAndStoreReceipt
};
