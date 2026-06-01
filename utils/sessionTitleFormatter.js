function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripLeadingDoctorTitle(value) {
  return normalizeWhitespace(value).replace(/^dr\.?\s*/i, '').trim();
}

/** Placeholder strings that should be treated as "no value" when picking a display name. */
const NAME_PLACEHOLDERS = new Set(['pending', 'not provided', 'n/a', 'na', 'none', 'null', 'undefined', '-']);

function isPlaceholderName(value) {
  if (!value) return true;
  const v = String(value).trim().toLowerCase();
  if (!v) return true;
  return NAME_PLACEHOLDERS.has(v);
}

function getClientDisplayName(client, fallback = 'Client') {
  if (typeof client === 'string') {
    return normalizeWhitespace(client) || fallback;
  }

  if (!client || typeof client !== 'object') {
    return fallback;
  }

  // Prefer first+last name (most reliable identity field).
  const fullName = normalizeWhitespace(`${client.first_name || ''} ${client.last_name || ''}`);
  if (fullName && !isPlaceholderName(fullName)) return fullName;

  // Fall back to child_name only if it isn't a known placeholder
  // ("Not provided", "Pending", "N/A", etc. are stored when admin leaves child fields blank).
  const childName = normalizeWhitespace(client.child_name);
  if (childName && !isPlaceholderName(childName)) return childName;

  if (fullName) return fullName; // e.g. "Sandra" with empty last_name still beats placeholder
  return fallback;
}

function getPsychologistDisplayName(psychologist, fallback = 'Psychologist') {
  if (typeof psychologist === 'string') {
    return stripLeadingDoctorTitle(psychologist) || fallback;
  }

  if (!psychologist || typeof psychologist !== 'object') {
    return fallback;
  }

  const combinedName = normalizeWhitespace(
    `${psychologist.first_name || ''} ${psychologist.last_name || ''}`
  );
  const cleanedCombined = stripLeadingDoctorTitle(combinedName);
  if (cleanedCombined) {
    return cleanedCombined;
  }

  const cleanedLastName = stripLeadingDoctorTitle(psychologist.last_name || '');
  if (cleanedLastName) {
    return cleanedLastName;
  }

  const cleanedFirstName = stripLeadingDoctorTitle(psychologist.first_name || '');
  return cleanedFirstName || fallback;
}

function buildKoottSessionTitle({ clientName, psychologistName }) {
  const safeClientName = normalizeWhitespace(clientName) || 'Client';
  const safePsychologistName = stripLeadingDoctorTitle(psychologistName) || 'Psychologist';
  return `Koott - ${safeClientName} with ${safePsychologistName}`;
}

function buildKoottSessionDescription({
  clientName,
  psychologistName,
  clientPhone = null,
  isRescheduled = false,
}) {
  const safeClientName = normalizeWhitespace(clientName) || 'Client';
  const safePsychologistName = stripLeadingDoctorTitle(psychologistName) || 'Psychologist';
  const sessionLabel = isRescheduled ? 'Rescheduled therapy session' : 'Online therapy session';
  const phoneLine = normalizeWhitespace(clientPhone)
    ? `\nClient phone: ${normalizeWhitespace(clientPhone)}`
    : '';

  return `${sessionLabel} between ${safeClientName} and ${safePsychologistName}.${phoneLine}`;
}

module.exports = {
  buildKoottSessionDescription,
  buildKoottSessionTitle,
  isPlaceholderName,
  getClientDisplayName,
  getPsychologistDisplayName,
  stripLeadingDoctorTitle,
};
