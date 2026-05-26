function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripLeadingDoctorTitle(value) {
  return normalizeWhitespace(value).replace(/^dr\.?\s*/i, '').trim();
}

function getClientDisplayName(client, fallback = 'Client') {
  if (typeof client === 'string') {
    return normalizeWhitespace(client) || fallback;
  }

  if (!client || typeof client !== 'object') {
    return fallback;
  }

  const childName = normalizeWhitespace(client.child_name);
  if (childName && childName.toLowerCase() !== 'pending') {
    return childName;
  }

  const fullName = normalizeWhitespace(`${client.first_name || ''} ${client.last_name || ''}`);
  return fullName || fallback;
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
  getClientDisplayName,
  getPsychologistDisplayName,
  stripLeadingDoctorTitle,
};
