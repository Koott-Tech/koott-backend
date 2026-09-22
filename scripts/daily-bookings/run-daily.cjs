const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RECIPIENT, istDate } = require('./report-email.cjs');
const date = istDate();
const dryRun = process.argv.includes('--dry-run');
const dir = process.env.REPORT_OUTPUT_DIR || path.resolve(__dirname, '../../.daily-booking-reports');
fs.mkdirSync(dir, { recursive:true });
const receipt = path.join(dir,`sent-${date}-${RECIPIENT}.json`);
const lock = path.join(dir,'.daily-running');
if (!dryRun && fs.existsSync(receipt)) { console.log('Already sent for this IST date; skipped.'); process.exit(0); }
let fd;
try { fd=fs.openSync(lock,'wx'); } catch { console.error('Report run active or interrupted; inspect .daily-running before retrying.'); process.exit(1); }
fs.writeFileSync(fd,JSON.stringify({pid:process.pid,date,startedAt:new Date().toISOString()}));
const env = {...process.env,REPORT_DATE:date,REPORT_OUTPUT_DIR:dir};
try {
  for (const name of ['fetch-real.cjs','build-real.mjs',...(dryRun ? [] : ['send-real.cjs'])]) {
    const result=spawnSync(process.execPath,[path.join(__dirname,name)],{env,stdio:'inherit',timeout:180000});
    if(result.error||result.status!==0)throw new Error(`${name} failed: ${result.error?.message||result.status}`);
  }
  if(dryRun)console.log(`Dry run passed for ${date}; no email sent.`);
} catch(e){console.error(e.message);process.exitCode=1;}
finally{fs.closeSync(fd);fs.unlinkSync(lock);}
