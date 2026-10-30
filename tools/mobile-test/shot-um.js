// ภาพ dialog "จัดการรายการไม่พบในระบบ" + การ์ดตรวจสอบผลต่าง (iPhone 14 / SE) — node shot-um.js → out/um-*.png
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit, devices } = require('playwright');
const { fixture } = require('./shot-sc.js');
const P = path.resolve(__dirname, '../../public'), OUT = path.join(__dirname, 'out'), PORT = 3995;
(async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'image/png'); r.end(fs.readFileSync(f)); }).listen(PORT);
  const b = await webkit.launch();
  for (const dev of ['iPhone 14', 'iPhone SE']) {
    const c = await b.newContext({ ...devices[dev] });
    await c.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1, PsName: 'สมชาย ใจดี (ชาย)' })));
    await c.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(r.request().url())) }));
    await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    const pg = await c.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
    const tag = dev.replace(' ', '');
    await pg.goto(`http://localhost:${PORT}/stock-count?id=3`); await pg.waitForTimeout(900);
    await pg.screenshot({ path: path.join(OUT, `um-top-${tag}.png`) });
    const seg = await pg.$('.ln-tools .seg'); if (seg) { await seg.scrollIntoViewIfNeeded(); await pg.waitForTimeout(200); await pg.screenshot({ path: path.join(OUT, `um-seg-${tag}.png`) }); }
    const card = await pg.$('.ln-cards .ln-card .more'); if (card) { await card.scrollIntoViewIfNeeded(); await pg.evaluate(() => window.scrollBy(0, -330)); await pg.waitForTimeout(200); await pg.screenshot({ path: path.join(OUT, `um-card-${tag}.png`) }); }
    const um = await pg.$('[data-um]'); if (um) { await um.click(); await pg.waitForTimeout(500); await pg.screenshot({ path: path.join(OUT, `um-dlg-${tag}.png`) }); }
    console.log(dev, 'seg', !!seg, 'card', !!card, 'um', !!um, errs.join('|'), JSON.stringify(await pg.evaluate(() => [document.documentElement.scrollWidth, innerWidth])));
    await c.close();
  }
  await b.close(); srv.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
