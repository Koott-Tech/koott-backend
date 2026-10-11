#!/usr/bin/env node
/**
 * Turn a filled sample report into a blank, fillable template.
 *
 * The Kalyana dummies are plain Helvetica PDFs (no design-tool form XObject), so the body text
 * can be edited directly in each page's content stream. This keeps the page furniture, the
 * table rules, the column headers and the domain names exactly as approved, and removes only
 * the sample's own content:
 *
 *   - participant values (the "(sample)" names and the sample date) become ruled blanks,
 *     so they line up with the Address / Email / Phone rows that are already blank;
 *   - every other content cell is deleted outright.
 *
 * A block is KEPT when it is empty (graphics state), matches a known structural string, is a
 * numbered domain label, or is already a ruled blank. Everything else is sample content.
 *
 * Usage:  node scripts/blank-report-template.js <sample.pdf> <out.pdf>
 */
const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const fs = require('fs');

const BLANK = '_______________________________';

// Text that belongs to the form itself rather than to the sample's answers.
const STRUCTURAL = [
  /^koott$/i,
  /^Koott Care Private limited$/i,
  /^Mini ?Bypass ?Rd/i,
  /^\+91/,
  /^care@koott\.in$/i,
  /^Note:/i,
  /^Kalyana Raman: Pre-Marital Readiness Assessment$/i,
  /^(Domain-wise Comparison|Domain-wise Themes|Client Responses|Comparison Table)$/i,
  /^Thematic Coding Summary/i,
  /^Partner [AB]$/,
  /^(Name|Date of assessment|Address|Email ID|Phone number|Date of birth):$/,
  /^(Domain|Initial code|Emergent code|Underlying theme)$/,
  /^Partner [AB]: key themes$/,
  /^(Qualitative comparison|Expected outcome \/ action|Discussion \/ action)$/,
  /^\d+\.\s+\S/,          // "1. Meaning of Marriage, ..." domain labels
  /^Q\d+\.\d+/,           // question labels on Report 1
  /^_+$/,                 // already-blank ruled fields
];

// Sample values that should become ruled blanks rather than vanish, so the rows stay aligned.
const BLANKABLE = [/\(sample\)\s*$/, /^\d{1,2} [A-Z][a-z]+ \d{4}$/];

const textOf = (block) => {
  const parts = [...block.matchAll(/\((.*?)(?<!\\)\)\s*Tj/g)].map((m) => m[1]);
  const raw = parts.length ? parts.join(' ') : [...block.matchAll(/\((.*?)(?<!\\)\)/g)].map((m) => m[1]).join(' ');
  return raw.replace(/\\([()])/g, '$1').trim();
};

const classify = (txt) => {
  if (!txt) return 'keep';
  if (STRUCTURAL.some((re) => re.test(txt))) return 'keep';
  if (BLANKABLE.some((re) => re.test(txt))) return 'blank';
  return 'drop';
};

(async () => {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) { console.error('usage: blank-report-template.js <sample.pdf> <out.pdf>'); process.exit(1); }

  const doc = await PDFDocument.load(fs.readFileSync(inPath));
  let kept = 0, blanked = 0, dropped = 0;

  for (const page of doc.getPages()) {
    const ref = page.node.get(PDFName.of('Contents'));
    const obj = doc.context.lookup(ref);
    const streams = obj.constructor.name === 'PDFArray'
      ? obj.asArray().map((r) => ({ ref: r, s: doc.context.lookup(r) }))
      : [{ ref, s: obj }];

    for (const { ref: sref, s } of streams) {
      let ops = Buffer.from(decodePDFRawStream(s).decode()).toString('latin1');
      ops = ops.replace(/BT[\s\S]*?ET/g, (block) => {
        const txt = textOf(block);
        const verdict = classify(txt);
        if (verdict === 'keep') { kept++; return block; }
        if (verdict === 'drop') { dropped++; return ''; }
        blanked++;
        // Replace every shown string in the block with one ruled blank.
        let first = true;
        return block.replace(/\((?:.*?)(?<!\\)\)\s*Tj/g, () => {
          if (!first) return '';
          first = false;
          return `(${BLANK}) Tj`;
        });
      });
      doc.context.assign(sref, PDFRawStream.of(doc.context.obj({}), Buffer.from(ops, 'latin1')));
    }
  }

  fs.writeFileSync(outPath, await doc.save());
  console.log(`kept ${kept}, blanked ${blanked}, dropped ${dropped} text blocks -> ${outPath}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
