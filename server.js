require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();
app.use(cors());
app.use(express.json());

// เซฟตี้เน็ต: กัน error ที่หลุดไปโดยไม่มีใครจับ ไม่ให้ทำให้ server ทั้งตัวล่ม
// (log ไว้ดูใน terminal แทนที่จะปล่อยให้ process ปิดตัวเองเงียบๆ)
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

// เสิร์ฟไฟล์หน้าเว็บ (public/index.html) จาก server เดียวกัน
// เพื่อเลี่ยงปัญหา CORS ระหว่างหน้าเว็บกับ API
app.use(express.static(path.join(__dirname, 'public')));

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

// สำคัญ: ห้าม throw ซ้ำใน .catch() ตรงนี้ ไม่งั้นจะเกิด unhandled promise rejection
// ซึ่งทำให้ Node.js process ทั้งตัวปิดตัวเองทันทีเมื่อต่อ DB ไม่สำเร็จ
// (server ทั้งตัวจะล่ม ไม่ใช่แค่ endpoint login ใช้งานไม่ได้)
let poolPromise = new sql.ConnectionPool(dbConfig).connect();

poolPromise
  .then(() => {
    console.log('✅ เชื่อมต่อ SQL Server (GR_Group) สำเร็จ');
  })
  .catch(err => {
    console.error('❌ เชื่อมต่อ SQL Server ไม่สำเร็จ:', err.message);
    console.error('   → server ยังทำงานอยู่ แต่ endpoint ที่ใช้ DB จะตอบ error กลับไปแทน');
  });

// ---------- ชื่อ table/คอลัมน์จริงตาม schema ----------
const TABLE_NAME = 'dPerson';
const COL_USERNAME = 'UN';
const COL_PASSWORD = 'PW';

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

// ---------- endpoint สำหรับ login ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอก username และ password' });
  }

  try {
    const pool = await poolPromise;

    // ใช้ parameterized query เพื่อป้องกัน SQL Injection
    const result = await pool.request()
      .input('username', sql.NVarChar, username)
      .query(`SELECT TOP 1 * FROM ${TABLE_NAME} WHERE ${COL_USERNAME} = @username`);

    if (result.recordset.length === 0) {
      return res.status(401).json({ success: false, message: 'ไม่พบผู้ใช้งานนี้' });
    }

    const user = result.recordset[0];

    // ⚠️ หมายเหตุ: โค้ดนี้เทียบรหัสผ่านแบบ plain text ตามข้อมูลที่มีใน table
    // ถ้ารหัสผ่านใน DB เข้ารหัสด้วย bcrypt/hash ต้องเปลี่ยนมาใช้ bcrypt.compare() แทน
    if (String(user[COL_PASSWORD]) !== String(password)) {
      return res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    delete user[COL_PASSWORD]; // ไม่ส่งรหัสผ่านกลับไปฝั่ง client

    // หา idComp (บริษัทของผู้ใช้คนนี้) เพื่อใช้ default ค่า combobox บริษัติทุกหน้าอัตโนมัติ
    // ไม่ทำให้ login ล้มเหลวถ้า query นี้ error/ไม่พบ แค่จะไม่มีการ default ให้เฉยๆ
    try {
      const compResult = await pool.request()
        .input('idPs', sql.Int, user.idPs)
        .query('SELECT idComp FROM devsk.vPersonxSelect WHERE idPs = @idPs');
      if (compResult.recordset.length > 0) {
        user.idComp = compResult.recordset[0].idComp;
      }
    } catch (compErr) {
      console.error('หา idComp ของผู้ใช้ไม่สำเร็จ (ไม่กระทบการ login):', compErr.message);
    }

    return res.json({ success: true, user });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
  }
});

const PORT = process.env.PORT || 3001;

// ==================================================================
// ---------- STOCK CARD: บริษัท / ค้นหา Lot / เรียก stored procedure ----------
// ==================================================================

const LOT_TABLE = 'GR_Group.devsk.dInvLotMain';
const SP_STOCKCARD = 'devsk.sp_StockCardInv';
const SP_PARAM_LOT = 'idLot'; // ต้องตรงกับชื่อ parameter ใน stored procedure เป๊ะๆ (ไม่ต้องมี @)

// ---------- ดึงรายชื่อบริษัททั้งหมด สำหรับ combobox ----------
app.get('/api/companies', async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(
      `SELECT c.CompName AS name, m.idcomp AS id
       FROM PchInvAndProject.devsk.dGroupCompMap m
       LEFT JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = m.idcomp
       WHERE c.stDel IS NULL AND m.stActive = 1 AND c.CompName IS NOT NULL
       ORDER BY c.CompName`
    );
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Companies error:', err);
    res.status(500).json({ success: false, message: 'โหลดข้อมูลบริษัทไม่สำเร็จ', detail: err.message });
  }
});

// ---------- ค้นหา Lot No. ในระบบ (ต้องระบุบริษัทเสมอ + พิมพ์คำค้นประกอบได้) ----------
app.get('/api/lots/search', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const companyId = (req.query.companyId || '').trim();

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อนค้นหา Lot' });
  }

  try {
    const pool = await poolPromise;
    // โหมดพิมพ์ค้นหา (มีคำค้น) จำกัด TOP 50 กันโหลดหนักตอนพิมพ์
    // โหมดดูทั้งหมด (ไม่พิมพ์คำค้น) ไม่จำกัดจำนวน เอามาให้ครบทุก Lot ของบริษัทนั้น
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

// ---------- แปลง Lot No. ที่พิมพ์เอง (exact match) ให้เป็น idLot ก่อนเรียก stored procedure ----------
app.get('/api/lots/resolve', async (req, res) => {
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

// ---------- เรียก stored procedure devsk.sp_StockCardInv ----------
app.get('/api/stockcard', async (req, res) => {
  const idLot = (req.query.idLot || '').trim();

  if (!idLot) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ Lot No.' });
  }

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input(SP_PARAM_LOT, sql.NVarChar, idLot)
      .execute(SP_STOCKCARD);

    // stored procedure บางตัวคืนหลาย recordset, ใช้ตัวแรกเป็นหลัก
    const rows = result.recordset || (result.recordsets && result.recordsets[0]) || [];
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('StockCard error:', err);
    res.status(500).json({ success: false, message: 'ดึงข้อมูล Stock Card ไม่สำเร็จ', detail: err.message });
  }
});

// ==================================================================
// ---------- STOCK CARD (รายสินค้า): ค้นหาสินค้า / เรียก stored procedure รวมทุก Lot ----------
// ==================================================================

// (ไม่ต้องมี config ชื่อ parameter แยกอีกแล้ว เพราะเรียกแบบ positional ตรงๆ ใน query ด้านล่าง)

// ---------- ค้นหาสินค้า (InvName) เฉพาะสินค้าที่มี Lot อยู่จริงของบริษัทที่เลือก ----------
// รองรับกรองด้วย groupId (กลุ่มสินค้า) แบบ optional ด้วย
app.get('/api/items/search', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const companyId = (req.query.companyId || '').trim();
  const groupId = (req.query.groupId || '').trim();

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อนค้นหาสินค้า' });
  }

  try {
    const pool = await poolPromise;
    // ไม่มั่นใจว่า dInventoryMain มีคอลัมน์บริษัทตรงๆ ไหม จึงกรองผ่าน Lot ที่ผูกกับบริษัทแทน (ปลอดภัยกว่าเดาคอลัมน์เพิ่ม)
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

// ---------- ดึงรายการกลุ่มสินค้า (Inventory Group) สำหรับกรองในหน้าค้นหาสินค้า ----------
app.get('/api/inv-groups', async (req, res) => {
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

// ---------- เรียก stored procedure devsk.sp_StockCardInvAllLot (รวมทุก Lot ของสินค้านั้น) ----------
// ⚠️ SP ตัวนี้รับ parameter แบบ "ตำแหน่ง" (positional) 6 ค่าตามลำดับนี้เป๊ะๆ:
//    idInvMain, idComp, MonthStart, YearStart, MonthEnd, YearEnd
// จึงใช้ EXEC proc @p1, @p2, ... แบบไม่ระบุชื่อ parameter ให้ SQL Server จับคู่ตามตำแหน่งแทน
// (ไม่ต้องรู้ชื่อ parameter จริงในตัว SP)
app.get('/api/stockcard-allot', async (req, res) => {
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

// ---------- ดึงรายการตามสถานะ: waiting (รอเริ่ม) / inprogress (กำลังเคลือบ) / done (เสร็จแล้ว) ----------
app.get('/api/coating/list', async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  const status = (req.query.status || '').trim();
  const date = (req.query.date || '').trim(); // ใช้เฉพาะตอน status=done

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อน' });
  }

  let statusCondition = '';
  let topClause = '';
  let orderBy = 'mt.DateReq';
  // เงื่อนไข wmt.stUseCut/WAfter เหมาะกับรายการที่ยังอยู่ในคิวทำงาน (รอเริ่ม/กำลังเคลือบ) เท่านั้น
  // พอเคลือบเสร็จแล้ว record จะหลุดออกจากคิว WimWaitCutMt ไปแล้ว (join ไม่เจอ) จึงต้องไม่ใช้เงื่อนไขนี้กับสถานะ done
  let queueCondition = 'AND wmt.stUseCut = 1 AND mt.WAfter IS NULL';

  if (status === 'waiting') {
    statusCondition = 'AND mt.DateRmStart IS NULL';
  } else if (status === 'inprogress') {
    statusCondition = 'AND mt.DateRmStart IS NOT NULL AND mt.DateRmEnd IS NULL';
  } else if (status === 'done') {
    statusCondition = 'AND mt.DateRmStart IS NOT NULL AND mt.DateRmEnd IS NOT NULL';
    queueCondition = ''; // เสร็จแล้วไม่ต้องเช็คเงื่อนไขคิวอีก
    orderBy = 'mt.DateRmEnd DESC';
    if (date) {
      // โหมดค้นหาตามวันที่ที่ระบุ
      statusCondition += ' AND CAST(mt.DateRmEnd AS DATE) = @filterDate';
    } else {
      // โหมด default: ล่าสุด 10 รายการ (ไม่กรองวันที่)
      topClause = 'TOP 5';
    }
  } else {
    return res.status(400).json({ success: false, message: 'ระบุ status ไม่ถูกต้อง (waiting/inprogress/done)' });
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

// ---------- บันทึกเวลาเริ่มเคลือบ ----------
app.post('/api/coating/start', async (req, res) => {
  const { idRm, idPs } = req.body;
  if (!idRm) return res.status(400).json({ success: false, message: 'ไม่พบรายการที่ต้องการ' });

  try {
    const pool = await poolPromise;
    const request = pool.request().input('idRm', sql.Int, idRm);

    // เก็บ idPsDateRmStart (ผู้กดปุ่มเริ่ม) ด้วย ถ้ามีส่งมา
    let setClause = 'DateRmStart = GETDATE()';
    if (idPs) {
      request.input('idPs', sql.Int, Number(idPs));
      setClause += ', idPsDateRmStart = @idPs';
    }

    const result = await request
      .query(`UPDATE ${COATING_TABLE} SET ${setClause} WHERE idRm = @idRm AND DateRmStart IS NULL`);

    if (result.rowsAffected[0] === 0) {
      return res.status(409).json({ success: false, message: 'รายการนี้ถูกลงเวลาเริ่มไปแล้ว หรือไม่พบรายการ' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Coating start error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเวลาเริ่มไม่สำเร็จ', detail: err.message });
  }
});

// ---------- บันทึกเวลาสิ้นสุดเคลือบ ----------
app.post('/api/coating/end', async (req, res) => {
  const { idRm, idPs } = req.body;
  if (!idRm) return res.status(400).json({ success: false, message: 'ไม่พบรายการที่ต้องการ' });

  try {
    const pool = await poolPromise;
    const request = pool.request().input('idRm', sql.Int, idRm);

    // เก็บ idPsDateRmEnd (ผู้กดปุ่มสิ้นสุด) ด้วย ถ้ามีส่งมา
    let setClause = 'DateRmEnd = GETDATE()';
    if (idPs) {
      request.input('idPs', sql.Int, Number(idPs));
      setClause += ', idPsDateRmEnd = @idPs';
    }

    const result = await request
      .query(`UPDATE ${COATING_TABLE} SET ${setClause} WHERE idRm = @idRm AND DateRmStart IS NOT NULL AND DateRmEnd IS NULL`);

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
// ---------- การลงเวลาลดความชื้น (ใช้ table เดียวกับเคลือบเมล็ด: SCoatingANDMixMt) ----------
// ==================================================================

// ⚠️ ชื่อคอลัมน์ด้านล่างนี้ยังไม่ได้ยืนยัน เป็นการเดาไว้ก่อนตามรูปแบบชื่อที่ใช้ในตารางนี้
// ต้องเช็คชื่อจริงแล้วแก้ตรงนี้ถ้าไม่ตรง
const COL_ROOM = 'idHumidRoom';   // คอลัมน์เก็บห้องที่ใช้ลดความชื้น ใน SCoatingANDMixMt
const COL_TEMP = 'TempOfRoom';    // คอลัมน์เก็บอุณหภูมิ
const COL_HUMID = 'HumidOfRoom';  // คอลัมน์เก็บความชื้น
const COL_PS_HM_START = 'idPsDateRdHmS'; // คอลัมน์เก็บผู้กดปุ่มเริ่มลดความชื้น
const COL_PS_HM_END = 'idPsDateRdHmE';   // คอลัมน์เก็บผู้กดปุ่มสิ้นสุดลดความชื้น
const COL_MC_AFTER = 'Humid';            // คอลัมน์เก็บ "ความชื้นหลังจัดการ"

// ---------- ดึงรายการห้องลดความชื้น (เฉพาะห้องของบริษัทที่เลือก และยังไม่ถูกลบ) ----------
app.get('/api/moisture/rooms', async (req, res) => {
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

// ---------- ดึงรายการตามสถานะ: waiting (รอเริ่ม) / inprogress (กำลังลดความชื้น) / done (เสร็จแล้ว) ----------
app.get('/api/moisture/list', async (req, res) => {
  const companyId = (req.query.companyId || '').trim();
  const status = (req.query.status || '').trim();
  const date = (req.query.date || '').trim();

  if (!companyId) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกบริษัทก่อน' });
  }

  let statusCondition = '';
  let topClause = '';
  let orderBy = 'mt.DateReq';
  // เงื่อนไขคิว เหมือนหน้าเคลือบเมล็ด ใช้เฉพาะรายการที่ยังอยู่ในคิวทำงาน (รอเริ่ม/กำลังลดความชื้น)
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
    return res.status(400).json({ success: false, message: 'ระบุ status ไม่ถูกต้อง (waiting/inprogress/done)' });
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

// ---------- บันทึกเวลาเริ่มลดความชื้น พร้อมห้อง/อุณหภูมิ/ความชื้น (บังคับกรอกครบทุกช่อง) ----------
app.post('/api/moisture/start', async (req, res) => {
  const { idRm, idPs, roomId, temp, humidity } = req.body;

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
      .query(`UPDATE ${COATING_TABLE} SET ${setClause} WHERE idRm = @idRm AND DateRdHmS IS NULL`);

    if (result.rowsAffected[0] === 0) {
      return res.status(409).json({ success: false, message: 'รายการนี้ถูกลงเวลาเริ่มไปแล้ว หรือไม่พบรายการ' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Moisture start error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเวลาเริ่มไม่สำเร็จ', detail: err.message });
  }
});

// ---------- บันทึกเวลาสิ้นสุดลดความชื้น ----------
app.post('/api/moisture/end', async (req, res) => {
  const { idRm, idPs, humidAfter } = req.body;

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
      .query(`UPDATE ${COATING_TABLE} SET ${setClause} WHERE idRm = @idRm AND DateRdHmS IS NOT NULL AND DateRdHmE IS NULL`);

    if (result.rowsAffected[0] === 0) {
      return res.status(409).json({ success: false, message: 'รายการนี้ยังไม่ได้เริ่ม หรือถูกลงเวลาสิ้นสุดไปแล้ว' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Moisture end error:', err);
    res.status(500).json({ success: false, message: 'บันทึกเวลาสิ้นสุดไม่สำเร็จ', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 WIM API server ทำงานที่ http://localhost:${PORT}`);
});
