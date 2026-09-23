const RECIPIENT = 'simsar280108@gmail.com';
// A failing midnight report is otherwise silent: the console nobody reads is the only record,
// and the accountant simply gets no email.
const ALERT_RECIPIENT = 'koottfordeveloper@gmail.com';
function istDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}
function buildEmail(report) {
  const bookedTherapists = report.groups.filter(g => g.slots.length).length;
  const completedTherapists = report.completedGroups.filter(g => g.slots.length).length;
  const lines = [
    `Booked for ${report.date}: ${report.total} slots across ${bookedTherapists} therapists.`,
    `Scheduled on ${report.completedDate}: ${report.completedTotal} slots across ${completedTherapists} therapists — ${report.completedHeld} marked completed.`,
    'Full therapist and slot details are in the attached Excel (2 tabs). All times IST.',
  ];
  return { to: RECIPIENT, subject: `Koott daily report — ${report.date} (IST)`, text: lines.join('\n\n'),
    html: `<div style="font-family:Arial,sans-serif;color:#24352f"><h2>Koott daily report</h2>${lines.map(line=>`<p>${line}</p>`).join('')}</div>` };
}
function buildFailureEmail(date, step, message) {
  const lines = [
    `The daily booking report for ${date} (IST) was not sent.`,
    `Failed step: ${step}`,
    `Error: ${message}`,
    'The report runs as a local scheduled task, so it only runs while that computer is awake. Re-run it manually with scripts/daily-bookings/run-daily.cjs once the cause is fixed.',
  ];
  return { to: ALERT_RECIPIENT, subject: `Koott daily report FAILED — ${date} (IST)`, text: lines.join('\n\n'),
    html: `<div style="font-family:Arial,sans-serif;color:#24352f"><h2>Daily report failed</h2>${lines.map(l=>`<p>${l}</p>`).join('')}</div>` };
}

module.exports = { RECIPIENT, ALERT_RECIPIENT, istDate, buildEmail, buildFailureEmail };
