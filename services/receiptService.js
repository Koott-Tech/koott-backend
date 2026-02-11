/**
 * Receipt service: generate and store receipts (PDF + DB).
 * Keeps session creation and payment layers from depending on payment controller.
 */

const { supabaseAdmin } = require('../config/supabase');
const userInteractionLogger = require('../utils/userInteractionLogger');

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
    if (isPackage && packageId) {
      try {
        console.log('🔍 Fetching package data for package_id:', packageId);
        const { data: packageData, error: packageError } = await supabaseAdmin
          .from('packages')
          .select('session_count')
          .eq('id', packageId)
          .single();
        console.log('🔍 Package data fetch result:', {
          packageData,
          packageError,
          session_count: packageData?.session_count
        });
        if (!packageError && packageData && packageData.session_count) {
          packageSessionCount = packageData.session_count;
          console.log('✅ Package session count set to:', packageSessionCount);
        } else {
          console.warn('⚠️ Could not get package session_count:', { error: packageError, data: packageData });
        }
      } catch (err) {
        console.error('❌ Error fetching package session_count:', err);
      }
    } else {
      console.log('ℹ️ Not a package, using default session count: 1');
    }

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
    const itemDescription = isPackage ? 'Package' : 'Individual Therapy';
    const quantity = isPackage ? packageSessionCount.toString() : '1';
    console.log('🔍 Receipt details being set:', {
      isPackage,
      itemDescription,
      quantity,
      packageSessionCount,
      package_id: paymentData.package_id
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
      package_id: packageId || null
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
