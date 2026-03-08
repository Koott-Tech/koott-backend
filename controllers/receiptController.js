const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');

// Get all receipts for a client
const getClientReceipts = async (req, res) => {
  try {
    const userId = req.user.id;
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔍 Fetching receipts for user (debug):', userId);
    }

    // Determine client ID: use client_id if available (new system), otherwise use id (old system)
    let clientId = req.user.client_id || userId;
    
    // If still not found, try to lookup client by user_id
    if (!clientId || clientId === userId) {
      const { data: clientData, error: clientError } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('user_id', userId)
        .single();
      
      if (!clientError && clientData) {
        clientId = clientData.id;
      }
    }

    // 1) Fetch sessions for this client (include package_id for session type)
    const { data: clientSessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select('id, client_id, scheduled_date, scheduled_time, status, psychologist_id, package_id')
      .eq('client_id', clientId);

    if (sessionsError) {
      console.error('❌ Error fetching client sessions:', sessionsError);
      return res.json(successResponse([], 'No receipts found'));
    }

    console.log('📊 Sessions for client:', clientSessions?.length || 0);
    if (!clientSessions || clientSessions.length === 0) {
      return res.json(successResponse([], 'No receipts found'));
    }

    const sessionIdList = clientSessions.map(s => s.id);
    const sessionMap = new Map(clientSessions.map(s => [s.id, s]));

    // 2) Fetch receipts for those sessions
    const { data: receipts, error: receiptsError } = await supabaseAdmin
      .from('receipts')
        .select('id, receipt_number, short_receipt_number, receipt_details, file_url, created_at, session_id, payment_id')
      .in('session_id', sessionIdList)
      .order('created_at', { ascending: false });

    if (receiptsError) {
      console.error('❌ Error fetching receipts:', receiptsError);
      return res.json(successResponse([], 'No receipts found'));
    }

    console.log('📊 Receipts found for client sessions:', receipts?.length || 0);
    if (!receipts || receipts.length === 0) {
      return res.json(successResponse([], 'No receipts found'));
    }

    // 3) Fetch payments for those receipts
    const paymentIdList = receipts.map(r => r.payment_id).filter(Boolean);
    let payments = [];
    if (paymentIdList.length > 0) {
      const { data: paymentsData, error: paymentsError } = await supabaseAdmin
        .from('payments')
        .select('id, transaction_id, amount, status, completed_at, created_at')
        .in('id', paymentIdList);
      if (paymentsError) {
        console.error('❌ Error fetching payments:', paymentsError);
      } else {
        payments = paymentsData || [];
      }
    }
    const paymentMap = new Map(payments.map(p => [p.id, p]));

    // 4) Fetch psychologists for display names
    const psychologistIdList = Array.from(new Set(clientSessions.map(s => s.psychologist_id).filter(Boolean)));
    let psychologists = [];
    if (psychologistIdList.length > 0) {
      const { data: psychologistsData, error: psychologistsError } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name')
        .in('id', psychologistIdList);
      if (psychologistsError) {
        console.error('❌ Error fetching psychologists:', psychologistsError);
      } else {
        psychologists = psychologistsData || [];
      }
    }
    const psychologistMap = new Map(psychologists.map(p => [p.id, p]));

    // 4b) Fetch packages for session_type (package of N)
    const packageIdList = Array.from(new Set(clientSessions.map(s => s.package_id).filter(Boolean)));
    let packages = [];
    if (packageIdList.length > 0) {
      const { data: packagesData, error: packagesError } = await supabaseAdmin
        .from('packages')
        .select('id, session_count, name')
        .in('id', packageIdList);
      if (!packagesError && packagesData) {
        packages = packagesData;
      }
    }
    const packageMap = new Map(packages.map(p => [p.id, p]));

    // 5) Compose and filter only successful/paid payments
    const composed = receipts
      .map(r => {
        const session = sessionMap.get(r.session_id);
        if (!session) {
          console.log('⚠️ Receipt has no matching session:', r.id, 'session_id:', r.session_id);
          return null;
        }
        
        const payment = paymentMap.get(r.payment_id);
        if (!payment) {
          console.log('⚠️ Receipt has no matching payment:', r.id, 'payment_id:', r.payment_id);
          return null;
        }
        
        // Include receipts for 'success' and 'cash' payment statuses
        const paymentStatus = (payment.status || '').toLowerCase();
        if (paymentStatus !== 'success' && paymentStatus !== 'cash') {
          console.log('⚠️ Receipt payment status is not success/cash:', r.id, 'status:', payment.status);
          return null;
        }
        
        const psych = session.psychologist_id ? psychologistMap.get(session.psychologist_id) : null;
        const pkg = session.package_id ? packageMap.get(session.package_id) : null;
        const sessionType = session.package_id && pkg ? 'package' : 'individual';
        const packageSessionCount = pkg ? (pkg.session_count || null) : null;
        return {
          id: r.id, // Use receipt ID instead of session ID for proper download
          receipt_id: r.id,
          session_id: session.id,
          receipt_number: r.short_receipt_number || r.receipt_number, // Use short_receipt_number if available
          session_date: session.scheduled_date,
          session_time: session.scheduled_time,
          psychologist_name: psych ? `${psych.first_name} ${psych.last_name}` : 'Unknown',
          amount: payment.amount || 0,
          transaction_id: payment.transaction_id || 'N/A',
          payment_date: payment.completed_at || payment.created_at || r.created_at,
          status: session.status,
          session_type: sessionType,
          package_session_count: packageSessionCount,
          // Note: file_url is for legacy receipts only (old system stored PDFs in storage)
          // New receipts use receipt_details and generate PDF on-demand
          file_url: r.file_url || null,
          has_receipt_details: !!r.receipt_details
        };
      })
      .filter(Boolean);

    console.log('📊 Composed receipts count:', composed.length);

    res.json(
      successResponse(composed, 'Receipts fetched successfully')
    );

  } catch (error) {
    console.error('Get client receipts error:', error);
    // Return empty array instead of error
    res.json(
      successResponse([], 'No receipts found')
    );
  }
};

// Download receipt as PDF
const downloadReceipt = async (req, res) => {
  try {
    const { receiptId } = req.params;
    const userId = req.user.id;

    console.log('🔍 Download receipt request - receiptId:', receiptId, 'userId:', userId);

    // Get client ID from clients table (support both old and new system)
    // New system: clients.user_id references users.id
    // Old system: clients.id === users.id
    let clientId = null;
    
    // Try new system first: find client by user_id
    const { data: clientDataByUserId, error: clientErrorByUserId } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (clientDataByUserId && !clientErrorByUserId) {
      clientId = clientDataByUserId.id;
      console.log('✅ Found client by user_id (new system):', clientId);
    } else {
      // Fallback to old system: try clients.id === userId
      const { data: clientDataById, error: clientErrorById } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('id', userId)
        .maybeSingle();

      if (clientDataById && !clientErrorById) {
        clientId = clientDataById.id;
        console.log('✅ Found client by id (old system):', clientId);
      }
    }

    if (!clientId) {
      console.log('📝 No client profile found for user:', userId);
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    // Try to get receipt by receipt ID first (new approach)
    // Fetch receipt with receipt_details (new system) or file_url (legacy)
    let { data: receipt, error: receiptError } = await supabaseAdmin
      .from('receipts')
      .select('id, receipt_number, receipt_details, file_url, session_id')
      .eq('id', receiptId)
      .single();

    // Fallback: if not found by ID, try by session_id (backward compatibility)
    if (receiptError || !receipt) {
      console.log('⚠️ Receipt not found by ID, trying by session_id:', receiptId);
      ({ data: receipt, error: receiptError } = await supabaseAdmin
        .from('receipts')
        .select('id, receipt_number, receipt_details, file_url, session_id')
        .eq('session_id', receiptId)
        .single());
    }

    if (receiptError || !receipt) {
      console.log('❌ Receipt not found:', receiptId, receiptError);
      return res.status(404).json(
        errorResponse('Receipt not found')
      );
    }

    // Verify the session belongs to this client
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, client_id')
      .eq('id', receipt.session_id)
      .maybeSingle(); // Use maybeSingle() to avoid error if session doesn't exist

    if (sessionError) {
      // Only log if it's not a "not found" error (PGRST116)
      if (sessionError.code !== 'PGRST116') {
        console.error('❌ Error fetching session:', sessionError);
      } else {
        console.log('ℹ️ Session not found for receipt:', receipt.session_id);
      }
    }

    if (!session || session.client_id !== clientId) {
      console.log('❌ Unauthorized receipt access or session not found');
      return res.status(404).json(
        errorResponse('Receipt not found')
      );
    }

    // Check if receipt has receipt_details (new system) or file_url (legacy)
    if (receipt.receipt_details) {
      // New system: Generate PDF on-demand from receipt_details
      console.log('📄 Generating PDF on-demand from receipt_details for receipt:', receipt.id);
      try {
        // Parse receipt_details (stored as JSON)
        const receiptDetails = typeof receipt.receipt_details === 'string' 
          ? JSON.parse(receipt.receipt_details) 
          : receipt.receipt_details;
        
        // Generate PDF on-demand
        const pdfBuffer = await generateReceiptPDFFromDetails(receiptDetails);
        
        // Generate filename using client name (sanitized for filesystem)
        let fileName = 'Receipt';
        if (receiptDetails.client_name) {
          // Sanitize client name: replace spaces with hyphens, remove special characters
          const sanitizedName = receiptDetails.client_name
            .trim()
            .replace(/\s+/g, '-') // Replace spaces with hyphens
            .replace(/[^a-zA-Z0-9\-_]/g, '') // Remove special characters except hyphens and underscores
            .substring(0, 50); // Limit length to 50 characters
          fileName = sanitizedName || 'Receipt';
        } else {
          // Fallback to receipt number if client name not available
          fileName = `Receipt-${receipt.receipt_number}`;
        }
        
        // Set headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        
        console.log('✅ PDF generated on-demand, sending to client');
        return res.send(pdfBuffer);
        
      } catch (pdfError) {
        console.error('❌ Error generating PDF on-demand:', pdfError);
        return res.status(500).json(
          errorResponse('Error generating receipt PDF')
        );
      }
    } else if (receipt.file_url) {
      // Legacy system: Return file URL (for backward compatibility with old receipts)
      console.log('✅ Receipt found (legacy), returning download URL:', receipt.file_url);
      return res.json(
        successResponse({ downloadUrl: receipt.file_url }, 'Download URL generated')
      );
    } else {
      console.log('❌ Receipt has no receipt_details or file_url:', receipt.id);
      return res.status(404).json(
        errorResponse('Receipt data not available')
      );
    }

  } catch (error) {
    console.error('Download receipt error:', error);
    res.status(500).json(
      errorResponse('Internal server error while downloading receipt')
    );
  }
};

/**
 * Generate PDF buffer from receipt details (on-demand generation)
 * Uses receipt_details JSON stored in database
 * Reuses the template-based generation from paymentController
 */
const generateReceiptPDFFromDetails = async (receiptDetails) => {
  // Reuse the generateReceiptPDF function from paymentController which uses the template
  const { generateReceiptPDF } = require('./paymentController');
  return generateReceiptPDF(receiptDetails);
};

// Get receipt by Razorpay order ID
const getReceiptByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    if (!orderId) {
      return res.status(400).json(
        errorResponse('Order ID is required')
      );
    }

    // Get client ID from clients table
    // Clients table has user_id that references users.id
    // Try new system first: lookup by user_id
    let { data: clientData, error: clientDataError } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .single();

    // Fallback to old system: lookup by id (backward compatibility)
    if (clientDataError || !clientData) {
      ({ data: clientData, error: clientDataError } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('id', userId)
        .single());
    }

    if (clientDataError || !clientData) {
      console.log('📝 No client profile found for user:', userId, clientDataError);
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    const clientId = clientData.id;
    console.log('🔍 User ID:', userId, 'Client ID:', clientId);

    // Find payment by razorpay_order_id
    const { data: payment, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('id, session_id, client_id, razorpay_order_id, transaction_id, status')
      .eq('razorpay_order_id', orderId)
      .single();

    if (paymentError || !payment) {
      console.log('❌ Payment not found for order:', orderId, paymentError);
      return res.status(404).json(
        errorResponse('Payment not found')
      );
    }

    console.log('🔍 Payment found - Payment client_id:', payment.client_id, 'User client_id:', clientId);

    // Verify the payment belongs to this client
    if (payment.client_id !== clientId) {
      console.log('❌ Unauthorized receipt access - Payment client_id:', payment.client_id, 'does not match user client_id:', clientId);
      return res.status(404).json(
        errorResponse('Receipt not found')
      );
    }

    // Get session details for this payment (even if receipt doesn't exist yet)
    let sessionDetails = null;
    if (payment.session_id) {
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .select(`
          id,
          scheduled_date,
          scheduled_time,
          status,
          psychologist:psychologists(
            id,
            first_name,
            last_name
          )
        `)
        .eq('id', payment.session_id)
        .maybeSingle(); // Use maybeSingle() to avoid error if session doesn't exist yet

      if (sessionError) {
        // Only log if it's not a "not found" error (PGRST116)
        if (sessionError.code !== 'PGRST116') {
          console.error('❌ Error fetching session:', sessionError);
        } else {
          console.log('ℹ️ Session not found yet (may still be processing):', payment.session_id);
        }
      } else if (session) {
        sessionDetails = {
          scheduled_date: session.scheduled_date,
          scheduled_time: session.scheduled_time,
          status: session.status,
          psychologist: session.psychologist ? {
            first_name: session.psychologist.first_name,
            last_name: session.psychologist.last_name
          } : null
        };
        console.log('✅ Session details found:', sessionDetails);
      } else {
        console.log('ℹ️ Session not found for payment session_id:', payment.session_id);
      }
    }

    // Get receipt by payment_id (may not exist yet if payment verification is still processing)
    const { data: receipt, error: receiptError } = await supabaseAdmin
      .from('receipts')
      .select('id, receipt_number, receipt_details, file_url, session_id, payment_id, created_at')
      .eq('payment_id', payment.id)
      .single();

    // Compute payment_status: if receipt exists but payment.status is missing we default to 'success' for backward compatibility; log when status is missing so data gaps are visible.
    let payment_status;
    if (receipt && !payment.status) {
      console.warn('⚠️ Receipt exists but payment.status is missing for payment id:', payment.id);
      payment_status = 'success';
    } else {
      payment_status = payment.status || 'pending';
    }

    // If receipt doesn't exist yet, return payment and session info anyway
    // This handles the case where payment verification is still processing
    if (receiptError || !receipt) {
      console.log('⚠️ Receipt not found for payment:', payment.id, '- Payment may still be processing');
      return res.json(
        successResponse({
          receipt_available: false,
          payment_status: payment_status,
          transaction_id: payment.transaction_id,
          session: sessionDetails, // Include session details even without receipt
          message: 'Receipt is being generated. Please check back in a moment.'
        }, 'Payment found, receipt pending')
      );
    }

    console.log('✅ Receipt found for order:', orderId);

    return res.json(
      successResponse({
        receipt_available: true,
        receipt_number: receipt.receipt_number,
        // file_url is for legacy receipts only (old system)
        // New receipts use receipt_details and generate PDF on-demand
        file_url: receipt.file_url || null,
        has_receipt_details: !!receipt.receipt_details,
        created_at: receipt.created_at,
        transaction_id: payment.transaction_id,
        payment_status: payment_status,
        session: sessionDetails // Include session details
      }, 'Receipt fetched successfully')
    );

  } catch (error) {
    console.error('Get receipt by order ID error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching receipt')
    );
  }
};

module.exports = {
  getClientReceipts,
  downloadReceipt,
  getReceiptByOrderId
};
