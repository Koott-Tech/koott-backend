const { supabaseAdmin } = require('../config/supabase');
const { ensureClientPackageRecord } = require('../services/packageService');
const { 
  getRazorpayConfig, 
  getRazorpayInstance,
  generateTransactionId, 
  verifyPaymentSignature 
} = require('../config/razorpay');
const meetLinkService = require('../utils/meetLinkService');
const assessmentSessionService = require('../services/assessmentSessionService');
const { addMinutesToTime, errorResponse } = require('../utils/helpers');
const emailService = require('../utils/emailService');
const userInteractionLogger = require('../utils/userInteractionLogger');
const { generateAndStoreReceipt } = require('../services/receiptService');

// Generate and store PDF receipt in Supabase storage
/**
 * Generate PDF buffer from receipt data using template PDF
 * Uses pdf-lib to load template and fill in data based on demo PDF structure
 */
const generateReceiptPDF = async (receiptDetails) => {
  try {
    const { PDFDocument, rgb } = require('pdf-lib');
    const fs = require('fs').promises;
    const path = require('path');

    // Load the template PDF - try multiple locations for production compatibility
    // Priority: 1) backend/templates (production), 2) frontend/public (local), 3) env var
    const templatePathBackend = path.join(__dirname, '../templates/template.pdf');
    const templatePathFrontend = path.join(__dirname, '../../frontend/public/template.pdf');
    const templatePathEnv = process.env.RECEIPT_TEMPLATE_PATH;
    
    let templatePath = null;
    
    // Try backend/templates first (most reliable in production)
    try {
      await fs.access(templatePathBackend);
      templatePath = templatePathBackend;
      console.log('✅ Using template from backend/templates/template.pdf');
    } catch (err) {
      // Try frontend/public (for local development)
      try {
        await fs.access(templatePathFrontend);
        templatePath = templatePathFrontend;
        console.log('✅ Using template from frontend/public/template.pdf');
      } catch (err2) {
        // Try environment variable path
        if (templatePathEnv) {
          try {
            await fs.access(templatePathEnv);
            templatePath = templatePathEnv;
            console.log('✅ Using template from RECEIPT_TEMPLATE_PATH:', templatePathEnv);
          } catch (err3) {
            console.log('⚠️ Template PDF not found in any location');
            console.log('⚠️ Tried:', templatePathBackend);
            console.log('⚠️ Tried:', templatePathFrontend);
            console.log('⚠️ Tried:', templatePathEnv);
            console.log('⚠️ Using fallback PDF generation method');
            return generateReceiptPDFFallback(receiptDetails);
          }
        } else {
          console.log('⚠️ Template PDF not found in any location');
          console.log('⚠️ Tried:', templatePathBackend);
          console.log('⚠️ Tried:', templatePathFrontend);
          console.log('⚠️ Using fallback PDF generation method');
          return generateReceiptPDFFallback(receiptDetails);
        }
      }
    }
    
    const templateBytes = await fs.readFile(templatePath);
    
    // Load the PDF document
    const pdfDoc = await PDFDocument.load(templateBytes);
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    const { width, height } = firstPage.getSize();

    // Get form fields if the template has them
    const form = pdfDoc.getForm();
    const formFields = form.getFields();
    
    // If template has form fields, fill them
    // Otherwise, we'll add text overlays based on demo PDF structure
    if (formFields.length > 0) {
      // Fill form fields (adjust field names based on actual template)
      try {
        if (form.getTextField('receipt_number')) {
          form.getTextField('receipt_number').setText(receiptDetails.receipt_number);
        }
        if (form.getTextField('date')) {
          form.getTextField('date').setText(new Date(receiptDetails.payment_date || new Date()).toLocaleDateString('en-IN'));
        }
        if (form.getTextField('time')) {
          form.getTextField('time').setText(new Date(receiptDetails.payment_date || new Date()).toLocaleTimeString('en-IN'));
        }
        if (form.getTextField('session_date')) {
          form.getTextField('session_date').setText(new Date(receiptDetails.session_date).toLocaleDateString('en-IN'));
        }
        if (form.getTextField('session_time')) {
          form.getTextField('session_time').setText(receiptDetails.session_time);
        }
        if (form.getTextField('psychologist_name')) {
          form.getTextField('psychologist_name').setText(receiptDetails.psychologist_name);
        }
        if (form.getTextField('client_name')) {
          form.getTextField('client_name').setText(receiptDetails.client_name);
        }
        if (form.getTextField('transaction_id')) {
          form.getTextField('transaction_id').setText(receiptDetails.transaction_id);
        }
        if (form.getTextField('amount')) {
          // Use INR instead of ₹ to avoid encoding issues
          form.getTextField('amount').setText(`INR ${receiptDetails.amount}`);
        }
      } catch (fieldError) {
        console.log('⚠️ Template may not have form fields, using text overlay method');
      }
    }

    // If no form fields or form fields failed, add text overlays
    // Position coordinates based on demo PDF analysis (A4 = 595.5 x 842.25 points)
    // PDF coordinates: origin (0,0) is at bottom-left, Y increases upward
    
    // Configuration - Invoice-style layout coordinates from demo PDF
    const documentConfig = {
      pageWidth: 595.5,
      pageHeight: 842.25,
      labelFontSize: 10,
      valueFontSize: 11,
      lineHeight: 15
    };

    const config = {
      // Document and font settings
      documentConfig: documentConfig,
      fontSizes: {
        label: documentConfig.labelFontSize,
        value: documentConfig.valueFontSize,
        lineHeight: documentConfig.lineHeight
      },
      
      // Field positions with alignment (exact coordinates from demo PDF)
      fields: {
        receiptNumberLabel: { x: 435, y: 671, alignment: 'left' }, // Moved down by 5px (was 676)
        receiptNumberValue: { x: 435, y: 671, alignment: 'right' }, // Same Y as label
        receiptDateLabel: { x: 435, y: 686, alignment: 'left' }, // Moved down by 10px (was 696), reduced gap to 15px
        receiptDate: { x: 480, y: 686, alignment: 'left' }, // Same Y as label
        clientName: { x: 60, y: 665, alignment: 'left' },
        clientEmail: { x: 60, y: 648, alignment: 'left' },
        clientPhone: { x: 60, y: 631, alignment: 'left' },
        paymentModeValue: { x: 60, y: 585, alignment: 'left' },
        transactionId: { x: 60, y: 570, alignment: 'left' },
        itemDescription: { x: 60, y: 435, alignment: 'left' },
        sessionDetails: { x: 60, y: 420, alignment: 'left' },
        therapistName: { x: 60, y: 405, alignment: 'left' },
        quantity: { x: 315, y: 435, alignment: 'center' },
        unitPrice: { x: 405, y: 435, alignment: 'center' },
        lineTotal: { x: 520, y: 435, alignment: 'right' },
        grandTotal: { x: 520, y: 370, alignment: 'right' },
        footerWebsite: { x: 297, y: 55, alignment: 'center' },
        footerPhone: { x: 297, y: 40, alignment: 'center' },
        footerEmail: { x: 297, y: 25, alignment: 'center' }
      }
    };

    // Embed standard fonts (pdf-lib supports Helvetica and Helvetica-Bold)
    const helveticaFont = await pdfDoc.embedFont('Helvetica');
    const helveticaBoldFont = await pdfDoc.embedFont('Helvetica-Bold');
    
    // Helper function to draw text with alignment support
    // Note: pdf-lib coordinates are already provided, so x represents the left edge for left alignment
    // For center/right alignment, we calculate the adjusted x position based on text width
    const drawText = (text, x, y, size, bold = false, alignment = 'left', maxWidth = null, lineHeight = null) => {
      // Ensure text is always a string (pdf-lib requires strings)
      const textStr = String(text || '');
      const font = bold ? helveticaBoldFont : helveticaFont;
      const spacing = lineHeight || size * 1.2; // Default line height
      
      // If maxWidth is specified, wrap text to multiple lines
      if (maxWidth && alignment === 'left') {
        const lines = [];
        let remainingText = textStr;
        
        while (remainingText) {
          // Check if entire remaining text fits
          const textWidth = font.widthOfTextAtSize(remainingText, size);
          
          if (textWidth <= maxWidth) {
            lines.push(remainingText);
            break;
          }
          
          // Binary search for the longest substring that fits
          let low = 0;
          let high = remainingText.length;
          let bestFit = '';
          
          while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const testText = remainingText.substring(0, mid);
            const testWidth = font.widthOfTextAtSize(testText, size);
            
            if (testWidth <= maxWidth) {
              bestFit = testText;
              low = mid + 1;
            } else {
              high = mid - 1;
            }
          }
          
          if (bestFit) {
            lines.push(bestFit);
            remainingText = remainingText.substring(bestFit.length).trim();
          } else {
            // Even a single character doesn't fit, force break to prevent infinite loop
            lines.push(remainingText.substring(0, 1));
            remainingText = remainingText.substring(1);
          }
        }
        
        // Draw each line
        lines.forEach((line, index) => {
          firstPage.drawText(line, {
            x: x,
            y: y - (index * spacing),
            size: size,
            color: rgb(0, 0, 0),
            font: font,
          });
        });
        
        return lines.length; // Return number of lines drawn
      }
      
      // Single line drawing (original behavior)
      let adjustedX = x;
      
      // Calculate text width if alignment is center or right
      if (alignment === 'center' || alignment === 'right') {
        const textWidth = font.widthOfTextAtSize(textStr, size);
        if (alignment === 'center') {
          adjustedX = x - (textWidth / 2);
        } else if (alignment === 'right') {
          adjustedX = x - textWidth;
        }
      }
      
      firstPage.drawText(textStr, {
        x: adjustedX,
        y: y,
        size: size,
        color: rgb(0, 0, 0),
        font: font,
      });
      
      return 1; // Single line
    };

    // Receipt Number Label (top right, left aligned)
    drawText(
      'Receipt No:', 
      config.fields.receiptNumberLabel.x, 
      config.fields.receiptNumberLabel.y, 
      config.fontSizes.label,
      false,
      config.fields.receiptNumberLabel.alignment
    );
    
    // Calculate position for receipt number value: right after the colon with a small gap
    const receiptNumberLabelText = 'Receipt No:';
    const receiptNumberLabelWidth = helveticaFont.widthOfTextAtSize(receiptNumberLabelText, config.fontSizes.label);
    const receiptNumberValueIndent = config.fields.receiptNumberLabel.x + receiptNumberLabelWidth + 3; // 3px gap after colon
    
    // Receipt Number Value (right after colon, same Y position, bold)
    drawText(
      receiptDetails.receipt_number, 
      receiptNumberValueIndent, 
      config.fields.receiptNumberValue.y, 
      config.fontSizes.value,
      true, // bold
      'left', // left-aligned from receiptNumberValueIndent
      null, // no max width
      config.fontSizes.lineHeight
    );

    // Receipt Date Label (below receipt number, left aligned, same font as receipt label)
    drawText(
      'Date:', 
      config.fields.receiptDateLabel.x, 
      config.fields.receiptDateLabel.y, 
      config.fontSizes.label,
      false,
      config.fields.receiptDateLabel.alignment
    );
    
    // Calculate position for date value: right after the colon with a small gap
    const dateLabelText = 'Date:';
    const dateLabelWidth = helveticaFont.widthOfTextAtSize(dateLabelText, config.fontSizes.label);
    const dateValueIndent = config.fields.receiptDateLabel.x + dateLabelWidth + 3; // 3px gap after colon
    
    // Receipt Date Value (right after colon, same Y as date label)
    const receiptDateStr = new Date(receiptDetails.payment_date || new Date()).toLocaleDateString('en-IN');
    drawText(
      receiptDateStr, 
      dateValueIndent, // Small gap after colon
      config.fields.receiptDate.y, 
      config.fontSizes.value,
      false,
      'left', // left-aligned
      null,
      config.fontSizes.lineHeight
    );

    // Client Name (left side, left aligned, bold) - moved up
    drawText(
      receiptDetails.client_name || 'N/A', 
      config.fields.clientName.x, 
      config.fields.clientName.y, 
      config.fontSizes.value,
      true, // bold
      config.fields.clientName.alignment
    );

    // Client Email (left side, below name, left aligned) - moved down
    if (receiptDetails.client_email) {
      drawText(
        receiptDetails.client_email, 
        config.fields.clientEmail.x, 
        config.fields.clientEmail.y, 
        config.fontSizes.value,
        false,
        config.fields.clientEmail.alignment
      );
    }

    // Client Phone (left side, below email, left aligned)
    if (receiptDetails.client_phone) {
      drawText(
        receiptDetails.client_phone, 
        config.fields.clientPhone.x, 
        config.fields.clientPhone.y, 
        config.fontSizes.value,
        false,
        config.fields.clientPhone.alignment
      );
    }

    // Payment Mode Value (left aligned) - from receiptDetails.payment_method
    const paymentMode = receiptDetails.payment_method || (receiptDetails.transaction_id ? 'Online Payment' : 'Cash Payment');
    drawText(
      paymentMode, 
      config.fields.paymentModeValue.x, 
      config.fields.paymentModeValue.y, 
      config.fontSizes.value,
      false,
      config.fields.paymentModeValue.alignment
    );

    // Transaction ID (left aligned)
    if (receiptDetails.transaction_id) {
      drawText(
        `Transaction ID: ${receiptDetails.transaction_id}`, 
        config.fields.transactionId.x, 
        config.fields.transactionId.y, 
        config.fontSizes.value,
        false,
        config.fields.transactionId.alignment
      );
    }

    // Item Description (Individual Therapy or Package Session, left aligned)
    // Use item_description from receiptDetails, but also check is_package flag as fallback
    let itemDescription = receiptDetails.item_description;
    
    // Fallback: if item_description is missing or is the old default, check is_package flag
    if (!itemDescription || itemDescription === 'Therapy Session' || itemDescription === 'Individual Therapy') {
      if (receiptDetails.is_package === true || receiptDetails.is_package === 'true') {
        itemDescription = 'Package';
      } else if (!itemDescription) {
        itemDescription = 'Individual Therapy';
      }
    }
    
    console.log('🔍 PDF Generation - Item Description:', {
      item_description: receiptDetails.item_description,
      is_package: receiptDetails.is_package,
      final_itemDescription: itemDescription,
      quantity: receiptDetails.quantity
    });
    
    drawText(
      itemDescription, 
      config.fields.itemDescription.x, 
      config.fields.itemDescription.y, 
      config.fontSizes.value,
      false,
      config.fields.itemDescription.alignment
    );

    // Session Details (date and time, left aligned)
    const sessionDetails = `${new Date(receiptDetails.session_date).toLocaleDateString('en-IN')} at ${receiptDetails.session_time}`;
    drawText(
      sessionDetails, 
      config.fields.sessionDetails.x, 
      config.fields.sessionDetails.y, 
      config.fontSizes.value,
      false,
      config.fields.sessionDetails.alignment
    );

    // Therapist Name (left aligned)
    drawText(
      receiptDetails.psychologist_name, 
      config.fields.therapistName.x, 
      config.fields.therapistName.y, 
      config.fontSizes.value,
      false,
      config.fields.therapistName.alignment
    );

    // Quantity (center aligned) - dynamic based on package or individual
    // For packages: shows package total (3, 6, etc.), for individual: shows 1
    let quantity = receiptDetails.quantity;
    
    // Fallback: if quantity is missing or is '1' but it's a package, try to determine from is_package flag
    if (!quantity || (quantity === '1' && (receiptDetails.is_package === true || receiptDetails.is_package === 'true'))) {
      // If it's a package but quantity is 1, we can't determine the actual count from receipt_details alone
      // So we'll use what's stored, but log a warning
      if (receiptDetails.is_package === true || receiptDetails.is_package === 'true') {
        console.warn('⚠️ PDF Generation - Package detected but quantity is 1, using stored value:', quantity);
      }
      quantity = quantity || '1';
    }
    
    console.log('🔍 PDF Generation - Quantity:', {
      stored_quantity: receiptDetails.quantity,
      is_package: receiptDetails.is_package,
      final_quantity: quantity
    });
    drawText(
      quantity, 
      config.fields.quantity.x, 
      config.fields.quantity.y, 
      config.fontSizes.value,
      false,
      config.fields.quantity.alignment
    );

    // Unit Price (center aligned) - only price number, no INR
    drawText(
      receiptDetails.amount, 
      config.fields.unitPrice.x, 
      config.fields.unitPrice.y, 
      config.fontSizes.value,
      false,
      config.fields.unitPrice.alignment
    );

    // Line Total (right aligned) - same font weight as unit price, no INR
    drawText(
      receiptDetails.amount, 
      config.fields.lineTotal.x, 
      config.fields.lineTotal.y, 
      config.fontSizes.value,
      false, // regular weight, same as unit price
      config.fields.lineTotal.alignment
    );

    // Grand Total (right aligned, bold) - currency from receiptDetails
    const currency = receiptDetails.currency || 'INR';
    drawText(
      `${currency} ${receiptDetails.amount}`, 
      config.fields.grandTotal.x, 
      config.fields.grandTotal.y, 
      config.fontSizes.value,
      true, // bold
      config.fields.grandTotal.alignment
    );

    // Save the PDF
    const pdfBytes = await pdfDoc.save();
    console.log('✅ PDF generated using template, size:', pdfBytes.length, 'bytes');
    return Buffer.from(pdfBytes);

  } catch (error) {
    console.error('❌ Error generating receipt PDF with template:', error);
    // Fallback to old method if template loading fails
    console.log('⚠️ Falling back to pdfkit method');
    return generateReceiptPDFFallback(receiptDetails);
  }
};

/**
 * Fallback PDF generation using pdfkit (original method)
 */
const generateReceiptPDFFallback = async (receiptDetails) => {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50
      });

      const chunks = [];
      
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {
        try {
          const pdfBuffer = Buffer.concat(chunks);
          console.log('✅ PDF generated successfully (fallback), size:', pdfBuffer.length, 'bytes');
          resolve(pdfBuffer);
        } catch (error) {
          console.error('❌ Error creating PDF buffer:', error);
          reject(error);
        }
      });

      doc.on('error', (error) => {
        console.error('❌ PDF generation error:', error);
        reject(error);
      });

      // Add company logo/header
      doc.fontSize(24).font('Helvetica-Bold').text('Little Care', { align: 'center' });
      doc.fontSize(12).font('Helvetica').text('Mental Health & Wellness Platform', { align: 'center' });
      doc.moveDown();

      // Add receipt title
      doc.fontSize(18).font('Helvetica-Bold').text('PAYMENT RECEIPT', { align: 'center' });
      doc.moveDown();

      // Add receipt details
      doc.fontSize(10).font('Helvetica');
      
      // Receipt number
      doc.text(`Receipt Number: ${receiptDetails.receipt_number}`);
      doc.text(`Date: ${new Date(receiptDetails.payment_date || new Date()).toLocaleDateString('en-IN')}`);
      doc.text(`Time: ${new Date(receiptDetails.payment_date || new Date()).toLocaleTimeString('en-IN')}`);
      doc.moveDown();

      // Session details
      doc.fontSize(12).font('Helvetica-Bold').text('Session Details:');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Date: ${new Date(receiptDetails.session_date).toLocaleDateString('en-IN')}`);
      doc.text(`Time: ${receiptDetails.session_time}`);
      doc.text(`Status: ${receiptDetails.session_status || 'booked'}`);
      doc.moveDown();

      // Psychologist details
      doc.fontSize(12).font('Helvetica-Bold').text('Therapist:');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Name: ${receiptDetails.psychologist_name}`);
      doc.text(`Email: ${receiptDetails.psychologist_email || 'N/A'}`);
      doc.text(`Phone: ${receiptDetails.psychologist_phone || 'N/A'}`);
      doc.moveDown();

      // Client details
      doc.fontSize(12).font('Helvetica-Bold').text('Client:');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Name: ${receiptDetails.client_name}`);
      doc.text(`Email: ${receiptDetails.client_email || 'N/A'}`);
      doc.moveDown();

      // Payment details
      doc.fontSize(12).font('Helvetica-Bold').text('Payment Details:');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Transaction ID: ${receiptDetails.transaction_id}`);
      doc.text(`Amount: ₹${receiptDetails.amount}`);
      doc.text(`Payment Date: ${new Date(receiptDetails.payment_date || new Date()).toLocaleDateString('en-IN')}`);
      doc.moveDown();

      // Footer
      doc.fontSize(10).font('Helvetica').text('Thank you for choosing Little Care for your mental health needs.', { align: 'center' });
      doc.text('For any queries, please contact our support team.', { align: 'center' });

      doc.end();

    } catch (error) {
      console.error('❌ Error generating receipt PDF:', error);
      reject(error);
    }
  });
};

/**
 * Generate next sequential short receipt number in format RCP-000001, RCP-000002, etc.
 * Queries the receipts table to find the highest existing number and increments it.
 * 
 * @returns {Promise<string>} Next receipt number in format RCP-XXXXXX (6 digits)
 */
const generateNextShortReceiptNumber = async (retryCount = 0) => {
  const maxRetries = 3;
  
  try {
    // Query for the maximum short_receipt_number
    const { data: receipts, error } = await supabaseAdmin
      .from('receipts')
      .select('short_receipt_number')
      .not('short_receipt_number', 'is', null)
      .order('short_receipt_number', { ascending: false })
      .limit(1);

    if (error) {
      console.error('❌ Error fetching receipts for short receipt number generation:', error);
      // Fallback: use timestamp-based number if query fails
      const timestamp = Date.now();
      return `RCP-${(timestamp % 1000000).toString().padStart(6, '0')}`;
    }

    let maxNumber = 0;

    if (receipts && receipts.length > 0 && receipts[0].short_receipt_number) {
      // Extract numeric part from RCP-XXXXXX format
      const receiptNumber = receipts[0].short_receipt_number;
      const match = receiptNumber.match(/^RCP-(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > maxNumber) {
          maxNumber = num;
        }
      }
    }

    // Increment and format (start from 1 if no receipts found)
    const nextNumber = maxNumber + 1;
    const shortReceiptNumber = `RCP-${nextNumber.toString().padStart(6, '0')}`;
    
    if (process.env.NODE_ENV !== 'production') {
      console.log(`✅ Generated next short receipt number: ${shortReceiptNumber} (previous max: ${maxNumber || 'none'})`);
    }
    return shortReceiptNumber;
  } catch (error) {
    console.error('❌ Error generating short receipt number:', error);
    
    // Retry on certain errors
    if (retryCount < maxRetries && error.code !== '23505') { // 23505 is unique violation
      if (process.env.NODE_ENV !== 'production') {
        console.log(`⚠️ Retrying short receipt number generation (attempt ${retryCount + 1}/${maxRetries})`);
      }
      await new Promise(resolve => setTimeout(resolve, 100 * (retryCount + 1))); // Exponential backoff
      return generateNextShortReceiptNumber(retryCount + 1);
    }
    
    // Fallback: use timestamp-based number if generation fails after retries
    const timestamp = Date.now();
    return `RCP-${(timestamp % 1000000).toString().padStart(6, '0')}`;
  }
};

// Create Razorpay payment order
const createPaymentOrder = async (req, res) => {
  try {
    console.log('🔍 Payment Request Body:', req.body);
    
    const { 
      sessionId, 
      psychologistId, 
      clientId, 
      amount, 
      packageId,
      sessionType,
      clientName,
      clientEmail,
      clientPhone,
      scheduledDate,
      scheduledTime,
      assessmentSessionId,
      assessmentType
    } = req.body;

    // SECURITY FIX: Always use clientId from authenticated user, ignore from request body
    // Get client ID from client record using user_id (payments table requires clients.id, not users.id)
    const userId = req.user.id;
    let actualClientId = null;
    
    // Priority: 1) client_id (from middleware), 2) lookup by user_id, 3) fallback to id (old system)
    if (req.user.client_id) {
      actualClientId = req.user.client_id;
    } else {
      // Lookup client record by user_id (new system)
      const { data: clientByUserId, error: errorByUserId } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (clientByUserId && !errorByUserId) {
        actualClientId = clientByUserId.id;
      } else {
        // Fallback: try old system (client.id = user.id for backward compatibility)
        const { data: clientById, error: errorById } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', userId)
          .single();

        if (clientById && !errorById) {
          actualClientId = clientById.id;
        }
      }
    }
    
    if (!actualClientId) {
      console.error('❌ Client profile not found for user:', userId);
      return res.status(404).json({
        success: false,
        message: 'Client profile not found. Please complete your profile setup.'
      });
    }
    
    // Validate required fields
    if (!scheduledDate || !scheduledTime || !psychologistId || !amount || !clientName || !clientEmail) {
      console.log('❌ Missing fields:', {
        scheduledDate: !!scheduledDate,
        scheduledTime: !!scheduledTime,
        psychologistId: !!psychologistId,
        clientId: !!actualClientId,
        amount: !!amount,
        clientName: !!clientName,
        clientEmail: !!clientEmail
      });
      return res.status(400).json({
        success: false,
        message: 'Missing required fields for payment'
      });
    }

    // SECURITY FIX: Server-side price validation
    // Validate amount against package/psychologist pricing
    let expectedPrice = null;
    
    if (packageId && packageId !== 'individual' && packageId !== 'null' && packageId !== 'undefined') {
      // Package booking - validate against package price
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: packageData, error: packageError } = await supabaseAdmin
        .from('packages')
        .select('price, psychologist_id')
        .eq('id', packageId)
        .eq('psychologist_id', psychologistId)
        .single();
      
      if (packageError || !packageData) {
        console.error('❌ Package validation failed:', packageError);
        return res.status(400).json({
          success: false,
          message: 'Invalid package selected'
        });
      }
      
      expectedPrice = packageData.price;
      console.log('💰 Package price validation:', {
        packageId,
        expectedPrice,
        providedAmount: amount
      });
    } else {
      // Individual session - validate against psychologist's individual session price
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: psychologistData, error: psychError } = await supabaseAdmin
        .from('psychologists')
        .select('individual_session_price')
        .eq('id', psychologistId)
        .single();
      
      if (psychError || !psychologistData) {
        console.error('❌ Psychologist lookup failed:', psychError);
        return res.status(400).json({
          success: false,
          message: 'Psychologist not found'
        });
      }
      
      // Use individual_session_price (column name updated, no fallback needed)
      expectedPrice = psychologistData.individual_session_price;
      console.log('💰 Individual session price validation:', {
        psychologistId,
        expectedPrice,
        providedAmount: amount
      });
    }
    
    // Validate amount matches expected price (allow 0.01 INR tolerance for rounding)
    if (expectedPrice && Math.abs(amount - expectedPrice) > 0.01) {
      console.error('❌ Price mismatch detected:', {
        expectedPrice,
        providedAmount: amount,
        difference: Math.abs(amount - expectedPrice),
        packageId: packageId || 'individual'
      });
      
      // Log price mismatch for audit
      await userInteractionLogger.logInteraction({
        userId: actualClientId,
        userRole: req.user.role,
        action: 'payment_price_mismatch',
        status: 'blocked',
        details: {
          expectedPrice,
          providedAmount: amount,
          packageId: packageId || 'individual',
          psychologistId,
          scheduledDate,
          scheduledTime
        }
      });
      
      return res.status(400).json({
        success: false,
        message: 'Payment amount does not match selected package/session price. Please refresh and try again.',
        error: 'PRICE_MISMATCH',
        expectedPrice: expectedPrice
      });
    }

    const razorpayConfig = getRazorpayConfig();
    const razorpay = getRazorpayInstance();
    
    // Validate Razorpay config
    if (!razorpayConfig || !razorpayConfig.keyId) {
      console.error('❌ Invalid Razorpay configuration:', razorpayConfig);
      return res.status(500).json({
        success: false,
        message: 'Payment gateway configuration error'
      });
    }
    
    console.log('🔧 Razorpay Config:', {
      keyId: razorpayConfig.keyId,
      successUrl: razorpayConfig.successUrl,
      failureUrl: razorpayConfig.failureUrl
    });
    
    // Generate transaction ID (receipt ID for Razorpay)
    const txnid = generateTransactionId();
    
    // Convert amount to paise (Razorpay uses smallest currency unit)
    const amountInPaise = Math.round(amount * 100);
    
    // Create Razorpay order
    const orderOptions = {
      amount: amountInPaise, // Amount in paise
      currency: 'INR',
      receipt: txnid,
      payment_capture: 1, // Auto capture payment
      notes: {
        scheduledDate: scheduledDate,
        psychologistId: psychologistId,
        clientId: actualClientId,
        packageId: packageId || '',
        scheduledTime: scheduledTime,
        assessmentSessionId: assessmentSessionId || '',
        assessmentType: assessmentType || '',
        sessionType: sessionType,
        clientName: clientName,
        clientEmail: clientEmail
      }
    };

    console.log('📦 Creating Razorpay order...');
    let razorpayOrder;
    try {
      // Add timeout for Razorpay API call (30 seconds)
      const razorpayPromise = razorpay.orders.create(orderOptions);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Razorpay API timeout - server is taking too long to respond')), 30000)
      );
      
      razorpayOrder = await Promise.race([razorpayPromise, timeoutPromise]);
      console.log('✅ Razorpay order created:', razorpayOrder.id);
    } catch (razorpayError) {
      console.error('❌ Razorpay order creation failed:', razorpayError);
      
      // Provide user-friendly error message
      let errorMessage = 'Failed to create payment order with Razorpay';
      if (razorpayError.message?.includes('timeout')) {
        errorMessage = 'Payment gateway is taking too long to respond. Please try again in a moment.';
      } else if (razorpayError.message) {
        errorMessage = `Payment gateway error: ${razorpayError.message}`;
      }
      
      return res.status(500).json({
        success: false,
        message: errorMessage,
        error: razorpayError.message || 'Razorpay API error',
        isTimeout: razorpayError.message?.includes('timeout') || false
      });
    }

    // CRITICAL: Hold slot BEFORE creating payment record
    // This prevents double booking during payment process
    // If slot_locks table doesn't exist, this will fail gracefully and we'll use legacy mode
    let slotLockResult = null;
    try {
      const { holdSlot } = require('../services/slotLockService');
      console.log('🔒 Holding slot before payment...');
      slotLockResult = await holdSlot({
        psychologistId: psychologistId,
        clientId: actualClientId, // Use actual clientId from JWT
        scheduledDate: scheduledDate,
        scheduledTime: scheduledTime,
        orderId: razorpayOrder.id
      });

      if (!slotLockResult.success) {
        // Check if it's a table not found error (migration not run)
        if (slotLockResult.error?.includes('relation') || slotLockResult.error?.includes('does not exist')) {
          console.warn('⚠️ slot_locks table not found - using legacy mode (run migration)');
          slotLockResult = null; // Will proceed without slot lock
        } else if (slotLockResult.conflict) {
          // Real conflict - slot already booked
          console.error('❌ Failed to hold slot (conflict):', slotLockResult.error);
          
          // Cancel Razorpay order if slot hold failed
          try {
            await razorpay.orders.cancel(razorpayOrder.id);
          } catch (cancelError) {
            console.warn('⚠️ Failed to cancel Razorpay order:', cancelError);
          }

          return res.status(409).json({
            success: false,
            message: slotLockResult.error || 'This time slot is already booked. Please select another time.',
            conflict: true
          });
        } else {
          // Other error - release any partial lock if created, then continue in legacy mode
          if (slotLockResult.data?.id) {
            try {
              const { releaseSlotLock } = require('../services/slotLockService');
              await releaseSlotLock(razorpayOrder.id);
              console.log('🔓 Released partial slot lock due to error');
            } catch (releaseError) {
              console.warn('⚠️ Failed to release partial slot lock:', releaseError);
            }
          }
          // Other error - log but continue (legacy mode)
          console.warn('⚠️ Slot lock failed, continuing in legacy mode:', slotLockResult.error);
          slotLockResult = null;
        }
      } else {
        console.log('✅ Slot held successfully:', {
          lockId: slotLockResult.data.id,
          expiresAt: slotLockResult.data.slot_expires_at
        });
      }
    } catch (slotError) {
      // Table doesn't exist or other error - continue in legacy mode
      console.warn('⚠️ Slot lock service error, using legacy mode:', slotError.message);
      slotLockResult = null;
    }

    // Store pending payment record
    console.log('💾 Creating payment record in database...');
    // Only log assessment booking check if it's actually an assessment booking
    if (assessmentSessionId || assessmentType) {
    console.log('🔍 Assessment booking check:', {
        assessmentSessionId: assessmentSessionId || null,
        assessmentType: assessmentType || null,
      hasAssessmentSessionId: !!assessmentSessionId
    });
    }
    
    const paymentData = {
      transaction_id: txnid,
      razorpay_order_id: razorpayOrder.id, // Store Razorpay order ID
      session_id: null, // Will be set after payment success
      psychologist_id: psychologistId,
      client_id: actualClientId, // Use actual clientId from JWT token
      package_id: packageId === 'individual' ? null : packageId, // Set to null for individual sessions
      amount: amount,
      session_type: sessionType,
      status: 'pending',
      razorpay_params: {
        orderId: razorpayOrder.id,
        amount: amountInPaise,
        currency: 'INR',
        receipt: txnid,
        notes: {
          ...orderOptions.notes,
          clientId: actualClientId // Store actual clientId in notes
        }
      },
      created_at: new Date().toISOString()
    };
    
    // Add assessment_session_id if assessment booking (only if column exists)
    if (assessmentSessionId) {
      paymentData.assessment_session_id = assessmentSessionId;
      console.log('🔍 Adding assessment_session_id to payment data:', assessmentSessionId);
    }
    
    console.log('🔍 Final payment data (excluding razorpay_params):', {
      ...paymentData,
      razorpay_params: '[REDACTED]'
    });
    
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: paymentRecord, error: paymentError } = await supabaseAdmin
      .from('payments')
      .insert([paymentData])
      .select()
      .single();

    if (paymentError) {
      console.error('❌ Error creating payment record:', paymentError);
      console.error('❌ Payment data attempted:', JSON.stringify(paymentData, null, 2));
      console.error('❌ Full error details:', {
        message: paymentError.message,
        code: paymentError.code,
        details: paymentError.details,
        hint: paymentError.hint
      });
      
      // Release slot lock if payment record creation failed
      if (slotLockResult?.success && slotLockResult?.data) {
        try {
          const { releaseSlotLock } = require('../services/slotLockService');
          await releaseSlotLock(razorpayOrder.id);
          console.log('🔓 Released slot lock due to payment record creation failure');
        } catch (releaseError) {
          console.error('⚠️ Failed to release slot lock:', releaseError);
        }
      }
      
      return res.status(500).json({
        success: false,
        message: 'Failed to create payment record',
        error: paymentError.message || 'Database error'
      });
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('✅ Payment record created successfully:', paymentRecord.id);
      console.log('📤 Sending payment response to frontend...');
    }
    
    // Prepare response data
    const responseData = {
      success: true,
      data: {
        paymentId: paymentRecord.id,
        transactionId: txnid,
        orderId: razorpayOrder.id,
        amount: amount,
        amountInPaise: amountInPaise,
        currency: 'INR',
        keyId: razorpayConfig.keyId,
        name: 'Little Care',
        description: assessmentType === 'assessment' ? `Assessment Session - ${sessionType}` : `Therapy Session - ${sessionType}`,
        prefill: {
          name: clientName,
          email: clientEmail,
          contact: clientPhone || ''
        },
        notes: orderOptions.notes,
        theme: {
          color: '#3b82f6'
        }
      }
    };
    
    // Send response - ensure it completes
    try {
      res.json(responseData);
      if (process.env.NODE_ENV !== 'production') {
        console.log('✅ Payment response sent successfully');
      }
    } catch (responseError) {
      console.error('❌ Error sending payment response:', responseError);
      // Try to send error response if json() failed
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Failed to send payment response'
        });
      }
    }

  } catch (error) {
    console.error('Error creating payment order:', error);
    
    // Release slot lock if it was created but payment order creation failed
    if (slotLockResult?.success && slotLockResult?.data && razorpayOrder?.id) {
      try {
        const { releaseSlotLock } = require('../services/slotLockService');
        await releaseSlotLock(razorpayOrder.id);
        console.log('🔓 Released slot lock due to payment order creation failure');
      } catch (releaseError) {
        console.error('⚠️ Failed to release slot lock:', releaseError);
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create payment order'
    });
  }
};

// Handle Razorpay success response
const handlePaymentSuccess = async (req, res) => {
  try {
    console.log('🚀 Payment Success Handler Called');
    console.log('📥 Request body:', JSON.stringify(req.body, null, 2));
    console.log('📥 Request headers:', req.headers);
    
    const razorpayConfig = getRazorpayConfig();
    const params = req.body;
    
    // Log payment success callback received (before we have clientId from payment record)
    await userInteractionLogger.logInteraction({
      userId: 'pending', // Will be updated after payment record lookup
      userRole: 'client',
      action: 'payment_success_callback',
      status: 'received',
      details: {
        razorpayOrderId: params?.razorpay_order_id,
        razorpayPaymentId: params?.razorpay_payment_id,
        hasSignature: !!params?.razorpay_signature
      }
    });

    console.log('✅ Razorpay Success Response received:', {
      razorpay_order_id: params?.razorpay_order_id,
      razorpay_payment_id: params?.razorpay_payment_id,
      has_signature: !!params?.razorpay_signature
    });

    // Extract Razorpay payment details
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = params;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.error('❌ Missing Razorpay payment details');
      return res.status(400).json({
        success: false,
        message: 'Missing payment verification details'
      });
    }

    // Find payment record by Razorpay order ID
    // Use FOR UPDATE lock in PostgreSQL to prevent concurrent processing
    // Note: Supabase doesn't support FOR UPDATE directly, so we'll use atomic updates instead
    console.log('🔍 Looking up payment record for order:', razorpay_order_id);
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: paymentRecord, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('razorpay_order_id', razorpay_order_id)
      .single();

    if (paymentError) {
      console.error('❌ Payment record lookup error:', paymentError);
      console.error('   Error code:', paymentError.code);
      console.error('   Error message:', paymentError.message);
      console.error('   Error details:', paymentError.details);
      console.error('   Error hint:', paymentError.hint);
      
      // Log payment lookup failure
      await userInteractionLogger.logInteraction({
        userId: 'pending',
        userRole: 'client',
        action: 'payment_record_lookup',
        status: 'failure',
        details: {
          razorpayOrderId: razorpay_order_id,
          errorCode: paymentError.code,
          errorMessage: paymentError.message
        },
        error: paymentError
      });
      
      return res.status(404).json({
        success: false,
        message: 'Payment record not found',
        error: paymentError.message
      });
    }

    if (!paymentRecord) {
      console.error('❌ Payment record not found for order:', razorpay_order_id);
      console.error('   No error returned, but paymentRecord is null/undefined');
      
      // Log payment record not found
      await userInteractionLogger.logInteraction({
        userId: 'pending',
        userRole: 'client',
        action: 'payment_record_lookup',
        status: 'failure',
        details: {
          razorpayOrderId: razorpay_order_id,
          errorMessage: 'Payment record not found (null/undefined)'
        },
        error: new Error('Payment record not found')
      });
      
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }

    console.log('✅ Payment record found:', {
      paymentId: paymentRecord.id,
      clientId: paymentRecord.client_id,
      psychologistId: paymentRecord.psychologist_id,
      status: paymentRecord.status,
      amount: paymentRecord.amount
    });

    // Verify payment signature
    console.log('🔍 Verifying payment signature...');
    console.log('   Order ID:', razorpay_order_id);
    console.log('   Payment ID:', razorpay_payment_id);
    console.log('   Has signature:', !!razorpay_signature);
    console.log('   Has key secret:', !!razorpayConfig.keySecret);
    
    let isValidSignature = false;
    try {
      isValidSignature = verifyPaymentSignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      razorpayConfig.keySecret
    );
      console.log('   Signature verification result:', isValidSignature);
    } catch (sigError) {
      console.error('❌ Error during signature verification:', sigError);
      console.error('   Error message:', sigError.message);
      console.error('   Error stack:', sigError.stack);
      
      // Log signature verification error
      await userInteractionLogger.logInteraction({
        userId: paymentRecord.client_id || 'pending',
        userRole: 'client',
        action: 'payment_signature_verification',
        status: 'failure',
        details: {
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          paymentId: paymentRecord.id,
          errorType: 'signature_verification_exception',
          errorMessage: sigError.message
        },
        error: sigError
      });
      
      return res.status(500).json({
        success: false,
        message: 'Error verifying payment signature',
        error: sigError.message
      });
    }
    
    // Use clientId from payment record for logging
    const clientId = paymentRecord.client_id;
    console.log('✅ Client ID from payment record:', clientId);
    
    // Log signature verification
    await userInteractionLogger.logInteraction({
      userId: clientId,
      userRole: 'client',
      action: 'payment_signature_verification',
      status: isValidSignature ? 'success' : 'failure',
      details: {
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        paymentId: paymentRecord.id
      }
    });

    if (!isValidSignature) {
      console.error('❌ Invalid Razorpay payment signature');
      
      // Log invalid signature
      await userInteractionLogger.logInteraction({
        userId: clientId,
        userRole: 'client',
        action: 'payment_signature_verification',
        status: 'failure',
        details: {
          paymentId: paymentRecord.id,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          errorType: 'invalid_signature'
        },
        error: new Error('Invalid Razorpay payment signature')
      });
      
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }

    console.log('✅ Payment signature verified successfully');

    // Use data from payment record (clientId already defined above)
    const actualPsychologistId = paymentRecord.psychologist_id;
    const actualScheduledDate = paymentRecord.razorpay_params?.notes?.scheduledDate;
    const actualScheduledTime = paymentRecord.razorpay_params?.notes?.scheduledTime;
    const actualPackageId = paymentRecord.package_id;
    const isAssessment = paymentRecord.assessment_session_id || paymentRecord.razorpay_params?.notes?.assessmentType === 'assessment';
    const actualAssessmentSessionId = paymentRecord.assessment_session_id || paymentRecord.razorpay_params?.notes?.assessmentSessionId;

    // Check if already processed (early return for already completed payments)
    if (paymentRecord.status === 'success') {
      console.log('ℹ️ Payment already processed, returning early');
      console.log('   Payment ID:', paymentRecord.id);
      console.log('   Payment status:', paymentRecord.status);
      console.log('   Session ID:', paymentRecord.session_id);
      
      // Log duplicate request
      await userInteractionLogger.logInteraction({
        userId: clientId,
        userRole: 'client',
        action: 'payment_duplicate_request',
        status: 'skipped',
        details: {
          paymentId: paymentRecord.id,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          reason: 'Payment already processed',
          sessionId: paymentRecord.session_id
        }
      });
      
      return res.json({
        success: true,
        message: 'Payment already processed',
        sessionId: paymentRecord.session_id
      });
    }

    // Check if session_id is already set (indicates payment is being processed or already processed)
    // This is a more reliable check than status since session_id is set atomically
    if (paymentRecord.session_id) {
      console.log('ℹ️ Payment already has a session, returning early');
      console.log('   Payment ID:', paymentRecord.id);
      console.log('   Session ID:', paymentRecord.session_id);
      console.log('   Payment status:', paymentRecord.status);
      
      // Re-fetch payment to get current status
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: currentPayment } = await supabaseAdmin
        .from('payments')
        .select('status, session_id')
        .eq('id', paymentRecord.id)
        .single();
      
      // Log duplicate request
      await userInteractionLogger.logInteraction({
        userId: clientId,
        userRole: 'client',
        action: 'payment_duplicate_request',
        status: 'skipped',
        details: {
          paymentId: paymentRecord.id,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          reason: 'Payment already has session_id (being processed or completed)',
          currentStatus: currentPayment?.status || 'unknown',
          sessionId: currentPayment?.session_id
        }
      });
      
      return res.json({
        success: true,
        message: 'Payment is being processed or already completed',
        sessionId: currentPayment?.session_id
      });
    }

    console.log('✅ Payment validated, creating session...');
    console.log('   Payment status before processing:', paymentRecord.status);
    console.log('   Client ID:', clientId);
    console.log('   Psychologist ID:', actualPsychologistId);
    console.log('   Scheduled Date:', actualScheduledDate);
    console.log('   Scheduled Time:', actualScheduledTime);

    // Check if this is an assessment booking
    if (isAssessment && actualAssessmentSessionId) {
      // Update assessment session status to booked
      const { data: assessmentSession, error: assessError } = await supabaseAdmin
        .from('assessment_sessions')
        .update({
          status: 'booked',
          payment_id: paymentRecord.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', actualAssessmentSessionId)
        .eq('status', 'reserved')
        .select('*')
        .single();

      if (assessError || !assessmentSession) {
        console.error('❌ Assessment session update failed:', assessError);
        return res.status(500).json({
          success: false,
          message: 'Failed to update assessment session after payment'
        });
      }

      console.log('✅ Assessment session booked successfully:', assessmentSession.id);

      let sessionWithMeet = assessmentSession;
      try {
        const { session: enrichedSession } = await assessmentSessionService.finalizeAssessmentSessionBooking(assessmentSession.id, {
          durationMinutes: 50
        });
        if (enrichedSession) {
          sessionWithMeet = enrichedSession;
        }
      } catch (notifyError) {
        console.error('⚠️ Failed to finalize assessment session notifications:', notifyError?.message || notifyError);
      }

      // Block the booked slot from availability (best-effort)
      try {
        const hhmm = (assessmentSession.scheduled_time || '').substring(0,5);
        const { data: avail } = await supabaseAdmin
          .from('availability')
          .select('id, time_slots')
          .eq('psychologist_id', assessmentSession.psychologist_id)
          .eq('date', assessmentSession.scheduled_date)
          .single();
        if (avail && Array.isArray(avail.time_slots)) {
          const filtered = avail.time_slots.filter(t => (typeof t === 'string' ? t.substring(0,5) : String(t).substring(0,5)) !== hhmm);
          if (filtered.length !== avail.time_slots.length) {
            await supabaseAdmin
              .from('availability')
              .update({ time_slots: filtered, updated_at: new Date().toISOString() })
              .eq('id', avail.id);
            console.log('✅ Availability updated to block booked assessment slot', { date: assessmentSession.scheduled_date, time: hhmm });
          }
        }
      } catch (blockErr) {
        console.warn('⚠️ Failed to update availability after assessment booking:', blockErr?.message);
      }

      // After first session is booked, create 2 additional sessions for psychologists to schedule
      try {
        // Get assessment details for pricing
        const { data: assessmentData } = await supabaseAdmin
          .from('assessments')
          .select('assessment_price')
          .eq('id', assessmentSession.assessment_id)
          .single();

        // Get client details for the new sessions
        const { data: clientData } = await supabaseAdmin
          .from('clients')
          .select('user_id, id')
          .eq('id', assessmentSession.client_id)
          .single();

        const assessmentPrice = assessmentData?.assessment_price || 5000;

        // Get the actual user_id from the client record
        // If client has user_id, use it; otherwise try to get it from the assessment session
        const actualUserId = clientData?.user_id || assessmentSession.user_id;
        
        // If still no user_id, we need to find it from the users table using client email or other means
        if (!actualUserId) {
          console.warn('⚠️ No user_id found in client or assessment session, attempting to find user by client email');
          // Try to get user_id from users table if client has email
          // This is a fallback for old clients that might not have user_id set
        }

        // Create 2 additional sessions with status 'pending' - unassigned (psychologist_id = null)
        // Any psychologist can schedule these sessions and assign them to any psychologist
        const additionalSessions = [];

        console.log('🔍 Creating pending sessions - unassigned (any psychologist can schedule):', {
          assessment_id: assessmentSession.assessment_id,
          user_id: actualUserId,
          client_id: assessmentSession.client_id,
          note: 'Pending sessions are unassigned - any psychologist can schedule them with any psychologist'
        });

        additionalSessions.push({
          user_id: actualUserId, // Use the actual user_id from client record
          client_id: assessmentSession.client_id,
          assessment_id: assessmentSession.assessment_id,
          assessment_slug: assessmentSession.assessment_slug,
          psychologist_id: null, // Unassigned - can be assigned to any psychologist when scheduled
          scheduled_date: null, // To be set by psychologist
          scheduled_time: null, // To be set by psychologist
          amount: assessmentPrice,
          currency: 'INR',
          status: 'pending', // Status for psychologist to schedule
          payment_id: paymentRecord.id, // Link to the same payment
          created_at: new Date().toISOString()
        });

        additionalSessions.push({
          user_id: actualUserId, // Use the actual user_id from client record
          client_id: assessmentSession.client_id,
          assessment_id: assessmentSession.assessment_id,
          assessment_slug: assessmentSession.assessment_slug,
          psychologist_id: null, // Unassigned - can be assigned to any psychologist when scheduled
          scheduled_date: null, // To be set by psychologist
          scheduled_time: null, // To be set by psychologist
          amount: assessmentPrice,
          currency: 'INR',
          status: 'pending', // Status for psychologist to schedule
          payment_id: paymentRecord.id, // Link to the same payment
          created_at: new Date().toISOString()
        });

        // Also update the first session to mark it as session 1 (if column exists)
        try {
          await supabaseAdmin
            .from('assessment_sessions')
            .update({ session_number: 1 })
            .eq('id', assessmentSession.id);
        } catch (updateError) {
          // Ignore if session_number column doesn't exist yet
          console.log('Note: session_number column may not exist yet:', updateError.message);
        }

        // Insert the 2 additional sessions
        const { data: newSessions, error: insertError } = await supabaseAdmin
          .from('assessment_sessions')
          .insert(additionalSessions)
          .select('*');

        if (insertError) {
          console.error('❌ Error creating additional assessment sessions:', insertError);
          console.error('❌ Insert data attempted:', JSON.stringify(additionalSessions, null, 2));
          // Don't fail the payment, just log the error
        } else {
          console.log('✅ Created 2 additional unassigned assessment sessions (any psychologist can schedule):', newSessions.map(s => ({
            id: s.id,
            psychologist_id: s.psychologist_id,
            status: s.status,
            scheduled_date: s.scheduled_date
          })));
        }
      } catch (error) {
        console.error('❌ Error creating additional assessment sessions:', error);
        // Don't fail the payment, just log the error
      }

      // Update payment record
      await supabaseAdmin
        .from('payments')
        .update({ status: 'success', completed_at: new Date().toISOString() })
        .eq('id', paymentRecord.id);

      return res.json({
        success: true,
        message: 'Assessment session booked successfully. 2 additional sessions have been created for psychologists to schedule.',
        data: { assessmentSessionId: assessmentSession.id, session: sessionWithMeet }
      });
    }

    // Regular therapy session booking (existing code)
    // Get client and psychologist details for session creation
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: clientDetails, error: clientDetailsError } = await supabaseAdmin
      .from('clients')
      .select(`
        *,
        user:users(email)
      `)
      .eq('id', clientId)
      .single();

    if (clientDetailsError || !clientDetails) {
      console.error('❌ Error fetching client details:', clientDetailsError);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch client details'
      });
    }

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologistDetails, error: psychologistDetailsError } = await supabaseAdmin
      .from('psychologists')
      .select('first_name, last_name, email, phone, google_calendar_credentials')
      .eq('id', actualPsychologistId)
      .single();

    if (psychologistDetailsError || !psychologistDetails) {
      console.error('❌ Error fetching psychologist details:', psychologistDetailsError);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch psychologist details'
      });
    }

    // SECURITY FIX: Check if slot lock expired but payment order matches
    // This allows session creation even if lock expired during payment (prevents UX failure)
    let allowSessionCreation = true;
    try {
      const { checkPaymentOrderMatchesLock } = require('../services/slotLockService');
      const lockCheck = await checkPaymentOrderMatchesLock(razorpay_order_id, clientId);
      
      if (lockCheck.success && lockCheck.matches) {
        console.log('✅ Payment order matches slot lock - allowing session creation even if expired');
        allowSessionCreation = true;
      } else {
        // Check if slot is actually available (no active bookings)
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { data: conflictingSessions } = await supabaseAdmin
          .from('sessions')
          .select('id')
          .eq('psychologist_id', actualPsychologistId)
          .eq('scheduled_date', actualScheduledDate)
          .eq('scheduled_time', actualScheduledTime)
          .in('status', ['booked', 'rescheduled']);
        
        if (conflictingSessions && conflictingSessions.length > 0) {
          console.error('❌ Slot already booked by another user');
          allowSessionCreation = false;
        }
      }
    } catch (lockCheckError) {
      console.warn('⚠️ Error checking slot lock, proceeding with session creation:', lockCheckError);
      // Continue anyway - better to allow session creation than block legitimate payment
    }

    if (!allowSessionCreation) {
      console.error('❌ Cannot create session - slot already booked');
      // Revert payment status but keep payment record for refund
      await supabaseAdmin
        .from('payments')
        .update({
          status: 'pending', // Keep as pending for manual review/refund
          razorpay_payment_id: razorpay_payment_id,
          razorpay_response: params
        })
        .eq('id', paymentRecord.id);
      
      return res.status(409).json({
        success: false,
        message: 'This time slot was just booked by another user. Your payment will be refunded.',
        error: 'DOUBLE_BOOKING_AFTER_PAYMENT'
      });
    }

    // Create the actual session IMMEDIATELY (don't wait for gmeet link)
    // Gmeet link will be created asynchronously and session will be updated later
    // Use ON CONFLICT DO NOTHING to handle race conditions gracefully
    const sessionData = {
      client_id: clientId,
      psychologist_id: actualPsychologistId,
      scheduled_date: actualScheduledDate,
      scheduled_time: actualScheduledTime,
      status: 'booked',
      price: paymentRecord.amount,
      payment_id: paymentRecord.id,
      original_scheduled_date: actualScheduledDate
    };

    // Only add package_id if it's provided and valid (not individual)
    if (actualPackageId && actualPackageId !== 'null' && actualPackageId !== 'undefined' && actualPackageId !== 'individual') {
      sessionData.package_id = actualPackageId;
    }

    // Don't add meet data yet - will be added asynchronously

    // Try to insert session - if duplicate key error, another request already created it
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (sessionError) {
      console.error('❌ Session creation failed:', sessionError);

      // Check if it's a unique constraint violation (double booking or concurrent request)
      if (
        sessionError.code === '23505' ||
        sessionError.message?.includes('unique') ||
        sessionError.message?.includes('duplicate')
      ) {
        console.log('⚠️ Duplicate session detected - checking if another request already created it');

        // Try to find the existing session that was created by another concurrent request
        const { data: existingSession } = await supabaseAdmin
          .from('sessions')
          .select('id, client_id, psychologist_id, scheduled_date, scheduled_time, status, payment_id')
          .eq('psychologist_id', actualPsychologistId)
          .eq('scheduled_date', actualScheduledDate)
          .eq('scheduled_time', actualScheduledTime)
          .eq('status', 'booked')
          .maybeSingle();

        if (existingSession && existingSession.client_id === clientId && existingSession.payment_id === paymentRecord.id) {
          // Same client AND same payment - this is definitely a duplicate request, not a double booking
          console.log('ℹ️ Duplicate request detected - session already exists for this payment');
          console.log('   Existing session ID:', existingSession.id);
          console.log('   Session payment_id:', existingSession.payment_id);
          console.log('   Current payment_id:', paymentRecord.id);
          
          // Try to atomically update payment status to success and link session_id
          // This ensures only one request successfully updates the payment
          const { data: updatedPayment, error: updateError } = await supabaseAdmin
            .from('payments')
            .update({
              status: 'success',
              razorpay_payment_id: razorpay_payment_id,
              razorpay_response: params,
              session_id: existingSession.id,
              completed_at: new Date().toISOString()
            })
            .eq('id', paymentRecord.id)
            .eq('status', 'pending') // Only update if still pending (atomic check-and-set)
            .select('*')
            .single();

          // Return success regardless of whether update succeeded
          // (another request may have already updated it)
          return res.json({
            success: true,
            message: 'Payment already processed by another concurrent request',
            data: {
              sessionId: existingSession.id,
              transactionId: paymentRecord.transaction_id,
              razorpayPaymentId: razorpay_payment_id,
              amount: paymentRecord.amount
            }
          });
        }

        // Different client or session not linked to payment - this is a real double booking
        console.log('⚠️ Double booking detected - slot was just booked by another user');

        // Log double booking scenario
        await userInteractionLogger.logInteraction({
          userId: clientId,
          userRole: 'client',
          action: 'booking_double_booking',
          status: 'failure',
          details: {
            paymentId: paymentRecord.id,
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            psychologistId: actualPsychologistId,
            scheduledDate: actualScheduledDate,
            scheduledTime: actualScheduledTime,
            errorType: 'double_booking_after_payment',
            existingSessionId: existingSession?.id
          },
          error: sessionError
        });

        // Instead of deleting the payment, preserve it as a usable credit-like record
        // (paid, but no session). We keep status as 'pending' but attach Razorpay details.
        // Use supabaseAdmin to ensure we can update even if status is 'processing'
        try {
          await supabaseAdmin
            .from('payments')
            .update({
              status: 'pending',
              razorpay_payment_id: razorpay_payment_id,
              razorpay_response: params,
              // Keep session_id null so it can be used for a future booking
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', paymentRecord.id);
          console.log('✅ Payment status reverted to pending after double booking');
        } catch (creditError) {
          console.error('⚠️ Failed to update payment after double booking:', creditError);
        }

        return res.status(409).json(
          errorResponse('This time slot was just booked by another user. Your payment is safe – please choose another available time.')
        );
      }

      // Log payment success but session creation failure (non-duplicate error)
      await userInteractionLogger.logBooking({
        userId: clientId,
        userRole: 'client',
        psychologistId: actualPsychologistId,
        packageId: actualPackageId,
        scheduledDate: actualScheduledDate,
        scheduledTime: actualScheduledTime,
        price: paymentRecord.amount,
        status: 'failure',
        error: sessionError,
        details: {
          paymentId: paymentRecord.id,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          paymentStatus: 'success',
          sessionCreationFailed: true,
          errorType: 'session_creation_failed_after_payment'
        }
      });

      // Send error notification email to admin
      try {
        await emailService.sendEmail({
          to: 'abhishekravi063@gmail.com',
          subject: '🚨 Booking Failed After Payment - Action Required',
          html: `
            <h2>Booking Failed After Payment</h2>
            <p><strong>Error:</strong> Failed to create session after payment</p>
            <p><strong>Payment Order ID:</strong> ${razorpay_order_id}</p>
            <p><strong>Payment ID:</strong> ${razorpay_payment_id}</p>
            <p><strong>Client ID:</strong> ${clientId}</p>
            <p><strong>Psychologist ID:</strong> ${actualPsychologistId}</p>
            <p><strong>Scheduled Date:</strong> ${actualScheduledDate}</p>
            <p><strong>Scheduled Time:</strong> ${actualScheduledTime}</p>
            <p><strong>Error Details:</strong> ${JSON.stringify(sessionError, null, 2)}</p>
            <p><strong>Payment Record:</strong> ${JSON.stringify(paymentRecord, null, 2)}</p>
            <p><em>Please investigate and manually create the session if needed.</em></p>
            <p><em>This error has been logged to Google Drive user interaction logs.</em></p>
          `
        });
        console.log('✅ Error notification email sent to admin');
      } catch (emailErr) {
        console.error('❌ Failed to send error notification email:', emailErr);
      }
      
      return res.status(500).json({
        success: false,
        message: 'Failed to create session after payment. Our team has been notified and will resolve this shortly.'
      });
    }

    console.log('✅ Session created successfully:', session.id);

    // Block the booked slot from availability IMMEDIATELY
    try {
      const availabilityService = require('../utils/availabilityCalendarService');
      await availabilityService.updateAvailabilityOnBooking(
        actualPsychologistId,
        actualScheduledDate,
        actualScheduledTime
      );
      console.log('✅ Availability updated to block booked slot');
    } catch (blockErr) {
      console.warn('⚠️ Failed to update availability after booking:', blockErr?.message);
      // Log availability update failure
      await userInteractionLogger.logInteraction({
        userId: clientId,
        userRole: 'client',
        action: 'availability_update',
        status: 'failure',
        details: {
          sessionId: session.id,
          psychologistId: actualPsychologistId,
          scheduledDate: actualScheduledDate,
          scheduledTime: actualScheduledTime
        },
        error: blockErr
      });
    }

    // Log comprehensive booking flow with all details
    await userInteractionLogger.logBooking({
      userId: clientId,
      userRole: 'client',
      psychologistId: actualPsychologistId,
      packageId: actualPackageId,
      scheduledDate: actualScheduledDate,
      scheduledTime: actualScheduledTime,
      price: paymentRecord.amount,
      status: 'success',
      sessionId: session.id,
      detailedFlow: {
        paymentId: paymentRecord.id,
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        paymentMethod: 'razorpay',
        bookingFlow: 'payment_success',
        paymentRequest: {
          scheduledDate: paymentRecord.scheduled_date || actualScheduledDate,
          scheduledTime: paymentRecord.scheduled_time || actualScheduledTime,
          psychologistId: actualPsychologistId,
          clientId: clientId,
          amount: paymentRecord.amount,
          packageId: actualPackageId,
          sessionType: paymentRecord.session_type,
          clientName: clientDetails?.child_name || `${clientDetails?.first_name} ${clientDetails?.last_name}`.trim(),
          clientEmail: clientDetails?.user?.email || clientDetails?.email,
          clientPhone: clientDetails?.phone_number
        },
        razorpayConfig: {
          environment: process.env.RAZORPAY_USE_PRODUCTION === 'true' ? 'production' : 'test',
          keyId: razorpayConfig?.keyId ? razorpayConfig.keyId.substring(0, 10) + '...' : null
        },
        sessionData: {
          sessionId: session.id,
          status: session.status,
          price: session.price,
          createdAt: session.created_at
        },
        paymentRecord: {
          transactionId: paymentRecord.transaction_id,
          status: 'success',
          amount: paymentRecord.amount,
          createdAt: paymentRecord.created_at
        }
      }
    });

    // Extract payment method from Razorpay response
    // Razorpay sends method in the payment entity or directly in params
    let paymentMethod = null;
    if (params.payment?.entity?.method) {
      paymentMethod = params.payment.entity.method;
    } else if (params.method) {
      paymentMethod = params.method;
    }
    
    // Atomically update payment status to completed and set session_id
    // Only update if status is still 'pending' (prevents race conditions)
    // This ensures only one request can successfully update the payment
    const updateData = {
        status: 'success',
        razorpay_payment_id: razorpay_payment_id,
        razorpay_response: params,
        session_id: session.id,
        completed_at: new Date().toISOString()
    };
    
    // Add payment_method if available
    if (paymentMethod) {
      updateData.payment_method = paymentMethod;
    }
    
    const { data: updatedPayment, error: paymentStatusUpdateError } = await supabaseAdmin
      .from('payments')
      .update(updateData)
      .eq('id', paymentRecord.id)
      .eq('status', 'pending') // Only update if still pending (atomic check-and-set)
      .select('*')
      .single();

    if (paymentStatusUpdateError || !updatedPayment) {
      // If update failed or no rows updated, another request already processed this payment
      console.log('⚠️ Payment status update failed - may have been processed by another request');
      console.log('   Update error:', paymentStatusUpdateError?.message || 'No rows updated');
      console.log('   Session was created:', session.id);
      
      // Check current payment status
      const { data: currentPayment } = await supabaseAdmin
        .from('payments')
        .select('status, session_id')
        .eq('id', paymentRecord.id)
        .single();
      
      if (currentPayment?.status === 'success' && currentPayment?.session_id) {
        console.log('✅ Payment was already processed by another request');
        // Continue with response - payment is successfully processed
      } else {
        console.error('❌ Error updating payment status:', paymentStatusUpdateError);
        // Continue anyway - session was created successfully
      }
    } else {
      console.log('✅ Payment status updated to success');
    }

    // Generate and store PDF receipt IMMEDIATELY
    console.log('📄 Generating and storing PDF receipt...');
    // Use updatedPayment if available (has latest data), otherwise use paymentRecord
    const paymentDataForReceipt = updatedPayment || paymentRecord;
    console.log('🔍 Payment data for receipt:', {
      using: updatedPayment ? 'updatedPayment' : 'paymentRecord',
      package_id: paymentDataForReceipt?.package_id,
      payment_id: paymentDataForReceipt?.id
    });
    
    let receiptResult = null;
    try {
      receiptResult = await generateAndStoreReceipt(
        session,
        { 
          ...paymentDataForReceipt, 
          completed_at: paymentDataForReceipt?.completed_at || new Date().toISOString() 
        },
        clientDetails,
        psychologistDetails
      );
      
      if (receiptResult && receiptResult.receiptNumber) {
        console.log('✅ Receipt generated successfully:', {
          receiptNumber: receiptResult.receiptNumber,
          pdfGenerated: !!receiptResult.pdfBuffer,
          pdfSize: receiptResult.pdfBuffer?.length || 0
        });
      } else {
        console.warn('⚠️ Receipt generation failed or returned no result:', receiptResult);
      }
      
      // Log receipt generation with details
      await userInteractionLogger.logReceipt({
        userId: clientId,
        userRole: 'client',
        paymentId: paymentRecord.id,
        sessionId: session.id,
        amount: paymentRecord.amount,
        status: receiptResult?.receiptNumber ? 'success' : 'partial',
        action: 'generate',
        details: {
          receiptNumber: receiptResult?.receiptNumber,
          pdfGenerated: !!receiptResult?.pdfBuffer,
          pdfSize: receiptResult?.pdfBuffer?.length || 0,
          detailsStored: !!receiptResult?.receiptDetails
        }
      });
    } catch (receiptError) {
      console.error('❌ Error generating receipt:', receiptError);
      console.error('❌ Receipt error stack:', receiptError.stack);
      // Log receipt generation failure
      await userInteractionLogger.logReceipt({
        userId: clientId,
        userRole: 'client',
        paymentId: paymentRecord.id,
        sessionId: session.id,
        amount: paymentRecord.amount,
        status: 'failure',
        action: 'generate',
        error: receiptError,
        details: {
          errorType: receiptError.name || 'Unknown',
          errorMessage: receiptError.message || String(receiptError)
        }
      });
      // Continue even if receipt generation fails
    }

    // Return success response IMMEDIATELY (don't wait for async processes)
    // Session and receipt are already created, gmeet/emails/WhatsApp will happen in background
    res.json({
      success: true,
      message: 'Payment successful and session created',
      data: {
        sessionId: session.id,
        transactionId: paymentRecord.transaction_id,
        razorpayPaymentId: razorpay_payment_id,
        amount: paymentRecord.amount
      }
      });
      
    // ASYNC: Create gmeet link, send emails and WhatsApp in background (don't wait)
    // This runs after response is sent, so it doesn't block the user
    (async () => {
      // First, verify that payment is still in 'success' status before proceeding
      // This prevents async processes from running if payment was reverted due to double booking
      try {
        const { data: currentPaymentStatus } = await supabaseAdmin
          .from('payments')
          .select('status, session_id')
          .eq('id', paymentRecord.id)
          .single();
        
        // If payment was reverted to pending (double booking detected), don't send notifications
        if (currentPaymentStatus?.status !== 'success' || currentPaymentStatus?.session_id !== session.id) {
          console.log('⚠️ Payment status changed or session mismatch - skipping async notifications');
          console.log('   Payment status:', currentPaymentStatus?.status);
          console.log('   Payment session_id:', currentPaymentStatus?.session_id);
          console.log('   Created session_id:', session.id);
          return; // Exit early - don't send notifications for reverted payments
        }
      } catch (statusCheckError) {
        console.error('⚠️ Error checking payment status before async processes:', statusCheckError);
        // Continue anyway - better to send notifications than miss them
      }
      
      // Initialize WhatsApp logs tracking at outer scope so it's accessible everywhere
      let whatsappLogs = {
        clientSent: false,
        psychologistSent: false,
        receiptSent: false,
        clientMessageIds: [],
        psychologistMessageIds: [],
        receiptMessageId: null
      };
      
      try {
        console.log('🔄 Starting async gmeet link creation and notifications...');
        
        // Create Google Meet link asynchronously
        let meetData = null;
        try {
          console.log('🔄 Creating Google Meet meeting via OAuth2 (async)...');
          
          const meetSessionData = {
        summary: `Therapy Session - ${clientDetails.child_name || clientDetails.first_name} with ${psychologistDetails.first_name}`,
        description: `Online therapy session between ${clientDetails.child_name || clientDetails.first_name} and ${psychologistDetails.first_name} ${psychologistDetails.last_name}`,
        startDate: actualScheduledDate,
        startTime: actualScheduledTime,
            endTime: addMinutesToTime(actualScheduledTime, 50),
            // Add both emails as attendees - this ensures they can join without host approval
            clientEmail: clientDetails.user?.email,
            psychologistEmail: psychologistDetails.email
          };
          
          // Get psychologist's OAuth tokens if available (for real Meet link creation)
          let userAuth = null;
          if (psychologistDetails.google_calendar_credentials) {
            const credentials = psychologistDetails.google_calendar_credentials;
            userAuth = {
              access_token: credentials.access_token,
              refresh_token: credentials.refresh_token,
              expiry_date: credentials.expiry_date
            };
            console.log('✅ Using psychologist OAuth tokens for Meet link creation');
          } else {
            console.log('⚠️ No OAuth tokens for psychologist - will use service account (may not create real Meet link)');
          }
          
          const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
      
      if (meetResult.success) {
        meetData = {
          meetLink: meetResult.meetLink,
          eventId: meetResult.eventId,
          calendarLink: meetResult.eventLink || null,
          method: meetResult.method
        };
            console.log('✅ Real Meet link created successfully (async):', meetResult);
            
            // Log Google Meet link creation
            await userInteractionLogger.logInteraction({
              userId: clientId,
              userRole: 'client',
              action: 'google_meet_creation',
              status: 'success',
              details: {
                sessionId: session.id,
                meetLink: meetResult.meetLink,
                eventId: meetResult.eventId,
                method: meetResult.method,
                hasOAuthTokens: !!userAuth
              }
            });
            
            // Update session with meet link
            await supabaseAdmin
              .from('sessions')
              .update({
                google_calendar_event_id: meetData.eventId,
                google_meet_link: meetData.meetLink,
                google_meet_join_url: meetData.meetLink,
                google_meet_start_url: meetData.meetLink,
                updated_at: new Date().toISOString()
              })
              .eq('id', session.id);
            
            console.log('✅ Session updated with meet link');
      } else {
        meetData = {
              meetLink: meetResult.meetLink,
          eventId: null,
          calendarLink: null,
          method: 'fallback'
        };
            console.log('⚠️ Using fallback Meet link (async):', meetResult.meetLink);
      }
    } catch (meetError) {
          console.error('❌ Error creating OAuth2 meeting (async):', meetError);
        }

        // Send confirmation emails with receipt (async)
        try {
          console.log('📧 Sending confirmation emails with receipt (async)...');
      
      // Use client_name from receiptDetails if available (first_name + last_name), otherwise use first_name + last_name directly
      const emailClientName = receiptResult?.receiptDetails?.client_name || 
                              `${clientDetails.first_name || ''} ${clientDetails.last_name || ''}`.trim() || 
                              'Client';
      
      await emailService.sendSessionConfirmation({
        clientName: emailClientName,
        psychologistName: `${psychologistDetails.first_name} ${psychologistDetails.last_name}`,
        sessionDate: actualScheduledDate,
        sessionTime: actualScheduledTime,
        sessionDuration: '60 minutes',
        clientEmail: clientDetails.user?.email,
        psychologistEmail: psychologistDetails.email,
        googleMeetLink: meetData?.meetLink,
        sessionId: session.id,
            transactionId: paymentRecord.transaction_id,
            amount: paymentRecord.amount,
            price: paymentRecord.amount, // Also pass as 'price' for email service
            status: session.status || 'booked',
            psychologistId: session.psychologist_id || actualPsychologistId,
            clientId: session.client_id || clientId,
            receiptId: receiptResult?.receiptId || null, // Pass receipt ID for reference
            receiptNumber: receiptResult?.receiptNumber || null,
            receiptPdfBuffer: receiptResult?.pdfBuffer || null // Pass PDF buffer to attach to email
      });
      
          console.log('✅ Confirmation emails sent successfully with receipt (async)');
          
          // Log email sending success
          await userInteractionLogger.logInteraction({
            userId: clientId,
            userRole: 'client',
            action: 'email_confirmation',
            status: 'success',
            details: {
              sessionId: session.id,
              clientEmail: clientDetails?.user?.email || clientDetails?.email,
              psychologistEmail: psychologistDetails?.email,
              hasReceipt: !!receiptResult?.pdfBuffer,
              meetLink: meetData?.meetLink
            }
          });
    } catch (emailError) {
          const failureReason = emailError?.message || 
                               emailError?.response?.data?.message || 
                               emailError?.code || 
                               'Unknown email service error';
          console.error('❌ Error sending confirmation emails (async):', failureReason);
          console.error('   Full error:', emailError);
          
          // Log email sending failure with detailed reason
          await userInteractionLogger.logInteraction({
            userId: clientId,
            userRole: 'client',
            action: 'email_confirmation',
            status: 'failure',
            details: {
              sessionId: session.id,
              clientEmail: clientDetails?.user?.email || clientDetails?.email,
              psychologistEmail: psychologistDetails?.email,
              failureReason: failureReason,
              errorCode: emailError?.code,
              errorResponse: emailError?.response?.data,
              smtpError: emailError?.smtpError,
              fullError: emailError
            },
            error: emailError
          });
    }

        // Send WhatsApp messages (async)
    try {
          console.log('📱 Sending WhatsApp messages via WhatsApp API (async)...');
          console.log('📱 Client phone:', clientDetails.phone_number);
          console.log('📱 Psychologist phone:', psychologistDetails.phone);
          console.log('📱 Meet link available:', !!meetData?.meetLink);
          console.log('📱 Receipt URL available:', !!receiptResult?.fileUrl);
      const { sendBookingConfirmation, sendWhatsAppTextWithRetry } = require('../utils/whatsappService');
      
      const clientName = clientDetails.child_name || `${clientDetails.first_name} ${clientDetails.last_name}`.trim();
      const psychologistName = `${psychologistDetails.first_name} ${psychologistDetails.last_name}`.trim();

      // Send WhatsApp to client
      const clientPhone = clientDetails.phone_number || null;
      if (clientPhone && meetData?.meetLink) {
        // Only include childName if child_name exists and is not empty/null/'Pending'
        const childName = clientDetails.child_name && 
          clientDetails.child_name.trim() !== '' && 
          clientDetails.child_name.toLowerCase() !== 'pending'
          ? clientDetails.child_name 
          : null;
        
        // Get client name from receiptDetails (first_name + last_name) for receipt filename
        const receiptClientName = receiptResult?.receiptDetails?.client_name || 
                                  `${clientDetails.first_name || ''} ${clientDetails.last_name || ''}`.trim() || null;
        
        const clientDetails_wa = {
          childName: childName,
          date: actualScheduledDate,
          time: actualScheduledTime,
          meetLink: meetData.meetLink,
          psychologistName: psychologistName, // Add psychologist name to WhatsApp message
          // Pass receipt PDF buffer so we can send the PDF via WhatsApp
          receiptPdfBuffer: receiptResult?.pdfBuffer || null,
          receiptNumber: receiptResult?.receiptNumber || null,
          clientName: receiptClientName // Client name (first_name + last_name) for receipt filename
        };
        const clientWaResult = await sendBookingConfirmation(clientPhone, clientDetails_wa);
        if (clientWaResult?.success) {
              console.log('✅ WhatsApp confirmation sent to client (receipt sent via email with PDF attachment)');
              whatsappLogs.clientSent = true;
              if (clientWaResult.data?.msgId) {
                whatsappLogs.clientMessageIds.push(clientWaResult.data.msgId);
              }
              if (clientWaResult.receiptMsgId) {
                whatsappLogs.receiptSent = true;
                whatsappLogs.receiptMessageId = clientWaResult.receiptMsgId;
              }
              
              // Log WhatsApp success
              await userInteractionLogger.logInteraction({
                userId: clientId,
                userRole: 'client',
                action: 'whatsapp_client_booking',
                status: 'success',
                details: {
                  sessionId: session.id,
                  clientPhone: clientPhone,
                  messageId: clientWaResult.data?.msgId,
                  receiptMessageId: clientWaResult.receiptMsgId,
                  hasReceipt: !!clientWaResult.receiptMsgId
                }
              });
        } else if (clientWaResult?.skipped) {
          console.log('ℹ️ Client WhatsApp skipped:', clientWaResult.reason);
          
          // Log WhatsApp skip with reason
          await userInteractionLogger.logInteraction({
            userId: clientId,
            userRole: 'client',
            action: 'whatsapp_client_booking',
            status: 'skipped',
            details: {
              sessionId: session.id,
              clientPhone: clientPhone,
              skipReason: clientWaResult.reason || 'Unknown reason'
            }
          });
        } else {
          const failureReason = clientWaResult?.error?.message || 
                               clientWaResult?.error || 
                               clientWaResult?.reason || 
                               'Unknown WhatsApp API error';
          console.warn('⚠️ Client WhatsApp send failed:', failureReason);
          
          // Log WhatsApp failure with detailed reason
          await userInteractionLogger.logInteraction({
            userId: clientId,
            userRole: 'client',
            action: 'whatsapp_client_booking',
            status: 'failure',
            details: {
              sessionId: session.id,
              clientPhone: clientPhone,
              failureReason: failureReason,
              errorDetails: clientWaResult?.error || clientWaResult
            },
            error: clientWaResult?.error || new Error(failureReason)
          });
        }
      } else {
        const skipReason = !clientPhone ? 'No client phone number' : 'No Google Meet link available';
        console.log('ℹ️ No client phone or meet link; skipping client WhatsApp');
        
        // Log WhatsApp skip with reason
        await userInteractionLogger.logInteraction({
          userId: clientId,
          userRole: 'client',
          action: 'whatsapp_client_booking',
          status: 'skipped',
          details: {
            sessionId: session.id,
            clientPhone: clientPhone,
            hasMeetLink: !!meetData?.meetLink,
            skipReason: skipReason
          }
        });
      }

      // Send WhatsApp to psychologist (single detailed message)
      const psychologistPhone = psychologistDetails.phone || null;
      if (psychologistPhone && meetData?.meetLink) {
        // Format date and time using the same functions as client messages
        const formatBookingDateShort = (dateStr) => {
          if (!dateStr) return '';
          try {
            const d = new Date(`${dateStr}T00:00:00+05:30`);
            return d.toLocaleDateString('en-IN', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              timeZone: 'Asia/Kolkata'
            });
          } catch {
            return dateStr;
          }
        };
        
        const formatFriendlyTime = (timeStr) => {
          if (!timeStr) return '';
          try {
            const [h, m] = timeStr.split(':');
            const hours = parseInt(h, 10);
            const minutes = parseInt(m || '0', 10);
            const period = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
            const displayMinutes = minutes.toString().padStart(2, '0');
            return `${displayHours}:${displayMinutes} ${period}`;
          } catch {
            return timeStr;
          }
        };
        
        const bullet = '•⁠  ⁠';
        const formattedDate = formatBookingDateShort(actualScheduledDate);
        const formattedTime = formatFriendlyTime(actualScheduledTime);
        const supportPhone = process.env.SUPPORT_PHONE || process.env.COMPANY_PHONE || '+91 95390 07766';
        
        const psychologistMessage =
          `Hey 👋\n\n` +
          `New session booked with Little Care.\n\n` +
          `${bullet}Client: ${clientName}\n` +
          `${bullet}Date: ${formattedDate}\n` +
          `${bullet}Time: ${formattedTime} (IST)\n\n` +
          `Join link:\n${meetData.meetLink}\n\n` +
          `Please be ready 5 mins early.\n\n` +
          `For help: ${supportPhone}\n\n` +
          `— Little Care 💜`;
        
        const psychologistWaResult = await sendWhatsAppTextWithRetry(psychologistPhone, psychologistMessage);
        if (psychologistWaResult?.success) {
              console.log('✅ WhatsApp notification sent to psychologist via WhatsApp API (async)');
              whatsappLogs.psychologistSent = true;
              if (psychologistWaResult.data?.msgId) {
                whatsappLogs.psychologistMessageIds.push(psychologistWaResult.data.msgId);
              }
              
              // Log WhatsApp success
              await userInteractionLogger.logInteraction({
                userId: clientId,
                userRole: 'client',
                action: 'whatsapp_psychologist_booking',
                status: 'success',
                details: {
                  sessionId: session.id,
                  psychologistPhone: psychologistPhone,
                  psychologistId: session.psychologist_id,
                  messageId: psychologistWaResult.data?.msgId
                }
              });
          } else if (psychologistWaResult?.skipped) {
            const skipReason = psychologistWaResult.reason || 'Unknown reason';
            console.log('ℹ️ Psychologist WhatsApp skipped:', skipReason);
            
            // Log WhatsApp skip with reason
            await userInteractionLogger.logInteraction({
              userId: clientId,
              userRole: 'client',
              action: 'whatsapp_psychologist_booking',
              status: 'skipped',
              details: {
                sessionId: session.id,
                psychologistPhone: psychologistPhone,
                psychologistId: session.psychologist_id,
                skipReason: skipReason
              }
            });
          } else {
            const failureReason = psychologistWaResult?.error?.message || 
                                 psychologistWaResult?.error || 
                                 psychologistWaResult?.reason || 
                                 'Unknown WhatsApp API error';
            console.warn('⚠️ Psychologist WhatsApp send failed:', failureReason);
            
            // Log WhatsApp failure with detailed reason
            await userInteractionLogger.logInteraction({
              userId: clientId,
              userRole: 'client',
              action: 'whatsapp_psychologist_booking',
              status: 'failure',
              details: {
                sessionId: session.id,
                psychologistPhone: psychologistPhone,
                psychologistId: session.psychologist_id,
                failureReason: failureReason,
                errorDetails: psychologistWaResult?.error || psychologistWaResult
              },
              error: psychologistWaResult?.error || new Error(failureReason)
            });
          }
      } else {
        const skipReason = !psychologistPhone ? 'No psychologist phone number' : 'No Google Meet link available';
        console.log('ℹ️ No psychologist phone or meet link; skipping psychologist WhatsApp');
        
        // Log WhatsApp skip with reason
        await userInteractionLogger.logInteraction({
          userId: clientId,
          userRole: 'client',
          action: 'whatsapp_psychologist_booking',
          status: 'skipped',
          details: {
            sessionId: session.id,
            psychologistPhone: psychologistPhone,
            psychologistId: session.psychologist_id,
            hasMeetLink: !!meetData?.meetLink,
            skipReason: skipReason
          }
        });
      }
      
          console.log('✅ WhatsApp messages sent successfully via UltraMsg (async)');
          
          // Log comprehensive WhatsApp summary
          await userInteractionLogger.logInteraction({
            userId: clientId,
            userRole: 'client',
            action: 'whatsapp_notifications',
            status: whatsappLogs.clientSent || whatsappLogs.psychologistSent ? 'success' : 'partial',
            details: {
              sessionId: session.id,
              clientPhone: clientPhone,
              psychologistPhone: psychologistDetails?.phone,
              ...whatsappLogs
            }
          });
    } catch (whatsappError) {
          const failureReason = whatsappError?.message || 
                               whatsappError?.response?.data?.message || 
                               whatsappError?.code || 
                               'Unknown WhatsApp service error';
          console.error('❌ Error sending WhatsApp messages (async):', failureReason);
          console.error('   Full error:', whatsappError);
          
          // Log WhatsApp failure with detailed reason
          await userInteractionLogger.logInteraction({
            userId: clientId,
            userRole: 'client',
            action: 'whatsapp_notifications',
            status: 'failure',
            details: {
              sessionId: session.id,
              clientPhone: clientPhone,
              psychologistPhone: psychologistDetails?.phone,
              failureReason: failureReason,
              errorCode: whatsappError?.code,
              errorResponse: whatsappError?.response?.data,
              apiError: whatsappError?.apiError,
              fullError: whatsappError
            },
            error: whatsappError
          });
        }
        
        console.log('✅ Async gmeet link creation and notifications completed');
        
        // Log final booking flow completion
        await userInteractionLogger.logInteraction({
          userId: clientId,
          userRole: 'client',
          action: 'booking_flow_complete',
          status: 'success',
          details: {
            sessionId: session.id,
            paymentId: paymentRecord.id,
            meetLinkCreated: !!meetData?.meetLink,
            receiptGenerated: !!receiptResult?.fileUrl,
            emailsSent: true, // Will be logged separately if fails
            whatsappSent: (whatsappLogs && (whatsappLogs.clientSent || whatsappLogs.psychologistSent)) || false,
            completedAt: new Date().toISOString()
          }
        });
      } catch (asyncError) {
        console.error('❌ Error in async background process:', asyncError);
        console.error('❌ Async error stack:', asyncError.stack);
        
        // Log the async error to user interaction logger
        try {
          await userInteractionLogger.logInteraction({
            userId: clientId,
            userRole: 'client',
            action: 'booking_async_process_failed',
            status: 'failure',
            details: {
              sessionId: session.id,
              paymentId: paymentRecord.id,
              errorType: asyncError.name || 'Unknown',
              errorMessage: asyncError.message || String(asyncError)
            },
            error: asyncError
          });
        } catch (logError) {
          console.error('❌ Failed to log async error:', logError);
        }
    }
    })(); // Immediately invoked async function - runs in background

    // Continue with async processes (don't block response)
    // If package booking, create client package record (async)
    if (actualPackageId && actualPackageId !== 'individual') {
      (async () => {
      try {
          console.log('📦 Creating client package record (async)...');
        const { data: packageData } = await supabaseAdmin
          .from('packages')
          .select('*')
          .eq('id', actualPackageId)
          .single();

        if (packageData) {
          const { created, error: clientPackageError } = await ensureClientPackageRecord({
            clientId,
            psychologistId: actualPsychologistId,
            packageId: actualPackageId,
            sessionId: session.id,
            purchasedAt: new Date().toISOString(),
            packageData,
            consumedSessions: 1
          });

          if (clientPackageError) {
            console.error('❌ Client package creation failed:', clientPackageError);
          } else if (created) {
              console.log('✅ Client package record created successfully (async)');
          } else {
            console.log('ℹ️ Client package record already existed for this session');
          }
        }
      } catch (packageError) {
          console.error('❌ Exception while creating client package (async):', packageError);
      }
      })();
    }

    // PRIORITY: Check and send reminder immediately if session is in next 1 hour (async)
    try {
      const sessionReminderService = require('../services/sessionReminderService');
      sessionReminderService.checkAndSendReminderForSessionId(session.id).catch(err => {
        console.error('❌ Error in priority reminder check:', err);
      });
    } catch (reminderError) {
      console.error('❌ Error initiating priority reminder check:', reminderError);
    }

  } catch (error) {
    console.error('❌ Error handling payment success:', error);
    console.error('   Error name:', error.name);
    console.error('   Error message:', error.message);
    console.error('   Error stack:', error.stack);
    console.error('   Request body:', JSON.stringify(req.body, null, 2));
    console.error('   Request headers:', JSON.stringify(req.headers, null, 2));
    
    // If payment was partially processed (session created but payment not updated),
    // we don't need to revert anything since we check session_id before processing
    // The payment will remain in 'pending' status and can be retried
    try {
      const params = req.body || {};
      const razorpay_order_id = params.razorpay_order_id || 'Unknown';
      
      // Try to get payment record for logging
      const { data: paymentRecord } = await supabaseAdmin
        .from('payments')
        .select('id, status, client_id, session_id')
        .eq('razorpay_order_id', razorpay_order_id)
        .single();
      
      // Log the error with user interaction logger
      const clientId = paymentRecord?.client_id || 'pending';
      
      await userInteractionLogger.logInteraction({
        userId: clientId,
        userRole: 'client',
        action: 'payment_success_handler_error',
        status: 'failure',
        details: {
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: params.razorpay_payment_id || 'Unknown',
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
          requestBody: req.body
        },
        error: error
      });
    } catch (logErr) {
      console.error('❌ Failed to log error to user interaction logger:', logErr);
    }
    
    // Send error notification email to admin
    try {
      const params = req.body || {};
      const razorpay_order_id = params.razorpay_order_id || 'Unknown';
      const razorpay_payment_id = params.razorpay_payment_id || 'Unknown';
      
      await emailService.sendEmail({
        to: 'abhishekravi063@gmail.com',
        subject: '🚨 Booking Failed After Payment - Action Required',
        html: `
          <h2>Booking Failed After Payment</h2>
          <p><strong>Error:</strong> ${error.message || 'Unknown error occurred'}</p>
          <p><strong>Error Name:</strong> ${error.name || 'N/A'}</p>
          <p><strong>Payment Order ID:</strong> ${razorpay_order_id}</p>
          <p><strong>Payment ID:</strong> ${razorpay_payment_id}</p>
          <p><strong>Error Stack:</strong></p>
          <pre>${error.stack || JSON.stringify(error, null, 2)}</pre>
          <p><strong>Request Body:</strong></p>
          <pre>${JSON.stringify(req.body, null, 2)}</pre>
          <p><em>Please investigate and manually create the session if needed.</em></p>
        `
      });
      console.log('✅ Error notification email sent to admin');
    } catch (emailErr) {
      console.error('❌ Failed to send error notification email:', emailErr);
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to process payment. Our team has been notified and will resolve this shortly.',
      error: error.message
    });
  }
};

// Handle Razorpay failure response
const handlePaymentFailure = async (req, res) => {
  try {
    const params = req.body;

    console.log('Razorpay Failure Response:', JSON.stringify(params, null, 2));

    const { razorpay_order_id, error } = params;

    // Log specific error details for risk check failures
    if (error?.reason === 'payment_risk_check_failed') {
      console.warn('⚠️ Payment Risk Check Failed:', {
        orderId: razorpay_order_id,
        errorCode: error?.code,
        errorDescription: error?.description,
        errorReason: error?.reason,
        errorStep: error?.step,
        metadata: error?.metadata
      });
    }

    if (!razorpay_order_id) {
      console.error('❌ Missing Razorpay order ID in failure response');
      return res.status(400).json({
        success: false,
        message: 'Missing order ID in failure response'
      });
    }

    // Find payment record by Razorpay order ID
    const { data: paymentRecord, error: paymentError } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('razorpay_order_id', razorpay_order_id)
      .single();

    if (paymentError || !paymentRecord) {
      console.error('Payment record not found for order:', razorpay_order_id);
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }

    // Update payment status to failed
    // Note: error_message column may not exist in all schemas, so we only update if column exists
    const updateData = {
      status: 'failed',
      razorpay_response: params,
      failed_at: new Date().toISOString()
    };
    
    // Only include error_message if it exists (will be stored in razorpay_response anyway)
    // Remove error_message field to avoid schema errors
    
    const { error: paymentFailedUpdateError } = await supabaseAdmin
      .from('payments')
      .update(updateData)
      .eq('id', paymentRecord.id);

    if (paymentFailedUpdateError) {
      console.error('Error updating payment status to failed:', paymentFailedUpdateError);
      // If update fails due to missing column, try without optional fields
      if (paymentFailedUpdateError.message?.includes('error_message')) {
        console.log('⚠️ Retrying without error_message column');
        const { error: retryError } = await supabaseAdmin
          .from('payments')
          .update({
            status: 'failed',
            razorpay_response: params,
            failed_at: new Date().toISOString()
          })
          .eq('id', paymentRecord.id);
        if (retryError) {
          console.error('Error on retry:', retryError);
        }
      }
    }

    // Release slot lock if it exists
    try {
      const { releaseSlotLock } = require('../services/slotLockService');
      const releaseResult = await releaseSlotLock(razorpay_order_id);
      if (releaseResult.success && releaseResult.released) {
        console.log('✅ Slot lock released due to payment failure');
      } else if (releaseResult.notFound) {
        console.log('ℹ️ Slot lock not found (may have been already released)');
      }
    } catch (releaseError) {
      console.error('⚠️ Failed to release slot lock:', releaseError);
    }

    // Release session slot if exists
    if (paymentRecord.session_id) {
    const { error: sessionError } = await supabaseAdmin
      .from('sessions')
      .update({
        status: 'available',
        client_id: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', paymentRecord.session_id);

    if (sessionError) {
      console.error('Error releasing session:', sessionError);
      }
    }

    // Determine user-friendly error message based on error type
    let userMessage = 'Payment failed';
    if (error?.reason === 'payment_risk_check_failed') {
      userMessage = 'Payment was declined due to security checks. Please try again or use a different payment method.';
    } else if (error?.description) {
      userMessage = error.description;
    } else if (error?.reason) {
      userMessage = `Payment failed: ${error.reason}`;
    }

    // Send admin notification for risk check failures
    if (error?.reason === 'payment_risk_check_failed') {
      try {
        // emailService is already imported at the top of the file
        await emailService.sendEmail({
          to: 'abhishekravi063@gmail.com',
          subject: '⚠️ Payment Risk Check Failed - Review Required',
          html: `
            <h2>Payment Risk Check Failed</h2>
            <p><strong>Order ID:</strong> ${razorpay_order_id}</p>
            <p><strong>Payment ID:</strong> ${error?.metadata?.payment_id || 'N/A'}</p>
            <p><strong>Error Code:</strong> ${error?.code || 'N/A'}</p>
            <p><strong>Error Description:</strong> ${error?.description || 'N/A'}</p>
            <p><strong>Error Reason:</strong> ${error?.reason || 'N/A'}</p>
            <p><strong>Error Step:</strong> ${error?.step || 'N/A'}</p>
            <p><strong>Client ID:</strong> ${paymentRecord.client_id || 'N/A'}</p>
            <p><strong>Amount:</strong> ₹${paymentRecord.amount || 'N/A'}</p>
            <p><em>This payment was declined by Razorpay's risk check system. Please review if this is a legitimate transaction.</em></p>
            <p><strong>Full Error Details:</strong></p>
            <pre>${JSON.stringify(params, null, 2)}</pre>
          `
        });
        console.log('✅ Risk check failure notification sent to admin');
      } catch (emailErr) {
        console.error('❌ Failed to send risk check failure notification:', emailErr);
      }
    }

    res.json({
      success: false,
      message: userMessage,
      data: {
        transactionId: paymentRecord.transaction_id,
        orderId: razorpay_order_id,
        errorMessage: userMessage,
        errorCode: error?.code,
        errorReason: error?.reason,
        isRiskCheckFailure: error?.reason === 'payment_risk_check_failed'
      }
    });

  } catch (error) {
    console.error('Error handling payment failure:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process payment failure'
    });
  }
};

// Get payment status
const getPaymentStatus = async (req, res) => {
  try {
    const { transactionId } = req.params;

    const { data: paymentRecord, error } = await supabaseAdmin
      .from('payments')
      .select('*')
      .eq('transaction_id', transactionId)
      .single();

    if (error || !paymentRecord) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    res.json({
      success: true,
      data: {
        status: paymentRecord.status,
        amount: paymentRecord.amount,
        sessionId: paymentRecord.session_id,
        createdAt: paymentRecord.created_at,
        completedAt: paymentRecord.completed_at
      }
    });

  } catch (error) {
    console.error('Error getting payment status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get payment status'
    });
  }
};

// Create cash payment for assessment
const createCashPayment = async (req, res) => {
  try {
    const { 
      scheduledDate, 
      scheduledTime, 
      psychologistId, 
      clientId, 
      amount, 
      clientName,
      clientEmail,
      clientPhone,
      assessmentSessionId,
      assessmentType
    } = req.body;

    if (!scheduledDate || !scheduledTime || !psychologistId || !clientId || !amount || !assessmentSessionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields for cash payment'
      });
    }

    // Generate transaction ID
    const txnid = generateTransactionId();

    // Create payment record with status 'cash'
    const { data: paymentRecord, error: paymentError } = await supabaseAdmin
      .from('payments')
      .insert({
        transaction_id: txnid,
        client_id: clientId,
        psychologist_id: psychologistId,
        amount: amount,
        currency: 'INR',
        status: 'cash', // Cash payment status
        payment_method: 'cash',
        razorpay_params: {
          notes: {
            scheduledDate: scheduledDate,
            psychologistId: psychologistId,
            clientId: clientId,
            scheduledTime: scheduledTime,
            assessmentSessionId: assessmentSessionId,
            assessmentType: assessmentType || 'assessment'
          }
        },
        assessment_session_id: assessmentSessionId,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (paymentError || !paymentRecord) {
      console.error('Error creating cash payment:', paymentError);
      return res.status(500).json({
        success: false,
        message: 'Failed to create cash payment record'
      });
    }

    // Process payment success (same as online payment)
    // This will mark the assessment session as booked and create the 2 additional sessions
    // Update assessment session status to booked
    const { data: assessmentSession, error: assessError } = await supabaseAdmin
      .from('assessment_sessions')
      .update({
        status: 'booked',
        payment_id: paymentRecord.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', assessmentSessionId)
      .eq('status', 'reserved')
      .select('*')
      .single();

    if (assessError || !assessmentSession) {
      console.error('❌ Assessment session update failed:', assessError);
      return res.status(500).json({
        success: false,
        message: 'Failed to update assessment session after cash payment'
      });
    }

    console.log('✅ Assessment session booked successfully with cash payment:', assessmentSession.id);

    // Block the booked slot from availability
    try {
      const hhmm = (assessmentSession.scheduled_time || '').substring(0,5);
      const { data: avail } = await supabaseAdmin
        .from('availability')
        .select('id, time_slots')
        .eq('psychologist_id', assessmentSession.psychologist_id)
        .eq('date', assessmentSession.scheduled_date)
        .single();
      if (avail && Array.isArray(avail.time_slots)) {
        const filtered = avail.time_slots.filter(t => (typeof t === 'string' ? t.substring(0,5) : String(t).substring(0,5)) !== hhmm);
        if (filtered.length !== avail.time_slots.length) {
          await supabaseAdmin
            .from('availability')
            .update({ time_slots: filtered, updated_at: new Date().toISOString() })
            .eq('id', avail.id);
          console.log('✅ Availability updated to block booked assessment slot', { date: assessmentSession.scheduled_date, time: hhmm });
        }
      }
    } catch (blockErr) {
      console.warn('⚠️ Failed to update availability after assessment booking:', blockErr?.message);
    }

    // Create 2 additional pending sessions (same logic as handlePaymentSuccess)
    try {
      const { data: assessmentData } = await supabaseAdmin
        .from('assessments')
        .select('assessment_price')
        .eq('id', assessmentSession.assessment_id)
        .single();

      const { data: clientData } = await supabaseAdmin
        .from('clients')
        .select('user_id, id')
        .eq('id', assessmentSession.client_id)
        .single();

      const assessmentPrice = assessmentData?.assessment_price || 5000;
      const actualUserId = clientData?.user_id || assessmentSession.user_id;

      const additionalSessions = [
        {
          user_id: actualUserId,
          client_id: assessmentSession.client_id,
          assessment_id: assessmentSession.assessment_id,
          assessment_slug: assessmentSession.assessment_slug,
          psychologist_id: null,
          scheduled_date: null,
          scheduled_time: null,
          amount: assessmentPrice,
          currency: 'INR',
          status: 'pending',
          payment_id: paymentRecord.id,
          session_number: 2,
          created_at: new Date().toISOString()
        },
        {
          user_id: actualUserId,
          client_id: assessmentSession.client_id,
          assessment_id: assessmentSession.assessment_id,
          assessment_slug: assessmentSession.assessment_slug,
          psychologist_id: null,
          scheduled_date: null,
          scheduled_time: null,
          amount: assessmentPrice,
          currency: 'INR',
          status: 'pending',
          payment_id: paymentRecord.id,
          session_number: 3,
          created_at: new Date().toISOString()
        }
      ];

      // Update first session to session_number 1
      await supabaseAdmin
        .from('assessment_sessions')
        .update({ session_number: 1 })
        .eq('id', assessmentSession.id);

      // Insert the 2 additional sessions
      const { data: newSessions, error: insertError } = await supabaseAdmin
        .from('assessment_sessions')
        .insert(additionalSessions)
        .select('*');

      if (insertError) {
        console.error('❌ Error creating additional assessment sessions:', insertError);
      } else {
        console.log('✅ Created 2 additional unassigned assessment sessions (any psychologist can schedule):', newSessions.map(s => ({
          id: s.id,
          psychologist_id: s.psychologist_id,
          status: s.status,
          scheduled_date: s.scheduled_date
        })));
      }
    } catch (error) {
      console.error('❌ Error creating additional assessment sessions:', error);
    }

    // Update payment record
    await supabaseAdmin
      .from('payments')
      .update({ status: 'cash', completed_at: new Date().toISOString() })
      .eq('id', paymentRecord.id);

    return res.json({
      success: true,
      message: 'Assessment booked successfully with cash payment. 2 additional sessions have been created for psychologists to schedule.',
      data: { assessmentSessionId: assessmentSession.id }
    });
    
  } catch (error) {
    console.error('Error creating cash payment:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error while processing cash payment'
    });
  }
};

module.exports = {
  createPaymentOrder,
  createCashPayment,
  handlePaymentSuccess,
  handlePaymentFailure,
  getPaymentStatus,
  generateAndStoreReceipt,
  generateReceiptPDF
};
