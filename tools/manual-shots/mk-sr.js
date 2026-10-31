// ถ่ายรูปประกอบคู่มือส่งคืนสินค้า/ลดหนี้ Supplier (หน้ารายการ + หมุดหมายเลข) จากหน้าจริง + ข้อมูลจำลอง (ไม่ต่อ DB / ไม่ใช้ session)
//   ใช้: node mk-sr.js  → public/images/manual/supplier-return/list.png
//   หมุด 1–7 ตรงกับรายการใต้รูปในคู่มือ (หัวข้อ 03)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('D:/WimOnWeb/tools/mobile-test/node_modules/playwright');
const PUBLIC = path.resolve(__dirname, '../../public');
const OUT = path.join(PUBLIC, 'images/manual/supplier-return');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const USER = { idPs: 2841, PsName: 'ปรียานุช จันทร์เขียว (กิ๊ฟ)', idComp: 5 };
const COMP = { id: 5, name: 'บริษัท ทดสอบ จำกัด', code: 'Test' };
const TYPES = [
  { id: 1, code: 'RR', name: 'ส่งคืน - ทดแทน', short: 'ส่งคืน-ทดแทน', credit: false, returnGoods: true },
  { id: 2, code: 'RC', name: 'ส่งคืน - ลดหนี้', short: 'ส่งคืน-ลดหนี้', credit: true, returnGoods: true },
  { id: 3, code: 'NR', name: 'ไม่ส่งคืน - ลดหนี้', short: 'ไม่ส่งคืน-ลดหนี้', credit: true, returnGoods: false }
];
const now = new Date(), ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const by = (n, h) => ({ by: n, at: `${ym}-16 ${h}:00` });
const item = (name, qty, unit, cost, price) => ({ po: 'O69/09/0001', rec: 'R69/09/0003', inv: 'INV1', name, reason: 'Purity ไม่ผ่าน', lot: 'ETC-01-690922', store: 'คลัง A', qty, unit, cost, price });
const D = (id, no, status, type, items, steps, remark) => ({ id, docNo: no, docDate: `${ym}-16`, returnDate: `${ym}-16`, status, type, compName: COMP.name, compCode: COMP.code,
  supName: 'P.K.S 2000', remark, items, steps: { create: by('ปรียานุช จันทร์เขียว (กิ๊ฟ)', '09'), ...steps }, cancel: null });
const DOCS = [
  D(31, 'RTS6910/0031', 0, 1, [item('ถุง PVC ใส ขนาด 8x12 นิ้ว', 1500, 'ใบ', 3, 0)], {}, 'ถุง PVC ชำรุด'),
  D(29, 'RTS6910/0029', 4, 3, [item('ผลตรวจคุณภาพไม่ผ่าน กะเพรา', 399, 'ซอง', 4, 2)], { ack: by('มาลี บัญชีดี', '10'), chk1: by('ประเสริฐ ตรวจดี', '10'), chk2: by('ชาญวุฒิ เฮงหิรัญ', '11') }, 'ผลตรวจคุณภาพไม่ผ่าน'),
  D(28, 'RTS6910/0028', 2, 1, [item('ข้าวโพดหวาน SUN-15', 11.4, 'กก.', 4, 0)], { ack: by('มาลี บัญชีดี', '10') }, 'ข้าวโพดหวานเมล็ดแตก'),
  D(27, 'RTS6910/0027', 1, 2, [item('เมล็ดข้าวโพดข้าวเหนียว', 11.63, 'กก.', 4, 0)], {}, 'เมล็ดข้าวเหนียวปน'),
  D(26, 'RTS6910/0026', 5, 2, [item('แตงกวา CM-736', 20, 'ซอง', 5, 3)], { ack: by('มาลี บัญชีดี', '10'), chk1: by('ประเสริฐ ตรวจดี', '10'), chk2: by('ชาญวุฒิ เฮงหิรัญ', '11'), appr: by('วิชัย ผู้อนุมัติ', '13') }, 'แตงกวาเมล็ดลีบ')
];
function api(p) {
  if (p.includes('/permissions/my')) return { success: true, unrestricted: true, allowedMenuCodes: [], wipMenuCodes: [] };
  if (p.includes('/supplier-return/meta')) return { success: true, types: TYPES, causes: [], canCancel: true, canManageCause: true, canEdit: true, canAck: true, canCheck: true, canApprove: true, me: USER.idPs, companies: [COMP] };
  if (p.includes('/supplier-return/list') || p.includes('/supplier-return/pending')) return { success: true, data: DOCS };
  if (p === '/api/companies') return { success: true, data: [{ idComp: COMP.id, CompName: COMP.name, CompCode: COMP.code }] };
  return { success: true, data: [] };
}

(async () => {
  const srv = http.createServer((q, r) => {
    const p = decodeURIComponent(q.url.split('?')[0]);
    if (p.startsWith('/api/')) { r.setHeader('Content-Type', 'application/json'); return r.end(JSON.stringify(api(p))); }
    let f = path.join(PUBLIC, p); if (!path.extname(f)) f += '.html';
    if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); }
    r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); r.end(fs.readFileSync(f));
  }).listen(5230);
  const b = await chromium.launch({ channel: 'chrome' });
  const c = await b.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  await c.addInitScript((u) => { sessionStorage.setItem('wim_user', JSON.stringify(u)); }, USER);
  await c.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  const pg = await c.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://localhost:5230/supplier-return'); await pg.waitForTimeout(2500);
  // หมุดหมายเลข (สีอำพัน) + กรอบประของปุ่มจัดการแถวแรก — แบบเดียวกับรูปเดิม
  const miss = await pg.evaluate(() => {
    const pin = (n, el, dx, dy) => { if (!el) return n; const r = el.getBoundingClientRect(); const d = document.createElement('div');
      d.textContent = n; d.style.cssText = `position:absolute; left:${r.right + scrollX + dx}px; top:${r.top + scrollY + dy}px; width:26px; height:26px; border-radius:50%;
        background:#f2a91c; color:#1b1404; font:700 14px Inter,sans-serif; display:flex; align-items:center; justify-content:center; z-index:9999; box-shadow:0 0 0 3px rgba(12,20,32,.9);`;
      document.body.appendChild(d); return null; };
    const g = [...document.querySelectorAll('#statusDash .dash-glbl small')];
    const row = document.querySelector('.doc-wrap tbody tr');
    const acts = row && row.querySelector('td');
    const chip = row && [...row.querySelectorAll('span, b')].find(e => /ส่งกลับแก้ไข/.test(e.textContent) && e.children.length === 0);
    const xls = [...document.querySelectorAll('button')].find(e => /Excel/.test(e.textContent) && e.offsetParent);
    const fs0 = document.querySelector('.flt-search'), flt = fs0 && (fs0.closest('.flt-panel, .filter-panel, .flt-box') || fs0.parentElement);
    const out = [pin(1, g[0], 8, -4), pin(2, g[1], 8, -4), pin(3, document.querySelector('[data-st="range"]'), -18, -12),
      pin(4, flt, -30, -12), pin(5, xls, -40, -18), pin(6, acts, -(acts ? acts.getBoundingClientRect().width : 0) - 12, 4), pin(7, chip, 2, -14)].filter(Boolean);
    if (acts) { const r = acts.getBoundingClientRect(); const box = document.createElement('div');
      box.style.cssText = `position:absolute; left:${r.left + scrollX + 2}px; top:${r.top + scrollY + 4}px; width:${r.width - 4}px; height:${r.height - 8}px; border:2px dashed #f2a91c; border-radius:8px; z-index:9998; pointer-events:none;`;
      document.body.appendChild(box); }
    return out;
  });
  await pg.screenshot({ path: path.join(OUT, 'list.png') });
  console.log('list.png', miss.length ? 'missing pins ' + miss.join(',') : 'pins ok', errs.join(' | ') || 'no JS errors');
  await b.close(); srv.close();
})();
