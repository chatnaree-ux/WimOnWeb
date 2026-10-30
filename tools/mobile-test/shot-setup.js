// ภาพหน้าต่าง "ตั้งค่าประเภท / สาเหตุ" (iPhone 14) — node shot-setup.js → out/setup-*.png
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit, devices } = require('playwright');
const { fixture } = require('./shot-sc.js');
const P = path.resolve(__dirname, '../../public'), OUT = path.join(__dirname, 'out'), PORT = 3998;
let posted = [];
function fx(url) {
  const p = new URL(url).pathname;
  if (p === '/api/stock-count/meta') { const m = fixture(url); m.types = m.types.map((t, i) => ({ ...t, nameEn: 'Count ' + i, sort: i + 1, inactive: i === 2 })); m.causes = m.causes.map((c, i) => ({ ...c, sort: i + 1, inactive: false })); return m; }
  if (p.startsWith('/api/stock-count/setup/')) return { success: true };
  return fixture(url);
}
(async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'image/png'); r.end(fs.readFileSync(f)); }).listen(PORT);
  const b = await webkit.launch();
  const c = await b.newContext({ ...devices['iPhone 14'] });
  await c.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1, PsName: 'สมชาย ใจดี (ชาย)' })));
  await c.route('**/api/**', r => { if (r.request().method() === 'POST') posted.push(r.request().url() + ' ' + r.request().postData()); r.fulfill({ contentType: 'application/json', body: JSON.stringify(fx(r.request().url())) }); });
  await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  const pg = await c.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('dialog', d => { errs.push('dialog:' + d.message()); d.dismiss(); });
  await pg.goto(`http://localhost:${PORT}/stock-count`); await pg.waitForTimeout(900);
  console.log('btn visible', await pg.isVisible('#btnSetup'));
  await pg.click('#btnSetup'); await pg.waitForTimeout(500);
  await pg.screenshot({ path: path.join(OUT, 'setup-list.png') });
  await pg.click('[data-sudown]'); await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(OUT, 'setup-moved.png') });
  await pg.click('[data-suact]'); await pg.waitForTimeout(400);
  await pg.click('[data-suedit]'); await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(OUT, 'setup-edit.png') });
  await pg.fill('#suName', 'แก้ชื่อ'); await pg.click('[data-susave]'); await pg.waitForTimeout(600);
  await pg.click('[data-sutab=cause]'); await pg.click('[data-suadd]'); await pg.screenshot({ path: path.join(OUT, 'setup-add.png') }); await pg.fill('#suName', 'สาเหตุใหม่'); await pg.click('[data-susave]'); await pg.waitForTimeout(600);
  await pg.screenshot({ path: path.join(OUT, 'setup-cause.png') });
  console.log(posted, errs, await pg.evaluate(() => [document.documentElement.scrollWidth, innerWidth]));
  await b.close(); srv.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
