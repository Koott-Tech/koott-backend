/**
 * Report builders. Each returns a PDF Buffer and writes nothing to disk or storage —
 * the buffer is attached to an email and then discarded.
 */
const { Report, C, M, safe } = require('./reportTheme');
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

/** Score column + progress bar + percentage, the layout used across both scored reports. */
function scoreTable(r, { columns, rows }) {
  const d = r.doc;
  const x = M.left + 40;
  const colX = columns.map((c) => x + c.dx);
  const barX = x + columns.find((c) => c.bar).dx;
  // Size the bar from what is actually left on the line, reserving room for the percentage,
  // so neither the bar nor the figure runs off the right margin in either report.
  const PCT_W = 52;
  const barW = (M.left + r.contentW) - barX - PCT_W;

  r.need(26);
  d.font('Helvetica').fontSize(8.8).fillColor(C.muted);
  columns.forEach((c, i) => d.text(safe(c.label), colX[i], r.y, { width: c.w || 120 }));
  r.y += 14;
  d.moveTo(x, r.y).lineTo(M.left + r.contentW, r.y).lineWidth(0.7).stroke(C.rule);
  r.y += 10;

  for (const row of rows) {
    r.need(28);
    d.font('Helvetica').fontSize(10).fillColor(C.body).text(safe(row.label), colX[0], r.y, { width: 150 });
    d.fillColor(C.heading).text(safe(row.value), colX[1], r.y, { width: 60 });
    if (row.extra !== undefined) d.fillColor(C.body).text(safe(row.extra), colX[2], r.y, { width: 90 });
    d.roundedRect(barX, r.y + 1, barW, 9, 1).fill(C.barTrack);
    d.roundedRect(barX, r.y + 1, Math.max(2, (barW * row.pct) / 100), 9, 1).fill(C.green);
    d.fillColor(C.body).font('Helvetica').fontSize(9.5)
      .text(row.pct.toFixed(1) + '%', barX + barW + 10, r.y, { width: PCT_W, align: 'left' });
    r.y += 22;
  }
  r.y += 6;
}

/* ─────────────────────────── Big Five ─────────────────────────── */
async function buildBigFiveReport({ participant, answers }) {
  const results = scoreBigFive(answers);
  const r = new Report({ note: NOTES.bigFive });
  r.title('Big Five Personality Inventory (BFI-44)');
  r.details(detailRows(participant));
  r.rule();

  r.heading('Scores');
  scoreTable(r, {
    columns: [{ label: 'Trait', dx: 0, w: 150 }, { label: 'Score', dx: 165, w: 60 }, { label: '', dx: 0 }, { label: 'Scale', dx: 245, bar: true }],
    rows: results.map((x) => ({ label: x.trait, value: x.mean.toFixed(2), pct: x.pct })),
  });

  for (const t of results) {
    r.need(60);
    const d = r.doc;
    d.font('Helvetica').fontSize(11.5).fillColor(C.heading).text(safe(t.trait), M.left, r.y, { continued: true });
    d.font('Helvetica').fontSize(8.8).fillColor(C.muted).text(safe('   (' + t.contrast + ')'));
    r.y += 17;
    r.para(t.description, { size: 8.8, gap: 4 });
    r.facets(t.facets);
  }
  return r.end();
}

/* ──────────────────────────── DASS-21 ──────────────────────────── */
async function buildDass21Report({ participant, answers }) {
  const results = scoreDass21(answers);
  const r = new Report({ note: NOTES.dass21 });
  r.title('Depression Anxiety Stress Scales (DASS-21)');
  r.details(detailRows(participant));
  r.rule();

  r.heading('Scores');
  scoreTable(r, {
    columns: [{ label: 'Scale', dx: 0, w: 120 }, { label: 'Score', dx: 130, w: 50 }, { label: 'Severity', dx: 190, w: 90 }, { label: 'Scale', dx: 300, bar: true }],
    rows: results.map((x) => ({ label: x.trait, value: String(x.score), extra: x.severity, pct: x.pct })),
  });

  for (const t of results) {
    r.need(55);
    r.heading(t.trait, 11.5);
    r.para(t.description, { size: 8.8, gap: 4 });
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
