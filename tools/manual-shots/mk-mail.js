// ถ่ายภาพอีเมลขออนุมัติ (ผู้อนุมัติ) จากเทมเพลตจริงใน server.js + ข้อมูลจำลอง → public/images/manual/over-po-sale/mail-approver.png
//   ใช้: node mk-mail.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const { webkit } = require('D:/WimOnWeb/tools/mobile-test/node_modules/playwright');
const NL = String.fromCharCode(10);
const lines = fs.readFileSync('D:/WimOnWeb/server.js', 'utf8').split(String.fromCharCode(13) + NL).join(NL).split(NL);
// ดึงประกาศ (const / function) ตามชื่อ — ขยายทีละบรรทัดจนคอมไพล์ผ่าน (ไม่เกิน 80 บรรทัด)
const grab = (re) => {
  const i = lines.findIndex(l => re.test(l));
  if (i < 0) throw new Error('ไม่พบ ' + re);
  for (let j = i; j < Math.min(lines.length, i + 80); j++) {
    const chunk = lines.slice(i, j + 1).join(NL);
    try { new vm.Script(chunk); return chunk; } catch (e) { /* ยังไม่จบประกาศ */ }
  }
  throw new Error('ไม่จบ ' + re);
};
const names = [/^const OPS_APV_STEPS/, /^const ursFmtDateThai/, /^const opsEsc /, /^const opsFmtQty/, /^const OPS_TITLE_RE/, /^const opsFormal/, /^const opsDear/, /^const opsStepName/,
  /^const opsFmtMoney/, /^const opsRound2/, /^const opsFmtPrice/, /^const opsMailWrap/, /^const opsKv/, /^function opsBuyItemsTable/, /^function buildOpsApvMail/];
const sandbox = {}; vm.createContext(sandbox);
vm.runInContext(names.map(grab).join(NL), sandbox);

const P = (name, full, pos) => ({ name, full, pos, position: pos });
const doc = {
  docNo: 'OPQ6910/0009', compReqName: 'บริษัท โฟลเทคซีดส์ จำกัด', causeNote: 'ผลผลิตจากแปลงสูงกว่าที่ประมาณการไว้ ทำให้ผลิตได้เกินยอดใบสั่งซื้อ',
  buy: { docNo: 'OPA6910/0006', dateGet: '2026-10-30', note: '', by: P('ลักขณา โถแก้วเขียว (ตั้น)', 'นางสาว ลักขณา โถแก้วเขียว', 'เจ้าหน้าที่จัดซื้อ') },
  items: [{ invName: 'เมล็ดพันธุ์ มะระขี้นก OP', unit: 'กิโลกรัม', amountOffer: 10, amountBuy: 10, price: 120, pos: [{ poCode: 'S69/09/0019' }] }]
};
const person = P('ณรงค์ วันช่วย (หนุ่ม)', 'นาย ณรงค์ วันช่วย', 'รองกรรมการผู้จัดการ');
const m = vm.runInContext('buildOpsApvMail', sandbox)(doc, 'https://wim.advanceseeds.com/over-po-sale-opa?id=9', person, ['accept'], 'send');
const htmlFile = path.join(__dirname, 'mail-approver.html');
fs.writeFileSync(htmlFile, '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;padding:14px 20px;width:1100px">' + m.html + '</body>');
(async () => {
  const br = await webkit.launch();
  const pg = await (await br.newContext({ viewport: { width: 1140, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await pg.goto('file:///' + htmlFile.split(path.sep).join('/')); await pg.waitForTimeout(500);
  // ซ่อนบรรทัดข้อความส่งอัตโนมัติ + ลิงก์ URL ท้ายอีเมล
  await pg.evaluate(() => { document.querySelectorAll('a').forEach(a => { if (/^https?:/.test(a.textContent.trim())) a.parentElement.style.display = 'none'; }); });
  await (await pg.$('body > div')).screenshot({ path: 'D:/WimOnWeb/public/images/manual/over-po-sale/mail-approver.png' });
  console.log('subject:', m.subject);
  await br.close(); fs.unlinkSync(htmlFile);
})();
