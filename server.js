require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const sql = require('mssql');

const app = express();

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- ที่เก็บ Session แบบไฟล์ (แทนหน่วยความจำ) ----------
// server รันบน IIS (iisnode): process ถูกปิด/เปิดใหม่บ่อย (ไม่มีคนใช้ ~20 นาที, อัปไฟล์ .js ใหม่) -> session ในหน่วยความจำหายหมด
// เก็บเป็นไฟล์ sessions/<sid>.sess แทน: restart แล้วยังอยู่ และหลาย process ใช้ร่วมกันได้
// นามสกุล .sess: iisnode/nodemon ไม่ดูไฟล์นี้ (ไม่ restart วน) และ IIS ไม่เสิร์ฟไฟล์นามสกุลที่ไม่รู้จัก
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 วัน (ตรงกับ cookie.maxAge)

class FileSessionStore extends session.Store {
  constructor(dir) {
    super();
    this.dir = dir;
    // ลบไฟล์ที่หมดอายุทุกชั่วโมง (unref = ไม่กัน process ปิดตัว)
    setInterval(() => this.cleanup(), 60 * 60 * 1000).unref();
  }

  file(sid) {
    return path.join(this.dir, String(sid).replace(/[^A-Za-z0-9_-]/g, '_') + '.sess');
  }

  get(sid, cb) {
    fs.readFile(this.file(sid), 'utf8', (err, text) => {
      if (err) return cb(err.code === 'ENOENT' ? null : err, null);
      let data;
      try { data = JSON.parse(text); } catch (e) { return cb(null, null); } // ไฟล์เสีย/กำลังเขียน = ถือว่าไม่มี session
      if (!data || data.expires < Date.now()) return this.destroy(sid, () => cb(null, null));
      cb(null, data.sess);
    });
  }

  // เขียนไฟล์ชั่วคราวก่อนแล้ว rename ทับ: process อื่นจะไม่อ่านเจอไฟล์ที่เขียนไม่ครบ
  set(sid, sess, cb = () => {}) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SESSION_TTL_MS;
    const target = this.file(sid);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFile(tmp, JSON.stringify({ expires, sess }), 'utf8', (err) => {
      if (err) return cb(err);
      const rename = (tries) => fs.rename(tmp, target, (e) => {
        // Windows: ไฟล์ปลายทางถูกเปิดอ่านอยู่ -> rename ไม่ได้ชั่วคราว ลองใหม่สั้นๆ
        if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') && tries > 0) return setTimeout(() => rename(tries - 1), 30);
        if (e) fs.unlink(tmp, () => {});
        cb(e || null);
      });
      rename(5);
    });
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }

  destroy(sid, cb = () => {}) {
    fs.unlink(this.file(sid), (err) => cb(err && err.code !== 'ENOENT' ? err : null));
  }

  cleanup() {
    fs.readdir(this.dir, (err, names) => {
      if (err) return;
      names.forEach(name => {
        const p = path.join(this.dir, name);
        if (name.endsWith('.tmp')) {
          // ไฟล์ชั่วคราวที่ค้าง (process ถูกปิดกลางคัน) เกิน 1 ชั่วโมง
          fs.stat(p, (e, st) => { if (!e && Date.now() - st.mtimeMs > 60 * 60 * 1000) fs.unlink(p, () => {}); });
          return;
        }
        if (!name.endsWith('.sess')) return;
        fs.readFile(p, 'utf8', (e, text) => {
          if (e) return;
          let expires = 0;
          try { expires = JSON.parse(text).expires; } catch (x) { /* ไฟล์เสีย = ลบ */ }
          if (!(expires > Date.now())) fs.unlink(p, () => {});
        });
      });
    });
  }
}

// เตรียมโฟลเดอร์ sessions/ — เขียนไฟล์ไม่ได้ (ไม่มีสิทธิ์) ให้กลับไปใช้หน่วยความจำแบบเดิม ระบบยังทำงานได้
function createSessionStore() {
  const dir = path.join(__dirname, 'sessions');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    console.log('🗂️  Session store: ไฟล์ (' + dir + ')');
    return new FileSessionStore(dir);
  } catch (err) {
    console.error('⚠️ เขียนโฟลเดอร์ sessions ไม่ได้ ใช้ session ในหน่วยความจำแทน:', err.message);
    return undefined;
  }
}

// ตั้งค่า Session สำหรับเก็บข้อมูล Token และ User หลัง Login ผ่าน SSO สำเร็จ
app.use(session({
  store: createSessionStore(),
  secret: process.env.SESSION_SECRET || 'wim-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', 
    httpOnly: true,
    maxAge: SESSION_TTL_MS // 1 วัน
  }
}));

// เซฟตี้เน็ต: กัน error ที่หลุดไปโดยไม่มีใครจับ ไม่ให้ทำให้ server ทั้งตัวล่ม
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

// ==================================================================
// ---------- ลำดับเมนู: WIMWebMenu.SortOrder เป็นแหล่งเดียว ----------
// ==================================================================
// แก้ลำดับเมนูใน DB ที่เดียว → sidebar (ทุกหน้า) + หน้า Home เรียงตามนั้น (cache 1 นาที)
// เมนูที่ไม่มีใน WIMWebMenu / ไม่มี SortOrder = ต่อท้ายตามลำดับเดิมในไฟล์
const MENU_ORDER_CACHE_MS = 60 * 1000;
// stWip = 1 (On process): เมนูที่ยังพัฒนาไม่เสร็จ — ซ่อนจากผู้ใช้ทั่วไป / ให้สิทธิ์ไม่ได้ / กลุ่มระบบยังเห็น (ไว้ทดสอบ)
let menuOrderCache = { exp: 0, map: null, wip: [] };
let menuMetaRefresh = null;
// cache หมดอายุแล้ว: ส่งค่าเดิมไปก่อน แล้วอ่าน DB ใหม่เบื้องหลัง (ไม่ให้ /sidebar.html ต้องรอคิว DB ตอนหน้าอื่นดึงข้อมูลหนัก ๆ)
// รอ DB จริงเฉพาะครั้งแรกหลังเปิด server
async function loadMenuMeta() {
  if (menuOrderCache.map && menuOrderCache.exp > Date.now()) return menuOrderCache;
  if (!menuMetaRefresh) menuMetaRefresh = fetchMenuMeta().finally(() => { menuMetaRefresh = null; });
  if (menuOrderCache.map) {
    menuMetaRefresh.catch(err => console.error('Menu meta refresh error:', err.message));
    return menuOrderCache;
  }
  return menuMetaRefresh;
}
async function fetchMenuMeta() {
  const pool = await poolPromise;
  const r = await pool.request().query(
    `SELECT MenuCode, MIN(SortOrder) AS SortOrder, MAX(CAST(ISNULL(stWip, 0) AS int)) AS stWip
     FROM WIMWebMenu
     WHERE stDel IS NULL AND MenuCode IS NOT NULL
     GROUP BY MenuCode`
  );
  const map = {};
  const wip = [];
  r.recordset.forEach(x => {
    if (x.SortOrder != null) map[x.MenuCode] = x.SortOrder;
    if (x.stWip) wip.push(x.MenuCode);
  });
  menuOrderCache = { exp: Date.now() + MENU_ORDER_CACHE_MS, map, wip };
  return menuOrderCache;
}
const getMenuOrder = () => loadMenuMeta().then(m => m.map);
const getMenuOrderSafe = () => getMenuOrder().catch(err => { console.error('Menu order error:', err.message); return {}; });
const getWipMenusSafe = () => loadMenuMeta().then(m => m.wip).catch(err => { console.error('Menu WIP error:', err.message); return []; });

// เรียง sidebar.html ตาม SortOrder (เมนูซ้อนได้หลายชั้น)
//   1) เมนูที่คลิกได้ <a class="nav-subitem" data-menu=".."> : เรียงภายในกลุ่มเดียวกัน (ช่วงระหว่างแท็ก div)
//   2) กลุ่มย่อย <div class="nav-group nav-group-sub" data-group=".."> : เรียงกลุ่มพี่น้องที่อยู่ติดกันตาม SortOrder ของกลุ่ม
//   บรรทัด comment / ตำแหน่งกลุ่มเมนูหลักคงเดิม / ไม่มีใน DB = ต่อท้ายตามลำดับเดิมในไฟล์
function sortSidebarHtml(html, order) {
  const key = (code) => (order[code] ?? Number.MAX_SAFE_INTEGER);

  // 1) เมนูย่อย: ช่วงข้อความหลัง <div class="nav-submenu-inner"> จนถึงแท็ก div ถัดไป = กลุ่มเดียวกัน
  html = html.replace(/(<div class="nav-submenu-inner">)([\s\S]*?)(?=<div|<\/div>)/g, (m, open, body) => {
    const lines = body.split('\n');
    const slots = [];
    const items = [];
    lines.forEach((line, i) => {
      const mm = line.match(/^\s*<a class="nav-subitem"[^>]*data-menu="([^"]+)"/);
      if (mm) { slots.push(i); items.push({ line, code: mm[1], pos: items.length }); }
    });
    items.sort((a, b) => key(a.code) - key(b.code) || a.pos - b.pos);
    slots.forEach((lineIdx, k) => { lines[lineIdx] = items[k].line; });
    return open + lines.join('\n');
  });

  // 2) กลุ่มย่อย: หาแต่ละบล็อก (นับ div เปิด/ปิดให้ครบ) แล้วเรียงบล็อกที่อยู่ติดกัน (คั่นด้วยช่องว่าง/comment เท่านั้น)
  const OPEN = '<div class="nav-group nav-group-sub" data-group="';
  const blocks = [];
  for (let i = html.indexOf(OPEN); i >= 0; i = html.indexOf(OPEN, i + 1)) {
    let depth = 0, j = i;
    const tag = /<div\b|<\/div>/g;
    tag.lastIndex = i;
    let t;
    while ((t = tag.exec(html))) {
      depth += t[0] === '</div>' ? -1 : 1;
      if (depth === 0) { j = tag.lastIndex; break; }
    }
    const code = html.slice(i + OPEN.length, html.indexOf('"', i + OPEN.length));
    blocks.push({ start: i, end: j, code });
  }
  // ตัดบล็อกที่ซ้อนอยู่ในบล็อกอื่นออก (เรียงเฉพาะระดับเดียวกันในรอบนี้)
  const top = blocks.filter(b => !blocks.some(o => o !== b && o.start < b.start && b.end <= o.end));
  const runs = [];
  top.forEach(b => {
    const last = runs[runs.length - 1];
    const prev = last && last[last.length - 1];
    if (prev && /^(\s|<!--[\s\S]*?-->)*$/.test(html.slice(prev.end, b.start))) last.push(b);
    else runs.push([b]);
  });
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r];
    if (run.length < 2) continue;
    const parts = run.map((b, pos) => ({ text: html.slice(b.start, b.end), code: b.code, pos }));
    const gaps = run.slice(1).map((b, k) => html.slice(run[k].end, b.start));
    parts.sort((a, b) => key(a.code) - key(b.code) || a.pos - b.pos);
    const rebuilt = parts.map((p, k) => p.text + (gaps[k] ?? '')).join('');
    html = html.slice(0, run[0].start) + rebuilt + html.slice(run[run.length - 1].end);
  }
  return html;
}

// URL หน้าเว็บไม่มี .html: ลิงก์เก่า /coating.html?x=1 → /coating?x=1, /index.html → /
// (bookmark / ลิงก์ที่ส่งใน Telegram ไปแล้วยังใช้ได้) — ยกเว้น /sidebar.html ที่ sidebar.js ดึงไปแปะเอง
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const m = req.path.match(/^\/([\w-]+)\.html$/);
  if (!m || m[1] === 'sidebar') return next();
  const q = req.originalUrl.indexOf('?');
  const query = q >= 0 ? req.originalUrl.slice(q) : '';
  res.redirect(m[1] === 'index' ? '/' + query : '/' + m[1] + query);
});

// ทุกหน้าโหลด /sidebar.html มาแปะ → ส่งฉบับที่เรียงตาม DB แล้ว (ต้องอยู่ก่อน express.static)
app.get('/sidebar.html', async (req, res, next) => {
  try {
    const html = await fs.promises.readFile(path.join(__dirname, 'public', 'sidebar.html'), 'utf8');
    const order = await getMenuOrderSafe();
    res.set('Cache-Control', 'no-cache').type('html').send(sortSidebarHtml(html, order));
  } catch (err) {
    console.error('Sidebar order error:', err);
    next(); // อ่าน/เรียงไม่ได้ → ส่งไฟล์เดิมผ่าน express.static
  }
});

// เสิร์ฟไฟล์หน้าเว็บ (public/) จาก server เดียวกัน
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'], // /coating → public/coating.html
  // หน้า .html ให้ browser เช็คเวอร์ชันใหม่กับ server ทุกครั้ง (ไม่ใช้ของเก่าใน cache หลังอัปเดตไฟล์)
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ---------- การตั้งค่าเชื่อมต่อ SQL Server ----------
const dbConfig = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '1433', 10),
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true'
  },
  // ค่าเริ่มต้นของ mssql คือ 15 วินาที — เผื่อไว้สำหรับรายงานช่วงยาว (เช่น รับคืนสินค้าทั้งปี) ตอน DB ทำงานหนัก
  requestTimeout: 30000,
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let poolPromise = new sql.ConnectionPool(dbConfig).connect();

poolPromise
  .then(() => {
    console.log('✅ เชื่อมต่อ SQL Server (GR_Group) สำเร็จ');
  })
  .catch(err => {
    console.error('❌ เชื่อมต่อ SQL Server ไม่สำเร็จ:', err.message);
  });

// ---------- การตั้งค่า Central Auth (SSO) ----------
const CENTRAL_AUTH_URL = 'https://auth.advanceseeds.com';
const APP_CODE = 'wimweb-app';
const APP_SECRET = '0dd959d32d613a4485fb9b0d6b4f23ced7a6d3499e6178d1';

// 1. Endpoint พาผู้ใช้ไปหน้า Login กลาง (SSO)
// returnTo ต้องเป็น path ภายในเว็บนี้เท่านั้น (ขึ้นต้น / แต่ไม่ใช่ // หรือ /\) กัน open redirect
const safeReturnTo = (v) => {
  const s = String(v || '');
  return /^\/(?![\/\\])/.test(s) ? s : '';
};

app.get('/auth/sso/login', (req, res) => {
  const host = req.get('host');
  const protocol = req.secure ? 'https' : 'http';

  // login เสร็จแล้วให้กลับไปหน้าที่ขอมา (เช่น ลิงก์ตอบกลับคำร้อง)
  // ฝาก returnTo ไปกับ callback URL ด้วย (ระบบกลางส่งกลับมาครบ) — ไม่พึ่ง session อย่างเดียว
  // เพราะ cookie อาจหายระหว่างทาง (เปิดจาก LINE แล้วไป login ใน browser อื่น / host ไม่ตรงกัน)
  const returnTo = safeReturnTo(req.query.returnTo);
  if (returnTo) req.session.returnTo = returnTo;
  const returnUrl = `${protocol}://${host}/auth/sso/callback` + (returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '');

  res.redirect(`${CENTRAL_AUTH_URL}/sso/authorize?app=${APP_CODE}&return=${encodeURIComponent(returnUrl)}`);
});

// 2. Endpoint รับ Ticket กลับมาจากระบบกลาง เพื่อนำมาแลก Token และสร้าง Session
app.get('/auth/sso/callback', async (req, res) => {
  let { ticket } = req.query;
  let queryReturnTo = String(req.query.returnTo || '');
  // กันกรณีระบบกลางต่อ ticket ด้วย "?" ซ้ำ -> ticket ไปติดอยู่ท้าย returnTo
  if (!ticket) {
    const m = queryReturnTo.match(/[?&]ticket=([^&]+)/);
    if (m) {
      ticket = decodeURIComponent(m[1]);
      queryReturnTo = queryReturnTo.replace(/[?&]ticket=[^&]+/, '');
    }
  }
  if (!ticket) {
    return res.redirect('/?error=no_ticket');
  }

  try {
    const response = await fetch(`${CENTRAL_AUTH_URL}/sso/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, app: APP_CODE, app_secret: APP_SECRET })
    });
    
    const result = await response.json();
    if (!result.success) {
      throw new Error(result.error || 'Exchange failed');
    }

    // เก็บ Token และข้อมูลผู้ใช้ลงใน Session ของ Node.js
    req.session.access_token = result.data.access_token;
    req.session.refresh_token = result.data.refresh_token;
    req.session.user = result.data.user;

    // เติม idComp ให้ user จากฐานข้อมูลเหมือนระบบเดิม (ถ้ามี)
    try {
      const pool = await poolPromise;
      const compResult = await pool.request()
        .input('idPs', sql.Int, result.data.user.idPs)
        .query('SELECT idComp FROM devsk.vPersonxSelect WHERE idPs = @idPs');
      if (compResult.recordset.length > 0) {
        req.session.user.idComp = compResult.recordset[0].idComp;
      }
    } catch (compErr) {
      console.error('หา idComp ของผู้ใช้ไม่สำเร็จ:', compErr.message);
    }

    // ส่งข้อมูลผู้ใช้ให้ Frontend ผ่าน Script แทรกในหน้า main-menu หรือเก็บใน session API
    // ถ้าเข้ามาจากลิงก์ที่ต้อง login ก่อน (returnTo) ให้กลับไปหน้านั้น
    const returnTo = safeReturnTo(queryReturnTo) || safeReturnTo(req.session.returnTo);
    delete req.session.returnTo;
    res.redirect(returnTo || '/main-menu');
  } catch (err) {
    console.error('❌ SSO Exchange Error เต็มๆ:', err);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

// 3. Endpoint ตรวจสอบข้อมูลผู้ใช้ปัจจุบัน (ให้หน้า main-menu.html ดึงไปใช้แสดงผล)
app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: 'ยังไม่ได้เข้าสู่ระบบ' });
  }
  res.json({ success: true, user: req.session.user, access_token: req.session.access_token });
});

// 4. Endpoint สำหรับ Logout (ล้างฝั่งเรา แล้วส่งต่อไปล้างคุกกี้ที่ระบบกลาง)
app.get('/logout', (req, res) => {
  const host = req.get('host');
  const protocol = req.secure ? 'https' : 'http';
  const postLogoutReturn = `${protocol}://${host}/`;

  req.session.destroy(() => {
    res.redirect(`${CENTRAL_AUTH_URL}/sso/logout?app=${APP_CODE}&return=${encodeURIComponent(postLogoutReturn)}`);
  });
});

// ---------- endpoint ตรวจสอบว่า backend + DB พร้อมใช้งาน ----------
app.get('/api/health', async (req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request().query('SELECT 1 AS ok');
    res.json({ success: true, message: 'เชื่อมต่อฐานข้อมูลปกติ' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 3001;
// const PORT = process.env.PORT || 80;

// ==================================================================
// ---------- ตรวจสิทธิ์ฝั่ง server (เมนู + บริษัท) ----------
// ==================================================================
// กติกา:
//   ไม่มีกลุ่ม = ไม่มีสิทธิ์เมนูและบริษัทใดเลย / กลุ่มระบบ (stSystem) = ทุกเมนู + ทุกบริษัท
//   กลุ่มทั่วไป = เฉพาะเมนูใน WIMWebMenuPermission + บริษัทใน WIMWebGroupCompPer
// idPs อ่านจาก session เท่านั้น (ไม่เชื่อค่าที่หน้าเว็บส่งมา) / cache สั้นๆ กันยิง DB ทุก request
const ACCESS_CACHE_MS = 30 * 1000;
const accessCache = new Map();

function clearAccessCache() { accessCache.clear(); }

async function getUserAccess(idPs) {
  const hit = accessCache.get(idPs);
  if (hit && hit.exp > Date.now()) return hit.access;

  const pool = await poolPromise;
  const groupResult = await pool.request()
    .input('idPs', sql.Int, idPs)
    .query(
      `SELECT g.idGroup, g.stSystem
       FROM WIMWebUserGroupMember m
       JOIN WIMWebUserGroup g ON m.idGroup = g.idGroup
       WHERE m.idPs = @idPs AND m.stDel IS NULL AND g.stDel IS NULL`
    );

  let access;
  if (groupResult.recordset.length === 0) {
    // ไม่มีกลุ่ม = login ได้ เข้าหน้า Home ได้ แต่ปิดทุกเมนู (ให้แจ้งผู้ดูแลระบบเปิดสิทธิ์)
    // ยกเว้นหน้าตอบกลับคำร้อง URS (/api/urs/reply) ที่เช็คแค่ login — มีลิงก์ก็ตอบกลับได้
    access = { unrestricted: false, allComps: false, menus: new Set(), comps: new Set() };
  } else {
    const { idGroup, stSystem } = groupResult.recordset[0];
    if (stSystem === true || stSystem === 1) {
      access = { unrestricted: true, allComps: true, menus: new Set(), comps: new Set() };
    } else {
      const menuResult = await pool.request()
        .input('idGroup', sql.Int, idGroup)
        .query(
          `SELECT m.MenuCode
           FROM WIMWebMenuPermission p
           JOIN WIMWebMenu m ON p.idMenu = m.idMenu
           WHERE p.idGroup = @idGroup AND p.stAllow = 1 AND p.stDel IS NULL AND m.stDel IS NULL
             AND ISNULL(m.stWip, 0) = 0` // เมนู On process ไม่นับ แม้มีแถวสิทธิ์ค้างอยู่
        );
      const compResult = await pool.request()
        .input('idGroup', sql.Int, idGroup)
        .query(
          `SELECT p.idComp
           FROM WIMWebGroupCompPer p
           JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = p.idComp
           WHERE p.idGroup = @idGroup AND p.stAllow = 1 AND p.stDel IS NULL
             AND c.stDel IS NULL AND c.CompName IS NOT NULL`
        );
      access = {
        unrestricted: false,
        allComps: false,
        menus: new Set(menuResult.recordset.map(r => r.MenuCode)),
        comps: new Set(compResult.recordset.map(r => String(r.idComp)))
      };
    }
  }
  accessCache.set(idPs, { access, exp: Date.now() + ACCESS_CACHE_MS });
  return access;
}

const hasMenu = (access, code) => access.unrestricted || access.menus.has(code);
const hasComp = (access, idComp) => access.allComps || access.comps.has(String(idComp));

// เงื่อนไข SQL จำกัดเฉพาะบริษัทที่มีสิทธิ์ (ผูก parameter ให้ request) — ไม่มีบริษัทเลย = ไม่ให้เจอแถวใด
function compFilter(access, request, column) {
  if (access.allComps) return '';
  const ids = [...access.comps].map(Number).filter(Number.isInteger);
  if (ids.length === 0) return 'AND 1 = 0';
  ids.forEach((id, i) => request.input(`accComp${i}`, sql.Int, id));
  return `AND ${column} IN (${ids.map((_, i) => `@accComp${i}`).join(', ')})`;
}

// ต้อง login: เก็บ idPs (จาก session) ไว้ที่ req.idPs ให้ handler ใช้ต่อ
function requireLogin(req, res, next) {
  const idPs = req.session.user && parseInt(req.session.user.idPs, 10);
  if (!idPs) return res.status(401).json({ success: false, message: 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
  req.idPs = idPs;
  next();
}

// ต้องมีสิทธิ์อย่างน้อย 1 เมนูในรายการ / companyParam = ชื่อ field (query หรือ body) ที่เป็นรหัสบริษัท ให้เช็คสิทธิ์บริษัทด้วย
function requireMenu(codes, { companyParam } = {}) {
  const list = Array.isArray(codes) ? codes : [codes];
  return [requireLogin, async (req, res, next) => {
    try {
      const access = await getUserAccess(req.idPs);
      if (!list.some(code => hasMenu(access, code))) {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึงเมนูนี้ ติดต่อผู้ดูแลระบบ' });
      }
      if (companyParam) {
        const idComp = String((req.query[companyParam] ?? (req.body && req.body[companyParam]) ?? '')).trim();
        if (idComp && !hasComp(access, idComp)) {
          return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้' });
        }
      }
      req.access = access;
      next();
    } catch (err) {
      console.error('Access check error:', err);
      res.status(500).json({ success: false, message: 'ตรวจสอบสิทธิ์ไม่สำเร็จ', detail: err.message });
    }
  }];
}

const STOCKCARD_MENUS = ['stockcard_lot', 'stockcard_item'];
const MENU_ADMIN = 'menu_permission';

// ==================================================================
// ---------- STOCK CARD: บริษัท / ค้นหา Lot / เรียก stored procedure ----------
// ==================================================================

const LOT_TABLE = 'GR_Group.devsk.dInvLotMain';
const SP_STOCKCARD = 'devsk.sp_StockCardInv';
const SP_PARAM_LOT = 'idLot';

// ---------- บริษัทใน combobox: แสดงเฉพาะบริษัทที่กลุ่มของผู้ใช้ได้รับสิทธิ์ใน WIMWebGroupCompPer ----------
// กลุ่มระบบ = เห็นทุกบริษัท / ไม่มีกลุ่ม หรือกลุ่มที่ไม่ได้กำหนดสิทธิ์บริษัท = ไม่เห็นบริษัทเลย
app.get('/api/companies', requireLogin, async (req, res) => {
  const idPs = req.idPs;

  try {
    const pool = await poolPromise;
    const systemResult = await pool.request()
      .input('idPs', sql.Int, idPs)
      .query(
        `SELECT TOP 1 1 AS isSystem
         FROM WIMWebUserGroupMember m
         JOIN WIMWebUserGroup g ON g.idGroup = m.idGroup
         WHERE m.idPs = @idPs AND m.stDel IS NULL AND g.stDel IS NULL AND g.stSystem = 1`
      );

    if (systemResult.recordset.length > 0) {
      const all = await pool.request().query(
        `SELECT CompName AS name, idComp AS id
         FROM PchInvAndProject.dbo.dCompany
         WHERE stDel IS NULL AND CompName IS NOT NULL
         ORDER BY CompName`
      );
      return res.json({ success: true, data: all.recordset });
    }

    const result = await pool.request()
      .input('idPs', sql.Int, idPs)
      .query(
        `SELECT DISTINCT c.CompName AS name, c.idComp AS id
         FROM WIMWebUserGroupMember m
         JOIN WIMWebUserGroup g ON g.idGroup = m.idGroup
         JOIN WIMWebGroupCompPer p ON p.idGroup = g.idGroup
         JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = p.idComp
         WHERE m.idPs = @idPs AND m.stDel IS NULL
           AND g.stDel IS NULL AND ISNULL(g.stSystem, 0) = 0
           AND p.stAllow = 1 AND p.stDel IS NULL
           AND c.stDel IS NULL AND c.CompName IS NOT NULL
         ORDER BY c.CompName`
      );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Companies error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลบริษัทไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/lots/search', requireMenu('stockcard_lot', { companyParam: 'companyId' }), async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const companyId = (req.query.companyId || '').trim();

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อนค้นหา Lot' });
  }

  // จำกัดจำนวนแถวเสมอ (เดิมถ้า keyword ว่างจะดึงทุก Lot ของบริษัท ทำให้หน้าต่าง "เลือกจาก Lot No. ทั้งหมด" โหลดนาน/ค้าง)
  const defaultLimit = keyword ? 50 : 200;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), 500);
  // เงื่อนไขเสริมจากหน้าต่าง "เลือกจาก Lot No. ทั้งหมด" (ไม่บังคับ, ช่องที่กรอกจะกรองร่วมกันแบบ AND)
  // keyword = กรอง Lot No., productName = กรองชื่อสินค้า/วัสดุ, groupId = ประเภทสินค้า/วัสดุ
  const productName = (req.query.productName || '').trim();
  const groupId = (req.query.groupId || '').trim();

  try {
    const pool = await poolPromise;
    const request = pool.request()
      .input('companyId', sql.NVarChar, companyId)
      .input('limit', sql.Int, limit);

    const filters = [];
    if (keyword) {
      request.input('keyword', sql.NVarChar, `%${keyword}%`);
      filters.push('AND l.LotNo LIKE @keyword');
    }
    if (productName) {
      request.input('productName', sql.NVarChar, `%${productName}%`);
      filters.push('AND i.InvName LIKE @productName');
    }
    if (groupId) {
      request.input('groupId', sql.NVarChar, groupId);
      filters.push('AND i.idInvgroup = @groupId');
    }
    // รายการเริ่มต้น (ยังไม่พิมพ์ Lot No.): ไม่เอา Lot No. ที่มีแต่ - . _ หรือช่องว่าง (ข้อมูลเก่ากว่า 3,000 รายการ เรียงขึ้นก่อนเลข Lot จริงเสมอ)
    //   พิมพ์ค้นหา "-" ยังเจอได้ตามปกติ
    if (!keyword) {
      filters.push(`AND LEN(REPLACE(REPLACE(REPLACE(REPLACE(l.LotNo, '-', ''), '.', ''), '_', ''), ' ', '')) > 0`);
    }

    const result = await request.query(
      // แสดง / เรียง Lot No. แบบตัดช่องว่างหน้าหลัง (ข้อมูลเก่าบางตัวมีช่องว่างนำหน้า เรียงขึ้นก่อนเลขอื่นเสมอ)
      `SELECT TOP (@limit) l.idLot, LTRIM(RTRIM(l.LotNo)) AS lotNo, i.InvName AS productName, g.InvGroupName AS groupName
       FROM ${LOT_TABLE} l
       LEFT JOIN dInventoryMain i ON l.idInvMain = i.idInvMain
       LEFT JOIN devsk.dInvGroup g ON i.idInvgroup = g.idInvGroup
       WHERE l.stDel IS NULL AND l.CompRec = @companyId ${filters.join(' ')}
         AND l.LotNo IS NOT NULL AND LTRIM(RTRIM(l.LotNo)) <> ''
       ORDER BY LTRIM(RTRIM(l.LotNo))`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Lot search error:', err);
    res.status(500).json({ success: false, message: 'ค้นหา Lot ไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/lots/resolve', requireMenu('stockcard_lot', { companyParam: 'companyId' }), async (req, res) => {
  const lotNo = (req.query.lotNo || '').trim();
  const companyId = (req.query.companyId || '').trim();

  if (!lotNo || !companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทและระบุ Lot No.' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('companyId', sql.NVarChar, companyId)
      .input('lotNo', sql.NVarChar, lotNo)
      .query(
        // ข้อมูลเก่าบาง Lot มีช่องว่างหน้า/หลัง Lot No. (เช่น " 11A6606011E") — หน้าเว็บส่งแบบตัดช่องว่างมา จึงเทียบแบบไม่สนช่องว่าง
        `SELECT TOP 1 l.idLot, LTRIM(RTRIM(l.LotNo)) AS lotNo, i.InvName AS productName
         FROM ${LOT_TABLE} l
         LEFT JOIN dInventoryMain i ON l.idInvMain = i.idInvMain
         WHERE l.stDel IS NULL AND l.CompRec = @companyId AND LTRIM(RTRIM(l.LotNo)) = @lotNo
         ORDER BY CASE WHEN l.LotNo = @lotNo THEN 0 ELSE 1 END, l.idLot`
      );

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบ Lot No. นี้ในบริษัทที่เลือก' });
    }
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error('Lot resolve error:', err);
    res.status(500).json({ success: false, message: 'ค้นหา Lot ไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/stockcard', requireMenu('stockcard_lot'), async (req, res) => {
  const idLot = (req.query.idLot || '').trim();

  if (!idLot) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ Lot No.' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input(SP_PARAM_LOT, sql.NVarChar, idLot)
      .execute(SP_STOCKCARD);

    const rows = result.recordset || (result.recordsets && result.recordsets[0]) || [];
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('StockCard error:', err);
    res.status(500).json({ success: false, message: 'ดึงข้อมูล Stock Card ไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- STOCK CARD (รายสินค้า) ----------
// ==================================================================

app.get('/api/items/search', requireMenu('stockcard_item', { companyParam: 'companyId' }), async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const companyId = (req.query.companyId || '').trim();
  const groupId = (req.query.groupId || '').trim();

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อนค้นหาสินค้า' });
  }

  try {
    const pool = await poolPromise;
    const topClause = keyword ? 'TOP 50' : '';
    const request = pool.request()
      .input('companyId', sql.NVarChar, companyId)
      .input('keyword', sql.NVarChar, `%${keyword}%`);

    let groupFilter = '';
    if (groupId) {
      request.input('groupId', sql.NVarChar, groupId);
      groupFilter = 'AND i.idInvgroup = @groupId';
    }

    const result = await request.query(
      `SELECT ${topClause} DISTINCT i.idInvMain, i.InvName AS invName
       FROM dInventoryMain i
       WHERE i.InvName LIKE @keyword
         ${groupFilter}
         AND EXISTS (
           SELECT 1 FROM ${LOT_TABLE} l
           WHERE l.idInvMain = i.idInvMain AND l.CompRec = @companyId AND l.stDel IS NULL
         )
       ORDER BY i.InvName`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Item search error:', err);
    res.status(500).json({ success: false, message: 'ค้นหาสินค้าไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/inv-groups', requireMenu(STOCKCARD_MENUS), async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT idInvGroup AS id, InvGroupName AS name
       FROM devsk.dInvGroup
       WHERE stDel IS NULL
       ORDER BY InvGroupName`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Inv groups error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลกลุ่มสินค้าไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/stockcard-allot', requireMenu('stockcard_item', { companyParam: 'idComp' }), async (req, res) => {
  const idInvMain = (req.query.idInvMain || '').trim();
  const idComp = (req.query.idComp || '').trim();
  const monthS = parseInt(req.query.monthS, 10);
  const yearS = parseInt(req.query.yearS, 10);
  const monthE = parseInt(req.query.monthE, 10);
  const yearE = parseInt(req.query.yearE, 10);

  if (!idInvMain || !idComp || !monthS || !yearS || !monthE || !yearE) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุสินค้า บริษัท และช่วงเดือน/ปีให้ครบ' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('pInvMain', sql.NVarChar, idInvMain)
      .input('pComp', sql.NVarChar, idComp)
      .input('pMonthS', sql.Int, monthS)
      .input('pYearS', sql.Int, yearS)
      .input('pMonthE', sql.Int, monthE)
      .input('pYearE', sql.Int, yearE)
      .query('EXEC devsk.sp_StockCardInvAllLot @pInvMain, @pComp, @pMonthS, @pYearS, @pMonthE, @pYearE');

    const rows = result.recordset || (result.recordsets && result.recordsets[0]) || [];
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('StockCard AllLot error:', err);
    res.status(500).json({ success: false, message: 'ดึงข้อมูล Stock Card (รายสินค้า) ไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- รายงานการรับคืนสินค้า (Sale Return Report) ----------
// ==================================================================
// Query ตั้งต้นแปลงมาจากหน้า VB.NET เดิม (GCRTRpt) ตรงๆ โดยเปลี่ยนค่าที่ hardcode ไว้
// (idComp = 4, MONTH/YEAR = 9/2026) ให้เป็น parameter แทน
//
// ⚠️ หมายเหตุสำคัญที่ยังไม่ได้ทำในเวอร์ชันนี้ (รอ confirm business rule ก่อน):
//   1. ตัวกรอง "เฉพาะที่ผลงอกออกแล้ว" และ "เฉพาะความงอกน้อยกว่า 50%" ของหน้าจอเดิม
//      ยังไม่ทราบแน่ชัดว่า "ความงอก" ใน query นี้อ้างอิงจากคอลัมน์ไหน (GrowPaper / GrowSand / Pure / PureGene)
//      จึงยังไม่ implement เงื่อนไข SQL ส่วนนี้ — ส่งมาได้แต่จะยังไม่มีผลกับผลลัพธ์
//   2. ปุ่ม "ทำรายการร้องขอทำลาย" และ "รายงานการร้องขอทำลาย" ของหน้าจอเดิม (เขียนข้อมูล ไม่ใช่แค่ดูรายงาน)
//      ยังไม่มี endpoint รองรับ เพราะยังไม่มี schema ตารางที่ใช้บันทึกคำร้องขอทำลาย
//
// สถานะ "การแสดง Lot รับคืน" (all / depleted / remaining) คำนวณจากคอลัมน์ derived AmountRTBal
// จึง filter หลังคำนวณ AmountRTBal ในตารางชั่วคราว #rt แล้วเท่านั้น
// ทดสอบเทียบกับ query เดิมได้ด้วย sql/salereturn-compare.sql
// schema: Ss* / SmSaleReturnMt / SmSaleReturnDt / SmSaleReturnCause / dPackingPdSet อยู่ dbo — ที่เหลืออยู่ devsk
const EXCLUDED_WH = 5503; // คลังใน dInvLotRefWh ที่ไม่นับเป็นยอดคงเหลือของสินค้ารับคืน

app.get('/api/salereturn', requireMenu('stock_return', { companyParam: 'companyId' }), async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  const statusMode = (req.query.statusMode || 'remaining').trim(); // all | depleted | remaining
  const dateMode = (req.query.dateMode || 'month').trim();         // day | month | year
  const dateFrom = (req.query.dateFrom || '').trim();
  const dateTo = (req.query.dateTo || '').trim();
  const month = parseInt(req.query.month, 10);
  const year = parseInt(req.query.year, 10); // เป็น ค.ศ. เสมอ (แปลงจาก พ.ศ. ฝั่ง frontend ก่อนส่งมา)
  const lotNo = (req.query.lotNo || '').trim();
  const returnNo = (req.query.returnNo || '').trim();
  const productName = (req.query.productName || '').trim();

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อน' });
  }

  // ---------- เงื่อนไขวันที่ตามโหมดที่เลือก ----------
  // แปลงทุกโหมดเป็นช่วง [dStart, dEnd) แล้วเทียบกับคอลัมน์ตรงๆ (ไม่ครอบด้วย YEAR()/MONTH()/CAST()) ให้ SQL Server ใช้ index ได้
  // ส่งเป็น string รูปแบบ YYYYMMDD ซึ่งแปลงเป็น datetime ได้ถูกต้องเสมอ ไม่ขึ้นกับ DATEFORMAT / ภาษาของ session
  const ymd = (y, m, d) => `${String(y).padStart(4, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  const parseIsoDate = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 ? d : null;
  };
  let dStart, dEnd;
  if (dateMode === 'day') {
    const from = parseIsoDate(dateFrom);
    const to = parseIsoDate(dateTo);
    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุช่วงวันที่ให้ครบ' });
    }
    to.setUTCDate(to.getUTCDate() + 1); // รวมทั้งวันสุดท้าย
    dStart = ymd(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate());
    dEnd = ymd(to.getUTCFullYear(), to.getUTCMonth() + 1, to.getUTCDate());
  } else if (dateMode === 'month') {
    if (!month || month < 1 || month > 12 || !year) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุเดือนและปี' });
    }
    dStart = ymd(year, month, 1);
    dEnd = month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1);
  } else if (dateMode === 'year') {
    if (!year) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุปี' });
    }
    dStart = ymd(year, 1, 1);
    dEnd = ymd(year + 1, 1, 1);
  } else {
    return res.status(400).json({ success: false, message: 'ระบุ dateMode ไม่ถูกต้อง (day/month/year)' });
  }
  const dateCondition = 'AND wrtMt.DateWaitReturn >= @dStart AND wrtMt.DateWaitReturn < @dEnd';

  // ---------- เงื่อนไข "การแสดง Lot รับคืน" (ใช้กับ #rt หลังคำนวณ AmountRTBal แล้ว) ----------
  let statusCondition = '';
  if (statusMode === 'remaining') statusCondition = 'AND a.AmountRTBal > 0';
  else if (statusMode === 'depleted') statusCondition = 'AND a.AmountRTBal <= 0';
  else if (statusMode !== 'all') {
    return res.status(400).json({ success: false, message: 'ระบุ statusMode ไม่ถูกต้อง (all/depleted/remaining)' });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request()
      .input('idComp', sql.NVarChar, companyId)
      .input('dStart', sql.VarChar(8), dStart)
      .input('dEnd', sql.VarChar(8), dEnd);

    // ---------- เงื่อนไขค้นหาเพิ่มเติม (optional) ----------
    // lotNo / returnNo กรองได้ตั้งแต่ขั้นเลือก Lot (ลดจำนวน Lot ที่ต้องหาเมล็ด) / productName ต้องใช้ SeedNameUsed จึงกรองขั้นสุดท้าย
    let searchConditions = '';
    if (lotNo) {
      request.input('lotNo', sql.NVarChar, `%${lotNo}%`);
      searchConditions += ' AND a.LotNoRT LIKE @lotNo';
    }
    if (returnNo) {
      request.input('returnNo', sql.NVarChar, `%${returnNo}%`);
      searchConditions += ' AND a.ReturnNo LIKE @returnNo';
    }
    let productCondition = '';
    if (productName) {
      request.input('productName', sql.NVarChar, `%${productName}%`);
      productCondition = " AND (a.InvName LIKE @productName OR ISNULL(s.SeedNameUsed, '-') LIKE @productName)";
    }

    // ทำเป็นขั้นด้วยตารางชั่วคราว (ทดสอบแล้ว ผลตรงกับ query เดิมทุกแถว / ทั้งปีจาก >60 วินาที เหลือ <1 วินาที):
    //   1. แถวพื้นฐาน: เริ่มจาก WimWaitReturnMt ที่กรองวันที่ + INNER JOIN เส้นทาง wrtMt → wrtDt → rtdt → wDt → rDt
    //      (เงื่อนไขวันที่บังคับให้ทุกตารางในเส้นทางนี้มีข้อมูลอยู่แล้ว ผลเท่ากับ LEFT JOIN เดิม)
    //   2. AmountRTBal: รวม dInvLotRefWh ตาม idBox ครั้งเดียวทั้งชุด / "Amount ของ idRefLot เดียวกัน" = wh.Amount
    //      ไม่นับของที่อยู่คลัง EXCLUDED_WH (ยอดรวมกล่อง = ไม่รวมแถวคลังนั้น / ยอดของ idRefLot นี้ = 0 ถ้าอยู่คลังนั้น)
    //   3. SeedNameUsed: เฉพาะ Lot ที่ผ่านตัวกรอง — join หาเมล็ดทุก Lot ครั้งเดียว (#pairs) แล้วต่อชื่อจากตารางเล็ก
    //   (ตัด DateGrowPP / DateGrowSand ออก เพราะหน้าเว็บยังไม่ได้ใช้)
    const query = `
      SET NOCOUNT ON;

      SELECT CONVERT(bit,0) AS chk, rDt.idCountRef, comp.CompCode, lm.idLot, ps.PsName AS PsSale,
             wrtMt.DateWaitReturn, wrtMt.ReturnNo, rtdt.LotNoRT, p.PartnerName,
             inv.idInvMain, inv.idUnit, inv.InvName, rDt.idComp,
             ISNULL(CONCAT(FORMAT(pk.Weight,'#,##0.##'), ' ' + uw.UnitName),'-') AS WeightxUnit,
             inv.idInvGroup, rDt.SumVolumn AS AmountRT, wh.idRefLot,
             wh.idBox AS whIdBox, IIF(ISNULL(wh.idWh,0) = ${EXCLUDED_WH}, 0, wh.Amount) AS whAmount,
             u.UnitName, rDt.idPkPORec, rtdt.idSaleReturnDt, ISNULL(b.BoxNo, swh.WareHouseName) AS BoxNo,
             CASE WHEN ISNULL(st.idSaleRtType,'') = '' THEN cause.ReturnCause
                  ELSE st.SaleReturnType + ' (' + cause.ReturnCause + ')' END AS ReturnCause,
             qt.Humid, rDt.SumVolumn, rDt.idLotMain,
             ISNULL(rtdt.RTPrice,0) AS RTPrice,
             qt.GrowPaper, qt.GrowSand, qt.GrowAA, qt.GrowMedia, qt.Pure, qt.PureGene, qt.NoteConfirm,
             b.BoxNo AS BoxNoRT, swh.WareHouseName
      INTO #rt
      FROM devsk.WimWaitReturnMt wrtMt
      JOIN devsk.WimWaitReturnDt wrtDt ON wrtDt.idWaitReturn = wrtMt.idWaitReturn
      JOIN dbo.SmSaleReturnDt rtdt     ON rtdt.idWaitReturnDt = wrtDt.idWaitReturnDt
      JOIN devsk.WimWaitRecDt wDt      ON wDt.idDt = rtdt.idSaleReturnDt
      JOIN devsk.vPkPORecReturn rDt    ON rDt.idWaitRecDt = wDt.idWaitRecDt
      LEFT JOIN devsk.WimWaitRecMt wMt ON wDt.idWaitRecMt = wMt.idWaitRecMt AND wMt.ProcessID = 3 AND wMt.stCancel IS NULL
      LEFT JOIN dbo.SmSaleReturnMt rtmt       ON rtdt.idSaleReturn = rtmt.idSaleReturn
      LEFT JOIN dbo.SsWareHouse swh           ON rDt.idWh = swh.idWh
      LEFT JOIN devsk.dPartner p              ON rtmt.idPartner = p.idPartner
      LEFT JOIN devsk.dInventoryMain inv      ON rDt.idInvMain = inv.idInvMain
      LEFT JOIN devsk.WimReturnBox b          ON rDt.idBox = b.idBox
      LEFT JOIN devsk.dInvUnit u              ON rDt.idUnitNew = u.idUnit
      LEFT JOIN devsk.vPersonxSelect ps       ON rtmt.idPsSale = ps.idPs
      LEFT JOIN dbo.SmSaleReturnCause cause   ON wrtDt.idRtCause = cause.idRtCause
      LEFT JOIN devsk.SmSaleReturnType st     ON cause.idSaleRtType = st.idSaleRtType
      LEFT JOIN dbo.dPackingPdSet pk          ON inv.idSubType = pk.idPdPk AND inv.idInvGroup = 2
      LEFT JOIN devsk.dInvUnit uw             ON pk.idUnitW = uw.idUnit
      LEFT JOIN devsk.dInvLotRefWh wh         ON rDt.idRefLot = wh.idRefLot
      LEFT JOIN PchInvAndProject.dbo.dCompany AS comp ON rDt.idComp = comp.idComp
      LEFT JOIN devsk.dInvLotQuality qt       ON rtdt.idSaleReturnDt = qt.idLot AND qt.TypeReturn = 1
      LEFT JOIN devsk.dInvLotMain lm          ON rDt.idLotMain = lm.idLot
      WHERE rtmt.idPsCancel IS NULL
        AND rDt.idComp = @idComp
        ${dateCondition};

      SELECT rw.idBox, SUM(rw.Amount) AS BoxSum
      INTO #box
      FROM devsk.dInvLotRefWh rw
      WHERE rw.idBox IN (SELECT whIdBox FROM #rt WHERE whIdBox IS NOT NULL)
        AND ISNULL(rw.idWh,0) <> ${EXCLUDED_WH}
      GROUP BY rw.idBox;

      ALTER TABLE #rt ADD AmountRTBal decimal(18,4) NULL;

      UPDATE a
      SET AmountRTBal = IIF(ISNULL(bx.BoxSum,0) = 0,
                            IIF(a.whAmount > a.SumVolumn, a.SumVolumn, a.whAmount),
                            bx.BoxSum)
      FROM #rt a
      LEFT JOIN #box bx ON bx.idBox = a.whIdBox;

      SELECT DISTINCT a.idLotMain
      INTO #lots
      FROM #rt a
      WHERE a.idLotMain IS NOT NULL
        ${statusCondition}
        ${searchConditions};

      SELECT DISTINCT lm2.idLot AS idLotMain, inv2.InvName
      INTO #pairs
      FROM devsk.dInvLotMain lm2
      JOIN devsk.dWithdrawMt dMt      ON lm2.idPlan = dMt.idPlanMt
      JOIN devsk.dWithdrawDt dDt      ON dMt.idWitdMt = dDt.idWitdMt
      JOIN devsk.dInventoryMain inv2  ON dDt.idInvMain = inv2.idInvMain
      WHERE lm2.idLot IN (SELECT idLotMain FROM #lots)
        AND inv2.idInvGroup = 1
        AND stCancel = 0;

      SELECT l.idLotMain,
             ISNULL(SUBSTRING(
               (SELECT ',' + pr.InvName AS [text()]
                FROM #pairs pr
                WHERE pr.idLotMain = l.idLotMain
                ORDER BY pr.InvName
                FOR XML PATH (''), TYPE
               ).value('text()[1]','nvarchar(max)'), 2, 2000), '-') AS SeedNameUsed
      INTO #seed
      FROM #lots l;

      SELECT a.*, ISNULL(s.SeedNameUsed, '-') AS SeedNameUsed
      FROM #rt a
      LEFT JOIN #seed s ON s.idLotMain = a.idLotMain
      WHERE 1=1
        ${statusCondition}
        ${searchConditions}
        ${productCondition}
      ORDER BY a.BoxNo;`;

    const result = await request.query(query);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Sale return report error:', err);
    res.status(500).json({ success: false, message: 'ดึงข้อมูลรายงานการรับคืนสินค้าไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- รายงานรับเมล็ดจากบริษัทในเครือ (PO -> ใบรับ) ----------
// ==================================================================
// ดึงบรรทัด PO ของผู้ขายที่เป็นบริษัทในเครือ + ใบรับที่อ้างอิงบรรทัดนั้น (ไม่รวมใบรับที่ยกเลิก)
// แล้วคำนวณยอดรับสะสม / % ของ PO / ยอด PO คงเหลือหลังรับแต่ละครั้ง ฝั่ง server
// - คิดยอดคงเหลือแยกตาม "บรรทัด PO" (idPODt) เพราะ PO หนึ่งใบมีได้หลายสินค้า
// - หน่วยรับ ≠ หน่วย PO: แปลงได้เฉพาะ กรัม(1) <-> กิโลกรัม(2) / หน่วยอื่นที่ไม่ตรงกัน = ไม่นำมาคำนวณ แจ้งเตือนแทน
// - ยอดรับสะสม > 120% ของ PO = แจ้งเตือนรับเกิน
const AFFILIATE_SUPPLIERS = [932, 504, 361];   // idSup ของบริษัทในเครือ (vSupplier)
const AFFILIATE_COMPANIES = ['2', '3', '4'];    // บริษัทที่ใช้รายงานนี้ได้
const GRAM_FACTOR = { 1: 1, 2: 1000 };          // idUnit -> จำนวนกรัม
const OVER_RECEIVE_PCT = 120;
// กลุ่มสินค้าที่นำมาแสดง: 1 = เมล็ดพันธุ์วัตถุดิบ / 42 = เมล็ดพันธุ์ดอกไม้แพ็คซองเล็ก (dInventoryMain.idInvGroup)
const SEED_INV_GROUPS = [1, 42];
// ประเภทพืช (dSeed.idSeed): กลุ่ม 1 ผ่าน vSeedProduct / กลุ่ม 42 ผ่าน dSeedFlPackage — ต้องมี alias ci = dInventoryMain
const CROP_JOIN_SQL = `LEFT JOIN dbo.vSeedProduct cs ON ci.idSubType = cs.idPd AND ci.idInvGroup = 1
      LEFT JOIN devsk.dSeedFlPackage cf ON ci.idSubType = cf.idFlPk AND ci.idInvGroup = 42`;
const CROP_ID_SQL = 'COALESCE(cs.idSeed, cf.idSeed)';

// ปัดเศษ 6 ตำแหน่ง (รองรับเมล็ดน้ำหนักเบามาก) และตัด error ของทศนิยม float เช่น 0.30000000000000004
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// แปลงจำนวนจากหน่วยหนึ่งไปอีกหน่วย / แปลงไม่ได้ = null
function convertUnit(amount, fromUnit, toUnit) {
  if (amount === null || amount === undefined || fromUnit == null || toUnit == null) return null;
  if (fromUnit === toUnit) return amount;
  if (GRAM_FACTOR[fromUnit] && GRAM_FACTOR[toUnit]) return amount * GRAM_FACTOR[fromUnit] / GRAM_FACTOR[toUnit];
  return null;
}

// สถานะการรับ: pending ยังไม่รับ / partial < 100% / complete 100% – 100.9% / excess รับเกิน 1–20% (101% – 120%) / over > 120%
// ตัดสินจาก % ที่ปัดทศนิยม 1 ตำแหน่ง (ตรงกับที่แสดงบนจอ)
const pct1 = (p) => Math.round(p * 10) / 10;
function lineStatus(receiptCount, pct) {
  if (receiptCount === 0) return 'pending';
  if (pct === null) return 'partial';
  if (pct1(pct) > OVER_RECEIVE_PCT) return 'over';
  if (pct1(pct) >= 101) return 'excess';
  if (pct1(pct) >= 100) return 'complete';
  return 'partial';
}

// แปลงแถวแบน (PO line x รายการรับ) เป็นโครงสร้าง PO -> บรรทัด PO -> ใบรับ (ครั้งที่รับ) -> Lot
// withLedger = true: ใส่ ledger (บรรทัด Stock Card ราย Lot พร้อมคงเหลือสะสม) ในแต่ละบรรทัด PO — ใช้เฉพาะตอนดูราย PO
function buildPoReceiveTree(rows, { withLedger = false } = {}) {
  const unitNames = {};
  const poMap = new Map();

  rows.forEach(r => {
    if (r.idUnitPO != null) unitNames[r.idUnitPO] = r.UnitPO;
    if (r.idUnitRec != null) unitNames[r.idUnitRec] = r.UnitRec;

    // จัดกลุ่มตามเลขที่ PO (เลขเดียวกันมีได้หลายเอกสาร PKPOBuyMt คนละวันที่) ใช้วันที่ PO แรกสุด
    if (!poMap.has(r.POCode)) {
      poMap.set(r.POCode, {
        poCode: r.POCode, dateBuy: r.DateBuyD, idSup: r.idSup, supName: r.SupName,
        completed: true, dateComplete: null, completeNote: null, lineMap: new Map()
      });
    }
    const po = poMap.get(r.POCode);
    if (r.DateBuyD && (!po.dateBuy || new Date(r.DateBuyD) < new Date(po.dateBuy))) po.dateBuy = r.DateBuyD;
    // สิ้นสุด PO (bmt.idPsComplete IS NOT NULL): เลขที่ PO เดียวกันหลายเอกสาร ต้องสิ้นสุดครบทุกเอกสาร
    if (r.idPsComplete == null) po.completed = false;
    else {
      if (r.DateComplete && (!po.dateComplete || new Date(r.DateComplete) > new Date(po.dateComplete))) po.dateComplete = r.DateComplete;
      if (r.CompleteNote) po.completeNote = r.CompleteNote;
    }

    if (!po.lineMap.has(r.idPODt)) {
      po.lineMap.set(r.idPODt, {
        idPODt: r.idPODt, idInvMain: r.idInvMainPO, invName: r.InvNamePO, amountPO: Number(r.AmountPO) || 0,
        idUnitPO: r.idUnitPO, invGroup: r.InvGroup,
        cropId: r.CropId ?? null, cropName: r.CropName ?? null, docMap: new Map()
      });
    }
    const line = po.lineMap.get(r.idPODt);
    if (r.idPkPORecDt == null) return; // บรรทัด PO ที่ยังไม่มีการรับ

    if (!line.docMap.has(r.idPkPORec)) {
      line.docMap.set(r.idPkPORec, { idPkPORec: r.idPkPORec, docRec: r.DocRec, docRef: r.DocRef, dateRec: r.DateRec, lots: [] });
    }
    line.docMap.get(r.idPkPORec).lots.push({
      lotNo: r.LotNo, invName: r.InvName, amountRec: Number(r.AmountRec) || 0, idUnitRec: r.idUnitRec
    });
  });

  unitNames[1] = unitNames[1] || 'กรัม';
  unitNames[2] = unitNames[2] || 'กิโลกรัม';
  const unitName = (id) => (id != null && unitNames[id]) || '';

  const pos = [...poMap.values()].map(po => {
    let unitErrors = 0;
    const docIds = new Set();
    let lastDateRec = null;

    const lines = [...po.lineMap.values()].map(line => {
      const poAmt = line.amountPO;
      let cumPo = 0;          // ยอดรับสะสม (หน่วย PO)
      let lineUnitErrors = 0;
      const ledgerSrc = [];   // ทุก Lot เรียงตามวันที่รับ (เก็บยอดหน่วย PO ไว้ไล่คงเหลือภายหลัง)
      // เมล็ดพันธุ์วัตถุดิบ (กลุ่ม 1) ที่ PO เป็นกรัม/กิโลกรัม: แสดงผลเป็นกิโลกรัมทั้งหมด
      // (กลุ่ม 42 ดอกไม้แพ็คซอง / กลุ่ม 1 ที่ PO เป็นซอง: แสดงตามหน่วยเดิม)
      const forceKg = line.invGroup === 1 && !!GRAM_FACTOR[line.idUnitPO];
      const lotDisp = (lot) => {
        const kg = forceKg ? convertUnit(lot.amountRec, lot.idUnitRec, 2) : null;
        return kg === null ? { amountRec: lot.amountRec, unitRec: unitName(lot.idUnitRec) } : { amountRec: round6(kg), unitRec: unitName(2) };
      };

      const receipts = [...line.docMap.values()]
        .sort((a, b) => new Date(a.dateRec) - new Date(b.dateRec) || a.idPkPORec - b.idPkPORec)
        .map((doc, idx) => {
          docIds.add(doc.idPkPORec);
          if (!lastDateRec || new Date(doc.dateRec) > new Date(lastDateRec)) lastDateRec = doc.dateRec;

          let docPo = 0;
          const okUnits = new Set();
          const lots = doc.lots.map(lot => {
            const amtPo = convertUnit(lot.amountRec, lot.idUnitRec, line.idUnitPO);
            if (amtPo === null) {
              lineUnitErrors++;
            } else {
              docPo += amtPo;
              okUnits.add(lot.idUnitRec);
            }
            ledgerSrc.push({ doc, lot, amtPo });
            return {
              lotNo: lot.lotNo, invName: lot.invName, ...lotDisp(lot),
              unitError: amtPo === null
            };
          });
          cumPo += docPo;

          // แสดงผลเป็นหน่วยรับ (ถ้าทุก Lot ในใบรับใช้หน่วยเดียวกัน) ไม่งั้นใช้หน่วย PO
          const dispUnit = forceKg ? 2 : (okUnits.size === 1 ? [...okUnits][0] : line.idUnitPO);
          const balancePo = poAmt - cumPo;
          return {
            seq: idx + 1, docRec: doc.docRec, docRef: doc.docRef, dateRec: doc.dateRec, lots,
            hasAmount: okUnits.size > 0,
            amount: round6(convertUnit(docPo, line.idUnitPO, dispUnit)),
            balance: round6(convertUnit(balancePo, line.idUnitPO, dispUnit)),
            unitId: dispUnit, unit: unitName(dispUnit),
            pct: poAmt > 0 ? round6(docPo / poAmt * 100) : null,
            cumPct: poAmt > 0 ? round6(cumPo / poAmt * 100) : null,
            unitErrors: lots.filter(l => l.unitError).length
          };
        });

      unitErrors += lineUnitErrors;
      const unitIds = new Set(receipts.filter(d => d.hasAmount).map(d => d.unitId));
      const dispUnitId = forceKg ? 2 : (unitIds.size === 1 ? [...unitIds][0] : line.idUnitPO);
      const pct = poAmt > 0 ? round6(cumPo / poAmt * 100) : null;

      // Stock Card ราย Lot: จำนวนรับ / คงเหลือ PO หลังรับ (หน่วยแสดงผลของบรรทัด) / % สะสม
      // Lot ที่หน่วยแปลงไม่ได้ = ไม่หักยอด แสดงจำนวนตามหน่วยรับเดิม + unitError
      let ledger;
      if (withLedger) {
        let run = 0;
        ledger = ledgerSrc.map(({ doc, lot, amtPo }) => {
          if (amtPo !== null) run += amtPo;
          return {
            dateRec: doc.dateRec, docRec: doc.docRec, docRef: doc.docRef, lotNo: lot.lotNo,
            qty: amtPo === null ? null : round6(convertUnit(amtPo, line.idUnitPO, dispUnitId) ?? amtPo),
            ...lotDisp(lot), unitError: amtPo === null,
            balance: round6(convertUnit(poAmt - run, line.idUnitPO, dispUnitId) ?? (poAmt - run)),
            cumPct: poAmt > 0 ? round6(run / poAmt * 100) : null
          };
        });
      }

      return {
        ...(ledger ? { ledger } : {}),
        cropId: line.cropId, cropName: line.cropName, invGroup: line.invGroup,
        idPODt: line.idPODt, idInvMain: line.idInvMain, invName: line.invName, idUnitPO: line.idUnitPO,
        amountPO: poAmt, unitPO: unitName(line.idUnitPO),
        unit: unitName(dispUnitId),
        amountPOInUnit: round6(convertUnit(poAmt, line.idUnitPO, dispUnitId) ?? poAmt),
        received: round6(convertUnit(cumPo, line.idUnitPO, dispUnitId) ?? cumPo),
        balance: round6(convertUnit(poAmt - cumPo, line.idUnitPO, dispUnitId) ?? (poAmt - cumPo)),
        receivedPO: round6(cumPo),
        pct, status: lineStatus(receipts.length, pct),
        unitErrors: lineUnitErrors, receipts
      };
    });

    // % รวมทั้ง PO: ถ้าทุกบรรทัดเป็น กรัม/กก. รวมเป็นกรัมแล้วคิด / ถ้ามีหน่วยอื่นปน ใช้ค่าเฉลี่ยของแต่ละบรรทัด
    let pct = null;
    const allGram = lines.length > 0 && lines.every(l => GRAM_FACTOR[l.idUnitPO]);
    if (allGram) {
      const poG = lines.reduce((s, l) => s + l.amountPO * GRAM_FACTOR[l.idUnitPO], 0);
      const recG = lines.reduce((s, l) => s + l.receivedPO * GRAM_FACTOR[l.idUnitPO], 0);
      pct = poG > 0 ? round6(recG / poG * 100) : null;
    } else {
      const ps = lines.filter(l => l.pct !== null).map(l => l.pct);
      pct = ps.length ? round6(ps.reduce((s, v) => s + v, 0) / ps.length) : null;
    }

    let status;
    // สถานะทั้ง PO: มีรายการรับเกิน 20% = over / ทุกรายการรับครบหรือเกินแล้ว: มีรายการเกิน = excess ไม่มี = complete
    if (lines.some(l => l.status === 'over')) status = 'over';
    else if (lines.every(l => l.status === 'pending')) status = 'pending';
    else if (lines.every(l => l.status === 'complete' || l.status === 'excess')) {
      status = lines.some(l => l.status === 'excess') ? 'excess' : 'complete';
    }
    else status = 'partial';

    const totalG = allGram ? {
      po: round6(lines.reduce((s, l) => s + l.amountPO * GRAM_FACTOR[l.idUnitPO], 0)),
      received: round6(lines.reduce((s, l) => s + l.receivedPO * GRAM_FACTOR[l.idUnitPO], 0))
    } : null;

    return {
      poCode: po.poCode, dateBuy: po.dateBuy, idSup: po.idSup, supName: po.supName,
      completed: po.completed, dateComplete: po.completed ? po.dateComplete : null, completeNote: po.completed ? po.completeNote : null,
      lineCount: lines.length, receiptCount: docIds.size, lastDateRec,
      pct, status, unitErrors, totalGram: totalG, lines
    };
  });

  return pos.sort((a, b) => new Date(b.dateBuy) - new Date(a.dateBuy) || String(b.poCode).localeCompare(String(a.poCode)));
}

// รายชื่อผู้ขาย (บริษัทในเครือ) สำหรับ combobox กรอง Supplier
app.get('/api/po-receive-affiliate/suppliers', requireMenu('po_receive_affiliate'), async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT idSup AS id, SupName AS name
       FROM PchInvAndProject.dbo.vSupplier
       WHERE idSup IN (${AFFILIATE_SUPPLIERS.join(',')})
       ORDER BY SupName`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('PO receive suppliers error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายชื่อผู้ขายไม่สำเร็จ', detail: err.message });
  }
});

// ประเภทพืชสำหรับ combobox กรอง (เฉพาะพืชที่มีใน PO ในเครือของบริษัทที่เลือก ทุกช่วงเวลา, กลุ่ม 1 + 42) + จำนวน PO
// otherCount = PO ที่มีบรรทัดกลุ่ม 1/42 แต่ผูกประเภทพืชไม่ได้ → หน้าเว็บแสดงตัวเลือก "ไม่ระบุประเภทพืช" (ปกติ = 0)
app.get('/api/po-receive-affiliate/crops', requireMenu('po_receive_affiliate', { companyParam: 'companyId' }), async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  if (!AFFILIATE_COMPANIES.includes(companyId)) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท' });
  }
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idComp', sql.Int, parseInt(companyId, 10))
      .query(`
        SELECT ${CROP_ID_SQL} AS id, MIN(sd.SeedName) AS name, COUNT(DISTINCT bmt.DocCode) AS poCount
        FROM devsk.PKPOBuyMt bmt
        JOIN devsk.PKPOBuyDt bdt ON bdt.idPOTs = bmt.idPOTs
        JOIN devsk.dInventoryMain ci ON bdt.idInvMain = ci.idInvMain
        ${CROP_JOIN_SQL}
        LEFT JOIN dbo.dSeed sd ON sd.idSeed = ${CROP_ID_SQL}
        WHERE bmt.idComp = @idComp
          AND bmt.idSup IN (${AFFILIATE_SUPPLIERS.join(',')})
          AND bmt.idPsCancel IS NULL AND bmt.stDel IS NULL
          AND ci.idInvGroup IN (${SEED_INV_GROUPS.join(',')})
        GROUP BY ${CROP_ID_SQL}`);
    const rows = result.recordset;
    const other = rows.find(r => r.id == null);
    res.json({
      success: true,
      data: rows.filter(r => r.id != null).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
      otherCount: other ? other.poCount : 0
    });
  } catch (err) {
    console.error('PO receive crops error:', err);
    res.status(500).json({ success: false, message: 'โหลดประเภทพืชไม่สำเร็จ', detail: err.message });
  }
});

// รายการแนะนำ PO สำหรับช่องเลือก PO No. ในแท็บ Stock Card (ค้นทุกช่วงเวลา จากเลขที่ PO หรือชื่อสินค้า, สูงสุด 20 ใบ)
app.get('/api/po-receive-affiliate/po-suggest', requireMenu('po_receive_affiliate', { companyParam: 'companyId' }), async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  const q = (req.query.q || '').trim();
  const supplierId = parseInt(req.query.supplierId, 10);

  if (!AFFILIATE_COMPANIES.includes(companyId)) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท' });
  }
  if (supplierId && !AFFILIATE_SUPPLIERS.includes(supplierId)) {
    return res.status(400).json({ success: false, message: 'ผู้ขายที่เลือกไม่ใช่บริษัทในเครือ' });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request()
      .input('idComp', sql.Int, parseInt(companyId, 10))
      .input('kw', sql.NVarChar, `%${q}%`)
      .input('kwStart', sql.NVarChar, `${q}%`);
    if (supplierId) request.input('idSup', sql.Int, supplierId);

    // จัดกลุ่มตามเลขที่ PO (เลขเดียวกันมีได้หลายเอกสาร) / เลขที่ PO ขึ้นต้นตรงกับคำค้นมาก่อน แล้วเรียงวันที่ล่าสุด
    const result = await request.query(`
      SELECT bmt.idPOTs, bmt.DocCode, bmt.DateBuyD, bmt.idSup, bmt.idPsComplete
      INTO #po
      FROM devsk.PKPOBuyMt bmt
      WHERE bmt.idComp = @idComp
        AND bmt.idSup IN (${AFFILIATE_SUPPLIERS.join(',')})
        AND bmt.idPsCancel IS NULL AND bmt.stDel IS NULL
        ${supplierId ? 'AND bmt.idSup = @idSup' : ''};

      SELECT TOP 20 p.DocCode AS poCode, MIN(p.DateBuyD) AS dateBuy, MIN(p.idSup) AS idSup, MIN(s.SupName) AS supName,
             CASE WHEN COUNT(p.idPsComplete) = COUNT(*) THEN 1 ELSE 0 END AS completed,
             (SELECT TOP 1 i.InvName FROM #po p2
                JOIN devsk.PKPOBuyDt d ON d.idPOTs = p2.idPOTs
                JOIN devsk.dInventoryMain i ON d.idInvMain = i.idInvMain
              WHERE p2.DocCode = p.DocCode AND i.idInvGroup IN (${SEED_INV_GROUPS.join(',')}) ORDER BY d.idPODt) AS invName,
             (SELECT COUNT(*) FROM #po p3 JOIN devsk.PKPOBuyDt d ON d.idPOTs = p3.idPOTs
                JOIN devsk.dInventoryMain i ON d.idInvMain = i.idInvMain
              WHERE p3.DocCode = p.DocCode AND i.idInvGroup IN (${SEED_INV_GROUPS.join(',')})) AS lineCount
      FROM #po p
      LEFT JOIN PchInvAndProject.dbo.vSupplier s ON p.idSup = s.idSup
      WHERE EXISTS (SELECT 1 FROM devsk.PKPOBuyDt d JOIN devsk.dInventoryMain i ON d.idInvMain = i.idInvMain
                    WHERE d.idPOTs = p.idPOTs AND i.idInvGroup IN (${SEED_INV_GROUPS.join(',')})
                      AND (p.DocCode LIKE @kw OR i.InvName LIKE @kw))
      GROUP BY p.DocCode
      ORDER BY MAX(CASE WHEN p.DocCode LIKE @kwStart THEN 1 ELSE 0 END) DESC, MIN(p.DateBuyD) DESC, p.DocCode DESC`);

    res.json({ success: true, data: result.recordset.map(r => ({ ...r, completed: !!r.completed })) });
  } catch (err) {
    console.error('PO suggest error:', err);
    res.status(500).json({ success: false, message: 'ค้นหา PO ไม่สำเร็จ', detail: err.message });
  }
});

// ดึงแถว PO ในเครือ (บรรทัด PO x รายการรับ) ตามเงื่อนไข — ใช้ร่วมกันระหว่างหน้ารายการ / Stock Card / วิเคราะห์
//   dStart/dEnd = ช่วงวันที่ออก PO (YYYYMMDD, ไม่ระบุ = ทุกช่วง) / poCode = PO ใบเดียว (ตรงตัว) / cropParam = idSeed หรือ 'other'
async function fetchAffiliatePoRows({ companyId, dStart = null, dEnd = null, supplierId = null, poCode = '', keyword = '', cropParam = '', cropId = null }) {
  const pool = await poolPromise;
  const request = pool.request().input('idComp', sql.Int, parseInt(companyId, 10));

  const filters = [];
  if (dStart) {
    request.input('dStart', sql.VarChar, dStart).input('dEnd', sql.VarChar, dEnd);
    filters.push('AND bmt.DateBuyD >= @dStart AND bmt.DateBuyD < @dEnd');
  }
  if (supplierId) {
    request.input('idSup', sql.Int, supplierId);
    filters.push('AND bmt.idSup = @idSup');
  }
  if (poCode) {
    request.input('poCode', sql.NVarChar, poCode);
    filters.push('AND bmt.DocCode = @poCode');
  }

  // ขั้นที่ 1: PO ที่อยู่ในขอบเขต (บริษัท / ผู้ขายในเครือ / ช่วงวันที่ / Supplier) ลง #po ก่อน — ชุดเล็ก (หลักพันใบ)
  // ขั้นที่ 2 (มีคำค้นหา): ค้นเฉพาะภายใน #po จาก เลขที่ PO / ชื่อสินค้าใน PO / เลข Lot / เลขที่ใบรับ
  //   (เดิมใช้ EXISTS ต่อแถว ทำให้สแกนตารางใบรับทั้งตาราง ~6 วินาที)
  let keywordSql = '';
  if (keyword && !poCode) {
    request.input('kw', sql.NVarChar, `%${keyword}%`);
    keywordSql = `
    SELECT p.idPOTs INTO #kw FROM #po p WHERE p.DocCode LIKE @kw
    UNION
    SELECT bdt.idPOTs FROM #po p
    JOIN devsk.PKPOBuyDt bdt ON bdt.idPOTs = p.idPOTs
    JOIN devsk.dInventoryMain i ON bdt.idInvMain = i.idInvMain
    WHERE i.InvName LIKE @kw
    UNION
    SELECT bdt.idPOTs FROM #po p
    JOIN devsk.PKPOBuyDt bdt ON bdt.idPOTs = p.idPOTs
    JOIN devsk.PKPoRecDt dt ON dt.idPODt = bdt.idPODt
    JOIN devsk.PKPoRecMt mt ON dt.idPkPORec = mt.idPkPORec AND mt.idPsCancel IS NULL
    LEFT JOIN devsk.dInvLotMain l ON dt.idLotMain = l.idLot
    WHERE l.LotNo LIKE @kw OR dt.LotNo LIKE @kw OR mt.DocCode LIKE @kw;

    DELETE FROM #po WHERE idPOTs NOT IN (SELECT idPOTs FROM #kw);`;
  }

  // ขั้นที่ 3: บรรทัด PO ที่นำมาแสดง → #pl
  //   - เฉพาะเมล็ดพันธุ์วัตถุดิบ (idInvGroup 1) และเมล็ดดอกไม้แพ็คซองเล็ก (idInvGroup 42) — ตัดค่าบริการ/วัสดุ/ยา ฯลฯ ออก
  //   - เลือกประเภทพืช: เฉพาะบรรทัดของพืชนั้น (PO หลายสินค้า แสดง/คำนวณ % เฉพาะบรรทัดของพืชที่เลือก)
  //   แล้วตัด PO ที่ไม่เหลือบรรทัดออกจาก #po
  const useCrop = !poCode && (cropParam === 'other' || !!cropId);
  if (useCrop && cropId) request.input('cropId', sql.Int, cropId);
  const cropSql = `
    SELECT bdt.idPODt, bdt.idPOTs, ${CROP_ID_SQL} AS CropId INTO #pl FROM #po p
    JOIN devsk.PKPOBuyDt bdt ON bdt.idPOTs = p.idPOTs
    JOIN devsk.dInventoryMain ci ON bdt.idInvMain = ci.idInvMain
    ${CROP_JOIN_SQL}
    WHERE ci.idInvGroup IN (${SEED_INV_GROUPS.join(',')})
      ${useCrop ? (cropId ? 'AND ' + CROP_ID_SQL + ' = @cropId' : 'AND ' + CROP_ID_SQL + ' IS NULL') : ''};

    DELETE FROM #po WHERE idPOTs NOT IN (SELECT idPOTs FROM #pl);`;

  const result = await request.query(`
    SELECT bmt.idPOTs, bmt.DocCode
    INTO #po
    FROM devsk.PKPOBuyMt bmt
    WHERE bmt.idComp = @idComp
      AND bmt.idSup IN (${AFFILIATE_SUPPLIERS.join(',')})
      AND bmt.idPsCancel IS NULL AND bmt.stDel IS NULL
      ${filters.join('\n        ')};
    ${keywordSql}
    ${cropSql}

    SELECT bmt.DocCode AS POCode, bmt.DateBuyD, bmt.idSup, s.SupName,
           bmt.idPsComplete, bmt.DateComplete, bmt.CompleteNote,
           bdt.idPODt, bdt.idInvMain AS idInvMainPO, ipo.InvName AS InvNamePO, ipo.idInvGroup AS InvGroup, bdt.Amount AS AmountPO, bdt.idUnitNew AS idUnitPO, up.UnitName AS UnitPO,
           r.idPkPORecDt, r.idPkPORec, r.DocRec, r.DocRef, r.DateRec, r.LotNo, r.InvName, r.AmountRec, r.idUnitRec, r.UnitRec
    FROM devsk.PKPOBuyMt bmt
    JOIN devsk.PKPOBuyDt bdt ON bdt.idPOTs = bmt.idPOTs
    LEFT JOIN devsk.dInventoryMain ipo ON bdt.idInvMain = ipo.idInvMain
    LEFT JOIN devsk.dInvUnit up ON bdt.idUnitNew = up.idUnit
    LEFT JOIN PchInvAndProject.dbo.vSupplier s ON bmt.idSup = s.idSup
    LEFT JOIN (
      SELECT dt.idPkPORecDt, dt.idPkPORec, dt.idPODt, mt.DocCode AS DocRec, mt.DocRef, mt.DateRec,
             ISNULL(l.LotNo, dt.LotNo) AS LotNo, i.InvName, dt.AmountRec,
             dt.idUnitNew AS idUnitRec, ur.UnitName AS UnitRec
      FROM devsk.PKPoRecDt dt
      JOIN devsk.PKPoRecMt mt ON dt.idPkPORec = mt.idPkPORec AND mt.idPsCancel IS NULL
      LEFT JOIN devsk.dInvLotMain l ON dt.idLotMain = l.idLot
      LEFT JOIN devsk.dInventoryMain i ON l.idInvMain = i.idInvMain
      LEFT JOIN devsk.dInvUnit ur ON dt.idUnitNew = ur.idUnit
    ) r ON r.idPODt = bdt.idPODt
    WHERE bmt.idPOTs IN (SELECT idPOTs FROM #po)
    ORDER BY bmt.DateBuyD DESC, bmt.DocCode, bdt.idPODt, r.DateRec, r.idPkPORecDt;
    SELECT pl.idPODt, pl.CropId, sd.SeedName AS CropName FROM #pl pl LEFT JOIN dbo.dSeed sd ON sd.idSeed = pl.CropId;`);

  // กรองเฉพาะบรรทัดใน #pl ฝั่ง Node (JOIN #pl ใน query หลักทำให้ SQL Server เลือก plan ช้า ~6 วินาที)
  // + แนบประเภทพืช (CropId / CropName) ให้แต่ละบรรทัด
  const lineInfo = new Map(result.recordsets[1].map(r => [r.idPODt, r]));
  return result.recordsets[0].filter(r => lineInfo.has(r.idPODt))
    .map(r => { const li = lineInfo.get(r.idPODt); return { ...r, CropId: li.CropId, CropName: li.CropName }; });
}

// ==================================================================
// ---------- วิเคราะห์การรับเทียบ PO (แท็บ 3) ----------
// ==================================================================
// ปีตามวันที่ออก PO / ภาพรวม + Supplier นับเป็น "จำนวน PO / รายการ" (หน่วยกิโลกรัมกับซองรวมกันไม่ได้ / ไม่ใช้มูลค่าเงิน)
//   รับเกิน   = บรรทัดที่ % รับ >= 101 (excess + over)
//   ปิดขาดรับ = PO สิ้นสุดแล้ว (idPsComplete) แต่บรรทัดรับไม่ถึง 100%
// ประเภทพืช / สินค้า: แยกตามหน่วยด้วย (กิโลกรัม / ซอง) เพื่อรวมปริมาณได้
//   poRecQty  = ยอด PO รวมของรายการที่เริ่มรับแล้ว (ไม่นับรายการที่ยังไม่รับ — กัน % ต่ำเกินจริงจาก PO ค้างรับ)
//   excessQty = ผลรวมส่วนที่รับเกินของแต่ละรายการ (รับ - PO เฉพาะรายการที่รับเกิน — ไม่เอาที่รับขาดมาหักลบ)
//   excessPct = excessQty / poRecQty x 100
//   รายการที่หน่วย PO กับหน่วยรับคำนวณกันไม่ได้ (unitErrors) ไม่นำมารวมปริมาณ
const ANALYSIS_STATUSES = ['pending', 'partial', 'complete', 'excess', 'over'];
function analyzePoTree(pos) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const blank = () => ({
    poCount: 0, lineCount: 0, receivedLines: 0, fullLines: 0, overLines: 0, shortEndedLines: 0, endedCount: 0,
    status: Object.fromEntries(ANALYSIS_STATUSES.map(s => [s, 0]))
  });
  const qtyBlank = (unit) => ({ unit: unit || '-', poRecQty: 0, excessQty: 0, poCodes: new Set() });
  const total = blank();
  const bySup = new Map();
  const byCrop = new Map();
  const byInv = new Map();

  pos.forEach(po => {
    const sup = bySup.get(po.idSup) || bySup.set(po.idSup, { idSup: po.idSup, supName: po.supName, ...blank() }).get(po.idSup);
    [total, sup].forEach(t => {
      t.poCount++; t.status[po.status]++;
      if (po.completed) t.endedCount++;
    });
    po.lines.forEach(l => {
      const p = l.pct === null ? null : Math.round(l.pct * 10) / 10;
      const isOver = p !== null && p >= 101;
      const isShortEnded = po.completed && (p === null || p < 100);
      const received = l.receipts.length > 0;
      const qtyOk = received && !l.unitErrors;
      const cropKey = `${l.cropId ?? 'none'}|${l.unit}`;
      const crop = byCrop.get(cropKey) || byCrop.set(cropKey, { cropId: l.cropId, cropName: l.cropName || 'ไม่ระบุประเภทพืช', ...blank(), ...qtyBlank(l.unit) }).get(cropKey);
      const invKey = `${l.idInvMain ?? l.invName}|${l.unit}`;
      const inv = byInv.get(invKey) || byInv.set(invKey, { idInvMain: l.idInvMain, invName: l.invName || '-', cropName: l.cropName || null, ...blank(), ...qtyBlank(l.unit) }).get(invKey);
      [crop, inv].forEach(t => {
        t.poCodes.add(po.poCode);
        if (qtyOk) {
          t.poRecQty += l.amountPOInUnit;
          if (isOver) t.excessQty += Math.max(0, l.received - l.amountPOInUnit);
        }
      });
      [total, sup, crop, inv].forEach(t => {
        t.lineCount++;
        if (received) t.receivedLines++;
        if (p !== null && p >= 100) t.fullLines++;
        if (isOver) t.overLines++;
        if (isShortEnded) t.shortEndedLines++;
      });
    });
  });

  const fin = (t) => {
    t.receivedLinePct = t.lineCount > 0 ? r2(t.receivedLines / t.lineCount * 100) : null; // % รายการที่เริ่มรับแล้ว
    t.overLinePct = t.receivedLines > 0 ? r2(t.overLines / t.receivedLines * 100) : null;  // % รายการที่รับเกิน (ของรายการที่รับแล้ว)
    return t;
  };
  // ประเภทพืช / สินค้า: ปิดท้ายปริมาณ + ชื่อซ้ำหลายหน่วย → ต่อท้ายชื่อด้วยหน่วย
  const finQty = (map, nameKey) => {
    const list = [...map.values()].map(c => {
      const { poCodes, status, ...rest } = c;
      const t = fin({ ...rest, poCount: poCodes.size });
      t.poRecQty = r4(t.poRecQty);
      t.excessQty = r4(t.excessQty);
      t.excessPct = t.poRecQty > 0 ? r2(t.excessQty / t.poRecQty * 100) : null;
      return t;
    });
    const nameCount = {};
    list.forEach(t => { nameCount[t[nameKey]] = (nameCount[t[nameKey]] || 0) + 1; });
    list.forEach(t => { if (nameCount[t[nameKey]] > 1) t[nameKey] += ` (${t.unit})`; });
    return list;
  };
  return {
    total: fin(total),
    suppliers: [...bySup.values()].map(fin).sort((a, b) => b.poCount - a.poCount),
    crops: finQty(byCrop, 'cropName'),
    products: finQty(byInv, 'invName')   // สรุปรายสินค้า (idInvMain)
  };
}

app.get('/api/po-receive-affiliate/analysis', requireMenu('po_receive_affiliate', { companyParam: 'companyId' }), async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  const year = parseInt(req.query.year, 10);              // ค.ศ. / ไม่ระบุ = ทุกปี
  if (!AFFILIATE_COMPANIES.includes(companyId)) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท' });
  }
  try {
    const rows = await fetchAffiliatePoRows({
      companyId,
      dStart: year ? `${year}0101` : null,
      dEnd: year ? `${year + 1}0101` : null
    });
    const pos = buildPoReceiveTree(rows);
    res.json({ success: true, data: analyzePoTree(pos) });
  } catch (err) {
    console.error('PO receive analysis error:', err);
    res.status(500).json({ success: false, message: 'วิเคราะห์ข้อมูลไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/po-receive-affiliate', requireMenu('po_receive_affiliate', { companyParam: 'companyId' }), async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  const dateMode = (req.query.dateMode || 'all').trim(); // month | year | all
  const month = parseInt(req.query.month, 10);
  const year = parseInt(req.query.year, 10);             // ค.ศ. (แปลงจาก พ.ศ. ฝั่ง frontend ก่อนส่งมา)
  const supplierId = parseInt(req.query.supplierId, 10); // ไม่ระบุ = ทุกผู้ขายในเครือ
  const keyword = (req.query.keyword || '').trim();
  const poCode = (req.query.poCode || '').trim();        // ระบุ = ดู PO ใบเดียว (ตรงตัว ทุกช่วงเวลา) + ledger สำหรับแท็บ Stock Card
  const cropParam = (req.query.cropId || '').trim();     // ประเภทพืช (vSeedProduct.idSeed) / 'other' = สินค้าที่ไม่มีประเภทพืช / ว่าง = ทุกประเภท
  const cropId = parseInt(cropParam, 10);
  if (cropParam && cropParam !== 'other' && !cropId) {
    return res.status(400).json({ success: false, message: 'ระบุประเภทพืชไม่ถูกต้อง' });
  }

  if (!AFFILIATE_COMPANIES.includes(companyId)) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท (รายงานนี้ใช้ได้เฉพาะบริษัทที่กำหนด)' });
  }
  if (supplierId && !AFFILIATE_SUPPLIERS.includes(supplierId)) {
    return res.status(400).json({ success: false, message: 'ผู้ขายที่เลือกไม่ใช่บริษัทในเครือ' });
  }

  // ช่วงวันที่ PO แบบ [dStart, dEnd) รูปแบบ YYYYMMDD (ไม่ขึ้นกับ DATEFORMAT ของ session)
  const ymd = (y, m) => `${String(y).padStart(4, '0')}${String(m).padStart(2, '0')}01`;
  let dStart = null, dEnd = null;
  if (poCode) {
    // ดูราย PO: ไม่ใช้เงื่อนไขวันที่
  } else if (dateMode === 'month') {
    if (!month || month < 1 || month > 12 || !year) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุเดือนและปี' });
    }
    dStart = ymd(year, month);
    dEnd = month === 12 ? ymd(year + 1, 1) : ymd(year, month + 1);
  } else if (dateMode === 'year') {
    if (!year) return res.status(400).json({ success: false, message: 'กรุณาระบุปี' });
    dStart = ymd(year, 1);
    dEnd = ymd(year + 1, 1);
  } else if (dateMode !== 'all') {
    return res.status(400).json({ success: false, message: 'ระบุ dateMode ไม่ถูกต้อง (month/year/all)' });
  }

  try {
    const rows = await fetchAffiliatePoRows({ companyId, dStart, dEnd, supplierId, poCode, keyword, cropParam, cropId });

    res.json({ success: true, overPct: OVER_RECEIVE_PCT, data: buildPoReceiveTree(rows, { withLedger: !!poCode }) });
  } catch (err) {
    console.error('PO receive affiliate error:', err);
    res.status(500).json({ success: false, message: 'ดึงข้อมูลรายงานรับเมล็ดพันธุ์ไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- การลงเวลาเคลือบเมล็ด (SCoatingANDMixMt) ----------
// ==================================================================

const COATING_TABLE = 'SCoatingANDMixMt';

app.get('/api/coating/list', requireMenu('coating', { companyParam: 'companyId' }), async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  const status = (req.query.status || '').trim();
  const date = (req.query.date || '').trim();

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อน' });
  }

  let statusCondition = '';
  let topClause = '';
  let orderBy = 'mt.DateReq';
  let queueCondition = 'AND wmt.stUseCut = 1 AND mt.WAfter IS NULL';

  if (status === 'waiting') {
    statusCondition = 'AND mt.DateRmStart IS NULL';
  } else if (status === 'inprogress') {
    statusCondition = 'AND mt.DateRmStart IS NOT NULL AND mt.DateRmEnd IS NULL';
  } else if (status === 'done') {
    statusCondition = 'AND mt.DateRmStart IS NOT NULL AND mt.DateRmEnd IS NOT NULL';
    queueCondition = '';
    orderBy = 'mt.DateRmEnd DESC';
    if (date) {
      statusCondition += ' AND CAST(mt.DateRmEnd AS DATE) = @filterDate';
    } else {
      topClause = 'TOP 5';
    }
  } else {
    return res.status(400).json({ success: false, message: 'ระบุ status ไม่ถูกต้อง' });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request().input('companyId', sql.NVarChar, companyId);
    if (status === 'done' && date) request.input('filterDate', sql.Date, date);

    const result = await request.query(
      `SELECT ${topClause} mt.idRm, mt.DocCode, mt.DateDoc, mt.DateReq, mt.DateRm, s.SeedName, mt.Note, mt.StrMC, mt.WBefore,
              mt.WAfter, u.UnitName, mt.DateRmStart, mt.DateRmEnd
       FROM ${COATING_TABLE} mt
       LEFT JOIN devsk.WimWaitCutMt wmt ON mt.idRm = wmt.idMt AND wmt.ProcessID = 12
       LEFT JOIN dbo.dSeed s ON mt.idSeed = s.idSeed
       LEFT JOIN devsk.dInvUnit u ON mt.idUnit = u.idUnit
       WHERE mt.idPsCancel IS NULL AND mt.idComp = @companyId AND mt.TypeRm IS NULL
         ${queueCondition}
         ${statusCondition}
       ORDER BY ${orderBy}`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Coating list error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการไม่สำเร็จ', detail: err.message });
  }
});

app.post('/api/coating/start', requireMenu('coating'), async (req, res) => {
  const { idRm } = req.body;
  const idPs = req.idPs; // ผู้บันทึก = ผู้ที่ login อยู่ (ไม่ใช้ค่าที่หน้าเว็บส่งมา)
  if (!idRm) return res.status(400).json({ success: false, message: 'ไม่พบรายการที่ต้องการ' });

  try {
    const pool = await poolPromise;
    const request = pool.request().input('idRm', sql.Int, idRm);

    let setClause = 'DateRmStart = GETDATE()';
    if (idPs) {
      request.input('idPs', sql.Int, Number(idPs));
      setClause += ', idPsDateRmStart = @idPs';
    }

    const result = await request
      .query(`UPDATE ${COATING_TABLE} SET ${setClause} WHERE idRm = @idRm ${compFilter(req.access, request, 'idComp')} AND DateRmStart IS NULL`);

    if (result.rowsAffected[0] === 0) {
      return res.status(409).json({ success: false, message: 'รายการนี้ถูกลงเวลาเริ่มไปแล้ว หรือไม่พบรายการ' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Coating start error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเวลาเริ่มไม่สำเร็จ', detail: err.message });
  }
});

app.post('/api/coating/end', requireMenu('coating'), async (req, res) => {
  const { idRm } = req.body;
  const idPs = req.idPs; // ผู้บันทึก = ผู้ที่ login อยู่ (ไม่ใช้ค่าที่หน้าเว็บส่งมา)
  if (!idRm) return res.status(400).json({ success: false, message: 'ไม่พบรายการที่ต้องการ' });

  try {
    const pool = await poolPromise;
    const request = pool.request().input('idRm', sql.Int, idRm);

    let setClause = 'DateRmEnd = GETDATE()';
    if (idPs) {
      request.input('idPs', sql.Int, Number(idPs));
      setClause += ', idPsDateRmEnd = @idPs';
    }

    const result = await request
      .query(`UPDATE ${COATING_TABLE} SET ${setClause} WHERE idRm = @idRm ${compFilter(req.access, request, 'idComp')} AND DateRmStart IS NOT NULL AND DateRmEnd IS NULL`);

    if (result.rowsAffected[0] === 0) {
      return res.status(409).json({ success: false, message: 'รายการนี้ยังไม่ได้เริ่ม หรือถูกลงเวลาสิ้นสุดไปแล้ว' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Coating end error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเวลาสิ้นสุดไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- การลงเวลาลดความชื้น ----------
// ==================================================================

const COL_ROOM = 'idHumidRoom';
const COL_TEMP = 'TempOfRoom';
const COL_HUMID = 'HumidOfRoom';
const COL_PS_HM_START = 'idPsDateRdHmS';
const COL_PS_HM_END = 'idPsDateRdHmE';
const COL_MC_AFTER = 'Humid';

app.get('/api/moisture/rooms', requireMenu('moisture', { companyParam: 'companyId' }), async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อน' });
  }
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('companyId', sql.NVarChar, companyId)
      .query(
        `SELECT idRoom AS id, RoomName AS name
         FROM devsk.SeedReduceHmRoom
         WHERE idComp = @companyId AND stDel IS NULL
         ORDER BY RoomName`
      );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Moisture rooms error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลห้องไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/moisture/list', requireMenu('moisture', { companyParam: 'companyId' }), async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  const status = (req.query.status || '').trim();
  const date = (req.query.date || '').trim();

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อน' });
  }

  let statusCondition = '';
  let topClause = '';
  let orderBy = 'mt.DateReq';
  let queueCondition = 'AND wmt.stUseCut = 1 AND mt.WAfter IS NULL';

  if (status === 'waiting') {
    statusCondition = 'AND mt.DateRdHmS IS NULL';
  } else if (status === 'inprogress') {
    statusCondition = 'AND mt.DateRdHmS IS NOT NULL AND mt.DateRdHmE IS NULL';
  } else if (status === 'done') {
    statusCondition = 'AND mt.DateRdHmS IS NOT NULL AND mt.DateRdHmE IS NOT NULL';
    queueCondition = '';
    orderBy = 'mt.DateRdHmE DESC';
    if (date) {
      statusCondition += ' AND CAST(mt.DateRdHmE AS DATE) = @filterDate';
    } else {
      topClause = 'TOP 5';
    }
  } else {
    return res.status(400).json({ success: false, message: 'ระบุ status ไม่ถูกต้อง' });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request().input('companyId', sql.NVarChar, companyId);
    if (status === 'done' && date) request.input('filterDate', sql.Date, date);

    const result = await request.query(
      `SELECT ${topClause} mt.idRm, mt.DocCode, mt.DateDoc, mt.DateReq, mt.DateRm, s.SeedName, mt.Note, mt.StrMC, mt.WBefore,
              mt.WAfter, u.UnitName, mt.DateRdHmS, mt.DateRdHmE,
              mt.${COL_TEMP} AS Temp, mt.${COL_HUMID} AS Humidity, r.RoomName,
              mt.${COL_MC_AFTER} AS MCAfter
       FROM ${COATING_TABLE} mt
       LEFT JOIN devsk.WimWaitCutMt wmt ON mt.idRm = wmt.idMt AND wmt.ProcessID = 12
       LEFT JOIN dbo.dSeed s ON mt.idSeed = s.idSeed
       LEFT JOIN devsk.dInvUnit u ON mt.idUnit = u.idUnit
       LEFT JOIN devsk.SeedReduceHmRoom r ON mt.${COL_ROOM} = r.idRoom
       WHERE mt.idPsCancel IS NULL AND mt.idComp = @companyId AND mt.TypeRm IS NULL
         ${queueCondition}
         ${statusCondition}
       ORDER BY ${orderBy}`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Moisture list error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการไม่สำเร็จ', detail: err.message });
  }
});

app.post('/api/moisture/start', requireMenu('moisture'), async (req, res) => {
  const { idRm, roomId, temp, humidity } = req.body;
  const idPs = req.idPs;

  if (!idRm || !roomId || temp === undefined || temp === '' || humidity === undefined || humidity === '') {
    return res.status(400).json({ success: false, message: 'กรุณาระบุห้อง อุณหภูมิ และความชื้นให้ครบ' });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request()
      .input('idRm', sql.Int, idRm)
      .input('roomId', sql.NVarChar, String(roomId))
      .input('temp', sql.Decimal(10, 2), Number(temp))
      .input('humidity', sql.Decimal(10, 2), Number(humidity));

    let setClause = `DateRdHmS = GETDATE(), ${COL_ROOM} = @roomId, ${COL_TEMP} = @temp, ${COL_HUMID} = @humidity`;
    if (idPs) {
      request.input('idPs', sql.Int, Number(idPs));
      setClause += `, ${COL_PS_HM_START} = @idPs`;
    }

    const result = await request
      .query(`UPDATE ${COATING_TABLE} SET ${setClause} WHERE idRm = @idRm ${compFilter(req.access, request, 'idComp')} AND DateRdHmS IS NULL`);

    if (result.rowsAffected[0] === 0) {
      return res.status(409).json({ success: false, message: 'รายการนี้ถูกลงเวลาเริ่มไปแล้ว หรือไม่พบรายการ' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Moisture start error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเวลาเริ่มไม่สำเร็จ', detail: err.message });
  }
});

app.post('/api/moisture/end', requireMenu('moisture'), async (req, res) => {
  const { idRm, humidAfter } = req.body;
  const idPs = req.idPs;

  if (!idRm) return res.status(400).json({ success: false, message: 'ไม่พบรายการที่ต้องการ' });
  if (humidAfter === undefined || humidAfter === null || humidAfter === '') {
    return res.status(400).json({ success: false, message: 'กรุณาระบุความชื้นหลังจัดการ' });
  }

  try {
    const pool = await poolPromise;
    const request = pool.request()
      .input('idRm', sql.Int, idRm)
      .input('humidAfter', sql.Decimal(10, 2), Number(humidAfter));

    let setClause = `DateRdHmE = GETDATE(), ${COL_MC_AFTER} = @humidAfter`;
    if (idPs) {
      request.input('idPs', sql.Int, Number(idPs));
      setClause += `, ${COL_PS_HM_END} = @idPs`;
    }

    const result = await request
      .query(`UPDATE ${COATING_TABLE} SET ${setClause} WHERE idRm = @idRm ${compFilter(req.access, request, 'idComp')} AND DateRdHmS IS NOT NULL AND DateRdHmE IS NULL`);

    if (result.rowsAffected[0] === 0) {
      return res.status(409).json({ success: false, message: 'รายการนี้ยังไม่ได้เริ่ม หรือถูกลงเวลาสิ้นสุดไปแล้ว' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Moisture end error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเวลาสิ้นสุดไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- ระบบกำหนดสิทธิ์การเข้าถึงเมนู ----------
// ==================================================================

app.get('/api/permissions/menus', requireMenu(MENU_ADMIN), async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT idMenu, MenuCode, MenuName, MenuUrl, idParentMenu, SortOrder, CAST(ISNULL(stWip, 0) AS bit) AS stWip
       FROM WIMWebMenu
       WHERE stDel IS NULL
       ORDER BY SortOrder, idMenu`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Permissions menus error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการเมนูไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/usergroups', requireMenu(MENU_ADMIN), async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT g.idGroup, g.GroupName, g.stSystem,
              (SELECT COUNT(*) FROM WIMWebUserGroupMember m WHERE m.idGroup = g.idGroup AND m.stDel IS NULL) AS memberCount
       FROM WIMWebUserGroup g
       WHERE g.stDel IS NULL
       ORDER BY g.stSystem DESC, g.GroupName`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Usergroups list error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการกลุ่มไม่สำเร็จ', detail: err.message });
  }
});

app.post('/api/usergroups', requireMenu(MENU_ADMIN), async (req, res) => {
  const { groupName } = req.body;
  if (!groupName || !groupName.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อกลุ่ม' });
  }
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('groupName', sql.NVarChar, groupName.trim())
      .query(`INSERT INTO WIMWebUserGroup (GroupName) OUTPUT INSERTED.idGroup VALUES (@groupName)`);
    res.json({ success: true, idGroup: result.recordset[0].idGroup });
  } catch (err) {
    console.error('Usergroups create error:', err);
    res.status(500).json({ success: false, message: 'สร้างกลุ่มไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/usergroups/:idGroup/members', requireMenu(MENU_ADMIN), async (req, res) => {
  const idGroup = parseInt(req.params.idGroup, 10);
  if (!idGroup) return res.status(400).json({ success: false, message: 'idGroup ไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idGroup', sql.Int, idGroup)
      .query(
        `SELECT m.idPs,v.PsName, v.PositionName, v.CompName, v.CompCode
         FROM WIMWebUserGroupMember m
         JOIN devsk.vPersonxSelect v ON m.idPs = v.idPs
         WHERE m.idGroup = @idGroup AND m.stDel IS NULL
         ORDER BY v.PsName`
      );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Usergroup members error:', err);
    res.status(500).json({ success: false, message: 'โหลดสมาชิกกลุ่มไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/usergroups/available-users', requireMenu([MENU_ADMIN, 'urs_request', 'supplier_return', 'over_po_sale', 'over_po_sale_mailto', 'over_po_sale_buy']), async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  try {
    const pool = await poolPromise;
    const topClause = keyword ? 'TOP 50' : '';
    const result = await pool.request()
      .input('keyword', sql.NVarChar, `%${keyword}%`)
      .query(
        `SELECT ${topClause} v.idPs, v.PsName, v.PositionName, v.idComp, v.CompName, v.CompCode
         FROM devsk.vPersonxSelect v
         WHERE v.idstWork <> 4
           AND (v.PsName LIKE @keyword)
         ORDER BY v.PsName`
      );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Available users error:', err);
    res.status(500).json({ success: false, message: 'ค้นหาพนักงานไม่สำเร็จ', detail: err.message });
  }
});

app.post('/api/usergroups/:idGroup/members', requireMenu(MENU_ADMIN), async (req, res) => {
  const idGroup = parseInt(req.params.idGroup, 10);
  const { idPs } = req.body;
  if (!idGroup || !idPs) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });

  try {
    const pool = await poolPromise;
    await pool.request()
      .input('idPs', sql.Int, idPs)
      .query('DELETE FROM WIMWebUserGroupMember WHERE idPs = @idPs');

    await pool.request()
      .input('idPs', sql.Int, idPs)
      .input('idGroup', sql.Int, idGroup)
      .query('INSERT INTO WIMWebUserGroupMember (idPs, idGroup) VALUES (@idPs, @idGroup)');

    clearAccessCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ success: false, message: 'เพิ่มสมาชิกไม่สำเร็จ', detail: err.message });
  }
});

app.delete('/api/usergroups/:idGroup/members/:idPs', requireMenu(MENU_ADMIN), async (req, res) => {
  const idGroup = parseInt(req.params.idGroup, 10);
  const idPs = parseInt(req.params.idPs, 10);
  if (!idGroup || !idPs) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });

  try {
    const pool = await poolPromise;
    await pool.request()
      .input('idPs', sql.Int, idPs)
      .input('idGroup', sql.Int, idGroup)
      .query('DELETE FROM WIMWebUserGroupMember WHERE idPs = @idPs AND idGroup = @idGroup');
    clearAccessCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ success: false, message: 'ลบสมาชิกไม่สำเร็จ', detail: err.message });
  }
});

app.get('/api/usergroups/:idGroup/permissions', requireMenu(MENU_ADMIN), async (req, res) => {
  const idGroup = parseInt(req.params.idGroup, 10);
  if (!idGroup) return res.status(400).json({ success: false, message: 'idGroup ไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idGroup', sql.Int, idGroup)
      .query(`SELECT idMenu FROM WIMWebMenuPermission WHERE idGroup = @idGroup AND stAllow = 1 AND stDel IS NULL`);
    res.json({ success: true, data: result.recordset.map(r => r.idMenu) });
  } catch (err) {
    console.error('Get group permissions error:', err);
    res.status(500).json({ success: false, message: 'โหลดสิทธิ์กลุ่มไม่สำเร็จ', detail: err.message });
  }
});

app.post('/api/usergroups/:idGroup/permissions', requireMenu(MENU_ADMIN), async (req, res) => {
  const idGroup = parseInt(req.params.idGroup, 10);
  const { menuIds } = req.body;
  const idPsCreate = req.idPs;
  if (!idGroup) return res.status(400).json({ success: false, message: 'idGroup ไม่ถูกต้อง' });
  if (!Array.isArray(menuIds)) return res.status(400).json({ success: false, message: 'รูปแบบข้อมูลไม่ถูกต้อง' });

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    await new sql.Request(transaction)
      .input('idGroup', sql.Int, idGroup)
      .query('DELETE FROM WIMWebMenuPermission WHERE idGroup = @idGroup');

    for (const idMenu of menuIds) {
      const req2 = new sql.Request(transaction)
        .input('idGroup', sql.Int, idGroup)
        .input('idMenu', sql.Int, idMenu);
      if (idPsCreate) req2.input('idPsCreate', sql.Int, idPsCreate);
      // เมนู On process (stWip = 1) ให้สิทธิ์ไม่ได้ — ข้ามไป (กันกรณีส่งมาตรงๆ ไม่ผ่านหน้ากำหนดสิทธิ์)
      await req2.query(
        `INSERT INTO WIMWebMenuPermission (idGroup, idMenu, stAllow${idPsCreate ? ', idPsCreate' : ''})
         SELECT @idGroup, idMenu, 1${idPsCreate ? ', @idPsCreate' : ''}
         FROM WIMWebMenu WHERE idMenu = @idMenu AND ISNULL(stWip, 0) = 0`
      );
    }

    await transaction.commit();
    clearAccessCache();
    res.json({ success: true });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Save group permissions error:', err);
    res.status(500).json({ success: false, message: 'บันทึกสิทธิ์ไม่สำเร็จ', detail: err.message });
  }
});

// สิทธิ์เมนูของผู้ใช้ที่ login อยู่ (อ่าน idPs จาก session — ค่า idPs ใน query ที่หน้าเว็บเดิมส่งมาไม่ถูกใช้)
app.get('/api/permissions/my', requireLogin, async (req, res) => {
  try {
    const access = await getUserAccess(req.idPs);
    res.json({ success: true, unrestricted: access.unrestricted, allowedMenuCodes: [...access.menus], menuOrder: await getMenuOrderSafe(), wipMenuCodes: await getWipMenusSafe() });
  } catch (err) {
    console.error('Permissions my error:', err);
    res.status(500).json({ success: false, message: 'โหลดสิทธิ์การใช้งานไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- สิทธิ์บริษัทที่เข้าถึงได้ (ผูกกับกลุ่มผู้ใช้งาน เหมือนสิทธิ์เมนู) ----------
// ==================================================================

// ---------- บริษัทในระบบคำร้องขอเมล็ดพันธุ์เร่งด่วน (idComp 2, 3, 4) ----------
// ส่งครบทุกบริษัท พร้อม allowed = user มีสิทธิ์บริษัทนั้น (WIMWebGroupCompPer / กลุ่มระบบเห็นทุกบริษัท)
//   หน้าเว็บ: "บริษัทที่ส่งคำร้องขอ" + รายการคำร้อง = เฉพาะ allowed / "บริษัทต้นทาง" = เลือกได้ทุกบริษัท
const URS_COMPANY_IDS = [2, 3, 4];

// เช็คสิทธิ์บริษัทของเอกสารคำร้อง (idCompReq) ก่อนแก้ไข / ยกเลิก / ส่ง — กันเรียก API ตรงกับเอกสารของบริษัทที่ไม่มีสิทธิ์
async function requireUrsDocComp(req, res, next) {
  try {
    const idUrs = parseInt(req.params.idUrs, 10);
    if (!idUrs) return res.status(400).json({ success: false, message: 'idUrs ไม่ถูกต้อง' });
    const pool = await poolPromise;
    const r = await pool.request().input('idUrs', sql.Int, idUrs)
      .query('SELECT idCompReq FROM GR_Group.devsk.SeedUrgentReqMt WHERE idUrs = @idUrs');
    if (!r.recordset.length) return res.status(404).json({ success: false, message: 'ไม่พบเอกสารคำร้องขอ' });
    if (!hasComp(req.access, r.recordset[0].idCompReq)) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้' });
    }
    next();
  } catch (err) {
    console.error('URS doc company check error:', err);
    res.status(500).json({ success: false, message: 'ตรวจสอบสิทธิ์ไม่สำเร็จ', detail: err.message });
  }
}

app.get('/api/urs/companies', requireMenu('urs_request'), async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT idComp AS id, CompName AS name
       FROM PchInvAndProject.dbo.dCompany
       WHERE stDel IS NULL AND idComp IN (${URS_COMPANY_IDS.join(', ')})
       ORDER BY CompName`
    );
    res.json({ success: true, data: result.recordset.map(c => ({ ...c, allowed: hasComp(req.access, c.id) })) });
  } catch (err) {
    console.error('URS companies error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลบริษัทไม่สำเร็จ', detail: err.message });
  }
});

// ---------- รายการเมล็ดพันธุ์ให้เลือกใน popup (รหัสสินค้า / ประเภทพืช / ชื่อเมล็ดพันธุ์) ----------
// ดึงแค่ชื่อ ไม่รวมยอดสต๊อก เพื่อให้ popup เปิดเร็ว (ยอดคงเหลือดึงทีหลังเฉพาะตัวที่ถูกเลือก)
app.get('/api/urs/seeds', requireMenu('urs_request'), async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT i.idInvMain, i.InvCode, s.SeedName, i.InvName, i.idUnit
       FROM devsk.dInventoryMain i
       LEFT JOIN dbo.vSeedProduct s ON i.idSubType = s.idPd AND i.idInvGroup = 1
       WHERE i.idInvGroup = 1 AND i.stActive IS NULL
       ORDER BY i.InvName`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('URS seeds error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการเมล็ดพันธุ์ไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ยอดคงเหลือ AV / GR / FLO และหน่วย ของเมล็ดพันธุ์ตัวเดียว (เรียกตอนกดเลือกเมล็ดใน popup) ----------
app.get('/api/urs/seeds/:idInvMain/stock', requireMenu('urs_request'), async (req, res) => {
  const idInvMain = parseInt(req.params.idInvMain, 10);
  if (!idInvMain) return res.status(400).json({ success: false, message: 'idInvMain ไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idInvMain', sql.Int, idInvMain)
      .query(
        `WITH Stock_AV AS (
           SELECT lmx.idInvMain, SUM(whx.Amount) AS AmtStockAV
           FROM devsk.dInvLotRefWh whx WITH (NOLOCK)
           INNER JOIN devsk.dInvLotMain lmx WITH (NOLOCK) ON whx.idLot = lmx.idLot
           LEFT JOIN devsk.dInvLotQuality qx WITH (NOLOCK) ON lmx.idLot = qx.idLot AND qx.typeReturn = 0
           LEFT JOIN dbo.ssWarehouse s WITH (NOLOCK) ON whx.idWh = s.idWh
           WHERE lmx.idInvMain = @idInvMain
                 AND lmx.CompRec = 4 AND lmx.stDel IS NULL AND whx.Amount > 0 AND s.idParent0 <> 5503
                 AND ISNULL(qx.Grad,'') <> 'F' AND ISNULL(qx.gradeConfirm,'') <> 'F'
           GROUP BY lmx.idInvMain
         ),
         Stock_GRxFL AS (
           SELECT inv.idInvMain,
             SUM(CASE WHEN sbl.idCompb = 2
                      THEN (ISNULL(S1NOW,0)+ISNULL(WIP1,0)+ISNULL(Bake,0)+ISNULL(S2,0)+ISNULL(S3,0)+ISNULL(S4,0)+ISNULL(WIP4,0)+ISNULL(S5,0)+ISNULL(S6,0))
                      ELSE 0 END) AS AmtStockGR,
             SUM(CASE WHEN sbl.idCompb = 1
                      THEN (ISNULL(S1NOW,0)+ISNULL(WIP1,0)+ISNULL(Bake,0)+ISNULL(S2,0)+ISNULL(S3,0)+ISNULL(S4,0)+ISNULL(WIP4,0)+ISNULL(S5,0)+ISNULL(S6,0))
                      ELSE 0 END) AS AmtStockFL
           FROM dbo.vSsProductStoreBalance sbl WITH (NOLOCK)
           INNER JOIN devsk.dInventoryMain inv WITH (NOLOCK) ON sbl.idPd = inv.idSubType AND inv.idInvGroup = 1
           WHERE inv.idInvMain = @idInvMain AND sbl.idCompb IN (1,2) AND sbl.stApprove = 1
           GROUP BY inv.idInvMain
         )
         SELECT i.idInvMain,
                ISNULL(sav.AmtStockAV, 0) AS AmtStockAV,
                ISNULL(sgf.AmtStockGR, 0) AS AmtStockGR, ISNULL(sgf.AmtStockFL, 0) AS AmtStockFL, u.UnitName
         FROM devsk.dInventoryMain i WITH (NOLOCK)
         LEFT JOIN Stock_AV sav ON i.idInvMain = sav.idInvMain
         LEFT JOIN Stock_GRxFL sgf ON i.idInvMain = sgf.idInvMain
         LEFT JOIN devsk.dInvUnit u WITH (NOLOCK) ON i.idUnit = u.idUnit
         WHERE i.idInvMain = @idInvMain AND i.idInvGroup = 1 AND i.stActive IS NULL`
      );
    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบเมล็ดพันธุ์นี้' });
    }
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error('URS seed stock error:', err);
    res.status(500).json({ success: false, message: 'โหลดยอดคงเหลือไม่สำเร็จ', detail: err.message });
  }
});

// ---------- popup รายละเอียดยอดคงเหลือ AV (CompRec = 4) ----------
// ยอดสรุปแยกเกรด: A/B/C/D/F/ไม่มีผล ไม่นับคลัง 262 (QC01), 263 (คลังเสื่อมคุณภาพ), 5503 / Amt262, Amt263 = ยอดในคลังนั้นทุกเกรด
// เกรดจริงของ lot: GradeNameShort (เกรดยืนยัน) > gradeConfirm > Grad
app.get('/api/urs/seeds/:idInvMain/av-summary', requireMenu('urs_request'), async (req, res) => {
  const idInvMain = parseInt(req.params.idInvMain, 10);
  if (!idInvMain) return res.status(400).json({ success: false, message: 'idInvMain ไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idInvMain', sql.Int, idInvMain)
      .query(
        `DECLARE @tpb_Stock TABLE(
           idLot int, idParent0 int, idInvMain int, Amount decimal(20,6), idUnit int, Grade varchar(3)
         );

         INSERT INTO @tpb_Stock
         SELECT lm.idLot, s.idParent0, i.idInvMain, SUM(wh.Amount) AS Amount, i.idUnit,
                (CASE WHEN g.GradeNameShort IS NOT NULL THEN g.GradeNameShort
                      WHEN q.gradeConfirm IS NOT NULL THEN q.gradeConfirm
                      ELSE ISNULL(q.Grad,'') END) AS Grade
         FROM devsk.dInvLotRefWh wh WITH (NOLOCK)
         LEFT JOIN devsk.dInvLotMain lm WITH (NOLOCK) ON wh.idLot = lm.idLot
         LEFT JOIN devsk.dInvLotQuality q WITH (NOLOCK) ON lm.idLot = q.idLot AND q.typeReturn = 0
         LEFT JOIN devsk.dInventoryMain i WITH (NOLOCK) ON lm.idInvMain = i.idInvMain
         LEFT JOIN dbo.ssWarehouse s WITH (NOLOCK) ON wh.idWh = s.idWh
         LEFT JOIN devsk.dInvLotQualityGradeConfirm g WITH (NOLOCK) ON q.idGrade = g.idGrade
         WHERE lm.CompRec = 4 AND s.idParent0 <> 5503 AND lm.stDel IS NULL AND wh.Amount > 0 AND i.idInvMain = @idInvMain
         GROUP BY lm.idLot, s.idParent0, i.idInvMain, q.gradeConfirm, q.Grad, i.idUnit, g.GradeNameShort;

         SELECT i.idInvMain, u.UnitName,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock), 0) AS AmtTotal,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock WHERE Grade IN ('A','VG') AND idParent0 NOT IN (262,263,5503)), 0) AS AmtA,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock WHERE Grade IN ('B','GD') AND idParent0 NOT IN (262,263,5503)), 0) AS AmtB,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock WHERE Grade IN ('C','BL') AND idParent0 NOT IN (262,263,5503)), 0) AS AmtC,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock WHERE Grade IN ('D','UP') AND idParent0 NOT IN (262,263,5503)), 0) AS AmtD,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock WHERE Grade IN ('F','AC') AND idParent0 NOT IN (262,263,5503)), 0) AS AmtF,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock WHERE Grade = '' AND idParent0 NOT IN (262,263)), 0) AS AmtNon,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock WHERE idParent0 = 262), 0) AS Amt262,
                ISNULL((SELECT SUM(Amount) FROM @tpb_Stock WHERE idParent0 = 263), 0) AS Amt263
         FROM devsk.dInventoryMain i WITH (NOLOCK)
         LEFT JOIN devsk.dInvUnit u WITH (NOLOCK) ON i.idUnit = u.idUnit
         WHERE i.idInvMain = @idInvMain`
      );
    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบเมล็ดพันธุ์นี้' });
    }
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error('URS AV summary error:', err);
    res.status(500).json({ success: false, message: 'โหลดยอดคงเหลือแยกเกรดไม่สำเร็จ', detail: err.message });
  }
});

// เงื่อนไขของแต่ละเกรดใน popup AV (whitelist — ห้ามต่อ string จาก request ตรงๆ)
const AV_GRADE_FILTERS = {
  A:     "tb.idParent0 NOT IN (262,263,5503) AND tb.Grade IN ('A','VG')",
  B:     "tb.idParent0 NOT IN (262,263,5503) AND tb.Grade IN ('B','GD')",
  C:     "tb.idParent0 NOT IN (262,263,5503) AND tb.Grade IN ('C','BL')",
  D:     "tb.idParent0 NOT IN (262,263,5503) AND tb.Grade IN ('D','UP')",
  F:     "tb.idParent0 NOT IN (262,263,5503) AND tb.Grade IN ('F','AC')",
  NON:   "tb.idParent0 NOT IN (262,263,5503) AND tb.Grade = ''",
  '262': 'tb.idParent0 = 262', // รอผลคลัง QC01
  '263': 'tb.idParent0 = 263'  // คลังเสื่อมคุณภาพ
};

// ผลตรวจคุณภาพ: -1 = NN, -2 = WW, 0 = ว่าง, อื่นๆ = ตัวเลข #,##0.00
const avQtCol = (col) =>
  `ISNULL(CASE WHEN q.${col} = -1 THEN 'NN' WHEN q.${col} = -2 THEN 'WW'
               WHEN q.${col} = 0 THEN '' ELSE CAST(FORMAT(q.${col},'#,##0.00') AS varchar) END, '') AS ${col}`;

// ---------- popup AV: รายการ lot ของเกรดที่เลือก ----------
app.get('/api/urs/seeds/:idInvMain/av-lots', requireMenu('urs_request'), async (req, res) => {
  const idInvMain = parseInt(req.params.idInvMain, 10);
  const gradeFilter = AV_GRADE_FILTERS[req.query.grade];
  if (!idInvMain) return res.status(400).json({ success: false, message: 'idInvMain ไม่ถูกต้อง' });
  if (!gradeFilter) return res.status(400).json({ success: false, message: 'เกรดไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idInvMain', sql.Int, idInvMain)
      .query(
        `SELECT *
         FROM (SELECT wh.idRefLot, s.idParent0, l.idLot, l.LotNo, wh.AmtBfWaitCut AS Amount, (wh.AmtBfWaitCut - wh.Amount) AS AmountWait,
                      wh.Amount AS AmtBal, u.UnitName, s.short_lock AS WareHouseName,
                      (SELECT TOP 1 ISNULL(sp.SupName,' - ') FROM devsk.PkPORecMt mt WITH (NOLOCK)
                       LEFT JOIN devsk.PkPORecDt dt WITH (NOLOCK) ON mt.idPkPORec = dt.idPkPORec
                       LEFT JOIN PchInvAndProject.dbo.dSupplier sp WITH (NOLOCK) ON mt.idSup = sp.idSup
                       WHERE dt.idLotMain = l.idLot ORDER BY AmountRec DESC) AS SupName,
                      (SELECT TOP 1 CONVERT(varchar(10), DateRec, 23) FROM devsk.PkPORecMt mt WITH (NOLOCK)
                       LEFT JOIN devsk.PkPORecDt dt WITH (NOLOCK) ON mt.idPkPORec = dt.idPkPORec
                       WHERE dt.idLotMain = l.idLot ORDER BY DateRec) AS DateRec,
                      ${avQtCol('GrowSand')}, ${avQtCol('GrowPaper')}, ${avQtCol('GrowMedia')},
                      ${avQtCol('GrowAA')}, ${avQtCol('GrowTZ')}, ${avQtCol('Pure')}, ${avQtCol('PureGene')},
                      q.Humid, q.gradeConfirm, ISNULL(q.stConfirm,0) AS stConfirm, q.percConfirm, q.noteConfirm,
                      (SELECT TOP 1 CONVERT(varchar(10), qc.DateCheck, 23) FROM devsk.dInvLotQualityCheck qc WITH (NOLOCK)
                       LEFT JOIN devsk.dInvLotQuality qq WITH (NOLOCK) ON qc.idLotQt = qq.idLotQt
                       WHERE qq.idLot = l.idLot ORDER BY qc.DateCheck DESC) AS DateCheckLast,
                      (CASE WHEN g.GradeNameShort IS NOT NULL THEN g.GradeNameShort
                            WHEN q.gradeConfirm IS NOT NULL THEN q.gradeConfirm
                            ELSE ISNULL(q.Grad,'') END) AS Grade
               FROM devsk.vInvLotRefWh_RStock wh WITH (NOLOCK)
               LEFT JOIN devsk.dInvLotMain l WITH (NOLOCK) ON wh.idLot = l.idLot
               LEFT JOIN devsk.dInventoryMain i WITH (NOLOCK) ON l.idInvMain = i.idInvMain
               LEFT JOIN dbo.SsWareHouse s WITH (NOLOCK) ON wh.idWh = s.idWh
               LEFT JOIN devsk.dInvUnit u WITH (NOLOCK) ON wh.idUnit = u.idUnit
               LEFT JOIN devsk.dInvLotQuality q WITH (NOLOCK) ON l.idLot = q.idLot AND q.typeReturn = 0
               LEFT JOIN devsk.dInvLotQualityGradeConfirm g WITH (NOLOCK) ON q.idGrade = g.idGrade
               WHERE l.stDel IS NULL AND l.CompRec = 4 AND wh.AmtBfWaitCut > 0 AND i.idInvMain = @idInvMain
         ) AS tb
         WHERE ${gradeFilter}
         ORDER BY tb.DateRec, tb.LotNo`
      );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('URS AV lots error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการ lot ไม่สำเร็จ', detail: err.message });
  }
});

// ---------- popup รายละเอียดยอดคงเหลือ GR / FLO (idCompb: 2 = GR, 1 = FLO) ----------
const STORE_COMPB_IDS = [1, 2];

// ยอดสรุปแต่ละคลัง: คอลัมน์เดียวกับที่รวมเป็นยอด GR / FLO ในตาราง (vSsProductStoreBalance)
app.get('/api/urs/seeds/:idInvMain/store-summary', requireMenu('urs_request'), async (req, res) => {
  const idInvMain = parseInt(req.params.idInvMain, 10);
  const idCompb = parseInt(req.query.idCompb, 10);
  if (!idInvMain) return res.status(400).json({ success: false, message: 'idInvMain ไม่ถูกต้อง' });
  if (!STORE_COMPB_IDS.includes(idCompb)) return res.status(400).json({ success: false, message: 'idCompb ไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idInvMain', sql.Int, idInvMain)
      .input('idCompb', sql.Int, idCompb)
      .query(
        `SELECT ISNULL(SUM(sbl.S1NOW),0) AS S1NOW, ISNULL(SUM(sbl.WIP1),0) AS WIP1, ISNULL(SUM(sbl.Bake),0) AS Bake,
                ISNULL(SUM(sbl.S2),0) AS S2, ISNULL(SUM(sbl.S3),0) AS S3, ISNULL(SUM(sbl.S4),0) AS S4,
                ISNULL(SUM(sbl.WIP4),0) AS WIP4, ISNULL(SUM(sbl.S5),0) AS S5, ISNULL(SUM(sbl.S6),0) AS S6
         FROM dbo.vSsProductStoreBalance sbl WITH (NOLOCK)
         INNER JOIN devsk.dInventoryMain inv WITH (NOLOCK) ON sbl.idPd = inv.idSubType AND inv.idInvGroup = 1
         WHERE inv.idInvMain = @idInvMain AND sbl.idCompb = @idCompb AND sbl.stApprove = 1`
      );
    const d = result.recordset[0];
    d.AmtTotal = ['S1NOW', 'WIP1', 'Bake', 'S2', 'S3', 'S4', 'WIP4', 'S5', 'S6'].reduce((s, k) => s + (Number(d[k]) || 0), 0);
    d.UnitName = 'กิโลกรัม';
    res.json({ success: true, data: d });
  } catch (err) {
    console.error('URS store summary error:', err);
    res.status(500).json({ success: false, message: 'โหลดยอดคงเหลือแยกคลังไม่สำเร็จ', detail: err.message });
  }
});

// คลัง 1-5 + ระหว่างดำเนินการ: idQcLine ของแต่ละคลัง (ตรงกับนิยามคอลัมน์ใน vSsProductStoreBalance) — whitelist ห้ามต่อ string จาก request ตรงๆ
const STORE_QC_LINES = {
  S1: "('0')",           // คลัง 1 : รับเมล็ด (S1NOW)
  T1: "('T1')",          // อยู่ระหว่างลดความชื้น (WIP1)
  B1: "('B1')",          // อยู่ระหว่างส่งอบ (Bake)
  S2: "('2')",           // คลัง 2 : ดูดทำความสะอาด
  S3: "('3','3i','3o')", // คลัง 3 : คัดเมล็ด
  S4: "('4')",           // คลัง 4 : เคลือบ/รมยา
  W4: "('4w')",          // อยู่ระหว่างคัด (WIP4)
  S5: "('5')"            // คลัง 5 : รอรวม Lot
};

// ---------- popup GR / FLO: รายการกระสอบ (คลัง 1-5) หรือ lot (คลัง 6) ของคลังที่เลือก ----------
app.get('/api/urs/seeds/:idInvMain/store-lots', requireMenu('urs_request'), async (req, res) => {
  const idInvMain = parseInt(req.params.idInvMain, 10);
  const idCompb = parseInt(req.query.idCompb, 10);
  const store = String(req.query.store || '');
  if (!idInvMain) return res.status(400).json({ success: false, message: 'idInvMain ไม่ถูกต้อง' });
  if (!STORE_COMPB_IDS.includes(idCompb)) return res.status(400).json({ success: false, message: 'idCompb ไม่ถูกต้อง' });
  if (store !== 'S6' && !STORE_QC_LINES[store]) return res.status(400).json({ success: false, message: 'คลังไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const request = pool.request()
      .input('idInvMain', sql.Int, idInvMain)
      .input('idCompb', sql.Int, idCompb);

    // คลัง 6 : รอขาย = lot ที่ยังไม่ขาย (vSsLotMt) / คลังอื่น = แยกรายกระสอบ เพราะ Cost แต่ละกระสอบไม่เท่ากัน
    // ผลตรวจที่เป็น WW / NN / ว่าง แสดงเป็น 'รอผล'
    const waitCol = (col) =>
      `(CASE WHEN UPPER(l.${col}) = 'WW' OR UPPER(l.${col}) = 'NN' OR l.${col} = '' THEN 'รอผล' ELSE l.${col} END) AS ${col}`;
    const qaCols =
      `sr.per_mc, sr.per_pp, sr.avg_tsw, CONVERT(varchar(10), sr.G_Result_Date, 23) AS G_Result_Date,
       sr.per_first_germ, sr.per_germ, sr.supply_status_code, sr.remark_supply_status, sr.stock_status_name`;

    const query = store === 'S6'
      ? `SELECT l.idLot, l.LotCode_, l.WUpdate, 'กิโลกรัม' AS UnitName, l.Grad,
                ${waitCol('Grow')}, ${waitCol('AA')}, ${waitCol('TZ')}, ${waitCol('Humid')}, ${waitCol('Pure')},
                (CASE WHEN pu.stSuccess = 1 THEN pu.PercentPurity ELSE NULL END) AS PureSPA,
                CONVERT(varchar(10), pu.DateCheckRef, 23) AS DateCheckRef,
                ${qaCols}
         FROM dbo.vSsLotMt l WITH (NOLOCK)
         LEFT JOIN devsk.dInventoryMain inv WITH (NOLOCK) ON l.idPd = inv.idSubType AND inv.idInvGroup = 1
         LEFT JOIN QA.dbo.vExcelExportQualityWithRef sr WITH (NOLOCK) ON l.idLot = sr.id_spm AND sr.Stage_ID = 3 AND sr.supply_status_id IS NOT NULL
         OUTER APPLY (
           SELECT TOP 1 p.stSuccess, p.PercentPurity, p.DateCheckRef
           FROM devsk.PdIndexPurityCheckMt p WITH (NOLOCK)
           WHERE p.idLot = l.idLot AND p.stFail IS NULL
           ORDER BY p.idChkMt DESC
         ) pu
         WHERE l.idSale IS NULL AND l.idPsCancel IS NULL AND l.WUpdate > 0 AND l.SeedTypeName <> ''
               AND inv.idInvMain = @idInvMain AND l.stStock IS NULL AND l.idCompb = @idCompb
         ORDER BY l.LotCode_`
      : `SELECT j.idJobRecPack, j.idJobRec, j.JrCode, CONVERT(varchar(10), devsk.fncStrDateToDateTime(j.JrDate), 23) AS JrDate, j.PackCode,
                j.SeasonName, j.Kg_, 'กิโลกรัม' AS UnitName, j.FmName, j.ZoneName, j.Grow, j.Pure,
                (CASE WHEN pu.stSuccess = 1 THEN pu.PercentPurity ELSE NULL END) AS PureSPA,
                CONVERT(varchar(10), pu.DateCheckRef, 23) AS DateCheckRef,
                j.idJob, j.StrainCode, ${qaCols},
                ((j.PackKgStore * j.BuyPrice) / j.Kg_) AS Cost
         FROM dbo.vPdIndexJobRecPack j WITH (NOLOCK)
         LEFT JOIN devsk.dInventoryMain inv WITH (NOLOCK) ON j.idProduct = inv.idSubType AND inv.idInvGroup = 1
         LEFT JOIN QA.dbo.vExcelExportQualityWithRef sr WITH (NOLOCK) ON j.idJob = sr.id_spm AND sr.Stage_ID = 2 AND sr.supply_status_id IS NOT NULL
         OUTER APPLY (
           SELECT TOP 1 p.stSuccess, p.PercentPurity, p.DateCheckRef
           FROM devsk.PdIndexPurityCheckMt p WITH (NOLOCK)
           WHERE p.idJob = j.idJob AND p.stFail IS NULL
           ORDER BY p.idChkMt DESC
         ) pu
         WHERE j.stCancel IS NULL AND j.idCompb = @idCompb AND inv.idInvMain = @idInvMain
               AND j.idQcLine IN ${STORE_QC_LINES[store]}
         ORDER BY devsk.fncStrDateToDateTime(j.JrDate), j.JrCode, j.PackCode`;

    const result = await request.query(query);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('URS store lots error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการในคลังไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ออกเลขที่คำร้อง (DocReq) ตัวถัดไป: URQ{YY}{MM}/{0001} ----------
// YY = พ.ศ. 2 หลักท้าย, MM = เดือนที่ทำรายการ, running ต่อจาก DocReq ล่าสุดใน SeedUrgentReqMt
// รันแยกบริษัท (idCompReq) และเริ่ม 0001 ใหม่เมื่อขึ้นปีใหม่ (เดือนเปลี่ยน running ไม่รีเซ็ต)
// ต้องเรียกด้วย transaction เดียวกับที่ INSERT ตอนบันทึกคำร้อง: UPDLOCK/HOLDLOCK กันสองรายการพร้อมกันได้เลขซ้ำ
async function getNextUrsDocReq(transaction, idCompReq, date = new Date()) {
  const yy = String(date.getFullYear() + 543).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const result = await new sql.Request(transaction)
    .input('idCompReq', sql.Int, idCompReq)
    .input('yearPattern', sql.NVarChar, `URQ${yy}__/%`)
    .query(
      `SELECT MAX(TRY_CAST(RIGHT(DocReq, 4) AS INT)) AS lastRunning
       FROM GR_Group.devsk.SeedUrgentReqMt WITH (UPDLOCK, HOLDLOCK)
       WHERE idCompReq = @idCompReq AND DocReq LIKE @yearPattern`
    );
  const next = (result.recordset[0].lastRunning || 0) + 1;
  return `URQ${yy}${mm}/${String(next).padStart(4, '0')}`;
}

// ---------- ตรวจข้อมูลคำร้อง (ใช้ทั้งตอนสร้างและแก้ไข) -> { error } หรือ { idPsReq, idCompTarget, reasonReq, rows } ----------
function parseUrsRequestBody(body, idCompReq) {
  const { items } = body;
  const idPsReq = parseInt(body.idPsReq, 10);
  const idCompTarget = parseInt(body.idCompTarget, 10);
  const reasonReq = String(body.reasonReq || '').trim();
  const isISODate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime());

  if (!idPsReq) return { error: 'กรุณาเลือกผู้ร้องขอ' };
  // บริษัทต้นทาง: ต้องเป็นหนึ่งในบริษัทที่เหลือ (ไม่ใช่บริษัทที่ส่งคำร้องขอ)
  if (!URS_COMPANY_IDS.includes(idCompTarget) || idCompTarget === idCompReq) {
    return { error: 'กรุณาเลือกบริษัทต้นทาง (ต้องไม่ใช่บริษัทเดียวกับบริษัทที่ส่งคำร้องขอ)' };
  }
  if (!reasonReq) return { error: 'กรุณาระบุเหตุผล/สาเหตุที่ต้องการเร่งด่วน' };
  if (!Array.isArray(items) || items.length === 0) return { error: 'กรุณาเลือกเมล็ดพันธุ์อย่างน้อย 1 รายการ' };

  const rows = items.map(it => ({
    idInvMain: parseInt(it.idInvMain, 10),
    amountReq: Number(it.amountReq),
    idUnit: it.idUnit === null || it.idUnit === undefined ? null : parseInt(it.idUnit, 10),
    dateNeeded: it.dateNeeded
  }));
  for (const [i, r] of rows.entries()) {
    if (!r.idInvMain) return { error: `รายการที่ ${i + 1}: เมล็ดพันธุ์ไม่ถูกต้อง` };
    if (!(r.amountReq > 0)) return { error: `รายการที่ ${i + 1}: จำนวนที่ต้องการต้องมากกว่า 0` };
    if (!isISODate(r.dateNeeded)) return { error: `รายการที่ ${i + 1}: วันที่ต้องการใช้งานไม่ถูกต้อง` };
  }
  if (new Set(rows.map(r => r.idInvMain)).size !== rows.length) return { error: 'มีเมล็ดพันธุ์ซ้ำกันในคำร้อง' };
  return { idPsReq, idCompTarget, reasonReq, rows };
}

// ---------- บันทึกคำร้องขอเมล็ดพันธุ์เร่งด่วน (SeedUrgentReqMt + SeedUrgentReqDt) ----------
// ออกเลข DocReq + insert หัว + insert รายการ ใน transaction เดียว (พลาดขั้นไหน rollback ทั้งหมด)
// stReq (อยู่ที่ Dt) ไม่ใส่ค่า: NULL = Draft / DateReq = GETDATE() ณ ตอนบันทึก (เวลาเดียวกับ DateUpdate)
app.post('/api/urs/requests', requireMenu('urs_request', { companyParam: 'idCompReq' }), async (req, res) => {
  const idPsUpdate = req.session.user && parseInt(req.session.user.idPs, 10);
  if (!idPsUpdate) {
    return res.status(401).json({ success: false, message: 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
  }

  const idCompReq = parseInt(req.body.idCompReq, 10);
  if (!URS_COMPANY_IDS.includes(idCompReq)) return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทที่ส่งคำร้องขอ' });
  const parsed = parseUrsRequestBody(req.body, idCompReq);
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const { idPsReq, idCompTarget, reasonReq, rows } = parsed;

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    // วันที่ร้องขอ = เวลาของ DB ณ ตอนบันทึก (รับเป็นข้อความ yyyy-mm-dd เพื่อไม่ให้ timezone ทำวันเพี้ยน)
    const nowResult = await new sql.Request(transaction)
      .query(`SELECT GETDATE() AS now, CONVERT(char(10), GETDATE(), 23) AS today`);
    const { now, today } = nowResult.recordset[0];

    const lateIdx = rows.findIndex(r => r.dateNeeded < today);
    if (lateIdx !== -1) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `รายการที่ ${lateIdx + 1}: วันที่ต้องการใช้งานต้องไม่น้อยกว่าวันที่ร้องขอ` });
    }

    // ปี/เดือนของเลขเอกสารอิงจากวันที่ร้องขอ
    const [y, m, d] = today.split('-').map(Number);
    const docReq = await getNextUrsDocReq(transaction, idCompReq, new Date(y, m - 1, d));

    const mtResult = await new sql.Request(transaction)
      .input('now', sql.DateTime, now)
      .input('docReq', sql.NVarChar, docReq)
      .input('idPsReq', sql.Int, idPsReq)
      .input('idCompReq', sql.Int, idCompReq)
      .input('idCompTarget', sql.Int, idCompTarget)
      .input('reasonReq', sql.NVarChar, String(reasonReq).trim())
      .input('idPsUpdate', sql.Int, idPsUpdate)
      .query(
        `INSERT INTO GR_Group.devsk.SeedUrgentReqMt (DateReq, DocReq, idPsReq, idCompReq, idCompTarget, ReasonReq, idPsUpdate, DateUpdate)
         VALUES (@now, @docReq, @idPsReq, @idCompReq, @idCompTarget, @reasonReq, @idPsUpdate, @now);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS idUrs;`
      );
    const idUrs = mtResult.recordset[0].idUrs;

    for (const r of rows) {
      await new sql.Request(transaction)
        .input('idUrs', sql.Int, idUrs)
        .input('idInvMain', sql.Int, r.idInvMain)
        .input('amountReq', sql.Decimal(18, 6), r.amountReq)
        .input('idUnit', sql.Int, r.idUnit)
        .input('dateNeeded', sql.VarChar, r.dateNeeded)
        .query(
          `INSERT INTO GR_Group.devsk.SeedUrgentReqDt (idUrs, idInvMain, AmountReq, idUnit, DateNeeded)
           VALUES (@idUrs, @idInvMain, @amountReq, @idUnit, CONVERT(date, @dateNeeded, 23))`
        );
    }

    await transaction.commit();
    res.json({ success: true, idUrs, docReq });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (rollbackErr) {} }
    console.error('URS save request error:', err);
    res.status(500).json({ success: false, message: 'บันทึกคำร้องไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ล็อกหัวคำร้องแล้วเช็คว่ายังแก้ไข/ยกเลิกได้ (ต้องเรียกใน transaction) ----------
// ได้ = ยังไม่ถูกยกเลิก และยังไม่มีรายการไหนตอบกลับแล้ว (ทุกรายการเป็น Draft หรือ รอตอบกลับ)
// คืน { error, status } หรือ { mt, dts } (dts = รายการเดิมของเอกสาร)
async function lockEditableUrs(transaction, idUrs) {
  const mt = await new sql.Request(transaction)
    .input('idUrs', sql.Int, idUrs)
    .query(
      `SELECT idUrs, idCompReq, idPsCancel, CONVERT(char(10), DateReq, 23) AS DateReq
       FROM GR_Group.devsk.SeedUrgentReqMt WITH (UPDLOCK, HOLDLOCK) WHERE idUrs = @idUrs`
    );
  if (mt.recordset.length === 0) return { status: 404, error: 'ไม่พบคำร้องนี้' };
  if (mt.recordset[0].idPsCancel) return { status: 400, error: 'คำร้องนี้ถูกยกเลิกแล้ว' };
  // เฉพาะรายการที่ยังไม่ถูกยกเลิก (รายการ 'C' เป็นประวัติ ไม่นำมาคิด)
  const dt = await new sql.Request(transaction)
    .input('idUrs', sql.Int, idUrs)
    .input('stCancel', sql.VarChar(1), URS_ST_CANCEL)
    .query(
      `SELECT idUrsDt, idInvMain, stReq FROM GR_Group.devsk.SeedUrgentReqDt WITH (UPDLOCK, HOLDLOCK)
       WHERE idUrs = @idUrs AND ISNULL(stReq, '') <> @stCancel`
    );
  if (dt.recordset.some(d => d.stReq && d.stReq !== URS_ST_SENT)) {
    return { status: 400, error: 'คำร้องนี้มีการตอบกลับแล้ว จึงแก้ไข/ยกเลิกไม่ได้' };
  }
  return { mt: mt.recordset[0], dts: dt.recordset };
}

// ---------- แก้ไขคำร้อง (ได้เฉพาะ Draft / รอตอบกลับ) ----------
// แก้ได้: ผู้ร้องขอ, บริษัทต้นทาง, เหตุผล, รายการเมล็ด (เพิ่ม/ลบ/แก้จำนวน หน่วย วันที่ต้องการ)
// บริษัทที่ส่งคำร้องขอ + เลขที่ + วันที่ร้องขอ คงเดิม (เลขที่ running แยกตามบริษัท)
// สถานะคงเดิม: เอกสารที่ส่งแล้ว รายการที่เพิ่มใหม่จะเป็น "รอตอบกลับ" ทันที (ใช้ลิงก์ตอบกลับเดิม)
app.put('/api/urs/requests/:idUrs', requireMenu('urs_request'), requireUrsDocComp, async (req, res) => {
  const idPs = req.session.user && parseInt(req.session.user.idPs, 10);
  if (!idPs) return res.status(401).json({ success: false, message: 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
  const idUrs = parseInt(req.params.idUrs, 10);
  if (!idUrs) return res.status(400).json({ success: false, message: 'idUrs ไม่ถูกต้อง' });

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const lock = await lockEditableUrs(transaction, idUrs);
    if (lock.error) {
      await transaction.rollback();
      return res.status(lock.status).json({ success: false, message: lock.error });
    }
    const { mt, dts } = lock;

    const parsed = parseUrsRequestBody(req.body, mt.idCompReq);
    if (parsed.error) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: parsed.error });
    }
    const { idPsReq, idCompTarget, reasonReq, rows } = parsed;
    const lateIdx = rows.findIndex(r => r.dateNeeded < mt.DateReq);
    if (lateIdx !== -1) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `รายการที่ ${lateIdx + 1}: วันที่ต้องการใช้งานต้องไม่น้อยกว่าวันที่ร้องขอ` });
    }

    await new sql.Request(transaction)
      .input('idUrs', sql.Int, idUrs)
      .input('idPsReq', sql.Int, idPsReq)
      .input('idCompTarget', sql.Int, idCompTarget)
      .input('reasonReq', sql.NVarChar, reasonReq)
      .input('idPsUpdate', sql.Int, idPs)
      .query(
        `UPDATE GR_Group.devsk.SeedUrgentReqMt
         SET idPsReq = @idPsReq, idCompTarget = @idCompTarget, ReasonReq = @reasonReq,
             idPsUpdate = @idPsUpdate, DateUpdate = GETDATE()
         WHERE idUrs = @idUrs`
      );

    // รายการเดิมที่ยังไม่ยกเลิก (จับคู่ด้วย idInvMain — ไม่ซ้ำในเอกสาร): ไม่อยู่ในรายการใหม่ = ยกเลิก / อยู่ = แก้ / ใหม่ = เพิ่ม
    // ยกเลิก = ไม่ลบ row แต่ตั้ง stReq = 'C' + ผู้ลบ/เวลาลบ เก็บเป็นประวัติ (เพิ่มเมล็ดเดิมกลับมาทีหลัง = row ใหม่)
    const sent = dts.some(d => d.stReq === URS_ST_SENT);
    const keep = new Set(rows.map(r => r.idInvMain));
    for (const d of dts.filter(d => !keep.has(d.idInvMain))) {
      await new sql.Request(transaction)
        .input('idUrsDt', sql.Int, d.idUrsDt)
        .input('stCancel', sql.VarChar(1), URS_ST_CANCEL)
        .input('idPs', sql.Int, idPs)
        .query(
          `UPDATE GR_Group.devsk.SeedUrgentReqDt
           SET stReq = @stCancel, idPsDel = @idPs, DateDel = GETDATE()
           WHERE idUrsDt = @idUrsDt`
        );
    }
    for (const r of rows) {
      const old = dts.find(d => d.idInvMain === r.idInvMain);
      const request = new sql.Request(transaction)
        .input('idUrs', sql.Int, idUrs)
        .input('idInvMain', sql.Int, r.idInvMain)
        .input('amountReq', sql.Decimal(18, 6), r.amountReq)
        .input('idUnit', sql.Int, r.idUnit)
        .input('dateNeeded', sql.VarChar, r.dateNeeded);
      if (old) {
        await request.input('idUrsDt', sql.Int, old.idUrsDt).query(
          `UPDATE GR_Group.devsk.SeedUrgentReqDt
           SET AmountReq = @amountReq, idUnit = @idUnit, DateNeeded = CONVERT(date, @dateNeeded, 23)
           WHERE idUrsDt = @idUrsDt`
        );
      } else if (sent) {
        await request.input('stSent', sql.VarChar(1), URS_ST_SENT).input('idPs', sql.Int, idPs).query(
          `INSERT INTO GR_Group.devsk.SeedUrgentReqDt (idUrs, idInvMain, AmountReq, idUnit, DateNeeded, stReq, idPsSendReq, DateSentReq)
           VALUES (@idUrs, @idInvMain, @amountReq, @idUnit, CONVERT(date, @dateNeeded, 23), @stSent, @idPs, GETDATE())`
        );
      } else {
        await request.query(
          `INSERT INTO GR_Group.devsk.SeedUrgentReqDt (idUrs, idInvMain, AmountReq, idUnit, DateNeeded)
           VALUES (@idUrs, @idInvMain, @amountReq, @idUnit, CONVERT(date, @dateNeeded, 23))`
        );
      }
    }

    // ส่งไปแล้ว -> แจ้งเตือน Telegram ว่ามีการแก้ไข (ข้อความเดียวกับที่ให้คัดลอกไปวางใน LINE) — insert ไม่สำเร็จ = ยกเลิกการแก้ไขทั้งหมด
    let message = null;
    if (sent) {
      message = await buildUrsMessage(transaction, idUrs, ursReplyOrigin(req), true);
      await queueUrsNotify(transaction, message, idPs);
    }

    await transaction.commit();
    // notified = server insert LineNotify สำเร็จจริง (หน้าเว็บใช้ตัวนี้แจ้งผู้ใช้ ไม่เดาเอง)
    res.json({ success: true, idUrs, sent, message, notified: sent });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (rollbackErr) {} }
    console.error('URS edit request error:', err);
    res.status(500).json({ success: false, message: 'แก้ไขคำร้องไม่สำเร็จ (รวมถึงการแจ้งเตือน Telegram) — กรุณาลองใหม่อีกครั้ง', detail: err.message });
  }
});

// ---------- ยกเลิกคำร้อง (ได้เฉพาะ Draft / รอตอบกลับ) ----------
// Mt: ผู้ยกเลิก / เวลา / เหตุผล — Dt: ทุกรายการเป็น 'C' + ผู้ลบ / เวลาลบ (เอกสารจะไม่แสดงในรายการอีก)
app.post('/api/urs/requests/:idUrs/cancel', requireMenu('urs_request'), requireUrsDocComp, async (req, res) => {
  const idPs = req.session.user && parseInt(req.session.user.idPs, 10);
  if (!idPs) return res.status(401).json({ success: false, message: 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
  const idUrs = parseInt(req.params.idUrs, 10);
  if (!idUrs) return res.status(400).json({ success: false, message: 'idUrs ไม่ถูกต้อง' });
  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลที่ยกเลิก' });
  if (note.length > 1000) return res.status(400).json({ success: false, message: 'เหตุผลยาวเกิน 1000 ตัวอักษร' });

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const lock = await lockEditableUrs(transaction, idUrs);
    if (lock.error) {
      await transaction.rollback();
      return res.status(lock.status).json({ success: false, message: lock.error });
    }
    await new sql.Request(transaction)
      .input('idUrs', sql.Int, idUrs)
      .input('idPs', sql.Int, idPs)
      .input('note', sql.VarChar(1000), note)
      .input('stCancel', sql.VarChar(1), URS_ST_CANCEL)
      .query(
        `UPDATE GR_Group.devsk.SeedUrgentReqMt
         SET idPsCancel = @idPs, DateCancel = GETDATE(), CancelNote = @note
         WHERE idUrs = @idUrs;
         UPDATE GR_Group.devsk.SeedUrgentReqDt
         SET stReq = @stCancel, idPsDel = @idPs, DateDel = GETDATE()
         WHERE idUrs = @idUrs AND ISNULL(stReq, '') <> @stCancel;`
      );
    await transaction.commit();
    res.json({ success: true });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (rollbackErr) {} }
    console.error('URS cancel error:', err);
    res.status(500).json({ success: false, message: 'ยกเลิกคำร้องไม่สำเร็จ', detail: err.message });
  }
});

// ---------- รายการร้องขอ (แสดงเป็นรายเมล็ด = แถวของ SeedUrgentReqDt) ของบริษัทที่เลือก ----------
// สถานะ (stReq) อยู่ที่ Dt: NULL = Draft / ยอดคงเหลือ AV, GR, FLO คำนวณสด ณ ตอนเรียก
// รวมรายการที่ยกเลิกด้วย (stReq = 'C') ให้หน้าเว็บค้นย้อนหลังได้ — หน้าเว็บซ่อนไว้ แสดงเมื่อกดการ์ด "ยกเลิก"
//   ยกเลิกทั้งเอกสาร (Mt.idPsCancel) ถือเป็น 'C' ทุกรายการ / ผู้ยกเลิก-เวลา: Dt.idPsDel, DateDel (ไม่มีใช้ของ Mt)
//   CancelNote = เหตุผลยกเลิกทั้งเอกสาร (เมล็ดที่ถูกลบตอนแก้ไขไม่มีเหตุผล)
// เรียง: วันที่ร้องขอ (เก่า -> ใหม่) / วันเดียวกันเรียงตามเอกสาร (idUrs) แล้วตาม idUrsDt
//   (คั่นด้วย idUrs ให้รายการของเอกสารเดียวกันอยู่ติดกันเสมอ — เมล็ดที่เพิ่มตอนแก้ไขได้ idUrsDt ใหม่กว่าเอกสารอื่น)
app.get('/api/urs/requests', requireMenu('urs_request', { companyParam: 'idComp' }), async (req, res) => {
  const idComp = parseInt(req.query.idComp, 10);
  if (!URS_COMPANY_IDS.includes(idComp)) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท' });
  }

  try {
    const t0 = Date.now();
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idComp', sql.Int, idComp)
      .input('stCancel', sql.VarChar(1), URS_ST_CANCEL)
      .input('stDone', sql.VarChar(1), URS_ST_DONE)
      .query(
        `WITH Req AS (
           SELECT dt.idUrsDt, dt.idUrs, dt.idInvMain, dt.AmountReq, dt.idUnit, dt.DateNeeded,
                  CASE WHEN mt.idPsCancel IS NOT NULL THEN @stCancel ELSE dt.stReq END AS stReq,
                  dt.DateSentReq, dt.DateSent, dt.NotSentNote, dt.idPsReplied, dt.DateReplied,
                  ISNULL(dt.idPsDel, mt.idPsCancel) AS idPsDel, ISNULL(dt.DateDel, mt.DateCancel) AS DateDel,
                  CASE WHEN mt.idPsCancel IS NOT NULL THEN 1 ELSE 0 END AS DocCancelled, mt.CancelNote,
                  mt.DateReq, mt.DocReq, mt.idPsReq, mt.idCompReq, mt.idCompTarget, mt.ReasonReq
           FROM GR_Group.devsk.SeedUrgentReqDt dt
           INNER JOIN GR_Group.devsk.SeedUrgentReqMt mt ON dt.idUrs = mt.idUrs
           WHERE mt.idCompReq = @idComp
         ),
         -- คงเหลือ AV / GR / FLO คำนวณเฉพาะเมล็ดของรายการที่ยังดำเนินการ (ยกเลิก / จัดส่งครบแล้ว ไม่ต้องดูสต๊อก -> NULL)
         ReqOpen AS (
           SELECT DISTINCT idInvMain FROM Req WHERE ISNULL(stReq, '') NOT IN (@stCancel, @stDone)
         ),
         Stock_AV AS (
           SELECT lmx.idInvMain, SUM(whx.Amount) AS AmtStockAV
           FROM devsk.dInvLotRefWh whx WITH (NOLOCK)
           INNER JOIN devsk.dInvLotMain lmx WITH (NOLOCK) ON whx.idLot = lmx.idLot
           LEFT JOIN devsk.dInvLotQuality qx WITH (NOLOCK) ON lmx.idLot = qx.idLot AND qx.typeReturn = 0
           LEFT JOIN dbo.ssWarehouse s WITH (NOLOCK) ON whx.idWh = s.idWh
           WHERE lmx.idInvMain IN (SELECT idInvMain FROM ReqOpen)
                 AND lmx.CompRec = 4 AND lmx.stDel IS NULL AND whx.Amount > 0 AND s.idParent0 <> 5503
                 AND ISNULL(qx.Grad,'') <> 'F' AND ISNULL(qx.gradeConfirm,'') <> 'F'
           GROUP BY lmx.idInvMain
         ),
         Stock_GRxFL AS (
           SELECT inv.idInvMain,
             SUM(CASE WHEN sbl.idCompb = 2
                      THEN (ISNULL(S1NOW,0)+ISNULL(WIP1,0)+ISNULL(Bake,0)+ISNULL(S2,0)+ISNULL(S3,0)+ISNULL(S4,0)+ISNULL(WIP4,0)+ISNULL(S5,0)+ISNULL(S6,0))
                      ELSE 0 END) AS AmtStockGR,
             SUM(CASE WHEN sbl.idCompb = 1
                      THEN (ISNULL(S1NOW,0)+ISNULL(WIP1,0)+ISNULL(Bake,0)+ISNULL(S2,0)+ISNULL(S3,0)+ISNULL(S4,0)+ISNULL(WIP4,0)+ISNULL(S5,0)+ISNULL(S6,0))
                      ELSE 0 END) AS AmtStockFL
           FROM dbo.vSsProductStoreBalance sbl WITH (NOLOCK)
           INNER JOIN devsk.dInventoryMain inv WITH (NOLOCK) ON sbl.idPd = inv.idSubType AND inv.idInvGroup = 1
           WHERE inv.idInvMain IN (SELECT idInvMain FROM ReqOpen) AND sbl.idCompb IN (1,2) AND sbl.stApprove = 1
           GROUP BY inv.idInvMain
         )
         SELECT r.idUrsDt, r.idUrs, r.idCompReq, r.idCompTarget, ct.CompName AS CompNameTarget, r.DocReq, r.ReasonReq, r.stReq,
                CONVERT(char(10), r.DateReq, 23) AS DateReq,
                CONVERT(char(10), r.DateNeeded, 23) AS DateNeeded,
                r.idInvMain, i.InvName, sp.SeedName, r.AmountReq, r.idUnit, u.UnitName, r.idPsReq,
                CASE WHEN r.stReq IN (@stCancel, @stDone) THEN NULL ELSE ISNULL(sav.AmtStockAV, 0) END AS AmtStockAV,
                CASE WHEN r.stReq IN (@stCancel, @stDone) THEN NULL ELSE ISNULL(sgf.AmtStockGR, 0) END AS AmtStockGR,
                CASE WHEN r.stReq IN (@stCancel, @stDone) THEN NULL ELSE ISNULL(sgf.AmtStockFL, 0) END AS AmtStockFL,
                ps.PsName AS PsNameReq, c.CompName,
                CONVERT(varchar(16), r.DateSentReq, 120) AS DateSentReq,
                CONVERT(char(10), r.DateSent, 23) AS DateSent, r.NotSentNote,
                CONVERT(varchar(16), r.DateReplied, 120) AS DateReplied, pr.PsName AS PsNameReplied,
                CONVERT(varchar(16), r.DateDel, 120) AS DateDel, pd.PsName AS PsNameDel, r.DocCancelled, r.CancelNote
         FROM Req r
         LEFT JOIN devsk.dInventoryMain i WITH (NOLOCK) ON r.idInvMain = i.idInvMain
         LEFT JOIN dbo.vSeedProduct sp WITH (NOLOCK) ON i.idSubType = sp.idPd AND i.idInvGroup = 1
         LEFT JOIN devsk.dInvUnit u WITH (NOLOCK) ON r.idUnit = u.idUnit
         LEFT JOIN Stock_AV sav ON r.idInvMain = sav.idInvMain
         LEFT JOIN Stock_GRxFL sgf ON r.idInvMain = sgf.idInvMain
         LEFT JOIN PchInvAndProject.dbo.dCompany c WITH (NOLOCK) ON r.idCompReq = c.idComp
         LEFT JOIN PchInvAndProject.dbo.dCompany ct WITH (NOLOCK) ON r.idCompTarget = ct.idComp
         OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = r.idPsReq) ps
         OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = r.idPsReplied) pr
         OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = r.idPsDel) pd
         ORDER BY CONVERT(date, r.DateReq), r.idUrs, r.idUrsDt`
      );
    const rows = result.recordset;
    const t1 = Date.now();
    await applyUrsDelivered(pool, idComp, rows);
    // จับเวลาไว้ดูว่าส่วนไหนช้า: รายการ+คงเหลือ AV/GR/FLO vs ยอดรับเข้า+อัพเดตสถานะ
    console.log(`[URS list] idComp=${idComp} rows=${rows.length} list+stock=${t1 - t0}ms delivered=${Date.now() - t1}ms`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('URS request list error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการร้องขอไม่สำเร็จ', detail: err.message });
  }
});

// ---------- สถานะคำร้อง (SeedUrgentReqDt.stReq) ----------
// NULL = Draft / '1' = ส่งคำร้องแล้ว (รอตอบกลับ) / '2' = พร้อมส่ง / '3' = ไม่พร้อมส่ง (2, 3 = บริษัทต้นทางตอบกลับ)
// '4' = จัดส่งแล้วบางส่วน / '5' = จัดส่งครบแล้ว (ระบบตั้งให้จากยอดรับเข้า ตอนโหลดรายการ — ดู applyUrsDelivered)
// 'C' = ยกเลิก (ลบเมล็ดตอนแก้ไข หรือยกเลิกทั้งเอกสาร) + idPsDel / DateDel — เก็บเป็นประวัติ ไม่แสดง / ไม่ส่ง / ไม่ให้ตอบ
const URS_ST_SENT = '1';
const URS_ST_READY = '2';
const URS_ST_NOT_READY = '3';
const URS_ST_PARTIAL = '4';
const URS_ST_DONE = '5';
const URS_ST_CANCEL = 'C';

// ---------- จำนวนที่จัดส่งแล้ว / คงค้างจัดส่ง (คำนวณสดจากการรับเข้า PKPORec ของบริษัทที่ร้องขอ) ----------
// นับเฉพาะรายการที่ส่งคำร้องแล้ว (ไม่ใช่ Draft / ยกเลิก) / รับเข้าตั้งแต่วันที่ส่งคำร้อง (DateSentReq, รวมวันนั้น) / หน่วย kg
// เมล็ดเดียวกันหลายคำร้อง: ตัดยอดรับเข้าแบบ FIFO — แต่ละยอดรับเข้าตัดให้คำร้องที่ส่งก่อนวันรับ เรียงตามวันที่ส่งคำร้องเก่าสุดก่อน
//   ยอดเกินที่ไม่มีคำร้องรับ -> ใส่ให้คำร้องล่าสุดที่มีสิทธิ์ (ให้เห็นว่าจัดส่งเกิน)
// สถานะ: มียอดแต่ยังไม่ครบ = '4' จัดส่งบางส่วน / ครบ (>= จำนวนที่ต้องการ) = '5' จัดส่งครบแล้ว
//   UPDATE เฉพาะรายการที่สถานะเปลี่ยน: 1/2/3 -> 4/5, 4 <-> 5
//   ถอยกลับได้เมื่อใบรับถูกยกเลิก: 5 -> 4 (ยอดลดแต่ยังมี) / 4,5 -> สถานะตอบกลับเดิม 1/2/3 (ยอดเหลือ 0)
async function applyUrsDelivered(pool, idComp, rows) {
  rows.forEach(r => { r.AmtDelivered = 0; r.AmtRemain = Number(r.AmountReq) || 0; });
  const live = rows
    .filter(r => r.stReq && r.stReq !== URS_ST_CANCEL && r.DateSentReq && Number.isInteger(r.idInvMain))
    .sort((a, b) => a.DateSentReq.localeCompare(b.DateSentReq) || a.idUrsDt - b.idUrsDt);
  if (live.length === 0) return;

  const bySeed = new Map();
  live.forEach(r => {
    r.sentDate = r.DateSentReq.slice(0, 10);
    if (!bySeed.has(r.idInvMain)) bySeed.set(r.idInvMain, []);
    bySeed.get(r.idInvMain).push(r);
  });
  const fromDate = live.map(r => r.sentDate).sort()[0];

  const rec = await pool.request()
    .input('idComp', sql.Int, idComp)
    .input('fromDate', sql.VarChar(10), fromDate)
    .query(
      `SELECT dt.idInvMain, CONVERT(char(10), mt.DateRec, 23) AS DateRec,
              SUM(CASE WHEN dt.idUnitNew = 1 THEN (dt.AmountRec/1000)
                       WHEN dt.idUnitNew = 4 THEN ((dt.AmountRec*fr.WPerPack)/1000)
                       ELSE dt.AmountRec END) AS AmtRec
       FROM devsk.PKPORecDt dt WITH (NOLOCK)
       LEFT JOIN devsk.PkPORecMt mt WITH (NOLOCK) ON dt.idPkPoRec = mt.idPkPoRec
       LEFT JOIN devsk.dInventoryMain im WITH (NOLOCK) ON dt.idInvMain = im.idInvMain
       LEFT JOIN devsk.dSeedFlPackage fr WITH (NOLOCK) ON im.idSubType = fr.idFlPk AND im.idInvGroup = 42
       WHERE dt.idInvMain IN (${[...bySeed.keys()].join(', ')}) AND mt.idComp = @idComp
             AND mt.idPsCancel IS NULL AND mt.DateRec >= CONVERT(date, @fromDate, 23)
       GROUP BY dt.idInvMain, CONVERT(char(10), mt.DateRec, 23)
       ORDER BY dt.idInvMain, DateRec`
    );

  for (const rc of rec.recordset) {
    const eligible = (bySeed.get(rc.idInvMain) || []).filter(r => r.sentDate <= rc.DateRec);
    let left = Number(rc.AmtRec) || 0;
    if (eligible.length === 0 || left <= 0) continue;
    for (const r of eligible) {
      const take = Math.min(Math.max((Number(r.AmountReq) || 0) - r.AmtDelivered, 0), left);
      r.AmtDelivered += take;
      left -= take;
      if (left <= 0) break;
    }
    if (left > 0) eligible[eligible.length - 1].AmtDelivered += left;
  }

  // key = สถานะใหม่, value = แถวที่ต้องเปลี่ยน (เฉพาะที่สถานะต่างจากเดิม)
  const changes = new Map();
  live.forEach(r => {
    delete r.sentDate;
    const req = Number(r.AmountReq) || 0;
    r.AmtDelivered = Math.round(r.AmtDelivered * 1e6) / 1e6;
    r.AmtRemain = Math.max(Math.round((req - r.AmtDelivered) * 1e6) / 1e6, 0);
    const shipped = r.stReq === URS_ST_PARTIAL || r.stReq === URS_ST_DONE;
    let target;
    if (r.AmtDelivered >= req && r.AmtDelivered > 0) target = URS_ST_DONE;
    else if (r.AmtDelivered > 0) target = URS_ST_PARTIAL;
    else if (shipped) target = ursReplyStatus(r);   // ใบรับถูกยกเลิกจนยอดเป็น 0 -> ถอยกลับเป็นสถานะตอบกลับเดิม
    else return;                                     // 1/2/3 ที่ยังไม่มีการรับ: ไม่แตะ
    if (target === r.stReq) return;
    if (!changes.has(target)) changes.set(target, []);
    changes.get(target).push(r);
  });
  if (changes.size === 0) return;

  const stLive = ['1', '2', '3', URS_ST_PARTIAL, URS_ST_DONE].map(s => `'${s}'`).join(', ');
  await pool.request().query([...changes].map(([st, list]) =>
    `UPDATE GR_Group.devsk.SeedUrgentReqDt SET stReq = '${st}'
     WHERE idUrsDt IN (${list.map(r => r.idUrsDt).join(', ')}) AND stReq IN (${stLive});`).join('\n'));
  changes.forEach((list, st) => list.forEach(r => { r.stReq = st; }));
}

// คำนวณยอดจัดส่ง + อัพเดตสถานะ 4/5 ของทุกรายการในบริษัทที่ร้องขอ (FIFO ต้องเห็นทุกคำร้องของบริษัท)
// ใช้ในหน้าตอบกลับ ให้สถานะ "จัดส่งครบแล้ว" ล็อกทันที ไม่ต้องรอให้มีคนเปิดแท็บรายการ
// คืน Map idUrsDt -> { stReq, AmtDelivered, AmtRemain }
async function refreshUrsDelivered(pool, idComp) {
  const result = await pool.request()
    .input('idComp', sql.Int, idComp)
    .input('stCancel', sql.VarChar(1), URS_ST_CANCEL)
    .query(
      `SELECT dt.idUrsDt, dt.idInvMain, dt.AmountReq,
              CASE WHEN mt.idPsCancel IS NOT NULL THEN @stCancel ELSE dt.stReq END AS stReq,
              CONVERT(varchar(16), dt.DateSentReq, 120) AS DateSentReq,
              CONVERT(varchar(16), dt.DateReplied, 120) AS DateReplied, dt.NotSentNote
       FROM GR_Group.devsk.SeedUrgentReqDt dt
       INNER JOIN GR_Group.devsk.SeedUrgentReqMt mt ON dt.idUrs = mt.idUrs
       WHERE mt.idCompReq = @idComp`
    );
  const rows = result.recordset;
  await applyUrsDelivered(pool, idComp, rows);
  return new Map(rows.map(r => [r.idUrsDt, r]));
}

// สถานะก่อนจัดส่ง (ใช้ตอนถอยกลับจาก 4/5): ยังไม่ตอบ = '1' / ตอบไม่พร้อมส่ง (มีสาเหตุ) = '3' / ตอบพร้อมส่ง = '2'
// อ้างอิงจากข้อมูลการตอบกลับที่ยังเก็บไว้ใน Dt (DateReplied, NotSentNote) — การเปลี่ยนเป็น 4/5 ไม่ได้ลบข้อมูลนี้
function ursReplyStatus(r) {
  if (!r.DateReplied) return URS_ST_SENT;
  return r.NotSentNote ? URS_ST_NOT_READY : URS_ST_READY;
}

// ---------- ข้อความแจ้งคำร้อง (ใช้ทั้งคัดลอกไปวางใน LINE และแจ้งเตือน Telegram ผ่าน LineNotify) ----------
// สร้างที่ server ที่เดียว ให้ข้อความ Telegram กับข้อความที่ผู้ใช้คัดลอกตรงกันเสมอ — รูปแบบต้องตรงกับ replyMessage() ใน urs-request.html
const URS_NOTIFY_LINE_ID = 189;   // devsk.LineNotify.lineID ของกลุ่มแจ้งเตือนคำร้องเร่งด่วน
const ursFmtDateThai = (iso) => {
  if (!iso) return '-';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y + 543}`;
};
const ursFmtNum = (v) => v === null || v === undefined ? '-'
  : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// origin ของลิงก์ตอบกลับ: ใช้ของหน้าเว็บที่ส่งมา (ตรงกับ location.origin) ถ้ารูปแบบถูก ไม่งั้นใช้ host ของ request
function ursReplyOrigin(req) {
  const o = typeof req.body.origin === 'string' ? req.body.origin.trim() : '';
  return /^https?:\/\/[^\s/?#]+$/i.test(o) ? o : `${req.protocol}://${req.get('host')}`;
}

// อ่านข้อมูลเอกสารภายใน transaction เดียวกัน (เห็นข้อมูลที่เพิ่งแก้ / เพิ่งส่ง) แล้วสร้างข้อความ
async function buildUrsMessage(transaction, idUrs, origin, edited) {
  const head = await new sql.Request(transaction)
    .input('idUrs', sql.Int, idUrs)
    .query(
      `SELECT mt.DocReq, mt.ReasonReq, c.CompName, ct.CompName AS CompNameTarget, ps.PsName AS PsNameReq
       FROM GR_Group.devsk.SeedUrgentReqMt mt
       LEFT JOIN PchInvAndProject.dbo.dCompany c ON mt.idCompReq = c.idComp
       LEFT JOIN PchInvAndProject.dbo.dCompany ct ON mt.idCompTarget = ct.idComp
       OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = mt.idPsReq) ps
       WHERE mt.idUrs = @idUrs`
    );
  const items = await new sql.Request(transaction)
    .input('idUrs', sql.Int, idUrs)
    .input('stCancel', sql.VarChar(1), URS_ST_CANCEL)
    .query(
      `SELECT i.InvName, dt.AmountReq, u.UnitName, CONVERT(char(10), dt.DateNeeded, 23) AS DateNeeded
       FROM GR_Group.devsk.SeedUrgentReqDt dt
       LEFT JOIN devsk.dInventoryMain i ON dt.idInvMain = i.idInvMain
       LEFT JOIN devsk.dInvUnit u ON dt.idUnit = u.idUnit
       WHERE dt.idUrs = @idUrs AND ISNULL(dt.stReq, '') <> @stCancel
       ORDER BY dt.idUrsDt`
    );
  const h = head.recordset[0] || {};
  const lines = items.recordset.map((r, i) =>
    `${i + 1}. ${r.InvName || '-'} — ${ursFmtNum(r.AmountReq)} ${r.UnitName || ''} (ต้องการ ${ursFmtDateThai(r.DateNeeded)})`);
  return [
    edited ? `✏️ แก้ไขคำร้องขอเมล็ดพันธุ์เร่งด่วน ${h.DocReq} (ข้อมูลล่าสุด)` : `📌 คำร้องขอเมล็ดพันธุ์เร่งด่วน ${h.DocReq}`,
    `จาก: ${h.CompName || '-'}`,
    `ถึง: ${h.CompNameTarget || '-'}`,
    `ผู้ร้องขอ: ${h.PsNameReq || '-'}`,
    `เหตุผล: ${h.ReasonReq || '-'}`,
    '',
    ...lines,
    '',
    `กรุณาตอบกลับสถานะ (พร้อมส่ง / ไม่พร้อมส่ง) ที่ลิงก์นี้:`,
    `${origin}/urs-reply?id=${encodeURIComponent(idUrs)}`
  ].join('\n');
}

// แจ้งเตือน Telegram: insert ลงคิว devsk.LineNotify (ระบบส่งแจ้งเตือนอ่านคิวไปส่งเอง) — อยู่ใน transaction เดียวกับการส่ง/แก้ไข
// insert ไม่สำเร็จ = throw -> ผู้เรียก rollback ทั้งหมด (การส่ง/แก้ไขคำร้องไม่ถูกบันทึก)
async function queueUrsNotify(transaction, message, idPs) {
  await new sql.Request(transaction)
    .input('lineID', sql.Int, URS_NOTIFY_LINE_ID)
    .input('msg', sql.NVarChar(sql.MAX), message)
    .input('idPs', sql.Int, idPs)
    .query(`INSERT INTO GR_Group.devsk.LineNotify (lineID, Messages, idPsTs) VALUES (@lineID, @msg, @idPs)`);
}

// ---------- ส่งคำร้อง: Draft ทุกรายการในเอกสาร -> ส่งคำร้องแล้ว + เก็บผู้ส่ง / เวลาส่ง + แจ้งเตือน Telegram ----------
// ส่งซ้ำได้ (กดเพื่อขอลิงก์อีกครั้ง) — รายการที่ส่ง/ตอบกลับไปแล้วไม่ถูกแตะ / แจ้งเตือนเฉพาะครั้งที่มีรายการถูกส่งจริง
// คืน message = ข้อความเดียวกับที่แจ้ง Telegram ให้หน้าเว็บแสดงให้คัดลอกไปวางใน LINE
app.post('/api/urs/requests/:idUrs/send', requireMenu('urs_request'), requireUrsDocComp, async (req, res) => {
  const idPs = req.session.user && parseInt(req.session.user.idPs, 10);
  if (!idPs) return res.status(401).json({ success: false, message: 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
  const idUrs = parseInt(req.params.idUrs, 10);
  if (!idUrs) return res.status(400).json({ success: false, message: 'idUrs ไม่ถูกต้อง' });

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const result = await new sql.Request(transaction)
      .input('idUrs', sql.Int, idUrs)
      .input('idPs', sql.Int, idPs)
      .input('stSent', sql.VarChar(1), URS_ST_SENT)
      .query(
        `IF NOT EXISTS (SELECT 1 FROM GR_Group.devsk.SeedUrgentReqMt WITH (UPDLOCK, HOLDLOCK) WHERE idUrs = @idUrs AND idPsCancel IS NULL)
           SELECT CAST(-1 AS INT) AS sentCount;
         ELSE
         BEGIN
           UPDATE GR_Group.devsk.SeedUrgentReqDt
           SET stReq = @stSent, idPsSendReq = @idPs, DateSentReq = GETDATE()
           WHERE idUrs = @idUrs AND stReq IS NULL;
           SELECT @@ROWCOUNT AS sentCount;
         END`
      );
    const sentCount = result.recordset[0].sentCount;
    if (sentCount === -1) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'ไม่พบคำร้องนี้ หรือคำร้องถูกยกเลิกแล้ว' });
    }
    const message = await buildUrsMessage(transaction, idUrs, ursReplyOrigin(req), false);
    if (sentCount > 0) await queueUrsNotify(transaction, message, idPs);
    await transaction.commit();
    res.json({ success: true, sentCount, message, notified: sentCount > 0 });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (rollbackErr) {} }
    console.error('URS send error:', err);
    res.status(500).json({ success: false, message: 'ส่งคำร้องไม่สำเร็จ (รวมถึงการแจ้งเตือน Telegram) — กรุณาลองใหม่อีกครั้ง', detail: err.message });
  }
});

// ---------- หน้าตอบกลับสถานะ: ข้อมูลคำร้อง + รายการเมล็ด (ต้อง login) ----------
// canReply = คำร้องยังไม่ถูกยกเลิก (ใครมีลิงก์ + login แล้วตอบได้ ไม่เช็คบริษัทที่สังกัด)
app.get('/api/urs/reply/:idUrs', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
  const idUrs = parseInt(req.params.idUrs, 10);
  if (!idUrs) return res.status(400).json({ success: false, message: 'ลิงก์ไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const mt = await pool.request()
      .input('idUrs', sql.Int, idUrs)
      .query(
        `SELECT mt.idUrs, mt.DocReq, CONVERT(char(10), mt.DateReq, 23) AS DateReq, mt.ReasonReq,
                mt.idCompReq, c.CompName AS CompNameReq, mt.idCompTarget, ct.CompName AS CompNameTarget,
                ps.PsName AS PsNameReq, mt.idPsCancel
         FROM GR_Group.devsk.SeedUrgentReqMt mt
         LEFT JOIN PchInvAndProject.dbo.dCompany c ON mt.idCompReq = c.idComp
         LEFT JOIN PchInvAndProject.dbo.dCompany ct ON mt.idCompTarget = ct.idComp
         OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = mt.idPsReq) ps
         WHERE mt.idUrs = @idUrs`
      );
    if (mt.recordset.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบคำร้องนี้' });
    const head = mt.recordset[0];

    // อัพเดตสถานะจัดส่งก่อนอ่านรายการ (รับครบ -> '5' ล็อกการแก้ไขทันที) + ยอดจัดส่งแล้ว / คงค้าง ไว้แสดง
    const delivered = head.idPsCancel ? new Map() : await refreshUrsDelivered(pool, head.idCompReq);

    const dt = await pool.request()
      .input('idUrs', sql.Int, idUrs)
      .input('stCancel', sql.VarChar(1), URS_ST_CANCEL)
      .query(
        `SELECT dt.idUrsDt, dt.idInvMain, i.InvName, sp.SeedName, dt.AmountReq, u.UnitName,
                CONVERT(char(10), dt.DateNeeded, 23) AS DateNeeded, dt.stReq,
                CONVERT(varchar(16), dt.DateSentReq, 120) AS DateSentReq,
                CONVERT(char(10), dt.DateSent, 23) AS DateSent, dt.NotSentNote,
                CONVERT(varchar(16), dt.DateReplied, 120) AS DateReplied, pr.PsName AS PsNameReplied
         FROM GR_Group.devsk.SeedUrgentReqDt dt
         LEFT JOIN devsk.dInventoryMain i ON dt.idInvMain = i.idInvMain
         LEFT JOIN dbo.vSeedProduct sp ON i.idSubType = sp.idPd AND i.idInvGroup = 1
         LEFT JOIN devsk.dInvUnit u ON dt.idUnit = u.idUnit
         OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = dt.idPsReplied) pr
         WHERE dt.idUrs = @idUrs AND ISNULL(dt.stReq, '') <> @stCancel
         ORDER BY dt.idUrsDt`
      );

    const items = dt.recordset.map(it => {
      const d = delivered.get(it.idUrsDt);
      return { ...it, AmtDelivered: d ? d.AmtDelivered : 0, AmtRemain: d ? d.AmtRemain : it.AmountReq };
    });
    const canReply = !head.idPsCancel;
    res.json({ success: true, data: { ...head, items, canReply } });
  } catch (err) {
    console.error('URS reply load error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลคำร้องไม่สำเร็จ', detail: err.message });
  }
});

// ---------- บันทึกการตอบกลับ (ผู้ที่มีลิงก์ + login แล้ว) ----------
// items: [{ idUrsDt, status: '2' | '3', dateSent, note }]
//   '2' พร้อมส่ง   -> dateSent (วันที่กำหนดส่ง) บังคับ
//   '3' ไม่พร้อมส่ง -> note (สาเหตุ) บังคับ, dateSent (คาดว่าจะพร้อมส่ง) ไม่บังคับ
// ต้องตอบครบทุกรายการที่ส่งมา (ส่งเฉพาะรายการที่เปลี่ยน แต่หลังบันทึกต้องไม่เหลือ "รอตอบกลับ") / แก้คำตอบเดิมได้ / รายการ Draft ตอบไม่ได้
// แก้คำตอบได้เรื่อยๆ จนกว่ารายการจะรับของครบ ('5' จัดส่งครบแล้ว)
app.post('/api/urs/reply/:idUrs', async (req, res) => {
  const user = req.session.user;
  const idPs = user && parseInt(user.idPs, 10);
  if (!idPs) return res.status(401).json({ success: false, message: 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
  const idUrs = parseInt(req.params.idUrs, 10);
  if (!idUrs) return res.status(400).json({ success: false, message: 'ลิงก์ไม่ถูกต้อง' });

  const isISODate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime());
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ success: false, message: 'กรุณาระบุสถานะอย่างน้อย 1 รายการ' });

  const rows = items.map(it => ({
    idUrsDt: parseInt(it.idUrsDt, 10),
    status: String(it.status || ''),
    dateSent: it.dateSent ? String(it.dateSent) : null,
    note: it.note ? String(it.note).trim() : ''
  }));
  for (const [i, r] of rows.entries()) {
    const no = `รายการที่ ${i + 1}`;
    if (!r.idUrsDt) return res.status(400).json({ success: false, message: `${no}: ข้อมูลไม่ถูกต้อง` });
    if (r.status === URS_ST_READY) {
      if (!isISODate(r.dateSent)) return res.status(400).json({ success: false, message: `${no}: กรุณาระบุวันที่กำหนดส่ง` });
      r.note = '';
    } else if (r.status === URS_ST_NOT_READY) {
      if (!r.note) return res.status(400).json({ success: false, message: `${no}: กรุณาระบุสาเหตุที่ไม่พร้อมส่ง` });
      if (r.note.length > 1000) return res.status(400).json({ success: false, message: `${no}: สาเหตุยาวเกิน 1000 ตัวอักษร` });
      if (r.dateSent !== null && !isISODate(r.dateSent)) return res.status(400).json({ success: false, message: `${no}: วันที่คาดว่าจะพร้อมส่งไม่ถูกต้อง` });
    } else {
      return res.status(400).json({ success: false, message: `${no}: กรุณาเลือกสถานะ พร้อมส่ง / ไม่พร้อมส่ง` });
    }
  }

  let transaction;
  try {
    const pool = await poolPromise;
    const mt = await pool.request()
      .input('idUrs', sql.Int, idUrs)
      .query(`SELECT idPsCancel, idCompReq FROM GR_Group.devsk.SeedUrgentReqMt WHERE idUrs = @idUrs`);
    if (mt.recordset.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบคำร้องนี้' });
    if (mt.recordset[0].idPsCancel) return res.status(400).json({ success: false, message: 'คำร้องนี้ถูกยกเลิกแล้ว' });
    // เช็คยอดรับล่าสุดก่อนบันทึก: รายการที่รับครบแล้ว ('5') จะถูกปฏิเสธใน UPDATE ด้านล่าง
    await refreshUrsDelivered(pool, mt.recordset[0].idCompReq);

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    for (const [i, r] of rows.entries()) {
      const upd = await new sql.Request(transaction)
        .input('idUrs', sql.Int, idUrs)
        .input('idUrsDt', sql.Int, r.idUrsDt)
        .input('status', sql.VarChar(1), r.status)
        .input('dateSent', sql.VarChar(10), r.dateSent)
        .input('note', sql.VarChar(1000), r.note || null)
        .input('idPs', sql.Int, idPs)
        .query(
          // จัดส่งบางส่วน ('4') แก้คำตอบได้ แต่คงสถานะ 4 ไว้ (คำตอบเก็บใน DateSent / NotSentNote ใช้ตอนถอยสถานะ)
          // รับครบแล้ว ('5') = สิ้นสุด แก้ไม่ได้
          `UPDATE GR_Group.devsk.SeedUrgentReqDt
           SET stReq = CASE WHEN stReq = '${URS_ST_PARTIAL}' THEN stReq ELSE @status END,
               DateSent = CONVERT(date, @dateSent, 23), NotSentNote = @note,
               idPsReplied = @idPs, DateReplied = GETDATE()
           WHERE idUrsDt = @idUrsDt AND idUrs = @idUrs AND stReq IN ('1','2','3','${URS_ST_PARTIAL}')`
        );
      if (upd.rowsAffected[0] !== 1) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: `รายการที่ ${i + 1}: รับของครบแล้ว (แก้ไขไม่ได้) หรือยังไม่ได้ส่งคำร้อง — กรุณาโหลดหน้าใหม่` });
      }
    }
    // ต้องตอบกลับครบทุกรายการที่ส่งมา: ถ้ายังเหลือรายการ "รอตอบกลับ" ให้ยกเลิกทั้งหมด
    const left = await new sql.Request(transaction)
      .input('idUrs', sql.Int, idUrs)
      .input('stSent', sql.VarChar(1), URS_ST_SENT)
      .query(`SELECT COUNT(*) AS n FROM GR_Group.devsk.SeedUrgentReqDt WHERE idUrs = @idUrs AND stReq = @stSent`);
    if (left.recordset[0].n > 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `ยังตอบกลับไม่ครบ ${left.recordset[0].n} รายการ — กรุณาตอบกลับให้ครบทุกรายการก่อนบันทึก` });
    }
    await transaction.commit();
    res.json({ success: true, updated: rows.length });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) { /* rollback แล้ว */ } }
    console.error('URS reply save error:', err);
    res.status(500).json({ success: false, message: 'บันทึกการตอบกลับไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ดึงรายชื่อบริษัททั้งหมดจาก dCompany (ใช้แสดงในลิสให้เลือกกำหนดสิทธิ์) ----------
app.get('/api/permissions/companies', requireMenu(MENU_ADMIN), async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT idComp, CompName
       FROM PchInvAndProject.dbo.dCompany
       WHERE stDel IS NULL
       ORDER BY CompName`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Permissions companies error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายชื่อบริษัทไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ดึงบริษัทที่กลุ่มหนึ่งๆ ได้รับอนุญาตอยู่ตอนนี้ ----------
app.get('/api/usergroups/:idGroup/company-permissions', requireMenu(MENU_ADMIN), async (req, res) => {
  const idGroup = parseInt(req.params.idGroup, 10);
  if (!idGroup) return res.status(400).json({ success: false, message: 'idGroup ไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idGroup', sql.Int, idGroup)
      .query(`SELECT idComp FROM WIMWebGroupCompPer WHERE idGroup = @idGroup AND stAllow = 1 AND stDel IS NULL`);
    res.json({ success: true, data: result.recordset.map(r => r.idComp) });
  } catch (err) {
    console.error('Get group company permissions error:', err);
    res.status(500).json({ success: false, message: 'โหลดสิทธิ์บริษัทของกลุ่มไม่สำเร็จ', detail: err.message });
  }
});

// ---------- บันทึกสิทธิ์บริษัทของกลุ่ม (แทนที่ชุดสิทธิ์เดิมทั้งหมดด้วยชุดใหม่ที่ส่งมา) ----------
app.post('/api/usergroups/:idGroup/company-permissions', requireMenu(MENU_ADMIN), async (req, res) => {
  const idGroup = parseInt(req.params.idGroup, 10);
  const { compIds } = req.body; // compIds = array ของ idComp ที่อนุญาต
  const idPsCreate = req.idPs;
  if (!idGroup) return res.status(400).json({ success: false, message: 'idGroup ไม่ถูกต้อง' });
  if (!Array.isArray(compIds)) return res.status(400).json({ success: false, message: 'รูปแบบข้อมูลไม่ถูกต้อง' });

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    await new sql.Request(transaction)
      .input('idGroup', sql.Int, idGroup)
      .query('DELETE FROM WIMWebGroupCompPer WHERE idGroup = @idGroup');

    for (const idComp of compIds) {
      const req2 = new sql.Request(transaction)
        .input('idGroup', sql.Int, idGroup)
        .input('idComp', sql.Int, idComp);
      if (idPsCreate) req2.input('idPsCreate', sql.Int, idPsCreate);
      await req2.query(
        `INSERT INTO WIMWebGroupCompPer (idGroup, idComp, stAllow${idPsCreate ? ', idPsCreate' : ''})
         VALUES (@idGroup, @idComp, 1${idPsCreate ? ', @idPsCreate' : ''})`
      );
    }

    await transaction.commit();
    clearAccessCache();
    res.json({ success: true });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Save group company permissions error:', err);
    res.status(500).json({ success: false, message: 'บันทึกสิทธิ์บริษัทไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- ส่งคืนสินค้า/ลดหนี้ Supplier (RTS) ----------
// ==================================================================
// table: devsk.PkBuyRTMt (หัว) / devsk.PkBuyRTDt (รายการ) / devsk.PkBuyRTType (ประเภท) / devsk.PkBuyRTCause (สาเหตุ)
// สถานะเอกสารไม่มีคอลัมน์ — คิดจากวันที่แต่ละขั้น (ยกเลิก > อนุมัติ > ตรวจสอบ 2 > ตรวจสอบ 1 > รับทราบ)
//   1 รอรับทราบ / 2 รอตรวจสอบ 1 / 3 รอตรวจสอบ 2 / 4 รออนุมัติ / 5 อนุมัติแล้ว / 9 ยกเลิก
const MENU_RTS = 'supplier_return';
// /supplier-return-approve?step=ack|check|approve = หน้าเดียวกับ /supplier-return แต่เปิดเป็นโหมดรับทราบ / ตรวจสอบ / อนุมัติ
app.get('/supplier-return-approve', (req, res) => res.sendFile(path.join(__dirname, 'public', 'supplier-return.html')));
// /supplier-return-doc?id= = หน้าเอกสารใบเดียว (ลิงก์ที่ส่งตามรับทราบ / ตรวจสอบ / อนุมัติ) — ไฟล์เดียวกัน หน้าเว็บสลับโหมดเอง
app.get('/supplier-return-doc', (req, res) => res.sendFile(path.join(__dirname, 'public', 'supplier-return.html')));
const MENU_RTS_CANCEL = 'supplier_return_cancel';   // สิทธิ์ยกเลิกเอกสาร (สิทธิ์ย่อย ไม่มีหน้าแยก)
const MENU_RTS_CAUSE = 'supplier_return_cause';     // สิทธิ์จัดการสาเหตุการคืน (สิทธิ์ย่อย ไม่มีหน้าแยก)
// เมนูรับทราบ / ตรวจสอบ / อนุมัติ (ผู้ใช้เมนูเหล่านี้อาจไม่มีสิทธิ์เมนูทำเอกสาร — เปิดข้อมูลตั้งต้น / เอกสารใบเดียวได้)
const MENU_RTS_ACK = 'supplier_return_ack';
const MENU_RTS_CHECK = 'supplier_return_check';
const MENU_RTS_APPROVE = 'supplier_return_approve';
const MENU_RTS_VIEW = [MENU_RTS, MENU_RTS_ACK, MENU_RTS_CHECK, MENU_RTS_APPROVE];
// 0 = ส่งกลับแก้ไข (DateSendBack ยังอยู่): รอผู้ทำเอกสารแก้ไขแล้วบันทึก จึงกลับไปรอรับทราบ (กันกดรับทราบซ้ำทันทีหลังส่งกลับ)
const rtsStatus = (r) => r.DateCancel ? 9 : r.DateApv ? 5 : r.DateCheck2 ? 4 : r.DateCheck ? 3 : r.DateAccept ? 2 : r.DateSendBack ? 0 : 1;
// ขั้นตอนอนุมัติ: ชื่อ + เวลา / ใบเอกสาร (ช่องลงนาม) ใช้ idPs (รูปลายเซ็น) + ตำแหน่งปัจจุบันในระบบ เพิ่ม
const rtsStep = (by, at, id, pos, full) => (at ? { by: by || '-', at, ...(id ? { id, pos: pos || '', full: (full || '').trim() } : {}) } : null);

// ข้อมูลตั้งต้นของหน้า: ประเภทการคืน / สาเหตุการคืน / บริษัทที่มีสิทธิ์ (พร้อม CompCode ไว้แสดงแบบสั้น)
//   สาเหตุส่งทั้งที่ปิดใช้งาน (stDel) ไปด้วย ให้เอกสารเก่ายังแสดงชื่อได้
app.get('/api/supplier-return/meta', requireMenu(MENU_RTS_VIEW), async (req, res) => {
  try {
    const pool = await poolPromise;
    const request = pool.request();
    const compSql = compFilter(req.access, request, 'c.idComp');
    const r = await request.query(
      `SELECT idTypeRT, TypeCode, TypeName, TypeNameEn, TypeDesc, stReturnGoods, stCredit, stReplace
       FROM devsk.PkBuyRTType WITH (NOLOCK)
       WHERE stDel IS NULL
       ORDER BY SortOrder, idTypeRT;

       SELECT idBuyRtCause, BuyRtCause, CASE WHEN stDel IS NULL THEN 0 ELSE 1 END AS inactive
       FROM devsk.PkBuyRTCause WITH (NOLOCK)
       ORDER BY ISNULL(SortOrder, idBuyRtCause), idBuyRtCause;

       SELECT c.idComp, LTRIM(RTRIM(c.CompCode)) AS CompCode, c.CompName
       FROM PchInvAndProject.dbo.dCompany c WITH (NOLOCK)
       WHERE c.stDel IS NULL AND c.CompName IS NOT NULL ${compSql}
       ORDER BY c.CompCode, c.CompName;`
    );
    res.json({
      success: true,
      types: r.recordsets[0].map(t => ({
        id: t.idTypeRT, code: t.TypeCode, name: t.TypeName, en: t.TypeNameEn, desc: t.TypeDesc,
        returnGoods: t.stReturnGoods === '1', credit: t.stCredit === '1', replace: t.stReplace === '1'
      })),
      causes: r.recordsets[1].map(c => ({ id: c.idBuyRtCause, name: c.BuyRtCause, inactive: !!c.inactive })),
      companies: r.recordsets[2].map(c => ({ id: c.idComp, code: c.CompCode || c.CompName, name: c.CompName })),
      canCancel: hasMenu(req.access, MENU_RTS_CANCEL), canEdit: hasMenu(req.access, MENU_RTS),
      canManageCause: hasMenu(req.access, MENU_RTS_CAUSE),
      canAck: hasMenu(req.access, MENU_RTS_ACK), canCheck: hasMenu(req.access, MENU_RTS_CHECK), canApprove: hasMenu(req.access, MENU_RTS_APPROVE),
      me: req.idPs
    });
  } catch (err) {
    console.error('Supplier return meta error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลตั้งต้นไม่สำเร็จ', detail: err.message });
  }
});

// Supplier ที่เคยรับของเข้าคลังในบริษัทนี้ (ใบรับไม่ยกเลิก + อ้างอิง PO) — ค้นชื่อ / รหัส (สูงสุด 50 ราย)
app.get('/api/supplier-return/suppliers', requireMenu(MENU_RTS, { companyParam: 'idComp' }), async (req, res) => {
  const idComp = parseInt(req.query.idComp, 10);
  const keyword = String(req.query.keyword || '').trim();
  if (!idComp) return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท' });
  try {
    const pool = await poolPromise;
    const r = await pool.request()
      .input('idComp', sql.Int, idComp)
      .input('keyword', sql.NVarChar, `%${keyword}%`)
      .query(
        `SELECT TOP 50 s.idSup, LTRIM(RTRIM(s.SupName)) AS SupName, s.SupCode, CONVERT(varchar(10), x.LastRec, 23) AS LastRec
         FROM (SELECT rm.idSup, MAX(rm.DateRec) AS LastRec
               FROM devsk.PKPoRecMt rm WITH (NOLOCK)
               WHERE rm.idComp = @idComp AND rm.idPsCancel IS NULL
                 AND EXISTS (SELECT 1 FROM devsk.PKPoRecDt rd WITH (NOLOCK) WHERE rd.idPkPORec = rm.idPkPORec AND rd.idPODt IS NOT NULL)
               GROUP BY rm.idSup) x
         JOIN PchInvAndProject.dbo.vSupplier s WITH (NOLOCK) ON s.idSup = x.idSup
         WHERE (s.SupName LIKE @keyword OR s.SupCode LIKE @keyword)
         ORDER BY x.LastRec DESC`
      );
    res.json({
      success: true,
      data: r.recordset.map(s => ({ id: s.idSup, name: s.SupName, code: s.SupCode, lastRec: s.LastRec }))
    });
  } catch (err) {
    console.error('Supplier return suppliers error:', err);
    res.status(500).json({ success: false, message: 'ค้นหา Supplier ไม่สำเร็จ', detail: err.message });
  }
});

// Lot ที่รับเข้าจาก PO ของ Supplier นี้ (popup เลือกรายการส่งคืน) — 1 แถว = Lot ในคลังหนึ่ง (dInvLotRefWh) ของบรรทัด PO หนึ่ง
//   กรองตาม Supplier ของใบรับ (PKPoRecMt) — PO อาจคนละ Supplier หรือถูกปิดหลังรับของแล้ว แต่ของยังอยู่ในคลัง
//   soldOut = 0 → เฉพาะ Lot ที่ยังมีสต๊อก (โหลดทั้งหมด ให้หน้าเว็บกรองเอง)
//   soldOut = 1 → เฉพาะ Lot ที่สต๊อกหมดแล้ว ค้นด้วย keyword (ชื่อสินค้า / Lot No. / PO / เลขที่รับ / ใบส่งของ) อย่างน้อย 2 ตัวอักษร
//                 สูงสุด RTS_SOLD_MAX_ROWS แถว — ประวัติสะสมเยอะ จึงไม่โหลดทั้งหมด (ใช้กับประเภทไม่ส่งคืน - ลดหนี้)
//   PendingQty = จำนวนในเอกสารส่งคืนประเภทคืนของอื่นที่ยังไม่อนุมัติ / ไม่ยกเลิก (excludeId = เอกสารที่กำลังแก้ไข ไม่นับตัวเอง)
//                ใช้แสดงเป็นข้อมูลเท่านั้น — เอกสารเหล่านี้ส่งเข้าตารางรอเบิกแล้ว คงเหลือจาก vInvLotRefWh_RStock จึงหักให้แล้ว
//   UsedQty = จำนวนในเอกสารอื่นทุกใบที่ไม่ยกเลิก (รวมที่อนุมัติแล้ว) — ประเภทไม่ส่งคืน ลดหนี้ได้ไม่เกิน รับเข้า - UsedQty (กันลดหนี้ซ้ำ)
//   ต้นทุนต่อหน่วย = dInvLotMain.CostPerUnit (null = Lot ไม่มีต้นทุน → หน้าเว็บเตือนและห้ามบันทึก)
//   เงื่อนไขเดียวกับหน้าเลือกรายการของ Win form:
//     - คงเหลือจาก view vInvLotRefWh_RStock = ยอดในคลัง - ยอดรอเบิก (WimWaitCut) / ไม่รวม Lot ที่อยู่ระหว่างขอปรับยอด-นับสต๊อก
//     - ไม่รวมคลังแม่ 5503 (Seeds Stock QA) / ใบรับ ProcessID 1, 11 เท่านั้น
//   warehouses = คลังหลักของบริษัท (ssWarehouse.idParrent = 0, stDel = 0) ให้หน้าเว็บกรองตาม idParent0 ของแต่ละแถว
//   ค่าคุณภาพส่งตามค่าจริงใน DB: -1 = NN, -2 = WW (หน้าเว็บแปลงตอนแสดง / ตอนบันทึกเก็บเป็นตัวเลขเดิม), null = ยังไม่มีผล
const RTS_LOT_MAX_ROWS = 2000;
const RTS_SOLD_MAX_ROWS = 300;
const RTS_EXCLUDED_WH_PARENT = 5503;   // Seeds Stock QA
app.get('/api/supplier-return/lots', requireMenu(MENU_RTS, { companyParam: 'idComp' }), async (req, res) => {
  const idComp = parseInt(req.query.idComp, 10);
  const idSup = parseInt(req.query.idSup, 10);
  const soldOut = req.query.soldOut === '1';
  const excludeId = parseInt(req.query.excludeId, 10) || null;
  const keyword = String(req.query.keyword || '').trim().slice(0, 100);
  if (!idComp || !idSup) return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทและ Supplier' });
  if (soldOut && keyword.length < 2) return res.status(400).json({ success: false, message: 'พิมพ์ชื่อสินค้าหรือ Lot No. อย่างน้อย 2 ตัวอักษร' });
  const maxRows = soldOut ? RTS_SOLD_MAX_ROWS : RTS_LOT_MAX_ROWS;
  try {
    const pool = await poolPromise;
    const r = await pool.request()
      .input('idComp', sql.Int, idComp)
      .input('idSup', sql.Int, idSup)
      .input('soldOut', sql.Bit, soldOut ? 1 : 0)
      .input('excludeId', sql.Int, excludeId)
      .input('maxRows', sql.Int, maxRows)
      .input('kw', sql.NVarChar(110), '%' + keyword.replace(/[[%_]/g, '[$&]') + '%')
      .query(`
      -- เปิดแก้ไขเอกสาร (excludeId): view หักยอดรอเบิกของเอกสารนี้ไปแล้ว — ดึงยอดที่เอกสารนี้จองไว้ครั้งเดียว แล้วบวกกลับให้เห็นยอดที่ใช้ได้จริง
      --   (เอกสารใหม่ excludeId ว่าง = ไม่ค้นตารางรอเบิกเลย — ตารางใหญ่ ค้นทีละแถวจะช้ามาก)
      SELECT wd.idRefLot, SUM(wd.AmountWaitChange) AS Qty
      INTO #own
      FROM devsk.WimWaitCutMt wm
      JOIN devsk.WimWaitCutDt wd ON wd.IdWaitCutMt = wm.IdWaitCutMt
      WHERE @excludeId IS NOT NULL AND wm.IdMt = @excludeId AND ${RTS_ACTIVE_WAITCUT}
        AND wd.stWait IS NULL AND wd.stDel IS NULL
      GROUP BY wd.idRefLot;

      SELECT rd.idPODt, rd.idLotMain AS idLot, MIN(rd.idPkPORecDt) AS idRecDt
      INTO #rec
      FROM devsk.PKPoRecDt rd WITH (NOLOCK)
      JOIN devsk.PKPoRecMt rm WITH (NOLOCK) ON rm.idPkPORec = rd.idPkPORec
      WHERE rm.idSup = @idSup AND rm.idComp = @idComp AND rm.idPsCancel IS NULL AND rm.ProcessID IN (1, 11)
        AND rd.idLotMain IS NOT NULL AND rd.idPODt IS NOT NULL
      GROUP BY rd.idPODt, rd.idLotMain;

      -- คงเหลือคำนวณเองด้วยตรรกะเดียวกับ view vInvLotRefWh_RStock (เฉพาะ Lot ของ Supplier นี้) แล้วเก็บลงตารางชั่วคราว
      --   คงเหลือ = dInvLotRefWh.Amount - ยอดรอเบิก (WimWaitCutDt: หัวไม่ยกเลิก / stWait / stDel ว่าง) / ไม่รวม Lot ที่อยู่ระหว่างขอปรับยอด-นับสต๊อก
      --   (join view ตรงๆ แบบส่งค่า parameter SQL เลือกแผนช้ามากเมื่อ Lot เยอะ — Supplier ใหญ่ 1.5-3 วินาทีจนหน้าเว็บโหลดไม่สำเร็จ / แบบนี้ ~0.3 วินาที)
      --   ถ้า view เปลี่ยนเงื่อนไข ต้องแก้ตรงนี้ให้ตรงกันด้วย (ตอนบันทึกยังเช็คกับ view ทีละ Lot — rtsLoadLots)
      --   OnHand = คงเหลือ + ยอดที่เอกสารที่กำลังแก้ไขจองไว้ (#own)
      SELECT r.idPODt, r.idLot, r.idRecDt, whr.idRefLot, whr.AmountRec, whr.Amount, whr.idWh, whr.idUnit
      INTO #lot
      FROM #rec r
      JOIN devsk.dInvLotRefWh whr WITH (NOLOCK) ON whr.idLot = r.idLot;

      SELECT wd.idRefLot, SUM(wd.AmountWaitChange) AS Qty
      INTO #wc
      FROM devsk.WimWaitCutDt wd WITH (NOLOCK)
      LEFT JOIN devsk.WimWaitCutMt wm WITH (NOLOCK) ON wd.IdWaitCutMt = wm.IdWaitCutMt
      WHERE wm.stCancel IS NULL AND wd.stWait IS NULL AND wd.stDel IS NULL AND wd.idRefLot IN (SELECT idRefLot FROM #lot)
      GROUP BY wd.idRefLot;

      SELECT DISTINCT rdt.idRefLot
      INTO #cnt
      FROM devsk.dInvReqCountDt rdt WITH (NOLOCK)
      LEFT JOIN devsk.dInvReqCountMt rmt WITH (NOLOCK) ON rdt.idRqUpdate = rmt.idRqUpdate
      WHERE rdt.idRefLot IN (SELECT idRefLot FROM #lot)
        AND ((rmt.idPsAccept IS NULL AND rmt.idPsCancel IS NULL) OR (rmt.idPsCancel IS NULL AND rmt.idPsCheck IS NULL)
          OR (rmt.idPsCancel IS NULL AND rmt.idPsApprove IS NULL));

      SELECT l.idPODt, l.idLot, l.idRecDt, l.idRefLot, l.AmountRec, l.idWh, l.idUnit, l.Amount - ISNULL(wc.Qty, 0) + ISNULL(own.Qty, 0) AS OnHand
      INTO #stk
      FROM #lot l
      LEFT JOIN #wc wc ON wc.idRefLot = l.idRefLot
      LEFT JOIN #own own ON own.idRefLot = l.idRefLot
      WHERE l.idRefLot NOT IN (SELECT idRefLot FROM #cnt);
      DELETE FROM #stk WHERE (@soldOut = 0 AND OnHand <= 0) OR (@soldOut = 1 AND OnHand > 0);

      SELECT TOP (@maxRows)
             s.idRefLot, s.idLot, lm.LotNo, lm.idInvMain, i.InvName, g.InvGroupName,
             s.idWh, w.idParent0, ISNULL(NULLIF(LTRIM(RTRIM(w.short_lock)), ''), w.WareHouseName) AS StoreName,
             s.idPODt, bm.DocCode AS POCode, bd.Amount AS POQty,
             s.idRecDt, rm.DocCode AS RecCode, NULLIF(LTRIM(RTRIM(rm.DocRef)), '') AS DocRef, CONVERT(varchar(10), rm.DateRec, 23) AS DateRec,
             s.AmountRec AS RcvQty, s.OnHand, s.idUnit, u.UnitName, lm.CostPerUnit,
             q.PureGene, q.GrowPaper, q.GrowMedia, q.GrowAA,
             ISNULL(pend.Qty, 0) AS PendingQty, ISNULL(pend.UsedQty, 0) AS UsedQty, adj.AdjFrom, adj.AdjTo, adj.AdjDoc
      FROM #stk s
      JOIN devsk.dInvLotMain lm WITH (NOLOCK) ON lm.idLot = s.idLot AND lm.stDel IS NULL
      LEFT JOIN devsk.PKPOBuyDt bd WITH (NOLOCK) ON bd.idPODt = s.idPODt
      LEFT JOIN devsk.PKPOBuyMt bm WITH (NOLOCK) ON bm.idPOTs = bd.idPOTs
      LEFT JOIN devsk.PKPoRecDt rdx WITH (NOLOCK) ON rdx.idPkPORecDt = s.idRecDt
      LEFT JOIN devsk.PKPoRecMt rm WITH (NOLOCK) ON rm.idPkPORec = rdx.idPkPORec
      LEFT JOIN devsk.dInventoryMain i WITH (NOLOCK) ON i.idInvMain = lm.idInvMain
      LEFT JOIN devsk.dInvGroup g WITH (NOLOCK) ON g.idInvGroup = i.idInvGroup
      LEFT JOIN devsk.dInvUnit u WITH (NOLOCK) ON u.idUnit = s.idUnit
      LEFT JOIN dbo.ssWarehouse w WITH (NOLOCK) ON w.idWh = s.idWh
      LEFT JOIN devsk.dInvLotQuality q WITH (NOLOCK) ON q.idLot = s.idLot AND q.typeReturn = 0
      -- Qty = เอกสารประเภทคืนของที่ยังไม่อนุมัติ (แสดงเป็นข้อมูล) / UsedQty = ทุกเอกสารที่ไม่ยกเลิก รวมที่อนุมัติแล้ว (กันลดหนี้ซ้ำ)
      OUTER APPLY (SELECT SUM(CASE WHEN mt.DateApv IS NULL AND ty.stReturnGoods = '1' THEN dt.AmountRT ELSE 0 END) AS Qty, SUM(dt.AmountRT) AS UsedQty
                   FROM devsk.PkBuyRTDt dt WITH (NOLOCK)
                   JOIN devsk.PkBuyRTMt mt WITH (NOLOCK) ON mt.idBuyRT = dt.idBuyRT
                   LEFT JOIN devsk.PkBuyRTType ty WITH (NOLOCK) ON ty.idTypeRT = mt.TypeRT
                   WHERE dt.idRefLot = s.idRefLot AND dt.stDel IS NULL AND mt.DateCancel IS NULL
                     AND (@excludeId IS NULL OR mt.idBuyRT <> @excludeId)) pend
      OUTER APPLY (SELECT TOP 1 CAST(lc.Cost_Old AS decimal(18,4)) AS AdjFrom, CAST(lc.Cost_New AS decimal(18,4)) AS AdjTo, mx.DocCode AS AdjDoc
                   FROM devsk.WimLogCost lc WITH (NOLOCK) JOIN devsk.PkBuyRTMt mx WITH (NOLOCK) ON mx.idBuyRT = lc.RefId
                   WHERE lc.idLot = s.idLot AND lc.RefTb = 'PkBuyRTMt' AND ISNULL(lc.Cost_Old, -1) <> ISNULL(lc.Cost_New, -1) ORDER BY lc.idLog DESC) adj
      WHERE ISNULL(w.idParent0, 0) <> ${RTS_EXCLUDED_WH_PARENT}
        AND (@soldOut = 0 OR i.InvName LIKE @kw OR lm.LotNo LIKE @kw OR bm.DocCode LIKE @kw OR rm.DocCode LIKE @kw OR rm.DocRef LIKE @kw)
      ORDER BY rm.DateRec DESC, lm.LotNo;

      SELECT idWh, ISNULL(NULLIF(LTRIM(RTRIM(short_lock)), ''), WareHouseName) AS WhName
      FROM dbo.ssWarehouse WITH (NOLOCK)
      WHERE idComp = @idComp AND idParrent = 0 AND stDel = 0 AND idWh <> ${RTS_EXCLUDED_WH_PARENT}
      ORDER BY WareHouseName;`);

    const num = (v) => (v == null ? null : Number(v));
    const data = r.recordset.map(x => ({
      key: `${x.idRefLot}-${x.idPODt}`, idRefLot: x.idRefLot, idLot: x.idLot, lot: x.LotNo, idInvMain: x.idInvMain,
      name: x.InvName, type: x.InvGroupName || '-', idWh: x.idWh, mainWh: x.idParent0, store: x.StoreName,
      idPODt: x.idPODt, po: x.POCode, poQty: num(x.POQty), idRecDt: x.idRecDt, rec: x.RecCode, inv: x.DocRef, rcvDate: x.DateRec,
      rcvQty: num(x.RcvQty) || 0, onHand: num(x.OnHand) || 0, pendingQty: num(x.PendingQty) || 0, usedQty: num(x.UsedQty) || 0,
      idUnit: x.idUnit, unit: x.UnitName, cost: num(x.CostPerUnit),
      gp: num(x.PureGene), gpPaper: num(x.GrowPaper), gpMedia: num(x.GrowMedia), aa: num(x.GrowAA),
      creditAdj: x.AdjDoc ? { doc: x.AdjDoc, from: num(x.AdjFrom), to: num(x.AdjTo) } : null
    }));
    const warehouses = r.recordsets[1].map(w => ({ id: w.idWh, name: w.WhName }));
    res.json({ success: true, data, warehouses, truncated: data.length >= maxRows, maxRows });
  } catch (err) {
    console.error('Supplier return lots error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการรับเข้าไม่สำเร็จ', detail: err.message });
  }
});

// ---------- จัดการสาเหตุการคืน (devsk.PkBuyRTCause) — สิทธิ์ supplier_return_cause ----------
//   stDel = '1' คือปิดใช้งาน (ไม่แสดงให้เลือก แต่เอกสารเก่ายังแสดงชื่อได้) / ลบได้เฉพาะที่ยังไม่เคยใช้ (ลบจริง)
//   สาเหตุที่ใช้แล้ว แก้ชื่อได้เล็กน้อย (แก้คำสะกดผิด) ไม่เกิน RTS_CAUSE_MAX_EDIT ตัวอักษร — ห้ามเปลี่ยนความหมายของเอกสารเก่า
//   idPsTs / DateTs = ผู้เพิ่มหรือแก้ไขล่าสุด (เขียนทับทุกครั้ง)
//   ใช้แล้ว = มีใน PkBuyRTDt (นับรวมรายการที่ถูกลบในเอกสาร เพราะยังอ้างอิงอยู่)
const RTS_CAUSE_MAX_LEN = 200;
const RTS_CAUSE_MAX_EDIT = 3;
// จำนวนตัวอักษรที่ต้องเพิ่ม / ลบ / เปลี่ยน ให้ข้อความ a กลายเป็น b (Levenshtein)
function rtsEditDistance(a, b) {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}
const rtsCauseName = (v) => String(v || '').replace(/\s+/g, ' ').trim();

async function rtsCauseList(pool) {
  const r = await pool.request().query(`
    SELECT c.idBuyRtCause, c.BuyRtCause, CASE WHEN c.stDel IS NULL THEN 0 ELSE 1 END AS inactive, c.SortOrder,
           (SELECT COUNT(*) FROM devsk.PkBuyRTDt d WITH (NOLOCK) WHERE d.idBuyRtCause = c.idBuyRtCause) AS UsedRows,
           p.PsName, CONVERT(varchar(16), c.DateTs, 120) AS DateTs
    FROM devsk.PkBuyRTCause c WITH (NOLOCK)
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = c.idPsTs) p
    ORDER BY ISNULL(c.SortOrder, c.idBuyRtCause), c.idBuyRtCause`);
  return r.recordset.map(c => ({ id: c.idBuyRtCause, name: c.BuyRtCause, inactive: !!c.inactive, used: c.UsedRows, by: c.PsName || null, at: c.DateTs || null }));
}
// ชื่อซ้ำกับสาเหตุอื่น (ไม่สนช่องว่างหน้าหลัง / ตัวพิมพ์เล็กใหญ่ — collation Thai_CI_AS)
async function rtsCauseDup(tq, name, exceptId) {
  const r = await tq().input('name', sql.VarChar(RTS_CAUSE_MAX_LEN), name).input('id', sql.Int, exceptId || 0)
    .query(`SELECT TOP 1 BuyRtCause FROM devsk.PkBuyRTCause WITH (UPDLOCK, HOLDLOCK) WHERE LTRIM(RTRIM(BuyRtCause)) = @name AND idBuyRtCause <> @id`);
  return r.recordset[0] ? r.recordset[0].BuyRtCause : null;
}
const rtsCauseFail = (res, status, message) => res.status(status).json({ success: false, message });

app.get('/api/supplier-return/causes', requireMenu(MENU_RTS_CAUSE), async (req, res) => {
  try {
    res.json({ success: true, data: await rtsCauseList(await poolPromise), maxEdit: RTS_CAUSE_MAX_EDIT });
  } catch (err) {
    console.error('Supplier return causes error:', err);
    res.status(500).json({ success: false, message: 'โหลดสาเหตุการคืนไม่สำเร็จ', detail: err.message });
  }
});

// เพิ่มสาเหตุ (ต่อท้ายลำดับ)
app.post('/api/supplier-return/causes', requireMenu(MENU_RTS_CAUSE), async (req, res) => {
  const name = rtsCauseName((req.body || {}).name);
  if (!name) return rtsCauseFail(res, 400, 'กรุณาระบุชื่อสาเหตุ');
  if (name.length > RTS_CAUSE_MAX_LEN) return rtsCauseFail(res, 400, `ชื่อสาเหตุยาวได้ไม่เกิน ${RTS_CAUSE_MAX_LEN} ตัวอักษร`);
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const tq = () => new sql.Request(transaction);
    const dup = await rtsCauseDup(tq, name, 0);
    if (dup) { await transaction.rollback(); transaction = null; return rtsCauseFail(res, 400, `มีสาเหตุ "${dup}" อยู่แล้ว`); }
    await tq().input('name', sql.VarChar(RTS_CAUSE_MAX_LEN), name).input('idPs', sql.Int, req.idPs)
      .query(`INSERT INTO devsk.PkBuyRTCause (BuyRtCause, stDel, SortOrder, idPsTs, DateTs)
              SELECT @name, NULL, ISNULL(MAX(ISNULL(SortOrder, idBuyRtCause)), 0) + 1, @idPs, GETDATE() FROM devsk.PkBuyRTCause`);
    await transaction.commit(); transaction = null;
    res.json({ success: true, data: await rtsCauseList(pool) });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return cause add error:', err);
    res.status(500).json({ success: false, message: 'เพิ่มสาเหตุไม่สำเร็จ', detail: err.message });
  }
});

// แก้ชื่อ (name) และ/หรือ เปิด-ปิดใช้งาน (active)
app.put('/api/supplier-return/causes/:id', requireMenu(MENU_RTS_CAUSE), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const name = b.name === undefined ? null : rtsCauseName(b.name);
  const active = b.active === undefined ? null : !!b.active;
  if (!id) return rtsCauseFail(res, 400, 'ข้อมูลไม่ถูกต้อง');
  if (name !== null && !name) return rtsCauseFail(res, 400, 'กรุณาระบุชื่อสาเหตุ');
  if (name && name.length > RTS_CAUSE_MAX_LEN) return rtsCauseFail(res, 400, `ชื่อสาเหตุยาวได้ไม่เกิน ${RTS_CAUSE_MAX_LEN} ตัวอักษร`);
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const tq = () => new sql.Request(transaction);
    const fail = async (status, message) => { await transaction.rollback(); transaction = null; return rtsCauseFail(res, status, message); };
    const cur = (await tq().input('id', sql.Int, id).query(`
      SELECT c.BuyRtCause, (SELECT COUNT(*) FROM devsk.PkBuyRTDt d WHERE d.idBuyRtCause = c.idBuyRtCause) AS UsedRows
      FROM devsk.PkBuyRTCause c WITH (UPDLOCK, ROWLOCK) WHERE c.idBuyRtCause = @id`)).recordset[0];
    if (!cur) return fail(404, 'ไม่พบสาเหตุนี้ (อาจถูกลบไปแล้ว)');
    if (name !== null && name !== rtsCauseName(cur.BuyRtCause)) {
      if (cur.UsedRows > 0 && rtsEditDistance(rtsCauseName(cur.BuyRtCause), name) > RTS_CAUSE_MAX_EDIT) {
        return fail(400, `สาเหตุนี้ถูกใช้ในเอกสารแล้ว ${cur.UsedRows} รายการ — แก้ชื่อได้เล็กน้อย (แก้คำสะกดผิดไม่เกิน ${RTS_CAUSE_MAX_EDIT} ตัวอักษร) ถ้าต้องการสาเหตุใหม่ ให้เพิ่มสาเหตุใหม่แล้วปิดใช้งานอันเดิม`);
      }
      const dup = await rtsCauseDup(tq, name, id);
      if (dup) return fail(400, `มีสาเหตุ "${dup}" อยู่แล้ว`);
    }
    await tq().input('id', sql.Int, id).input('name', sql.VarChar(RTS_CAUSE_MAX_LEN), name)
      .input('chgActive', sql.Bit, active === null ? 0 : 1).input('active', sql.Bit, active ? 1 : 0).input('idPs', sql.Int, req.idPs)
      .query(`UPDATE devsk.PkBuyRTCause
              SET BuyRtCause = ISNULL(@name, BuyRtCause),
                  stDel = CASE WHEN @chgActive = 0 THEN stDel WHEN @active = 1 THEN NULL ELSE '1' END,
                  idPsTs = @idPs, DateTs = GETDATE()
              WHERE idBuyRtCause = @id`);
    await transaction.commit(); transaction = null;
    res.json({ success: true, data: await rtsCauseList(pool) });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return cause update error:', err);
    res.status(500).json({ success: false, message: 'บันทึกสาเหตุไม่สำเร็จ', detail: err.message });
  }
});

// ลบ (เฉพาะที่ยังไม่เคยใช้ — ลบจริง)
app.delete('/api/supplier-return/causes/:id', requireMenu(MENU_RTS_CAUSE), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return rtsCauseFail(res, 400, 'ข้อมูลไม่ถูกต้อง');
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const r = await new sql.Request(transaction).input('id', sql.Int, id).query(`
      IF EXISTS (SELECT 1 FROM devsk.PkBuyRTDt WITH (UPDLOCK, HOLDLOCK) WHERE idBuyRtCause = @id) SELECT -1 AS n
      ELSE BEGIN DELETE FROM devsk.PkBuyRTCause WHERE idBuyRtCause = @id; SELECT @@ROWCOUNT AS n; END`);
    const n = r.recordset[0].n;
    if (n !== 1) {
      await transaction.rollback(); transaction = null;
      return rtsCauseFail(res, n === -1 ? 400 : 404, n === -1 ? 'สาเหตุนี้ถูกใช้ในเอกสารแล้ว ลบไม่ได้ — ใช้ปิดใช้งานแทน' : 'ไม่พบสาเหตุนี้ (อาจถูกลบไปแล้ว)');
    }
    await transaction.commit(); transaction = null;
    res.json({ success: true, data: await rtsCauseList(pool) });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return cause delete error:', err);
    res.status(500).json({ success: false, message: 'ลบสาเหตุไม่สำเร็จ', detail: err.message });
  }
});

// เรียงลำดับใหม่: ids = idBuyRtCause ทุกตัวตามลำดับที่ต้องการ
app.put('/api/supplier-return/causes-order', requireMenu(MENU_RTS_CAUSE), async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(v => parseInt(v, 10)).filter(v => v > 0) : [];
  if (!ids.length || new Set(ids).size !== ids.length) return rtsCauseFail(res, 400, 'ข้อมูลลำดับไม่ถูกต้อง');
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    for (let i = 0; i < ids.length; i++) {
      await new sql.Request(transaction).input('id', sql.Int, ids[i]).input('ord', sql.Int, i + 1)
        .query('UPDATE devsk.PkBuyRTCause SET SortOrder = @ord WHERE idBuyRtCause = @id');
    }
    await transaction.commit(); transaction = null;
    res.json({ success: true, data: await rtsCauseList(pool) });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return cause order error:', err);
    res.status(500).json({ success: false, message: 'บันทึกลำดับไม่สำเร็จ', detail: err.message });
  }
});

// ---------- บันทึกเอกสารส่งคืน: ใหม่ (POST) / แก้ไข (PUT) / เปิดเอกสารใบเดียว (GET) ----------
// body: { idComp, typeId, idSup, idPsRT, returnDate (yyyy-mm-dd), note, stamp (แก้ไขเท่านั้น),
//         items: [{ idBuyRTDt (รายการเดิม / null = เพิ่มใหม่), idRefLot, idPODt, idRecDt, qty, price, idCause, seenOnHand, seenUsedQty }] }
// ทุกขั้นอยู่ใน transaction เดียว — ผิดพลาดตรงไหน rollback ทั้งหมด
//   1. ดึงข้อมูล Lot ล่าสุดจาก DB (ล็อกแถว dInvLotRefWh กันบันทึกซ้อน)
//      รายการใหม่ใช้ต้นทุน / คุณภาพล่าสุดของ Lot / รายการเดิม (แก้ไข) คงต้นทุน / คุณภาพ ณ วันที่ทำเอกสารไว้
//   2. ยอดเปลี่ยนจากที่หน้าเว็บเห็น (คืนของ = คงเหลือ / ไม่คืนของ = ยอดที่ลดหนี้ไปแล้ว) → ไม่บันทึก ส่งรายการที่เปลี่ยนกลับไป (409 STOCK_CHANGED)
//      ตอนแก้ไข: คงเหลือบวกยอดรอเบิกของเอกสารนี้กลับ (view หักไปแล้ว) / ยอดลดหนี้ไปแล้วไม่นับเอกสารนี้
//   3. ใหม่: เลขที่ RTS{ปี พ.ศ. 2 หลัก}{เดือน}/{ลำดับ 4 หลัก} เริ่มใหม่ทุกเดือน แยกตามบริษัท
//   4. PkBuyRTMt / PkBuyRTDt — ประเภทไม่ลดหนี้ เก็บยอดราคาใหม่ / ยอดลดหนี้เป็น NULL / รายการที่ลบตอนแก้ไข = stDel '1' (ไม่ลบจริง)
//   5. ตารางรอเบิก WimWaitCutMt / Dt (ProcessID 21, stNoApprove = 1) เฉพาะประเภทคืนของ (stReturnGoods = '1')
//      แก้ไข: ปรับจำนวน / stDel รายการที่ลบ / เพิ่มรายการใหม่ — เปลี่ยนเป็นประเภทไม่คืนของ = ยกเลิกหัวรอเบิก (รายการถือว่ายกเลิกตาม)
//      / เปลี่ยนจากไม่คืนของเป็นคืนของ = สร้างหัว + รายการรอเบิกใหม่ทั้งชุด
const RTS_MAX_ITEMS = 200;
const RTS_PROCESS_WAITCUT = 21;   // การเบิกเพื่อส่งคืนสินค้าให้ Supplier
const rtsRound = (n, d) => { const p = 10 ** d; return Math.round((Number(n) + Number.EPSILON) * p) / p; };
// หัวรอเบิกของเอกสารที่ยังใช้งาน (ไม่ยกเลิก) — รายการรอเบิกที่นับเป็นยอดจอง = stWait / stDel ว่าง (เงื่อนไขเดียวกับ vInvLotRefWh_RStock)
const RTS_ACTIVE_WAITCUT = `wm.ProcessID = ${RTS_PROCESS_WAITCUT} AND wm.TbName = 'PkBuyRTMt' AND wm.stCancel IS NULL AND wm.idPsCancel IS NULL`;

// ตรวจ body ที่หน้าเว็บส่งมา → { head, lines } หรือ { error }
function rtsParseBody(b) {
  const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const head = {
    idComp: int(b.idComp), typeId: int(b.typeId), idSup: int(b.idSup), idPsRT: int(b.idPsRT),
    returnDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.returnDate || '')) ? b.returnDate : null,
    note: String(b.note || '').trim().slice(0, 1000) || null,
    noCostAdj: b.noCostAdj === true || b.noCostAdj === '1'
  };
  const items = Array.isArray(b.items) ? b.items : [];
  if (!head.idComp || !head.typeId || !head.idSup || !head.idPsRT || !head.returnDate) return { error: 'ข้อมูลหัวเอกสารไม่ครบ (บริษัท / ประเภท / Supplier / ผู้ดำเนินการ / วันที่คืนสินค้า)' };
  if (!items.length) return { error: 'กรุณาเลือกรายการส่งคืนอย่างน้อย 1 รายการ' };
  if (items.length > RTS_MAX_ITEMS) return { error: `เอกสารหนึ่งใบมีได้ไม่เกิน ${RTS_MAX_ITEMS} รายการ` };
  const lines = items.map((it, i) => ({
    no: i + 1, idBuyRTDt: int(it.idBuyRTDt), idRefLot: int(it.idRefLot), idPODt: int(it.idPODt), idRecDt: int(it.idRecDt),
    qty: rtsRound(num(it.qty) || 0, 6), price: num(it.price), idCause: int(it.idCause),
    seenOnHand: num(it.seenOnHand), seenUsedQty: num(it.seenUsedQty)
  }));
  if (lines.some(l => !l.idBuyRTDt && (!l.idRefLot || !l.idPODt || !l.idRecDt))) return { error: 'ข้อมูลรายการไม่ถูกต้อง กรุณาเลือกรายการใหม่' };
  const noCause = lines.filter(l => !l.idCause).map(l => l.no);
  if (noCause.length) return { error: `ยังไม่ระบุสาเหตุการคืน รายการที่ ${noCause.join(', ')}` };
  const badQty = lines.filter(l => !(l.qty > 0)).map(l => l.no);
  if (badQty.length) return { error: `จำนวนคืนต้องมากกว่า 0 รายการที่ ${badQty.join(', ')}` };
  return { head, lines };
}

// ประเภท + สาเหตุที่เปิดใช้งาน (อ่านก่อนเปิด transaction)
async function rtsLoadMeta(pool, typeId) {
  const r = await pool.request().input('typeId', sql.Int, typeId)
    .query(`SELECT stReturnGoods, stCredit FROM devsk.PkBuyRTType WHERE idTypeRT = @typeId AND stDel IS NULL;
            SELECT idBuyRtCause FROM devsk.PkBuyRTCause WHERE stDel IS NULL;`);
  const ty = r.recordsets[0][0];
  if (!ty) return null;
  return { returnGoods: ty.stReturnGoods === '1', credit: ty.stCredit === '1', causes: new Set(r.recordsets[1].map(c => c.idBuyRtCause)) };
}

// ข้อมูล Lot ล่าสุดของแต่ละรายการ → l.db (idBuyRT = เอกสารที่กำลังแก้ไข: บวกยอดรอเบิกของตัวเองกลับ / ไม่นับยอดลดหนี้ของตัวเอง)
async function rtsLoadLots(tq, lines, { idComp, idSup, idBuyRT }) {
  for (const l of lines) {
    const r = await tq()
      .input('idRefLot', sql.Int, l.idRefLot).input('idPODt', sql.Int, l.idPODt).input('idRecDt', sql.Int, l.idRecDt)
      .input('idComp', sql.Int, idComp).input('idSup', sql.Int, idSup).input('idBuyRT', sql.Int, idBuyRT || null)
      .query(`
        SELECT whr.idLot, whr.idWh, whr.idUnit, whr.AmountRec, CASE WHEN rs.idRefLot IS NULL THEN 1 ELSE 0 END AS Counting,
               ISNULL(rs.Amount, 0) + ISNULL(own.Qty, 0) AS OnHand,
               lm.idInvMain, lm.LotNo, lm.CostPerUnit, i.InvName,
               q.PureGene, q.GrowPaper, q.GrowMedia, q.GrowAA,
               (SELECT ISNULL(SUM(dt.AmountRT), 0) FROM devsk.PkBuyRTDt dt JOIN devsk.PkBuyRTMt mt ON mt.idBuyRT = dt.idBuyRT
                WHERE dt.idRefLot = whr.idRefLot AND dt.stDel IS NULL AND mt.DateCancel IS NULL
                  AND (@idBuyRT IS NULL OR mt.idBuyRT <> @idBuyRT)) AS UsedQty,
               CASE WHEN EXISTS (SELECT 1 FROM devsk.PKPoRecDt rd JOIN devsk.PKPoRecMt rm ON rm.idPkPORec = rd.idPkPORec
                                 WHERE rd.idPkPORecDt = @idRecDt AND rd.idPODt = @idPODt AND rd.idLotMain = whr.idLot
                                   AND rm.idSup = @idSup AND rm.idComp = @idComp AND rm.idPsCancel IS NULL) THEN 1 ELSE 0 END AS RefOk
        FROM devsk.dInvLotRefWh whr WITH (UPDLOCK, ROWLOCK)
        JOIN devsk.dInvLotMain lm ON lm.idLot = whr.idLot AND lm.stDel IS NULL
        LEFT JOIN devsk.dInventoryMain i ON i.idInvMain = lm.idInvMain
        LEFT JOIN devsk.vInvLotRefWh_RStock rs ON rs.idRefLot = whr.idRefLot
        LEFT JOIN devsk.dInvLotQuality q ON q.idLot = whr.idLot AND q.typeReturn = 0
        OUTER APPLY (SELECT SUM(wd.AmountWaitChange) AS Qty FROM devsk.WimWaitCutDt wd
                     JOIN devsk.WimWaitCutMt wm ON wm.IdWaitCutMt = wd.IdWaitCutMt
                     WHERE ${RTS_ACTIVE_WAITCUT} AND wm.IdMt = @idBuyRT
                       AND wd.stWait IS NULL AND wd.stDel IS NULL AND wd.idRefLot = whr.idRefLot) own
        WHERE whr.idRefLot = @idRefLot`);
    l.db = r.recordset[0] || null;
  }
}

// ตรวจรายการกับข้อมูลล่าสุด → null = ผ่าน / { status, body } = ไม่บันทึก
function rtsCheckLines(lines, { returnGoods, credit }) {
  const lotLabel = (l) => l.db ? `${l.db.LotNo} (${l.db.InvName || ''})` : `รายการที่ ${l.no}`;
  const notFound = lines.filter(l => !l.db || (!l.existing && !l.db.RefOk));
  if (notFound.length) return { status: 400, body: { message: `ไม่พบข้อมูล Lot / ใบรับของ Supplier นี้: ${notFound.map(lotLabel).join(', ')} — กรุณาลบรายการนั้นแล้วเลือกใหม่` } };
  const noCost = lines.filter(l => (l.existing ? l.existing.CostPerUnit : l.db.CostPerUnit) == null);
  if (noCost.length) return { status: 400, body: { message: `Lot ยังไม่มีต้นทุนต่อหน่วย: ${noCost.map(lotLabel).join(', ')}` } };
  if (returnGoods) {
    const counting = lines.filter(l => l.db.Counting);
    if (counting.length) return { status: 400, body: { message: `Lot อยู่ระหว่างขอปรับยอด / นับสต๊อก ยังส่งคืนไม่ได้: ${counting.map(lotLabel).join(', ')}` } };
  }
  if (credit) {
    const badPrice = lines.filter(l => l.price == null || !(l.price >= 0)).map(l => l.no);
    if (badPrice.length) return { status: 400, body: { message: `ราคาใหม่ต่อหน่วยไม่ถูกต้อง รายการที่ ${badPrice.join(', ')}` } };
  }
  const changes = [], over = [];
  for (const l of lines) {
    const onHand = Number(l.db.OnHand || 0), used = Number(l.db.UsedQty || 0), rcv = Number(l.db.AmountRec || 0);
    const base = { idRefLot: l.idRefLot, idPODt: l.idPODt, lot: l.db.LotNo, name: l.db.InvName, onHand, usedQty: used, rcvQty: rcv };
    if (returnGoods) {
      if (l.seenOnHand == null || Math.abs(l.seenOnHand - onHand) > 1e-6) changes.push({ ...base, field: 'onHand', old: l.seenOnHand, now: onHand });
      else if (l.qty > onHand + 1e-6) over.push(lotLabel(l));
    } else {
      const limit = rtsRound(rcv - used, 6);
      if (l.seenUsedQty == null || Math.abs(l.seenUsedQty - used) > 1e-6) changes.push({ ...base, field: 'credit', old: rtsRound(rcv - (l.seenUsedQty || 0), 6), now: limit });
      else if (l.qty > limit + 1e-6) over.push(lotLabel(l));
    }
  }
  if (changes.length) return { status: 409, body: { code: 'STOCK_CHANGED', message: 'จำนวนคงเหลือมีการเปลี่ยนแปลง กรุณาตรวจสอบก่อนบันทึก', changes } };
  if (over.length) return { status: 400, body: { message: `จำนวนเกิน${returnGoods ? 'คงเหลือ' : 'จำนวนที่ลดหนี้ได้'}: ${over.join(', ')}` } };
  return null;
}

// ยอดเงินของแต่ละรายการ + รวม (รายการเดิมใช้ต้นทุนเดิมของเอกสาร)
function rtsCalcTotals(lines, credit) {
  const t = { value: 0, buy: 0, diff: 0 };
  for (const l of lines) {
    l.cost = Number(l.existing ? l.existing.CostPerUnit : l.db.CostPerUnit);
    l.total = rtsRound(l.qty * l.cost, 2);
    if (credit) {
      l.totalNew = rtsRound(l.qty * l.price, 2);
      l.diff = rtsRound(l.total - l.totalNew, 2);
      t.buy += l.totalNew; t.diff += l.diff;
    }
    t.value += l.total;
  }
  return { value: rtsRound(t.value, 2), buy: credit ? rtsRound(t.buy, 2) : null, diff: credit ? rtsRound(t.diff, 2) : null };
}

// เพิ่มรายการใหม่ใน PkBuyRTDt → idBuyRTDt (ต้นทุน / หน่วย / คุณภาพจาก Lot ล่าสุด)
async function rtsInsertDt(tq, idBuyRT, l, credit) {
  const d = l.db;
  const r = await tq()
    .input('idBuyRT', sql.Int, idBuyRT).input('idRefLot', sql.Int, l.idRefLot).input('idInvMain', sql.Int, d.idInvMain)
    .input('idPODt', sql.Int, l.idPODt).input('idRecDt', sql.Int, l.idRecDt)
    .input('qty', sql.Decimal(18, 6), l.qty).input('idUnit', sql.Int, d.idUnit)
    .input('cost', sql.Decimal(18, 4), l.cost).input('total', sql.Decimal(18, 4), l.total)
    .input('costNew', sql.Decimal(18, 4), credit ? l.price : null)
    .input('totalNew', sql.Decimal(18, 4), credit ? l.totalNew : null)
    .input('diff', sql.Decimal(18, 4), credit ? l.diff : null)
    .input('idCause', sql.Int, l.idCause)
    .input('pureGene', sql.Decimal(18, 4), d.PureGene).input('growPaper', sql.Decimal(18, 4), d.GrowPaper)
    .input('growMedia', sql.Decimal(18, 4), d.GrowMedia).input('growAA', sql.Decimal(18, 4), d.GrowAA)
    .query(`INSERT INTO devsk.PkBuyRTDt (idBuyRT, idRefLot, idInvMain, idPoDt, idRecDt, AmountRT, idUnit, CostPerUnit, Total,
                                         CostUnitNew, ToTalNew, TotalDiff, idBuyRtCause, PureGene, GrowPaper, GrowMedia, GrowAA)
            VALUES (@idBuyRT, @idRefLot, @idInvMain, @idPODt, @idRecDt, @qty, @idUnit, @cost, @total,
                    @costNew, @totalNew, @diff, @idCause, @pureGene, @growPaper, @growMedia, @growAA);
            SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`);
  return r.recordset[0].id;
}

// สร้างหัว + รายการรอเบิกทั้งชุดจากรายการที่ยังใช้งานของเอกสาร — คำสั่งเดียวกับ SetToWaitCut ของ Win form
async function rtsInsertWaitCut(tq, idBuyRT, idComp, idPs) {
  await tq()
    .input('idBuyRT', sql.Int, idBuyRT).input('idComp', sql.Int, idComp).input('idPs', sql.Int, idPs)
    .input('processId', sql.Int, RTS_PROCESS_WAITCUT)
    .query(`
      INSERT INTO devsk.WimWaitCutMt (DocCode, DocDate, Note, ProcessID, ProcessName, SystemRef, TbName, IdMt, idcomp, IdPsTs, DateTs, stNoApprove)
      SELECT DocCode, DateTs, Note, @processId, (SELECT ProcessName FROM devsk.WimProcessRec WHERE ID = @processId), 'WIM',
             'PkBuyRTMt', idBuyRT, @idComp, @idPs, GETDATE(), 1
      FROM devsk.PkBuyRTMt WHERE idBuyRT = @idBuyRT;
      DECLARE @idWaitCutMt int = SCOPE_IDENTITY();
      INSERT INTO devsk.WimWaitCutDt (IdWaitCutMt, idDtRef, idLot, idRefLot, idInvMain, AmountWait, AmountWaitBal, idUnitNew, AmountWaitChange, idWh)
      SELECT @idWaitCutMt, dt.idBuyRTDt, w.idLot, dt.idRefLot, dt.idInvMain, dt.AmountRT, dt.AmountRT, dt.idUnit, dt.AmountRT, w.idWh
      FROM devsk.PkBuyRTDt dt
      LEFT JOIN devsk.dInvLotRefWh w ON dt.idRefLot = w.idRefLot
      WHERE dt.idBuyRT = @idBuyRT AND dt.stDel IS NULL;`);
}

// ยกเลิกรายการรอเบิกของเอกสาร: หัว stCancel = 1 + รายการ stDel = 1 (หน้าจอคลังที่เช็คแบบไหนก็เห็นว่ายกเลิก)
async function rtsCancelWaitCut(tq, idWaitCutMt, idPs) {
  await tq().input('w', sql.Int, idWaitCutMt).input('idPs', sql.Int, idPs)
    .query(`UPDATE devsk.WimWaitCutMt SET stCancel = 1, idPsCancel = @idPs, DateCancel = GETDATE() WHERE IdWaitCutMt = @w;
            UPDATE devsk.WimWaitCutDt SET stDel = 1 WHERE IdWaitCutMt = @w AND stDel IS NULL;`);
}

// ยอดลดหนี้ของเอกสารถูกดึงไปใช้ต่อแล้วหรือยัง — ตอนนี้ยังไม่มีระบบที่ดึงไปใช้ (ลดหนี้จริง) จึงยกเลิกได้เสมอ
//   อนาคตมีระบบดึงยอดลดหนี้ไปใช้: เพิ่มเงื่อนไขที่นี่ (true = ยกเลิกไม่ได้)
async function rtsCreditUsed(tq, idBuyRT) { return false; }

// เพิ่ม 1 รายการรอเบิกให้หัวรอเบิกที่มีอยู่ (รายการที่เพิ่มตอนแก้ไข)
async function rtsInsertWaitCutDt(tq, idWaitCutMt, idBuyRTDt) {
  await tq().input('w', sql.Int, idWaitCutMt).input('dt', sql.Int, idBuyRTDt)
    .query(`INSERT INTO devsk.WimWaitCutDt (IdWaitCutMt, idDtRef, idLot, idRefLot, idInvMain, AmountWait, AmountWaitBal, idUnitNew, AmountWaitChange, idWh)
            SELECT @w, dt.idBuyRTDt, w.idLot, dt.idRefLot, dt.idInvMain, dt.AmountRT, dt.AmountRT, dt.idUnit, dt.AmountRT, w.idWh
            FROM devsk.PkBuyRTDt dt
            LEFT JOIN devsk.dInvLotRefWh w ON dt.idRefLot = w.idRefLot
            WHERE dt.idBuyRTDt = @dt;`);
}

// ---------- บันทึกเอกสารใหม่ ----------
app.post('/api/supplier-return', requireMenu(MENU_RTS, { companyParam: 'idComp' }), async (req, res) => {
  const parsed = rtsParseBody(req.body || {});
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const { head, lines } = parsed;
  if (lines.some(l => l.idBuyRTDt)) return res.status(400).json({ success: false, message: 'ข้อมูลรายการไม่ถูกต้อง' });
  if (new Set(lines.map(l => l.idRefLot + '-' + l.idPODt)).size !== lines.length) return res.status(400).json({ success: false, message: 'มีรายการซ้ำกันในเอกสาร' });

  let transaction;
  try {
    const pool = await poolPromise;
    const meta = await rtsLoadMeta(pool, head.typeId);
    if (!meta) return res.status(400).json({ success: false, message: 'ประเภทการคืนไม่ถูกต้อง' });
    const offCause = lines.filter(l => !meta.causes.has(l.idCause)).map(l => l.no);
    if (offCause.length) return res.status(400).json({ success: false, message: `สาเหตุการคืนถูกปิดใช้งานแล้ว กรุณาเลือกใหม่ รายการที่ ${offCause.join(', ')}` });

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const tq = () => new sql.Request(transaction);

    await rtsLoadLots(tq, lines, { idComp: head.idComp, idSup: head.idSup, idBuyRT: null });
    const bad = rtsCheckLines(lines, meta);
    if (bad) { await transaction.rollback(); transaction = null; return res.status(bad.status).json({ success: false, ...bad.body }); }
    const t = rtsCalcTotals(lines, meta.credit);

    // เลขที่เอกสาร + หัวเอกสาร (DateDoc = DateTs = เวลาสร้าง)
    const mt = await tq()
      .input('idComp', sql.Int, head.idComp).input('returnDate', sql.Date, head.returnDate).input('typeId', sql.Int, head.typeId)
      .input('idSup', sql.Int, head.idSup).input('idPsRT', sql.Int, head.idPsRT)
      .input('totalValue', sql.Decimal(18, 2), t.value).input('totalBuy', sql.Decimal(18, 2), t.buy).input('totalDiff', sql.Decimal(18, 2), t.diff)
      .input('note', sql.VarChar(1000), head.note).input('idPs', sql.Int, req.idPs)
      .input('noCostAdj', sql.Char(1), head.noCostAdj && meta.credit && !meta.returnGoods ? '1' : null)
      .query(`
        DECLARE @now datetime = GETDATE();
        DECLARE @prefix varchar(8) = 'RTS' + RIGHT(CAST(YEAR(@now) + 543 AS varchar(4)), 2) + RIGHT('0' + CAST(MONTH(@now) AS varchar(2)), 2) + '/';
        DECLARE @seq int = ISNULL((SELECT MAX(CAST(SUBSTRING(DocCode, 9, 4) AS int))
                                   FROM devsk.PkBuyRTMt WITH (UPDLOCK, HOLDLOCK)
                                   WHERE idComp = @idComp AND DocCode LIKE @prefix + '[0-9][0-9][0-9][0-9]'), 0) + 1;
        DECLARE @docCode varchar(12) = @prefix + RIGHT('0000' + CAST(@seq AS varchar(4)), 4);
        INSERT INTO devsk.PkBuyRTMt (DocCode, DateDoc, DateRetrun, TypeRT, idSup, idPsRT, idComp, TotalValue, TotalBuy, TotalDiff, Note, idPsTs, DateTs, stNoCostAdj)
        VALUES (@docCode, @now, @returnDate, @typeId, @idSup, @idPsRT, @idComp, @totalValue, @totalBuy, @totalDiff, @note, @idPs, @now, @noCostAdj);
        SELECT CAST(SCOPE_IDENTITY() AS int) AS idBuyRT, @docCode AS DocCode;`);
    const { idBuyRT, DocCode } = mt.recordset[0];

    for (const l of lines) await rtsInsertDt(tq, idBuyRT, l, meta.credit);
    if (meta.returnGoods) await rtsInsertWaitCut(tq, idBuyRT, head.idComp, req.idPs);

    await transaction.commit();
    transaction = null;
    res.json({ success: true, id: idBuyRT, docNo: DocCode });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return save error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเอกสารไม่สำเร็จ — ระบบยกเลิกการบันทึกทั้งหมดแล้ว', detail: err.message });
  }
});

// ---------- บันทึกแก้ไขเอกสาร (แก้ได้เฉพาะสถานะรอรับทราบ) ----------
//   บริษัท / Supplier แก้ไม่ได้ (ต้องตรงกับเอกสารเดิม) / stamp = DateEdit (ว่าง = DateTs) ที่หน้าเว็บเห็น — ไม่ตรง = มีคนแก้ไปก่อน
//   ผู้แก้ไข / เวลา = idPsEdit / DateEdit (idPsTs / DateTs = ผู้สร้าง ไม่เขียนทับ)
app.put('/api/supplier-return/doc/:id', requireMenu(MENU_RTS, { companyParam: 'idComp' }), async (req, res) => {
  const idBuyRT = parseInt(req.params.id, 10);
  const parsed = rtsParseBody(req.body || {});
  if (!idBuyRT) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const { head, lines } = parsed;
  const stamp = String((req.body || {}).stamp || '');
  const dupIds = lines.filter(l => l.idBuyRTDt).map(l => l.idBuyRTDt);
  if (new Set(dupIds).size !== dupIds.length) return res.status(400).json({ success: false, message: 'มีรายการซ้ำกันในเอกสาร' });

  let transaction;
  try {
    const pool = await poolPromise;
    const meta = await rtsLoadMeta(pool, head.typeId);
    if (!meta) return res.status(400).json({ success: false, message: 'ประเภทการคืนไม่ถูกต้อง' });

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const tq = () => new sql.Request(transaction);
    const fail = async (status, body) => { await transaction.rollback(); transaction = null; return res.status(status).json({ success: false, ...body }); };

    // หัวเอกสาร (ล็อกไว้จนจบ transaction)
    const doc = (await tq().input('id', sql.Int, idBuyRT).query(`
      SELECT mt.DocCode, mt.idComp, mt.idSup, mt.DateAccept, mt.DateCancel, mt.DateApv,
             CONVERT(varchar(23), ISNULL(mt.DateEdit, mt.DateTs), 121) AS Stamp,
             CONVERT(varchar(16), ISNULL(mt.DateEdit, mt.DateTs), 120) AS StampText,
             (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = ISNULL(mt.idPsEdit, mt.idPsTs)) AS StampBy
      FROM devsk.PkBuyRTMt mt WITH (UPDLOCK, ROWLOCK) WHERE mt.idBuyRT = @id`)).recordset[0];
    if (!doc) return fail(404, { message: 'ไม่พบเอกสาร' });
    if (!hasComp(req.access, doc.idComp)) return fail(403, { message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้' });
    if (doc.idComp !== head.idComp || doc.idSup !== head.idSup) return fail(400, { message: 'แก้ไขบริษัทหรือ Supplier ของเอกสารที่บันทึกแล้วไม่ได้' });
    if (doc.DateCancel || doc.DateApv || doc.DateAccept) {
      return fail(409, { code: 'DOC_CHANGED', message: `เอกสาร ${doc.DocCode} ${doc.DateCancel ? 'ถูกยกเลิกแล้ว' : doc.DateApv ? 'อนุมัติแล้ว' : 'มีการรับทราบแล้ว'} — แก้ไขไม่ได้` });
    }
    if (doc.Stamp !== stamp) {
      return fail(409, { code: 'DOC_CHANGED', message: `เอกสาร ${doc.DocCode} ถูกแก้ไขโดย ${doc.StampBy || '-'} เมื่อ ${doc.StampText} หลังจากที่เปิดหน้าจอนี้ — กรุณาเปิดเอกสารใหม่` });
    }

    // หัวรอเบิกของเอกสาร — คลังเริ่มเบิกแล้วห้ามแก้
    const wc = (await tq().input('id', sql.Int, idBuyRT).query(`
      SELECT TOP 1 wm.IdWaitCutMt,
             (SELECT COUNT(*) FROM devsk.WimWaitCutDt wd WHERE wd.IdWaitCutMt = wm.IdWaitCutMt AND wd.stDel IS NULL
                AND (wd.stWait = 1 OR EXISTS (SELECT 1 FROM devsk.WimCutStockDtMain c WHERE c.idWaitCutDt = wd.idWaitCutDt AND c.DateCancel IS NULL AND c.stDel IS NULL))) AS CutRows
      FROM devsk.WimWaitCutMt wm WITH (UPDLOCK, ROWLOCK)
      WHERE ${RTS_ACTIVE_WAITCUT} AND wm.IdMt = @id ORDER BY wm.IdWaitCutMt DESC`)).recordset[0] || null;
    // คลังตัดเบิกแล้ว = มี Dt ที่ stWait = 1 หรือมีใบตัดเบิกที่ยังไม่ยกเลิก (ไม่ดู stUseCut ของหัว — ยกเลิกตัดแล้วไม่ถูกล้าง) / หัวที่ stCancel = Dt ทุกตัวยกเลิกตาม (RTS_ACTIVE_WAITCUT กรองออกแล้ว)
    if (wc && wc.CutRows > 0) return fail(400, { message: 'คลังเริ่มเบิกสินค้าของเอกสารนี้แล้ว — แก้ไขไม่ได้' });

    // รายการเดิมในเอกสาร: รายการที่ส่งมาพร้อม idBuyRTDt ต้องเป็นของเอกสารนี้ / Lot ใช้ค่าจาก DB (ไม่เชื่อค่าจากหน้าเว็บ)
    const oldRows = (await tq().input('id', sql.Int, idBuyRT).query(`
      SELECT idBuyRTDt, idRefLot, idPoDt, idRecDt, CostPerUnit FROM devsk.PkBuyRTDt WHERE idBuyRT = @id AND stDel IS NULL`)).recordset;
    const oldById = new Map(oldRows.map(r => [r.idBuyRTDt, r]));
    for (const l of lines) {
      if (!l.idBuyRTDt) continue;
      const o = oldById.get(l.idBuyRTDt);
      if (!o) return fail(409, { code: 'DOC_CHANGED', message: 'รายการในเอกสารถูกเปลี่ยนไปแล้ว — กรุณาเปิดเอกสารใหม่' });
      Object.assign(l, { existing: o, idRefLot: o.idRefLot, idPODt: o.idPoDt, idRecDt: o.idRecDt });
    }
    if (new Set(lines.map(l => l.idRefLot + '-' + l.idPODt)).size !== lines.length) return fail(400, { message: 'มีรายการซ้ำกันในเอกสาร' });
    // สาเหตุที่ปิดใช้งานแล้ว: รายการเดิมที่ใช้อยู่ให้คงไว้ได้ / เลือกใหม่ต้องเป็นสาเหตุที่เปิดใช้งาน
    const oldCause = new Map((await tq().input('id', sql.Int, idBuyRT).query(
      `SELECT idBuyRTDt, idBuyRtCause FROM devsk.PkBuyRTDt WHERE idBuyRT = @id AND stDel IS NULL`)).recordset.map(r => [r.idBuyRTDt, r.idBuyRtCause]));
    const offCause = lines.filter(l => !meta.causes.has(l.idCause) && !(l.idBuyRTDt && oldCause.get(l.idBuyRTDt) === l.idCause)).map(l => l.no);
    if (offCause.length) return fail(400, { message: `สาเหตุการคืนถูกปิดใช้งานแล้ว กรุณาเลือกใหม่ รายการที่ ${offCause.join(', ')}` });

    await rtsLoadLots(tq, lines, { idComp: doc.idComp, idSup: doc.idSup, idBuyRT });
    const bad = rtsCheckLines(lines, meta);
    if (bad) return fail(bad.status, bad.body);
    const t = rtsCalcTotals(lines, meta.credit);

    // หัวเอกสาร
    await tq()
      .input('id', sql.Int, idBuyRT).input('returnDate', sql.Date, head.returnDate).input('typeId', sql.Int, head.typeId)
      .input('idPsRT', sql.Int, head.idPsRT)
      .input('totalValue', sql.Decimal(18, 2), t.value).input('totalBuy', sql.Decimal(18, 2), t.buy).input('totalDiff', sql.Decimal(18, 2), t.diff)
      .input('note', sql.VarChar(1000), head.note).input('idPs', sql.Int, req.idPs)
      .input('noCostAdj', sql.Char(1), head.noCostAdj && meta.credit && !meta.returnGoods ? '1' : null)
      .query(`UPDATE devsk.PkBuyRTMt SET DateRetrun = @returnDate, TypeRT = @typeId, idPsRT = @idPsRT, stNoCostAdj = @noCostAdj,
                     TotalValue = @totalValue, TotalBuy = @totalBuy, TotalDiff = @totalDiff, Note = @note,
                     idPsEdit = @idPs, DateEdit = GETDATE(), DateSendBack = NULL
              WHERE idBuyRT = @id`);

    // รายการ: แก้ไขรายการเดิม / ลบ (stDel) รายการที่ไม่ส่งมา / เพิ่มรายการใหม่
    const kept = lines.filter(l => l.existing), added = lines.filter(l => !l.existing);
    const removed = oldRows.filter(o => !kept.some(l => l.idBuyRTDt === o.idBuyRTDt)).map(o => o.idBuyRTDt);
    for (const l of kept) {
      await tq()
        .input('dt', sql.Int, l.idBuyRTDt).input('qty', sql.Decimal(18, 6), l.qty).input('total', sql.Decimal(18, 4), l.total)
        .input('costNew', sql.Decimal(18, 4), meta.credit ? l.price : null)
        .input('totalNew', sql.Decimal(18, 4), meta.credit ? l.totalNew : null)
        .input('diff', sql.Decimal(18, 4), meta.credit ? l.diff : null)
        .input('idCause', sql.Int, l.idCause)
        .query(`UPDATE devsk.PkBuyRTDt SET AmountRT = @qty, Total = @total, CostUnitNew = @costNew, ToTalNew = @totalNew, TotalDiff = @diff,
                       idBuyRtCause = @idCause
                WHERE idBuyRTDt = @dt`);
    }
    for (const id of removed) {
      await tq().input('dt', sql.Int, id).input('idPs', sql.Int, req.idPs)
        .query(`UPDATE devsk.PkBuyRTDt SET stDel = '1', idPsDel = @idPs, DateDel = GETDATE() WHERE idBuyRTDt = @dt AND stDel IS NULL`);
    }
    for (const l of added) l.idBuyRTDt = await rtsInsertDt(tq, idBuyRT, l, meta.credit);

    // ตารางรอเบิก
    let waitCut = 'none';
    if (meta.returnGoods && wc) {
      await tq().input('w', sql.Int, wc.IdWaitCutMt).input('note', sql.NVarChar(1000), head.note)
        .query(`UPDATE devsk.WimWaitCutMt SET Note = @note WHERE IdWaitCutMt = @w`);
      for (const l of kept) {
        const u = await tq().input('w', sql.Int, wc.IdWaitCutMt).input('dt', sql.Int, l.idBuyRTDt).input('qty', sql.Decimal(18, 6), l.qty)
          .query(`UPDATE devsk.WimWaitCutDt SET AmountWait = @qty, AmountWaitBal = @qty, AmountWaitChange = @qty
                  WHERE IdWaitCutMt = @w AND idDtRef = @dt AND stDel IS NULL`);
        if (!u.rowsAffected[0]) await rtsInsertWaitCutDt(tq, wc.IdWaitCutMt, l.idBuyRTDt);
      }
      for (const id of removed) {
        await tq().input('w', sql.Int, wc.IdWaitCutMt).input('dt', sql.Int, id)
          .query(`UPDATE devsk.WimWaitCutDt SET stDel = 1 WHERE IdWaitCutMt = @w AND idDtRef = @dt AND stDel IS NULL`);
      }
      for (const l of added) await rtsInsertWaitCutDt(tq, wc.IdWaitCutMt, l.idBuyRTDt);
      waitCut = 'updated';
    } else if (meta.returnGoods) {
      await rtsInsertWaitCut(tq, idBuyRT, doc.idComp, req.idPs);   // เดิมเป็นประเภทไม่คืนของ
      waitCut = 'created';
    } else if (wc) {
      // เปลี่ยนเป็นประเภทไม่คืนของ: ยกเลิกรายการรอเบิกทั้งชุด
      await rtsCancelWaitCut(tq, wc.IdWaitCutMt, req.idPs);
      waitCut = 'cancelled';
    }

    await transaction.commit();
    transaction = null;
    res.json({ success: true, id: idBuyRT, docNo: doc.DocCode, waitCut });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return update error:', err);
    res.status(500).json({ success: false, message: 'บันทึกการแก้ไขไม่สำเร็จ — ระบบยกเลิกการบันทึกทั้งหมดแล้ว', detail: err.message });
  }
});

// ---------- ยกเลิกเอกสาร (สิทธิ์ supplier_return_cancel) ----------
// body: { reason (> 5 ตัวอักษร, ไม่เกิน 500), stamp }
//   ยกเลิกได้ทุกสถานะ จนกว่าคลังจะเริ่มตัดสต๊อกจริง (ประเภทคืนของ) / ประเภทไม่คืนของยกเลิกได้ตลอด (จนกว่าจะมีการดึงยอดลดหนี้ไปใช้ — rtsCreditUsed)
//   อนุมัติแล้ว (คลังยังไม่ตัดสต๊อก): ประเภทรับสินค้าทดแทน คืนยอดรับ PO ที่ขั้นอนุมัติหักไว้ (rtsAdjustPo -1)
//   ยกเลิกแล้วกู้คืนไม่ได้ — รายการ (PkBuyRTDt) ไม่ต้องแก้ ถือว่ายกเลิกตามหัวเอกสาร
const RTS_CANCEL_NOTE_MAX = 500;
app.post('/api/supplier-return/doc/:id/cancel', requireMenu(MENU_RTS_CANCEL), async (req, res) => {
  const idBuyRT = parseInt(req.params.id, 10);
  const reason = String((req.body || {}).reason || '').trim();
  const stamp = String((req.body || {}).stamp || '');
  if (!idBuyRT) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  if (reason.length <= 5 || reason === '0' || reason === '-') return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลการยกเลิกให้ชัดเจน (มากกว่า 5 ตัวอักษร)' });
  if (reason.length > RTS_CANCEL_NOTE_MAX) return res.status(400).json({ success: false, message: `เหตุผลการยกเลิกยาวได้ไม่เกิน ${RTS_CANCEL_NOTE_MAX} ตัวอักษร` });

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const tq = () => new sql.Request(transaction);
    const fail = async (status, body) => { await transaction.rollback(); transaction = null; return res.status(status).json({ success: false, ...body }); };

    const doc = (await tq().input('id', sql.Int, idBuyRT).query(`
      SELECT mt.DocCode, mt.idComp, mt.DateApv, mt.DateCancel, (SELECT stReplace FROM devsk.PkBuyRTType WHERE idTypeRT = mt.TypeRT) AS stReplace,
             (SELECT stCredit FROM devsk.PkBuyRTType WHERE idTypeRT = mt.TypeRT) AS stCredit,
             CONVERT(varchar(23), ISNULL(mt.DateEdit, mt.DateTs), 121) AS Stamp,
             CONVERT(varchar(16), ISNULL(mt.DateEdit, mt.DateTs), 120) AS StampText,
             (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = ISNULL(mt.idPsEdit, mt.idPsTs)) AS StampBy
      FROM devsk.PkBuyRTMt mt WITH (UPDLOCK, ROWLOCK) WHERE mt.idBuyRT = @id`)).recordset[0];
    if (!doc) return fail(404, { message: 'ไม่พบเอกสาร' });
    if (!hasComp(req.access, doc.idComp)) return fail(403, { message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้' });
    if (doc.DateCancel) return fail(409, { code: 'DOC_CHANGED', message: `เอกสาร ${doc.DocCode} ถูกยกเลิกไปแล้ว` });
    if (doc.Stamp !== stamp) {
      return fail(409, { code: 'DOC_CHANGED', message: `เอกสาร ${doc.DocCode} ถูกแก้ไขโดย ${doc.StampBy || '-'} เมื่อ ${doc.StampText} หลังจากที่เปิดหน้าจอนี้ — กรุณาตรวจสอบเอกสารอีกครั้ง` });
    }

    const wc = (await tq().input('id', sql.Int, idBuyRT).query(`
      SELECT wm.IdWaitCutMt,
             (SELECT COUNT(*) FROM devsk.WimWaitCutDt wd WHERE wd.IdWaitCutMt = wm.IdWaitCutMt AND wd.stDel IS NULL
                AND (wd.stWait = 1 OR EXISTS (SELECT 1 FROM devsk.WimCutStockDtMain c WHERE c.idWaitCutDt = wd.idWaitCutDt AND c.DateCancel IS NULL AND c.stDel IS NULL))) AS CutRows
      FROM devsk.WimWaitCutMt wm WITH (UPDLOCK, ROWLOCK)
      WHERE ${RTS_ACTIVE_WAITCUT} AND wm.IdMt = @id`)).recordset;
    // คลังตัดเบิกแล้ว (ราย Dt) — ยกเลิกการตัดเบิกแล้วกลับมายกเลิกเอกสารได้
    if (wc.some(w => w.CutRows > 0)) return fail(400, { message: 'เอกสารนี้ยกเลิกไม่ได้ เนื่องจากมีการเบิกสินค้าออกจากคลังไปแล้ว' });
    if (await rtsCreditUsed(tq, idBuyRT)) return fail(400, { message: 'เอกสารนี้ยกเลิกไม่ได้ เนื่องจากยอดลดหนี้ถูกนำไปใช้แล้ว' });
    // ลดหนี้ที่อนุมัติแล้ว = ปรับต้นทุน Lot แล้ว (ไม่มีการคืนต้นทุน) — ถ้าผิดให้ฝ่ายบัญชีแก้ต้นทุนเอง
    if (doc.DateApv && doc.stCredit === '1') return fail(400, { message: `เอกสาร ${doc.DocCode} อนุมัติแล้วและปรับปรุงต้นทุน Lot แล้ว — ยกเลิกไม่ได้ (ถ้าต้นทุนผิดให้ฝ่ายบัญชีแก้ไขต้นทุน)` });
    if (doc.DateApv && doc.stReplace === '1') {
      try { await rtsAdjustPo(tq, idBuyRT, -1); }
      catch (e) { if (e instanceof RtsUnitError) return fail(400, { message: `ยกเลิกไม่ได้ — คืนยอด PO ไม่ได้: ${e.message}` }); throw e; }
    }

    await tq().input('id', sql.Int, idBuyRT).input('idPs', sql.Int, req.idPs).input('note', sql.VarChar(RTS_CANCEL_NOTE_MAX), reason)
      .query(`UPDATE devsk.PkBuyRTMt SET idPsCancel = @idPs, DateCancel = GETDATE(), CancelNote = @note WHERE idBuyRT = @id`);
    for (const w of wc) await rtsCancelWaitCut(tq, w.IdWaitCutMt, req.idPs);

    await transaction.commit();
    transaction = null;
    res.json({ success: true, id: idBuyRT, docNo: doc.DocCode, waitCutCancelled: wc.length });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return cancel error:', err);
    res.status(500).json({ success: false, message: 'ยกเลิกเอกสารไม่สำเร็จ — ระบบไม่ได้เปลี่ยนแปลงข้อมูล', detail: err.message });
  }
});

// ---------- เปิดเอกสารใบเดียว: หัว + รายการ พร้อมยอดล่าสุดของแต่ละ Lot ----------
//   onHand = คงเหลือ (view) + ยอดรอเบิกของเอกสารนี้ (ให้แก้จำนวนได้ถึงยอดที่มีจริง) / usedQty = ยอดลดหนี้ของเอกสารอื่น
//   stamp = DateEdit (ว่าง = DateTs) ใช้ตรวจว่ามีคนแก้ไปก่อนตอนบันทึก
app.get('/api/supplier-return/doc/:id', requireMenu(MENU_RTS_VIEW), async (req, res) => {
  const idBuyRT = parseInt(req.params.id, 10);
  if (!idBuyRT) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  try {
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, idBuyRT).query(`
      SELECT mt.idBuyRT, mt.DocCode, mt.idComp, mt.idSup, LTRIM(RTRIM(s.SupName)) AS SupName, mt.TypeRT, mt.idPsRT, pRT.PsName AS PsNameRT, pRT.PsFullName AS PsFullRT,
             CONVERT(varchar(10), mt.DateRetrun, 23) AS DateRetrun, mt.Note, mt.DateAccept, mt.DateCheck, mt.DateCheck2, mt.DateApv, mt.DateCancel, mt.DateSendBack,
             CONVERT(varchar(23), ISNULL(mt.DateEdit, mt.DateTs), 121) AS Stamp, mt.idPsCheck, mt.CancelNote, mt.SendBackNote, mt.stNoCostAdj,
             CONVERT(varchar(10), mt.DateDoc, 23) AS DateDoc, c.CompName, c.CompCode,
             c.CompNameEng, c.Address AS CompAddress, c.AddressEng AS CompAddressEng, c.PostCode AS CompPostCode, c.Tel AS CompTel, c.Fax AS CompFax,
             c.TaxCode AS CompTaxCode, LTRIM(RTRIM(pvc.ProvinceName)) AS CompProvince,
             LTRIM(RTRIM(s.SupAddress)) AS SupAddress, LTRIM(RTRIM(s.ProvinceName)) AS SupProvince, LTRIM(RTRIM(s.SupPhone)) AS SupPhone, LTRIM(RTRIM(s.TaxID)) AS SupTaxID,
             CONVERT(varchar(16), mt.DateTs, 120) AS TxTs, pTs.PsName AS PsTs, CONVERT(varchar(16), mt.DateEdit, 120) AS TxEdit, pEd.PsName AS PsEdit,
             CONVERT(varchar(16), mt.DateAccept, 120) AS TxAccept, pAc.PsName AS PsAccept, CONVERT(varchar(16), mt.DateCheck, 120) AS TxCheck, pC1.PsName AS PsCheck,
             CONVERT(varchar(16), mt.DateCheck2, 120) AS TxCheck2, pC2.PsName AS PsCheck2, CONVERT(varchar(16), mt.DateApv, 120) AS TxApv, pAp.PsName AS PsApv,
             CONVERT(varchar(16), mt.DateCancel, 120) AS TxCancel, pCa.PsName AS PsCancel, CONVERT(varchar(16), mt.DateSendBack, 120) AS TxSendBack, pSb.PsName AS PsSendBack,
             pTs.PsFullName AS FullTs, pAc.PsFullName AS FullAccept, pC1.PsFullName AS FullCheck, pC2.PsFullName AS FullCheck2, pAp.PsFullName AS FullApv,
             mt.idPsTs, mt.idPsAccept, mt.idPsCheck2, mt.idPsApv, pTs.PositionName AS PosTs, pAc.PositionName AS PosAccept, pC1.PositionName AS PosCheck,
             pC2.PositionName AS PosCheck2, pAp.PositionName AS PosApv
      FROM devsk.PkBuyRTMt mt WITH (NOLOCK)
      LEFT JOIN PchInvAndProject.dbo.vSupplier s WITH (NOLOCK) ON s.idSup = mt.idSup
      LEFT JOIN PchInvAndProject.dbo.dCompany c WITH (NOLOCK) ON c.idComp = mt.idComp
      LEFT JOIN PchInvAndProject.dbo.dProvinceFix pvc WITH (NOLOCK) ON pvc.idProvince = c.idProvince
      OUTER APPLY (SELECT TOP 1 v.PsName, v.PsFullName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsRT) pRT
      OUTER APPLY (SELECT TOP 1 v.PsName, v.PsFullName, v.PositionName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsTs) pTs
      OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsEdit) pEd
      OUTER APPLY (SELECT TOP 1 v.PsName, v.PsFullName, v.PositionName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsAccept) pAc
      OUTER APPLY (SELECT TOP 1 v.PsName, v.PsFullName, v.PositionName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsCheck) pC1
      OUTER APPLY (SELECT TOP 1 v.PsName, v.PsFullName, v.PositionName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsCheck2) pC2
      OUTER APPLY (SELECT TOP 1 v.PsName, v.PsFullName, v.PositionName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsApv) pAp
      OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsCancel) pCa
      OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsSendBack) pSb
      WHERE mt.idBuyRT = @id;

      SELECT dt.idBuyRTDt, dt.idRefLot, whr.idLot, lm.LotNo, dt.idInvMain, i.InvName, g.InvGroupName,
             whr.idWh, w.idParent0, ISNULL(NULLIF(LTRIM(RTRIM(w.short_lock)), ''), w.WareHouseName) AS StoreName,
             dt.idPoDt, bm.DocCode AS POCode, bd.Amount AS POQty,
             dt.idRecDt, rm.DocCode AS RecCode, NULLIF(LTRIM(RTRIM(rm.DocRef)), '') AS DocRef, CONVERT(varchar(10), rm.DateRec, 23) AS DateRec,
             whr.AmountRec AS RcvQty, ISNULL(rs.Amount, 0) + ISNULL(own.Qty, 0) AS OnHand,
             ISNULL(oth.Pending, 0) AS PendingQty, ISNULL(oth.Used, 0) AS UsedQty,
             dt.AmountRT, dt.idUnit, u.UnitName, dt.CostPerUnit, dt.CostUnitNew, dt.idBuyRtCause, cs.BuyRtCause,
             dt.PureGene, dt.GrowPaper, dt.GrowMedia, dt.GrowAA, lm.CostPerUnit AS LotCost, adj.AdjFrom, adj.AdjTo, adj.AdjDoc,
             STUFF((SELECT DISTINCT ', ' + m3.DocCode FROM devsk.PkBuyRTDt d3 WITH (NOLOCK)
                    JOIN devsk.dInvLotRefWh w3 WITH (NOLOCK) ON w3.idRefLot = d3.idRefLot
                    JOIN devsk.PkBuyRTMt m3 WITH (NOLOCK) ON m3.idBuyRT = d3.idBuyRT
                    JOIN devsk.PkBuyRTType t3 WITH (NOLOCK) ON t3.idTypeRT = m3.TypeRT AND t3.stCredit = '1'
                    WHERE w3.idLot = whr.idLot AND d3.stDel IS NULL AND m3.DateCancel IS NULL AND m3.DateApv IS NULL AND m3.idBuyRT <> dt.idBuyRT
                    FOR XML PATH('')), 1, 2, '') AS OtherCredit
      FROM devsk.PkBuyRTDt dt WITH (NOLOCK)
      LEFT JOIN devsk.dInvLotRefWh whr WITH (NOLOCK) ON whr.idRefLot = dt.idRefLot
      LEFT JOIN devsk.dInvLotMain lm WITH (NOLOCK) ON lm.idLot = whr.idLot
      LEFT JOIN devsk.dInventoryMain i WITH (NOLOCK) ON i.idInvMain = dt.idInvMain
      LEFT JOIN devsk.dInvGroup g WITH (NOLOCK) ON g.idInvGroup = i.idInvGroup
      LEFT JOIN dbo.ssWarehouse w WITH (NOLOCK) ON w.idWh = whr.idWh
      LEFT JOIN devsk.dInvUnit u WITH (NOLOCK) ON u.idUnit = dt.idUnit
      LEFT JOIN devsk.PkBuyRTCause cs WITH (NOLOCK) ON cs.idBuyRtCause = dt.idBuyRtCause
      LEFT JOIN devsk.PKPOBuyDt bd WITH (NOLOCK) ON bd.idPODt = dt.idPoDt
      LEFT JOIN devsk.PKPOBuyMt bm WITH (NOLOCK) ON bm.idPOTs = bd.idPOTs
      LEFT JOIN devsk.PKPoRecDt rd WITH (NOLOCK) ON rd.idPkPORecDt = dt.idRecDt
      LEFT JOIN devsk.PKPoRecMt rm WITH (NOLOCK) ON rm.idPkPORec = rd.idPkPORec
      LEFT JOIN devsk.vInvLotRefWh_RStock rs ON rs.idRefLot = dt.idRefLot
      OUTER APPLY (SELECT SUM(wd.AmountWaitChange) AS Qty FROM devsk.WimWaitCutDt wd
                   JOIN devsk.WimWaitCutMt wm ON wm.IdWaitCutMt = wd.IdWaitCutMt
                   WHERE ${RTS_ACTIVE_WAITCUT} AND wm.IdMt = dt.idBuyRT
                     AND wd.stWait IS NULL AND wd.stDel IS NULL AND wd.idRefLot = dt.idRefLot) own
      OUTER APPLY (SELECT SUM(CASE WHEN m2.DateApv IS NULL AND t2.stReturnGoods = '1' THEN d2.AmountRT ELSE 0 END) AS Pending, SUM(d2.AmountRT) AS Used
                   FROM devsk.PkBuyRTDt d2 WITH (NOLOCK)
                   JOIN devsk.PkBuyRTMt m2 WITH (NOLOCK) ON m2.idBuyRT = d2.idBuyRT
                   LEFT JOIN devsk.PkBuyRTType t2 WITH (NOLOCK) ON t2.idTypeRT = m2.TypeRT
                   WHERE d2.idRefLot = dt.idRefLot AND d2.stDel IS NULL AND m2.DateCancel IS NULL AND m2.idBuyRT <> dt.idBuyRT) oth
      OUTER APPLY (SELECT TOP 1 CAST(lc.Cost_Old AS decimal(18,4)) AS AdjFrom, CAST(lc.Cost_New AS decimal(18,4)) AS AdjTo, mx.DocCode AS AdjDoc
                   FROM devsk.WimLogCost lc WITH (NOLOCK) JOIN devsk.PkBuyRTMt mx WITH (NOLOCK) ON mx.idBuyRT = lc.RefId
                   WHERE lc.idLot = whr.idLot AND lc.RefTb = 'PkBuyRTMt' AND ISNULL(lc.Cost_Old, -1) <> ISNULL(lc.Cost_New, -1) ORDER BY lc.idLog DESC) adj
      WHERE dt.idBuyRT = @id AND dt.stDel IS NULL
      ORDER BY dt.idBuyRTDt;`);
    const m = r.recordsets[0][0];
    if (!m) return res.status(404).json({ success: false, message: 'ไม่พบเอกสาร' });
    if (!hasComp(req.access, m.idComp)) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้' });
    const num = (v) => (v == null ? null : Number(v));
    res.json({
      success: true,
      data: {
        id: m.idBuyRT, docNo: m.DocCode, comp: m.idComp, sup: m.idSup, supName: m.SupName, type: m.TypeRT,
        operator: m.idPsRT, operatorName: m.PsNameRT, operatorFull: (m.PsFullRT || '').trim(), noCostAdj: m.stNoCostAdj === '1', returnDate: m.DateRetrun, remark: m.Note || '',
        status: rtsStatus(m), stamp: m.Stamp, docDate: m.DateDoc, compName: m.CompName, compCode: m.CompCode,
        // หัวใบเอกสาร: บริษัท (ไทย / อังกฤษ / ที่อยู่ / โทร / แฟกซ์ / เลขผู้เสียภาษี) + Supplier (ที่อยู่ / โทร / เลขผู้เสียภาษี)
        compInfo: { nameEn: m.CompNameEng || '', address: m.CompAddress || '', addressEn: m.CompAddressEng || '', province: m.CompProvince || '',
                    postCode: m.CompPostCode || '', tel: m.CompTel || '', fax: m.CompFax || '', taxId: m.CompTaxCode || '' },
        supInfo: { address: m.SupAddress || '', province: m.SupProvince || '', phone: m.SupPhone || '', taxId: m.SupTaxID || '' },
        steps: { create: rtsStep(m.PsTs, m.TxTs, m.idPsTs, m.PosTs, m.FullTs), ack: rtsStep(m.PsAccept, m.TxAccept, m.idPsAccept, m.PosAccept, m.FullAccept),
                 chk1: rtsStep(m.PsCheck, m.TxCheck, m.idPsCheck, m.PosCheck, m.FullCheck), chk2: rtsStep(m.PsCheck2, m.TxCheck2, m.idPsCheck2, m.PosCheck2, m.FullCheck2),
                 appr: rtsStep(m.PsApv, m.TxApv, m.idPsApv, m.PosApv, m.FullApv) },
        edit: rtsStep(m.PsEdit, m.TxEdit),
        cancel: m.TxCancel ? { by: m.PsCancel || '-', at: m.TxCancel, reason: m.CancelNote || '' } : null,
        sendBack: m.SendBackNote ? { by: m.PsSendBack || '-', at: m.TxSendBack || null, reason: m.SendBackNote, pending: !!m.TxSendBack } : null,
        check1By: m.idPsCheck,
        items: r.recordsets[1].map(x => ({
          idBuyRTDt: x.idBuyRTDt, key: `${x.idRefLot}-${x.idPoDt}`, idRefLot: x.idRefLot, idLot: x.idLot, lot: x.LotNo, idInvMain: x.idInvMain,
          name: x.InvName, type: x.InvGroupName || '-', idWh: x.idWh, mainWh: x.idParent0, store: x.StoreName,
          idPODt: x.idPoDt, po: x.POCode, poQty: num(x.POQty), idRecDt: x.idRecDt, rec: x.RecCode, inv: x.DocRef, rcvDate: x.DateRec,
          rcvQty: num(x.RcvQty) || 0, onHand: num(x.OnHand) || 0, pendingQty: num(x.PendingQty) || 0, usedQty: num(x.UsedQty) || 0,
          idUnit: x.idUnit, unit: x.UnitName, cost: num(x.CostPerUnit),
          gp: num(x.PureGene), gpPaper: num(x.GrowPaper), gpMedia: num(x.GrowMedia), aa: num(x.GrowAA),
          qty: num(x.AmountRT) || 0, price: num(x.CostUnitNew) || 0, causeId: x.idBuyRtCause, reason: x.BuyRtCause || '',
          lotCost: num(x.LotCost), otherCredit: x.OtherCredit || '',
          creditAdj: x.AdjDoc ? { doc: x.AdjDoc, from: num(x.AdjFrom), to: num(x.AdjTo) } : null
        }))
      }
    });
  } catch (err) {
    console.error('Supplier return doc error:', err);
    res.status(500).json({ success: false, message: 'โหลดเอกสารไม่สำเร็จ', detail: err.message });
  }
});

// ---------- รายการเอกสาร (ใช้ร่วม: หน้ารายการตามช่วงวันที่ / หน้ารับทราบ-ตรวจสอบ-อนุมัติ) ----------
// setup(request) ผูก parameter แล้วคืนเงื่อนไข SQL เพิ่มเติม (ขึ้นต้นด้วย AND) — จำกัดบริษัทตามสิทธิ์ (compFilter) เสมอ
// ส่งหัวเอกสาร + รายการสินค้าไปพร้อมกัน (หน้าเว็บกรอง Supplier / เลขที่ / PO / Lot เอง และขยายดูรายการได้ทันที)
async function rtsDocList(access, setup) {
  const pool = await poolPromise;
  const request = pool.request();
  const where = setup(request) || '';
  const compSql = compFilter(access, request, 'mt.idComp');

  const r = await request.query(`
    SELECT mt.idBuyRT
    INTO #rt
    FROM devsk.PkBuyRTMt mt WITH (NOLOCK)
    WHERE 1 = 1 ${where}
      ${compSql};

    SELECT mt.idBuyRT, mt.DocCode, CONVERT(varchar(10), mt.DateDoc, 23) AS DateDoc, CONVERT(varchar(10), mt.DateRetrun, 23) AS DateRetrun, mt.TypeRT, mt.idComp, c.CompName, c.CompCode,
           mt.idSup, LTRIM(RTRIM(s.SupName)) AS SupName, mt.idPsRT, pRT.PsName AS PsNameRT, mt.Note,
           mt.TotalValue, mt.TotalBuy, mt.TotalDiff,
           CONVERT(varchar(16), mt.DateTs, 120) AS DateTs, pTs.PsName AS PsNameTs, CONVERT(varchar(16), mt.DateEdit, 120) AS DateEdit, pEd.PsName AS PsNameEdit,
           CONVERT(varchar(16), mt.DateAccept, 120) AS DateAccept, pAc.PsName AS PsNameAccept, CONVERT(varchar(16), mt.DateCheck, 120) AS DateCheck, pC1.PsName AS PsNameCheck,
           CONVERT(varchar(16), mt.DateCheck2, 120) AS DateCheck2, pC2.PsName AS PsNameCheck2, CONVERT(varchar(16), mt.DateApv, 120) AS DateApv, pAp.PsName AS PsNameApv,
           CONVERT(varchar(16), mt.DateCancel, 120) AS DateCancel, pCa.PsName AS PsNameCancel, mt.CancelNote,
           CONVERT(varchar(23), ISNULL(mt.DateEdit, mt.DateTs), 121) AS Stamp, mt.idPsCheck,
           mt.SendBackNote, CONVERT(varchar(16), mt.DateSendBack, 120) AS DateSendBack, pSb.PsName AS PsNameSendBack, mt.stNoCostAdj
    FROM devsk.PkBuyRTMt mt WITH (NOLOCK)
    LEFT JOIN PchInvAndProject.dbo.dCompany c WITH (NOLOCK) ON c.idComp = mt.idComp
    LEFT JOIN PchInvAndProject.dbo.vSupplier s WITH (NOLOCK) ON s.idSup = mt.idSup
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsRT) pRT
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsTs) pTs
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsEdit) pEd
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsAccept) pAc
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsCheck) pC1
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsCheck2) pC2
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsApv) pAp
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsCancel) pCa
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WITH (NOLOCK) WHERE v.idPs = mt.idPsSendBack) pSb
    WHERE mt.idBuyRT IN (SELECT idBuyRT FROM #rt)
    ORDER BY mt.DateDoc DESC, mt.DocCode DESC;

    -- รายการ: Lot / คลัง จาก idRefLot (dInvLotRefWh) — ชื่อคลังเต็ม (รวมคลังแม่ทุกชั้น) จาก ssWarehouse.short_lock / PO จาก idPoDt / ใบรับ (เลขที่รับ + ใบส่งของ) จาก idRecDt หรือใบรับแรกของ PO + Lot นั้น
    SELECT dt.idBuyRTDt, dt.idBuyRT, dt.idRefLot, dt.idInvMain, i.InvName, lm.LotNo,
           ISNULL(NULLIF(LTRIM(RTRIM(w.short_lock)), ''), w.WareHouseName) AS StoreName,
           po.DocCode AS POCode, rec.DocCode AS RecCode, NULLIF(LTRIM(RTRIM(rec.DocRef)), '') AS DocRef,
           dt.AmountRT, u.UnitName, dt.CostPerUnit, dt.Total, dt.CostUnitNew, dt.ToTalNew, dt.TotalDiff,
           dt.idBuyRtCause, cs.BuyRtCause, dt.PureGene, dt.GrowPaper, dt.GrowMedia, dt.GrowAA
    FROM devsk.PkBuyRTDt dt WITH (NOLOCK)
    LEFT JOIN devsk.dInventoryMain i WITH (NOLOCK) ON i.idInvMain = dt.idInvMain
    LEFT JOIN devsk.dInvUnit u WITH (NOLOCK) ON u.idUnit = dt.idUnit
    LEFT JOIN devsk.dInvLotRefWh wh WITH (NOLOCK) ON wh.idRefLot = dt.idRefLot
    LEFT JOIN devsk.dInvLotMain lm WITH (NOLOCK) ON lm.idLot = wh.idLot
    LEFT JOIN dbo.ssWarehouse w WITH (NOLOCK) ON w.idWh = wh.idWh
    LEFT JOIN devsk.PkBuyRTCause cs WITH (NOLOCK) ON cs.idBuyRtCause = dt.idBuyRtCause
    OUTER APPLY (SELECT TOP 1 b.DocCode FROM devsk.PKPOBuyDt bd WITH (NOLOCK)
                 JOIN devsk.PKPOBuyMt b WITH (NOLOCK) ON b.idPOTs = bd.idPOTs
                 WHERE bd.idPODt = dt.idPoDt) po
    OUTER APPLY (SELECT TOP 1 rm.DocCode, rm.DocRef FROM devsk.PKPoRecDt rd WITH (NOLOCK)
                 JOIN devsk.PKPoRecMt rm WITH (NOLOCK) ON rm.idPkPORec = rd.idPkPORec AND rm.idPsCancel IS NULL
                 WHERE (dt.idRecDt IS NOT NULL AND rd.idPkPORecDt = dt.idRecDt)
                    OR (dt.idRecDt IS NULL AND rd.idPODt = dt.idPoDt AND rd.idLotMain = wh.idLot)
                 ORDER BY CASE WHEN rd.idPkPORecDt = dt.idRecDt THEN 0 ELSE 1 END, rm.DateRec) rec
    WHERE dt.idBuyRT IN (SELECT idBuyRT FROM #rt) AND dt.stDel IS NULL
    ORDER BY dt.idBuyRT, dt.idBuyRTDt;`);

  const items = new Map();
  r.recordsets[1].forEach(d => {
    if (!items.has(d.idBuyRT)) items.set(d.idBuyRT, []);
    items.get(d.idBuyRT).push({
      id: d.idBuyRTDt, idRefLot: d.idRefLot, idInvMain: d.idInvMain, name: d.InvName, lot: d.LotNo, store: d.StoreName,
      po: d.POCode, rec: d.RecCode, inv: d.DocRef,
      qty: Number(d.AmountRT) || 0, unit: d.UnitName, cost: Number(d.CostPerUnit) || 0,
      price: Number(d.CostUnitNew) || 0, causeId: d.idBuyRtCause, reason: d.BuyRtCause || '',
      gp: d.PureGene, gpPaper: d.GrowPaper, gpMedia: d.GrowMedia, aa: d.GrowAA
    });
  });

  return r.recordsets[0].map(m => ({
    id: m.idBuyRT, docNo: m.DocCode, docDate: m.DateDoc, returnDate: m.DateRetrun, type: m.TypeRT,
    comp: m.idComp, compName: m.CompName, compCode: m.CompCode,
    sup: m.idSup, supName: m.SupName, operator: m.idPsRT, operatorName: m.PsNameRT, remark: m.Note || '', noCostAdj: m.stNoCostAdj === '1',
    totalValue: m.TotalValue, totalBuy: m.TotalBuy, totalDiff: m.TotalDiff,
    status: rtsStatus(m),
    steps: {
      create: rtsStep(m.PsNameTs, m.DateTs),
      ack: rtsStep(m.PsNameAccept, m.DateAccept),
      chk1: rtsStep(m.PsNameCheck, m.DateCheck),
      chk2: rtsStep(m.PsNameCheck2, m.DateCheck2),
      appr: rtsStep(m.PsNameApv, m.DateApv)
    },
    edit: rtsStep(m.PsNameEdit, m.DateEdit),
    cancel: m.DateCancel ? { by: m.PsNameCancel || '-', at: m.DateCancel, reason: m.CancelNote || '' } : null,
    sendBack: m.SendBackNote ? { by: m.PsNameSendBack || '-', at: m.DateSendBack || null, reason: m.SendBackNote, pending: !!m.DateSendBack } : null,
    check1By: m.idPsCheck,
    stamp: m.Stamp,
    items: items.get(m.idBuyRT) || []
  }));
}

// รายการเอกสารส่งคืนตามช่วงวันที่เอกสาร (from / to = yyyy-mm-dd) — เฉพาะบริษัทที่มีสิทธิ์ / idComp = กรองบริษัทเดียว
app.get('/api/supplier-return/list', requireMenu(MENU_RTS, { companyParam: 'idComp' }), async (req, res) => {
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const { from, to } = req.query;
  const idComp = parseInt(req.query.idComp, 10) || null;
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ success: false, message: 'ช่วงวันที่ไม่ถูกต้อง' });
  try {
    const data = await rtsDocList(req.access, (request) => {
      request.input('from', sql.Date, from).input('to', sql.Date, to);
      if (idComp) request.input('idComp', sql.Int, idComp);
      // เอกสารที่ยังไม่จบ (ส่งกลับแก้ไข / รอรับทราบ / ตรวจสอบ / อนุมัติ) แสดงเสมอไม่ว่าเลือกช่วงวันที่ไหน — ช่วงวันที่ใช้กับเอกสารที่จบแล้ว (อนุมัติ / ยกเลิก)
      return `AND ((mt.DateDoc >= @from AND mt.DateDoc < DATEADD(day, 1, @to)) OR (mt.DateApv IS NULL AND mt.DateCancel IS NULL)) ${idComp ? 'AND mt.idComp = @idComp' : ''}`;
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Supplier return list error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการส่งคืนสินค้าไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- รับทราบ / ตรวจสอบ / อนุมัติ เอกสารส่งคืน ----------
// ==================================================================
// 3 เมนู ใช้หน้าเว็บเดียวกัน (/supplier-return-approve?step=ack|check|approve) — สิทธิ์แยกกัน
//   check = ตรวจสอบ 1 + 2: คนแรกที่กดลงตรวจสอบ 1 / คนถัดไป (ต้องคนละคน) ลงตรวจสอบ 2
//   คนเดียวทำหลายขั้นได้ (ตามหน้างาน) ยกเว้นตรวจสอบ 1 กับ 2 ต้องคนละคน / ทุกประเภทต้องผ่านครบ 4 ขั้น
//   เช็คสถานะซ้ำที่ server ทุกครั้งที่กด (2 คนกดพร้อมกัน / เปิดหน้าค้าง / กดจากลิงก์เก่า)
const RTS_STEPS = {
  ack:     { menu: MENU_RTS_ACK,     name: 'รับทราบ', waits: (st) => st === 1,
             pending: 'AND mt.DateCancel IS NULL AND mt.DateAccept IS NULL AND mt.DateSendBack IS NULL' },
  check:   { menu: MENU_RTS_CHECK,   name: 'ตรวจสอบ', waits: (st) => st === 2 || st === 3,
             pending: 'AND mt.DateCancel IS NULL AND mt.DateAccept IS NOT NULL AND mt.DateCheck2 IS NULL' },
  approve: { menu: MENU_RTS_APPROVE, name: 'อนุมัติ', waits: (st) => st === 4,
             pending: 'AND mt.DateCancel IS NULL AND mt.DateCheck2 IS NOT NULL AND mt.DateApv IS NULL' }
};
const RTS_STATUS_NAME = { 0: 'ส่งกลับแก้ไข', 1: 'รอรับทราบ', 2: 'รอตรวจสอบ 1', 3: 'รอตรวจสอบ 2', 4: 'รออนุมัติ', 5: 'อนุมัติแล้ว', 9: 'ยกเลิกแล้ว' };
const rtsStepOf = (req) => RTS_STEPS[String((req.query.step || (req.body && req.body.step) || '')).trim()] ? String(req.query.step || req.body.step).trim() : null;

// เอกสารที่รอขั้นนี้ (เฉพาะบริษัทที่มีสิทธิ์)
app.get('/api/supplier-return/pending', requireMenu([MENU_RTS_ACK, MENU_RTS_CHECK, MENU_RTS_APPROVE]), async (req, res) => {
  const step = rtsStepOf(req);
  if (!step) return res.status(400).json({ success: false, message: 'ขั้นตอนไม่ถูกต้อง' });
  if (!hasMenu(req.access, RTS_STEPS[step].menu)) return res.status(403).json({ success: false, message: `ไม่มีสิทธิ์${RTS_STEPS[step].name}เอกสารส่งคืนสินค้า Supplier` });
  try {
    // รอตรวจสอบ: ไม่แสดงใบที่ผู้ใช้คนนี้ตรวจสอบไปแล้ว (รอผู้ตรวจสอบอีกท่าน ไม่ใช่งานของเขาแล้ว)
    const data = await rtsDocList(req.access, (request) => {
      if (step !== 'check') return RTS_STEPS[step].pending;
      request.input('me', sql.Int, req.idPs);
      return `${RTS_STEPS[step].pending} AND NOT (mt.DateCheck IS NOT NULL AND mt.idPsCheck = @me)`;
    });
    res.json({ success: true, data, me: req.idPs });
  } catch (err) {
    console.error('Supplier return pending error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการรอดำเนินการไม่สำเร็จ', detail: err.message });
  }
});

// ---------- แปลงหน่วย (หักยอดรับ PO ตอนอนุมัติ / คืนยอดตอนยกเลิกเอกสารที่อนุมัติแล้ว) ----------
//   ยอดคืนเก็บเป็นหน่วยของ Lot → แปลงเป็นหน่วยของ PO (PKPOBuyDt.idUnitNew) / หน่วยของรายการรอรับ (WimWaitRecDt.idUnitNew)
//   ผ่านหน่วยหลักของสินค้า (dInventoryMain.idUnit): กรัม ↔ กิโลกรัม แปลงได้เสมอ / หน่วยอื่นใช้ dInvUnitSub
//   (idUnit = หน่วยหลัก, idSubUnit = หน่วยรอง, AmtMainperSub = จำนวนหน่วยหลักต่อ 1 หน่วยรอง)
//   แปลงไม่ได้ = null → ไม่ให้อนุมัติ (ให้ตั้งค่าหน่วยรองก่อน)
function rtsConvertUnit(qty, from, to, main, subs) {
  if (from === to) return qty;
  const perMain = (u) => {   // จำนวนหน่วยหลักต่อ 1 หน่วย u
    if (u === main) return 1;
    if (GRAM_FACTOR[u] && GRAM_FACTOR[main]) return GRAM_FACTOR[u] / GRAM_FACTOR[main];
    const s = subs.get(u);
    return s > 0 ? s : null;
  };
  const a = perMain(from), b = perMain(to);
  if (a != null && b != null) return qty * a / b;
  if (GRAM_FACTOR[from] && GRAM_FACTOR[to]) return qty * GRAM_FACTOR[from] / GRAM_FACTOR[to];
  return null;
}
class RtsUnitError extends Error {}
class RtsCostError extends Error {}

// ปรับปรุงต้นทุน Lot ตอนอนุมัติเอกสารที่มีลดหนี้ (ไม่ส่งคืน-ลดหนี้ / ส่งคืน-ลดหนี้) — ต้นทุนเฉลี่ยตามหลัก ERP
//   H = จำนวนในคลังจริงของ Lot (ทุกคลัง รวมของที่จองเบิกไว้แต่ยังไม่ตัก — ตักเบิกใช้ต้นทุน Lot ณ ตอนตัก) หักของที่เอกสารใบนี้ส่งคืน
//   Q = จำนวนลดหนี้ของ Lot, C = ต้นทุนปัจจุบัน, P = ราคาใหม่, ยอดลดหนี้ = Σ จำนวน × (ต้นทุนในเอกสาร − P)
//     H ≤ 0 หรือ Q ≥ H → ต้นทุนใหม่ = P (ลดหนี้ครอบคลุมของที่เหลือ / ของหมดแล้ว)
//     Q < H           → ต้นทุนใหม่ = (C × H − ยอดลดหนี้) ÷ H (เฉลี่ยถ่วงน้ำหนัก)
//   ไม่ปรับ: ส่งคืน-ลดหนี้ราคาใหม่ 0 (คืนเงินเต็ม) / เลือก "ลดหนี้เฉพาะส่วนที่ใช้ไปแล้ว" / ต้นทุนเท่าเดิม
//   ผลติดลบ / มากกว่าต้นทุนเดิม = ไม่ให้อนุมัติ / Lot เดียวกันราคาใหม่ไม่เท่ากัน = ไม่ให้อนุมัติ
//   ทุก Lot บันทึก WimLogCost (RefTb / RefId = เอกสาร, RefNote = C / H / Q / P + สูตร) — RefNote เป็น varchar ใช้ -> แทนลูกศร
async function rtsAdjustCost(tq, idBuyRT, docCode, returnGoods, noCostAdj, idPs) {
  const rows = (await tq().input('id', sql.Int, idBuyRT).query(`
    SELECT whr.idLot, lm.LotNo, lm.CostPerUnit AS CostNow, lm.NoteCost, dt.CostUnitNew, dt.CostPerUnit AS DocCost, dt.AmountRT, u.UnitName,
           (SELECT SUM(w2.Amount) FROM devsk.dInvLotRefWh w2 WHERE w2.idLot = whr.idLot) AS LotStock
    FROM devsk.PkBuyRTDt dt
    JOIN devsk.dInvLotRefWh whr ON whr.idRefLot = dt.idRefLot
    JOIN devsk.dInvLotMain lm WITH (UPDLOCK, ROWLOCK) ON lm.idLot = whr.idLot
    LEFT JOIN devsk.dInvUnit u ON u.idUnit = dt.idUnit
    WHERE dt.idBuyRT = @id AND dt.stDel IS NULL`)).recordset;
  const r4 = (v) => Math.round(Number(v) * 10000) / 10000;
  const n6 = (v) => Number(Number(v).toFixed(6));
  const lots = new Map();
  for (const x of rows) {
    const k = String(x.idLot);
    const g = lots.get(k) || { idLot: x.idLot, lot: (x.LotNo || '').trim(), costNow: x.CostNow == null ? null : r4(x.CostNow), note: x.NoteCost,
                               stock: Number(x.LotStock) || 0, prices: new Set(), qty: 0, credit: 0, unit: x.UnitName || '' };
    const p = r4(x.CostUnitNew || 0), q = Number(x.AmountRT) || 0;
    g.prices.add(p);
    g.qty += q;
    g.credit += q * ((x.DocCost == null ? Number(g.costNow) || 0 : Number(x.DocCost)) - p);
    lots.set(k, g);
  }
  const mixed = [...lots.values()].filter(g => g.prices.size > 1);
  if (mixed.length) throw new RtsCostError(`Lot ${mixed.map(g => g.lot).join(', ')} มีหลายรายการแต่ราคาใหม่ไม่เท่ากัน — แก้ให้ราคาใหม่เท่ากันก่อน (ต้นทุน Lot มีได้ค่าเดียว)`);
  const plans = [...lots.values()].map(g => {
    const p = [...g.prices][0];
    const h = n6(Math.max(0, g.stock - (returnGoods ? g.qty : 0)));
    const q = n6(g.qty);
    const base = `C ${g.costNow == null ? '-' : g.costNow} H ${h} Q ${q} P ${p}`;
    if (noCostAdj) return { g, p, next: g.costNow, why: `ลดหนี้เฉพาะส่วนที่ใช้ไปแล้ว — ไม่ปรับต้นทุน (${base})` };
    if (returnGoods && p === 0) return { g, p, next: g.costNow, why: `ส่งคืนรับเงินคืนเต็มจำนวน (ราคาใหม่ 0) — ไม่ปรับต้นทุน (${base})` };
    let next, rule;
    if (g.costNow == null || h <= 0 || q >= h) { next = p; rule = h <= 0 ? 'ไม่มีของเหลือในคลัง = ราคาใหม่' : 'ลดหนี้ครอบคลุมของที่เหลือ = ราคาใหม่'; }
    else { next = r4((g.costNow * h - g.credit) / h); rule = `ลดหนี้บางส่วน เฉลี่ย (C x H - ยอดลดหนี้ ${r4(g.credit)}) / H`; }
    if (next < 0 || (g.costNow != null && next > g.costNow)) {
      throw new RtsCostError(`Lot ${g.lot} คำนวณต้นทุนใหม่ได้ ${next} (ต้นทุนเดิม ${g.costNow}) — ผิดปกติ ตรวจสอบต้นทุน / ราคาใหม่ก่อนอนุมัติ`);
    }
    if (g.costNow != null && next === g.costNow) return { g, p, next, why: `ต้นทุนเท่าเดิม — ไม่เปลี่ยน (${base}, ${rule})` };
    return { g, p, next, why: `ปรับต้นทุน ${g.costNow == null ? '-' : g.costNow} -> ${next} (${base}, ${rule})` };
  });
  let changed = 0;
  for (const { g, p, next, why } of plans) {
    if (next !== g.costNow) {
      await tq().input('lot', sql.BigInt, g.idLot).input('c', sql.Decimal(18, 4), next)
        .query('UPDATE devsk.dInvLotMain SET CostPerUnit = @c WHERE idLot = @lot');
      changed++;
    }
    const refNote = `${docCode} ลดหนี้ ${n6(g.qty)} ${g.unit} ราคาใหม่ ${p} — ${why}`.slice(0, 500);
    await tq().input('lot', sql.Int, Number(g.idLot)).input('old', sql.Float, g.costNow).input('new', sql.Float, next)
      .input('note', sql.VarChar(sql.MAX), g.note == null ? null : String(g.note)).input('idPs', sql.Int, idPs)
      .input('refId', sql.Int, idBuyRT).input('refNote', sql.VarChar(500), refNote)
      .query(`INSERT INTO devsk.WimLogCost (idLot, Cost_Old, Cost_New, Note_Old, Note_New, idPsUpdate, DateUpdate, RefTb, RefId, RefNote)
              VALUES (@lot, @old, @new, @note, @note, @idPs, GETDATE(), 'PkBuyRTMt', @refId, @refNote)`);
  }
  return { lots: lots.size, changed };
}

// หักยอดรับของ PO (sign = 1 ตอนอนุมัติ / -1 ตอนยกเลิกเอกสารที่อนุมัติแล้ว) — เฉพาะประเภทรับสินค้าทดแทน (stReplace)
//   ตามขั้นตอน ReturnPOAmount / CancelReturnPO ของ Win form แต่แก้ให้ถูก:
//   แปลงหน่วย / รวมยอดต่อบรรทัด PO / คำนวณสถานะรับครบจริง (ไม่ตั้งเป็นยังไม่ครบทุกครั้ง) / ไม่แตะรายการรอรับที่ยกเลิกแล้ว
async function rtsAdjustPo(tq, idBuyRT, sign) {
  const r = await tq().input('id', sql.Int, idBuyRT).query(`
    SELECT dt.idBuyRTDt, dt.idPoDt, dt.AmountRT, dt.idUnit AS LotUnit, dt.idInvMain, i.idUnit AS MainUnit, i.InvName, lm.LotNo,
           bd.idUnitNew AS PoUnit, bm.DocCode AS POCode, ul.UnitName AS LotUnitName, up.UnitName AS PoUnitName
    FROM devsk.PkBuyRTDt dt
    JOIN devsk.dInventoryMain i ON i.idInvMain = dt.idInvMain
    LEFT JOIN devsk.dInvLotRefWh wh ON wh.idRefLot = dt.idRefLot
    LEFT JOIN devsk.dInvLotMain lm ON lm.idLot = wh.idLot
    LEFT JOIN devsk.PKPOBuyDt bd ON bd.idPODt = dt.idPoDt
    LEFT JOIN devsk.PKPOBuyMt bm ON bm.idPOTs = bd.idPOTs
    LEFT JOIN devsk.dInvUnit ul ON ul.idUnit = dt.idUnit
    LEFT JOIN devsk.dInvUnit up ON up.idUnit = bd.idUnitNew
    WHERE dt.idBuyRT = @id AND dt.stDel IS NULL;
    SELECT us.idInvMain, us.idSubUnit, us.AmtMainperSub FROM devsk.dInvUnitSub us
    WHERE us.idInvMain IN (SELECT idInvMain FROM devsk.PkBuyRTDt WHERE idBuyRT = @id AND stDel IS NULL);
    SELECT w.idWaitRecDt, w.idDt, w.idUnitNew, uw.UnitName FROM devsk.WimWaitRecDt w
    JOIN devsk.WimWaitRecMt wm ON wm.IdWaitRecMt = w.IdWaitRecMt
    LEFT JOIN devsk.dInvUnit uw ON uw.idUnit = w.idUnitNew
    WHERE wm.ProcessID = 1 AND wm.stCancel IS NULL
      AND w.idDt IN (SELECT idPoDt FROM devsk.PkBuyRTDt WHERE idBuyRT = @id AND stDel IS NULL);`);
  const lines = r.recordsets[0];
  const subs = new Map();
  r.recordsets[1].forEach(s => { if (!subs.has(s.idInvMain)) subs.set(s.idInvMain, new Map()); subs.get(s.idInvMain).set(s.idSubUnit, Number(s.AmtMainperSub)); });
  const waitRows = r.recordsets[2];
  const poQty = new Map(), waitQty = new Map(), bad = [];
  for (const l of lines) {
    if (!l.idPoDt) continue;
    const sb = subs.get(l.idInvMain) || new Map();
    const q = Number(l.AmountRT);
    const toPo = rtsConvertUnit(q, l.LotUnit, l.PoUnit, l.MainUnit, sb);
    if (toPo == null) { bad.push(`${l.InvName} (Lot ${l.LotNo || '-'}, PO ${l.POCode || '-'}): หน่วยคืน ${l.LotUnitName || l.LotUnit} → หน่วย PO ${l.PoUnitName || l.PoUnit}`); continue; }
    poQty.set(l.idPoDt, (poQty.get(l.idPoDt) || 0) + toPo);
    for (const w of waitRows.filter(x => x.idDt === l.idPoDt)) {
      const toWait = rtsConvertUnit(q, l.LotUnit, w.idUnitNew, l.MainUnit, sb);
      if (toWait == null) { bad.push(`${l.InvName} (Lot ${l.LotNo || '-'}, PO ${l.POCode || '-'}): หน่วยคืน ${l.LotUnitName || l.LotUnit} → หน่วยรอรับ ${w.UnitName || w.idUnitNew}`); continue; }
      waitQty.set(w.idWaitRecDt, (waitQty.get(w.idWaitRecDt) || 0) + toWait);
    }
  }
  if (bad.length) throw new RtsUnitError(`แปลงหน่วยไม่ได้ — ให้โปรแกรมเมอร์ตั้งค่าหน่วยหลัก / หน่วยรองของสินค้าก่อน:\n${[...new Set(bad)].join('\n')}`);

  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  for (const [idPoDt, q] of poQty) {
    await tq().input('po', sql.Int, idPoDt).input('q', sql.Decimal(18, 6), round6(q * sign))
      .query(`UPDATE devsk.PKPOBuyDt
              SET AmountRT = ISNULL(AmountRT, 0) + @q,
                  stRec = CASE WHEN ISNULL(Amount, 0) > ISNULL(AmountRec, 0) - (ISNULL(AmountRT, 0) + @q) THEN NULL ELSE 1 END
              WHERE idPODt = @po`);
  }
  for (const [idWaitRecDt, q] of waitQty) {
    await tq().input('w', sql.Int, idWaitRecDt).input('q', sql.Decimal(18, 6), round6(q * sign))
      .query(`UPDATE devsk.WimWaitRecDt
              SET AmountWaitRT = ISNULL(AmountWaitRT, 0) + @q,
                  stRecDt = CASE WHEN ISNULL(AmountWait, 0) > ISNULL(AmountRec, 0) - (ISNULL(AmountWaitRT, 0) + @q) THEN NULL ELSE 1 END
              WHERE idWaitRecDt = @w`);
  }
  const poIds = [...poQty.keys()].map(Number).filter(Number.isInteger);
  if (poIds.length) {
    const inList = poIds.join(',');
    // สถานะหัว PO / หัวรอรับ คำนวณใหม่จากทุกบรรทัด (เงื่อนไขเดียวกับ Win form)
    await tq().query(`
      WITH SummaryStatus AS (
        SELECT mt.idPOTs,
               CASE WHEN COUNT(CASE WHEN dt.stRec = 1 THEN 1 END) = 0 THEN 0
                    WHEN COUNT(CASE WHEN dt.stRec IS NULL OR dt.stRec = 0 THEN 1 END) > 0 THEN 2
                    ELSE 1 END AS New_stPO
        FROM devsk.PKPOBuyMt mt
        JOIN devsk.PKPOBuyDt dt ON mt.idPOTs = dt.idPOTs
        WHERE mt.idPOTs IN (SELECT DISTINCT idPOTs FROM devsk.PKPOBuyDt WHERE idPODt IN (${inList}))
        GROUP BY mt.idPOTs)
      UPDATE mt SET mt.stPO = s.New_stPO FROM devsk.PKPOBuyMt mt JOIN SummaryStatus s ON mt.idPOTs = s.idPOTs;

      WITH SummaryWaitStatus AS (
        SELECT wm.IdWaitRecMt,
               CASE WHEN COUNT(w.stRecDt) = 0 THEN NULL
                    WHEN COUNT(CASE WHEN w.stRecDt IS NULL THEN 1 END) > 0 THEN 2
                    ELSE 1 END AS New_stRec
        FROM devsk.WimWaitRecMt wm
        JOIN devsk.WimWaitRecDt w ON wm.IdWaitRecMt = w.IdWaitRecMt
        WHERE wm.ProcessID = 1 AND wm.stCancel IS NULL
          AND wm.IdWaitRecMt IN (SELECT DISTINCT ws.IdWaitRecMt FROM devsk.WimWaitRecDt ws WHERE ws.idDt IN (${inList}))
        GROUP BY wm.IdWaitRecMt)
      UPDATE wm SET wm.StRec = s.New_stRec FROM devsk.WimWaitRecMt wm JOIN SummaryWaitStatus s ON wm.IdWaitRecMt = s.IdWaitRecMt;`);
  }
  return { poLines: poQty.size, waitLines: waitQty.size };
}

// กดผ่านขั้นนี้ 1 ใบ — body: { step, stamp } (หน้าเว็บส่งทีละใบ ถ้าเลือกหลายใบ แต่ละใบบันทึกแยกกัน)
//   ack: idPsAccept / DateAccept (ล้างเหตุผลส่งกลับเดิม) / check: ลง Check ก่อน ถ้ามีแล้วลง Check2 (ต้องคนละคน)
//   approve: idPsApv / DateApv + ปลดล็อกรายการรอเบิก (stNoApprove = NULL) + หักยอดรับ PO (ประเภทรับสินค้าทดแทน)
app.post('/api/supplier-return/doc/:id/step', requireMenu([MENU_RTS_ACK, MENU_RTS_CHECK, MENU_RTS_APPROVE]), async (req, res) => {
  const idBuyRT = parseInt(req.params.id, 10);
  const step = rtsStepOf(req);
  const stamp = String((req.body || {}).stamp || '');
  if (!idBuyRT || !step) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  const S = RTS_STEPS[step];
  if (!hasMenu(req.access, S.menu)) return res.status(403).json({ success: false, message: `ไม่มีสิทธิ์${S.name}เอกสารส่งคืนสินค้า Supplier` });

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const tq = () => new sql.Request(transaction);
    const fail = async (status, body) => { await transaction.rollback(); transaction = null; return res.status(status).json({ success: false, ...body }); };

    const doc = (await tq().input('id', sql.Int, idBuyRT).query(`
      SELECT mt.DocCode, mt.idComp, mt.TypeRT, mt.DateAccept, mt.DateCheck, mt.DateCheck2, mt.DateApv, mt.DateCancel, mt.DateSendBack, mt.idPsCheck,
             CONVERT(varchar(23), ISNULL(mt.DateEdit, mt.DateTs), 121) AS Stamp, ty.stReplace, ty.stCredit, ty.stReturnGoods, mt.stNoCostAdj
      FROM devsk.PkBuyRTMt mt WITH (UPDLOCK, ROWLOCK)
      LEFT JOIN devsk.PkBuyRTType ty ON ty.idTypeRT = mt.TypeRT
      WHERE mt.idBuyRT = @id`)).recordset[0];
    if (!doc) return fail(404, { message: 'ไม่พบเอกสาร' });
    if (!hasComp(req.access, doc.idComp)) return fail(403, { message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้' });
    const st = rtsStatus(doc);
    if (!S.waits(st)) return fail(409, { code: 'DOC_CHANGED', docStatus: st, message: `เอกสาร ${doc.DocCode} อยู่ในสถานะ "${RTS_STATUS_NAME[st]}" — ไม่ได้รอ${S.name}แล้ว` });
    // รับทราบ: เอกสารแก้ไขได้จนถึงขั้นนี้ — ถูกแก้หลังจากเปิดดู ให้ดูใหม่ก่อน
    if (step === 'ack' && stamp && stamp !== doc.Stamp) return fail(409, { code: 'DOC_CHANGED', docStatus: st, message: `เอกสาร ${doc.DocCode} ถูกแก้ไขหลังจากที่เปิดดู — กรุณาตรวจสอบเอกสารอีกครั้ง` });

    let done = step, po = null, cost = null;
    if (step === 'ack') {
      await tq().input('id', sql.Int, idBuyRT).input('idPs', sql.Int, req.idPs)
        .query(`UPDATE devsk.PkBuyRTMt SET idPsAccept = @idPs, DateAccept = GETDATE(), SendBackNote = NULL, idPsSendBack = NULL, DateSendBack = NULL
                WHERE idBuyRT = @id`);
    } else if (step === 'check') {
      if (!doc.DateCheck) {
        await tq().input('id', sql.Int, idBuyRT).input('idPs', sql.Int, req.idPs)
          .query('UPDATE devsk.PkBuyRTMt SET idPsCheck = @idPs, DateCheck = GETDATE() WHERE idBuyRT = @id');
        done = 'check1';
      } else {
        if (doc.idPsCheck === req.idPs) return fail(400, { message: `คุณตรวจสอบ 1 ของเอกสาร ${doc.DocCode} ไปแล้ว — ตรวจสอบ 2 ต้องเป็นผู้ตรวจสอบคนอื่น` });
        await tq().input('id', sql.Int, idBuyRT).input('idPs', sql.Int, req.idPs)
          .query('UPDATE devsk.PkBuyRTMt SET idPsCheck2 = @idPs, DateCheck2 = GETDATE() WHERE idBuyRT = @id');
        done = 'check2';
      }
    } else {
      if (doc.stReplace === '1') {
        try { po = await rtsAdjustPo(tq, idBuyRT, 1); }
        catch (e) { if (e instanceof RtsUnitError) return fail(400, { message: `อนุมัติเอกสาร ${doc.DocCode} ไม่ได้ — ${e.message}` }); throw e; }
      }
      if (doc.stCredit === '1') {
        try { cost = await rtsAdjustCost(tq, idBuyRT, doc.DocCode, doc.stReturnGoods === '1', doc.stNoCostAdj === '1', req.idPs); }
        catch (e) { if (e instanceof RtsCostError) return fail(400, { message: `อนุมัติเอกสาร ${doc.DocCode} ไม่ได้ — ${e.message}` }); throw e; }
      }
      // ปลดล็อกรายการรอเบิก ให้คลังเบิกได้ (ทุกหัวที่ยังใช้งาน — เอกสารเก่าจาก Win form อาจมีค้างมากกว่า 1 ชุด)
      await tq().input('id', sql.Int, idBuyRT)
        .query(`UPDATE wm SET stNoApprove = NULL FROM devsk.WimWaitCutMt wm WHERE ${RTS_ACTIVE_WAITCUT} AND wm.IdMt = @id`);
      await tq().input('id', sql.Int, idBuyRT).input('idPs', sql.Int, req.idPs)
        .query('UPDATE devsk.PkBuyRTMt SET idPsApv = @idPs, DateApv = GETDATE() WHERE idBuyRT = @id');
    }

    await transaction.commit();
    transaction = null;
    res.json({ success: true, id: idBuyRT, docNo: doc.DocCode, done, po: typeof po === 'undefined' ? null : po, cost });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return step error:', err);
    res.status(500).json({ success: false, message: `บันทึก${S.name}ไม่สำเร็จ — ระบบไม่ได้เปลี่ยนแปลงข้อมูล`, detail: err.message });
  }
});

// ส่งกลับแก้ไข — body: { step, reason (> 5 ตัวอักษร, ไม่เกิน 500), stamp }
//   ล้างการรับทราบ / ตรวจสอบ 1-2 ที่ผ่านมา เอกสารกลับไปรอรับทราบ (ผู้ทำเอกสารแก้ไขได้) + เก็บเหตุผลล่าสุด
//   ส่งกลับได้ทุกขั้นที่ยังไม่อนุมัติ (ผู้ส่งกลับต้องมีสิทธิ์ขั้นที่เอกสารรออยู่)
app.post('/api/supplier-return/doc/:id/send-back', requireMenu([MENU_RTS_ACK, MENU_RTS_CHECK, MENU_RTS_APPROVE]), async (req, res) => {
  const idBuyRT = parseInt(req.params.id, 10);
  const step = rtsStepOf(req);
  const reason = String((req.body || {}).reason || '').trim();
  if (!idBuyRT || !step) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  const S = RTS_STEPS[step];
  if (!hasMenu(req.access, S.menu)) return res.status(403).json({ success: false, message: `ไม่มีสิทธิ์${S.name}เอกสารส่งคืนสินค้า Supplier` });
  if (reason.length <= 5 || reason === '0' || reason === '-') return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลการส่งกลับแก้ไขให้ชัดเจน (มากกว่า 5 ตัวอักษร)' });
  if (reason.length > 500) return res.status(400).json({ success: false, message: 'เหตุผลการส่งกลับยาวได้ไม่เกิน 500 ตัวอักษร' });

  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const tq = () => new sql.Request(transaction);
    const fail = async (status, body) => { await transaction.rollback(); transaction = null; return res.status(status).json({ success: false, ...body }); };
    const doc = (await tq().input('id', sql.Int, idBuyRT).query(`
      SELECT DocCode, idComp, DateAccept, DateCheck, DateCheck2, DateApv, DateCancel, DateSendBack
      FROM devsk.PkBuyRTMt WITH (UPDLOCK, ROWLOCK) WHERE idBuyRT = @id`)).recordset[0];
    if (!doc) return fail(404, { message: 'ไม่พบเอกสาร' });
    if (!hasComp(req.access, doc.idComp)) return fail(403, { message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้' });
    const st = rtsStatus(doc);
    if (!S.waits(st)) return fail(409, { code: 'DOC_CHANGED', docStatus: st, message: `เอกสาร ${doc.DocCode} อยู่ในสถานะ "${RTS_STATUS_NAME[st]}" — ไม่ได้รอ${S.name}แล้ว` });
    await tq().input('id', sql.Int, idBuyRT).input('idPs', sql.Int, req.idPs).input('note', sql.VarChar(500), reason)
      .query(`UPDATE devsk.PkBuyRTMt
              SET idPsAccept = NULL, DateAccept = NULL, idPsCheck = NULL, DateCheck = NULL, idPsCheck2 = NULL, DateCheck2 = NULL,
                  SendBackNote = @note, idPsSendBack = @idPs, DateSendBack = GETDATE()
              WHERE idBuyRT = @id`);
    await transaction.commit();
    transaction = null;
    res.json({ success: true, id: idBuyRT, docNo: doc.DocCode });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('Supplier return send-back error:', err);
    res.status(500).json({ success: false, message: 'ส่งกลับแก้ไขไม่สำเร็จ — ระบบไม่ได้เปลี่ยนแปลงข้อมูล', detail: err.message });
  }
});

// รวมยอดทุกบริษัท + แยกรายบริษัท (byComp เก็บเฉพาะบริษัทที่มีงานค้าง) ให้หน้า Home บอกได้ว่ายอดมาจากบริษัทไหน
// บริษัทที่ไม่นับในหน้า Home (5 = บริษัท ทดสอบ จำกัด — ข้อมูลทดสอบ ไม่ใช่งานจริง)
const HOME_EXCLUDE_COMP_IDS = [5];

function summarizeByComp(rows, fields) {
  const total = Object.fromEntries(fields.map(k => [k, 0]));
  rows.forEach(r => fields.forEach(k => { total[k] += r[k] || 0; }));
  const byComp = rows
    .filter(r => fields.some(k => r[k] > 0))
    .map(r => ({ id: r.id, name: r.name, ...Object.fromEntries(fields.map(k => [k, r[k] || 0])) }));
  return { ...total, byComp };
}

// ==================================================================
// ---------- ร้องขอขายเมล็ดพันธุ์ (Over PO) — OPS ----------
// ==================================================================
// ฝั่งร้องขอ (ผู้ขาย เช่น FLO / GR) อ้างอิง PO ตั้งต้นที่บริษัทผู้ซื้อ (เช่น AV) เปิดให้ แล้วเสนอขายยอดที่ผลิตเกิน PO
// เฟส 1: บันทึก / แก้ไข (ก่อนส่ง) / ยกเลิก / เอกสาร A4 / ส่งอีเมลแจ้งฝ่ายจัดซื้อผู้ซื้อ (ผู้รับกำหนดใน SeedReqSaleMailTo)
// เฟส 2: ฝ่ายจัดซื้อผู้ซื้อกำหนดจำนวน/ราคา → ใบขออนุมัติ OPA → อนุมัติ 4 ขั้น (SeedReqSaleApv) → สร้าง PO (X..) + ใบสั่งขายอัตโนมัติ
// ตาราง + เมนู: sql/over-po-sale-setup.sql, sql/over-po-sale-phase2-20261019.sql, sql/over-po-sale-dropcols-20261020.sql
const MENU_OPS = 'over_po_sale';
const MENU_OPS_MAILTO = 'over_po_sale_mailto';     // สิทธิ์กำหนดผู้รับอีเมล (สิทธิ์ย่อย ไม่มีหน้าแยก)
const OPS_COMPANY_IDS = [2, 3, 4];
// idComp -> idSup ของบริษัทนั้นในฐานะผู้ขาย (PO ที่ผู้ซื้อเปิดให้ผู้ร้องขอ = PKPOBuyMt.idSup นี้)
const OPS_COMP_SUPPLIER = { 2: 361, 3: 504, 4: 932 };
const OPS_MAIL_STEP_CHECK = 'check';
const OPS_EPS = 1e-6;
const OPS_MAX_CC = 20;
// เรื่อง: ทุกเอกสารเป็นเรื่องเดียวกัน → ไม่ให้กรอก ระบบใส่ให้ (ยังเก็บใน Subject เผื่อใช้เรื่องอื่นในอนาคต)
const OPS_DEFAULT_SUBJECT = 'แจ้งร้องขอขายเมล็ดพันธุ์ที่เกินใบสั่งซื้อ (Over PO)';

// หน้าเดียวกันหลายโหมด: /over-po-sale (ผู้ร้องขอ) / -doc (ใบร้องขอ OPQ) / -buy (ฝ่ายจัดซื้อ: รายการ + ?id= จัดการคำร้อง) / -opa (ใบขออนุมัติ + ปุ่มอนุมัติ)
['/over-po-sale-doc', '/over-po-sale-buy', '/over-po-sale-buy.html', '/over-po-sale-opa', '/over-po-sale-apv'].forEach(p =>
  app.get(p, (req, res) => res.sendFile(path.join(__dirname, 'public', 'over-po-sale.html'))));

// ---- เฟส 2: ฝ่ายจัดซื้อผู้ซื้อพิจารณา + ขออนุมัติ 4 ขั้น (แบบ PO) + สร้าง PO / ใบสั่งขายอัตโนมัติ — sql/over-po-sale-phase2-20261019.sql
const MENU_OPS_BUY = 'over_po_sale_buy';
// ขั้นอนุมัติ: ลำดับแสดงผล / ชื่อ (ผู้อนุมัติ 1-2 แสดงว่า "ผู้อนุมัติ" — ลำดับ 1/2 เป็นเรื่องหลังบ้าน) / คอลัมน์ผู้อนุมัติใน PkPOBuyMt (ใช้ทั้งดึงค่าเริ่มต้นจาก PO ที่อ้างอิง และตอนสร้าง PO)
const OPS_APV_STEPS = [
  { code: 'accept', name: 'ผู้รับทราบ', poPs: 'idPsAccept', poDate: 'DateAcceptD', poSys: 'SysAccept' },
  { code: 'check', name: 'ผู้ตรวจสอบ', poPs: 'idPsCheck', poDate: 'DateCheckD', poSys: 'SysCheck' },
  { code: 'approve1', name: 'ผู้อนุมัติ', poPs: 'idPsApprove1', poDate: 'DateApprove1D', poSys: 'SysApprove' },
  { code: 'approve2', name: 'ผู้อนุมัติ', poPs: 'idPsApprove2', poDate: 'DateApprove2D', poSys: 'SysApprove2' }
];
// อนุมัติ 1 กับ 2 ต้องเป็นคนละคน — PO เดิมได้คนเดียวกัน (ระบบอนุมัติ PO ใส่ซ้ำ) → ค่าเริ่มต้น อนุมัติ 1 = ชัชวาล / อนุมัติ 2 = อนวัช
const OPS_APV_FIX = { approve1: 9, approve2: 7 };
const OPS_PO_TYPE = 8;          // PkPOBuyMt.TypeTs ของ PO ซื้อส่วนเกินใบสั่งซื้อ (7 มีเอกสาร E ใช้อยู่)
const OPS_PO_PREFIX = 'X';      // DocCode X{yy}/{mm}/{0000} — ใช้ไปก่อนจนกว่าฝ่ายจัดซื้อแจ้งรหัสที่ต้องการ
const OPS_PO_SYS = 3;           // Sys* ของการอนุมัติ = 3 (อนุมัติผ่านใบขออนุมัติ OPA ในระบบนี้ / 1 = โปรแกรม, 2 = เว็บอนุมัติ)
// OPS_PO_TEST_ROLLBACK=1 (.env): อนุมัติครบแล้วสร้าง PO + ใบสั่งขายจริงใน transaction แล้ว rollback ทั้งหมด (ทดสอบโดยไม่ทิ้งข้อมูล)
const opsPoTestRollback = () => process.env.OPS_PO_TEST_ROLLBACK === '1';

// ---------- อีเมล (nodemailer) ----------
// ตั้งค่าใน .env: SMTP_HOST / SMTP_PORT / SMTP_SECURE (true = 465) / SMTP_USER / SMTP_PASS / MAIL_FROM
//   MAIL_DRY_RUN=1 = ไม่ส่งจริง เขียนไฟล์ .eml ลงโฟลเดอร์ mail-outbox/ แทน (ใช้ทดสอบบนเครื่อง dev)
//   APP_BASE_URL = ต้นทางของลิงก์ในอีเมล เช่น https://wim.example.com (ไม่ตั้ง = ใช้ของหน้าเว็บที่กดส่ง)
//   MAIL_REDIRECT_TO = ช่วงทดสอบ: ส่งอีเมลทุกฉบับไปที่อีเมลนี้แทนผู้รับจริง (หัวเรื่อง + แถบบนสุดของอีเมลบอกผู้รับจริง)
//                      log ยังเก็บผู้รับจริง / เปิดใช้งานจริง = ลบบรรทัดนี้ออกจาก .env แล้ว restart
let opsTransport = null;
const opsMailDryRun = () => process.env.MAIL_DRY_RUN === '1';
const opsMailRedirect = () => (process.env.MAIL_REDIRECT_TO || '').trim();
const opsMailReady = () => opsMailDryRun() || !!(process.env.SMTP_HOST && process.env.MAIL_FROM);
function opsMailer() {
  if (opsTransport) return opsTransport;
  const nodemailer = require('nodemailer');
  opsTransport = opsMailDryRun()
    ? nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
    : nodemailer.createTransport({
        pool: true, maxConnections: 3, maxMessages: 100,
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
      });
  return opsTransport;
}
// ส่ง 1 ฉบับ -> { ok: Set(อีเมลที่ server รับ), error } (dry run = เขียน .eml แล้วถือว่าส่งสำเร็จทุกคน)
// MAIL_REDIRECT_TO: ส่งไปอีเมลทดสอบแทน — ถ้าส่งถึงอีเมลทดสอบได้ ถือว่าผู้รับจริงทุกคน "ส่งแล้ว" (log เก็บผู้รับจริง)
async function opsSendMail({ to, cc, subject, html }) {
  const from = process.env.MAIL_FROM || 'WIM <no-reply@localhost>';
  const redirect = opsMailRedirect();
  const real = [...to, ...cc];
  if (redirect) {
    const list = (arr) => opsEsc(arr.join(', ') || '-');
    html = `<div style="font-family:Tahoma,Arial,sans-serif;font-size:13px;background:#fff4d6;border:1px solid #f2a91c;border-radius:6px;padding:10px 14px;margin-bottom:16px;color:#5a4300">
      <b>🧪 อีเมลทดสอบ (MAIL_REDIRECT_TO)</b> — ใช้งานจริงจะส่งถึง<br>To: ${list(to)}${cc.length ? `<br>Cc: ${list(cc)}` : ''}</div>` + html;
    subject = `[ทดสอบ → ${to.join(', ')}${cc.length ? ` +cc ${cc.length}` : ''}] ${subject}`;
    to = [redirect];
    cc = [];
  }
  try {
    const info = await opsMailer().sendMail({ from, to, cc, subject, html });
    if (opsMailDryRun()) {
      const dir = path.join(__dirname, 'mail-outbox');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}-${subject.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}.eml`), info.message);
      return { ok: new Set(real.map(e => e.toLowerCase())), error: null };
    }
    if (redirect) {
      const delivered = (info.accepted || []).some(e => String(e).toLowerCase() === redirect.toLowerCase());
      return { ok: new Set(delivered ? real.map(e => e.toLowerCase()) : []), error: delivered ? null : `ส่งถึงอีเมลทดสอบ ${redirect} ไม่สำเร็จ` };
    }
    return { ok: new Set((info.accepted || []).map(e => String(e).toLowerCase())), error: (info.rejected || []).length ? 'ผู้รับบางรายถูกปฏิเสธ' : null };
  } catch (err) {
    console.error('OPS mail error:', err);
    return { ok: new Set(), error: err.message };
  }
}

// ---------- สถานะเอกสาร (ดูจากวันที่ของแต่ละขั้น ไม่มีคอลัมน์สถานะ) ----------
// D = ร่าง (ยังไม่ส่ง) / S = ส่งคำร้องแล้ว รอฝ่ายจัดซื้อ / H = ฝ่ายจัดซื้อส่งขออนุมัติแล้ว รออนุมัติ (4 ขั้น)
// B = ผู้อนุมัติส่งกลับแก้ไข (รอฝ่ายจัดซื้อแก้แล้วส่งใหม่) / A = อนุมัติรับซื้อ (สร้าง PO แล้ว) / R = ไม่รับซื้อ / C = ยกเลิก
// ApvBack มาจาก OPS_ROUND_SQL (ผลของรอบขออนุมัติปัจจุบัน) — query ที่ใช้ opsStatus ต้อง join ไว้
function opsStatus(m) {
  if (m.DateCancel) return 'C';
  if (m.DateReject) return 'R';
  if (m.DateApv) return 'A';
  if (m.ApvBack) return 'B';
  if (m.DateBuy) return 'H';
  if (m.DateSent) return 'S';
  return 'D';
}
// สรุปผลรอบขออนุมัติปัจจุบัน (ต่อท้าย FROM ... m) → ar.ApvDone / ar.ApvBack / ar.ApvActed / ar.ApvCount
const OPS_ROUND_SQL = (m = 'm') => `OUTER APPLY (
      SELECT SUM(CASE WHEN a.Result = 'A' THEN 1 ELSE 0 END) AS ApvDone, MAX(CASE WHEN a.Result = 'B' THEN 1 ELSE 0 END) AS ApvBack,
             SUM(CASE WHEN a.Result IS NOT NULL THEN 1 ELSE 0 END) AS ApvActed, COUNT(a.idApv) AS ApvCount
      FROM devsk.SeedReqSaleApv a WHERE a.idOps = ${m}.idOps AND a.ApvRound = ${m}.ApvRound) ar`;

// ---------- ออกเลขที่เอกสาร: OPQ{YY}{MM}/{0001} (แบบเดียวกับ URQ ของคำร้องเร่งด่วน) ----------
// YY = พ.ศ. 2 หลักท้าย / รันแยกบริษัทผู้ร้องขอ เริ่ม 0001 ใหม่ทุกปี / ต้องเรียกใน transaction เดียวกับ INSERT
async function getNextOpsDocCode(transaction, idCompReq, date) {
  const yy = String(date.getFullYear() + 543).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const r = await new sql.Request(transaction)
    .input('idComp', sql.Int, idCompReq)
    .input('pat', sql.VarChar, `OPQ${yy}__/%`)
    .query(`SELECT MAX(TRY_CAST(RIGHT(DocCode, 4) AS INT)) AS last
            FROM devsk.SeedReqSaleMt WITH (UPDLOCK, HOLDLOCK)
            WHERE idCompReq = @idComp AND DocCode LIKE @pat`);
  return `OPQ${yy}${mm}/${String((r.recordset[0].last || 0) + 1).padStart(4, '0')}`;
}

// ---------- บรรทัด PO ตั้งต้น + ยอดขายแล้ว (ผู้ขาย) + ยอดรับแล้ว (ผู้ซื้อ) — ใช้ทั้ง popup เลือก PO และตอนบันทึก ----------
// PO ที่บริษัทผู้ซื้อ (idCompTarget) เปิดให้บริษัทผู้ร้องขอ (idSup) / ไม่รวมที่ยกเลิก / เฉพาะเมล็ด (กลุ่ม 1, 42)
// ยอดขาย = ใบขายของบริษัทผู้ขาย (idCompSeller) ที่อ้างบรรทัด PO (SmSaleDtAll.idPODt) ไม่ยกเลิก — ใช้คำนวณยอดเสนอขาย
//   sellerComplete = บรรทัดใบสั่งขายที่อ้าง PO ติด "ขายครบ" (SmSaleOrderDt.stAllSale = 1) หรือยอดขาย >= PO
//   (ผู้ขายตัดขายแล้ว แต่ผู้ซื้ออาจยังไม่รับเข้า — เช่น S69/09/0019 — ฝั่งขายถือว่าครบแล้ว)
// ยอดรับ = ใบรับฝั่งผู้ซื้อที่ไม่ยกเลิก — แสดงประกอบ / ทั้งสองยอดแปลงเป็นหน่วย PO (กรัม <-> กก.) แปลงไม่ได้ = ไม่นับ + unitError
// idPODts = เฉพาะบรรทัดที่ระบุ (ตอนบันทึก) / runner = transaction หรือ pool
async function fetchOpsPoLines(runner, { idCompTarget, idSup, idCompSeller, idPODts = null, excludeIdOps = null }) {
  const req = (runner instanceof sql.Transaction ? new sql.Request(runner) : runner.request())
    .input('idComp', sql.Int, idCompTarget).input('idSup', sql.Int, idSup).input('seller', sql.Int, idCompSeller)
    .input('exOps', sql.Int, excludeIdOps || 0);
  const ids = idPODts ? idPODts.filter(Number.isInteger) : null;
  if (ids && !ids.length) return [];
  const r = await req.query(`
    SELECT bdt.idPODt INTO #pl
    FROM devsk.PKPOBuyMt bmt
    JOIN devsk.PKPOBuyDt bdt ON bdt.idPOTs = bmt.idPOTs
    JOIN devsk.dInventoryMain i ON i.idInvMain = bdt.idInvMain
    WHERE bmt.idComp = @idComp AND bmt.idSup = @idSup
      AND bmt.idPsCancel IS NULL AND bmt.stDel IS NULL
      AND i.idInvGroup IN (${SEED_INV_GROUPS.join(',')})
      ${ids ? `AND bdt.idPODt IN (${ids.join(',')})` : ''};

    SELECT bmt.idPOTs, bmt.DocCode AS POCode, CONVERT(varchar(10), bmt.DateBuyD, 23) AS DatePO,
           CASE WHEN bmt.idPsComplete IS NULL THEN 0 ELSE 1 END AS Completed, CONVERT(varchar(10), bmt.DateComplete, 23) AS DateComplete,
           bdt.idPODt, bdt.idInvMain, ci.InvName, ${CROP_ID_SQL} AS idSeed, sd.SeedName, bdt.Amount, bdt.idUnitNew AS idUnit, u.UnitName
    FROM #pl pl
    JOIN devsk.PKPOBuyDt bdt ON bdt.idPODt = pl.idPODt
    JOIN devsk.PKPOBuyMt bmt ON bmt.idPOTs = bdt.idPOTs
    JOIN devsk.dInventoryMain ci ON ci.idInvMain = bdt.idInvMain
    ${CROP_JOIN_SQL}
    LEFT JOIN dbo.dSeed sd ON sd.idSeed = ${CROP_ID_SQL}
    LEFT JOIN devsk.dInvUnit u ON u.idUnit = bdt.idUnitNew
    ORDER BY bmt.DateBuyD DESC, bmt.DocCode, bdt.idPODt;

    SELECT dt.idPODt, dt.AmountRec, dt.idUnitNew AS idUnit
    FROM devsk.PKPoRecDt dt
    JOIN devsk.PKPoRecMt mt ON mt.idPkPORec = dt.idPkPORec AND mt.idPsCancel IS NULL
    WHERE dt.idPODt IN (SELECT idPODt FROM #pl);

    SELECT p.idPODt, m.DocCode
    FROM devsk.SeedReqSalePORef p
    JOIN devsk.SeedReqSaleMt m ON m.idOps = p.idOps
    WHERE p.idPODt IN (SELECT idPODt FROM #pl) AND m.DateCancel IS NULL AND m.DateReject IS NULL AND m.idOps <> @exOps;

    SELECT dt.idPODt, dt.Amount, dt.idUnit
    FROM dbo.SmSaleDtAll dt
    JOIN dbo.SmSaleMt m ON m.idSale = dt.idSale
    WHERE dt.idPODt IN (SELECT idPODt FROM #pl) AND m.idPsCancel IS NULL AND m.idComp = @seller;

    SELECT d.idPODt, MAX(CASE WHEN d.stAllSale = 1 THEN 1 ELSE 0 END) AS AllSale
    FROM dbo.SmSaleOrderDt d
    JOIN dbo.SmSaleOrderMt o ON o.idSaleOrder = d.idSaleOrder
    WHERE d.idPODt IN (SELECT idPODt FROM #pl) AND o.idPsCancel IS NULL AND d.idPsCancel IS NULL AND o.idComp = @seller
    GROUP BY d.idPODt;

    DROP TABLE #pl;`);
  const rec = new Map();
  r.recordsets[1].forEach(x => {
    const cur = rec.get(x.idPODt) || { qty: 0, unitError: false, rows: [] };
    cur.rows.push(x);
    rec.set(x.idPODt, cur);
  });
  const used = new Map();
  r.recordsets[2].forEach(x => used.set(x.idPODt, [...(used.get(x.idPODt) || []), x.DocCode]));
  const sold = new Map();
  r.recordsets[3].forEach(x => sold.set(x.idPODt, [...(sold.get(x.idPODt) || []), x]));
  const allSale = new Map(r.recordsets[4].map(x => [x.idPODt, !!x.AllSale]));
  return r.recordsets[0].map(l => {
    const rc = rec.get(l.idPODt) || { rows: [] };
    let qty = 0, unitError = false;
    rc.rows.forEach(x => {
      const v = convertUnit(Number(x.AmountRec) || 0, x.idUnit, l.idUnit);
      if (v === null) unitError = true; else qty += v;
    });
    let soldQty = 0;
    (sold.get(l.idPODt) || []).forEach(x => {
      const v = convertUnit(Number(x.Amount) || 0, x.idUnit, l.idUnit);
      if (v === null) unitError = true; else soldQty += v;
    });
    const amount = Number(l.Amount) || 0;
    return {
      idPOTs: l.idPOTs, poCode: l.POCode, datePO: l.DatePO, completed: !!l.Completed, dateComplete: l.DateComplete,
      idPODt: l.idPODt, idInvMain: l.idInvMain, invName: l.InvName, idSeed: l.idSeed, seedName: l.SeedName,
      amountPO: round6(amount), amountRec: round6(qty), amountSold: round6(soldQty), idUnit: l.idUnit, unitName: l.UnitName,
      fullyReceived: amount > 0 && qty >= amount - OPS_EPS,
      sellerComplete: allSale.get(l.idPODt) === true || (amount > 0 && soldQty >= amount - OPS_EPS),
      unitError, usedIn: used.get(l.idPODt) || []
    };
  });
}

// ---------- ตรวจข้อมูลเอกสาร + คำนวณยอดจาก PO ล่าสุด (ใช้ทั้งสร้างและแก้ไข) ----------
// คืน { error } หรือ { head, items } — items[].pos แปลงเป็นหน่วยของรายการแล้ว (หน่วยรายการ = หน่วยของ PO บรรทัดแรกที่เลือก)
async function parseOpsBody(runner, body, { excludeIdOps = null } = {}) {
  const idCompReq = parseInt(body.idCompReq, 10);
  const idCompTarget = parseInt(body.idCompTarget, 10);
  const idPsReq = parseInt(body.idPsReq, 10);
  const subject = String(body.subject || '').trim() || OPS_DEFAULT_SUBJECT;
  const causeNote = String(body.causeNote || '').trim();
  const note = String(body.note || '').trim();
  if (!OPS_COMPANY_IDS.includes(idCompReq)) return { error: 'กรุณาเลือกบริษัทที่ร้องขอ' };
  if (!OPS_COMPANY_IDS.includes(idCompTarget) || idCompTarget === idCompReq) return { error: 'กรุณาเลือกบริษัทที่ส่งคำร้องถึง (ต้องไม่ใช่บริษัทเดียวกับผู้ร้องขอ)' };
  if (!idPsReq) return { error: 'กรุณาเลือกผู้ร้องขอ' };
  if (!subject) return { error: 'กรุณาระบุเรื่อง' };
  if (subject.length > 300) return { error: 'เรื่องยาวเกิน 300 ตัวอักษร' };
  if (!causeNote) return { error: 'กรุณาระบุสาเหตุ/รายละเอียดการผลิตเกิน PO' };
  if (note.length > 1000) return { error: 'หมายเหตุยาวเกิน 1,000 ตัวอักษร' };
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { error: 'กรุณาเลือก PO ที่อ้างอิงอย่างน้อย 1 รายการ' };

  const rows = items.map(it => ({
    idInvMain: parseInt(it.idInvMain, 10),
    amountProduce: Number(it.amountProduce),
    amountOffer: Number(it.amountOffer),
    note: String(it.note || '').trim(),
    poIds: [...new Set((Array.isArray(it.poLines) ? it.poLines : []).map(v => parseInt(v, 10)).filter(Boolean))]
  }));
  const allIds = rows.flatMap(r => r.poIds);
  if (new Set(allIds).size !== allIds.length) return { error: 'มีบรรทัด PO ซ้ำกันในหลายรายการ' };
  if (new Set(rows.map(r => r.idInvMain)).size !== rows.length) return { error: 'มีเมล็ดพันธุ์ซ้ำกันในเอกสาร' };

  const lines = await fetchOpsPoLines(runner, { idCompTarget, idSup: OPS_COMP_SUPPLIER[idCompReq], idCompSeller: idCompReq, idPODts: allIds, excludeIdOps });
  const byId = new Map(lines.map(l => [l.idPODt, l]));
  const out = [];
  for (const [i, r] of rows.entries()) {
    const no = `รายการที่ ${i + 1}`;
    if (!r.idInvMain) return { error: `${no}: เมล็ดพันธุ์ไม่ถูกต้อง` };
    if (!r.poIds.length) return { error: `${no}: กรุณาเลือก PO ที่อ้างอิง` };
    if (r.note.length > 500) return { error: `${no}: หมายเหตุยาวเกิน 500 ตัวอักษร` };
    const pos = r.poIds.map(id => byId.get(id));
    if (pos.some(p => !p)) return { error: `${no}: พบ PO ที่ไม่ใช่ของบริษัทผู้ซื้อ/ผู้ร้องขอนี้ หรือถูกยกเลิกแล้ว — กรุณาเลือก PO ใหม่` };
    if (pos.some(p => p.idInvMain !== r.idInvMain)) return { error: `${no}: PO ที่อ้างอิงต้องเป็นเมล็ดพันธุ์เดียวกัน` };
    pos.sort((a, b) => a.idPODt - b.idPODt);
    const unit = pos[0].idUnit;
    const conv = [];
    for (const p of pos) {
      const po = convertUnit(p.amountPO, p.idUnit, unit), rec = convertUnit(p.amountRec, p.idUnit, unit), sold = convertUnit(p.amountSold, p.idUnit, unit);
      if (po === null || rec === null || sold === null) return { error: `${no}: หน่วยของ PO ${p.poCode} (${p.unitName || '-'}) แปลงเป็น ${pos[0].unitName || '-'} ไม่ได้ — แยกเป็นเอกสารคนละใบ` };
      conv.push({ ...p, amountPO: round6(po), amountRec: round6(rec), amountSold: round6(sold) });
    }
    const amountPO = round6(conv.reduce((s, p) => s + p.amountPO, 0));
    const amountRec = round6(conv.reduce((s, p) => s + p.amountRec, 0));
    const amountSold = round6(conv.reduce((s, p) => s + p.amountSold, 0));   // ขายแล้วตามใบขายฝั่งผู้ขาย
    if (!(r.amountProduce > 0)) return { error: `${no}: ยอดผลิตได้ทั้งหมดต้องมากกว่า 0` };
    if (r.amountProduce <= amountPO + OPS_EPS) return { error: `${no}: ยอดผลิตได้ (${r.amountProduce}) ไม่เกินยอด PO (${amountPO}) — ไม่ใช่กรณีผลิตเกิน PO` };
    if (!(r.amountOffer > 0)) return { error: `${no}: ยอดเสนอขายเพิ่มต้องมากกว่า 0` };
    // เสนอขายได้ไม่เกิน ผลิตได้ − ขายแล้ว (ใบขายฝั่งผู้ขาย — รวมที่ผู้ซื้อยังไม่รับเข้า)
    const maxOffer = round6(r.amountProduce - amountSold);
    if (maxOffer <= OPS_EPS) return { error: `${no}: ยอดผลิตได้ (${r.amountProduce}) ไม่เกินยอดที่ขายไปแล้ว (${amountSold}) — ไม่มียอดคงเหลือให้เสนอขาย` };
    if (r.amountOffer > maxOffer + OPS_EPS) return { error: `${no}: ยอดเสนอขายเพิ่มเกินยอดคงเหลือหลังหักที่ขายแล้ว (สูงสุด ${maxOffer})` };
    out.push({ idInvMain: r.idInvMain, idUnit: unit, amountPO, amountRec, amountSold, amountProduce: round6(r.amountProduce), amountOffer: round6(r.amountOffer), note: r.note, pos: conv });
  }

  // ผู้รับอีเมล: ผู้รับคำร้อง (to) 1 คน ต้องอยู่ในรายชื่อฝ่ายจัดซื้อของบริษัทผู้ซื้อ / สำเนา (cc) ใครก็ได้ ไม่มีก็ได้ — ทุกคนต้องมีอีเมล
  const mailTo = parseInt(body.mailTo, 10);
  const ccIds = [...new Set((Array.isArray(body.mailCc) ? body.mailCc : []).map(v => parseInt(v, 10)).filter(Boolean))].filter(id => id !== mailTo);
  if (!mailTo) return { error: 'กรุณาเลือกผู้รับคำร้อง (ฝ่ายจัดซื้อ)' };
  if (ccIds.length > OPS_MAX_CC) return { error: `สำเนาถึง (CC) ได้ไม่เกิน ${OPS_MAX_CC} คน` };
  const to = (await opsRecipients(runner, idCompTarget)).find(x => x.idPs === mailTo);
  if (!to) return { error: 'ผู้รับคำร้องต้องอยู่ในรายชื่อฝ่ายจัดซื้อของบริษัทที่ส่งถึง — กรุณาเลือกใหม่' };
  if (!opsValidEmail(to.email)) return { error: `ผู้รับคำร้อง ${to.name} ไม่มีอีเมลในระบบ` };
  const cc = await opsPeople(runner, ccIds);
  const noMail = ccIds.filter(id => !cc.some(p => p.idPs === id && opsValidEmail(p.email)));
  if (noMail.length) return { error: `สำเนาถึง (CC) มีผู้ที่ไม่พบ/ไม่มีอีเมลในระบบ: ${noMail.map(id => (cc.find(p => p.idPs === id) || {}).name || `#${id}`).join(', ')}` };

  return { head: { idCompReq, idCompTarget, idPsReq, subject, causeNote, note, mailTo: to, mailCc: cc }, items: out };
}

// ข้อมูลพนักงาน + อีเมล (dbo.dPerson) ตามรายการ idPs — ใช้กับผู้รับสำเนา (cc)
async function opsPeople(runner, ids) {
  const list = (ids || []).filter(Number.isInteger);
  if (!list.length) return [];
  const req = runner instanceof sql.Transaction ? new sql.Request(runner) : runner.request();
  const r = await req.query(`
    SELECT p.idPs, v.PsName, v.PsFullName, v.PositionName, v.CompName, NULLIF(LTRIM(RTRIM(p.Email)), '') AS Email
    FROM dbo.dPerson p
    OUTER APPLY (SELECT TOP 1 x.PsName, x.PsFullName, x.PositionName, x.CompName FROM devsk.vPersonxSelect x WHERE x.idPs = p.idPs) v
    WHERE p.idPs IN (${list.join(',')})`);
  return r.recordset.map(x => ({ idPs: x.idPs, name: x.PsName || `#${x.idPs}`, full: (x.PsFullName || '').trim(), position: x.PositionName || '', compName: x.CompName || '', email: x.Email }));
}

// ผู้รับอีเมลของเอกสาร (แทนที่ของเดิมทั้งหมด — ใช้ทั้งสร้างและแก้ไข)
async function saveOpsRecipients(transaction, idOps, head, idPsTs) {
  await new sql.Request(transaction).input('id', sql.Int, idOps).query('DELETE FROM devsk.SeedReqSaleMailRecv WHERE idOps = @id');
  const rows = [{ type: 'to', idPs: head.mailTo.idPs }, ...head.mailCc.map(p => ({ type: 'cc', idPs: p.idPs }))];
  for (const x of rows) {
    await new sql.Request(transaction)
      .input('id', sql.Int, idOps).input('type', sql.VarChar(3), x.type).input('ps', sql.Int, x.idPs).input('ts', sql.Int, idPsTs)
      .query('INSERT INTO devsk.SeedReqSaleMailRecv (idOps, RecvType, idPs, idPsTs, DateTs) VALUES (@id, @type, @ps, @ts, GETDATE())');
  }
}

async function insertOpsItems(transaction, idOps, items) {
  for (const it of items) {
    const d = await new sql.Request(transaction)
      .input('idOps', sql.Int, idOps).input('inv', sql.Int, it.idInvMain).input('unit', sql.Int, it.idUnit)
      .input('po', sql.Decimal(18, 6), it.amountPO).input('rec', sql.Decimal(18, 6), it.amountRec).input('sold', sql.Decimal(18, 6), it.amountSold)
      .input('pd', sql.Decimal(18, 6), it.amountProduce).input('of', sql.Decimal(18, 6), it.amountOffer)
      .input('note', sql.NVarChar(500), it.note || null)
      .query(`INSERT INTO devsk.SeedReqSaleDt (idOps, idInvMain, idUnit, AmountPO, AmountRec, AmountSold, AmountProduce, AmountOffer, NoteDt)
              VALUES (@idOps, @inv, @unit, @po, @rec, @sold, @pd, @of, @note);
              SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`);
    const idOpsDt = d.recordset[0].id;
    for (const p of it.pos) {
      await new sql.Request(transaction)
        .input('idOps', sql.Int, idOps).input('dt', sql.Int, idOpsDt).input('pots', sql.Int, p.idPOTs).input('podt', sql.Int, p.idPODt)
        .input('code', sql.NVarChar(30), p.poCode).input('date', sql.VarChar(10), p.datePO)
        .input('po', sql.Decimal(18, 6), p.amountPO).input('rec', sql.Decimal(18, 6), p.amountRec).input('sold', sql.Decimal(18, 6), p.amountSold)
        .query(`INSERT INTO devsk.SeedReqSalePORef (idOps, idOpsDt, idPOTs, idPODt, POCode, DatePO, AmountPO, AmountRec, AmountSold)
                VALUES (@idOps, @dt, @pots, @podt, @code, CONVERT(date, @date, 23), @po, @rec, @sold)`);
    }
  }
}

// ล็อกหัวเอกสารใน transaction แล้วคืนแถว (ใช้ก่อนแก้ไข / ยกเลิก / ส่ง)
async function lockOpsDoc(transaction, idOps) {
  const r = await new sql.Request(transaction).input('id', sql.Int, idOps).query(`
    SELECT m.idOps, m.DocCode, m.idCompReq, m.idCompTarget, m.DateSent, m.DateApv, m.DateReject, m.DateCancel,
           m.DateBuy, m.BuyDocCode, m.ApvRound, m.idPsBuy, ar.ApvDone, ar.ApvBack, ar.ApvActed, ar.ApvCount,
           CONVERT(varchar(23), ISNULL(m.DateEdit, m.DateTs), 121) AS Stamp
    FROM devsk.SeedReqSaleMt m WITH (UPDLOCK, ROWLOCK)
    ${OPS_ROUND_SQL()}
    WHERE m.idOps = @id`);
  return r.recordset[0] || null;
}

// ---------- บริษัท (2, 3, 4) + allowed = มีสิทธิ์บริษัทนั้น ----------
app.get('/api/ops/companies', requireMenu([MENU_OPS, MENU_OPS_BUY]), async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query(`
      SELECT idComp AS id, CompName AS name FROM PchInvAndProject.dbo.dCompany
      WHERE stDel IS NULL AND idComp IN (${OPS_COMPANY_IDS.join(',')}) ORDER BY CompName`);
    res.json({
      success: true,
      data: r.recordset.map(c => ({ ...c, allowed: hasComp(req.access, c.id) })),
      mailReady: opsMailReady(), mailDryRun: opsMailDryRun(), mailRedirect: opsMailRedirect() || null,
      canMailTo: hasMenu(req.access, MENU_OPS_MAILTO), canReq: hasMenu(req.access, MENU_OPS), canBuy: hasMenu(req.access, MENU_OPS_BUY),
      poTestRollback: opsPoTestRollback()
    });
  } catch (err) {
    console.error('OPS companies error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลบริษัทไม่สำเร็จ', detail: err.message });
  }
});

// ---------- popup เลือก PO ตั้งต้น ----------
// ค่าเริ่มต้น = เฉพาะ PO ที่สิ้นสุดแล้ว (idPsComplete) หรือบรรทัดที่รับครบแล้ว / all=1 = รวม PO ที่ยังรับไม่ครบ
app.get('/api/ops/po-lines', requireMenu(MENU_OPS, { companyParam: 'idCompReq' }), async (req, res) => {
  const idCompReq = parseInt(req.query.idCompReq, 10);
  const idCompTarget = parseInt(req.query.idCompTarget, 10);
  const excludeIdOps = parseInt(req.query.idOps, 10) || null;
  if (!OPS_COMPANY_IDS.includes(idCompReq) || !OPS_COMPANY_IDS.includes(idCompTarget) || idCompReq === idCompTarget) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทที่ร้องขอและบริษัทที่ส่งคำร้องถึง' });
  }
  try {
    const pool = await poolPromise;
    const lines = await fetchOpsPoLines(pool, { idCompTarget, idSup: OPS_COMP_SUPPLIER[idCompReq], idCompSeller: idCompReq, excludeIdOps });
    // แสดงเฉพาะ PO ที่ผู้ขายขายครบแล้ว / ผู้ซื้อรับครบแล้ว / สิ้นสุดแล้ว (PO ที่ยังขายได้ตามปกติ ไม่ต้องใช้เมนูนี้)
    const data = req.query.all === '1' ? lines : lines.filter(l => l.sellerComplete || l.completed || l.fullyReceived);
    res.json({ success: true, data, hiddenOpen: lines.length - data.length });
  } catch (err) {
    console.error('OPS PO lines error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการ PO ไม่สำเร็จ', detail: err.message });
  }
});

// ---------- รายการเอกสาร: side = req (ของบริษัทผู้ร้องขอ) / buy (ที่ส่งถึงบริษัทผู้ซื้อ — เฉพาะที่ส่งแล้ว) ----------
// range = { from, to } ('YYYY-MM-DD' ตามวันที่ร้องขอ): กรองเฉพาะเอกสารที่สิ้นสุดแล้ว (อนุมัติ / ไม่รับซื้อ / ยกเลิก)
// เอกสารระหว่างดำเนินการแสดงทุกฉบับเสมอ ไม่ว่าวันที่ใด — ไม่ส่ง range = ทั้งหมด
async function opsListDocs(idComp, side, range = {}) {
  const pool = await poolPromise;
  const okDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(new Date(v));
  const from = okDate(range.from) ? range.from : null, to = okDate(range.to) ? range.to : null;
  const closed = 'm.DateCancel IS NOT NULL OR m.DateReject IS NOT NULL OR m.DateApv IS NOT NULL';
  const where = (side === 'buy' ? 'm.idCompTarget = @idComp AND m.DateSent IS NOT NULL' : 'm.idCompReq = @idComp')
    + (from || to ? ` AND (NOT (${closed}) OR (${from ? 'm.DateDoc >= @from' : '1 = 1'} AND ${to ? 'm.DateDoc < DATEADD(day, 1, @to)' : '1 = 1'}))` : '');
  const r = await pool.request().input('idComp', sql.Int, idComp).input('from', sql.Date, from).input('to', sql.Date, to).query(`
    SELECT m.idOps, m.DocCode, CONVERT(varchar(10), m.DateDoc, 23) AS DateDoc, m.idCompReq, m.idCompTarget, ct.CompName AS CompNameTarget, cr.CompName AS CompNameReq,
           m.idPsReq, pr.PsName AS PsNameReq, m.Subject, m.CauseNote,
           m.DateSent, m.DateApv, m.DateReject, m.DateCancel, m.DateBuy, m.RejectNote, m.RejectStep, m.CancelNote,
           m.BuyDocCode, m.ApvRound, ar.ApvDone, ar.ApvBack, ar.ApvActed, ar.ApvCount, po.DocCode AS POCodeAuto,
           CONVERT(varchar(16), m.DateSent, 120) AS TxSent, CONVERT(varchar(16), m.DateCancel, 120) AS TxCancel, pc.PsName AS PsCancel,
           CONVERT(varchar(16), m.DateBuy, 120) AS TxBuy, pb.PsName AS PsBuy, CONVERT(varchar(16), m.DateReject, 120) AS TxReject, prj.PsName AS PsReject,
           ml.LastMail, ml.MailFail
    FROM devsk.SeedReqSaleMt m
    LEFT JOIN PchInvAndProject.dbo.dCompany ct ON ct.idComp = m.idCompTarget
    LEFT JOIN PchInvAndProject.dbo.dCompany cr ON cr.idComp = m.idCompReq
    LEFT JOIN devsk.PkPOBuyMt po ON po.idPOTs = m.idPOTsAuto
    ${OPS_ROUND_SQL()}
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsReq) pr
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsCancel) pc
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsBuy) pb
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsReject) prj
    OUTER APPLY (SELECT MAX(l.DateSend) AS LastSend FROM devsk.SeedReqSaleMailLog l WHERE l.idOps = m.idOps) lm
    OUTER APPLY (SELECT CONVERT(varchar(16), lm.LastSend, 120) AS LastMail,
                        SUM(CASE WHEN l.stSend = 0 THEN 1 ELSE 0 END) AS MailFail
                 FROM devsk.SeedReqSaleMailLog l WHERE l.idOps = m.idOps AND l.DateSend = lm.LastSend) ml
    WHERE ${where}
    ORDER BY m.DateDoc DESC, m.idOps DESC;

    SELECT d.idOps, d.idOpsDt, i.InvName, d.AmountPO, d.AmountRec, d.AmountSold, d.AmountProduce, d.AmountOffer, d.AmountBuy, d.Price, u.UnitName,
           STUFF((SELECT ', ' + p.POCode FROM devsk.SeedReqSalePORef p WHERE p.idOpsDt = d.idOpsDt ORDER BY p.DatePO, p.POCode FOR XML PATH('')), 1, 2, '') AS POCodes
    FROM devsk.SeedReqSaleDt d
    JOIN devsk.SeedReqSaleMt m ON m.idOps = d.idOps
    LEFT JOIN devsk.dInventoryMain i ON i.idInvMain = d.idInvMain
    LEFT JOIN devsk.dInvUnit u ON u.idUnit = d.idUnit
    WHERE ${where}
    ORDER BY d.idOps, d.idOpsDt;`);
  const items = new Map();
  r.recordsets[1].forEach(x => items.set(x.idOps, [...(items.get(x.idOps) || []), {
    invName: x.InvName, amountPO: Number(x.AmountPO), amountRec: Number(x.AmountRec), amountSold: x.AmountSold == null ? null : Number(x.AmountSold),
    amountProduce: Number(x.AmountProduce), amountOffer: Number(x.AmountOffer),
    amountBuy: x.AmountBuy == null ? null : Number(x.AmountBuy), price: x.Price == null ? null : Number(x.Price),
    unit: x.UnitName, poCodes: x.POCodes || ''
  }]));
  return r.recordsets[0].map(m => ({
    id: m.idOps, docNo: m.DocCode, docDate: m.DateDoc, req: m.idCompReq, reqName: m.CompNameReq, target: m.idCompTarget, targetName: m.CompNameTarget,
    requester: m.PsNameReq || '-', subject: m.Subject || '', cause: m.CauseNote || '', status: opsStatus(m),
    sentAt: m.TxSent, lastMail: m.LastMail, mailFail: (m.MailFail || 0) > 0,
    cancel: m.TxCancel ? { by: m.PsCancel || '-', at: m.TxCancel, reason: m.CancelNote || '' } : null,
    rejectNote: m.RejectNote || '', reject: m.TxReject ? { by: m.PsReject || '-', at: m.TxReject, step: m.RejectStep || '' } : null,
    buyDocNo: m.BuyDocCode || null, buy: m.TxBuy ? { by: m.PsBuy || '-', at: m.TxBuy } : null,
    apvDone: m.ApvDone || 0, apvCount: m.ApvCount || 0, apvActed: m.ApvActed || 0, poCode: m.POCodeAuto || null,
    items: items.get(m.idOps) || []
  }));
}

app.get('/api/ops/docs', requireMenu(MENU_OPS, { companyParam: 'idComp' }), async (req, res) => {
  const idComp = parseInt(req.query.idComp, 10);
  if (!OPS_COMPANY_IDS.includes(idComp)) return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท' });
  try {
    res.json({ success: true, data: await opsListDocs(idComp, 'req', { from: req.query.dateFrom, to: req.query.dateTo }) });
  } catch (err) {
    console.error('OPS list error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการเอกสารไม่สำเร็จ', detail: err.message });
  }
});

// รายการคำร้องที่ส่งถึงบริษัทผู้ซื้อ (หน้าพิจารณาคำร้องขอขาย — ฝ่ายจัดซื้อ)
app.get('/api/ops/buy/docs', requireMenu(MENU_OPS_BUY, { companyParam: 'idComp' }), async (req, res) => {
  const idComp = parseInt(req.query.idComp, 10);
  if (!OPS_COMPANY_IDS.includes(idComp)) return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท' });
  try {
    res.json({ success: true, data: await opsListDocs(idComp, 'buy', { from: req.query.dateFrom, to: req.query.dateTo }) });
  } catch (err) {
    console.error('OPS buy list error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการเอกสารไม่สำเร็จ', detail: err.message });
  }
});

// ---------- เปิดเอกสารใบเดียว (ฟอร์มแก้ไข + หน้าเอกสาร A4) ----------
// ดูได้ถ้ามีสิทธิ์เมนู + บริษัทผู้ร้องขอหรือผู้ซื้อ หรือเป็นผู้รับอีเมล (to / cc) ของเอกสารนั้น (แค่ login)
// runner = transaction (อ่านข้อมูลที่เพิ่งบันทึกใน transaction เดียวกัน ก่อนส่งอีเมล) / ไม่ระบุ = pool
async function loadOpsDoc(idOps, runner = null) {
  const req = runner ? new sql.Request(runner) : (await poolPromise).request();
  const r = await req.input('id', sql.Int, idOps).query(`
    SELECT m.*, CONVERT(varchar(10), m.DateDoc, 23) AS DocDate, CONVERT(varchar(23), ISNULL(m.DateEdit, m.DateTs), 121) AS Stamp,
           c.CompName, c.CompNameEng, c.Address AS CompAddress, c.PostCode AS CompPostCode, c.Tel AS CompTel, c.Fax AS CompFax,
           LTRIM(RTRIM(pvc.ProvinceName)) AS CompProvince, ct.CompName AS CompNameTarget,
           pr.PsName AS PsNameReq, pr.PsFullName AS FullReq, pr.PositionName AS PosReq,
           CONVERT(varchar(16), m.DateTs, 120) AS TxTs, pt.PsName AS PsTs, CONVERT(varchar(16), m.DateEdit, 120) AS TxEdit, pe.PsName AS PsEdit,
           CONVERT(varchar(16), m.DateSent, 120) AS TxSent, ps.PsName AS PsSent,
           CONVERT(varchar(16), m.DateCancel, 120) AS TxCancel, pc.PsName AS PsCancel,
           -- อนุมัติครบ (ผู้กดคนสุดท้าย) / ไม่รับซื้อ — ผลรายขั้นอยู่ใน SeedReqSaleApv
           CONVERT(varchar(16), m.DateApv, 120) AS TxApv, pav.PsName AS PsApv, CONVERT(varchar(16), m.DateReject, 120) AS TxReject, prj.PsName AS PsReject,
           -- ฝ่ายจัดซื้อ (ใบขออนุมัติรับซื้อ OPA) + ผลรอบขออนุมัติปัจจุบัน + PO ที่สร้างอัตโนมัติ
           CONVERT(varchar(10), m.BuyDateDoc, 23) AS BuyDocDate, CONVERT(varchar(16), m.DateBuy, 120) AS TxBuy, CONVERT(varchar(10), m.BuyDateGet, 23) AS BuyGetDate,
           pb.PsName AS PsBuy, pb.PsFullName AS FullBuy, pb.PositionName AS PosBuy,
           ar.ApvDone, ar.ApvBack, ar.ApvActed, ar.ApvCount, po.DocCode AS POCodeAuto, sod.DocCode AS SaleOrderCode,
           cb.CompNameEng AS TgtNameEng, cb.Address AS TgtAddress, cb.PostCode AS TgtPostCode, cb.Tel AS TgtTel, cb.Fax AS TgtFax, LTRIM(RTRIM(pvt.ProvinceName)) AS TgtProvince
    FROM devsk.SeedReqSaleMt m
    LEFT JOIN devsk.PkPOBuyMt po ON po.idPOTs = m.idPOTsAuto
    OUTER APPLY (SELECT TOP 1 o.DocCode FROM dbo.SmSaleOrderMt o WHERE o.idPOTs = m.idPOTsAuto AND m.idPOTsAuto IS NOT NULL AND o.idPsCancel IS NULL ORDER BY o.idSaleOrder DESC) sod
    LEFT JOIN PchInvAndProject.dbo.dCompany cb ON cb.idComp = m.idCompTarget
    LEFT JOIN PchInvAndProject.dbo.dProvinceFix pvt ON pvt.idProvince = cb.idProvince
    ${OPS_ROUND_SQL()}
    OUTER APPLY (SELECT TOP 1 v.PsName, v.PsFullName, v.PositionName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsBuy) pb
    LEFT JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = m.idCompReq
    LEFT JOIN PchInvAndProject.dbo.dProvinceFix pvc ON pvc.idProvince = c.idProvince
    LEFT JOIN PchInvAndProject.dbo.dCompany ct ON ct.idComp = m.idCompTarget
    OUTER APPLY (SELECT TOP 1 v.PsName, v.PsFullName, v.PositionName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsReq) pr
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsTs) pt
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsEdit) pe
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsSent) ps
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsCancel) pc
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsApv) pav
    OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsReject) prj
    WHERE m.idOps = @id;

    SELECT d.idOpsDt, d.idInvMain, ci.InvName, ci.idInvGroup, sd.SeedName, d.idUnit, u.UnitName, d.AmountPO, d.AmountRec, d.AmountSold, d.AmountProduce, d.AmountOffer, d.AmountBuy, d.Price, d.NoteDt
    FROM devsk.SeedReqSaleDt d
    JOIN devsk.dInventoryMain ci ON ci.idInvMain = d.idInvMain
    ${CROP_JOIN_SQL}
    LEFT JOIN dbo.dSeed sd ON sd.idSeed = ${CROP_ID_SQL}
    LEFT JOIN devsk.dInvUnit u ON u.idUnit = d.idUnit
    WHERE d.idOps = @id ORDER BY d.idOpsDt;

    SELECT p.idOpsDt, p.idPOTs, p.idPODt, p.POCode, CONVERT(varchar(10), p.DatePO, 23) AS DatePO, p.AmountPO, p.AmountRec, p.AmountSold
    FROM devsk.SeedReqSalePORef p WHERE p.idOps = @id ORDER BY p.DatePO, p.POCode, p.idPODt;

    SELECT l.Step, l.RecvType, l.Email, l.stSend, l.ErrMsg, CONVERT(varchar(16), l.DateSend, 120) AS TxSend, v.PsName
    FROM devsk.SeedReqSaleMailLog l
    OUTER APPLY (SELECT TOP 1 x.PsName FROM devsk.vPersonxSelect x WHERE x.idPs = l.idPs) v
    WHERE l.idOps = @id ORDER BY l.DateSend DESC, l.idMailLog;

    SELECT r.RecvType, r.idPs, v.PsName, v.PsFullName, v.PositionName, v.CompName, NULLIF(LTRIM(RTRIM(p.Email)), '') AS Email
    FROM devsk.SeedReqSaleMailRecv r
    LEFT JOIN dbo.dPerson p ON p.idPs = r.idPs
    OUTER APPLY (SELECT TOP 1 x.PsName, x.PsFullName, x.PositionName, x.CompName FROM devsk.vPersonxSelect x WHERE x.idPs = r.idPs) v
    WHERE r.idOps = @id ORDER BY r.idRecv;

    SELECT a.idApv, a.ApvRound, a.StepCode, a.idPsAssign, a.Result, a.Note, a.idPsAct, CONVERT(varchar(16), a.DateAct, 120) AS TxAct,
           CONVERT(varchar(16), a.DateTs, 120) AS TxTs, v.PsName, v.PsFullName, v.PositionName, NULLIF(LTRIM(RTRIM(p.Email)), '') AS Email, va.PsName AS PsAct
    FROM devsk.SeedReqSaleApv a
    LEFT JOIN dbo.dPerson p ON p.idPs = a.idPsAssign
    OUTER APPLY (SELECT TOP 1 x.PsName, x.PsFullName, x.PositionName FROM devsk.vPersonxSelect x WHERE x.idPs = a.idPsAssign) v
    OUTER APPLY (SELECT TOP 1 x.PsName FROM devsk.vPersonxSelect x WHERE x.idPs = a.idPsAct) va
    WHERE a.idOps = @id ORDER BY a.ApvRound, a.idApv;`);
  const m = r.recordsets[0][0];
  if (!m) return null;
  const pos = r.recordsets[2];
  return {
    id: m.idOps, docNo: m.DocCode, docDate: m.DocDate, stamp: m.Stamp, status: opsStatus(m),
    compReq: m.idCompReq, compReqName: m.CompName, compTarget: m.idCompTarget, compTargetName: m.CompNameTarget,
    compInfo: { nameEn: m.CompNameEng || '', address: m.CompAddress || '', province: m.CompProvince || '', postCode: m.CompPostCode || '', tel: m.CompTel || '', fax: m.CompFax || '' },
    requester: { id: m.idPsReq, name: m.PsNameReq || '-', full: (m.FullReq || '').trim(), pos: m.PosReq || '' },
    subject: m.Subject || '', causeNote: m.CauseNote || '', note: m.Note || '',
    created: { by: m.PsTs || '-', at: m.TxTs }, edited: m.TxEdit ? { by: m.PsEdit || '-', at: m.TxEdit } : null,
    sent: m.TxSent ? { by: m.PsSent || '-', at: m.TxSent } : null,
    cancel: m.TxCancel ? { by: m.PsCancel || '-', at: m.TxCancel, reason: m.CancelNote || '' } : null,
    reject: m.DateReject ? { note: m.RejectNote || '', step: m.RejectStep || '', by: m.PsReject || '-', at: m.TxReject } : null,
    buyerSteps: {
      approve: m.TxApv ? { by: m.PsApv || '-', at: m.TxApv } : null
    },
    items: r.recordsets[1].map(d => ({
      idInvMain: d.idInvMain, invName: d.InvName, seedName: d.SeedName, idUnit: d.idUnit, unit: d.UnitName,
      amountPO: Number(d.AmountPO), amountRec: Number(d.AmountRec), amountSold: d.AmountSold == null ? null : Number(d.AmountSold),
      amountProduce: Number(d.AmountProduce), amountOffer: Number(d.AmountOffer),
      price: d.Price == null ? null : Number(d.Price), note: d.NoteDt || '',
      idOpsDt: d.idOpsDt, idInvGroup: d.idInvGroup, amountBuy: d.AmountBuy == null ? null : Number(d.AmountBuy),
      pos: pos.filter(p => p.idOpsDt === d.idOpsDt).map(p => ({
        idPOTs: p.idPOTs, idPODt: p.idPODt, poCode: p.POCode, datePO: p.DatePO, amountPO: Number(p.AmountPO), amountRec: Number(p.AmountRec),
        amountSold: p.AmountSold == null ? null : Number(p.AmountSold)
      }))
    })),
    mails: r.recordsets[3].map(l => ({ step: l.Step, type: l.RecvType, email: l.Email, name: l.PsName || '', ok: !!l.stSend, error: l.ErrMsg || '', at: l.TxSend })),
    recipients: (() => {
      const ps = r.recordsets[4].map(x => ({ type: x.RecvType, idPs: x.idPs, name: x.PsName || `#${x.idPs}`, full: (x.PsFullName || '').trim(), position: x.PositionName || '', compName: x.CompName || '', email: x.Email }));
      return { to: ps.find(x => x.type === 'to') || null, cc: ps.filter(x => x.type === 'cc') };
    })(),
    // ---- ฝ่ายจัดซื้อ / ขออนุมัติ (เฟส 2) ----
    tgtInfo: { nameEn: m.TgtNameEng || '', address: m.TgtAddress || '', province: m.TgtProvince || '', postCode: m.TgtPostCode || '', tel: m.TgtTel || '', fax: m.TgtFax || '' },
    buy: m.BuyDocCode || m.TxBuy ? {
      docNo: m.BuyDocCode || null, docDate: m.BuyDocDate, at: m.TxBuy, dateGet: m.BuyGetDate, note: m.BuyNote || '',
      by: m.idPsBuy ? { id: m.idPsBuy, name: m.PsBuy || '-', full: (m.FullBuy || '').trim(), pos: m.PosBuy || '' } : null
    } : null,
    apvRound: m.ApvRound || 0,
    apvSummary: { done: m.ApvDone || 0, count: m.ApvCount || 0, acted: m.ApvActed || 0 },
    approvals: r.recordsets[5].map(a => ({
      id: a.idApv, round: a.ApvRound, step: a.StepCode, idPs: a.idPsAssign, name: a.PsName || `#${a.idPsAssign}`, full: (a.PsFullName || '').trim(),
      position: a.PositionName || '', email: a.Email, result: a.Result || null, note: a.Note || '', at: a.TxAct, actBy: a.idPsAct ? (a.PsAct || '-') : null, sentAt: a.TxTs
    })),
    poAuto: m.idPOTsAuto ? { id: m.idPOTsAuto, docNo: m.POCodeAuto || null, saleOrder: m.SaleOrderCode || null } : null
  };
}

// ผู้รับ to / cc ของเอกสาร เปิดดูได้แม้ไม่มีสิทธิ์เมนู (ดูอย่างเดียว) / canEdit = มีสิทธิ์เมนู + บริษัทผู้ร้องขอ
app.get('/api/ops/doc/:id', requireLogin, async (req, res) => {
  const idOps = parseInt(req.params.id, 10);
  if (!idOps) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  try {
    const access = await getUserAccess(req.idPs);
    const doc = await loadOpsDoc(idOps);
    if (!doc) return res.status(404).json({ success: false, message: 'ไม่พบเอกสาร' });
    const member = hasMenu(access, MENU_OPS) && (hasComp(access, doc.compReq) || hasComp(access, doc.compTarget));
    const buyer = hasMenu(access, MENU_OPS_BUY) && hasComp(access, doc.compTarget);
    const recipient = [doc.recipients.to, ...doc.recipients.cc].some(x => x && x.idPs === req.idPs);
    const approver = doc.approvals.some(a => a.idPs === req.idPs);
    if (!member && !buyer && !recipient && !approver) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เปิดเอกสารนี้' });
    const canEdit = hasMenu(access, MENU_OPS) && hasComp(access, doc.compReq);
    // ฝ่ายจัดซื้อ: กรอกจำนวนรับซื้อ/ราคา/ผู้อนุมัติ แล้วส่งขออนุมัติ — ได้ตอนรอฝ่ายจัดซื้อ / ส่งกลับแก้ไข / ส่งขออนุมัติแล้วแต่ยังไม่มีใครกด
    const buyOpen = doc.status === 'S' || doc.status === 'B' || (doc.status === 'H' && !doc.apvSummary.acted);
    const myApv = doc.status === 'H' ? doc.approvals.filter(a => a.round === doc.apvRound && a.idPs === req.idPs && !a.result).map(a => a.step) : [];
    // ราคา / จำนวนรับซื้อ / ผู้อนุมัติ เป็นข้อมูลภายในฝ่ายซื้อ — ฝั่งผู้ร้องขอ (และ CC) ไม่เห็น
    const internal = buyer || approver;
    const data = { ...doc, mails: member || buyer ? doc.mails : [], canEdit, viewOnly: !canEdit, canBuy: buyer && buyOpen, isBuyer: buyer, myApv, internal };
    if (!internal) {
      // ราคา: ผู้ร้องขอเห็นเมื่ออนุมัติแล้ว (ราคาอยู่ใน PO ที่ส่งถึงผู้ขายอยู่แล้ว)
      if (doc.status !== 'A') data.items = doc.items.map(it => ({ ...it, price: null }));
      data.approvals = [];
      data.buy = doc.buy ? { docNo: doc.buy.docNo, at: doc.buy.at } : null;
    }
    if (buyer && buyOpen) data.apvDefaults = await opsApvDefaults(idOps, doc);
    res.json({ success: true, data });
  } catch (err) {
    console.error('OPS doc error:', err);
    res.status(500).json({ success: false, message: 'โหลดเอกสารไม่สำเร็จ', detail: err.message });
  }
});

// ---------- บันทึกเอกสารใหม่ (ร่าง — ยังไม่ส่งอีเมล) ----------
// ---------- บันทึกและส่งคำร้อง: บันทึก + ส่งอีเมลใน transaction เดียว — ส่งถึงผู้รับคำร้องไม่สำเร็จ = ไม่บันทึกอะไรเลย ----------
app.post('/api/ops/docs', requireMenu(MENU_OPS, { companyParam: 'idCompReq' }), async (req, res) => {
  if (!opsMailReady()) return res.status(503).json({ success: false, message: 'ยังไม่ได้ตั้งค่าการส่งอีเมล (SMTP) ที่ server — บันทึกและส่งคำร้องไม่ได้ ติดต่อผู้ดูแลระบบ' });
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const parsed = await parseOpsBody(transaction, req.body);
    if (parsed.error) { await transaction.rollback(); return res.status(400).json({ success: false, message: parsed.error }); }
    const { head, items } = parsed;
    const now = (await new sql.Request(transaction).query('SELECT GETDATE() AS now')).recordset[0].now;
    const docCode = await getNextOpsDocCode(transaction, head.idCompReq, now);
    const mt = await new sql.Request(transaction)
      .input('doc', sql.VarChar(12), docCode).input('now', sql.DateTime, now)
      .input('req', sql.Int, head.idCompReq).input('tgt', sql.Int, head.idCompTarget).input('ps', sql.Int, head.idPsReq)
      .input('subj', sql.NVarChar(300), head.subject).input('cause', sql.NVarChar(sql.MAX), head.causeNote)
      .input('note', sql.NVarChar(1000), head.note || null).input('ts', sql.Int, req.idPs)
      .query(`INSERT INTO devsk.SeedReqSaleMt (DocCode, DateDoc, idCompReq, idCompTarget, idPsReq, Subject, CauseNote, Note, idPsTs, DateTs)
              VALUES (@doc, @now, @req, @tgt, @ps, @subj, @cause, @note, @ts, @now);
              SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`);
    const idOps = mt.recordset[0].id;
    await insertOpsItems(transaction, idOps, items);
    await saveOpsRecipients(transaction, idOps, head, req.idPs);
    const sent = await deliverOpsMails(transaction, idOps, 'send', req);
    if (!sent.ok) {
      await transaction.rollback();
      return res.status(502).json({ success: false, message: `${sent.message} — ระบบยังไม่ได้บันทึกเอกสาร กรุณาลองใหม่`, results: sent.results });
    }
    await transaction.commit();
    res.json({ success: true, id: idOps, docNo: docCode, dryRun: sent.dryRun, results: sent.results });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('OPS save error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเอกสารไม่สำเร็จ — ระบบไม่ได้บันทึกข้อมูลใดๆ', detail: err.message });
  }
});

// ---------- แก้ไข: ได้จนกว่าฝั่งผู้ซื้อจะเริ่มดำเนินการ (ตรวจสอบ) — บันทึกแล้วส่งอีเมล "(แก้ไขเอกสาร)" ถึงผู้รับคำร้อง + CC ----------
// ส่งอีเมลไม่สำเร็จ = ไม่บันทึกการแก้ไข / เปลี่ยนบริษัทผู้ร้องขอไม่ได้ / มีคนแก้ไปก่อน = ไม่บันทึก
app.put('/api/ops/docs/:id', requireMenu(MENU_OPS), async (req, res) => {
  const idOps = parseInt(req.params.id, 10);
  if (!idOps) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  if (!opsMailReady()) return res.status(503).json({ success: false, message: 'ยังไม่ได้ตั้งค่าการส่งอีเมล (SMTP) ที่ server — ติดต่อผู้ดูแลระบบ' });
  let transaction;
  const fail = async (code, message, extra = {}) => { await transaction.rollback(); return res.status(code).json({ success: false, message, ...extra }); };
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const cur = await lockOpsDoc(transaction, idOps);
    if (!cur) return fail(404, 'ไม่พบเอกสาร');
    if (!hasComp(req.access, cur.idCompReq)) return fail(403, 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้');
    const st = opsStatus(cur);
    if (!['D', 'S'].includes(st)) return fail(409, 'ฝั่งผู้ซื้อเริ่มดำเนินการแล้ว หรือเอกสารถูกยกเลิก — แก้ไขไม่ได้');
    if (req.body.stamp && req.body.stamp !== cur.Stamp) return fail(409, 'มีผู้อื่นแก้ไขเอกสารนี้ไปก่อนแล้ว — กรุณาเปิดเอกสารใหม่อีกครั้ง');
    const parsed = await parseOpsBody(transaction, { ...req.body, idCompReq: cur.idCompReq }, { excludeIdOps: idOps });
    if (parsed.error) return fail(400, parsed.error);
    const { head, items } = parsed;
    await new sql.Request(transaction)
      .input('id', sql.Int, idOps).input('tgt', sql.Int, head.idCompTarget).input('ps', sql.Int, head.idPsReq)
      .input('subj', sql.NVarChar(300), head.subject).input('cause', sql.NVarChar(sql.MAX), head.causeNote)
      .input('note', sql.NVarChar(1000), head.note || null).input('ed', sql.Int, req.idPs)
      .query(`UPDATE devsk.SeedReqSaleMt SET idCompTarget = @tgt, idPsReq = @ps, Subject = @subj, CauseNote = @cause, Note = @note,
                     idPsEdit = @ed, DateEdit = GETDATE()
              WHERE idOps = @id;
              DELETE FROM devsk.SeedReqSalePORef WHERE idOps = @id;
              DELETE FROM devsk.SeedReqSaleDt WHERE idOps = @id;`);
    await insertOpsItems(transaction, idOps, items);
    await saveOpsRecipients(transaction, idOps, head, req.idPs);
    const sent = await deliverOpsMails(transaction, idOps, st === 'S' ? 'edit' : 'send', req);
    if (!sent.ok) return fail(502, `${sent.message} — ระบบยังไม่ได้บันทึกการแก้ไข กรุณาลองใหม่`, { results: sent.results });
    await transaction.commit();
    res.json({ success: true, id: idOps, docNo: cur.DocCode, dryRun: sent.dryRun, results: sent.results });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('OPS edit error:', err);
    res.status(500).json({ success: false, message: 'แก้ไขเอกสารไม่สำเร็จ — ระบบไม่ได้เปลี่ยนแปลงข้อมูล', detail: err.message });
  }
});

// ---------- ยกเลิก (ร่าง หรือส่งแล้วแต่ฝั่งผู้ซื้อยังไม่ดำเนินการ) — ต้องระบุเหตุผล ----------
app.post('/api/ops/docs/:id/cancel', requireMenu(MENU_OPS), async (req, res) => {
  const idOps = parseInt(req.params.id, 10);
  const note = String(req.body.note || '').trim();
  if (!idOps) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  if (note.length <= 5 || /^[-0\s]+$/.test(note)) return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลการยกเลิก (มากกว่า 5 ตัวอักษร)' });
  if (note.length > 500) return res.status(400).json({ success: false, message: 'เหตุผลยาวเกิน 500 ตัวอักษร' });
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const cur = await lockOpsDoc(transaction, idOps);
    const stop = async (code, message) => { await transaction.rollback(); return res.status(code).json({ success: false, message }); };
    if (!cur) return stop(404, 'ไม่พบเอกสาร');
    if (!hasComp(req.access, cur.idCompReq)) return stop(403, 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้');
    if (!['D', 'S'].includes(opsStatus(cur))) return stop(409, 'ฝั่งผู้ซื้อดำเนินการกับเอกสารนี้แล้ว หรือถูกยกเลิกไปแล้ว — ยกเลิกไม่ได้');
    await new sql.Request(transaction).input('id', sql.Int, idOps).input('ps', sql.Int, req.idPs).input('note', sql.NVarChar(500), note)
      .query('UPDATE devsk.SeedReqSaleMt SET idPsCancel = @ps, DateCancel = GETDATE(), CancelNote = @note WHERE idOps = @id');
    await transaction.commit();
    res.json({ success: true });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('OPS cancel error:', err);
    res.status(500).json({ success: false, message: 'ยกเลิกเอกสารไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ผู้รับอีเมล (ตามบริษัทผู้ซื้อ) ----------
// รายชื่อฝ่ายจัดซื้อที่เลือกเป็น "ผู้รับคำร้อง" ได้ / isDefault = ผู้รับค่าเริ่มต้นของบริษัท (ไม่ได้ตั้ง = คนแรกตามชื่อ) — เรียงคนค่าเริ่มต้นก่อน
async function opsRecipients(runner, idComp, step = OPS_MAIL_STEP_CHECK) {
  const req = runner instanceof sql.Transaction ? new sql.Request(runner) : runner.request();
  const r = await req.input('idComp', sql.Int, idComp).input('step', sql.VarChar(10), step).query(`
    SELECT t.idMailTo, t.idPs, t.stDefault, v.PsName, v.PsFullName, v.PositionName, NULLIF(LTRIM(RTRIM(p.Email)), '') AS Email
    FROM devsk.SeedReqSaleMailTo t
    LEFT JOIN dbo.dPerson p ON p.idPs = t.idPs
    OUTER APPLY (SELECT TOP 1 x.PsName, x.PsFullName, x.PositionName FROM devsk.vPersonxSelect x WHERE x.idPs = t.idPs) v
    WHERE t.idComp = @idComp AND t.Step = @step AND t.stDel IS NULL
    ORDER BY CASE WHEN t.stDefault = 1 THEN 0 ELSE 1 END, v.PsName`);
  const list = r.recordset.map(x => ({ id: x.idMailTo, idPs: x.idPs, name: x.PsName || `#${x.idPs}`, full: (x.PsFullName || '').trim(), position: x.PositionName || '', email: x.Email, isDefault: !!x.stDefault }));
  if (list.length && !list.some(x => x.isDefault)) list[0].isDefault = true;
  return list;
}
const opsValidEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

app.get('/api/ops/mailto', requireMenu(MENU_OPS), async (req, res) => {
  const idComp = parseInt(req.query.idComp, 10);
  if (!OPS_COMPANY_IDS.includes(idComp)) return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัท' });
  try {
    const pool = await poolPromise;
    res.json({ success: true, data: await opsRecipients(pool, idComp), canEdit: hasMenu(req.access, MENU_OPS_MAILTO) });
  } catch (err) {
    console.error('OPS mailto error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายชื่อผู้รับอีเมลไม่สำเร็จ', detail: err.message });
  }
});

app.post('/api/ops/mailto', requireMenu(MENU_OPS_MAILTO), async (req, res) => {
  const idComp = parseInt(req.body.idComp, 10);
  const idPs = parseInt(req.body.idPs, 10);
  if (!OPS_COMPANY_IDS.includes(idComp) || !idPs) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
  try {
    const pool = await poolPromise;
    await pool.request().input('idComp', sql.Int, idComp).input('idPs', sql.Int, idPs).input('step', sql.VarChar(10), OPS_MAIL_STEP_CHECK)
      .input('ts', sql.Int, req.idPs)
      .query(`IF NOT EXISTS (SELECT 1 FROM devsk.SeedReqSaleMailTo WHERE idComp = @idComp AND Step = @step AND idPs = @idPs AND stDel IS NULL)
                INSERT INTO devsk.SeedReqSaleMailTo (idComp, Step, idPs, idPsTs, DateTs) VALUES (@idComp, @step, @idPs, @ts, GETDATE())`);
    res.json({ success: true, data: await opsRecipients(pool, idComp) });
  } catch (err) {
    console.error('OPS mailto add error:', err);
    res.status(500).json({ success: false, message: 'เพิ่มผู้รับอีเมลไม่สำเร็จ', detail: err.message });
  }
});

app.delete('/api/ops/mailto/:id', requireMenu(MENU_OPS_MAILTO), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  try {
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, id)
      .query('UPDATE devsk.SeedReqSaleMailTo SET stDel = 1 OUTPUT inserted.idComp WHERE idMailTo = @id AND stDel IS NULL');
    const idComp = r.recordset[0] && r.recordset[0].idComp;
    res.json({ success: true, data: idComp ? await opsRecipients(pool, idComp) : [] });
  } catch (err) {
    console.error('OPS mailto delete error:', err);
    res.status(500).json({ success: false, message: 'ลบผู้รับอีเมลไม่สำเร็จ', detail: err.message });
  }
});

// ตั้งผู้รับคำร้องค่าเริ่มต้นของบริษัท (1 คนต่อบริษัท)
app.post('/api/ops/mailto/:id/default', requireMenu(MENU_OPS_MAILTO), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  try {
    const pool = await poolPromise;
    const r = await pool.request().input('id', sql.Int, id).query(`
      DECLARE @c int, @s varchar(10);
      SELECT @c = idComp, @s = Step FROM devsk.SeedReqSaleMailTo WHERE idMailTo = @id AND stDel IS NULL;
      UPDATE devsk.SeedReqSaleMailTo SET stDefault = CASE WHEN idMailTo = @id THEN 1 ELSE NULL END WHERE idComp = @c AND Step = @s;
      SELECT @c AS idComp;`);
    const idComp = r.recordset[0] && r.recordset[0].idComp;
    res.json({ success: true, data: idComp ? await opsRecipients(pool, idComp) : [] });
  } catch (err) {
    console.error('OPS mailto default error:', err);
    res.status(500).json({ success: false, message: 'ตั้งผู้รับค่าเริ่มต้นไม่สำเร็จ', detail: err.message });
  }
});

// ข้อมูลพนักงาน + อีเมล (ใช้ตอนเพิ่มผู้รับสำเนา CC ในฟอร์ม)
app.get('/api/ops/people', requireMenu([MENU_OPS, MENU_OPS_BUY]), async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(v => parseInt(v, 10)).filter(Boolean).slice(0, 50);
  try {
    const pool = await poolPromise;
    res.json({ success: true, data: await opsPeople(pool, ids) });
  } catch (err) {
    console.error('OPS people error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลพนักงานไม่สำเร็จ', detail: err.message });
  }
});

// ---------- เนื้อหาอีเมลแจ้งคำร้อง (HTML — inline style เพราะโปรแกรมอ่านเมลไม่รองรับ <style>) ----------
const opsEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// ทศนิยม 2 ตำแหน่ง / ค่าที่เบามาก (ไม่ใช่ 0 แต่ 2 ตำแหน่งได้ 0.00) แสดง 3–6 ตำแหน่ง — ตรงกับ fmtQty() ในหน้าเว็บ
const opsFmtQty = (v) => {
  if (v == null) return '-';
  const n = Number(v);
  const tiny = n !== 0 && Math.abs(n) < 0.005;
  return n.toLocaleString('en-US', tiny ? { minimumFractionDigits: 3, maximumFractionDigits: 6 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
// kind: send = ส่งคำร้อง / edit = แก้ไขหลังส่ง / resend = ส่งซ้ำ
// role: to = ผู้รับคำร้อง (ปุ่มเข้าไปดำเนินการ) / cc = สำเนาแจ้งเพื่อทราบ (ปุ่มดูเอกสารอย่างเดียว)
function buildOpsMail(doc, link, kind, role, to, cc) {
  const th = 'style="border:1px solid #bbb;padding:6px 8px;background:#f2f2f2;font-weight:700;text-align:center"';
  const td = (v, num) => `<td style="border:1px solid #bbb;padding:6px 8px;${num ? 'text-align:right;white-space:nowrap' : ''}">${v}</td>`;
  const kv = (k, v) => `<tr><td style="padding:2px 12px 2px 0;color:#555;vertical-align:top;white-space:nowrap">${k}</td><td>${v}</td></tr>`;
  // ชื่อทางการ (คำนำหน้า ชื่อ นามสกุล ไม่มีชื่อเล่น) — แบบเดียวกับผู้ร้องขอ
  const formal = (p) => p.full || String(p.name || '').replace(/\s*\([^)]*\)\s*$/, '');
  const person = (p) => `${opsEsc(formal(p))}${p.position ? ` (${opsEsc(p.position)})` : ''}`;
  const rows = doc.items.map((it, i) => `<tr>${td(i + 1)}${td(`<b>${opsEsc(it.invName)}</b><br><span style="color:#555;font-size:12px">PO ที่อ้างอิง: ${opsEsc(it.pos.map(p => p.poCode).join(', '))}</span>`)}
    ${td(opsFmtQty(it.amountPO), 1)}${td(opsFmtQty(it.amountSold), 1)}${td(opsFmtQty(it.amountRec), 1)}${td(opsFmtQty(it.amountProduce), 1)}
    ${td(`<b style="color:#c0392b">${opsFmtQty(it.amountProduce - it.amountPO)}</b>`, 1)}${td(`<b>${opsFmtQty(it.amountOffer)}</b>`, 1)}${td(opsEsc(it.unit || '-'))}</tr>`).join('');
  const isCc = role === 'cc';
  const tag = (isCc ? '(แจ้งเพื่อทราบ) ' : '') + (kind === 'edit' ? '(แก้ไขเอกสาร) ' : kind === 'resend' ? '(ส่งซ้ำ) ' : '');
  const subject = `[WIM] ${tag}ร้องขอขายเมล็ดพันธุ์ (Over PO) ${doc.docNo} — ${doc.compReqName}`;
  const action = kind === 'edit' ? 'แก้ไขคำร้อง' : 'ส่งคำร้อง';
  const intro = isCc
    ? `<p>เรียน ผู้เกี่ยวข้อง</p><p><b>แจ้งเพื่อทราบ:</b> ${opsEsc(doc.compReqName)} ${action}ขอขายเมล็ดพันธุ์ที่ผลิตเกินใบสั่งซื้อ (Over PO) ถึงฝ่ายจัดซื้อ ${opsEsc(doc.compTargetName)}${kind === 'edit' ? ' รายละเอียดล่าสุดดังนี้' : ''}</p>`
    : `<p>เรียน ${opsEsc(opsDear(to))} ฝ่ายจัดซื้อ ${opsEsc(doc.compTargetName)}</p>` + (kind === 'edit'
      ? `<p>${opsEsc(doc.compReqName)} <b>แก้ไข</b>คำร้องขอขายเมล็ดพันธุ์ที่ผลิตเกินใบสั่งซื้อ (Over PO) — กรุณาใช้รายละเอียดล่าสุดด้านล่างแทนฉบับก่อนหน้า</p>`
      : `<p>${opsEsc(doc.compReqName)} ส่งคำร้องขอขายเมล็ดพันธุ์ที่ผลิตเกินใบสั่งซื้อ (Over PO) เพื่อโปรดพิจารณาและดำเนินการ</p>`);
  const btn = isCc ? `ดูเอกสาร ${doc.docNo}` : `เปิดเอกสารเพื่อดำเนินการ ${doc.docNo}`;
  const html = `<div style="font-family:Tahoma,Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
    ${intro}
    <table style="border-collapse:collapse;margin:8px 0 14px">
      ${kv('เลขที่เอกสาร', `<b>${opsEsc(doc.docNo)}</b>`)}
      ${kv('วันที่', opsEsc(ursFmtDateThai(doc.docDate)))}
      ${kv('เรื่อง', opsEsc(doc.subject))}
      ${kv('ผู้ร้องขอ', `${opsEsc(doc.requester.full || doc.requester.name)}${doc.requester.pos ? ` (${opsEsc(doc.requester.pos)})` : ''}`)}
      ${kv('ส่งคำร้องถึง', person(to))}
      ${cc.length ? kv('สำเนาถึง', cc.map(person).join('<br>')) : ''}
    </table>
    <table style="border-collapse:collapse;font-size:13px">
      <tr><th ${th}>#</th><th ${th}>เมล็ดพันธุ์ / PO ที่อ้างอิง</th><th ${th}>จำนวน PO</th><th ${th}>ขายแล้ว (ผู้ขาย)</th><th ${th}>รับเข้าแล้ว (ผู้ซื้อ)</th><th ${th}>ผลิตได้ทั้งหมด</th><th ${th}>จำนวนเกิน PO</th><th ${th}>เสนอขายเพิ่ม</th><th ${th}>หน่วย</th></tr>
      ${rows}
    </table>
    <p style="margin-top:14px"><b>สาเหตุการผลิตเกิน PO</b><br>${opsEsc(doc.causeNote).replace(/\n/g, '<br>')}</p>
    ${doc.note ? `<p><b>หมายเหตุ</b><br>${opsEsc(doc.note).replace(/\n/g, '<br>')}</p>` : ''}
    <p style="margin:22px 0"><a href="${opsEsc(link)}" style="background:${isCc ? '#4ea7e0' : '#f2a91c'};color:#111;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700">${opsEsc(btn)}</a></p>
    <p style="color:#888;font-size:12px">อีเมลนี้ส่งอัตโนมัติจากระบบ WIM${isCc ? ' — สำเนาแจ้งเพื่อทราบ เปิดดูเอกสารได้อย่างเดียว' : ''} (ต้องเข้าสู่ระบบก่อนเปิดเอกสาร)<br>${opsEsc(link)}</p>
  </div>`;
  return { subject, html };
}

// ส่งอีเมลของเอกสาร (ภายใน transaction ของการบันทึก/แก้ไข/ส่งซ้ำ): ผู้รับคำร้อง 1 ฉบับ + สำเนา (CC ทุกคน) อีก 1 ฉบับ
// ส่งถึงผู้รับคำร้องไม่สำเร็จ = { ok: false } ให้ผู้เรียก rollback ทั้งหมด / สำเร็จ = เขียน log + ตั้ง DateSent (ครั้งแรก)
// เอกสารเก่าที่ยังไม่มีผู้รับรายเอกสาร → ใช้ผู้รับค่าเริ่มต้นของบริษัทผู้ซื้อ
async function deliverOpsMails(transaction, idOps, kind, req) {
  const doc = await loadOpsDoc(idOps, transaction);
  let { to } = doc.recipients;
  const cc = doc.recipients.cc.filter(x => opsValidEmail(x.email));
  if (!to) to = (await opsRecipients(transaction, doc.compTarget)).find(x => opsValidEmail(x.email)) || null;
  if (!to || !opsValidEmail(to.email)) return { ok: false, message: 'ไม่พบผู้รับคำร้องที่มีอีเมล', results: [] };

  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '') || ursReplyOrigin(req);
  const link = `${base}/over-po-sale-doc?id=${idOps}`;          // CC: ดูเอกสารอย่างเดียว
  const buyLink = `${base}/over-po-sale-buy?id=${idOps}`;      // ผู้รับคำร้อง: หน้าจัดการคำร้องของฝ่ายจัดซื้อ
  const logs = [];
  const m1 = buildOpsMail(doc, buyLink, kind, 'to', to, cc);
  const r1 = await opsSendMail({ to: [to.email], cc: [], subject: m1.subject, html: m1.html });
  const toOk = r1.ok.has(to.email.toLowerCase());
  logs.push({ type: 'to', idPs: to.idPs, email: to.email, ok: toOk, err: toOk ? null : (r1.error || 'ส่งไม่สำเร็จ') });
  if (!toOk) return { ok: false, message: `ส่งอีเมลถึงผู้รับคำร้องไม่สำเร็จ: ${r1.error || 'ไม่ทราบสาเหตุ'}`, results: logs.map(({ type, email, ok }) => ({ type, email, ok })) };
  if (cc.length) {
    const m2 = buildOpsMail(doc, link, kind, 'cc', to, cc);
    const r2 = await opsSendMail({ to: cc.map(x => x.email), cc: [], subject: m2.subject, html: m2.html });
    cc.forEach(x => {
      const ok = r2.ok.has(x.email.toLowerCase());
      logs.push({ type: 'cc', idPs: x.idPs, email: x.email, ok, err: ok ? null : (r2.error || 'ส่งไม่สำเร็จ') });
    });
  }

  const now = (await new sql.Request(transaction).query('SELECT GETDATE() AS now')).recordset[0].now;
  for (const l of logs) {
    await new sql.Request(transaction)
      .input('id', sql.Int, idOps).input('step', sql.VarChar(20), kind).input('type', sql.VarChar(3), l.type)
      .input('ps', sql.Int, l.idPs).input('mail', sql.NVarChar(255), l.email).input('ok', sql.Bit, l.ok)
      .input('err', sql.NVarChar(1000), l.err ? String(l.err).slice(0, 1000) : null)
      .input('by', sql.Int, req.idPs).input('now', sql.DateTime, now)
      .query(`INSERT INTO devsk.SeedReqSaleMailLog (idOps, Step, RecvType, idPs, Email, stSend, ErrMsg, idPsSend, DateSend)
              VALUES (@id, @step, @type, @ps, @mail, @ok, @err, @by, @now)`);
  }
  await new sql.Request(transaction).input('id', sql.Int, idOps).input('ps', sql.Int, req.idPs).input('now', sql.DateTime, now)
    .query('UPDATE devsk.SeedReqSaleMt SET idPsSent = @ps, DateSent = @now WHERE idOps = @id AND DateSent IS NULL');
  return { ok: true, dryRun: opsMailDryRun(), results: logs.map(({ type, email, ok }) => ({ type, email, ok })) };
}

// ---------- ส่งอีเมลซ้ำ (เอกสารที่ส่งแล้ว ฝั่งผู้ซื้อยังไม่ดำเนินการ) / ส่งเอกสารร่างเดิม (ก่อนมีปุ่มบันทึกและส่ง) ----------
app.post('/api/ops/docs/:id/send', requireMenu(MENU_OPS), async (req, res) => {
  const idOps = parseInt(req.params.id, 10);
  if (!idOps) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  if (!opsMailReady()) return res.status(503).json({ success: false, message: 'ยังไม่ได้ตั้งค่าการส่งอีเมล (SMTP) ที่ server — ติดต่อผู้ดูแลระบบ' });
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const cur = await lockOpsDoc(transaction, idOps);
    const stop = async (code, message, extra = {}) => { await transaction.rollback(); return res.status(code).json({ success: false, message, ...extra }); };
    if (!cur) return stop(404, 'ไม่พบเอกสาร');
    if (!hasComp(req.access, cur.idCompReq)) return stop(403, 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้');
    const st = opsStatus(cur);
    if (!['D', 'S'].includes(st)) return stop(409, 'เอกสารถูกยกเลิก หรือฝั่งผู้ซื้อดำเนินการแล้ว — ส่งไม่ได้');
    const sent = await deliverOpsMails(transaction, idOps, st === 'S' ? 'resend' : 'send', req);
    if (!sent.ok) return stop(502, sent.message, { results: sent.results });
    await transaction.commit();
    res.json({ success: true, dryRun: sent.dryRun, results: sent.results });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('OPS send error:', err);
    res.status(500).json({ success: false, message: 'ส่งอีเมลไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- ร้องขอขายเมล็ดพันธุ์ (Over PO) เฟส 2: ฝ่ายจัดซื้อพิจารณา + ขออนุมัติ 4 ขั้น + สร้าง PO อัตโนมัติ ----------
// ==================================================================
// 1. ฝ่ายจัดซื้อ (สิทธิ์ over_po_sale_buy + บริษัทผู้ซื้อ) กรอกจำนวนรับซื้อจริง / ราคา/หน่วย / วันที่รับของ / ผู้อนุมัติ 4 ขั้น
//    → ออกเลขใบขออนุมัติ OPA + ส่งอีเมลถึงผู้อนุมัติทั้ง 4 พร้อมกัน (ส่งไม่สำเร็จ = ไม่บันทึก) / หรือตัดสินไม่รับซื้อเอง (แจ้งผู้ร้องขอ)
// 2. ผู้อนุมัติกดลำดับไหนก่อนก็ได้: ผ่าน / ส่งกลับแก้ไข (กลับไปฝ่ายจัดซื้อ แก้แล้วส่งใหม่ = รอบใหม่) / ไม่รับซื้อ (จบ)
// 3. ผ่านครบ 4 ขั้น → สร้าง PO (TypeTs 8 / X..) อนุมัติแล้ว + ใบสั่งขายฝั่งผู้ขาย (sp_InsertPOxSlOrder) ใน transaction เดียว
//    → อีเมลแจ้งผู้ร้องขอพร้อมเลข PO
const opsFormal = (p) => (p && (p.full || String(p.name || '').replace(/\s*\([^)]*\)\s*$/, ''))) || '-';
// คำขึ้นต้นอีเมล: "เรียน คุณชื่อ นามสกุล" — ตัดคำนำหน้าชื่อ (นาย / นาง / นางสาว / ดร. ...) แล้วใช้ "คุณ" แทน
const OPS_TITLE_RE = /^(นางสาว|น\.ส\.|นาง|นาย|ด\.ช\.|ด\.ญ\.|ดร\.|ว่าที่\s*ร\.?\s*ต\.?(\s*หญิง)?)\s*/;
const opsDear = (p) => { const n = opsFormal(p).replace(OPS_TITLE_RE, '').trim(); return n && n !== '-' ? `คุณ${n}` : 'ผู้เกี่ยวข้อง'; };
const opsStepName = (code) =>(OPS_APV_STEPS.find(s => s.code === code) || {}).name || code;
const opsStepAct = (code) => opsStepName(code).replace(/^ผู้/, '');   // ผู้อนุมัติ 1 → อนุมัติ 1
const opsBase = (req) => (process.env.APP_BASE_URL || '').replace(/\/+$/, '') || ursReplyOrigin(req);
const opsRound2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const opsFmtMoney = (v) => v == null ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const opsFmtPrice = (v) => v == null ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

// ผู้อนุมัติค่าเริ่มต้น: รอบก่อนหน้า (ส่งใหม่หลังแก้ไข) / ไม่มี = คนที่พบบ่อยสุดในแต่ละขั้นของ PO ที่อ้างอิง
// อนุมัติ 1 = อนุมัติ 2 (PO เดิมใส่ซ้ำ) → OPS_APV_FIX
async function opsApvDefaults(idOps, doc) {
  const pool = await poolPromise;
  let ids = {};
  const prev = doc.apvRound ? doc.approvals.filter(a => a.round === doc.apvRound) : [];
  if (prev.length) prev.forEach(a => { ids[a.step] = a.idPs; });
  else {
    const r = await pool.request().input('id', sql.Int, idOps).query(`
      SELECT b.idPsAccept, b.idPsCheck, b.idPsApprove1, b.idPsApprove2
      FROM devsk.PkPOBuyMt b WHERE b.idPOTs IN (SELECT DISTINCT idPOTs FROM devsk.SeedReqSalePORef WHERE idOps = @id)`);
    for (const st of OPS_APV_STEPS) {
      const cnt = new Map();
      r.recordset.forEach(x => { const v = x[st.poPs]; if (v) cnt.set(v, (cnt.get(v) || 0) + 1); });
      const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
      ids[st.code] = top ? top[0] : null;
    }
    if (ids.approve1 && ids.approve1 === ids.approve2) Object.assign(ids, OPS_APV_FIX);
  }
  const people = await opsPeople(pool, Object.values(ids).filter(Boolean));
  const out = {};
  OPS_APV_STEPS.forEach(st => { out[st.code] = (ids[st.code] && people.find(p => p.idPs === ids[st.code])) || null; });
  return out;
}

// เลขใบขออนุมัติรับซื้อ OPA{YY}{MM}/{0001} — รันแยกบริษัทผู้ซื้อ เริ่มใหม่ทุกปี
async function getNextOpaDocCode(transaction, idCompTarget, date) {
  const yy = String(date.getFullYear() + 543).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const r = await new sql.Request(transaction)
    .input('idComp', sql.Int, idCompTarget)
    .input('pat', sql.VarChar, `OPA${yy}__/%`)
    .query(`SELECT MAX(TRY_CAST(RIGHT(BuyDocCode, 4) AS INT)) AS last
            FROM devsk.SeedReqSaleMt WITH (UPDLOCK, HOLDLOCK)
            WHERE idCompTarget = @idComp AND BuyDocCode LIKE @pat`);
  return `OPA${yy}${mm}/${String((r.recordset[0].last || 0) + 1).padStart(4, '0')}`;
}

// ---------- อีเมลฝั่งผู้ซื้อ ----------
// ตารางรายการ: จำนวนเสนอขาย / รับซื้อ / ราคา / จำนวนเงิน (ข้อมูลภายในฝ่ายซื้อ — ส่งผู้ร้องขอเฉพาะตอนอนุมัติแล้ว)
function opsBuyItemsTable(doc) {
  const th = 'style="border:1px solid #bbb;padding:6px 8px;background:#f2f2f2;font-weight:700;text-align:center"';
  const td = (v, num) => `<td style="border:1px solid #bbb;padding:6px 8px;${num ? 'text-align:right;white-space:nowrap' : ''}">${v}</td>`;
  let total = 0;
  const rows = doc.items.map((it, i) => {
    const amt = it.amountBuy != null && it.price != null ? opsRound2(it.amountBuy * it.price) : null;
    total += amt || 0;
    return `<tr>${td(i + 1)}${td(`<b>${opsEsc(it.invName)}</b><br><span style="color:#555;font-size:12px">PO ที่อ้างอิง: ${opsEsc(it.pos.map(p => p.poCode).join(', '))}</span>`)}
      ${td(opsFmtQty(it.amountOffer), 1)}${td(`<b>${opsFmtQty(it.amountBuy)}</b>`, 1)}${td(opsEsc(it.unit || '-'))}${td(opsFmtPrice(it.price), 1)}${td(opsFmtMoney(amt), 1)}</tr>`;
  }).join('');
  return `<table style="border-collapse:collapse;font-size:13px">
      <tr><th ${th}>#</th><th ${th}>เมล็ดพันธุ์ / PO ที่อ้างอิง</th><th ${th}>เสนอขาย</th><th ${th}>รับซื้อ</th><th ${th}>หน่วย</th><th ${th}>ราคา/หน่วย (บาท)</th><th ${th}>จำนวนเงิน (บาท)</th></tr>
      ${rows}
      <tr><td colspan="6" style="border:1px solid #bbb;padding:6px 8px;text-align:right;font-weight:700">รวมเป็นเงิน</td>${td(`<b>${opsFmtMoney(total)}</b>`, 1)}</tr>
    </table>`;
}
const opsMailWrap = (body, link, btn, color, foot) => `<div style="font-family:Tahoma,Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
    ${body}
    ${link ? `<p style="margin:22px 0"><a href="${opsEsc(link)}" style="background:${color};color:#111;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700">${opsEsc(btn)}</a></p>` : ''}
    <p style="color:#888;font-size:12px">อีเมลนี้ส่งอัตโนมัติจากระบบ WIM${foot ? ` — ${foot}` : ''} (ต้องเข้าสู่ระบบก่อนเปิดเอกสาร)${link ? `<br>${opsEsc(link)}` : ''}</p>
  </div>`;
const opsKv = (rows) => `<table style="border-collapse:collapse;margin:8px 0 14px">${rows.filter(Boolean).map(([k, v]) =>
  `<tr><td style="padding:2px 12px 2px 0;color:#555;vertical-align:top;white-space:nowrap">${k}</td><td>${v}</td></tr>`).join('')}</table>`;

// ขออนุมัติ (ถึงผู้อนุมัติ 1 คน — ระบุขั้นของคนนั้น) kind: request / edit / resubmit / remind
function buildOpsApvMail(doc, link, person, steps, kind) {
  const tag = { edit: '(แก้ไขเอกสาร) ', resubmit: '(ส่งขออนุมัติใหม่) ', remind: '(เตือน) ' }[kind] || '';
  const subject = `[WIM] ${tag}ขออนุมัติรับซื้อเมล็ดพันธุ์ส่วนเกิน PO ${doc.buy.docNo} — ${doc.compReqName}`;
  const lead = {
    edit: 'ฝ่ายจัดซื้อ<b>แก้ไข</b>ใบขออนุมัติ — กรุณาใช้รายละเอียดล่าสุดด้านล่างแทนฉบับก่อนหน้า',
    resubmit: 'ฝ่ายจัดซื้อแก้ไขตามที่ส่งกลับแล้ว และส่งขออนุมัติใหม่ (ผลการพิจารณารอบก่อนถูกล้าง ต้องพิจารณาใหม่ทุกท่าน)',
    remind: 'ใบขออนุมัติด้านล่าง<b>ยังรอการพิจารณาของท่าน</b>'
  }[kind] || 'ฝ่ายจัดซื้อขออนุมัติรับซื้อเมล็ดพันธุ์ที่ผลิตเกินใบสั่งซื้อ (Over PO) ตามคำร้องของผู้ขาย';
  const body = `<p>เรียน ${opsEsc(opsDear(person))}</p>
    <p>${lead} — ท่านเป็น<b>${opsEsc(steps.map(opsStepName).join(' / '))}</b> ของเอกสารนี้ (ผู้อนุมัติแต่ละท่านพิจารณาได้ทันที ไม่ต้องรอท่านอื่น)</p>
    ${opsKv([
      ['ใบขออนุมัติเลขที่', `<b>${opsEsc(doc.buy.docNo)}</b>`],
      ['อ้างอิงใบร้องขอ', `${opsEsc(doc.docNo)} — ${opsEsc(doc.compReqName)}`],
      ['ผู้ขออนุมัติ', `${opsEsc(opsFormal(doc.buy.by))}${doc.buy.by && doc.buy.by.pos ? ` (${opsEsc(doc.buy.by.pos)})` : ''}`],
      ['วันที่ต้องการรับของ', opsEsc(ursFmtDateThai(doc.buy.dateGet))]
    ])}
    ${opsBuyItemsTable(doc)}
    <p style="margin-top:14px"><b>สาเหตุการผลิตเกิน PO (จากผู้ขาย)</b><br>${opsEsc(doc.causeNote).replace(/\n/g, '<br>')}</p>
    ${doc.buy.note ? `<p><b>หมายเหตุฝ่ายจัดซื้อ</b><br>${opsEsc(doc.buy.note).replace(/\n/g, '<br>')}</p>` : ''}`;
  const listLink = link.replace(/\/over-po-sale-opa\?.*$/, '/over-po-sale-apv');
  return { subject, html: opsMailWrap(body + `<p style="font-size:13px;color:#555">ดูรายการที่รอการพิจารณาของท่านทั้งหมด (พิจารณาหลายรายการพร้อมกันได้): <a href="${opsEsc(listLink)}">${opsEsc(listLink)}</a></p>`,
    link, `เปิดใบขออนุมัติ ${doc.buy.docNo} เพื่อพิจารณา`, '#f2a91c') };
}

// ผลการพิจารณา kind: approved (ครบ + PO) / rejected (ผู้อนุมัติไม่รับซื้อ) / buy-reject (ฝ่ายจัดซื้อไม่รับซื้อ) / back (ส่งกลับแก้ไข → ฝ่ายจัดซื้อ)
function buildOpsResultMail(doc, link, kind, dear, info = {}) {
  const head = `[WIM] ร้องขอขายเมล็ดพันธุ์ (Over PO) ${doc.docNo}`;
  const subject = {
    approved: `${head} — อนุมัติรับซื้อแล้ว PO ${info.poCode || ''}`,
    rejected: `${head} — ไม่รับซื้อ`, 'buy-reject': `${head} — ไม่รับซื้อ`,
    back: `[WIM] ส่งกลับแก้ไข ใบขออนุมัติ ${doc.buy && doc.buy.docNo} (${doc.docNo})`
  }[kind];
  const who = info.by ? `${opsEsc(info.by)}${info.step ? ` (${opsEsc(opsStepName(info.step))})` : ''}` : '';
  let body = `<p>เรียน ${opsEsc(dear)}</p>`;
  if (kind === 'approved') {
    body += `<p>${opsEsc(doc.compTargetName)} <b style="color:#1e8449">อนุมัติรับซื้อ</b>เมล็ดพันธุ์ส่วนเกินใบสั่งซื้อตามคำร้อง ${opsEsc(doc.docNo)} แล้ว และออกใบสั่งซื้อ (PO) ให้ดังนี้</p>
      ${opsKv([
        ['เลขที่ PO', `<b>${opsEsc(info.poCode || '-')}</b>`],
        info.soCode ? ['ใบสั่งขาย (ผู้ขาย)', opsEsc(info.soCode)] : null,
        ['ใบขออนุมัติ', opsEsc(doc.buy.docNo)],
        ['วันที่ต้องการรับของ', opsEsc(ursFmtDateThai(doc.buy.dateGet))]
      ])}
      ${opsBuyItemsTable(doc)}`;
  } else if (kind === 'back') {
    body += `<p>ใบขออนุมัติ <b>${opsEsc(doc.buy.docNo)}</b> (คำร้อง ${opsEsc(doc.docNo)} — ${opsEsc(doc.compReqName)}) ถูก<b style="color:#b9770e">ส่งกลับแก้ไข</b> โดย ${who}</p>
      <p><b>เหตุผล:</b> ${opsEsc(info.note || '-').replace(/\n/g, '<br>')}</p>
      <p>กรุณาแก้ไขแล้วกด "บันทึกพร้อมส่งขออนุมัติ" อีกครั้ง (ผู้อนุมัติทุกท่านจะต้องพิจารณาใหม่)</p>`;
  } else {
    body += `<p>${opsEsc(doc.compTargetName)} <b style="color:#c0392b">ไม่รับซื้อ</b>เมล็ดพันธุ์ส่วนเกินใบสั่งซื้อตามคำร้อง <b>${opsEsc(doc.docNo)}</b></p>
      ${opsKv([['พิจารณาโดย', who], ['เหตุผล', opsEsc(info.note || '-').replace(/\n/g, '<br>')]])}`;
  }
  const btn = kind === 'back' ? `เปิดเพื่อแก้ไข ${doc.buy.docNo}` : `ดูเอกสาร ${doc.docNo}`;
  return { subject, html: opsMailWrap(body, link, btn, kind === 'back' ? '#f2a91c' : '#4ea7e0') };
}

// งานส่งอีเมลหลังบันทึกแล้ว — ไม่ให้ผู้ใช้รอ SMTP (Gmail ฉบับละหลายวินาที) / error เก็บ log ไม่ทำให้ server ล้ม
const opsBackground = (label, fn) => setImmediate(() => Promise.resolve().then(fn).catch(err => console.error(`OPS ${label} mail error:`, err)));

// ส่ง 1 ฉบับ + เก็บ log (นอก transaction — ใช้หลังบันทึกผลแล้ว ส่งไม่สำเร็จไม่ย้อนผล)
async function opsNotify(runner, idOps, step, req, toList, ccList, mail) {
  const to = toList.filter(p => p && opsValidEmail(p.email));
  const seen = new Set(to.map(p => p.idPs));
  const cc = [];
  ccList.forEach(p => { if (p && opsValidEmail(p.email) && !seen.has(p.idPs)) { seen.add(p.idPs); cc.push(p); } });
  if (!to.length && !cc.length) return { ok: false, logs: [] };
  const r = await opsSendMail({ to: (to.length ? to : cc).map(p => p.email), cc: to.length ? cc.map(p => p.email) : [], subject: mail.subject, html: mail.html });
  const logs = [...to.map(p => ({ type: 'to', p })), ...cc.map(p => ({ type: 'cc', p }))].map(x => ({ ...x, ok: r.ok.has(x.p.email.toLowerCase()) }));
  const rq = () => runner instanceof sql.Transaction ? new sql.Request(runner) : runner.request();
  for (const l of logs) {
    await rq().input('id', sql.Int, idOps).input('step', sql.VarChar(20), step).input('type', sql.VarChar(3), l.type)
      .input('ps', sql.Int, l.p.idPs).input('mail', sql.NVarChar(255), l.p.email).input('ok', sql.Bit, l.ok)
      .input('err', sql.NVarChar(1000), l.ok ? null : String(r.error || 'ส่งไม่สำเร็จ').slice(0, 1000)).input('by', sql.Int, req.idPs)
      .query(`INSERT INTO devsk.SeedReqSaleMailLog (idOps, Step, RecvType, idPs, Email, stSend, ErrMsg, idPsSend, DateSend)
              VALUES (@id, @step, @type, @ps, @mail, @ok, @err, @by, GETDATE())`);
  }
  return { ok: logs.every(l => l.ok), error: r.error, logs: logs.map(l => ({ type: l.type, email: l.p.email, name: l.p.name, ok: l.ok })) };
}

// ส่งอีเมลขออนุมัติถึงผู้อนุมัติ (1 ฉบับต่อคน รวมทุกขั้นของคนนั้น / ส่งพร้อมกัน) — onlyPending = เฉพาะขั้นที่ยังไม่ได้กด (เตือน)
// runner = pool (หลังบันทึกแล้ว)
async function opsSendApvMails(transaction, idOps, kind, req, onlyPending = false) {
  const doc = await loadOpsDoc(idOps, transaction);
  const link = `${opsBase(req)}/over-po-sale-opa?id=${idOps}`;
  const rows = doc.approvals.filter(a => a.round === doc.apvRound && (!onlyPending || !a.result));
  const byPs = new Map();
  rows.forEach(a => byPs.set(a.idPs, { person: { idPs: a.idPs, name: a.name, full: a.full, position: a.position, email: a.email }, steps: [...((byPs.get(a.idPs) || {}).steps || []), a.step] }));
  const results = (await Promise.all([...byPs.values()].map(async ({ person, steps }) => {
    if (!opsValidEmail(person.email)) return [{ type: 'to', email: '-', name: person.name, ok: false }];
    const r = await opsNotify(transaction, idOps, `apv-${kind}`, req, [person], [], buildOpsApvMail(doc, link, person, steps, kind));
    return r.logs.length ? r.logs : [{ type: 'to', email: person.email, name: person.name, ok: false }];
  }))).flat();
  return { ok: results.length > 0 && results.every(r => r.ok), results, doc };
}

// ---------- สร้าง PO + ใบสั่งขายฝั่งผู้ขาย (ภายใน transaction ของการอนุมัติขั้นสุดท้าย) ----------
// หัว PO: คัดลอก ที่อยู่ / เครดิต / ประเภทบิล / สถานะเร่งด่วน / ออกบิลอัตโนมัติ จาก PO ที่อ้างอิงล่าสุด
// รายการ: จำนวนรับซื้อจริง (> 0) × ราคา / คุณภาพ + ฤดูผลิต จากบรรทัด PO อ้างอิงล่าสุดของรายการนั้น / idDtRef = idOpsDt
// เลขที่ X{yy}/{mm}/{0000}: รันแบบโปรแกรม PO เดิม (TypeTs + เดือน/ปีของ create_date + บริษัท)
async function opsCreatePO(transaction, idOps, now) {
  const rq = () => new sql.Request(transaction);
  const r = await rq().input('id', sql.Int, idOps).query(`
    SELECT m.idOps, m.DocCode, m.BuyDocCode, m.idCompReq, m.idCompTarget, m.idPsBuy, m.BuyDateGet, m.BuyNote, m.ApvRound, cr.CompName AS CompNameReq,
           (SELECT TOP 1 b.idPOTs FROM devsk.SeedReqSalePORef p JOIN devsk.PkPOBuyMt b ON b.idPOTs = p.idPOTs WHERE p.idOps = m.idOps ORDER BY b.idPOTs DESC) AS idRefPO,
           STUFF((SELECT DISTINCT ', ' + p.POCode FROM devsk.SeedReqSalePORef p WHERE p.idOps = m.idOps FOR XML PATH('')), 1, 2, '') AS POCodes
    FROM devsk.SeedReqSaleMt m
    LEFT JOIN PchInvAndProject.dbo.dCompany cr ON cr.idComp = m.idCompReq
    WHERE m.idOps = @id;

    SELECT d.idOpsDt, d.idInvMain, d.idUnit, d.AmountBuy, d.Price
    FROM devsk.SeedReqSaleDt d WHERE d.idOps = @id AND d.AmountBuy > 0 ORDER BY d.idOpsDt;

    SELECT a.StepCode, a.idPsAct, a.DateAct
    FROM devsk.SeedReqSaleApv a JOIN devsk.SeedReqSaleMt m ON m.idOps = a.idOps AND m.ApvRound = a.ApvRound
    WHERE a.idOps = @id AND a.Result = 'A';`);
  const h = r.recordsets[0][0];
  const lines = r.recordsets[1].map(d => ({ ...d, amount: Number(d.AmountBuy), price: Number(d.Price) }));
  const apv = new Map(r.recordsets[2].map(a => [a.StepCode, a]));
  if (!h || !h.idRefPO) throw new Error('ไม่พบ PO ที่อ้างอิง — สร้าง PO ไม่ได้');
  if (!lines.length) throw new Error('ไม่มีรายการที่รับซื้อ — สร้าง PO ไม่ได้');
  if (OPS_APV_STEPS.some(s => !apv.get(s.code))) throw new Error('ผลอนุมัติไม่ครบ 4 ท่าน — สร้าง PO ไม่ได้');
  lines.forEach(l => { l.total = opsRound2(l.amount * l.price); });
  const total = opsRound2(lines.reduce((s, l) => s + l.total, 0));

  const last = (await rq().input('type', sql.Int, OPS_PO_TYPE).input('comp', sql.Int, h.idCompTarget).input('now', sql.DateTime, now).query(`
    SELECT MAX(DocCode) AS last FROM devsk.PkPOBuyMt WITH (UPDLOCK, HOLDLOCK)
    WHERE stGenDoc IS NOT NULL AND TypeTs = @type AND YEAR(create_date) = YEAR(@now) AND MONTH(create_date) = MONTH(@now) AND idComp = @comp`)).recordset[0].last;
  const run = last ? (parseInt(String(last).substring(7, 11), 10) || 0) + 1 : 1;
  const docCode = `${OPS_PO_PREFIX}${String(now.getFullYear() + 543).slice(-2)}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(run).padStart(4, '0')}`;
  const note = `ซื้อเมล็ดพันธุ์ส่วนเกินใบสั่งซื้อ (Over PO) ตามใบขออนุมัติ ${h.BuyDocCode} / ใบร้องขอ ${h.DocCode} ของ ${h.CompNameReq || ''}\r\nอ้างอิง PO: ${h.POCodes || '-'}`
    + (h.BuyNote ? `\r\n${h.BuyNote}` : '');

  const mreq = rq()
    .input('type', sql.Int, OPS_PO_TYPE).input('doc', sql.VarChar(20), docCode).input('now', sql.DateTime, now)
    .input('day', sql.Date, now).input('get', sql.DateTime, h.BuyDateGet).input('ps', sql.Int, h.idPsBuy)
    .input('sup', sql.Int, OPS_COMP_SUPPLIER[h.idCompReq]).input('comp', sql.Int, h.idCompTarget).input('note', sql.NVarChar(sql.MAX), note)
    .input('total', sql.Decimal(18, 2), total).input('qt', sql.VarChar(20), h.DocCode).input('idMt', sql.Int, idOps)
    .input('ref', sql.Int, h.idRefPO).input('sys', sql.Int, OPS_PO_SYS);
  OPS_APV_STEPS.forEach(s => { const a = apv.get(s.code); mreq.input(`p_${s.code}`, sql.Int, a.idPsAct).input(`d_${s.code}`, sql.DateTime, a.DateAct); });
  const mt = await mreq.query(`
    INSERT INTO devsk.PkPOBuyMt (TypeTs, DocCode, DateTsD, idPsTs, idSup, idPsBuy, DateBuyD, DateGetD, idCredit, Address,
      Note, TotalPrice, DiscountPerc, Discount, TotalNet, idComp, QtCode, SystemGroup, stPOGetMoney, AmountGetMoneyBalance,
      idProject, stRight, VAT, idWhd, TAXPerc, TAX, stCredit, DateCredit, stTypeBill, idPsMoney, Money_balance, idPayCard,
      stUrgent, stAutoBillBuy, TbName, idMt, stGenDoc, stReturn, DateReturnD, create_id, create_date, stPO,
      ${OPS_APV_STEPS.map(s => `${s.poPs}, ${s.poDate}, ${s.poSys}`).join(', ')})
    SELECT @type, @doc, @now, @ps, @sup, @ps, @day, @get, b.idCredit, b.Address,
      @note, @total, 0, 0, @total, @comp, @qt, 'MAIN', NULL, @total,
      0, b.stRight, 0, NULL, 0, 0, b.stCredit, NULL, b.stTypeBill, NULL, NULL, NULL,
      b.stUrgent, b.stAutoBillBuy, 'SeedReqSaleMt', @idMt, 1, NULL, NULL, @ps, @now, 0,
      ${OPS_APV_STEPS.map(s => `@p_${s.code}, @d_${s.code}, @sys`).join(', ')}
    FROM devsk.PkPOBuyMt b WHERE b.idPOTs = @ref;
    SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`);
  const idPOTs = mt.recordset[0].id;
  for (const l of lines) {
    await rq().input('po', sql.Int, idPOTs).input('inv', sql.Int, l.idInvMain).input('amt', sql.Decimal(18, 6), l.amount)
      .input('price', sql.Decimal(18, 4), l.price).input('total', sql.Decimal(18, 2), l.total).input('unit', sql.Int, l.idUnit).input('dt', sql.Int, l.idOpsDt)
      .query(`INSERT INTO devsk.PkPOBuyDt (idPOTs, idProduct, idInvMain, Amount, Price, TotalPrice, NoteDt, idPRDt, idUnitNew, dNET, dDiscount,
                HumidPercent, ImpurePercent, PurePercent, GrowPercent, idDtRef, idSeasonPd)
              SELECT @po, @inv, @inv, @amt, @price, @total, '', NULL, @unit, @price, 0,
                q.HumidPercent, q.ImpurePercent, q.PurePercent, q.GrowPercent, @dt, q.idSeasonPd
              FROM (SELECT 1 AS one) z
              OUTER APPLY (SELECT TOP 1 b.HumidPercent, b.ImpurePercent, b.PurePercent, b.GrowPercent, b.idSeasonPd
                           FROM devsk.SeedReqSalePORef p JOIN devsk.PkPOBuyDt b ON b.idPODt = p.idPODt
                           WHERE p.idOpsDt = @dt ORDER BY p.idPOTs DESC, p.idPODt DESC) q`);
  }
  // ใบสั่งขายฝั่งผู้ขาย (ODP..) — SP เดียวกับตอน PO ในเครืออนุมัติครบ
  await rq().input('po', sql.Int, idPOTs).input('ps', sql.Int, h.idPsBuy)
    .query('EXEC devsk.sp_InsertPOxSlOrder @typeCmd = 1, @idPOTs = @po, @idPsTs = @ps');
  // trigger tg_CalAmountOrd (คำนวณ AmountPiece / idUnitSale) ทำได้ทีละแถว — SP insert หลายแถวพร้อมกัน แถวอื่นได้ NULL
  // → แตะทีละแถว (UPDATE Amount = Amount) ให้ trigger คำนวณครบทุกบรรทัด
  await rq().input('po', sql.Int, idPOTs).query(`
    DECLARE @dt int;
    DECLARE c CURSOR LOCAL FAST_FORWARD FOR
      SELECT d.idSaleOrderDt FROM dbo.SmSaleOrderDt d JOIN dbo.SmSaleOrderMt m ON m.idSaleOrder = d.idSaleOrder WHERE m.idPOTs = @po;
    OPEN c; FETCH NEXT FROM c INTO @dt;
    WHILE @@FETCH_STATUS = 0 BEGIN
      UPDATE dbo.SmSaleOrderDt SET Amount = Amount WHERE idSaleOrderDt = @dt;
      FETCH NEXT FROM c INTO @dt;
    END
    CLOSE c; DEALLOCATE c;`);
  const so = (await rq().input('po', sql.Int, idPOTs)
    .query('SELECT TOP 1 DocCode FROM dbo.SmSaleOrderMt WHERE idPOTs = @po AND idPsCancel IS NULL ORDER BY idSaleOrder DESC')).recordset[0];
  return { idPOTs, docCode, soCode: so ? so.DocCode : null, total };
}

// ---------- ฝ่ายจัดซื้อ: บันทึกพร้อมส่งขออนุมัติ ----------
// body: { items: [{ idOpsDt, amountBuy, price }], dateGet: 'YYYY-MM-DD', note, approvers: { accept, check, approve1, approve2 } }
// สถานะ S = ส่งครั้งแรก (รอบ 1) / B = ส่งใหม่หลังแก้ไข (รอบใหม่) / H ที่ยังไม่มีใครกด = แก้ไข (แทนรอบเดิม)
// บันทึกเสร็จแล้วจึงส่งอีเมลถึงผู้อนุมัติทั้ง 4 (เบื้องหลัง)
app.post('/api/ops/buy/:id/submit', requireMenu(MENU_OPS_BUY), async (req, res) => {
  const idOps = parseInt(req.params.id, 10);
  if (!idOps) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  if (!opsMailReady()) return res.status(503).json({ success: false, message: 'ยังไม่ได้ตั้งค่าการส่งอีเมล (SMTP) ที่ server — ติดต่อผู้ดูแลระบบ' });
  let transaction;
  const fail = async (code, message, extra = {}) => { await transaction.rollback(); return res.status(code).json({ success: false, message, ...extra }); };
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const cur = await lockOpsDoc(transaction, idOps);
    if (!cur) return fail(404, 'ไม่พบเอกสาร');
    if (!hasComp(req.access, cur.idCompTarget)) return fail(403, 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้');
    const st = opsStatus(cur);
    if (!(st === 'S' || st === 'B' || (st === 'H' && !cur.ApvActed))) return fail(409, st === 'H' ? 'มีผู้อนุมัติพิจารณาไปแล้ว — แก้ไขไม่ได้' : 'สถานะเอกสารเปลี่ยนไปแล้ว — กรุณาเปิดเอกสารใหม่');

    // รายการ: ครบทุกบรรทัด / รับซื้อ 0 ถึงจำนวนเสนอขาย / มีรับซื้อ = ต้องมีราคา
    const dts = (await new sql.Request(transaction).input('id', sql.Int, idOps)
      .query('SELECT d.idOpsDt, d.AmountOffer, i.InvName FROM devsk.SeedReqSaleDt d LEFT JOIN devsk.dInventoryMain i ON i.idInvMain = d.idInvMain WHERE d.idOps = @id')).recordset;
    const body = new Map((Array.isArray(req.body.items) ? req.body.items : []).map(x => [parseInt(x.idOpsDt, 10), x]));
    const rows = [];
    for (const d of dts) {
      const x = body.get(d.idOpsDt);
      if (!x) return fail(400, `${d.InvName}: ไม่พบข้อมูลรายการ — กรุณาเปิดเอกสารใหม่`);
      const amt = Number(x.amountBuy), price = x.price === '' || x.price == null ? null : Number(x.price);
      if (!(amt >= 0)) return fail(400, `${d.InvName}: จำนวนรับซื้อไม่ถูกต้อง`);
      if (amt > Number(d.AmountOffer) + OPS_EPS) return fail(400, `${d.InvName}: จำนวนรับซื้อเกินจำนวนที่เสนอขาย (${opsFmtQty(d.AmountOffer)})`);
      if (amt > 0 && !(price > 0)) return fail(400, `${d.InvName}: กรุณาระบุราคารับซื้อ/หน่วย`);
      rows.push({ idOpsDt: d.idOpsDt, amt: round6(amt), price: amt > 0 ? Math.round(price * 10000) / 10000 : null });
    }
    if (!rows.some(r => r.amt > 0)) return fail(400, 'ต้องมีรายการที่รับซื้ออย่างน้อย 1 รายการ (ถ้าไม่รับซื้อทั้งหมด ใช้ปุ่ม "ไม่รับซื้อ")');
    const dateGet = String(req.body.dateGet || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateGet) || isNaN(new Date(dateGet))) return fail(400, 'กรุณาระบุวันที่ต้องการรับของ');
    const note = String(req.body.note || '').trim();
    if (note.length > 1000) return fail(400, 'หมายเหตุยาวเกิน 1,000 ตัวอักษร');

    // ผู้อนุมัติ 4 ขั้น: ครบ / มีอีเมล / อนุมัติ 1 ≠ อนุมัติ 2
    const ap = {};
    for (const s of OPS_APV_STEPS) {
      ap[s.code] = parseInt((req.body.approvers || {})[s.code], 10);
      if (!ap[s.code]) return fail(400, `กรุณาเลือก${s.name}`);
    }
    if (new Set(Object.values(ap)).size !== OPS_APV_STEPS.length) return fail(400, 'ผู้รับทราบ ผู้ตรวจสอบ และผู้อนุมัติ ทั้ง 4 ท่านต้องเป็นคนละคน');
    const people = await opsPeople(transaction, [...new Set(Object.values(ap))]);
    for (const s of OPS_APV_STEPS) {
      const p = people.find(x => x.idPs === ap[s.code]);
      if (!p) return fail(400, `${s.name}: ไม่พบพนักงานในระบบ`);
      if (!opsValidEmail(p.email)) return fail(400, `${s.name} (${p.name}) ไม่มีอีเมลในระบบ`);
    }

    const now = (await new sql.Request(transaction).query('SELECT GETDATE() AS now')).recordset[0].now;
    for (const r of rows) {
      await new sql.Request(transaction).input('dt', sql.Int, r.idOpsDt).input('amt', sql.Decimal(18, 6), r.amt).input('price', sql.Decimal(18, 4), r.price)
        .query('UPDATE devsk.SeedReqSaleDt SET AmountBuy = @amt, Price = @price WHERE idOpsDt = @dt');
    }
    const buyDoc = cur.BuyDocCode || await getNextOpaDocCode(transaction, cur.idCompTarget, now);
    const kind = st === 'S' ? 'request' : st === 'B' ? 'resubmit' : 'edit';
    const round = st === 'H' ? cur.ApvRound : (cur.ApvRound || 0) + 1;
    await new sql.Request(transaction)
      .input('id', sql.Int, idOps).input('doc', sql.VarChar(12), buyDoc).input('now', sql.DateTime, now).input('ps', sql.Int, req.idPs)
      .input('get', sql.Date, dateGet).input('note', sql.NVarChar(1000), note || null).input('round', sql.Int, round)
      .query(`UPDATE devsk.SeedReqSaleMt SET BuyDocCode = @doc, BuyDateDoc = ISNULL(BuyDateDoc, @now), idPsBuy = @ps, DateBuy = @now,
                     BuyDateGet = @get, BuyNote = @note, ApvRound = @round
              WHERE idOps = @id;
              DELETE FROM devsk.SeedReqSaleApv WHERE idOps = @id AND ApvRound = @round;`);
    for (const s of OPS_APV_STEPS) {
      await new sql.Request(transaction).input('id', sql.Int, idOps).input('round', sql.Int, round).input('step', sql.VarChar(10), s.code)
        .input('ps', sql.Int, ap[s.code]).input('ts', sql.Int, req.idPs).input('now', sql.DateTime, now)
        .query(`INSERT INTO devsk.SeedReqSaleApv (idOps, ApvRound, StepCode, idPsAssign, idPsTs, DateTs, DateMail)
                VALUES (@id, @round, @step, @ps, @ts, @now, @now)`);
    }
    await transaction.commit();
    // บันทึกแล้วค่อยส่งอีเมล (ไม่ให้ transaction ค้างระหว่างรอ SMTP) — ส่งไม่สำเร็จดูได้ใน log / กด "ส่ง E-mail เตือน" ซ้ำได้
    res.json({ success: true, buyDocNo: buyDoc, kind, dryRun: opsMailDryRun(), mailTo: OPS_APV_STEPS.map(st => ({ step: st.code, name: (people.find(p => p.idPs === ap[st.code]) || {}).name })) });
    opsBackground('apv-request', () => opsSendApvMails(pool, idOps, kind, req));
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('OPS buy submit error:', err);
    res.status(500).json({ success: false, message: 'บันทึกไม่สำเร็จ — ระบบไม่ได้บันทึกข้อมูลใดๆ', detail: err.message });
  }
});

// ---------- ฝ่ายจัดซื้อ: ส่งอีเมลเตือนผู้อนุมัติที่ยังไม่ได้พิจารณา ----------
app.post('/api/ops/buy/:id/remind', requireMenu(MENU_OPS_BUY), async (req, res) => {
  const idOps = parseInt(req.params.id, 10);
  if (!idOps) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  if (!opsMailReady()) return res.status(503).json({ success: false, message: 'ยังไม่ได้ตั้งค่าการส่งอีเมล (SMTP) ที่ server — ติดต่อผู้ดูแลระบบ' });
  try {
    const pool = await poolPromise;
    const doc = await loadOpsDoc(idOps);
    if (!doc) return res.status(404).json({ success: false, message: 'ไม่พบเอกสาร' });
    if (!hasComp(req.access, doc.compTarget)) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้' });
    if (doc.status !== 'H') return res.status(409).json({ success: false, message: 'เอกสารไม่ได้อยู่ระหว่างรออนุมัติ' });
    const sent = await opsSendApvMails(pool, idOps, 'remind', req, true);
    res.json({ success: true, dryRun: opsMailDryRun(), results: sent.results });
  } catch (err) {
    console.error('OPS buy remind error:', err);
    res.status(500).json({ success: false, message: 'ส่งอีเมลเตือนไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ผู้ร้องขอ + CC + ฝ่ายจัดซื้อ (ใช้แจ้งผลถึงฝั่งผู้ขาย) ----------
async function opsSellerAudience(runner, doc) {
  const req = await opsPeople(runner, [doc.requester.id]);
  const extra = await opsPeople(runner, [doc.buy && doc.buy.by && doc.buy.by.id, doc.recipients.to && doc.recipients.to.idPs].filter(Boolean));
  return { to: req, cc: [...doc.recipients.cc, ...extra] };
}

// ---------- ฝ่ายจัดซื้อ: ไม่รับซื้อ (ตัดสินเอง ไม่ผ่านผู้อนุมัติ) — ต้องระบุเหตุผล / แจ้งผู้ร้องขอ + CC ตอนส่งคำร้อง ----------
app.post('/api/ops/buy/:id/reject', requireMenu(MENU_OPS_BUY), async (req, res) => {
  const idOps = parseInt(req.params.id, 10);
  const note = String(req.body.note || '').trim();
  if (!idOps) return res.status(400).json({ success: false, message: 'เลขที่เอกสารไม่ถูกต้อง' });
  if (note.length <= 5 || /^[-0\s]+$/.test(note)) return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลที่ไม่รับซื้อ (มากกว่า 5 ตัวอักษร)' });
  if (note.length > 500) return res.status(400).json({ success: false, message: 'เหตุผลยาวเกิน 500 ตัวอักษร' });
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const cur = await lockOpsDoc(transaction, idOps);
    const stop = async (code, message) => { await transaction.rollback(); return res.status(code).json({ success: false, message }); };
    if (!cur) return stop(404, 'ไม่พบเอกสาร');
    if (!hasComp(req.access, cur.idCompTarget)) return stop(403, 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้');
    const st = opsStatus(cur);
    if (!(st === 'S' || st === 'B' || (st === 'H' && !cur.ApvActed))) return stop(409, 'มีผู้อนุมัติพิจารณาไปแล้ว หรือสถานะเอกสารเปลี่ยนไป — ไม่รับซื้อจากฝ่ายจัดซื้อไม่ได้');
    await new sql.Request(transaction).input('id', sql.Int, idOps).input('ps', sql.Int, req.idPs).input('note', sql.NVarChar(500), note)
      .query(`UPDATE devsk.SeedReqSaleMt SET idPsReject = @ps, DateReject = GETDATE(), RejectNote = @note, RejectStep = 'buy' WHERE idOps = @id`);
    await transaction.commit();
    // แจ้งผล (หลังบันทึก / เบื้องหลัง — ส่งไม่สำเร็จไม่ย้อนผล)
    res.json({ success: true });
    opsBackground('buy-reject', async () => {
      const doc = await loadOpsDoc(idOps);
      // ผู้รับ: ผู้ร้องขอ + ผู้รับสำเนา (CC) ที่ผู้ร้องขอใส่ไว้ตอนส่งคำร้องเท่านั้น (ไม่ส่งผู้อนุมัติ)
      const requester = await opsPeople(pool, [doc.requester.id]);
      const me = (await opsPeople(pool, [req.idPs]))[0];
      const m = buildOpsResultMail(doc, `${opsBase(req)}/over-po-sale-doc?id=${idOps}`, 'buy-reject',
        opsDear(doc.requester), { by: `${opsFormal(me)} ฝ่ายจัดซื้อ ${doc.compTargetName}`, note });
      await opsNotify(pool, idOps, 'buy-reject', req, requester, doc.recipients.cc, m);
    });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('OPS buy reject error:', err);
    res.status(500).json({ success: false, message: 'บันทึกไม่รับซื้อไม่สำเร็จ', detail: err.message });
  }
});

// ---------- รายการที่รอการพิจารณาของผู้ใช้ (หน้า /over-po-sale-apv) — เฉพาะเอกสารรออนุมัติ ที่มีขั้นของคนนี้ยังไม่กด ----------
app.get('/api/ops/apv/pending', requireLogin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const r = await pool.request().input('ps', sql.Int, req.idPs).query(`
      SELECT m.idOps INTO #mine
      FROM devsk.SeedReqSaleMt m
      ${OPS_ROUND_SQL()}
      WHERE m.DateBuy IS NOT NULL AND m.DateCancel IS NULL AND m.DateReject IS NULL AND m.DateApv IS NULL AND ISNULL(ar.ApvBack, 0) = 0
        AND EXISTS (SELECT 1 FROM devsk.SeedReqSaleApv a WHERE a.idOps = m.idOps AND a.ApvRound = m.ApvRound AND a.idPsAssign = @ps AND a.Result IS NULL);

      SELECT m.idOps, m.DocCode, m.BuyDocCode, CONVERT(varchar(16), m.DateBuy, 120) AS TxBuy, m.idCompReq, cr.CompName AS CompNameReq, pb.PsName AS PsBuy, ar.ApvDone, ar.ApvCount,
             STUFF((SELECT ',' + a.StepCode FROM devsk.SeedReqSaleApv a WHERE a.idOps = m.idOps AND a.ApvRound = m.ApvRound AND a.idPsAssign = @ps AND a.Result IS NULL
                    ORDER BY CASE a.StepCode WHEN 'accept' THEN 1 WHEN 'check' THEN 2 WHEN 'approve1' THEN 3 ELSE 4 END FOR XML PATH('')), 1, 1, '') AS MySteps
      FROM devsk.SeedReqSaleMt m
      JOIN #mine x ON x.idOps = m.idOps
      LEFT JOIN PchInvAndProject.dbo.dCompany cr ON cr.idComp = m.idCompReq
      OUTER APPLY (SELECT TOP 1 v.PsName FROM devsk.vPersonxSelect v WHERE v.idPs = m.idPsBuy) pb
      ${OPS_ROUND_SQL()}
      ORDER BY m.DateBuy, m.idOps;

      SELECT d.idOps, i.InvName, d.AmountBuy, d.Price, u.UnitName
      FROM devsk.SeedReqSaleDt d
      JOIN #mine x ON x.idOps = d.idOps
      LEFT JOIN devsk.dInventoryMain i ON i.idInvMain = d.idInvMain
      LEFT JOIN devsk.dInvUnit u ON u.idUnit = d.idUnit
      WHERE d.AmountBuy > 0
      ORDER BY d.idOps, d.idOpsDt;

      DROP TABLE #mine;`);
    const items = new Map();
    r.recordsets[1].forEach(x => {
      const amt = opsRound2(Number(x.AmountBuy) * Number(x.Price || 0));
      items.set(x.idOps, [...(items.get(x.idOps) || []), { invName: x.InvName, amountBuy: Number(x.AmountBuy), price: x.Price == null ? null : Number(x.Price), unit: x.UnitName, amt }]);
    });
    res.json({ success: true, data: r.recordsets[0].map(m => {
      const its = items.get(m.idOps) || [];
      return { id: m.idOps, docNo: m.DocCode, buyDocNo: m.BuyDocCode, buyAt: m.TxBuy, req: m.idCompReq, reqName: m.CompNameReq, buyBy: m.PsBuy || '-',
        done: m.ApvDone || 0, count: m.ApvCount || OPS_APV_STEPS.length, steps: String(m.MySteps || '').split(',').filter(Boolean),
        items: its, total: opsRound2(its.reduce((s, it) => s + it.amt, 0)) };
    }) });
  } catch (err) {
    console.error('OPS apv pending error:', err);
    res.status(500).json({ success: false, message: 'โหลดรายการรอพิจารณาไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ผู้อนุมัติ: ผ่าน (A) / ส่งกลับแก้ไข (B) / ไม่รับซื้อ (R) — กดได้เฉพาะขั้นของตัวเองในรอบปัจจุบัน ----------
// body.step = ขั้นที่กด (ปุ่มแยกตามขั้น) — ไม่ระบุ = ทุกขั้นที่รอคนนี้ (เอกสารเก่าที่คนเดียวมีหลายขั้น) / ผ่านครบ 4 ขั้น → สร้าง PO + ใบสั่งขาย
app.post('/api/ops/apv/:id', requireLogin, async (req, res) => {
  const idOps = parseInt(req.params.id, 10);
  const result = String(req.body.result || '');
  const note = String(req.body.note || '').trim();
  const step = req.body.step ? String(req.body.step) : null;
  if (!idOps || !['A', 'B', 'R'].includes(result) || (step && !OPS_APV_STEPS.some(s => s.code === step))) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  if (result !== 'A' && (note.length <= 5 || /^[-0\s]+$/.test(note))) return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผล (มากกว่า 5 ตัวอักษร)' });
  if (note.length > 500) return res.status(400).json({ success: false, message: 'เหตุผลยาวเกิน 500 ตัวอักษร' });
  let transaction;
  try {
    const pool = await poolPromise;
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const cur = await lockOpsDoc(transaction, idOps);
    const stop = async (code, message) => { await transaction.rollback(); return res.status(code).json({ success: false, message }); };
    if (!cur) return stop(404, 'ไม่พบเอกสาร');
    { const st0 = opsStatus(cur); if (st0 !== 'H') return stop(409, ({ R: 'คำร้องนี้ถูกตัดสินไม่รับซื้อไปแล้ว (ฝ่ายจัดซื้อหรือผู้อนุมัติท่านอื่นตัดสินไปก่อน) จึงพิจารณาไม่ได้', A: 'ใบขออนุมัตินี้อนุมัติครบทุกท่านแล้ว', B: 'ใบขออนุมัตินี้ถูกส่งกลับแก้ไข — รอฝ่ายจัดซื้อแก้ไขและส่งขออนุมัติใหม่', C: 'ผู้ขายยกเลิกคำร้องนี้แล้ว' })[st0] || 'เอกสารไม่ได้อยู่ระหว่างรออนุมัติแล้ว — กรุณาเปิดเอกสารใหม่'); }
    const mine = (await new sql.Request(transaction).input('id', sql.Int, idOps).input('round', sql.Int, cur.ApvRound).input('ps', sql.Int, req.idPs).input('step', sql.VarChar(10), step)
      .query('SELECT idApv, StepCode FROM devsk.SeedReqSaleApv WHERE idOps = @id AND ApvRound = @round AND idPsAssign = @ps AND Result IS NULL AND (@step IS NULL OR StepCode = @step)')).recordset;
    if (!mine.length) return stop(409, 'ไม่มีรายการที่รอการพิจารณาของคุณในเอกสารนี้ (อาจพิจารณาไปแล้ว หรือฝ่ายจัดซื้อเปลี่ยนผู้อนุมัติ)');
    const now = (await new sql.Request(transaction).query('SELECT GETDATE() AS now')).recordset[0].now;
    await new sql.Request(transaction).input('id', sql.Int, idOps).input('round', sql.Int, cur.ApvRound).input('ps', sql.Int, req.idPs)
      .input('res', sql.Char(1), result).input('note', sql.NVarChar(500), note || null).input('now', sql.DateTime, now).input('step', sql.VarChar(10), step)
      .query(`UPDATE devsk.SeedReqSaleApv SET Result = @res, Note = @note, idPsAct = @ps, DateAct = @now
              WHERE idOps = @id AND ApvRound = @round AND idPsAssign = @ps AND Result IS NULL AND (@step IS NULL OR StepCode = @step)`);
    const steps = mine.map(x => x.StepCode);
    let final = null;
    if (result === 'R') {
      await new sql.Request(transaction).input('id', sql.Int, idOps).input('ps', sql.Int, req.idPs).input('note', sql.NVarChar(500), note)
        .input('step', sql.VarChar(10), steps[0]).input('now', sql.DateTime, now)
        .query('UPDATE devsk.SeedReqSaleMt SET idPsReject = @ps, DateReject = @now, RejectNote = @note, RejectStep = @step WHERE idOps = @id');
    } else if (result === 'A') {
      const c = (await new sql.Request(transaction).input('id', sql.Int, idOps).input('round', sql.Int, cur.ApvRound)
        .query(`SELECT COUNT(*) AS n, SUM(CASE WHEN Result = 'A' THEN 1 ELSE 0 END) AS ok FROM devsk.SeedReqSaleApv WHERE idOps = @id AND ApvRound = @round`)).recordset[0];
      if (c.n === OPS_APV_STEPS.length && c.ok === c.n) {
        final = await opsCreatePO(transaction, idOps, now);
        await new sql.Request(transaction).input('id', sql.Int, idOps).input('ps', sql.Int, req.idPs).input('now', sql.DateTime, now).input('po', sql.Int, final.idPOTs)
          .query('UPDATE devsk.SeedReqSaleMt SET idPsApv = @ps, DateApv = @now, idPOTsAuto = @po WHERE idOps = @id');
      }
    }
    if (final && opsPoTestRollback()) {
      // ดูข้อมูลที่จะถูกบันทึก (PO + ใบสั่งขาย) ก่อน rollback
      const snap = await new sql.Request(transaction).input('po', sql.Int, final.idPOTs).query(`
        SELECT * FROM devsk.PkPOBuyMt WHERE idPOTs = @po;
        SELECT * FROM devsk.PkPOBuyDt WHERE idPOTs = @po;
        SELECT * FROM dbo.SmSaleOrderMt WHERE idPOTs = @po;
        SELECT d.* FROM dbo.SmSaleOrderDt d JOIN dbo.SmSaleOrderMt m ON m.idSaleOrder = d.idSaleOrder WHERE m.idPOTs = @po;`);
      await transaction.rollback();
      return res.json({ success: true, testRollback: true, steps, po: final,
        preview: { poMt: snap.recordsets[0], poDt: snap.recordsets[1], soMt: snap.recordsets[2], soDt: snap.recordsets[3] } });
    }
    await transaction.commit();

    // แจ้งผล (หลังบันทึก / เบื้องหลัง)
    res.json({ success: true, steps, po: final });
    opsBackground('apv-result', async () => {
      const doc = await loadOpsDoc(idOps);
      const me = (await opsPeople(pool, [req.idPs]))[0];
      const by = opsFormal(me);
      if (result === 'B' && doc.buy && doc.buy.by) {
        const buyer = await opsPeople(pool, [doc.buy.by.id]);
        await opsNotify(pool, idOps, 'apv-back', req, buyer, [],
          buildOpsResultMail(doc, `${opsBase(req)}/over-po-sale-buy?id=${idOps}`, 'back', opsDear(doc.buy.by), { by, step: steps[0], note }));
      } else if (result === 'R' || final) {
        const aud = await opsSellerAudience(pool, doc);
        await opsNotify(pool, idOps, result === 'R' ? 'rejected' : 'approved', req, aud.to, aud.cc,
          buildOpsResultMail(doc, `${opsBase(req)}/over-po-sale-doc?id=${idOps}`, result === 'R' ? 'rejected' : 'approved', opsDear(doc.requester),
            { by, step: steps[0], note, poCode: final && final.docCode, soCode: final && final.soCode }));
      }
    });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('OPS apv error:', err);
    res.status(500).json({ success: false, message: 'บันทึกผลการพิจารณาไม่สำเร็จ — ระบบไม่ได้บันทึกข้อมูลใดๆ', detail: err.message });
  }
});

// ==================================================================
// ---------- หน้า Home: ตัวเลขสรุปเฉพาะเมนู + บริษัทที่ผู้ใช้มีสิทธิ์ ----------
// ==================================================================
// ส่วนที่ไม่มีสิทธิ์จะไม่ถูก query และไม่อยู่ใน response เลย (หน้าเว็บไม่ต้องซ่อนเอง)
app.get('/api/home/summary', requireLogin, async (req, res) => {
  try {
    const access = await getUserAccess(req.idPs);
    const pool = await poolPromise;
    const data = {};

    if (hasMenu(access, 'coating')) {
      const request = pool.request();
      const r = await request.query(
        `SELECT mt.idComp AS id, c.CompName AS name,
           COUNT(DISTINCT CASE WHEN mt.DateRmStart IS NULL THEN mt.idRm END) AS waiting,
           COUNT(DISTINCT CASE WHEN mt.DateRmStart IS NOT NULL AND mt.DateRmEnd IS NULL THEN mt.idRm END) AS inprogress
         FROM ${COATING_TABLE} mt
         JOIN devsk.WimWaitCutMt wmt ON mt.idRm = wmt.idMt AND wmt.ProcessID = 12
         LEFT JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = mt.idComp
         WHERE mt.idPsCancel IS NULL AND mt.TypeRm IS NULL
           AND wmt.stUseCut = 1 AND mt.WAfter IS NULL
           ${compFilter(access, request, 'mt.idComp')}
           AND mt.idComp NOT IN (${HOME_EXCLUDE_COMP_IDS.join(', ')})
         GROUP BY mt.idComp, c.CompName
         ORDER BY c.CompName`
      );
      data.coating = summarizeByComp(r.recordset, ['waiting', 'inprogress']);
    }

    if (hasMenu(access, 'moisture')) {
      const request = pool.request();
      const r = await request.query(
        `SELECT mt.idComp AS id, c.CompName AS name,
           COUNT(DISTINCT CASE WHEN mt.DateRdHmS IS NULL THEN mt.idRm END) AS waiting,
           COUNT(DISTINCT CASE WHEN mt.DateRdHmS IS NOT NULL AND mt.DateRdHmE IS NULL THEN mt.idRm END) AS inprogress
         FROM ${COATING_TABLE} mt
         JOIN devsk.WimWaitCutMt wmt ON mt.idRm = wmt.idMt AND wmt.ProcessID = 12
         LEFT JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = mt.idComp
         WHERE mt.idPsCancel IS NULL AND mt.TypeRm IS NULL
           AND wmt.stUseCut = 1 AND mt.WAfter IS NULL
           ${compFilter(access, request, 'mt.idComp')}
           AND mt.idComp NOT IN (${HOME_EXCLUDE_COMP_IDS.join(', ')})
         GROUP BY mt.idComp, c.CompName
         ORDER BY c.CompName`
      );
      data.moisture = summarizeByComp(r.recordset, ['waiting', 'inprogress']);
    }

    if (hasMenu(access, 'urs_request')) {
      const r = await pool.request()
        .input('stSent', sql.VarChar(1), URS_ST_SENT)
        .input('stNotReady', sql.VarChar(1), URS_ST_NOT_READY)
        .query(
          `SELECT
             COUNT(DISTINCT CASE WHEN dt.stReq IS NULL THEN dt.idUrs END) AS draftDocs,
             SUM(CASE WHEN dt.stReq = @stSent THEN 1 ELSE 0 END) AS awaitingReply,
             SUM(CASE WHEN dt.stReq = @stNotReady THEN 1 ELSE 0 END) AS notReady
           FROM GR_Group.devsk.SeedUrgentReqDt dt
           JOIN GR_Group.devsk.SeedUrgentReqMt mt ON dt.idUrs = mt.idUrs
           WHERE mt.idPsCancel IS NULL AND mt.idCompReq IN (${URS_COMPANY_IDS.join(', ')})`
        );
      const row = r.recordset[0];
      data.urs = { draftDocs: row.draftDocs || 0, awaitingReply: row.awaitingReply || 0, notReady: row.notReady || 0 };
    }

    // ผู้อนุมัติ Over PO: ใบขออนุมัติที่รอการพิจารณาของผู้ใช้ (เงื่อนไขเดียวกับ /api/ops/apv/pending) — แสดงการ์ดเมื่อมีรายการ
    {
      const r = await pool.request().input('ps', sql.Int, req.idPs).query(`
        SELECT COUNT(*) AS n, CAST(ISNULL(SUM(t.amt), 0) AS decimal(18, 2)) AS total
        FROM (
          SELECT (SELECT SUM(ROUND(d.AmountBuy * ISNULL(d.Price, 0), 2)) FROM devsk.SeedReqSaleDt d WHERE d.idOps = m.idOps AND d.AmountBuy > 0) AS amt
          FROM devsk.SeedReqSaleMt m
          ${OPS_ROUND_SQL()}
          WHERE m.DateBuy IS NOT NULL AND m.DateCancel IS NULL AND m.DateReject IS NULL AND m.DateApv IS NULL AND ISNULL(ar.ApvBack, 0) = 0
            AND EXISTS (SELECT 1 FROM devsk.SeedReqSaleApv a WHERE a.idOps = m.idOps AND a.ApvRound = m.ApvRound AND a.idPsAssign = @ps AND a.Result IS NULL)
        ) t`);
      const row = r.recordset[0];
      if (row && row.n) data.opsApv = { pending: row.n, total: Number(row.total) || 0 };
    }

    let companies = null;
    if (!access.allComps) {
      const compReq = pool.request();
      const comps = await compReq.query(
        `SELECT c.idComp AS id, c.CompName AS name
         FROM PchInvAndProject.dbo.dCompany c
         WHERE c.idComp NOT IN (${HOME_EXCLUDE_COMP_IDS.join(', ')})
           ${compFilter(access, compReq, 'c.idComp')}
         ORDER BY c.CompName`
      );
      companies = comps.recordset;
    }

    res.json({
      success: true,
      unrestricted: access.unrestricted,
      allowedMenuCodes: [...access.menus],
      companies,                             // บริษัทที่มีสิทธิ์ (null = ทุกบริษัท)
      menuOrder: await getMenuOrderSafe(),   // ลำดับเมนูหน้า Home (WIMWebMenu.SortOrder)
      wipMenuCodes: await getWipMenusSafe(), // เมนู On process (ซ่อนจากผู้ใช้ทั่วไป)
      data
    });
  } catch (err) {
    console.error('Home summary error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลสรุปไม่สำเร็จ', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 WIM API server ทำงานที่ http://localhost:${PORT}`);
});