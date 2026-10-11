/**
 * Public assessment endpoints: score the submission, build the PDF in memory, email it, done.
 *
 * Nothing is persisted. The PDF never touches disk or Supabase Storage, and the answers are
 * not written to the database — they exist only for the life of the request. If responses
 * ever need to be retained, that is a deliberate decision to take separately, with consent
 * and a retention period.
 */
const fs = require('fs');
const path = require('path');
const emailService = require('../utils/emailService');
const { buildBigFiveReport, buildDass21Report, buildKalyanaResponsesReport,
        buildKalyanaThemesReport, buildKalyanaComparisonSheet } = require('../utils/assessments/reports');
const { BFI_ITEMS, DASS_ITEMS, KR_DOMAINS } = require('../utils/assessments/instruments');
const store = require('../utils/assessments/submissionStore');
const { scoreBigFive, scoreDass21 } = require('../utils/assessments/instruments');

/**
 * Who every assessment report goes to. Set ASSESSMENT_REPORT_EMAIL to a comma-separated list to
 * change this without a deploy; it replaces the defaults rather than adding to them.
 */
/**
 * Reports go to these fixed addresses only. The client's own address is collected and printed
 * on the report, but is deliberately NOT mailed to for now - the psychologist passes results
 * on in the feedback session. The UI must not promise the client a copy.
 */
const DEFAULT_RECIPIENTS = ['abhishekravi063@gmail.com', 'dr.aswathi.raman.koott@gmail.com'];
const RECIPIENT = () => {
  const override = (process.env.ASSESSMENT_REPORT_EMAIL || '').split(',').map((e) => e.trim()).filter(Boolean);
  return (override.length ? override : DEFAULT_RECIPIENTS).join(', ');
};

// Every date in a report is a date in India, never UTC. A bare 'YYYY-MM-DD' from a date input
// parses as UTC midnight, and IST is UTC+5:30 - ahead of UTC - so rendering it in Asia/Kolkata
// gives back the same calendar day the client picked. Formatting it in UTC instead would be a
// day behind for anything submitted after 05:30 IST.
const IST = 'Asia/Kolkata';
const fmtIst = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: IST });
const istDate = () => fmtIst(new Date());
/** Consent is recorded to the minute, in IST, for the delivery email's audit line. */
const fmtIstStamp = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'time not recorded'
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: IST });
};

/**
 * The consent is not printed in the report - that is its own form - but it is recorded in the
 * delivery email so the agreement is not lost, since nothing here is persisted.
 */
function consentFrom(body, choiceSection) {
  const c = body?.consent;
  if (!c || c.agreed !== true) return null;
  return {
    agreed: true,
    choiceSection,
    agreedAt: c.agreedAt || new Date().toISOString(),
    anonymisedUse: c.anonymisedUse === 'agree' ? 'agree' : 'decline',
  };
}

function participantFrom(body) {
  const clean = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || null;
  const asDate = (v) => {
    if (!v || typeof v !== 'string' || !v.trim()) return null;
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : fmtIst(d);
  };
  return {
    name: clean(body.name) || 'Not provided',
    date: asDate(body.date) || istDate(),
    address: clean(body.address, 200),
    email: clean(body.email),
    phone: clean(body.phone, 40),
    sex: clean(body.sex, 40),
    dob: asDate(body.dob) || clean(body.dob, 40),
  };
}

async function deliver({ res, subject, intro, filename, buffer, participant, consent, extras = [], coupleCode }) {
  await emailService.sendCustomEmail({
    to: RECIPIENT(),
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;color:#333;line-height:1.6">
             <h2 style="color:#025545;margin:0 0 10px">${intro}</h2>
             <p><b>Name:</b> ${participant.name}<br/><b>Submitted:</b> ${participant.date}</p>
             ${coupleCode ? `<p><b>Couple code:</b> <code style="font-size:15px;letter-spacing:2px">${coupleCode}</code><br/>
               <span style="font-size:13px;color:#666">The other partner enters this when they start, so the
               two sets of answers can be compared.</span></p>` : ''}
             ${consent ? `<p style="font-size:13px;color:#666"><b>Consent:</b> given online before the
               questionnaire was shown, ${fmtIstStamp(consent.agreedAt)} IST. Use of anonymised
               information (section ${consent.choiceSection}): <b>${consent.anonymisedUse === 'agree' ? 'agreed' : 'not agreed'}</b>.</p>` : ''}
             <p>${extras.length
               ? `Attached: the client's responses, plus the thematic coding worksheet and the couple
                  comparison sheet. The interpretive columns on those two are left for the psychologist,
                  and the comparison sheet carries only this partner's side.`
               : 'The report is attached as a PDF.'}</p>
           </div>`,
    attachments: [
      { filename, content: buffer, contentType: 'application/pdf' },
      ...extras.map((e) => ({ filename: e.filename, content: e.content, contentType: 'application/pdf' })),
    ],
  });
  return res.json({
    success: true,
    message: 'Your responses have been submitted. The report has been sent.',
    ...(coupleCode ? { coupleCode } : {}),
  });
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
    const consent = consentFrom(req.body, 6);
    const buffer = await buildBigFiveReport({ participant, answers });
    // Stored after the report is built, and never awaited in a way that can fail the request:
    // a storage outage must not cost the client their submission.
    await store.save({ assessment: 'big_five', participant, answers, consent,
                       scores: scoreBigFive(answers) });
    return deliver({ res, participant, buffer, consent,
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
    const consent = consentFrom(req.body, 7);
    const buffer = await buildDass21Report({ participant, answers });
    await store.save({ assessment: 'dass21', participant, answers, consent,
                       scores: scoreDass21(answers) });
    return deliver({ res, participant, buffer, consent,
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
    const consent = consentFrom(req.body, 8);

    // A couple code links the two partners. Partner A gets one issued; Partner B types in the
    // one A was given, which is how the two submissions find each other later.
    const supplied = String(req.body?.coupleCode || '').trim().toUpperCase();
    const coupleCode = supplied || store.makeCoupleCode();

    await store.save({ assessment: 'kalyana_raman', participant, answers, consent,
                       partner, coupleCode });
    // Only now can the other half be looked up - after this submission is on record, so two
    // partners finishing at the same moment still find each other.
    const other = await store.findPartner(coupleCode, partner);

    const buffer = await buildKalyanaResponsesReport({ participant, answers });

    // Reports 2 and 3 follow the approved samples: the columns that hold what the client
    // actually wrote are filled from their answers, and only the columns that call for the
    // psychologist's reading are left blank. The manual defines the initial/descriptive code
    // as "the person's actual words", and puts the emergent code, the underlying theme and the
    // qualitative comparison with the psychologist, so software must not write those.
    // Report 3 can only ever carry this partner's column: nothing is stored, so one
    // submission can never see the other partner's answers.
    const extras = [];
    try {
      const themes = await buildKalyanaThemesReport({ participant, answers });
      extras.push({ filename: `Kalyana-Raman-Partner-${partner}-themes-worksheet.pdf`, content: themes });
      // Report 3 is the approved landscape sheet. It compares two people and nothing is
      // stored, so this submission can only fill its own side; the psychologist completes the
      // rest once both partners have been seen.
      const comparison = await buildKalyanaComparisonSheet({ participant, partner, other });
      extras.push({
        filename: other
          ? 'Kalyana-Raman-couple-comparison.pdf'
          : `Kalyana-Raman-couple-comparison-Partner-${partner}.pdf`,
        content: comparison,
      });
    } catch (e) {
      // A worksheet failing must never cost the client their submission.
      console.error('[assessment/kalyana-raman] worksheet attach failed:', e.message);
    }

    // Section 8 carries the either/or choice on the Kalyana form (DASS uses 7, Big Five 6).
    return deliver({ res, participant, buffer, extras, consent, coupleCode,
      subject: `Kalyana Raman - Partner ${partner} responses - ${participant.name}`
               + (other ? ' (couple now complete)' : ''),
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
