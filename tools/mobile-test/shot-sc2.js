// ภาพหน้าจอรอบแก้มือถือ: ฟอร์มสร้างเอกสาร / เลือกคลัง / live count / การ์ดรายการ / รายงานปรับสต๊อก — node shot-sc2.js [iPhone 14|iPhone SE] → out/s2-*.png
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit, devices } = require('playwright');
const { fixture } = require('./shot-sc.js');
const P = path.resolve(__dirname, '../../public'), OUT = path.join(__dirname, 'out'), PORT = 3997;
const names = ['เมล็ดพันธุ์ ผักบุ้ง OP WATERMELON NILOBON B - 2606 25 g. porling / STARTEST ชื่อยาวมากๆๆ', 'สารเคมีพอลิเมอร์ เคลือบเมล็ด SEEDWORX BLAZE 2 PINK (TN590) Film coating', 'บล็อคพิมพ์'];
const months = Array.from({ length: 12 }, (_, i) => ({ y: i < 2 ? 2025 : 2026, m: i < 2 ? i + 11 : i - 1, docs: i % 4, plus: 3 * i % 9, minus: 5 * i % 11 + 1, set: 0 }));
const lines = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, doc: 1 + i % 2, lotNo: 'F16406000' + i, invCode: 'RAW10390' + (i % 3), invName: names[i % 3], idGroup: 1, unit: 'กิโลกรัม', wh: 'คลังสินค้าวัตถุดิบ : RM2 A-2-1', idWh0: 5, mainWh: 'คลังสินค้าวัตถุดิบ', before: 15.62, op: i % 2 ? '+' : '-', amount: 8.96, after: 6.66, note: '', cause: '', rev: null }));
const docs = [1, 2].map(id => ({ id, docCode: '6901/0000' + id, date: '2026-01-12T09:22:00', idComp: 4, compCode: 'AV', compName: 'AV', note: 'ปรับตามการตรวจนับ', cmd: 'ก ข', act: 'ค ง', idRq: 1, rqCode: 'RQ6910/00001', src: 'SC', scCode: 'SC6910/0001', apv: 'จ ฉ', revOf: null }));
function fx(url) {
  const p = new URL(url).pathname;
  if (p === '/api/stock-adjust-report/meta') return { success: true, companies: [{ id: 4, code: 'AV', name: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด' }], groups: [{ id: 1, name: 'วัตถุดิบ' }], warehouses: [{ id: 5, name: 'คลังสินค้าวัตถุดิบ', idComp: 4 }], max: 5000, canReverse: false };
  if (p === '/api/stock-adjust-report/data') return { success: true, more: false, max: 5000, docs, lines };
  if (p === '/api/stock-adjust-report/trend') return { success: true, months };
  if (p === '/api/stock-count/overview') { const o = fixture(url); o.topShort = names.map((n, i) => ({ invName: n, invCode: 'RAW10390' + i, times: 3 - i, qty: 14.3, unit: 'ลิตร', docs: 2 })); o.kpi = o.kpi || {}; return o; }
  if (p === '/api/stock-count/warehouses') return { success: true, data: [{ id: 57, path: 'QC01', lvl: 0, level: 0, nLot: 123, n: [123, 0, 0, 0, 0], lastDt: null }, { id: 58, path: 'QC01 › คลังวัตถุดิบเมล็ดพันธุ์', lvl: 1, level: 0, nLot: 25, n: [25, 0, 0, 0, 0] }, { id: 59, path: 'QC01 › คลังวัตถุดิบเมล็ดพันธุ์ › คลังวัตถุดิบ 2', lvl: 2, level: 0, nLot: 9, n: [9, 0, 0, 0, 0] }, { id: 60, path: 'QC01 › คลังวัตถุดิบเมล็ดพันธุ์ › คลังวัตถุดิบ 2 › G', lvl: 3, level: 3, nLot: 5, n: [0, 0, 0, 5, 0], lastDt: '2026-06-01' }] };
  return fixture(url);
}
(async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'image/png'); r.end(fs.readFileSync(f)); }).listen(PORT);
  const b = await webkit.launch();
  const dev = process.argv[2] || 'iPhone 14', tag = dev.replace(' ', '');
  const c = await b.newContext({ ...devices[dev] });
  await c.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1, PsName: 'สมชาย ใจดี (ชาย)' })));
  await c.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fx(r.request().url())) }));
  await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  const shots = [
    ['list', 'stock-count', ''],
    ['overview', 'stock-count', 'document.getElementById("fComp").value="4"; document.querySelector("[data-ltab=overview]").click()', 'document.querySelector(".hbars").scrollIntoView()'],
    ['form', 'stock-count', 'document.getElementById("btnNew").click()'],
    ['wh', 'stock-count', 'document.getElementById("btnNew").click(); setTimeout(()=>document.getElementById("hWhPick").click(),300)'],
    ['live', 'stock-count?id=2', 'document.querySelector("[data-tab=count]") && document.querySelector("[data-tab=count]").click()'],
    ['livenf', 'stock-count?id=2', 'document.querySelector("[data-tab=count]") && document.querySelector("[data-tab=count]").click(); setTimeout(()=>{document.getElementById("scanInput").value="ZZZ"; document.getElementById("scanForm").dispatchEvent(new Event("submit",{cancelable:true}));},300)'],
    ['adddlg', 'stock-count?id=2', 'document.querySelector("[data-tab=count]") && document.querySelector("[data-tab=count]").click(); setTimeout(()=>{document.getElementById("scanInput").value="ZZZ"; document.getElementById("scanForm").dispatchEvent(new Event("submit",{cancelable:true})); setTimeout(()=>{const x=document.querySelector("[data-act=add-u]"); x&&x.click();},400)},300)'],
    ['um', 'stock-count?id=3', 'document.querySelector("[data-um]").click()'],
    ['rq', 'stock-adjust-approve?step=check', ''],
    ['rpt', 'stock-adjust-report', ''],
    ['rpt-item', 'stock-adjust-report', 'document.querySelector("[data-view=item]").click()'],
    ['rpt-dash', 'stock-adjust-report', 'document.querySelector("[data-view=dash]").click()']
  ];
  for (const [name, url, js] of shots) {
    const pg = await c.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(`http://localhost:${PORT}/${url}`); await pg.waitForTimeout(800);
    if (js) { try { await pg.evaluate(js); } catch (e) { errs.push('js:' + e.message); } await pg.waitForTimeout(900); }
    const sw = await pg.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    if (name === 'rpt-dash') { const el = await pg.$('.trend'); if (el) { const box = await el.evaluateHandle(e => e.parentElement); await box.asElement().screenshot({ path: path.join(OUT, 's2-trend-' + tag + '.png') }); } }
    await pg.screenshot({ path: path.join(OUT, `s2-${name}-${tag}.png`), fullPage: !/form|wh|dlg|um/.test(name) });
    console.log(name.padEnd(10), sw[0] > sw[1] + 1 ? 'H-SCROLL ' + sw.join('>') : 'ok', errs.join(' | '));
    await pg.close();
  }
  await b.close(); srv.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
