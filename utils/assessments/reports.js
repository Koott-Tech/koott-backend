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
  kalyana:
    'Note: Kalyana Raman is a qualitative premarital readiness interview scale and guided-discussion framework. It is not a diagnostic instrument or a pass/fail test, and it does not produce a total score. The results are intended to guide conversation and should be interpreted by a qualified professional in the context of individual interviews and personal circumstances.',
};

/** Name and date are filled; the rest are ruled blanks unless supplied. */
const detailRows = (p) => ([
  ['Name', p.name || null],
  ['Date of assessment', p.date || null],
  ['Address', p.address || null],
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
  const r = new Report({ note: NOTES.kalyana });
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

module.exports = { buildBigFiveReport, buildDass21Report, buildKalyanaResponsesReport, NOTES };
