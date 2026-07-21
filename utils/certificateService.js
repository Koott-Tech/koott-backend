const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

/**
 * Generates a certificate PDF and returns it as a buffer.
 * @param {Object} data 
 * @param {string} data.participantName
 * @param {string} data.topic
 * @param {string} data.speaker
 * @param {string} data.date
 * @param {string} data.time
 * @returns {Promise<Buffer>}
 */
async function generateCertificate(data) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [1414, 2000],
        margin: 0
      });

      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        resolve(Buffer.concat(buffers));
      });
      doc.on('error', reject);

      // Load background image
      try {
        if (data.certificateTemplateUrl) {
          let imageUrl = data.certificateTemplateUrl;
          
          // If the URL is relative, prepend a dummy base or the actual base if known
          // Assuming uploaded images might be absolute URLs (e.g. Supabase Storage)
          if (imageUrl.startsWith('http')) {
            const response = await fetch(imageUrl);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              doc.image(buffer, 0, 0, { width: 1414, height: 2000 });
            } else {
              throw new Error('Failed to fetch custom template');
            }
          } else {
             // Try to find it locally if it's a relative path starting with /
             // Assuming it maps to littlecare-frontend/public or similar
             // We fallback to the default if not an HTTP url for safety
             throw new Error('Non-HTTP URL provided for custom template');
          }
        } else {
          throw new Error('No custom template URL provided');
        }
      } catch (err) {
        // Fallback to default template
        const bgPath = path.join(__dirname, '../assets/Certificate.png');
        if (fs.existsSync(bgPath)) {
          doc.image(bgPath, 0, 0, { width: 1414, height: 2000 });
        }
      }

      // Register the custom cursive font for the name
      const customFontPath = path.join(__dirname, '../assets/GreatVibes-Regular.ttf');
      if (fs.existsSync(customFontPath)) {
        doc.registerFont('CursiveFont', customFontPath);
      }

      // We will place the text block starting below "PROUDLY PRESENTED TO"
      // Based on OCR, "PROUDLY PRESENTED TO" is around Y=527.
      // So we start around Y=650.

      // 1. "This is to certify that"
      // Wait, in the layout provided, the cursive name comes immediately after "PROUDLY PRESENTED TO"
      // and THEN "This is to certify that [Participant Name] has successfully..."
      // But wait! We need to follow the EXACT layout of the user's provided snippet.
      // The snippet:
      // PROUDLY PRESENTED TO
      // Ayisha Asheequa (Large gold cursive)
      // This is to certify that Ayisha Asheequa has successfully...
      
      // So we will place the cursive name at Y=630
      doc.fontSize(130)
         .font(fs.existsSync(customFontPath) ? 'CursiveFont' : 'Helvetica-Bold')
         .fillColor('#e5b73e') // Gold color
         .text(data.participantName || 'Participant', 0, 600, { align: 'center', width: 1414 });

      // Then the standard text paragraph at Y=830
      // 5. The descriptive paragraph
      let paragraph = '';
      if (data.certificateTextTemplate) {
        paragraph = data.certificateTextTemplate.replace(/\{\{\s*participant_name\s*\}\}/g, data.participantName || 'Participant');
      } else {
        paragraph = `This is to certify that ${data.participantName || 'Participant'} has successfully participated in the workshop "${data.eventTitle || 'Workshop Event'}", conducted by Koott on ${data.date || 'July 18, 2026'}. The workshop, led by ${data.speaker || 'Dr. Thaniya k leela'}, focused on "${data.topic || 'Strengthening Therapeutic Alliances, Preventing Premature Dropout and Ethical Termination'}". This certificate recognizes your active participation and commitment to promoting ethical and effective psychotherapy practice.`;
      }

      doc.fontSize(30)
         .font('Helvetica')
         .fillColor('#444444')
         .text(paragraph, 150, 830, { 
            align: 'center', 
            width: 1114, 
            lineGap: 14 
         });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateCertificate
};
