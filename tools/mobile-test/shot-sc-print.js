// ภาพตัวอย่างเอกสารพิมพ์ของเมนูตรวจนับ (ใบสรุปผล / ใบนับ) — media print, A4 กว้าง 794px
//   ใช้: node shot-sc-print.js  → out/sc-print-summary.png, out/sc-print-sheet.png (ข้อมูลจำลองจาก shot-sc.js)
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit } = require('playwright');
const { fixture } = require('./shot-sc');
const P = path.resolve(__dirname, '../../public');
const PORT = 3993;
(async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : 'text/css'); r.end(fs.readFileSync(f)); }).listen(PORT);
  const b = await webkit.launch();
  const c = await b.newContext({ viewport: { width: 794, height: 1123 } });
  await c.addInitScript(() => { sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1 })); window.print = () => {}; });
  await c.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(r.request().url())) }));
  await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  for (const [name, id, act, w, h] of [['summary', 3, 'print-summary', 1123, 794], ['sheet', 1, 'print', 794, 1123]]) {
    const pg = await c.newPage();
    await pg.setViewportSize({ width: w, height: h });
    await pg.goto(`http://localhost:${PORT}/stock-count?id=${id}`); await pg.waitForTimeout(700);
    await pg.click(`[data-act="${act}"]`); await pg.waitForTimeout(200);
    await pg.emulateMedia({ media: 'print' });
    await pg.screenshot({ path: path.join(__dirname, 'out', `sc-print-${name}.png`), fullPage: true });
    console.log(name, 'ok');
    await pg.close();
  }
  await b.close(); srv.close();
})();
