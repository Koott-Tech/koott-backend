/**
 * Report builders. Each returns a PDF Buffer and writes nothing to disk or storage —
 * the buffer is attached to an email and then discarded.
 */
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
async function buildKalyanaThemesReport({ participant }) {
  const r = new Report({ letterhead: 'kalyana' });
  r.title('Kalyana Raman: Pre-Marital Readiness Assessment',
          'Thematic Coding Summary (Reflexive Thematic Analysis)');
  r.details(detailRows(participant));

  r.y += 12;
  r.heading('Domain-wise Themes', F.scoresHeading, 14);

  // Columns measured off Report2_Partner_A_Themes and shifted onto the house left margin,
  // so this report lines up with Report 1 rather than with the mock-up's own margin.
  const COLS = [
    { x: 62.7,  w: 130 },   // Domain
    { x: 198.8, w: 113 },   // Initial code
    { x: 317.6, w: 108 },   // Emergent code
    { x: 431.1, w: 108 },   // Underlying theme
  ];
  const SIZE = 8.6;
  const HEADS = ['Domain', 'Initial code', 'Emergent code', 'Underlying theme'];

  const headerRow = () => {
    r.doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(SIZE);
    HEADS.forEach((h, i) => r.doc.text(safe(h), COLS[i].x, r.y, { width: COLS[i].w }));
    r.y += 14;
    r.rule(0, 6, COLS[0].x, M.right);
  };
  headerRow();

  KR_DOMAINS.forEach((domain, di) => {
    const label = `${di + 1}. ${domain.title}`;
    r.doc.font('Helvetica').fontSize(SIZE);
    const h = Math.max(r.doc.heightOfString(safe(label), { width: COLS[0].w }), 22);
    if (r.y + h + 8 > r.bottomLimit) { r.addPage(); headerRow(); }
    r.doc.fillColor(C.ink).font('Helvetica').fontSize(SIZE)
      .text(safe(label), COLS[0].x, r.y, { width: COLS[0].w });
    // Columns 2-4 stay blank for the clinician.
    r.y += h + 8;
    r.rule(0, 6, COLS[0].x, M.right);
  });
  return r.end();
}

module.exports = {
  buildBigFiveReport, buildDass21Report,
  buildKalyanaResponsesReport, buildKalyanaThemesReport,
  NOTES,
};
