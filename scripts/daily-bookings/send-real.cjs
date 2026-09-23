const fs = require('node:fs');
const path = require('node:path');
const { RECIPIENT, istDate, buildEmail } = require('./report-email.cjs');
const backend = path.resolve(__dirname, '../..');
const dir = process.env.REPORT_OUTPUT_DIR || path.join(backend, '.daily-booking-reports');
async function main() {
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'real-report.json'), 'utf8'));
  if (report.date !== istDate() || (process.env.REPORT_DATE && report.date !== process.env.REPORT_DATE)) throw new Error('Report date does not match the current IST day');
  const age = Date.now() - Date.parse(report.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > 15*60*1000) throw new Error('Report is stale; refresh before sending');
  const receiptPath = path.join(dir, `sent-${report.date}-${RECIPIENT}.json`);
  const attemptPath = path.join(dir, `attempt-${report.date}-${RECIPIENT}.json`);
  if (fs.existsSync(receiptPath)) { console.log('Already sent; skipped.'); return; }
  if (fs.existsSync(attemptPath)) throw new Error('Previous delivery is uncertain; inspect the attempt before retrying');
  const filename = `koott-daily-report-${report.date}.xlsx`;
  fs.accessSync(path.join(dir, filename));
  require('dotenv').config({ path: path.join(backend, '.env') });
  const email = require('../../utils/emailService');
  // Keep an attempt record even if SMTP accepts but the process dies before saving its receipt.
  fs.writeFileSync(attemptPath, JSON.stringify({ startedAt:new Date().toISOString(), to:RECIPIENT, date:report.date }), { flag:'wx' });
  const result = await email.sendCustomEmail({ ...buildEmail(report), attachments:[{filename,path:path.join(dir,filename)}] });
  const receipt = { accepted:result.accepted,rejected:result.rejected,messageId:result.messageId,sentAt:new Date().toISOString() };
  if (!result.accepted?.includes(RECIPIENT) || result.rejected?.length) throw new Error('SMTP did not accept the recipient');
  fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2));
  fs.rmSync(attemptPath, { force: true }); // delivery is confirmed; the attempt record has served its purpose
  console.log(JSON.stringify(receipt));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
