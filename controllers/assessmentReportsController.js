/**
 * Public assessment endpoints: score the submission, build the PDF in memory, email it, done.
 *
 * Nothing is persisted. The PDF never touches disk or Supabase Storage, and the answers are
 * not written to the database — they exist only for the life of the request. If responses
 * ever need to be retained, that is a deliberate decision to take separately, with consent
 * and a retention period.
 */
const emailService = require('../utils/emailService');
const { buildBigFiveReport, buildDass21Report, buildKalyanaResponsesReport } = require('../utils/assessments/reports');
const { BFI_ITEMS, DASS_ITEMS, KR_DOMAINS } = require('../utils/assessments/instruments');

/** Single recipient while testing. Set ASSESSMENT_REPORT_EMAIL to change it without a deploy. */
const RECIPIENT = () => process.env.ASSESSMENT_REPORT_EMAIL || 'abhishekravi063@gmail.com';

const istDate = () => new Date(Date.now() + 5.5 * 3600 * 1000)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function participantFrom(body) {
  const clean = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || null;
  return {
    name: clean(body.name) || 'Not provided',
    date: istDate(),
    address: clean(body.address, 200),
    email: clean(body.email),
    phone: clean(body.phone, 40),
    dob: clean(body.dob, 40),
  };
}

async function deliver({ res, subject, intro, filename, buffer, participant }) {
  await emailService.sendCustomEmail({
    to: RECIPIENT(),
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;color:#333;line-height:1.6">
             <h2 style="color:#025545;margin:0 0 10px">${intro}</h2>
             <p><b>Name:</b> ${participant.name}<br/><b>Submitted:</b> ${participant.date}</p>
             <p>The report is attached as a PDF.</p>
           </div>`,
    attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
  });
  return res.json({ success: true, message: 'Your responses have been submitted. The report has been sent.' });
}

const fail = (res, code, message) => res.status(code).json({ success: false, error: message });

/** POST /api/assessment-reports/big-five  { name, answers: { "1": 1-5, ... x44 } } */
async function submitBigFive(req, res) {
  try {
    const answers = req.body?.answers || {};
    const missing = BFI_ITEMS.filter((i) => {
      const v = Number(answers[i.n]);
      return !Number.isFinite(v) || v < 1 || v > 5;
    }).map((i) => i.n);
    if (missing.length) return fail(res, 400, `Please answer every question. Missing or invalid: ${missing.join(', ')}`);

    const participant = participantFrom(req.body);
    const buffer = await buildBigFiveReport({ participant, answers });
    return deliver({ res, participant, buffer,
      subject: `Big Five (BFI-44) report - ${participant.name}`,
      intro: 'Big Five Personality Inventory - new submission',
      filename: `Big-Five-Report-${participant.name.replace(/[^\w]+/g, '-')}.pdf` });
  } catch (e) {
    console.error('[assessment/big-five]', e);
    return fail(res, 500, 'Could not generate the report.');
  }
}

/** POST /api/assessment-reports/dass-21  { name, answers: { "1": 0-3, ... x21 } } */
async function submitDass21(req, res) {
  try {
    const answers = req.body?.answers || {};
    const missing = DASS_ITEMS.filter((i) => {
      const v = Number(answers[i.n]);
      return !Number.isFinite(v) || v < 0 || v > 3;
    }).map((i) => i.n);
    if (missing.length) return fail(res, 400, `Please answer every question. Missing or invalid: ${missing.join(', ')}`);

    const participant = participantFrom(req.body);
    const buffer = await buildDass21Report({ participant, answers });
    return deliver({ res, participant, buffer,
      subject: `DASS-21 report - ${participant.name}`,
      intro: 'DASS-21 - new submission',
      filename: `DASS-21-Report-${participant.name.replace(/[^\w]+/g, '-')}.pdf` });
  } catch (e) {
    console.error('[assessment/dass-21]', e);
    return fail(res, 500, 'Could not generate the report.');
  }
}

/**
 * POST /api/assessment-reports/kalyana-raman
 * { name, partner: 'A'|'B', answers: [ [d1q1, d1q2, d1q3], ... x10 ] }
 *
 * Produces Report 1 (that partner's own responses) only. Reports 2 and 3 need themes written,
 * which is not yet decided, so each partner's submission is delivered on its own.
 */
async function submitKalyanaRaman(req, res) {
  try {
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!answers || answers.length !== KR_DOMAINS.length) {
      return fail(res, 400, `Expected answers for ${KR_DOMAINS.length} domains.`);
    }
    const blank = [];
    KR_DOMAINS.forEach((d, di) => d.questions.forEach((_, qi) => {
      const v = answers[di]?.[qi];
      if (!v || !String(v).trim()) blank.push(`Q${di + 1}.${qi + 1}`);
    }));
    if (blank.length) return fail(res, 400, `Please answer every question. Missing: ${blank.join(', ')}`);

    const partner = req.body?.partner === 'B' ? 'B' : 'A';
    const participant = participantFrom(req.body);
    const buffer = await buildKalyanaResponsesReport({ participant, answers });
    return deliver({ res, participant, buffer,
      subject: `Kalyana Raman - Partner ${partner} responses - ${participant.name}`,
      intro: `Kalyana Raman - Partner ${partner} submission`,
      filename: `Kalyana-Raman-Partner-${partner}-${participant.name.replace(/[^\w]+/g, '-')}.pdf` });
  } catch (e) {
    console.error('[assessment/kalyana-raman]', e);
    return fail(res, 500, 'Could not generate the report.');
  }
}

/** GET /api/assessment-reports/questions - the questionnaires, so the pages stay in step. */
function getQuestions(req, res) {
  const { BFI_SCALE_LABELS, DASS_SCALE_LABELS } = require('../utils/assessments/instruments');
  return res.json({
    success: true,
    data: {
      bigFive: { items: BFI_ITEMS, scale: BFI_SCALE_LABELS, min: 1, max: 5 },
      dass21: { items: DASS_ITEMS.map(({ n, text }) => ({ n, text })), scale: DASS_SCALE_LABELS, min: 0, max: 3 },
      kalyanaRaman: { domains: KR_DOMAINS },
    },
  });
}

module.exports = { submitBigFive, submitDass21, submitKalyanaRaman, getQuestions };
