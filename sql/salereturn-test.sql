-- ==================================================================
-- ทดสอบ query รายงานการรับคืนสินค้า (เวอร์ชันปรับความเร็ว v2) — รันใน SSMS ได้เลย
-- ==================================================================
-- อ่านอย่างเดียว: ใช้แค่ตารางชั่วคราว (#rt, #box, #lots, #pairs, #seed) ไม่แก้ข้อมูลในตารางจริง
--
-- สิ่งที่เปลี่ยนจาก query เดิม (ผลลัพธ์ต้องเหมือนเดิม ยกเว้นตัด DateGrowPP / DateGrowSand ออก):
--   1. เริ่ม join จาก WimWaitReturnMt ที่กรองวันที่แล้ว และใช้ INNER JOIN ตลอดเส้นทาง wrtMt → wrtDt → rtdt → wDt → rDt
--      (เดิมเป็น LEFT JOIN แต่เงื่อนไขวันที่บังคับให้ทุกตารางในเส้นทางนี้ต้องมีข้อมูลอยู่แล้ว)
--   2. AmountRTBal: รวม dInvLotRefWh ตาม idBox ครั้งเดียวทั้งชุด (#box) แทนการอ่าน 4 ครั้งต่อแถว
--      ส่วน "Amount ของ idRefLot เดียวกัน" ใช้ wh.Amount ที่ join มาแล้ว (เป็นแถวเดียวกัน)
--   3. กรองสถานะ "คงเหลือในคลัง" ก่อน แล้วค่อยหา SeedNameUsed เฉพาะ Lot ที่เหลือ
--      v2: join หาเมล็ดที่ใช้ของทุก Lot พร้อมกันครั้งเดียว (#pairs) แล้วค่อยต่อชื่อด้วย FOR XML จากตารางเล็ก
--      (v1 ค้น dWithdrawMt/Dt แยกทีละ Lot = 657 รอบ ใช้ 11 วินาที)
--   4. ตัด DateGrowPP / DateGrowSand ออก (หน้าเว็บยังไม่ได้ใช้)
--   5. ยอดคงเหลือไม่นับของที่อยู่คลัง 5503 (dInvLotRefWh.idWh) — ตรงกับ /api/salereturn ใน server.js
--      ยอดรวมกล่อง (BoxSum) = ไม่รวมแถวคลัง 5503 / ยอดของ idRefLot นี้ (whAmount) = 0 ถ้าอยู่คลัง 5503
--
-- ผล v1 (ปี 2026, idComp 4): ขั้น 1 = 7258 ms / ขั้น 2-3 = 11011 ms / ขั้น 4 = 78 ms / รวม 18347 ms / 924 แถว
-- ==================================================================

SET NOCOUNT ON;

-- ---------- พารามิเตอร์ทดสอบ (แก้ตรงนี้) ----------
DECLARE @idComp nvarchar(20) = N'4';
DECLARE @dStart varchar(8) = '20260101';   -- วันแรก (รวม)        เช่น ทั้งปี 2026 = 20260101
DECLARE @dEnd   varchar(8) = '20270101';   -- วันถัดจากวันสุดท้าย  เช่น ทั้งปี 2026 = 20270101
-- เดือน 9/2026 = '20260901' ถึง '20261001'

DECLARE @t0 datetime2 = SYSDATETIME(), @t datetime2 = SYSDATETIME(), @n int;

IF OBJECT_ID('tempdb..#rt')    IS NOT NULL DROP TABLE #rt;
IF OBJECT_ID('tempdb..#box')   IS NOT NULL DROP TABLE #box;
IF OBJECT_ID('tempdb..#lots')  IS NOT NULL DROP TABLE #lots;
IF OBJECT_ID('tempdb..#pairs') IS NOT NULL DROP TABLE #pairs;
IF OBJECT_ID('tempdb..#seed')  IS NOT NULL DROP TABLE #seed;

-- ---------- ขั้น 1a: แถวพื้นฐานตามบริษัท + ช่วงวันที่ (ยังไม่คำนวณ AmountRTBal) ----------
SELECT CONVERT(bit,0) AS chk, rDt.idCountRef, comp.CompCode, lm.idLot, ps.PsName AS PsSale,
       wrtMt.DateWaitReturn, wrtMt.ReturnNo, rtdt.LotNoRT, p.PartnerName,
       inv.idInvMain, inv.idUnit, inv.InvName, rDt.idComp,
       ISNULL(CONCAT(FORMAT(pk.Weight,'#,##0.##'), ' ' + uw.UnitName),'-') AS WeightxUnit,
       inv.idInvGroup, rDt.SumVolumn AS AmountRT, wh.idRefLot,
       wh.idBox AS whIdBox, IIF(ISNULL(wh.idWh,0) = 5503, 0, wh.Amount) AS whAmount,   -- อยู่คลัง 5503 = ไม่นับ
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
WHERE wrtMt.DateWaitReturn >= @dStart AND wrtMt.DateWaitReturn < @dEnd
  AND rDt.idComp = @idComp
  AND rtmt.idPsCancel IS NULL;

SET @n = @@ROWCOUNT;
PRINT CONCAT('ขั้น 1a (แถวพื้นฐาน): ', @n, ' แถว, ', DATEDIFF(ms, @t, SYSDATETIME()), ' ms');
SET @t = SYSDATETIME();

-- ---------- ขั้น 1b: ยอดคงเหลือรวมต่อกล่อง (ครั้งเดียวทั้งชุด) + คำนวณ AmountRTBal ----------
SELECT rw.idBox, SUM(rw.Amount) AS BoxSum
INTO #box
FROM devsk.dInvLotRefWh rw
WHERE rw.idBox IN (SELECT whIdBox FROM #rt WHERE whIdBox IS NOT NULL)
  AND ISNULL(rw.idWh,0) <> 5503                                                     -- ไม่นับของที่อยู่คลัง 5503
GROUP BY rw.idBox;

ALTER TABLE #rt ADD AmountRTBal decimal(18,4) NULL, BoxSum decimal(18,4) NULL;

UPDATE a
SET BoxSum = bx.BoxSum,
    AmountRTBal = IIF(ISNULL(bx.BoxSum,0) = 0,
                      IIF(a.whAmount > a.SumVolumn, a.SumVolumn, a.whAmount),
                      bx.BoxSum)
FROM #rt a
LEFT JOIN #box bx ON bx.idBox = a.whIdBox;

PRINT CONCAT('ขั้น 1b (AmountRTBal): ', DATEDIFF(ms, @t, SYSDATETIME()), ' ms');
SET @t = SYSDATETIME();

-- ---------- ขั้น 2: Lot ที่ต้องหา SeedNameUsed (เฉพาะแถวที่ผ่านตัวกรองสถานะ "คงเหลือในคลัง") ----------
SELECT DISTINCT a.idLotMain
INTO #lots
FROM #rt a
WHERE a.idLotMain IS NOT NULL
  AND a.AmountRTBal > 0;          -- statusMode = remaining  (หมดแล้ว = <= 0 / ทั้งหมด = ไม่ใส่บรรทัดนี้)

-- ---------- ขั้น 3a: เมล็ดที่ใช้ของทุก Lot — join ครั้งเดียวทั้งชุด ----------
SELECT DISTINCT lm2.idLot AS idLotMain, inv2.InvName
INTO #pairs
FROM devsk.dInvLotMain lm2
JOIN devsk.dWithdrawMt dMt      ON lm2.idPlan = dMt.idPlanMt
JOIN devsk.dWithdrawDt dDt      ON dMt.idWitdMt = dDt.idWitdMt
JOIN devsk.dInventoryMain inv2  ON dDt.idInvMain = inv2.idInvMain
WHERE lm2.idLot IN (SELECT idLotMain FROM #lots)
  AND inv2.idInvGroup = 1
  AND stCancel = 0;

PRINT CONCAT('ขั้น 2-3a (หาเมล็ดที่ใช้): ', @@ROWCOUNT, ' คู่ Lot-เมล็ด, ', DATEDIFF(ms, @t, SYSDATETIME()), ' ms');
SET @t = SYSDATETIME();

-- ---------- ขั้น 3b: ต่อชื่อเมล็ดต่อ Lot จากตารางเล็ก ----------
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

PRINT CONCAT('ขั้น 3b (ต่อชื่อเมล็ด): ', @@ROWCOUNT, ' Lot, ', DATEDIFF(ms, @t, SYSDATETIME()), ' ms');
SET @t = SYSDATETIME();

-- ---------- ขั้น 4: ผลลัพธ์สุดท้าย ----------
SELECT a.*, ISNULL(s.SeedNameUsed, '-') AS SeedNameUsed
FROM #rt a
LEFT JOIN #seed s ON s.idLotMain = a.idLotMain
WHERE 1=1
  AND a.AmountRTBal > 0           -- statusMode = remaining
  -- AND a.LotNoRT LIKE N'%...%'
  -- AND a.ReturnNo LIKE N'%...%'
  -- AND (a.InvName LIKE N'%...%' OR ISNULL(s.SeedNameUsed,'-') LIKE N'%...%')
ORDER BY a.BoxNo;

PRINT CONCAT('ขั้น 4 (ผลลัพธ์): ', @@ROWCOUNT, ' แถว, ', DATEDIFF(ms, @t, SYSDATETIME()), ' ms');
PRINT CONCAT('รวมทั้งหมด: ', DATEDIFF(ms, @t0, SYSDATETIME()), ' ms');

DROP TABLE #rt;
DROP TABLE #box;
DROP TABLE #lots;
DROP TABLE #pairs;
DROP TABLE #seed;
