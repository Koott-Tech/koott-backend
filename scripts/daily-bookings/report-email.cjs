const RECIPIENT = 'simsar280108@gmail.com';
function istDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}
function buildEmail(report) {
  const bookedTherapists = report.groups.filter(g => g.slots.length).length;
  const completedTherapists = report.completedGroups.filter(g => g.slots.length).length;
  const lines = [
    `Booked for ${report.date}: ${report.total} slots across ${bookedTherapists} therapists.`,
    `Completed on ${report.completedDate}: ${report.completedTotal} sessions across ${completedTherapists} therapists.`,
    'Full therapist and slot details are in the attached Excel (2 tabs). All times IST.',
  ];
  return { to: RECIPIENT, subject: `Koott daily report — ${report.date} (IST)`, text: lines.join('\n\n'),
    html: `<div style="font-family:Arial,sans-serif;color:#24352f"><h2>Koott daily report</h2>${lines.map(line=>`<p>${line}</p>`).join('')}</div>` };
}
module.exports = { RECIPIENT, istDate, buildEmail };
