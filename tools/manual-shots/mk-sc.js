// ถ่ายรูปประกอบคู่มือตรวจนับสต๊อก + อนุมัติปรับยอดสต๊อก (WebKit 1920 × scale 1.5) จากหน้าจริง + ข้อมูลจำลอง (ไม่ต่อ DB / ไม่ใช้ session)
//   ใช้: node mk-sc.js [ชื่อรูป ...]  → public/images/manual/stock-count/
//   ชื่อบุคคลในรูปกำหนดใน P (ผู้ตรวจนับ / ผู้ตรวจสอบ / ผู้รับทราบ / ผู้ตรวจสอบปรับยอด / ผู้อนุมัติ) แก้แล้วรันใหม่ได้
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit } = require('D:/WimOnWeb/tools/mobile-test/node_modules/playwright');
const PUBLIC = path.resolve(__dirname, '../../public');
const OUT = path.join(PUBLIC, 'images/manual/stock-count');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const PORT = 3995;

const P = {
  counter: { id: 11, name: 'ปรียานุช จันทร์เขียว (กิ๊ฟ)', full: 'นางสาว ปรียานุช จันทร์เขียว', position: 'พนักงานคลังสินค้า' },
  reviewer: { id: 12, name: 'ชาญวุฒิ เฮงหิรัญ (ตุ้ม)', full: 'นาย ชาญวุฒิ เฮงหิรัญ', position: 'หัวหน้าคลังสินค้า' },
  ack: { id: 13, name: 'มาลี บัญชีดี (มาลี)', full: 'นางสาว มาลี บัญชีดี', position: 'เจ้าหน้าที่บัญชี' },
  check: { id: 14, name: 'ประเสริฐ ตรวจดี (เสริฐ)', full: 'นาย ประเสริฐ ตรวจดี', position: 'ผู้จัดการฝ่ายบัญชี' },
  approve: { id: 15, name: 'วิชัย ผู้อนุมัติ (ชัย)', full: 'นาย วิชัย ผู้อนุมัติ', position: 'ผู้จัดการโรงงาน' }
};
const COMP = { id: 4, code: 'AV', name: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด' };
const COMP_INFO = { nameEn: 'ADVANCE SEEDS CO.,LTD.', address: '99/9 หมู่ 4 ต.สวนพริกไทย อ.เมืองปทุมธานี', addressEn: '99/9 Moo 4, Suan Phrik Thai, Muang Pathum Thani', province: 'ปทุมธานี', postCode: '12000', tel: '0 2958 8476-8', fax: '0 2958 8479', taxId: '0105512345678' };

// ---------- เอกสารตรวจนับ (SC) ----------
const types = [{ id: 1, code: 'DAILY', name: 'ประจำวัน', nameEn: 'Daily Count' }, { id: 5, code: 'WEEKLY', name: 'ประจำสัปดาห์', nameEn: 'Weekly Count' }, { id: 2, code: 'MONTHLY', name: 'ประจำเดือน', nameEn: 'Monthly Count' }, { id: 4, code: 'SPOT', name: 'เฉพาะรายการ', nameEn: 'Spot Count' }];
const causes = ['นับคลาดเคลื่อน', 'บันทึกรับ-จ่ายในระบบผิด', 'เบิกใช้แล้วยังไม่ตัดระบบ', 'ชำรุด-เสื่อมสภาพ', 'อื่นๆ'].map((name, i) => ({ id: i + 1, name }));
const can = { edit: true, review: true, cancel: true, setup: true, ack: true, check: true, approve: true, reverse: true };
const items = [['CUC101156', 'เมล็ดพันธุ์ แตงร้าน CL-751'], ['CUC100210', 'เมล็ดพันธุ์ แตงกวา C-746'], ['MOR200011', 'เมล็ดพันธุ์ มะระขี้นก OP'], ['PAC000112', 'ซองฟอยล์ 10 กรัม พิมพ์ลาย']];
function lines(status) {
  const out = [];
  for (let i = 0; i < 14; i++) {
    const [code, name] = items[i % items.length];
    const erp = [9, 5.7, 120, 32.5, 0.85, 14][i % 6];
    const counted = status !== 'COUNT' || i < 6;
    const count = !counted ? null : i % 5 === 1 ? erp - 1 : i % 7 === 3 ? erp + 2 : erp;
    out.push({ id: i + 1, seq: i + 1, src: i === 13 ? 'A' : 'S', idRefLot: 1000 + i, prevCount: [null, '2026-09-01', '2026-05-20', '2025-12-01', '2025-03-14'][i % 5], lotNo: `68${4 + (i % 3)}-04${i % 10}-000${10 + i}`, invCode: code, invName: name,
      idWh: 5200 + (i < 7 ? 1 : 2), loc: i < 7 ? 'RM2 A-1-3' : 'RM2 A-1-4', unit: code.startsWith('PAC') ? 'ซอง' : 'กิโลกรัม', erp, count, cost: 250,
      exp: null, quality: i === 4 ? 'HOLD' : 'NORMAL', idCause: status === 'REVIEW' && count !== erp && count != null ? (i % 2 ? 1 : 3) : null, note: '',
      action: status === 'COUNT' ? 'PENDING' : count === erp ? 'NONE' : 'PENDING', adjust: status !== 'COUNT' && count != null && count !== erp, exclude: false, recount: 0,
      countBy: counted ? P.counter.name : null, countAt: counted ? '2026-10-26T10:1' + (i % 10) + ':00' : null, nEntry: counted ? 1 : 0 });
  }
  out.push({ id: 99, seq: 15, src: 'U', inputText: 'FG24-1O02', itemText: 'ข้าวโพดหวาน WIM-01', locText: 'A-01-2', unitText: 'ถุง', count: 6, mapStatus: status === 'REVIEW' ? 'N' : 'P', action: 'PENDING', exclude: false, adjust: false, quality: 'NORMAL', countBy: P.counter.name, countAt: '2026-10-26T10:30:00' });
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
const person = (p) => ({ id: p.id, name: p.name, full: p.full, position: p.position });
function head(id, status, mode) {
  const closed = ['REVIEW', 'APPROVE', 'POSTED', 'DONE'].includes(status);
  return { id, docCode: 'SC6910/000' + id, dateDoc: '2026-10-26T09:00:00', idComp: COMP.id, compCode: COMP.code, compName: COMP.name, idParent0: 57, whName: 'คลังสินค้าวัตถุดิบ',
    idWhScope: 5201, scopePath: 'คลังสินค้าวัตถุดิบ > คลังวัตถุดิบ 2 > RACK A', dateCount: '2026-10-26', round: 1, idCountType: 5, typeName: 'ประจำสัปดาห์', mode, sheetType: mode === 'O' ? 'P' : null, blind: false,
    counter: person(P.counter), reviewer: person(P.reviewer), tolerance: 2, note: '', status,
    dateStart: status === 'DRAFT' ? null : '2026-10-26T09:05:00', dateClose: closed ? '2026-10-26T11:15:00' : null, apvRound: status === 'APPROVE' ? 1 : 0, idRq: status === 'APPROVE' ? 1 : null, rqCode: status === 'APPROVE' ? 'RQ6910/00098' : null,
    sendBack: null, cancel: null, creator: { id: P.counter.id, name: P.counter.name }, dateTs: '2026-10-26T09:00:00',
    rqSteps: status === 'APPROVE' ? { ack: { by: P.ack.name, at: '2026-10-26T13:00:00' }, check: null, approve: null } : null };
}
const DOCS = { 1: ['COUNT', 'O'], 2: ['COUNT', 'L'], 3: ['REVIEW', 'O'], 4: ['APPROVE', 'L'], 5: ['DRAFT', null], 6: ['DONE', 'O'] };
function docData(id) {
  const [st, mode] = DOCS[id];
  const ls = st === 'DRAFT' ? [] : lines(st);
  return { ...head(id, st, mode), stats: stats(ls), lines: ls, log: [
    { act: 'create', detail: 'สร้างเอกสาร SC6910/000' + id, at: '2026-10-25T16:20:00', by: P.counter.name },
    { act: 'start', detail: 'เริ่มตรวจนับ · snapshot ยอด ERP 14 รายการ', at: '2026-10-26T09:05:00', by: P.counter.name },
    { act: 'close', detail: 'ปิดการนับ · นับครบทุกรายการ', at: '2026-10-26T11:15:00', by: P.counter.name }] };
}

// ---------- ใบขอปรับยอดสต๊อก (RQ) ----------
const stepOf = (p, at) => ({ id: p.id, by: p.name, full: p.full, position: p.position, at });
const rq = (id, over = {}) => ({ id, docCode: 'RQ6910/000' + (97 + id), idComp: COMP.id, compCode: COMP.code, compName: COMP.name,
  note: id === 1 ? 'ตรวจนับสต๊อก SC6910/0004 (ประจำสัปดาห์)' : id === 2 ? 'ตรวจนับสต๊อก SC6910/0007 (ประจำเดือน)' : 'ปรับยอดตามการชั่งน้ำหนักจริงหน้างาน', dateTs: '2026-10-26T13:00:00',
  src: id === 3 ? null : 'SC', idCount: id === 3 ? null : 4, scCode: id === 3 ? null : 'SC6910/000' + (id === 1 ? 4 : 7), creator: P.reviewer.name, command: P.reviewer.name, action: P.counter.name,
  commandPs: person(P.reviewer), actionPs: person(P.counter), steps: { ack: null, check: null, approve: null }, cancel: null, revOf: null, nLine: 3, nPlus: 1, nMinus: 2, adjValue: -1250.5, ...over });
const RQ_LINES = [
  { id: 1, lotNo: '684-041-00011', invCode: 'CUC100210', invName: 'เมล็ดพันธุ์ แตงกวา C-746', unit: 'กิโลกรัม', loc: 'RM2 A-1-3', before: 5.7, op: '-', amount: 1, after: 4.7, note: 'นับคลาดเคลื่อน', now: 5.7, erp: 5.7, count: 4.7 },
  { id: 2, lotNo: '686-043-00013', invCode: 'PAC000112', invName: 'ซองฟอยล์ 10 กรัม พิมพ์ลาย', unit: 'ซอง', loc: 'RM2 A-1-3', before: 32.5, op: '+', amount: 2, after: 34.5, note: 'บันทึกรับ-จ่ายในระบบผิด', now: 32.5, erp: 32.5, count: 34.5 },
  { id: 3, lotNo: '685-046-00016', invCode: 'MOR200011', invName: 'เมล็ดพันธุ์ มะระขี้นก OP', unit: 'กิโลกรัม', loc: 'RM2 A-1-4', before: 14, op: '-', amount: 1, after: 13, note: 'เบิกใช้แล้วยังไม่ตัดระบบ', now: 14, erp: 14, count: 13 }];
const SC_SUM = { id: 4, docCode: 'SC6910/0004', status: 'APPROVE', typeName: 'ประจำสัปดาห์', dateCount: '2026-10-26T00:00:00', round: 1, mode: 'L', blind: false, scope: 'คลังสินค้าวัตถุดิบ > คลังวัตถุดิบ 2 > RACK A',
  counter: person(P.counter), reviewer: person(P.reviewer), dateClose: '2026-10-26T11:15:00', stats: { counted: 14, match: 9, short: 3, over: 2, exclude: 0 } };
function rqDoc(steps) {
  return { ...rq(1, { steps }), compInfo: COMP_INFO, lines: RQ_LINES, sc: SC_SUM, posted: null, reversedBy: [],
    log: [{ step: 'submit', note: 'สร้างจากเอกสารตรวจนับ SC6910/0004 (3 รายการ)', at: '2026-10-26T13:00:00', by: P.reviewer.name }, ...(steps.ack ? [{ step: 'accept', note: null, at: steps.ack.at, by: P.ack.name }] : []), ...(steps.check ? [{ step: 'check', note: null, at: steps.check.at, by: P.check.name }] : [])] };
}

// ---------- งานรออนุมัติ / รายงาน ----------
const prog3 = (n) => [['ack', 'รับทราบ'], ['check', 'ตรวจสอบ'], ['approve', 'อนุมัติ']].map(([k, name], i) => ({ name, done: i < n }));
const INBOX = (() => {
  const it = (id, docNo, title, src, nLine, my, done, date) => ({ mod: 'rq', scope: 'role', id, docNo, comp: COMP.name, compCode: COMP.code, date, title, src, srcType: 'SC', nLine, by: P.reviewer.name,
    my: my.map(k => ({ code: k, name: { ack: 'รับทราบ', check: 'ตรวจสอบ', approve: 'อนุมัติปรับยอด' }[k] })), progress: prog3(done), href: `/stock-adjust-approve?id=${id}&step=${my[0]}&from=inbox` });
  const data = [
    it(1, 'RQ6910/00098', 'ตรวจนับสต๊อก SC6910/0004 (ประจำสัปดาห์)', 'ตรวจนับ SC6910/0004', 3, ['check'], 1, '2026-10-26T13:00:00.000Z'),
    it(2, 'RQ6910/00099', 'ตรวจนับสต๊อก SC6910/0007 (ประจำเดือน)', 'ตรวจนับ SC6910/0007', 5, ['check'], 1, '2026-10-24T15:20:00.000Z'),
    { ...it(3, 'RQ6910/00100', 'ปรับยอดตามการชั่งน้ำหนักจริงหน้างาน', 'WIM Desktop', 2, ['check'], 1, '2026-10-15T09:40:00.000Z'), srcType: 'PC' }];
  return { success: true, data, counts: { rq: 3, rts: 0, ops: 0 }, total: 3, named: 0, role: 3, more: {}, badge: 3, badgeCounts: { rq: 3, rts: 0, ops: 0 }, unrestricted: false, eligible: true,
    mods: { rq: true, rts: false, ops: false }, me: P.check.id, postingReady: true, can: { rqBulk: ['check'] } };
})();
const RPT_DOCS = [
  { id: 6480, docCode: '6910/00003', date: '2026-10-27T15:10:00', idComp: 4, compCode: 'AV', compName: COMP.name, note: 'ตรวจนับสต๊อก SC6910/0004 (ประจำสัปดาห์)', cmd: P.reviewer.name, act: P.counter.name, idRq: 1, rqCode: 'RQ6910/00098', src: 'SC', scCode: 'SC6910/0004', apv: P.approve.name, revOf: null },
  { id: 6479, docCode: '6910/00002', date: '2026-10-20T10:05:00', idComp: 4, compCode: 'AV', compName: COMP.name, note: 'ปรับยอดตามการชั่งน้ำหนักจริงหน้างาน', cmd: P.reviewer.name, act: P.counter.name, idRq: 3, rqCode: 'RQ6910/00091', src: 'PC', scCode: '', apv: P.approve.name, revOf: null }];
const RPT_LINES = [
  { id: 1, doc: 6480, lotNo: '684-041-00011', invCode: 'CUC100210', invName: 'เมล็ดพันธุ์ แตงกวา C-746', idGroup: 1, unit: 'กิโลกรัม', wh: 'RM2 A-1-3', idWh0: 57, mainWh: 'คลังสินค้าวัตถุดิบ', before: 5.7, op: '-', amount: 1, after: 4.7, note: 'นับคลาดเคลื่อน', cause: 'นับคลาดเคลื่อน', rev: null },
  { id: 2, doc: 6480, lotNo: '686-043-00013', invCode: 'PAC000112', invName: 'ซองฟอยล์ 10 กรัม พิมพ์ลาย', idGroup: 2, unit: 'ซอง', wh: 'RM2 A-1-3', idWh0: 57, mainWh: 'คลังสินค้าวัตถุดิบ', before: 32.5, op: '+', amount: 2, after: 34.5, note: 'บันทึกรับ-จ่ายในระบบผิด', cause: 'บันทึกรับ-จ่ายในระบบผิด', rev: null },
  { id: 3, doc: 6480, lotNo: '685-046-00016', invCode: 'MOR200011', invName: 'เมล็ดพันธุ์ มะระขี้นก OP', idGroup: 1, unit: 'กิโลกรัม', wh: 'RM2 A-1-4', idWh0: 57, mainWh: 'คลังสินค้าวัตถุดิบ', before: 14, op: '-', amount: 1, after: 13, note: 'เบิกใช้แล้วยังไม่ตัดระบบ', cause: 'เบิกใช้แล้วยังไม่ตัดระบบ', rev: null },
  { id: 4, doc: 6479, lotNo: '683-021-00007', invCode: 'CUC101156', invName: 'เมล็ดพันธุ์ แตงร้าน CL-751', idGroup: 1, unit: 'กิโลกรัม', wh: 'RM1 B-2-1', idWh0: 57, mainWh: 'คลังสินค้าวัตถุดิบ', before: 20, op: '-', amount: 0.5, after: 19.5, note: 'ชั่งจริงขาด', cause: '', rev: null }];
const REV_INFO = { success: true, head: { id: 6480, docCode: '6910/00003', date: '2026-10-27T15:10:00', idComp: 4, note: 'ตรวจนับสต๊อก SC6910/0004 (ประจำสัปดาห์)', idRq: 1, rqCode: 'RQ6910/00098', isRev: false },
  lines: [
    { id: 1, lotNo: '684-041-00011', invName: 'เมล็ดพันธุ์ แตงกวา C-746', unit: 'กิโลกรัม', wh: 'RM2 A-1-3', op: '-', amount: 1, before: 5.7, after0: 4.7, revOp: '+', revAmount: 1, now: 4.7, newAfter: 5.7, state: 'ok', msg: '' },
    { id: 2, lotNo: '686-043-00013', invName: 'ซองฟอยล์ 10 กรัม พิมพ์ลาย', unit: 'ซอง', wh: 'RM2 A-1-3', op: '+', amount: 2, before: 32.5, after0: 34.5, revOp: '-', revAmount: 2, now: 34.5, newAfter: 32.5, state: 'ok', msg: '' },
    { id: 3, lotNo: '685-046-00016', invName: 'เมล็ดพันธุ์ มะระขี้นก OP', unit: 'กิโลกรัม', wh: 'RM2 A-1-4', op: '-', amount: 1, before: 14, after0: 13, revOp: '+', revAmount: 1, now: 13, newAfter: 14, state: 'locked', msg: 'Lot มีใบขอปรับยอด RQ6910/00101 ค้างอยู่ — รอให้ใบนั้นจบก่อน' }] };

function api(url, user) {
  const u = new URL(url), p = u.pathname;
  if (p.includes('/permissions/my')) return { success: true, unrestricted: true, allowedMenuCodes: [], wipMenuCodes: [] };
  if (p.includes('/auth/me')) return { success: true, user: { idPs: user.id, PsName: user.name, idComp: 4 } };
  if (p === '/api/approval-inbox/count') return { success: true, total: 3, counts: { rq: 3, rts: 0, ops: 0 }, eligible: true };
  if (p === '/api/approval-inbox') return INBOX;
  if (p === '/api/stock-count/meta') return { success: true, types, causes, companies: [COMP, { id: 3, code: 'GR', name: 'บริษัท กรีนซีดส์ จำกัด' }], can, postingReady: true, me: user.id };
  if (p === '/api/stock-count/overview') return { success: true, kpi: { docs30: 3, counted30: 42, match30: 34, accuracy30: 81, short30: 5, over30: 3, um30: 1, open: { draft: 1, counting: 2, review: 1, approve: 1 } },
    causes: [{ name: 'นับคลาดเคลื่อน', short: 3, over: 2 }, { name: 'เบิกใช้แล้วยังไม่ตัดระบบ', short: 2, over: 0 }, { name: 'บันทึกรับ-จ่ายในระบบผิด', short: 0, over: 1 }],
    topShort: [{ invCode: 'CUC100210', invName: 'เมล็ดพันธุ์ แตงกวา C-746', unit: 'กิโลกรัม', times: 3, docs: 2, qty: 2.5 }, { invCode: 'MOR200011', invName: 'เมล็ดพันธุ์ มะระขี้นก OP', unit: 'กิโลกรัม', times: 2, docs: 2, qty: 1 }],
    coverage: [{ idWh: 4, whName: 'คลังบรรจุภัณฑ์', nLot: 1699, lastCount: null, lastDoc: null, days: null, nDoc90: 0, level: 0, n: [1699, 0, 0, 0, 0] }, { idWh: 57, whName: 'คลังสินค้าวัตถุดิบ', nLot: 3301, lastCount: '2026-10-26', lastDoc: 'SC6910/0004', days: 2, nDoc90: 3, level: 2, n: [0, 2100, 820, 381, 0] },
      { idWh: 3, whName: 'คลังสำเร็จรูป', nLot: 1444, lastCount: '2026-06-01', lastDoc: 'SC6906/0003', days: 149, nDoc90: 0, level: 4, n: [0, 200, 300, 544, 400] }] };
  if (p === '/api/stock-count/warehouses') return { success: true, data: [
    { id: 57, parent0: 57, path: 'คลังสินค้าวัตถุดิบ', lvl: 0, nLot: 3301, level: 2, n: [0, 2100, 820, 381, 0], lastDt: '2026-10-26' },
    { id: 5200, parent0: 57, path: 'คลังสินค้าวัตถุดิบ › คลังวัตถุดิบ 2', lvl: 1, nLot: 1801, level: 3, n: [0, 600, 820, 381, 0], lastDt: '2026-10-26' },
    { id: 5201, parent0: 57, path: 'คลังสินค้าวัตถุดิบ › คลังวัตถุดิบ 2 › RACK A', lvl: 2, nLot: 300, level: 3, n: [0, 0, 120, 180, 0], lastDt: '2026-06-01' },
    { id: 4, parent0: 4, path: 'คลังบรรจุภัณฑ์', lvl: 0, nLot: 1699, level: 0, n: [1699, 0, 0, 0, 0], lastDt: null }] };
  if (p === '/api/stock-count/list') return { success: true, data: Object.keys(DOCS).map(id => { const d = docData(+id); delete d.lines; delete d.log; return d; }) };
  if (p === '/api/stock-count/overlap' || p === '/api/stock-count/next-round') return { success: true, data: [], round: 1 };
  const m = p.match(/^\/api\/stock-count\/doc\/(\d+)$/);
  if (m) return { success: true, data: docData(+m[1]) };
  if (p === '/api/stock-adjust/list') return { success: true, data: [rq(1, { steps: { ack: stepOf(P.ack, '2026-10-26T14:00:00'), check: null, approve: null } }), rq(2, { steps: { ack: stepOf(P.ack, '2026-10-25T09:00:00'), check: null, approve: null } }), rq(3, { steps: { ack: stepOf(P.ack, '2026-10-16T10:00:00'), check: null, approve: null } })],
    can, postingReady: true, me: user.id };
  if (p === '/api/stock-adjust/track') {
    const tab = u.searchParams.get('tab') || 'pending';
    const data = tab === 'cancel' ? [] : [rq(1, { steps: { ack: stepOf(P.ack, '2026-10-26T14:00:00'), check: null, approve: null } }), rq(2), rq(3, { docCode: 'RQ6705/00012', dateTs: '2024-05-12T10:00:00' })];
    return { success: true, tab, data, more: false, max: 1000, counts: { pending: 3, cancel: 0 }, ranged: false, me: user.id };
  }
  const d = p.match(/^\/api\/stock-adjust\/doc\/(\d+)$/);
  if (d) { const all = u.searchParams.get('final') || globalThis.__final; return { success: true, can, postingReady: true, me: user.id,
    data: rqDoc(all ? { ack: stepOf(P.ack, '2026-10-26T14:00:00'), check: stepOf(P.check, '2026-10-27T09:30:00'), approve: null } : { ack: stepOf(P.ack, '2026-10-26T14:00:00'), check: null, approve: null }) }; }
  if (p === '/api/stock-adjust-report/meta') return { success: true, companies: [COMP], groups: [{ id: 1, name: 'เมล็ดพันธุ์' }, { id: 2, name: 'บรรจุภัณฑ์' }], warehouses: [{ id: 57, name: 'คลังสินค้าวัตถุดิบ', idComp: 4 }], max: 20000, canReverse: true };
  if (p === '/api/stock-adjust-report/data') return { success: true, more: false, max: 20000, docs: RPT_DOCS, lines: RPT_LINES };
  if (p === '/api/stock-adjust-report/trend') return { success: true, months: Array.from({ length: 12 }, (_, i) => ({ y: i < 2 ? 2025 : 2026, m: ((i + 10) % 12) + 1, docs: [2, 1, 3, 2, 4, 1, 2, 3, 2, 1, 3, 2][i], plus: [3, 1, 4, 2, 5, 1, 2, 4, 3, 1, 2, 1][i], minus: [5, 2, 6, 4, 7, 3, 4, 5, 3, 2, 6, 3][i], set: 0 })) };
  if (/^\/api\/stock-adjust\/reverse\/\d+$/.test(p)) return REV_INFO;
  return { success: true, data: [] };
}

const SHOTS = {
  // ---- ฝั่งตรวจนับ ----
  async 'sc-list'(page) { await go(page, '/stock-count', P.counter); await page.evaluate(() => { const b = document.getElementById('stepsBox'); if (b && b.hidden) document.getElementById('stepsToggle').click(); }); await page.waitForTimeout(300); return top(page, 1180); },
  async 'sc-form'(page) { await go(page, '/stock-count', P.counter); await page.click('#btnNew'); await page.waitForTimeout(900); return page.locator('.modal-box:visible').first().screenshot({ type: 'png' }); },
  async 'sc-mode'(page) { await go(page, '/stock-count?id=5', P.counter); return top(page, 980); },
  async 'sc-sheet'(page) { await go(page, '/stock-count?id=1', P.counter); return top(page, 1150); },
  async 'sc-live'(page) { await go(page, '/stock-count?id=2', P.counter); return top(page, 1000); },
  async 'sc-close'(page) { await go(page, '/stock-count?id=1', P.counter); await page.locator('[data-act="close"]').first().click(); await page.waitForTimeout(700); return page.locator('.modal-box:visible').first().screenshot({ type: 'png' }); },
  async 'sc-review'(page) { await go(page, '/stock-count?id=3', P.reviewer); return top(page, 1300); },
  // ตารางตรวจสอบผลต่าง (การ์ดใต้ Dashboard) — ซ่อนแถบปุ่มลอยด้านล่างชั่วคราวไม่ให้บังตาราง
  async 'sc-review-lines'(page) { await go(page, '/stock-count?id=3', P.reviewer); await page.addStyleTag({ content: '.save-bar{position:static !important}' }); await page.waitForTimeout(300);
    return page.locator('.card', { hasText: 'ตรวจสอบผลต่าง' }).last().screenshot({ type: 'png' }); },
  async 'sc-overview'(page) { await go(page, '/stock-count', P.reviewer); await page.selectOption('#fComp', '4').catch(() => {}); await page.click('[data-ltab="overview"]'); await page.waitForTimeout(1200); return top(page, 1250); },
  // ---- ฝั่งอนุมัติปรับยอด ----
  async 'apv-inbox'(page) { await go(page, '/approvals', P.check); return top(page, 900); },
  async 'adj-list'(page) { await go(page, '/stock-adjust-approve?step=check', P.check); return top(page, 900); },
  async 'adj-doc'(page) { await go(page, '/stock-adjust-approve?id=1&step=check', P.check); await page.waitForTimeout(500); return page.locator('#docModal .modal-box').screenshot({ type: 'png' }); },
  async 'adj-final'(page) { globalThis.__final = 1; await go(page, '/stock-adjust-approve?id=1&step=approve', P.approve); await page.locator('[data-step="approve"]').first().click(); await page.waitForTimeout(600); globalThis.__final = 0; return page.locator('#dlgModal .modal-box').screenshot({ type: 'png' }); },
  async 'adj-track'(page) { await go(page, '/stock-adjust-list', P.reviewer); return top(page, 900); },
  async 'adj-report'(page) { await go(page, '/stock-adjust-report', P.reviewer); await page.locator('.rp-table [data-toggle]').first().click(); await page.waitForTimeout(400); return top(page, 1150); },
  async 'adj-reverse'(page) { await go(page, '/stock-adjust-report', P.reviewer); await page.locator('[data-rev]:visible').first().click(); await page.waitForTimeout(900); await page.fill('#rvxNote', 'ปรับผิด Lot — ต้องปรับที่ Lot 684-041-00012'); await page.waitForTimeout(200); return page.locator('.rvx-box').screenshot({ type: 'png' }); }
};

async function go(page, url, user) {
  await page.addInitScript(u => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: u.id, PsName: u.name, idComp: 4 })), user);
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(api(route.request().url(), user)) }));
  await page.route(/^https?:\/\/(?!localhost|fonts\.g|cdnjs)/, r => r.abort());
  await page.goto(`http://localhost:${PORT}${url}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1500);
  // ฟอนต์ไทยสำรองของ WebKit บน Windows วางวรรณยุกต์ผิด → อักษรไทยใช้ Noto Sans Thai (ชุดเดียวกับ mk.js)
  const NOTO_THAI = 'https://fonts.gstatic.com/s/notosansthai/v29/iJWQBXeUZi_OHPqn4wq6hQ2_hbJ1xyN9wd43SofNWcdfKI2hX2g.woff2';
  const thaiFix = ['Inter', 'Oswald', 'JetBrains Mono'].map(f => `@font-face{font-family:'${f}'; font-weight:100 900; src:url(${NOTO_THAI}) format('woff2'); unicode-range:U+0E01-0E5B,U+200C-200D,U+25CC;}`).join('');
  await page.addStyleTag({ content: '.dry-note, .test-banner{display:none !important}' + thaiFix });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}
async function top(page, h) { const m = await page.$('main'); const b = await m.boundingBox(); return page.screenshot({ type: 'png', clip: { x: b.x, y: Math.max(0, b.y - 12), width: b.width, height: Math.min(h, b.height + 24) } }); }
async function view(page) { const m = await page.$('main'); const b = await m.boundingBox(); const vh = page.viewportSize().height; return page.screenshot({ type: 'png', clip: { x: b.x, y: 0, width: b.width, height: vh } }); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/stock-adjust-list' || p === '/stock-adjust-approve') p = '/stock-adjust-approve';
    let f = path.join(PUBLIC, p); if (!path.extname(f)) f += '.html';
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) { r.statusCode = 404; return r.end(); }
    r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); r.end(fs.readFileSync(f));
  }).listen(PORT);
  const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const b = await webkit.launch();
  for (const [name, fn] of Object.entries(SHOTS)) {
    if (only.length && !only.includes(name)) continue;
    const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1.5 });
    const page = await ctx.newPage(); page.on('pageerror', e => console.log('  pageerror', name, e.message.slice(0, 120)));
    try { const buf = await fn(page); fs.writeFileSync(path.join(process.argv.includes('--tmp') ? __dirname : OUT, name + '.png'), buf); console.log('✓', name); }
    catch (e) { console.log('✗', name, e.message.split('\n')[0]); }
    await ctx.close();
  }
  await b.close(); srv.close();
})();
