/**
 * Shared page furniture for assessment reports, matching the practice's report templates:
 * pale green page, dark green header band with an angled cut and the koott wordmark,
 * a participant detail block, green section headings, and a footer carrying the
 * assessment's own note above the contact band.
 *
 * Built with pdfkit rather than drawn onto the letterhead PDFs in the frontend's /public:
 * those carry a pre-printed disclaimer whose wording differs per assessment, there is no
 * letterhead for DASS-21 at all, and the reports need to flow over a variable number of
 * pages in both orientations. Reproducing the furniture keeps all three consistent.
 */
const PDFDocument = require('pdfkit');

const C = {
  green:     '#0B5345',   // header band, table heads
  heading:   '#0E6B57',   // section headings
  body:      '#2B2B2B',
  muted:     '#6B6B6B',
  page:      '#EFF6F0',   // pale green page
  rule:      '#C9DDD2',
  barTrack:  '#DCE8E0',
};
const M = { left: 50, right: 50, headerH: 70, footerH: 62, noteGap: 10 };

/** StandardFonts are WinAnsi-only; participants type free text, so fold to a safe subset. */
function safe(t) {
  return String(t ?? '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\xFF]/g, '');
}

class Report {
  /** @param {{orientation?:'portrait'|'landscape', note:string}} opts */
  constructor(opts) {
    this.note = opts.note;
    this.doc = new PDFDocument({
      size: 'A4',
      layout: opts.orientation || 'portrait',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false,
      bufferPages: true,
    });
    this.chunks = [];
    this.doc.on('data', (c) => this.chunks.push(c));
    this.W = (opts.orientation === 'landscape' ? 841.89 : 595.28);
    this.H = (opts.orientation === 'landscape' ? 595.28 : 841.89);
    this.contentW = this.W - M.left - M.right;
    this.addPage();
  }

  get bottomLimit() { return this.H - M.footerH - 34; }

  addPage() {
    this.doc.addPage();
    const d = this.doc;
    d.rect(0, 0, this.W, this.H).fill(C.page);                       // page tint
    // Header: a dark green trapezoid occupying the right of the band, its left edge sloping
    // down-right, exactly as on the practice's letterhead and report templates.
    d.moveTo(this.W * 0.625, 0)
      .lineTo(this.W, 0)
      .lineTo(this.W, M.headerH)
      .lineTo(this.W * 0.735, M.headerH)
      .closePath().fill(C.green);
    d.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(23)
      .text('koott', this.W - M.right - 150, M.headerH / 2 - 13, { width: 150, align: 'right' });
    this.footer();
    this.y = M.headerH + 32;
    return this;
  }

  footer() {
    const d = this.doc;
    d.fillColor(C.muted).font('Helvetica').fontSize(6.4);
    const noteH = d.heightOfString(safe(this.note), { width: this.contentW });
    d.text(safe(this.note), M.left, this.H - M.footerH - noteH - M.noteGap, { width: this.contentW });
    d.rect(0, this.H - M.footerH, this.W, M.footerH).fill(C.green);
    d.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(12.5)
      .text('Koott Care Private limited', M.left + 28, this.H - M.footerH + 17);
    d.font('Helvetica').fontSize(8.5)
      .text('Mini Bypass Rd, Puthiyara, Calicut, Kerala', M.left + 28, this.H - M.footerH + 35);
    const rx = this.W * 0.56;
    d.fontSize(9).text('+91 86060 40400', rx, this.H - M.footerH + 18);
    d.text('care@koott.in', rx, this.H - M.footerH + 34);
  }

  /** Reserve vertical space, starting a new page if it will not fit. */
  need(h) { if (this.y + h > this.bottomLimit) this.addPage(); return this; }

  title(main, sub) {
    this.need(46);
    this.doc.fillColor(C.heading).font('Helvetica').fontSize(17).text(safe(main), M.left, this.y);
    this.y += 23;
    if (sub) {
      this.doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(safe(sub), M.left, this.y);
      this.y += 16;
    }
    return this;
  }

  /** Name / date filled in; address, email, phone, DOB as ruled blanks for the clinician. */
  details(fields, x = M.left + 60, width = 430) {
    const d = this.doc, labelW = 120;
    for (const [label, value] of fields) {
      d.fillColor(C.body).font('Helvetica').fontSize(9.5).text(safe(label + ':'), x, this.y, { width: labelW });
      if (value) d.text(safe(value), x + labelW + 18, this.y, { width: width - labelW - 18 });
      else {
        const ly = this.y + 10;
        d.moveTo(x + labelW + 18, ly).lineTo(x + labelW + 18 + 215, ly).lineWidth(0.6).stroke(C.muted);
      }
      this.y += 18;
    }
    return this;
  }

  rule(pad = 12) {
    this.y += pad;
    this.doc.moveTo(M.left, this.y).lineTo(this.W - M.right, this.y).lineWidth(0.7).stroke(C.rule);
    this.y += pad;
    return this;
  }

  heading(text, size = 12.5) {
    this.need(size + 16);
    this.doc.fillColor(C.heading).font('Helvetica').fontSize(size).text(safe(text), M.left, this.y);
    this.y += size + 7;
    return this;
  }

  para(text, { size = 9, color = C.body, indent = 0, gap = 5, font = 'Helvetica' } = {}) {
    const w = this.contentW - indent;
    const h = this.doc.font(font).fontSize(size).heightOfString(safe(text), { width: w });
    this.need(h);
    this.doc.fillColor(color).text(safe(text), M.left + indent, this.y, { width: w });
    this.y += h + gap;
    return this;
  }

  /** Facet chips rendered as a single bullet-separated line, as in the templates. */
  facets(list, color = C.heading) {
    return this.para(list.join('  •  '), { size: 8.8, color, gap: 12 });
  }

  end() {
    return new Promise((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}

module.exports = { Report, C, M, safe };
