// ทดสอบการแสดงผลบน iPhone (WebKit จริง) — ใช้: node run.js [ชื่อหน้า ...]  เช่น node run.js supplier-return stockcard
//   ผล: ตารางสรุปปัญหาต่อหน้า + ภาพหน้าจอใน out/ (ไม่ต้องต่อฐานข้อมูล: /api/* ถูกจำลองด้วย fixtures.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { webkit, devices } = require('playwright');
const fixtures = require('./fixtures');

const PUBLIC = path.resolve(__dirname, '../../public');
const OUT = path.resolve(__dirname, 'out');
const PORT = 3997;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let f = path.join(PUBLIC, p);
      if (!path.extname(f)) f += '.html';
      if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
      res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
      res.end(fs.readFileSync(f));
    }).listen(PORT, () => resolve(srv));
  });
}

// ตรวจในหน้า (รันใน browser)
function inPage() {
  const vw = window.innerWidth;
  const issues = [];
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const scrollParent = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return p; } return null; };
  const all = [...document.querySelectorAll('body *')].filter(el => visible(el) && !el.closest('.sidebar, .sidebar-overlay'));

  if (document.documentElement.scrollWidth > vw + 1) issues.push({ t: 'หน้าเลื่อนซ้าย-ขวาได้', d: `scrollWidth ${document.documentElement.scrollWidth} > ${vw}` });

  const over = all.filter(el => {
    const r = el.getBoundingClientRect();
    if (getComputedStyle(el).position === 'fixed') return false;
    if (r.right <= vw + 1 && r.left >= -1) return false;
    return !scrollParent(el);
  }).slice(0, 8);
  over.forEach(el => issues.push({ t: 'ล้นขอบจอ', d: `${name(el)} (${Math.round(el.getBoundingClientRect().left)}→${Math.round(el.getBoundingClientRect().right)})` }));

  // ปุ่มแถวเดียวกันสูง / กว้างไม่เท่ากัน
  const btns = all.filter(el => el.matches('button, .btn, a.btn, [class*="-btn"]') && el.getBoundingClientRect().height > 20);
  const byRow = new Map();
  btns.forEach(b => { const k = b.parentElement; const top = Math.round(b.getBoundingClientRect().top / 6); const key = k && (btns.indexOf(b) >= 0) ? top + '|' + [...document.querySelectorAll('*')].indexOf(k) : top; (byRow.get(key) || byRow.set(key, []).get(key)).push(b); });
  byRow.forEach(row => {
    if (row.length < 2) return;
    const hs = row.map(b => Math.round(b.getBoundingClientRect().height));
    if (Math.max(...hs) - Math.min(...hs) > 4) issues.push({ t: 'ปุ่มแถวเดียวกันสูงไม่เท่ากัน', d: row.map(b => (b.innerText || b.title || name(b)).trim().slice(0, 14) + ':' + Math.round(b.getBoundingClientRect().height)).join(' | ') });
  });

  // ช่องกรอก / select ที่ซ้อนกันสูงไม่เท่ากัน (กลุ่มเดียวกัน)
  const fields = all.filter(el => el.matches('select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), .search-shell, .input-shell') && !el.closest('.input-shell, .search-shell') === (el.matches('select, input')));
  const small = all.filter(el => el.matches('button, a.btn, select, input:not([type=hidden])') && el.getBoundingClientRect().height < 32 && !el.closest('.drawer') && !el.matches('input[type=checkbox], input[type=radio]')).slice(0, 5);
  small.forEach(el => issues.push({ t: 'แตะยาก (สูง < 32px)', d: `${name(el)} ${Math.round(el.getBoundingClientRect().height)}px` }));

  // iOS ซูมเองเมื่อโฟกัสช่องที่ตัวอักษร < 16px
  const zoom = all.filter(el => el.matches('select, textarea, input:not([type=checkbox]):not([type=radio]):not([type=hidden])') && parseFloat(getComputedStyle(el).fontSize) < 16);
  if (zoom.length) issues.push({ t: 'ช่องกรอกตัวอักษร < 16px (iOS ซูม)', d: `${zoom.length} ช่อง เช่น ${name(zoom[0])}` });

  // ข้อความถูกตัด (overflow hidden ไม่มี ellipsis)
  const clipped = all.filter(el => { const cs = getComputedStyle(el); return el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'hidden' && cs.textOverflow !== 'ellipsis' && el.textContent.trim(); }).slice(0, 4);
  clipped.forEach(el => issues.push({ t: 'ข้อความถูกตัด', d: `${name(el)} "${el.textContent.trim().slice(0, 24)}"` }));

  // ตารางที่ยังเป็นตารางบนมือถือ
  const tbl = [...document.querySelectorAll('table')].filter(t => visible(t) && getComputedStyle(t).display === 'table' && t.getBoundingClientRect().width > vw * 0.95 && t.querySelectorAll('tr').length > 1);
  tbl.filter((t, i, a) => a.findIndex(x => x.className === t.className) === i).forEach(t => issues.push({ t: 'ตารางกว้างบนมือถือ', d: name(t) + ` กว้าง ${Math.round(t.getBoundingClientRect().width)}px` }));
  return issues;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const only = process.argv.slice(2);
  const pages = fs.readdirSync(PUBLIC).filter(f => f.endsWith('.html') && !['sidebar.html'].includes(f)).map(f => f.replace(/\.html$/, '')).filter(p => !only.length || only.includes(p));
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'th-TH' });
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('wim_user', JSON.stringify({ idPs: 1, PsName: 'ทดสอบ', idComp: 4, token: 't' })); } catch (e) {}
  });
  await ctx.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures(route.request().url())) }));
  await ctx.route(/^https?:\/\/(?!localhost)/, route => route.abort());   // ไม่โหลดเว็บภายนอก (ฟอนต์ / CDN) ให้ผลคงที่
  let total = 0;
  for (const p of pages) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    try {
      await page.goto(`http://localhost:${PORT}/${p}`, { waitUntil: 'load', timeout: 15000 });
      await page.waitForTimeout(700);
      const issues = await page.evaluate(inPage);
      errs.slice(0, 2).forEach(m => issues.push({ t: 'JS error', d: m.slice(0, 100) }));
      await page.screenshot({ path: path.join(OUT, p + '.png'), fullPage: true }).catch(() => page.screenshot({ path: path.join(OUT, p + '.png') }));
      total += issues.length;
      console.log(`\n■ ${p}  ${issues.length ? '⚠ ' + issues.length + ' จุด' : '✓ ผ่าน'}`);
      issues.forEach(i => console.log(`   - ${i.t}: ${i.d}`));
    } catch (e) { console.log(`\n■ ${p}  ✗ เปิดไม่ได้: ${e.message.split('\n')[0]}`); }
    await page.close();
  }
  console.log(`\nรวม ${total} จุด • ภาพอยู่ที่ ${OUT}`);
  await browser.close(); srv.close();
})();
