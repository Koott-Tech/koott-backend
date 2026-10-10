/**
 * Build assets/koott-letterhead.pdf: the practice letterhead with the report body stripped out.
 *
 * The sample report is a design-tool export whose entire page is one form XObject. The
 * letterhead furniture (header shapes, wordmark, watermark, footer band, contact icons and the
 * footer text in Poppins/Gordita) and the report body live in that same form, so the body is
 * removed rather than the furniture rebuilt - that way the furniture stays pixel-identical.
 *
 * Removed: every text block set in HelveticaLTPro (the report's own type), and the image
 * XObjects that draw the report's rules and score bars. Kept: everything else.
 */
const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const fs = require('fs');

const BODY_FONTS = /\/(F25|F26|F33)\s/;            // HelveticaLTPro Bold / Roman / BoldOblique
// X19 is the infinity watermark and belongs to the letterhead; the rest draw the report's
// own rules and score bars.
const BODY_SHAPES = (process.env.BODY_SHAPES || 'X27,X29,X31,X34').split(',');

(async () => {
  const src = await PDFDocument.load(fs.readFileSync(process.argv[2]));
  const page = src.getPage(0);
  const ref = page.node.Resources().lookup(PDFName.of('XObject')).get(PDFName.of('X36'));
  const form = src.context.lookup(ref);
  const ops = Buffer.from(decodePDFRawStream(form).decode()).toString('latin1');

  let out = ops.replace(/BT[\s\S]*?ET/g, (b) => (BODY_FONTS.test(b) ? '' : b));

  // Drop the whole q..Q block around each body shape, so its clip path goes with it.
  const lines = out.split('\n');
  const kept = [];
  let depth = 0, buf = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (s === 'q') { if (depth === 0) buf = []; depth++; }
    if (depth > 0) buf.push(ln); else kept.push(ln);
    if (s === 'Q') {
      depth--;
      if (depth === 0) {
        const m = buf.join('\n').match(/\/(X\d+) Do/);
        if (!m || !BODY_SHAPES.includes(m[1])) kept.push(...buf);
        buf = [];
      }
    }
  }
  const bytes = Buffer.from(kept.join('\n'), 'latin1');
  const dict = form.dict.clone(src.context);
  dict.delete(PDFName.of('Filter'));
  dict.set(PDFName.of('Length'), src.context.obj(bytes.length));
  src.context.assign(ref, PDFRawStream.of(dict, new Uint8Array(bytes)));

  while (src.getPageCount() > 1) src.removePage(1);
  fs.writeFileSync(process.argv[3], await src.save());
  console.log('wrote', process.argv[3], bytes.length, 'bytes of content');
})();
