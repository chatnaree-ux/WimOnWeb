const http = require('http'), fs = require('fs'), path = require('path');
const { webkit } = require('playwright');
const P = path.resolve(__dirname, '../../public');
const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'image/png'); r.end(fs.readFileSync(f)); }).listen(3995);
(async () => {
  const b = await webkit.launch(); const c = await b.newContext({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 2 });
  await c.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1 })));
  await c.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, unrestricted: true, data: [] }) }));
  await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  const p = await c.newPage(); await p.goto('http://localhost:3995/' + process.argv[2]); await p.waitForTimeout(900);
  if (process.argv[3]) await p.click(process.argv[3]);
  const el = await p.$('.mpanel:not([hidden]) .flow'); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: path.join(__dirname, 'out', 'flow.png') });
  await b.close(); srv.close();
})();
