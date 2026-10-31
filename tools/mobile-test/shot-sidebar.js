// ตัวอย่างเส้นนำเมนู sidebar หลายแบบ — node shot-sidebar.js → out/sidebar-compare.png
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit } = require('playwright');
const { fixture } = require('./shot-sc.js');
const P = path.resolve(__dirname, '../../public'), OUT = path.join(__dirname, 'out'), PORT = 3996;
const A = 'rgba(242,169,28,';
const VARIANTS = {
  'ก) ที่ทำอยู่ตอนนี้ (เส้น + รอยต่อ)': '',
  'ข) ตัดรอยต่อ เหลือเส้นแนวตั้ง': `
    #sidebar .nav-subitem::before, #sidebar .nav-group-sub > .nav-parent::before{display:none !important;}`,
  'ค) เส้นจาง ชัดเฉพาะกลุ่มที่เปิด': `
    #sidebar .nav-subitem::before, #sidebar .nav-group-sub > .nav-parent::before{display:none !important;}
    #sidebar .nav-submenu-inner > .nav-subitem, #sidebar .nav-group-sub > .nav-parent, #sidebar .nav-group-sub > .nav-submenu .nav-subitem{border-left:2px solid rgba(255,255,255,.1) !important;}
    #sidebar .nav-group-sub.open > .nav-parent{border-left-color:${A}.95) !important;}
    #sidebar .nav-group-sub.open > .nav-submenu .nav-subitem{border-left-color:${A}.45) !important;}
    #sidebar .nav-subitem.active{border-left-color:${A}1) !important;}`
};
(async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'image/png'); r.end(fs.readFileSync(f)); }).listen(PORT);
  const b = await webkit.launch();
  const c = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await c.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1, PsName: 'ฉัตรนรี พิมพิรัตน์ (นุช)' })));
  await c.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(r.request().url())) }));
  await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  const shots = [];
  for (const [name, css] of Object.entries(VARIANTS)) {
    const pg = await c.newPage();
    await pg.goto(`http://localhost:${PORT}/stock-count`); await pg.waitForTimeout(1200);
    await pg.evaluate(() => { document.querySelectorAll('#sidebar .nav-group').forEach(g => g.classList.toggle('open', !g.matches('[data-group=supplier_return_group]'))); });
    if (css) await pg.addStyleTag({ content: css.replace(/#sidebar /g, 'html body #sidebar ') });
    await pg.waitForTimeout(600);
    const clip = await pg.evaluate(() => { const r = document.getElementById('sidebar').getBoundingClientRect(); const a = document.querySelector('#sidebar .nav-group-sub'); const y = a ? a.getBoundingClientRect().top - 90 : 100; return { x: 0, y: Math.max(0, y), width: r.width, height: 520 }; });
    shots.push([name, (await pg.screenshot({ clip })).toString('base64')]);
    await pg.close();
  }
  const pg = await c.newPage();
  await pg.setContent(`<body style="margin:0;background:#0b1220;font-family:sans-serif;color:#fff"><div style="display:flex;gap:14px;padding:14px">${shots.map(([n, d]) => `<div><div style="padding:6px 4px;font-size:15px">${n}</div><img style="width:340px;border:1px solid #333" src="data:image/png;base64,${d}"></div>`).join('')}</div></body>`);
  await pg.setViewportSize({ width: 1200, height: 640 }); await pg.waitForTimeout(500);
  await pg.screenshot({ path: path.join(OUT, 'sidebar-compare.png') });
  await b.close(); srv.close(); console.log('ok');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
