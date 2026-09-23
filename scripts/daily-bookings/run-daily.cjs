const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RECIPIENT, istDate, buildFailureEmail } = require('./report-email.cjs');
const date = istDate();
const dryRun = process.argv.includes('--dry-run');
const dir = process.env.REPORT_OUTPUT_DIR || path.resolve(__dirname, '../../.daily-booking-reports');
fs.mkdirSync(dir, { recursive:true });
const receipt = path.join(dir,`sent-${date}-${RECIPIENT}.json`);
const lock = path.join(dir,'.daily-running');
if (!dryRun && fs.existsSync(receipt)) { console.log('Already sent for this IST date; skipped.'); process.exit(0); }
// A hard kill used to leave this lock behind forever, so every later night exited here and no
// report was ever sent again. A lock older than the 3-minute step budget is stale; take it over.
const STALE_LOCK_MS = 15 * 60 * 1000;
let fd;
try { fd = fs.openSync(lock, 'wx'); } catch {
  let age = null;
  try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
  if (age === null || age < STALE_LOCK_MS) {
    console.error('Report run active; inspect .daily-running before retrying.');
    process.exit(1);
  }
  console.warn(`Removing stale lock (${Math.round(age / 60000)} min old).`);
  fs.rmSync(lock, { force: true });
  try { fd = fs.openSync(lock, 'wx'); } catch { console.error('Could not claim the run lock.'); process.exit(1); }
}
fs.writeFileSync(fd,JSON.stringify({pid:process.pid,date,startedAt:new Date().toISOString()}));
const env = {...process.env,REPORT_DATE:date,REPORT_OUTPUT_DIR:dir};
try {
  for (const name of ['fetch-real.cjs','build-real.mjs',...(dryRun ? [] : ['send-real.cjs'])]) {
    const result=spawnSync(process.execPath,[path.join(__dirname,name)],{env,stdio:'inherit',timeout:180000});
    if(result.error||result.status!==0)throw new Error(`${name} failed: ${result.error?.message||result.status}`);
  }
  if(dryRun)console.log(`Dry run passed for ${date}; no email sent.`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
  if (!dryRun) alertFailure(e.message);
} finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }

// Best effort: the alert must never mask the original failure.
function alertFailure(message) {
  try {
    require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
    const step = /^(\S+\.(?:cjs|mjs))/.exec(message)?.[1] || 'unknown';
    const mail = require('../../utils/emailService');
    const alert = buildFailureEmail(date, step, message);
    mail.sendCustomEmail(alert)
      .then(() => console.error(`Failure alert sent to ${alert.to}.`))
      .catch((err) => console.error('Could not send failure alert:', err.message || err));
  } catch (err) { console.error('Could not send failure alert:', err.message || err); }
}
