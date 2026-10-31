// ทดสอบหน้างานรออนุมัติ (ห้องของขั้น) — node shot-approvals.js [multi|single] → out/apv-*.png
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit, devices } = require('playwright');
const P = path.resolve(__dirname, '../../public'), OUT = path.join(__dirname, 'out'), PORT = 3991;
const mode = process.argv[2] || 'multi';

const mk = (mod, i, codes, scope, comp) => ({
  mod, id: 100 + i, docNo: (mod === 'rq' ? 'RQ6910/' : mod === 'rts' ? 'RT6910/' : 'OPA6910/') + String(i).padStart(5, '0'), comp: comp || 'บริษัท ตัวอย่าง จำกัด', date: `2026-10-${String(10 + (i % 18)).padStart(2, '0')}T09:00:00.000Z`,
  title: mod === 'rq' ? 'ปรับยอดหลังตรวจนับ ประจำเดือน ต.ค.' : mod === 'rts' ? 'ส่งคืนเมล็ดพันธุ์เสียหาย' : 'ขอรับซื้อเมล็ดข้าวโพด Over PO', src: 'คลังเมล็ด', nLine: 3 + i, by: 'สมชาย ใจดี (ชาย)',
  value: 1000 * i, credit: null, flags: {}, sup: 'ซัพพลายเออร์ A', typeName: 'คืนสินค้า', scope,
  my: codes.map(c => ({ code: c, name: c === 'ack' ? 'รับทราบ' : c === 'check' ? 'ตรวจสอบ' : 'อนุมัติ' })),
  progress: [{ name: 'รับทราบ', done: !codes.includes('ack') }, { name: 'ตรวจสอบ', done: !codes.includes('check') && !codes.includes('ack') }, { name: 'อนุมัติ', done: false }],
  href: `/stock-adjust-approve?id=${100 + i}&step=${codes[0]}&from=inbox`, amount: mod === 'ops' ? 25000 : null
});
function inbox() {
  const d = [];
  if (mode === 'multi') {
    for (let i = 1; i <= 3; i++) d.push(mk('rq', i, ['ack'], 'role'));
    for (let i = 4; i <= 8; i++) d.push(mk('rq', i, ['check'], 'role', i % 2 ? 'บริษัท ตัวอย่าง 2 จำกัด' : ''));
    for (let i = 9; i <= 15; i++) d.push(mk('rq', i, ['approve'], 'role'));
    for (let i = 16; i <= 18; i++) d.push(mk('rts', i, ['approve'], 'role'));
    for (let i = 19; i <= 20; i++) d.push(mk('ops', i, ['approve'], 'named'));
  } else {
    for (let i = 1; i <= 4; i++) d.push(mk('rq', i, ['check'], 'role'));
    for (let i = 5; i <= 6; i++) d.push(mk('rts', i, ['check'], 'role'));
  }
  const named = d.filter(x => x.scope === 'named').length;
  return { success: true, data: d, counts: {}, total: d.length, named, role: d.length - named, more: {}, badge: d.length, badgeCounts: {}, unrestricted: false, mods: {}, eligible: true,
    can: { rqBulk: mode === 'multi' ? ['ack', 'check', 'approve'] : ['check'], rtsBulk: mode === 'multi' ? ['approve'] : ['check'] } };
}
const fixture = (url) => {
  const p = new URL(url).pathname;
  if (p === '/api/approval-inbox') return inbox();
  if (p === '/api/approval-inbox/count') return { success: true, total: 0, counts: {}, eligible: true };
  return { success: true, data: [], menus: [], items: [] };
};
const shot = async (pg, name) => { await pg.waitForTimeout(350); await pg.screenshot({ path: path.join(OUT, `apv-${mode}-${name}.png`) }); };
(async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'image/png'); r.end(fs.readFileSync(f)); }).listen(PORT);
  const b = await webkit.launch();
  for (const [tag, opt] of [['desk', { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.2 }], ['mob', devices['iPhone 14']]]) {
    const c = await b.newContext(opt);
    await c.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1, PsName: 'ทดสอบ' })));
    await c.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(r.request().url())) }));
    await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    const pg = await c.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => m.type() === 'error' && errs.push('console:' + m.text()));
    await pg.goto(`http://localhost:${PORT}/approvals`); await pg.waitForTimeout(900);
    const st = async (label) => console.log(tag, label, JSON.stringify(await pg.evaluate(() => ({ steps: document.querySelectorAll('[data-step]').length, room: !!document.querySelector('.ib-room'), mods: [...document.querySelectorAll('[data-mod]')].map(x => x.textContent.replace(/\s+/g, ' ').trim()), rows: document.querySelectorAll('.ib-table tbody tr').length, h: (document.querySelector('.ib-h') || {}).textContent, crumb: (document.querySelector('.ib-crumb .h') || {}).textContent, hist: JSON.stringify(history.state), sw: document.documentElement.scrollWidth + '/' + innerWidth }))));
    // แท็บตามสิทธิ์
    if (mode === 'multi') { await pg.click('[data-scope=role]'); await pg.waitForTimeout(300); }
    await st('landing'); await shot(pg, `${tag}-1-landing`);
    if (mode === 'multi') {
      await pg.click('[data-step=approve]'); await pg.waitForTimeout(300); await st('room approve'); await shot(pg, `${tag}-2-room`);
      // ติ๊ก 2 ใบ
      await pg.locator('.pk:visible').nth(0).check(); await pg.locator('.pk:visible').nth(1).check(); await pg.waitForTimeout(250); await st('picked'); await shot(pg, `${tag}-3-picked`);
      await pg.click('[data-back]'); await pg.waitForTimeout(400); await st('back');
      await pg.click('[data-step=check]'); await pg.waitForTimeout(250); await pg.goBack(); await pg.waitForTimeout(300); await st('browser back from room');
      // เรื่องอื่น
      await pg.goto(`http://localhost:${PORT}/approvals`); await pg.waitForTimeout(700); await pg.click('[data-scope=role]'); await pg.click('[data-step=approve]'); await pg.waitForTimeout(250); await pg.click('[data-mod=rts]'); await pg.waitForTimeout(300); await st('mod rts'); await shot(pg, `${tag}-5-rts`);
      await pg.reload(); await pg.waitForTimeout(800); await st('after reload (restore)');
      await pg.goto(`http://localhost:${PORT}/approvals`); await pg.waitForTimeout(700); await pg.click('[data-scope=named]'); await pg.waitForTimeout(300); await st('named'); await shot(pg, `${tag}-6-named`);
    } else {
      await st('single'); await shot(pg, `${tag}-1-single`);
    }
    console.log(tag, 'errors', errs);
    await c.close();
  }
  await b.close(); srv.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
