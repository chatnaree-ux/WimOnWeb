// ทดสอบแท็บคู่มือ Over PO ตามสิทธิ์: node test-manual-tabs.js
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit, devices } = require('playwright');
const PUBLIC = path.resolve(__dirname, '../../public');
const srv = http.createServer((q, r) => { let f = path.join(PUBLIC, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : 'text/css'); r.end(fs.readFileSync(f)); }).listen(3996);
const cases = [
  ['ผู้ดูแลระบบ (unrestricted)', { success: true, unrestricted: true, allowedMenuCodes: [] }, 'req,buy', 'req'],
  ['มีแค่แจ้งคำร้อง', { success: true, unrestricted: false, allowedMenuCodes: ['over_po_sale'] }, 'req', 'req'],
  ['มีแค่พิจารณา', { success: true, unrestricted: false, allowedMenuCodes: ['over_po_sale_buy'] }, 'buy', 'buy'],
  ['มีทั้งสอง', { success: true, unrestricted: false, allowedMenuCodes: ['over_po_sale', 'over_po_sale_buy'] }, 'req,buy', 'req'],
  ['ไม่มีสิทธิ์ Over PO (ผู้อนุมัติ)', { success: true, unrestricted: false, allowedMenuCodes: ['stockcard_lot'] }, 'req,buy', 'req']
];
(async () => {
  const b = await webkit.launch(); let bad = 0;
  for (const [name, perm, wantTabs, wantActive] of cases) {
    const ctx = await b.newContext({ ...devices['Desktop Safari'] });
    await ctx.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1 })));
    await ctx.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }));
    await ctx.route('**/api/permissions/my**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(perm) }));
    await ctx.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    const p = await ctx.newPage(); await p.goto('http://localhost:3996/manual-over-po-sale'); await p.waitForTimeout(800);
    const got = await p.evaluate(() => ({ tabs: [...document.querySelectorAll('.mtab')].filter(x => !x.hidden).map(x => x.dataset.tab).join(','), bar: !document.getElementById('mTabs').hidden, shown: [...document.querySelectorAll('.mpanel')].filter(x => !x.hidden).map(x => x.dataset.panel).join(',') }));
    const ok = got.tabs === wantTabs && got.shown === wantActive && got.bar === (wantTabs.includes(','));
    if (!ok) bad++;
    console.log((ok ? '✓' : '✗') + ' ' + name + ' → แท็บ ' + got.tabs + ' / แสดง ' + got.shown + ' / แถบแท็บ ' + (got.bar ? 'มี' : 'ซ่อน'));
    await ctx.close();
  }
  await b.close(); srv.close(); process.exit(bad ? 1 : 0);
})();
