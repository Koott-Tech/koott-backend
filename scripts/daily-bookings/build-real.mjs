import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const artifactPath = require.resolve('@oai/artifact-tool', {
  paths: process.env.ARTIFACT_NODE_MODULES ? [process.env.ARTIFACT_NODE_MODULES] : [path.dirname(fileURLToPath(import.meta.url))],
});
const { Workbook, SpreadsheetFile } = await import(pathToFileURL(artifactPath).href);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = process.env.REPORT_OUTPUT_DIR || path.join(backend, '.daily-booking-reports');
const report = JSON.parse(await fs.readFile(path.join(dir, 'real-report.json'), 'utf8'));
if (process.env.REPORT_DATE && report.date !== process.env.REPORT_DATE) throw new Error('Report date mismatch');
const wb = Workbook.create();
const views = [];
for (const completed of [false, true]) {
  const groups = completed ? report.completedGroups : report.groups;
  const total = completed ? report.completedTotal : report.total;
  const date = completed ? report.completedDate : report.date;
  const sheet = wb.worksheets.add(completed ? 'Completed sessions' : 'Daily bookings');
  const lastCol = completed ? 'D' : 'C';
  const rows = total + groups.length * 4 + 20;
  sheet.showGridLines = false;
  sheet.getRange(`A1:${lastCol}${rows}`).format = { font: { name: 'Arial', size: 11, color: '#24352F' }, rowHeight: 25, columnWidth: 24 };
  sheet.getRange(`A1:A${rows}`).format.columnWidth = 40;
  sheet.getRange('A2').values = [[completed ? 'Completed sessions' : 'Daily booked slots']];
  sheet.getRange('A2').format.font = { name: 'Arial', size: 16, bold: true };
  sheet.getRange('A3').values = [[`${date} · All times IST`]];
  const active = groups.filter(g => g.slots.length);
  sheet.getRange('A4').values = [[`${total} ${completed ? 'completed sessions' : 'bookings'} across ${active.length} therapists`]];
  let row = 6;
  if (!active.length) sheet.getRange(`A${row++}`).values = [[completed ? 'No completed sessions recorded.' : 'No booked slots recorded.']];
  for (const g of active) {
    sheet.getRange(`A${row}:${lastCol}${row}`).format = { fill: '#244C43', font: { name: 'Arial', size: 12, bold: true, color: '#FFFFFF' }, rowHeight: 30 };
    sheet.getRange(`A${row}`).values = [[g.name]];
    sheet.getRange(`${lastCol}${row}`).values = [[`${g.slots.length} ${completed ? 'completed' : 'booked'} slot${g.slots.length === 1 ? '' : 's'}`]];
    row++;
    sheet.getRange(`A${row}:${lastCol}${row}`).values = [completed ? ['Scheduled date', 'Time (IST)', 'Duration', 'Session type'] : ['Time (IST)', 'Duration', 'Session type']];
    sheet.getRange(`A${row}:${lastCol}${row}`).format = { fill: '#E8EFEB', font: { bold: true } };
    row++;
    for (const s of g.slots) {
      const [h,m] = (s.time || '').split(':').map(Number);
      const time = s.time && h >= 0 && h < 24 && m >= 0 && m < 60 ? (h*60+m)/1440 : 'Not recorded';
      const values = [time, s.minutes ? s.minutes/1440 : 'Not recorded', s.type ? s.type.charAt(0).toUpperCase()+s.type.slice(1) : 'Not recorded'];
      if (completed) values.unshift(s.scheduledDate ? new Date(`${s.scheduledDate}T00:00:00Z`) : 'Not recorded');
      sheet.getRange(`A${row}:${lastCol}${row}`).values = [values];
      if (completed) sheet.getRange(`A${row}`).setNumberFormat('dd mmm yyyy');
      sheet.getRange(`${completed ? 'B' : 'A'}${row}`).setNumberFormat('h:mm AM/PM');
      sheet.getRange(`${completed ? 'C' : 'B'}${row}`).setNumberFormat(s.minutes >= 60 ? '[h] "hr" mm "min"' : '[m] "min"');
      sheet.getRange(`A${row}:${lastCol}${row}`).format.horizontalAlignment = 'left';
      row++;
    }
    row++;
  }
  if (!completed) {
    sheet.getRange(`A${row}:${lastCol}${row}`).format = { fill: '#E8EFEB', font: { bold: true } };
    sheet.getRange(`A${row++}`).values = [['No bookings on this date']];
    for (const g of groups.filter(g => !g.slots.length)) sheet.getRange(`A${row++}`).values = [[g.name]];
    if (active.length === groups.length) sheet.getRange(`A${row++}`).values = [['None']];
  }
  row++;
  sheet.getRange(`A${row++}`).values = [['Source: Koott live booking records']];
  if (completed) sheet.getRange(`A${row++}`).values = [['Recorded completion date; scheduled date used when missing.']];
  sheet.getRange(`A${row}`).values = [[`Retrieved ${new Date(report.fetchedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST`]];
  views.push({ sheet, lastCol, row });
}
wb.recalculate();
for (const { sheet, lastCol, row } of views) {
  const preview = await wb.render({ sheetName: sheet.name, range: `A1:${lastCol}${Math.min(row,30)}`, scale: 1.5 });
  await fs.writeFile(path.join(dir, `${sheet.name}.png`), new Uint8Array(await preview.arrayBuffer()));
}
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!',options:{useRegex:true,maxResults:10}})).ndjson);
await (await SpreadsheetFile.exportXlsx(wb)).save(path.join(dir, `koott-daily-report-${report.date}.xlsx`));
console.log(JSON.stringify({bookings:report.total,completed:report.completedTotal,sheets:views.map(v=>v.sheet.name)}));
