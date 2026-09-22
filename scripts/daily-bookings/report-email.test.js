const { istDate, buildEmail, RECIPIENT } = require('./report-email.cjs');
test('date rolls over at midnight IST, regardless of host time zone', () => {
  expect(istDate(new Date('2026-09-22T18:29:59Z'))).toBe('2026-09-22');
  expect(istDate(new Date('2026-09-22T18:30:00Z'))).toBe('2026-09-23');
  expect(istDate(new Date('2026-12-31T18:30:00Z'))).toBe('2027-01-01');
});
test('email includes both totals but no therapist names or slot preview', () => {
  const report = {date:'2026-09-23',completedDate:'2026-09-22',total:2,completedTotal:1,
    groups:[{name:'Private therapist name',slots:[{time:'10:00'}, {time:'11:00'}]}],
    completedGroups:[{name:'Private therapist name',slots:[{time:'09:00'}]}]};
  const mail=buildEmail(report);
  expect(mail.to).toBe('simsar280108@gmail.com');
  expect(mail.to).toBe(RECIPIENT);
  for(const body of [mail.text,mail.html]) {
    expect(body).toContain('2026-09-23: 2 slots across 1 therapists');
    expect(body).toContain('2026-09-22: 1 sessions across 1 therapists');
    expect(body).not.toContain('Private therapist name');
    expect(body).not.toContain('10:00');
  }
});
test('empty days still have explicit zero totals',()=>{
  expect(buildEmail({date:'2026-09-23',completedDate:'2026-09-22',total:0,completedTotal:0,groups:[],completedGroups:[]}).text).toContain('0 sessions across 0 therapists');
});
