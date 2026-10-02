require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const sql = require('mssql');

const app = express();

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ตั้งค่า Session สำหรับเก็บข้อมูล Token และ User หลัง Login ผ่าน SSO สำเร็จ
app.use(session({
  secret: process.env.SESSION_SECRET || 'wim-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 1 วัน
  }
}));

// เซฟตี้เน็ต: กัน error ที่หลุดไปโดยไม่มีใครจับ ไม่ให้ทำให้ server ทั้งตัวล่ม
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

// เสิร์ฟไฟล์หน้าเว็บ (public/index.html) จาก server เดียวกัน
app.use(express.static(path.join(__dirname, 'public'), {
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
    res.redirect(returnTo || '/main-menu.html');
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
           WHERE p.idGroup = @idGroup AND p.stAllow = 1 AND p.stDel IS NULL AND m.stDel IS NULL`
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

  try {
    const pool = await poolPromise;
    const topClause = keyword ? 'TOP 50' : '';
    const result = await pool.request()
      .input('companyId', sql.NVarChar, companyId)
      .input('keyword', sql.NVarChar, `%${keyword}%`)
      .query(
        `SELECT ${topClause} l.idLot, l.LotNo AS lotNo, i.InvName AS productName
         FROM ${LOT_TABLE} l
         LEFT JOIN dInventoryMain i ON l.idInvMain = i.idInvMain
         WHERE l.stDel IS NULL AND l.CompRec = @companyId AND l.LotNo LIKE @keyword
           AND l.LotNo IS NOT NULL AND LTRIM(RTRIM(l.LotNo)) <> ''
         ORDER BY l.LotNo`
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
        `SELECT TOP 1 l.idLot, l.LotNo AS lotNo, i.InvName AS productName
         FROM ${LOT_TABLE} l
         LEFT JOIN dInventoryMain i ON l.idInvMain = i.idInvMain
         WHERE l.stDel IS NULL AND l.CompRec = @companyId AND l.LotNo = @lotNo`
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
      `SELECT idMenu, MenuCode, MenuName, MenuUrl, idParentMenu, SortOrder
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

app.get('/api/usergroups/available-users', requireMenu([MENU_ADMIN, 'urs_request']), async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  try {
    const pool = await poolPromise;
    const topClause = keyword ? 'TOP 50' : '';
    const result = await pool.request()
      .input('keyword', sql.NVarChar, `%${keyword}%`)
      .query(
        `SELECT ${topClause} v.idPs, v.PsName, v.PositionName, v.CompName, v.CompCode
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
      await req2.query(
        `INSERT INTO WIMWebMenuPermission (idGroup, idMenu, stAllow${idPsCreate ? ', idPsCreate' : ''})
         VALUES (@idGroup, @idMenu, 1${idPsCreate ? ', @idPsCreate' : ''})`
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
    res.json({ success: true, unrestricted: access.unrestricted, allowedMenuCodes: [...access.menus] });
  } catch (err) {
    console.error('Permissions my error:', err);
    res.status(500).json({ success: false, message: 'โหลดสิทธิ์การใช้งานไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- สิทธิ์บริษัทที่เข้าถึงได้ (ผูกกับกลุ่มผู้ใช้งาน เหมือนสิทธิ์เมนู) ----------
// ==================================================================

// ---------- บริษัทที่เลือกส่งคำร้องขอเมล็ดพันธุ์เร่งด่วนได้ (กำหนดตายตัว ใช้กับทุก user) ----------
const URS_COMPANY_IDS = [2, 3, 4];
app.get('/api/urs/companies', requireMenu('urs_request'), async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT idComp AS id, CompName AS name
       FROM PchInvAndProject.dbo.dCompany
       WHERE stDel IS NULL AND idComp IN (${URS_COMPANY_IDS.join(', ')})
       ORDER BY CompName`
    );
    res.json({ success: true, data: result.recordset });
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
app.post('/api/urs/requests', requireMenu('urs_request'), async (req, res) => {
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
app.put('/api/urs/requests/:idUrs', requireMenu('urs_request'), async (req, res) => {
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

    await transaction.commit();
    res.json({ success: true, idUrs, sent });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (rollbackErr) {} }
    console.error('URS edit request error:', err);
    res.status(500).json({ success: false, message: 'แก้ไขคำร้องไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ยกเลิกคำร้อง (ได้เฉพาะ Draft / รอตอบกลับ) ----------
// Mt: ผู้ยกเลิก / เวลา / เหตุผล — Dt: ทุกรายการเป็น 'C' + ผู้ลบ / เวลาลบ (เอกสารจะไม่แสดงในรายการอีก)
app.post('/api/urs/requests/:idUrs/cancel', requireMenu('urs_request'), async (req, res) => {
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
app.get('/api/urs/requests', requireMenu('urs_request'), async (req, res) => {
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

// ---------- ส่งคำร้อง: Draft ทุกรายการในเอกสาร -> ส่งคำร้องแล้ว + เก็บผู้ส่ง / เวลาส่ง ----------
// ส่งซ้ำได้ (กดเพื่อขอลิงก์อีกครั้ง) — รายการที่ส่ง/ตอบกลับไปแล้วไม่ถูกแตะ
app.post('/api/urs/requests/:idUrs/send', requireMenu('urs_request'), async (req, res) => {
  const idPs = req.session.user && parseInt(req.session.user.idPs, 10);
  if (!idPs) return res.status(401).json({ success: false, message: 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' });
  const idUrs = parseInt(req.params.idUrs, 10);
  if (!idUrs) return res.status(400).json({ success: false, message: 'idUrs ไม่ถูกต้อง' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('idUrs', sql.Int, idUrs)
      .input('idPs', sql.Int, idPs)
      .input('stSent', sql.VarChar(1), URS_ST_SENT)
      .query(
        `IF NOT EXISTS (SELECT 1 FROM GR_Group.devsk.SeedUrgentReqMt WHERE idUrs = @idUrs AND idPsCancel IS NULL)
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
    if (sentCount === -1) return res.status(404).json({ success: false, message: 'ไม่พบคำร้องนี้ หรือคำร้องถูกยกเลิกแล้ว' });
    res.json({ success: true, sentCount });
  } catch (err) {
    console.error('URS send error:', err);
    res.status(500).json({ success: false, message: 'ส่งคำร้องไม่สำเร็จ', detail: err.message });
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
        `SELECT
           COUNT(DISTINCT CASE WHEN mt.DateRmStart IS NULL THEN mt.idRm END) AS waiting,
           COUNT(DISTINCT CASE WHEN mt.DateRmStart IS NOT NULL AND mt.DateRmEnd IS NULL THEN mt.idRm END) AS inprogress
         FROM ${COATING_TABLE} mt
         JOIN devsk.WimWaitCutMt wmt ON mt.idRm = wmt.idMt AND wmt.ProcessID = 12
         WHERE mt.idPsCancel IS NULL AND mt.TypeRm IS NULL
           AND wmt.stUseCut = 1 AND mt.WAfter IS NULL
           ${compFilter(access, request, 'mt.idComp')}`
      );
      data.coating = r.recordset[0];
    }

    if (hasMenu(access, 'moisture')) {
      const request = pool.request();
      const r = await request.query(
        `SELECT
           COUNT(DISTINCT CASE WHEN mt.DateRdHmS IS NULL THEN mt.idRm END) AS waiting,
           COUNT(DISTINCT CASE WHEN mt.DateRdHmS IS NOT NULL AND mt.DateRdHmE IS NULL THEN mt.idRm END) AS inprogress,
           COUNT(DISTINCT CASE WHEN mt.DateRdHmS IS NOT NULL AND mt.DateRdHmE IS NULL THEN mt.${COL_ROOM} END) AS roomsBusy
         FROM ${COATING_TABLE} mt
         JOIN devsk.WimWaitCutMt wmt ON mt.idRm = wmt.idMt AND wmt.ProcessID = 12
         WHERE mt.idPsCancel IS NULL AND mt.TypeRm IS NULL
           AND wmt.stUseCut = 1 AND mt.WAfter IS NULL
           ${compFilter(access, request, 'mt.idComp')}`
      );
      const roomReq = pool.request();
      const rooms = await roomReq.query(
        `SELECT COUNT(*) AS roomsTotal FROM devsk.SeedReduceHmRoom
         WHERE stDel IS NULL ${compFilter(access, roomReq, 'idComp')}`
      );
      data.moisture = { ...r.recordset[0], roomsTotal: rooms.recordset[0].roomsTotal };
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

    res.json({
      success: true,
      unrestricted: access.unrestricted,
      allowedMenuCodes: [...access.menus],
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