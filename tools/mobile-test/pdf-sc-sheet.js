// ใบนับตรวจนับสต๊อก → PDF ด้วย Chrome headless (ตรวจท้ายกระดาษ / หลายหน้า) — ข้อมูลจำลองจาก shot-sc.js
//   ใช้: node pdf-sc-sheet.js [จำนวนรายการ] [summary | blank <จำนวนหน้า>]   → out/sc-sheet-<n>.pdf / out/sc-summary-<n>.pdf
const http = require('http'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { fixture } = require('./shot-sc');
const P = path.resolve(__dirname, '../../public');
const N = parseInt(process.argv[2], 10) || 14;
const SUM = process.argv[3] === 'summary', BLANK = process.argv[3] === 'blank' ? (+process.argv[4] || 1) : 0, KIND = SUM ? 'summary' : BLANK ? 'blank' : 'sheet';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(f => fs.existsSync(f));
(async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript'); r.end(fs.readFileSync(f)); }).listen(3990);
  const b = await chromium.launch({ channel: 'chrome' });
  const c = await b.newContext();
  await c.addInitScript(() => { sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1 })); window.print = () => {}; });
  await c.route('**/api/**', r => {
    const data = fixture(r.request().url());
    // เพิ่มจำนวนรายการ (ทดสอบหลายหน้า)
    if (data.data && data.data.lines && N > data.data.lines.length) {
      const base = data.data.lines.filter(l => l.src !== 'U');
      for (let i = data.data.lines.length; i < N; i++) { const s = base[i % base.length]; data.data.lines.push({ ...s, id: 1000 + i, seq: i + 1, loc: i < N / 2 ? 'RM2 A-1-3' : 'RM2 A-2-1' }); }
    }
    if (data.data && process.argv[4] === 'rq') { data.data.rqCode = 'RQ6910/00123'; data.data.dateSubmit = data.data.dateClose; }
    if (BLANK && data.data && data.data.lines) data.data.sheetType = 'B';
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  const pg = await c.newPage();
  await pg.goto('http://localhost:3990/stock-count?id=' + (SUM ? 3 : 1)); await pg.waitForTimeout(800);
  await pg.click(SUM ? '[data-act="print-summary"]' : '[data-act="print"]'); await pg.waitForTimeout(BLANK ? 400 : 1500);
  if (BLANK) { await pg.fill('#blankPages', String(BLANK)); await pg.click('[data-act="print-blank"]'); await pg.waitForTimeout(1500); }
  // เอา style ทั้งหมด + printArea ไปเป็นไฟล์ HTML นิ่ง ให้ Chrome พิมพ์
  const html = await pg.evaluate(() => '<!doctype html><html><head><meta charset="utf-8">' + [...document.querySelectorAll('style')].map(s => s.outerHTML).join('') +
    '</head><body class="printing">' + document.getElementById('printArea').outerHTML + '</body></html>');
  await b.close(); srv.close();
  const tmp = path.join(__dirname, 'out', 'sc-sheet-print.html');
  fs.writeFileSync(tmp, html);
  const pdf = path.join(__dirname, 'out', `sc-${KIND}-${N}.pdf`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, 'file:///' + tmp.replace(/\\/g, '/')], { stdio: 'ignore' });
  console.log('pdf', pdf, fs.statSync(pdf).size);
})();
