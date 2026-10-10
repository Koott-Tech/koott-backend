/**
 * Page furniture for assessment reports.
 *
 * The report is drawn in two passes: pdfkit lays out the text and the score bars on a
 * transparent A4 page, then pdf-lib stamps each of those pages over assets/koott-letterhead.pdf.
 * The letterhead is the practice's own artwork - header shapes, wordmark, watermark, footer band,
 * contact icons and the footer text in Poppins/Gordita - lifted verbatim from the approved sample
 * report, so the furniture is identical rather than a redrawn approximation.
 * See scripts/build-letterhead.js for how that asset is produced.
 *
 * Every measurement below (positions, sizes, colours, leading) was read off the approved sample
 * report, so the generated report matches it.
 */
const PDFDocument = require('pdfkit');
const { PDFDocument: LibPDF } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

/**
 * Each assessment has its own letterhead: the footer wording differs, and the Big Five sheet
 * carries its note pre-printed while the DASS one does not, so that report draws its own.
 */
const LETTERHEADS = {
  dass21:  { file: 'koott-letterhead.pdf',         note: true,  bottomLimit: 733 },
  bigFive: { file: 'koott-letterhead-bigfive.pdf', note: false, bottomLimit: 718 },
  kalyana: { file: 'koott-letterhead.pdf',         note: true,  bottomLimit: 733 },
};
const assetPath = (f) => path.join(__dirname, '..', '..', 'assets', f);
const PAGE = { w: 595.5, h: 842.25 };
const BOX_Y = 7.83;   // the letterhead MediaBox's y origin

const C = {
  green:     '#01584A',   // title, section headings, score figures, facets
  heading:   '#01584A',
  body:      '#212121',   // description paragraphs
  ink:       '#000000',   // detail labels and values, table head, severity, percentage
  muted:     '#333333',   // the footer note
  subtle:    '#666666',   // the Big Five report's trait contrast, e.g. "(Extraversion vs. ...)"
  rule:      '#C9C9C9',
  barTrack:  '#E8EEEA',
};

/** Type sizes, in points, as used in the sample report. */
const F = {
  title: 17.33,
  detail: 10,
  scoresHeading: 12,
  tableHead: 10,
  row: 10,
  scaleHeading: 10.67,
  body: 9.33,
  note: 6.67,
};

const M = {
  left: 56.7,            // title, headings, descriptions and facets
  right: 539.1,
  detailLabel: 85.4,
  detailValue: 198.7,
  top: 87.4,             // first baseline block on every page
  noteY: 744.9,          // the note sits above the letterhead's footer band
  bottomLimit: 733,
};
M.contentW = M.right - M.left;

/** StandardFonts are WinAnsi-only; participants type free text, so fold to a safe subset. */
function safe(t) {
  return String(t ?? '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    // U+2022 sits above \xFF, but WinAnsi does carry a bullet (0x95) and pdfkit maps it, so it
    // must survive the strip - it is the separator between facet names.
    .replace(/[^\x20-\xFF•]/g, '');
}

/** Blank detail fields are ruled with underscores in the sample, not with a drawn line. */
const BLANK = '_______________________________';

class Report {
  constructor({ note, letterhead = 'dass21', leading = 12.7, paraGap = 1.9, facetGap = 8.3 } = {}) {
    this.sheet = LETTERHEADS[letterhead] || LETTERHEADS.dass21;
    this.note = this.sheet.note ? note : null;   // pre-printed sheets already carry it
    this.leading = leading;
    this.paraGap = paraGap;
    this.facetGap = facetGap;
    this.doc = new PDFDocument({ size: [PAGE.w, PAGE.h], margin: 0, bufferPages: true });
    this.chunks = [];
    this.doc.on('data', (c) => this.chunks.push(c));
    this.y = M.top;
    this.contentW = M.contentW;
    this.bottomLimit = this.sheet.bottomLimit;
  }

  addPage() { this.doc.addPage({ size: [PAGE.w, PAGE.h], margin: 0 }); this.y = M.top; return this; }

  /** Reserve vertical space, starting a new page if it will not fit. */
  need(h) { if (this.y + h > this.bottomLimit) this.addPage(); return this; }

  title(main) {
    this.need(46);
    this.doc.fillColor(C.green).font('Helvetica-Bold').fontSize(F.title)
      .text(safe(main), M.left, this.y, { lineBreak: false });
    this.y += 25.3;
    return this;
  }

  /** Name and date are filled in; the rest are ruled blanks for the clinician. */
  details(fields) {
    const d = this.doc;
    for (const [label, value] of fields) {
      d.fillColor(C.ink).font('Helvetica-Bold').fontSize(F.detail)
        .text(safe(label + ':'), M.detailLabel, this.y, { lineBreak: false });
      d.font('Helvetica').text(safe(value || BLANK), M.detailValue, this.y, { lineBreak: false });
      this.y += 15.75;
    }
    return this;
  }

  rule(before = 4.8, after = 8.15, x0 = 65.8, x1 = 529.4) {
    this.y += before;
    this.doc.moveTo(x0, this.y).lineTo(x1, this.y).lineWidth(0.72).stroke(C.rule);
    this.y += after;
    return this;
  }

  heading(text, size = F.scaleHeading, gap = 16, subtitle) {
    this.need(size + 20);
    const d = this.doc;
    d.fillColor(C.green).font('Helvetica-Bold').fontSize(size).text(safe(text), M.left, this.y, { lineBreak: false });
    if (subtitle) {
      const x = M.left + d.widthOfString(safe(text)) + 8.8;
      d.fillColor(C.subtle).font('Helvetica').fontSize(F.body)
        .text('(' + safe(subtitle) + ')', x, this.y + 1.3, { lineBreak: false });
    }
    this.y += gap;
    return this;
  }

  para(text, { size = F.body, color = C.body, gap = this.paraGap, font = 'Helvetica', lineGap = this.leading - 10.6 } = {}) {
    const w = this.contentW;
    const opts = { width: w, lineGap };
    const h = this.doc.font(font).fontSize(size).heightOfString(safe(text), opts);
    this.need(h);
    this.doc.fillColor(color).text(safe(text), M.left, this.y, opts);
    this.y += h + gap;
    return this;
  }

  facets(list, color = C.green) {
    return this.para(list.join(' • '), { size: F.body, color, gap: this.facetGap, font: 'Helvetica-BoldOblique' });
  }

  /** The note is repeated on every page, just above the letterhead's footer band. */
  drawNote() {
    if (!this.note) return;
    const d = this.doc, x = 42.7, w = PAGE.w - 2 * x;
    const body = safe(this.note.replace(/^Note:\s*/, ''));
    d.font('Helvetica').fontSize(F.note).fillColor(C.muted)
      .text('Note: ' + body, x, M.noteY, { width: w, lineGap: 1.2 });
    d.font('Helvetica-Bold').text('Note:', x, M.noteY, { lineBreak: false });
  }

  async end() {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      this.drawNote();
    }
    this.doc.end();
    const content = await new Promise((res) => this.doc.on('end', () => res(Buffer.concat(this.chunks))));
    return stampOnLetterhead(content, this.sheet.file);
  }
}

/** Put each drawn page on top of the letterhead. */
async function stampOnLetterhead(contentPdf, file) {
  const letterhead = await LibPDF.load(fs.readFileSync(assetPath(file)));
  const content = await LibPDF.load(contentPdf);
  const out = await LibPDF.create();
  const [bg] = await out.embedPdf(letterhead, [0]);
  const pages = await out.embedPdf(content, content.getPageIndices());
  for (const p of pages) {
    const page = out.addPage([PAGE.w, PAGE.h]);
    // The letterhead's own MediaBox starts at y=7.83, not 0. Stamping it onto a page that
    // starts at 0 would lift the artwork by that much, so shift it back down.
    page.drawPage(bg, { x: 0, y: -BOX_Y, width: PAGE.w, height: PAGE.h });
    page.drawPage(p, { x: 0, y: 0, width: PAGE.w, height: PAGE.h });
  }
  return Buffer.from(await out.save());
}

module.exports = { Report, C, F, M, safe, PAGE };
