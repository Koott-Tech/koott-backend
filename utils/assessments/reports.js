/**
 * Report builders. Each returns a PDF Buffer and writes nothing to disk or storage —
 * the buffer is attached to an email and then discarded.
 */
const fs = require('fs');
const path = require('path');
const { Report, C, F, M, safe } = require('./reportTheme');
const { scoreBigFive, scoreDass21, KR_DOMAINS } = require('./instruments');

const NOTES = {
  bigFive:
    'Note: The Big Five Personality Assessment provides insights into an individual’s personality traits and tendencies. However, the tool alone cannot provide a complete understanding of an individual’s personality or predict behaviour across all situations. You are advised to schedule a session with your therapist to review and interpret the results in the context of your personal experiences, behavioural patterns, and individual circumstances.',
  dass21:
    'Note: The DASS-21 is a screening and self-report measure of current emotional distress; it is not a diagnostic tool and cannot alone provide a complete understanding of an individual’s emotional state. You are advised to schedule a session with your therapist to review and interpret the results in the context of your personal experiences, behavioural patterns, and individual circumstances.',
  // Verbatim from the text pre-printed on koott-letterhead-kalyana.pdf, so the sheet and
  // any on-screen copy cannot drift apart. NOT drawn into the PDF (note: false).
  kalyana:
    'Note: The Kalyana Raman Premarital Readiness Assessment explores relationship expectations, personal values, and areas that may require further discussion before marriage. However, the assessment results alone cannot determine compatibility or reliably predict marital success. You are advised to schedule a session with your therapist for the triangulation process, during which your assessment results will be reviewed alongside your therapist\u2019s observations and relevant information gathered through professional discussion. This process aims to develop a more comprehensive understanding of your responses, identify areas of alignment or discrepancy, and highlight topics that may benefit from further exploration.',
};

/** Name and date are filled; the rest are ruled blanks unless supplied. */
// The intake form now asks Name, Mobile, DOB and Sex and no longer asks for an address, so
// the block mirrors what is actually collected. This is a deliberate departure from the
// approved sample reports, which carry an Address row and no Sex row.
const detailRows = (p) => ([
  ['Name', p.name || null],
  ['Date of assessment', p.date || null],
  ['Sex', p.sex || null],
  ['Email ID', p.email || null],
  ['Phone number', p.phone || null],
  ['Date of birth', p.dob || null],
]);

/**
 * The score table, with the sample report's own column positions: scale name, score, severity,
 * then a track with the filled proportion and the percentage to its right.
 */
const TABLE = {
  dass21:  { label: 78.0, score: 168.7, severity: 220.1, head4: 319.4, pct: 460.8,
             barX: 319.0, barW: 127.2, rule: [80.2, 515.0] },
  bigFive: { label: 70.7, score: 212.7, severity: null,  head4: 283.4, pct: 454.1,
             barX: 283.9, barW: 155.1, rule: [73.2, 522.2] },
};
const BAR = { h: 8.5, dy: 1.05 };

function scoreTable(r, { rows, headings = ['Scale', 'Score', 'Severity', 'Scale'], layout = 'dass21' }) {
  const d = r.doc;
  const COL = TABLE[layout];
  r.need(70);
  d.font('Helvetica-Bold').fontSize(F.tableHead).fillColor(C.ink);
  [COL.label, COL.score, COL.severity, COL.head4].forEach((x, i) => {
    if (x != null && headings[i]) d.text(safe(headings[i]), x, r.y, { lineBreak: false });
  });
  r.y += 16.5;
  d.moveTo(COL.rule[0], r.y).lineTo(COL.rule[1], r.y).lineWidth(0.72).stroke(C.rule);
  r.y += 6.2;

  for (const row of rows) {
    r.need(28);
    d.font('Helvetica').fontSize(F.row).fillColor(C.ink).text(safe(row.label), COL.label, r.y, { lineBreak: false });
    d.font('Helvetica-Bold').fillColor(C.green).text(safe(row.value), COL.score, r.y, { lineBreak: false });
    if (row.extra !== undefined && COL.severity != null) {
      d.font('Helvetica').fillColor(C.ink).text(safe(row.extra), COL.severity, r.y, { lineBreak: false });
    }
    const by = r.y + BAR.dy;
    d.rect(COL.barX, by, COL.barW, BAR.h).fill(C.barTrack);
    d.rect(COL.barX, by, Math.max(1.5, (COL.barW * row.pct) / 100), BAR.h).fill(C.green);
    d.font('Helvetica').fontSize(F.row).fillColor(C.ink)
      .text(row.pct.toFixed(1) + '%', COL.pct, r.y, { lineBreak: false });
    r.y += 23.0;
  }
  r.y += 7.0;
}

/* ─────────────────────────── Big Five ─────────────────────────── */
async function buildBigFiveReport({ participant, answers }) {
  const results = scoreBigFive(answers);
  // The Big Five sheet sets its paragraphs a little tighter than the DASS one.
  const r = new Report({ letterhead: 'bigFive', leading: 12.0, paraGap: 2.1, facetGap: 8.7 });
  r.title('Big Five Personality Inventory (BFI-44)');
  r.details(detailRows(participant));
  r.rule();

  r.heading('Scores', F.scoresHeading, 23.3);
  scoreTable(r, {
    layout: 'bigFive',
    headings: ['Trait', 'Score', null, 'Scale'],
    rows: results.map((x) => ({ label: x.trait, value: x.mean.toFixed(2), pct: x.pct })),
  });

  for (const t of results) {
    r.need(75);
    r.heading(t.trait, F.scaleHeading, 16, t.contrast);
    r.para(t.description);
    r.facets(t.facets);
  }
  return r.end();
}

/* ──────────────────────────── DASS-21 ──────────────────────────── */
/**
 * The report follows the sample report exactly: title, participant details, the score table,
 * then one block per scale. The consent record is deliberately NOT printed here - consent is
 * its own form, and the sample report does not carry it. It is still captured on submission
 * and noted in the delivery email so the record is not lost.
 */
async function buildDass21Report({ participant, answers }) {
  const results = scoreDass21(answers);
  const r = new Report({ note: NOTES.dass21 });
  r.title('Depression Anxiety Stress Scales (DASS-21)');
  r.details(detailRows(participant));
  r.rule();

  r.heading('Scores', F.scoresHeading, 23.3);
  scoreTable(r, {
    rows: results.map((x) => ({ label: x.trait, value: String(x.score), extra: x.severity, pct: x.pct })),
  });

  for (const t of results) {
    r.need(70);
    r.heading(t.trait);
    r.para(t.description);
    r.facets(t.facets);
  }
  return r.end();
}

/* ─────────────────── Kalyana Raman: Report 1 ─────────────────── */
async function buildKalyanaResponsesReport({ participant, answers }) {
  const r = new Report({ letterhead: 'kalyana' });
  r.title('Kalyana Raman: Pre-Marital Readiness Assessment', 'Client Responses');
  r.details(detailRows(participant));
  r.rule();

  KR_DOMAINS.forEach((domain, di) => {
    r.need(52);
    r.heading(`${di + 1}. ${domain.title}`, 11.5);
    domain.questions.forEach((q, qi) => {
      const tag = `Q${di + 1}.${qi + 1}`;
      const given = answers?.[di]?.[qi];
      r.need(30);
      r.para(`${tag} ${q}`, { size: 9, color: C.body, gap: 1, font: 'Helvetica-Bold' });
      r.para(given && String(given).trim() ? given : '— no response given —',
        { size: 9, color: given ? C.body : C.muted, gap: 9 });
    });
    r.y += 4;
  });
  return r.end();
}

/**
 * Report 2 - Thematic Coding Summary (Reflexive Thematic Analysis).
 *
 * The domain column is filled in; Initial code / Emergent code / Underlying theme are left
 * EMPTY on purpose. The manual is explicit that coding is the psychologist's judgement
 * ("Make sure that any raw statements are not included in the interpretation of the
 * assessor"), and that the tool must never produce a verdict or a score. Software cannot
 * derive a theme from free text without inventing clinical opinion, so this prints the
 * approved layout as a worksheet for the clinician to complete.
 */
/**
 * The initial (descriptive) code is "the person's actual words" per the manual, condensed.
 * The sample carries a few short phrases per domain, not whole sentences, and the whole table
 * has to fit one page - so each answer is reduced to its opening clause and clipped.
 * Nothing is reworded: every fragment is text the client wrote.
 */
const CLAUSE_MAX = 44;
const CELL_MAX = 108;
function clampLines(doc, text, width, maxLines, size) {
  if (!text) return text;
  doc.font('Helvetica').fontSize(size);
  const limit = doc.currentLineHeight() * maxLines + 0.5;
  if (doc.heightOfString(safe(text), { width }) <= limit) return text;
  let out = text;
  while (out.length > 1) {
    const cut = out.lastIndexOf(' ');
    out = (cut > 0 ? out.slice(0, cut) : out.slice(0, -1)).replace(/[\s;,.]+$/, '');
    if (doc.heightOfString(safe(out + '\u2026'), { width }) <= limit) return out + '\u2026';
  }
  return out;
}

function initialCode(domainAnswers) {
  const parts = [];
  for (const raw of domainAnswers || []) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    t = t.split(/[,.;:!?]/)[0].trim();                        // opening clause only
    if (t.length > CLAUSE_MAX) {
      const cut = t.slice(0, CLAUSE_MAX);
      t = cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : CLAUSE_MAX) + '\u2026';
    }
    if (t) parts.push(t);
  }
  let out = parts.join('; ');
  if (out.length > CELL_MAX) {
    const cut = out.slice(0, CELL_MAX);
    out = cut.slice(0, cut.lastIndexOf(' ')) + '\u2026';
  }
  return out;
}

async function buildKalyanaThemesReport({ participant, answers = [] }) {
  const r = new Report({ letterhead: 'kalyana' });
  r.title('Kalyana Raman: Pre-Marital Readiness Assessment',
          'Thematic Coding Summary (Reflexive Thematic Analysis)');
  r.details(detailRows(participant));

  r.y += 12;
  r.heading('Domain-wise Themes', F.scoresHeading, 14);

  // Laid out to the approved sample: a green header band, ruled cells and alternating
  // row fill. Columns measured off Report2_Partner_A_Themes at 892/595.276 scale.
  const X = [57.4, 193.5, 312.3, 425.8, 540.0];
  const HEADS = ['Domain', 'Initial code', 'Emergent code', 'Underlying theme'];
  const SIZE = 7.8;
  const PAD = 4;
  const HEAD_H = 17;

  const headerBand = () => {
    r.doc.rect(X[0], r.y, X[4] - X[0], HEAD_H).fill(C.green);
    r.doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(SIZE);
    HEADS.forEach((h, i) => r.doc.text(safe(h), X[i] + PAD, r.y + 5, { width: X[i + 1] - X[i] - PAD * 2 }));
    r.y += HEAD_H;
  };
  headerBand();

  KR_DOMAINS.forEach((domain, di) => {
    const label = `${di + 1}. ${domain.title}`;
    // The initial/descriptive code is "the person's actual words" (manual), condensed to the
    // opening clause of each answer so the row stays the size the sample shows. The emergent
    // code and the underlying theme are the psychologist's reading and are left empty.
    r.doc.font('Helvetica').fontSize(SIZE);
    const cellW = (i) => X[i + 1] - X[i] - PAD * 2;
    // Clamp by measured height, not character count: the sample puts all ten domains on one
    // page, so no cell may run past three lines however much the client wrote.
    const code = clampLines(r.doc, initialCode(answers[di]), cellW(1), 3, SIZE);
    const h = Math.max(
      r.doc.heightOfString(safe(label), { width: cellW(0) }),
      code ? r.doc.heightOfString(safe(code), { width: cellW(1) }) : 0,
      22) + PAD * 2;

    if (r.y + h > r.bottomLimit) { r.addPage(); headerBand(); }

    if (di % 2 === 1) r.doc.rect(X[0], r.y, X[4] - X[0], h).fill('#F2F7F4');
    r.doc.lineWidth(0.5).strokeColor(C.rule);
    r.doc.rect(X[0], r.y, X[4] - X[0], h).stroke();
    for (let i = 1; i < 4; i++) r.doc.moveTo(X[i], r.y).lineTo(X[i], r.y + h).stroke();

    r.doc.fillColor(C.ink).font('Helvetica').fontSize(SIZE)
      .text(safe(label), X[0] + PAD, r.y + PAD, { width: cellW(0) });
    if (code) {
      r.doc.text(safe(code), X[1] + PAD, r.y + PAD, { width: cellW(1) });
    }
    // The emergent code and the underlying theme are the psychologist's reading, so they are
    // left for them to complete. Saying so stops an intentionally blank cell looking broken.
    if (di === 0) {
      r.doc.fillColor('#9AA5A0').font('Helvetica-Oblique').fontSize(SIZE - 0.6);
      [2, 3].forEach((i) => r.doc.text('to be completed by the psychologist',
        X[i] + PAD, r.y + PAD, { width: cellW(i) }));
      r.doc.fillColor(C.ink).font('Helvetica').fontSize(SIZE);
    }
    r.y += h;
  });
  return r.end();
}

/**
 * Report 3 is the approved landscape comparison sheet. It compares two people, and nothing is
 * stored, so one submission can only ever fill its own side: this stamps the submitting
 * partner's details onto their column and leaves the other partner's column, the key-theme
 * columns and the comparison for the psychologist to complete with both sets of answers.
 *
 * Measured off assets/kalyana-couple-comparison-template.pdf.
 */
const CMP = {
  page: { w: 841.89, h: 595.276 },
  valueX: { A: 158.8, B: 529.0 },
  rowsY: [152.1, 167.4, 182.8, 198.1, 214.1, 229.5],   // Name .. Date of birth
  size: 6.67,
  width: 164.1,
  bg: { r: 243 / 255, g: 251 / 255, b: 239 / 255 },     // the sheet's own page colour
};

async function buildKalyanaComparisonSheet({ participant, partner = 'A', other = null }) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const file = path.join(__dirname, '..', '..', 'assets', 'kalyana-couple-comparison-template.pdf');
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const mine = partner === 'B' ? 'B' : 'A';
  const sides = [[mine, participant]];
  // Once the other partner has submitted, their column is filled too and the sheet becomes a
  // real couple comparison rather than one half of one.
  if (other) {
    sides.push([mine === 'A' ? 'B' : 'A', {
      name: other.name, date: other.assessment_date, address: other.address,
      email: other.email, phone: other.phone, dob: other.dob,
    }]);
  }

  for (const [side, person] of sides) fillSide(page, font, rgb, side, person);
  return Buffer.from(await doc.save());
}

function fillSide(page, font, rgb, side, person) {
  const values = [person.name, person.date, person.address, person.email, person.phone, person.dob];
  const x = CMP.valueX[side];

  values.forEach((v, i) => {
    const text = safe(v || '').trim();
    if (!text) return;                                   // leave the ruled blank as it is
    const top = CMP.rowsY[i];
    // Cover the printed underscores before writing, or the value sits on top of them.
    page.drawRectangle({
      x: x - 1, y: CMP.page.h - top - CMP.size - 2.2, width: CMP.width + 2, height: CMP.size + 4,
      color: rgb(CMP.bg.r, CMP.bg.g, CMP.bg.b),
    });
    let out = text;
    while (out.length > 1 && font.widthOfTextAtSize(out, CMP.size) > CMP.width) out = out.slice(0, -1);
    page.drawText(out, {
      x, y: CMP.page.h - top - CMP.size * 0.718 - 1.2,
      size: CMP.size, font, color: rgb(0.2, 0.2, 0.2),
    });
  });
}

module.exports = {
  buildBigFiveReport, buildDass21Report,
  buildKalyanaResponsesReport, buildKalyanaThemesReport, buildKalyanaComparisonSheet,
  NOTES,
};
