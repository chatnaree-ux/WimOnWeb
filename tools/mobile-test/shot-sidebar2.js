const http = require('http'), fs = require('fs'), path = require('path');
const { webkit, devices } = require('playwright');
const { fixture } = require('./shot-sc.js');
const P = path.resolve(__dirname, '../../public'), OUT = path.join(__dirname, 'out'), PORT = 3993;
(async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'image/png'); r.end(fs.readFileSync(f)); }).listen(PORT);
  const b = await webkit.launch();
  for (const [tag, opt] of [['desk', { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 }], ['mob', devices['iPhone 14']]]) {
    const c = await b.newContext(opt);
    await c.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1, PsName: 'ทดสอบ' })));
    await c.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(r.request().url())) }));
    await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    for (const [name, url] of [['count', 'stock-count'], ['sr', 'supplier-return'], ['coat', 'coating'], ['urs', 'urs-request']]) {
      const pg = await c.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
      await pg.goto(`http://localhost:${PORT}/${url}`); await pg.waitForTimeout(1200);
      if (tag === 'mob') { await pg.click('#sidebarToggle').catch(() => {}); await pg.waitForTimeout(500); }
      await pg.evaluate(() => document.querySelectorAll('#sidebar .nav-group').forEach(g => g.classList.add('open')));
      await pg.waitForTimeout(500);
      const el = await pg.$('#sidebar');
      await el.screenshot({ path: path.join(OUT, `sb-${tag}-${name}.png`) });
      console.log(tag, name, errs.join('|') || 'ok'); await pg.close();
    }
    await c.close();
  }
  await b.close(); srv.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
