/**
 * Correct obvious misspellings of major email providers.
 *
 * A typo like "gmai.com" is syntactically valid, so SMTP ACCEPTS it, the send reports success,
 * email_sent_at gets stamped — and the mail bounces silently hours later. 36 clients were in
 * exactly that state: the system said "sent", they received nothing, and no alert could fire
 * because nothing had failed.
 *
 * Clients mistype their own address and will never notice. Correcting an unambiguous typo is
 * strictly better than delivering nothing.
 *
 * SAFETY RULES — these are what stop this from mangling real addresses:
 *   1. EXACT full-domain match only. Never fuzzy, never prefix. "yahoo.co.uk" is a real domain
 *      and must not collide with the "yahoo.co" typo, so only whole-domain equality counts.
 *   2. Only misspellings of the big consumer providers. A company domain we don't recognise is
 *      left completely alone — an unknown domain is far more likely to be legitimate.
 *   3. The local part (before @) is never touched. We cannot know what the person meant.
 */

// typo domain -> the domain it is unmistakably meant to be
const DOMAIN_CORRECTIONS = {
  // gmail.com
  'gmai.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmil.com': 'gmail.com',
  'gmali.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gmsil.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.comm': 'gmail.com',
  'gmailc.om': 'gmail.com',
  'gmail.om': 'gmail.com',
  // yahoo.com  (NOTE: yahoo.co.uk / yahoo.co.in are REAL — exact match keeps them safe)
  'yahooo.com': 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'yhaoo.com': 'yahoo.com',
  'yahoo.cm': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  // hotmail.com
  'hotmai.com': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmil.com': 'hotmail.com',
  'hotmaill.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  // outlook.com
  'outlok.com': 'outlook.com',
  'outllook.com': 'outlook.com',
  'outlook.con': 'outlook.com',
  // icloud.com
  'iclod.com': 'icloud.com',
  'icloud.con': 'icloud.com',
  // rediffmail.com (common in India)
  'rediffmail.co': 'rediffmail.com',
  'redifmail.com': 'rediffmail.com',
};

/**
 * @param {string} email
 * @returns {{ email: string, corrected: boolean, from: string|null, to: string|null }}
 *          `email` is the address to actually use — corrected when a typo was recognised,
 *          otherwise the input unchanged.
 */
function correctEmailDomain(email) {
  const raw = String(email || '').trim();
  const unchanged = { email: raw, corrected: false, from: null, to: null };
  if (!raw) return unchanged;

  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return unchanged; // not an address we can reason about

  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1).toLowerCase();
  const fixed = DOMAIN_CORRECTIONS[domain];
  if (!fixed) return unchanged;

  return { email: `${local}@${fixed}`, corrected: true, from: domain, to: fixed };
}

/** True when the domain is a recognised typo (i.e. mail to it would bounce). */
function isTypoEmailDomain(email) {
  return correctEmailDomain(email).corrected;
}

module.exports = { correctEmailDomain, isTypoEmailDomain, DOMAIN_CORRECTIONS };
