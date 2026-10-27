// ภาพหน้าจอเมนูตรวจนับสต๊อก + อนุมัติปรับยอด (ข้อมูลจำลอง ไม่ต่อฐานข้อมูล) — desktop 1440 + iPhone 390
//   ใช้: node shot-sc.js   → out/sc-*.png + รายงานหน้าเลื่อนข้าง / JS error
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit, devices } = require('playwright');
const P = path.resolve(__dirname, '../../public');
const OUT = path.join(__dirname, 'out');
const PORT = 3994;

const types = [{ id: 1, code: 'DAILY', name: 'ประจำวัน' }, { id: 5, code: 'WEEKLY', name: 'ประจำสัปดาห์' }, { id: 2, code: 'MONTHLY', name: 'ประจำเดือน' }];
const causes = ['นับคลาดเคลื่อน', 'บันทึกรับ-จ่ายในระบบผิด', 'เบิกใช้แล้วยังไม่ตัดระบบ', 'ชำรุด-เสื่อมสภาพ', 'อื่นๆ'].map((name, i) => ({ id: i + 1, name }));
const can = { edit: true, review: true, cancel: true, setup: true, ack: true, check: true, approve: true };
const items = [['CUC101156', 'เมล็ดพันธุ์ แตงร้าน CL-751'], ['CUC100210', 'เมล็ดพันธุ์ แตงกวา C-746'], ['MOR200011', 'เมล็ดพันธุ์ มะระขี้นก OP'], ['PAC000112', 'ซองฟอยล์ 10 กรัม พิมพ์ลาย']];
function lines(status) {
  const out = [];
  for (let i = 0; i < 14; i++) {
    const [code, name] = items[i % items.length];
    const erp = [9, 5.7, 120, 32.5, 0.85, 0.0035][i % 6];
    const counted = status !== 'COUNT' || i < 6;
    const count = !counted ? null : i % 5 === 1 ? erp - 1 : i % 7 === 3 ? erp + 2 : erp;
    out.push({ id: i + 1, seq: i + 1, src: i === 13 ? 'A' : 'S', idRefLot: 1000 + i, prevCount: [null, '2026-09-01', '2026-05-20', '2025-12-01', '2025-03-14'][i % 5], lotNo: `68${4 + (i % 3)}-04${i % 10}-000${10 + i}`, invCode: code, invName: name,
      idWh: 5200 + (i < 7 ? 1 : 2), loc: i < 7 ? 'RM2 A-1-3' : 'RM2 A-1-4', unit: code.startsWith('PAC') ? 'ซอง' : 'กิโลกรัม', erp, count, cost: 250,
      exp: null, quality: i === 4 ? 'HOLD' : 'NORMAL', idCause: status === 'REVIEW' && count !== erp && count != null ? 1 : null, note: '',
      action: status === 'COUNT' ? 'PENDING' : count === erp ? 'NONE' : 'PENDING', adjust: status !== 'COUNT' && count != null && count !== erp, exclude: false, recount: 0,
      countBy: counted ? 'สมชาย ใจดี (ชาย)' : null, countAt: counted ? '2026-10-26T10:1' + (i % 10) + ':00' : null, nEntry: counted ? 1 : 0 });
  }
  out.push({ id: 99, seq: 15, src: 'U', inputText: 'FG24-1O02', itemText: 'ข้าวโพดหวาน WIM-01', locText: 'A-01-2', unitText: 'ถุง', count: 6, mapStatus: 'P', action: 'PENDING', exclude: false, adjust: false, quality: 'NORMAL', countBy: 'สมชาย ใจดี', countAt: '2026-10-26T10:30:00' });
  out.push({ id: 98, seq: 16, src: 'U', inputText: 'X-NEW-0091', itemText: 'เมล็ดพันธุ์ถั่วฝักยาว ไม่มีฉลาก', locText: 'RM2 A-1-4', unitText: 'กก.', count: 2.5, mapStatus: 'N', note: 'ถุงไม่มีฉลาก', mapNote: 'ส่งฝ่ายรับเข้าตั้ง Lot', action: 'DONE', exclude: false, adjust: false, quality: 'HOLD', countBy: 'สมชาย ใจดี', countAt: '2026-10-26T10:35:00' });
  return out;
}
function stats(ls) {
  const s = { all: ls.length, counted: 0, notCounted: 0, match: 0, short: 0, over: 0, exclude: 0, um: 0, umPending: 0, adjust: 0, diffValue: 0 };
  ls.forEach(l => {
    if (l.src === 'U') { s.um++; if (l.mapStatus === 'P') s.umPending++; return; }
    if (l.count == null) { s.notCounted++; return; }
    s.counted++; const d = l.count - l.erp; if (!d) s.match++; else if (d < 0) s.short++; else s.over++;
    if (l.adjust) s.adjust++; s.diffValue += d * (l.cost || 0);
  });
  return s;
}
function head(id, status, mode) {
  return { id, docCode: 'SC6910/000' + id, dateDoc: '2026-10-26T09:00:00', idComp: 4, compCode: 'AV', compName: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด', idParent0: 57, whName: 'คลังสินค้าวัตถุดิบ',
    idWhScope: 5201, scopePath: 'คลังสินค้าวัตถุดิบ > คลังวัตถุดิบ 2 > RACK A', dateCount: '2026-10-26', round: 1, idCountType: 5, typeName: 'ประจำสัปดาห์', mode, sheetType: mode === 'O' ? 'P' : null, blind: false,
    counter: { id: 1, name: 'สมชาย ใจดี (ชาย)', full: 'นางสาว ฉัตรนรี พิมพิรัตน์', position: 'เจ้าหน้าที่คลังสินค้า' }, reviewer: { id: 2, name: 'ประเสริฐ ตรวจดี (เสริฐ)', full: 'นางสาว ภัทราภรณ์ ชวนชัย', position: 'หัวหน้าคลังสินค้า' }, tolerance: 2, note: '', status,
    dateStart: '2026-10-26T09:05:00', dateClose: null, apvRound: status === 'APPROVE' ? 1 : 0, idRq: status === 'APPROVE' ? 890 : null, rqCode: status === 'APPROVE' ? 'RQ6910/00098' : null,
    sendBack: null, cancel: null, creator: { id: 1, name: 'สมชาย ใจดี (ชาย)' }, dateTs: '2026-10-26T09:00:00', rqSteps: status === 'APPROVE' ? { ack: '2026-10-26T11:00:00', check: null, approve: null } : null };
}
const DOCS = { 1: ['COUNT', 'O'], 2: ['COUNT', 'L'], 3: ['REVIEW', 'O'], 4: ['APPROVE', 'L'], 5: ['DRAFT', null], 6: ['CANCEL', 'O'] };
function docData(id) {
  const [st, mode] = DOCS[id];
  const ls = st === 'DRAFT' ? [] : lines(st);
  return { ...head(id, st, mode), stats: stats(ls), lines: ls, log: [{ act: 'create', detail: 'สร้างเอกสาร SC6910/000' + id, at: '2026-10-25T16:20:00', by: 'สมชาย ใจดี (ชาย)' }, { act: 'edit', detail: 'แก้ไขหัวเอกสาร', at: '2026-10-25T16:31:00', by: 'สมชาย ใจดี (ชาย)' }, { act: 'start', detail: 'เริ่มตรวจนับ · snapshot ยอด ERP 14 รายการ', at: '2026-10-26T09:05:00', by: 'สมชาย ใจดี (ชาย)' }, { act: 'import', detail: 'นำเข้าใบนับเปล่า 14 แถว · ในเอกสาร 12 · เพิ่ม Lot นอกขอบเขต 1 · ไม่พบในระบบ 1', at: '2026-10-26T10:40:00', by: 'สมชาย ใจดี (ชาย)' }, { act: 'unmatched', detail: 'ส่งตั้งรหัสใหม่: "FG24-1O02"', at: '2026-10-26T11:02:00', by: 'ประเสริฐ ตรวจดี (เสริฐ)' }, { act: 'close', detail: 'ปิดการนับ · รายการที่ไม่ได้นับ 2 รายการ: ถือเป็น 0', at: '2026-10-26T11:15:00', by: 'สมชาย ใจดี (ชาย)' }, { act: 'sendback', detail: 'RQ6910/00123 ส่งกลับแก้ไข: ตรวจ Lot 684-043-00013 อีกครั้ง', at: '2026-10-26T13:30:00', by: 'มาลี บัญชีดี (มาลี)' }] };
}
const rq = (id, src) => ({ id, docCode: 'RQ6910/000' + (90 + id), idComp: 4, compCode: 'AV', compName: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด', note: src === 'SC' ? 'ตรวจนับสต๊อก SC6910/0004 (ประจำสัปดาห์)' : 'เนื่องจากหน้างานชั่ง นน.ผิด', dateTs: '2026-10-26T10:00:00',
  src, idCount: src === 'SC' ? 4 : null, scCode: src === 'SC' ? 'SC6910/0004' : null, creator: 'ปรียานุช จันทร์เขียว (กิ๊ฟ)', command: 'ชาญวุฒิ เฮงหิรัญ (ตุ้ม)', action: 'ปรียานุช จันทร์เขียว (กิ๊ฟ)',
  steps: { ack: id === 1 ? { id: 3, by: 'มาลี บัญชีดี', at: '2026-10-26T11:00:00' } : null, check: null, approve: null }, cancel: null, nLine: 3, nPlus: 1, nMinus: 2, adjValue: -1250.5 });

function fixture(url) {
  const u = new URL(url), p = u.pathname;
  if (p.includes('/permissions/my')) return { success: true, unrestricted: true, allowedMenuCodes: [], wipMenuCodes: [] };
  if (p.includes('/auth/me')) return { success: true, user: { idPs: 1, PsName: 'ทดสอบ' } };
  if (p === '/api/stock-count/meta') return { success: true, types, causes, companies: [{ id: 4, code: 'AV', name: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด' }, { id: 3, code: 'GR', name: 'บริษัท กรีนซีดส์ จำกัด' }], can, postingReady: false, me: 1 };
  if (p === '/api/stock-count/overview') return { success: true, kpi: { docs30: 3, counted30: 42, match30: 27, accuracy30: 64.3, short30: 9, over30: 6, um30: 1, open: { draft: 1, counting: 2, review: 1, approve: 1 } },
    causes: [{ name: 'นับคลาดเคลื่อน', short: 5, over: 3 }, { name: 'เบิกใช้แล้วยังไม่ตัดระบบ', short: 4, over: 0 }, { name: 'รับเข้าแล้วยังไม่บันทึก', short: 0, over: 3 }, { name: 'ยังไม่ระบุสาเหตุ', noCause: true, short: 1, over: 0 }],
    topShort: [{ invCode: 'KAT107165', invName: 'คะน้า ดาวทอง 1 100 กรัม/กระป๋อง ตราดาวทอง', unit: 'กระป๋อง', times: 4, docs: 3, qty: 7 }, { invCode: 'CUC101156', invName: 'เมล็ดพันธุ์ แตงร้าน CL-751', unit: 'กิโลกรัม', times: 2, docs: 2, qty: 1.35 }],
    coverage: [{ idWh: 4, whName: 'คลังบรรจุภัณฑ์', nLot: 1699, lastCount: null, lastDoc: null, days: null, nDoc90: 0, level: 0, n: [1699, 0, 0, 0, 0] }, { idWh: 2, whName: 'คลังสินค้าวัตถุดิบ', nLot: 3301, lastCount: '2026-06-01', lastDoc: 'SC6906/0003', days: 147, nDoc90: 0, level: 4, n: [0, 1200, 900, 820, 381] },
      { idWh: 3, whName: 'คลังสำเร็จรูป', nLot: 1444, lastCount: '2026-10-26', lastDoc: 'SC6910/0004', days: 0, nDoc90: 4, level: 2, n: [0, 1300, 144, 0, 0] }] };
  if (p === '/api/stock-count/warehouses') return { success: true, data: [
    { id: 2, parent0: 2, path: 'คลังสินค้าวัตถุดิบ', lvl: 0, nLot: 3301, level: 4, n: [0, 1200, 900, 820, 381], lastDt: '2026-10-20' },
    { id: 21, parent0: 2, path: 'คลังสินค้าวัตถุดิบ › คลังวัตถุดิบ 1', lvl: 1, nLot: 1500, level: 1, n: [0, 1500, 0, 0, 0], lastDt: '2026-10-20' },
    { id: 22, parent0: 2, path: 'คลังสินค้าวัตถุดิบ › คลังวัตถุดิบ 2', lvl: 1, nLot: 1801, level: 4, n: [0, 0, 900, 820, 81], lastDt: '2026-06-01' },
    { id: 23, parent0: 2, path: 'คลังสินค้าวัตถุดิบ › คลังวัตถุดิบ 2 › RACK A', lvl: 2, nLot: 300, level: 3, n: [0, 0, 120, 180, 0], lastDt: '2026-06-01' },
    { id: 4, parent0: 4, path: 'คลังบรรจุภัณฑ์', lvl: 0, nLot: 1699, level: 0, n: [1699, 0, 0, 0, 0], lastDt: null },
    { id: 41, parent0: 4, path: 'คลังบรรจุภัณฑ์ › โซน B', lvl: 1, nLot: 0, level: null, n: [0, 0, 0, 0, 0], lastDt: null }] };
  if (p === '/api/stock-count/list') return { success: true, data: Object.keys(DOCS).map(id => { const d = docData(+id); delete d.lines; delete d.log; return d; }) };
  const m = p.match(/^\/api\/stock-count\/doc\/(\d+)$/);
  if (m) return { success: true, data: docData(+m[1]) };
  if (p === '/api/stock-adjust/list') return { success: true, data: [rq(1, 'SC'), rq(2, null), rq(3, null)], can, postingReady: false, me: 1 };
  if (p.startsWith('/api/stock-adjust/doc/')) return { success: true, can, postingReady: false, me: 1, data: { ...rq(1, 'SC'), lines: [
    { id: 1, lotNo: '684-040-00009', invCode: 'CUC101156', invName: 'เมล็ดพันธุ์ แตงร้าน CL-751', unit: 'กิโลกรัม', loc: 'RM2 A-1-3', before: 9, op: '+', amount: 1, after: 10, note: 'นับคลาดเคลื่อน', now: 9, erp: 9, count: 10 },
    { id: 2, lotNo: '684-041-00005', invCode: 'CUC101156', invName: 'เมล็ดพันธุ์ แตงร้าน CL-751', unit: 'กิโลกรัม', loc: 'RM2 A-1-3', before: 5.7, op: '-', amount: 1, after: 4.7, note: 'ชำรุด-เสื่อมสภาพ', now: 5.2, erp: 5.7, count: 4.7 }],
    log: [{ step: 'submit', note: 'สร้างจากเอกสารตรวจนับ SC6910/0004 (2 รายการ)', at: '2026-10-26T10:00:00', by: 'ประเสริฐ ตรวจดี' }, { step: 'accept', note: null, at: '2026-10-26T11:00:00', by: 'มาลี บัญชีดี' }] } };
  return { success: true, data: [] };
}

const SHOTS = [
  ['list', 'stock-count'], ['mine', 'stock-count', 'document.querySelector("[data-ltab=mine]").click()'], ['overview', 'stock-count', 'document.getElementById("fComp").value="4"; document.querySelector("[data-ltab=overview]").click()'], ['form', 'stock-count', 'document.getElementById("btnNew").click(); document.getElementById("hBlind").click()'], ['filters', 'stock-count', 'document.getElementById("btnMoreFlt").click()'], ['draft', 'stock-count?id=5'], ['sheet', 'stock-count?id=1'], ['live', 'stock-count?id=2'],
  ['review', 'stock-count?id=3'], ['alllines', 'stock-count?id=3', 'document.querySelector("[data-tab=lines]").click()'], ['approve-doc', 'stock-count?id=4'], ['adj-list', 'stock-adjust-approve?step=check'], ['adj-doc', 'stock-adjust-approve?id=1']
];
module.exports = { fixture };
if (require.main === module) (async () => {
  const srv = http.createServer((q, r) => { let f = path.join(P, decodeURIComponent(q.url.split('?')[0])); if (!path.extname(f)) f += '.html'; if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'image/png'); r.end(fs.readFileSync(f)); }).listen(PORT);
  const b = await webkit.launch();
  for (const [dev, ctxOpt] of [['desktop', { viewport: { width: 1440, height: 1000 } }], ['iphone', devices['iPhone 14']]]) {
    const c = await b.newContext(ctxOpt);
    await c.addInitScript(() => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1, PsName: 'สมชาย ใจดี (ชาย)' })));
    await c.route('**/api/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(r.request().url())) }));
    await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    for (const [name, url, js] of SHOTS) {
      const pg = await c.newPage();
      const errs = [];
      pg.on('pageerror', e => errs.push(e.message));
      await pg.goto(`http://localhost:${PORT}/${url}`); await pg.waitForTimeout(700);
      if (js) { await pg.evaluate(js); await pg.waitForTimeout(400); }
      const sw = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      await pg.screenshot({ path: path.join(OUT, `sc-${name}-${dev}.png`), fullPage: true });
      console.log(`${dev.padEnd(8)} ${name.padEnd(12)} ${sw[0] > sw[1] + 1 ? 'H-SCROLL ' + sw.join('>') : 'ok'} ${errs.length ? 'JS ERR: ' + errs.join(' | ') : ''}`);
      await pg.close();
    }
    await c.close();
  }
  await b.close(); srv.close();
})();
