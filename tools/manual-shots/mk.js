// ถ่ายรูปประกอบคู่มือ Over PO แบบคมชัด (WebKit, scale 2) จากหน้าจริง + ข้อมูลจำลอง (ไม่ต่อ DB / ไม่ใช้ session)
//   ใช้: node mk.js [ชื่อรูป ...]  → บันทึกที่ public/images/manual/over-po-sale/
const http = require('http'), fs = require('fs'), path = require('path');
const { webkit } = require('D:/WimOnWeb/tools/mobile-test/node_modules/playwright');
const PUBLIC = path.resolve(__dirname, '../../public');
const OUT = path.join(PUBLIC, 'images/manual/over-po-sale');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const P = {
  teerasit: { id: 4, name: 'ธีรสิทธิ์ เทพสุริยานนท์ (กั๊ก)', full: 'นาย ธีรสิทธิ์ เทพสุริยานนท์', pos: 'ผู้จัดการฝ่ายส่งเสริมการผลิตเมล็ดพันธุ์', position: 'ผู้จัดการฝ่ายส่งเสริมการผลิตเมล็ดพันธุ์', email: 'teerasit@advanceseeds.com' },
  lakkhana: { id: 2730, name: 'ลักขณา โถแก้วเขียว (ตั้น)', full: 'นางสาว ลักขณา โถแก้วเขียว', pos: 'เจ้าหน้าที่จัดซื้อ', position: 'เจ้าหน้าที่จัดซื้อ', email: 'advanceseeds.lackana@gmail.com' },
  narong: { id: 275, name: 'ณรงค์ วันช่วย (หนุ่ม)', full: 'นาย ณรงค์ วันช่วย', pos: 'รองกรรมการผู้จัดการ', position: 'รองกรรมการผู้จัดการ', email: 'numadvance@gmail.com' },
  wanchai: { id: 1797, name: 'วันชัย ประพฤติธรรม (วันชัย)', full: 'นาย วันชัย ประพฤติธรรม', pos: 'ผู้จัดการฝ่ายการตลาด', position: 'ผู้จัดการฝ่ายการตลาด', email: 'advanceseeds.wanchai@gmail.com' },
  chatchawan: { id: 9, name: 'ชัชวาล วุ้นนที (ชัช)', full: 'นาย ชัชวาล วุ้นนที', pos: 'กรรมการผู้จัดการ', position: 'กรรมการผู้จัดการ', email: 'khunchatav@gmail.com' },
  anawat: { id: 7, name: 'อนวัช ญาณิสราพันธ์ (au)', full: 'นาย อนวัช ญาณิสราพันธ์', pos: 'กรรมการผู้จัดการ', position: 'กรรมการผู้จัดการ', email: 'anawaya@gmail.com' }
};
const STEPS = [['accept', P.narong], ['check', P.wanchai], ['approve1', P.chatchawan], ['approve2', P.anawat]];
const apv = (done) => STEPS.map(([step, p], i) => ({ round: 1, step, idPs: p.id, name: p.name, full: p.full, position: p.position, email: p.email,
  result: done > i ? 'A' : null, at: done > i ? `2026-10-22 1${i}:0${i + 1}` : undefined, actBy: done > i ? p.name : undefined }));

function doc(over = {}) {
  const base = {
    id: 9, docNo: 'OPQ6910/0009', docDate: '2026-10-22', status: 'A', stamp: '', compReq: 2, compReqName: 'บริษัท โฟลเทคซีดส์ จำกัด', compTarget: 4, compTargetName: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด',
    compInfo: { nameEn: 'Flotech Seeds Co.,Ltd.', address: '332 หมู่ 7 ต.แจ้ห่ม อ.แจ้ห่ม จ.ลำปาง 52120', tel: '054-271638, 086-1890202' },
    tgtInfo: { nameEn: 'Advance Seeds Co.,Ltd.', address: '99/9 หมู่ 4 ต.สวนพริกไทย อ.เมืองปทุมธานี 12000', tel: '0 2958 8476-8', fax: '0 2958 8479' },
    requester: P.teerasit, subject: 'แจ้งร้องขอขายเมล็ดพันธุ์ที่เกินใบสั่งซื้อ (Over PO)',
    causeNote: 'ผลผลิตจากแปลงสูงกว่าที่ประมาณการไว้ ทำให้ผลิตได้เกินยอดใบสั่งซื้อ', note: '',
    created: { by: P.teerasit.name, at: '2026-10-22 11:35' }, sent: { by: P.teerasit.name, at: '2026-10-22 11:35' }, edited: null, cancel: null, reject: null, buyerSteps: {},
    items: [{ idOpsDt: 11, invName: 'เมล็ดพันธุ์ มะระขี้นก OP', cropName: 'มะระ', unit: 'กิโลกรัม', amountPO: 22.1, amountSold: 140.7, amountRec: 0, amountProduce: 160, amountOffer: 10, amountBuy: 10, price: 120, note: '',
      pos: [{ poCode: 'S69/09/0019', datePO: '2026-09-28', amountPO: 22.1, amountSold: 140.7, amountRec: 0 }] }],
    mails: [], recipients: { to: [P.lakkhana], cc: [] },
    buy: { docNo: 'OPA6910/0006', docDate: '2026-10-22', at: '2026-10-22 11:37', dateGet: '2026-10-30', note: '', by: P.lakkhana },
    apvRound: 1, apvSummary: { done: 4, count: 4, acted: 4 }, approvals: apv(4),
    poAuto: { docNo: 'OS69/10/0001', saleOrder: 'ODP69/00100' }, internal: true, isBuyer: true, canEdit: false, viewOnly: true, canBuy: false, myApv: []
  };
  return { ...base, ...over };
}

const PEND = (n) => ({ id: 9, buyDocNo: 'OPA6910/0006', docNo: 'OPQ6910/0009', req: 2, reqName: 'บริษัท โฟลเทคซีดส์ จำกัด', buyAt: '2026-10-22 11:37', buyBy: P.lakkhana.name, done: 0, count: 4, steps: ['accept'],
  items: [{ invName: 'เมล็ดพันธุ์ มะระขี้นก OP', amountBuy: 10, unit: 'กิโลกรัม', price: 120, amt: 1200 }], total: 1200 });
const LIST_ITEM = { invName: 'เมล็ดพันธุ์ มะระขี้นก OP', cropName: 'มะระ', unit: 'กิโลกรัม', amountOffer: 10, amountBuy: 10, price: 120, poCodes: ['S69/09/0019'], poCode: 'S69/09/0019' };
const LISTDOC = (over = {}) => ({ id: 9, docNo: 'OPQ6910/0009', docDate: '2026-10-22', req: 2, reqName: 'บริษัท โฟลเทคซีดส์ จำกัด', target: 4, targetName: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด', requester: P.teerasit.name, subject: 'แจ้งร้องขอขายเมล็ดพันธุ์ที่เกินใบสั่งซื้อ (Over PO)',
  cause: 'ผลผลิตจากแปลงสูงกว่าที่ประมาณการไว้ ทำให้ผลิตได้เกินยอดใบสั่งซื้อ', status: 'A', sentAt: '2026-10-22 11:35', lastMail: '2026-10-22 11:35', mailFail: false, cancel: null, rejectNote: '', reject: null,
  buyDocNo: 'OPA6910/0006', buy: { by: P.lakkhana.name, at: '2026-10-22 11:37' }, apvDone: 4, apvCount: 4, apvActed: 4, poCode: 'OS69/10/0001', items: [LIST_ITEM], ...over });
const PO_LINE = { idPODt: 43741, idPOTs: 43485, poCode: 'S69/09/0019', datePO: '2026-09-28', invName: 'เมล็ดพันธุ์ มะระขี้นก OP', seedName: 'มะระ', unitName: 'กิโลกรัม', amountPO: 22.1, amountSold: 140.7, amountRec: 0, sellerComplete: true, fullyReceived: false, completed: false, idInvMain: 16286, usedIn: [], refOps: [] };
const SHOTS = {
  async 'list-req'(page) {
    await go(page, '/over-po-sale', { user: P.teerasit, doc: doc(), docs: [LISTDOC()] });
    await page.selectOption('#listCompSelect', '2'); await page.waitForTimeout(1200); return top(page, 1050);
  },
  async 'buy-list'(page) {
    await go(page, '/over-po-sale-buy', { user: P.lakkhana, doc: doc(), docs: [LISTDOC()] });
    await page.selectOption('#buyCompSelect', '4'); await page.waitForTimeout(1200); return top(page, 640);
  },
  async 'form'(page) { await formPage(page); return region(page, null, 'รายการ PO อ้างอิง และยอดที่เสนอขาย', true); },
  async 'po-picker'(page) { await formPage(page, { picker: true }); return page.locator('#poModal .modal-box').screenshot({ type: 'png' }); },
  async 'confirm-req'(page) { await formPage(page, { fill: true }); await page.click('#saveBtn'); await page.waitForTimeout(800); return page.locator('.modal-box:visible').first().screenshot({ type: 'png' }); },
  async 'form-items'(page) { await formPage(page, { fill: true }); return region(page, 'รายการ PO อ้างอิง และยอดที่เสนอขาย', 'สาเหตุการผลิตเกิน PO', false); },
  async 'doc-opq'(page) { await go(page, '/over-po-sale-doc?id=9', { user: P.teerasit, doc: doc({ status: 'H' }) }); return trimmed(page, '#docPaper .paper-fit >> nth=0'); },
  async 'doc-opa'(page) { await go(page, '/over-po-sale-opa?id=9', { user: P.lakkhana, doc: doc() }); return trimmed(page, '#docPaper .paper-fit >> nth=0'); },
  async 'opa-timeline'(page) { await go(page, '/over-po-sale-opa?id=9', { user: P.lakkhana, doc: doc() }); return page.locator('.doc-timeline').screenshot({ type: 'png' }); },
  async 'apv-page'(page) { await go(page, '/over-po-sale-opa?id=9', { user: P.narong, doc: doc({ status: 'H', poAuto: null, apvSummary: { done: 0, count: 4, acted: 0 }, approvals: apv(0), isBuyer: false, myApv: ['accept'] }) }); return top(page, 520); },
  async 'apv-list'(page) { await go(page, '/over-po-sale-apv', { user: P.narong, doc: doc(), pending: [PEND()] }); return top(page, 640); },
  async 'buy-consider'(page) { await consider(page); return top(page, 1000); },
  async 'confirm-buy'(page) { await consider(page); await page.locator('button:has-text("บันทึกพร้อมส่งขออนุมัติ")').first().click(); await page.waitForTimeout(800); return page.locator('.modal-box:visible').first().screenshot({ type: 'png' }); },
  async 'buy-approvers'(page) { await go(page, '/over-po-sale-buy?id=9', { user: P.lakkhana, doc: doc() }); return page.locator('.card:has-text("ผลการพิจารณาของผู้อนุมัติแต่ละท่าน")').last().screenshot({ type: 'png' }); }
};
async function formPage(page, opt = {}) {
  await go(page, '/over-po-sale', { user: P.teerasit, doc: doc(), docs: [], poLines: [PO_LINE], mailto: [{ idPs: 2730, name: P.lakkhana.name, position: P.lakkhana.position, email: P.lakkhana.email, isDefault: true }] });
  await page.click('#navFormBtn'); await page.waitForTimeout(500);
  await page.selectOption('#compReqSelect', '2'); await page.waitForTimeout(500); await page.selectOption('#compTargetSelect', '4'); await page.waitForTimeout(800);
  if (opt.picker || opt.fill) {
    await page.click('#openPoBtn'); await page.waitForTimeout(800);
    const c = page.locator('#poShowOpen'); if (await c.count()) { await c.check().catch(() => {}); }
    await page.waitForTimeout(600);
    if (process.env.DBG) { console.log((await page.locator('#poBody').innerHTML()).slice(0,500)); }
    if (opt.picker) { await page.locator('#poBody tr[data-po]').first().click(); await page.waitForTimeout(300); return; }
    await page.locator('#poBody tr[data-po]').first().click(); await page.click('#poConfirmBtn'); await page.waitForTimeout(600);
    await page.fill('[data-f=amountProduce]', '160.00'); await page.fill('[data-f=amountOffer]', '10.00');
    await page.fill('#causeInput', 'ผลผลิตจากแปลงสูงกว่าที่ประมาณการไว้ ทำให้ผลิตได้เกินยอดใบสั่งซื้อ'); await page.waitForTimeout(400);
  }
}
// ถ่ายช่วงตั้งแต่การ์ดที่มีหัวข้อ from (null = ต้นหน้า) ถึงก่อน/หลังการ์ด to (until=true: ก่อนการ์ด to / false: รวมการ์ด to)
async function region(page, from, to, until) {
  const card = (t) => page.locator('.card', { hasText: t }).last();
  const m = await (await page.$('main')).boundingBox();
  const a = from ? await card(from).boundingBox() : { y: m.y - 12 };
  const b = await card(to).boundingBox();
  const sy = await page.evaluate(() => window.scrollY);
  const y0 = a.y + sy, y1 = until ? b.y + sy - 8 : b.y + sy + b.height;
  return page.screenshot({ type: 'png', fullPage: true, clip: { x: m.x, y: y0, width: m.width, height: y1 - y0 } });
}
async function consider(page) {
  await go(page, '/over-po-sale-buy?id=9', { user: P.lakkhana, doc: doc({ status: 'S', buy: null, poAuto: null, approvals: [], apvRound: 0, apvSummary: { done: 0, count: 0, acted: 0 }, canBuy: true, viewOnly: false,
    items: doc().items.map(i => ({ ...i, amountBuy: null, price: null })), apvDefaults: { accept: P.narong, check: P.wanchai, approve1: P.chatchawan, approve2: P.anawat } }) });
  const ins = page.locator('main input[type=text]:visible'); await ins.nth(1).fill('120.00'); await ins.nth(1).blur();
  await page.fill('#buyDateGet', '2026-10-30'); await page.waitForTimeout(400);
}
async function trimmed(page, sel) {
  const el = page.locator(sel); const box = await el.boundingBox();
  const bottom = await el.evaluate(e => { let m = 0; const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); while (w.nextNode()) { if (!w.currentNode.nodeValue.trim()) continue; const r = document.createRange(); r.selectNodeContents(w.currentNode); m = Math.max(m, r.getBoundingClientRect().bottom); } return m; });
  const top0 = box.y - (await page.evaluate(() => 0));
  const sy = await page.evaluate(() => window.scrollY);
  return page.screenshot({ type: 'png', fullPage: true, clip: { x: box.x, y: box.y + sy, width: box.width, height: Math.min(box.height, bottom - box.y + 40) } });
}

async function go(page, url, { user, doc: d, pending = [], docs = [], poLines = [], mailto = [] }) {
  await page.addInitScript(u => sessionStorage.setItem('wim_user', JSON.stringify({ idPs: u.id, PsName: u.name, idComp: 4 })), user);
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url()); const p = u.pathname; let body = { success: true, data: [] };
    if (p.startsWith('/api/ops/doc/')) body = { success: true, data: d };
    else if (p.includes('/permissions/my')) body = { success: true, unrestricted: true, allowedMenuCodes: [], wipMenuCodes: [] };
    else if (p === '/api/ops/companies') body = { success: true, data: [{ id: 2, name: 'บริษัท โฟลเทคซีดส์ จำกัด', allowed: true }, { id: 4, name: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด', allowed: true }], mailReady: true };
    else if (p === '/api/ops/apv/pending') body = { success: true, data: pending };
    else if (p === '/api/ops/docs' || p === '/api/ops/buy/docs') body = { success: true, data: docs };
    else if (p === '/api/ops/po-lines') body = { success: true, data: poLines, hiddenOpen: 0 };
    else if (p === '/api/ops/mailto') body = { success: true, data: mailto };
    else if (p === '/api/ops/people') body = { success: true, data: [P.teerasit] };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://localhost:3994' + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.addStyleTag({ content: '.dry-note, .test-banner{display:none !important}' });
}
async function paper(page) { const el = await page.$('#docPaper, .paper-fit, .paper'); return el.screenshot({ type: 'png' }); }
async function top(page, h) { const m = await page.$('main'); const b = await m.boundingBox(); return page.screenshot({ type: 'png', clip: { x: b.x, y: Math.max(0, b.y - 12), width: b.width, height: Math.min(h, b.height + 24) } }); }

(async () => {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (/^\/over-po-sale/.test(p)) p = '/over-po-sale';
    let f = path.join(PUBLIC, p); if (!path.extname(f)) f += '.html';
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) { r.statusCode = 404; return r.end(); }
    r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); r.end(fs.readFileSync(f));
  }).listen(3994);
  const only = process.argv.slice(2);
  const b = await webkit.launch();
  for (const [name, fn] of Object.entries(SHOTS)) {
    if (only.length && !only.includes(name)) continue;
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage(); page.on('pageerror', e => console.log('  pageerror', e.message.slice(0, 120)));
    try { const buf = await fn(page); fs.writeFileSync(path.join(process.argv.includes('--tmp') ? __dirname : OUT, name + '.png'), buf); console.log('✓', name); }
    catch (e) { console.log('✗', name, e.message.split('\n')[0]); }
    await ctx.close();
  }
  await b.close(); srv.close();
})();
