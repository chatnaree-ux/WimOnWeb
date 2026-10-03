-- ==================================================================
-- เทียบผลลัพธ์ query รายงานรับคืนสินค้า: เดิม (GCRTRpt) vs ใหม่ (v2) ทุกแถว ทุกคอลัมน์ — รันใน SSMS
-- ==================================================================
-- อ่านอย่างเดียว: ใช้แค่ตารางชั่วคราว ไม่แก้ข้อมูลในตารางจริง
-- query เดิมช้า (โหมดปีอาจเกิน 1 นาที) — SSMS ไม่มี timeout รอจนเสร็จได้
--
-- ผลที่ควรได้ (แท็บ Results):
--   ชุดที่ 1 = จำนวนแถวของทั้งสองฝั่ง → ต้องเท่ากัน
--   ชุดที่ 2 = แถวที่มีใน "เดิม" แต่ไม่มีใน "ใหม่"   → ต้องว่าง
--   ชุดที่ 3 = แถวที่มีใน "ใหม่" แต่ไม่มีใน "เดิม"   → ต้องว่าง
--   ชุดที่ 4 = ยอดคงเหลือ (BoxSum / whAmount / AmountRTBal) เดิม-ใหม่ ข้างกันทีละแถว → Match = 'ตรง' ทุกแถว
-- ทั้งสองฝั่งไม่นับของที่อยู่คลัง 5503 (dInvLotRefWh.idWh) ในยอดคงเหลือ
-- ถ้าชุด 2/3 มีแถว ให้ดูคอลัมน์ที่ต่างกันของ idPkPORec เดียวกัน
-- (ถ้าต่างแค่ลำดับชื่อใน SeedNameUsed ถือว่าไม่ใช่ปัญหา: เดิมใช้ GROUP BY ไม่รับประกันลำดับ / ใหม่เรียงตามชื่อ)
-- ==================================================================

SET NOCOUNT ON;

DECLARE @idComp nvarchar(20) = N'4';
DECLARE @year int = 2026;                                   -- query เดิม: YEAR(...) = @year
DECLARE @dStart varchar(8) = CONCAT(@year, '0101');         -- query ใหม่: ช่วงวันที่เดียวกัน
DECLARE @dEnd   varchar(8) = CONCAT(@year + 1, '0101');

IF OBJECT_ID('tempdb..#old')   IS NOT NULL DROP TABLE #old;
IF OBJECT_ID('tempdb..#rt')    IS NOT NULL DROP TABLE #rt;
IF OBJECT_ID('tempdb..#box')   IS NOT NULL DROP TABLE #box;
IF OBJECT_ID('tempdb..#lots')  IS NOT NULL DROP TABLE #lots;
IF OBJECT_ID('tempdb..#pairs') IS NOT NULL DROP TABLE #pairs;
IF OBJECT_ID('tempdb..#seed')  IS NOT NULL DROP TABLE #seed;
IF OBJECT_ID('tempdb..#new')   IS NOT NULL DROP TABLE #new;

-- ==================================================================
-- ฝั่งเดิม: query จาก GCRTRpt (ใส่ schema แล้ว ตัด DateGrowPP/DateGrowSand) + กรอง "คงเหลือในคลัง"
-- ==================================================================
SELECT * INTO #old FROM (
  Select rDt.idCountRef, comp.CompCode, lm.idLot, ps.PsName As PsSale, wrtMt.DateWaitReturn, wrtMt.ReturnNo, rtdt.LotNoRT, p.PartnerName, inv.idInvMain, inv.idUnit, inv.InvName, rDt.idComp,
  ISNULL(CONCAT(Format(pk.Weight,'#,##0.##'), ' '+ uw.UnitName),'-') As WeightxUnit, inv.idInvGroup, rDt.SumVolumn As AmountRT, wh.idRefLot,
  -- ยอดคงเหลือ: ไม่นับของที่อยู่คลัง 5503 (ยอดรวมกล่อง = ไม่รวมแถว 5503 / ยอดของ idRefLot นี้ = 0 ถ้าอยู่ 5503)
  IIF(ISNULL((SELECT Sum(rw.Amount) FROM devsk.dInvLotRefWh rw Where rw.idBox = wh.idBox AND ISNULL(rw.idWh,0) <> 5503),0) = 0,
      IIF((SELECT IIF(ISNULL(rw.idWh,0) = 5503, 0, rw.Amount) FROM devsk.dInvLotRefWh rw Where rw.idRefLot = rDt.idRefLot) > rDt.Sumvolumn,
          rDt.Sumvolumn, (SELECT IIF(ISNULL(rw.idWh,0) = 5503, 0, rw.Amount) FROM devsk.dInvLotRefWh rw Where rw.idRefLot = rDt.idRefLot)),
      (SELECT Sum(rw.Amount) FROM devsk.dInvLotRefWh rw Where rw.idBox = wh.idBox AND ISNULL(rw.idWh,0) <> 5503)) As AmountRTBal,
  -- ค่าระหว่างทาง (ไว้เทียบกับ BoxSum / whAmount ของ query ใหม่)
  (SELECT Sum(rw.Amount) FROM devsk.dInvLotRefWh rw Where rw.idBox = wh.idBox AND ISNULL(rw.idWh,0) <> 5503) As BoxSum,
  (SELECT IIF(ISNULL(rw.idWh,0) = 5503, 0, rw.Amount) FROM devsk.dInvLotRefWh rw Where rw.idRefLot = rDt.idRefLot) As whAmount,
  u.UnitName, rDt.idPkPORec, rtdt.idSaleReturnDt, ISNULL(b.BoxNo, swh.WareHouseName) As BoxNo,
  CASE WHEN ISNULL(st.idSaleRtType,'') = '' THEN cause.ReturnCause ELSE st.SaleReturnType + ' (' + cause.ReturnCause + ')' END As ReturnCause, qt.Humid,
  rDt.SumVolumn, rDt.idLotMain,
  ISNULL(rtdt.RTPrice,0) As RTPrice, qt.GrowPaper, qt.GrowSand, qt.GrowAA, qt.GrowMedia, qt.Pure, qt.PureGene, qt.NoteConfirm,
  ISNULL(SUBSTRING(
      (SELECT ','+ inv.InvName  AS [text()]
       FROM devsk.dInvLotMain lm
       LEFT JOIN devsk.dWithdrawMt dMt ON lm.idPlan = dMt.idPlanMt
       LEFT JOIN devsk.dWithdrawDt dDt ON dMt.idWitdMt = dDt.idWitdMt
       LEFT JOIN devsk.dInventoryMain inv ON dDt.idInvMain = inv.idInvMain
       Where lm.idLot = rDt.idLotMain
       AND inv.idInvGroup = 1
       AND stCancel = 0
       Group By inv.InvName
       FOR XML PATH (''), TYPE
      ).value('text()[1]','nvarchar(max)'), 2, 2000),'-') [SeedNameUsed], b.BoxNo As BoxNoRT, swh.WareHouseName
  FROM devsk.vPkPORecReturn rDt
  LEFT JOIN dbo.SsWareHouse swh ON rDt.idWh = swh.idWh
  LEFT JOIN devsk.WimWaitRecDt wDt ON rDt.idWaitRecDt = wDt.idWaitRecDt
  LEFT JOIN devsk.WimWaitRecMt wMt ON wDt.idWaitRecMt = wMt.idWaitRecMt AND wMt.ProcessID = 3 AND wMt.stCancel Is NULL
  LEFT JOIN dbo.SmSaleReturnDt rtdt ON wDt.idDt = rtdt.idSaleReturnDt
  LEFT JOIN dbo.SmSaleReturnMt rtmt ON rtdt.idSaleReturn = rtmt.idSaleReturn
  LEFT JOIN devsk.WimWaitReturnDt wrtDt ON rtdt.idWaitReturnDt = wrtDt.idWaitReturnDt
  LEFT JOIN devsk.WimWaitReturnMt wrtMt ON wrtDt.idWaitReturn = wrtMt.idWaitReturn
  LEFT JOIN devsk.dPartner p ON rtmt.idPartner = p.idPartner
  LEFT JOIN devsk.dInventoryMain inv ON rDt.idInvMain = inv.idInvMain
  LEFT JOIN devsk.WimReturnBox b ON rDt.idBox = b.idBox
  LEFT JOIN devsk.dInvUnit u ON rDt.idUnitNew = u.idUnit
  LEFT JOIN devsk.vPersonxSelect ps ON rtmt.idPsSale = ps.idPs
  LEFT JOIN dbo.SmSaleReturnCause cause On wrtDt.idRtCause = cause.idRtCause
  LEFT JOIN devsk.SmSaleReturnType st ON cause.idSaleRtType = st.idSaleRtType
  LEFT JOIN dbo.dPackingPdSet pk ON inv.idSubType = pk.idPdPk AND inv.idInvGroup = 2
  LEFT JOIN devsk.dInvUnit uw ON pk.idUnitW = uw.idUnit
  LEFT JOIN devsk.dInvLotRefWh wh ON rDt.idRefLot = wh.idRefLot
  LEFT JOIN PchInvAndProject.dbo.dCompany As comp ON rDt.idComp = comp.idComp
  LEFT JOIN devsk.dInvLotQuality qt ON rtdt.idSaleReturnDt = qt.idLot AND qt.TypeReturn = 1
  LEFT JOIN devsk.dInvLotMain lm ON rDt.idLotMain = lm.idLot
  Where rtmt.idPsCancel Is NULL
    AND rDt.idComp = @idComp
    AND YEAR(wrtMt.DateWaitReturn) = @year
) As a
Where a.AmountRTBal > 0;

-- ==================================================================
-- ฝั่งใหม่: v2 (เหมือน salereturn-test.sql)
-- ==================================================================
SELECT rDt.idCountRef, comp.CompCode, lm.idLot, ps.PsName AS PsSale,
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

SELECT DISTINCT a.idLotMain
INTO #lots
FROM #rt a
WHERE a.idLotMain IS NOT NULL
  AND a.AmountRTBal > 0;

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
INTO #new
FROM #rt a
LEFT JOIN #seed s ON s.idLotMain = a.idLotMain
WHERE a.AmountRTBal > 0;

-- ==================================================================
-- เทียบผล
-- ==================================================================
-- ชุดที่ 1: จำนวนแถว
SELECT (SELECT COUNT(*) FROM #old) AS OldRows, (SELECT COUNT(*) FROM #new) AS NewRows;

-- ชุดที่ 2: มีในเดิม ไม่มีในใหม่
SELECT 'เฉพาะเดิม' AS Side, x.* FROM (
  SELECT idPkPORec, idCountRef, CompCode, idLot, PsSale, DateWaitReturn, ReturnNo, LotNoRT, PartnerName,
         idInvMain, InvName, WeightxUnit, AmountRT, idRefLot,
         CAST(BoxSum AS decimal(18,4)) AS BoxSum, CAST(whAmount AS decimal(18,4)) AS whAmount, CAST(AmountRTBal AS decimal(18,4)) AS AmountRTBal,
         UnitName, idSaleReturnDt, BoxNo, ReturnCause, Humid, idLotMain, RTPrice,
         GrowPaper, GrowSand, Pure, PureGene, SeedNameUsed, BoxNoRT, WareHouseName
  FROM #old
  EXCEPT
  SELECT idPkPORec, idCountRef, CompCode, idLot, PsSale, DateWaitReturn, ReturnNo, LotNoRT, PartnerName,
         idInvMain, InvName, WeightxUnit, AmountRT, idRefLot,
         CAST(BoxSum AS decimal(18,4)), CAST(whAmount AS decimal(18,4)), CAST(AmountRTBal AS decimal(18,4)),
         UnitName, idSaleReturnDt, BoxNo, ReturnCause, Humid, idLotMain, RTPrice,
         GrowPaper, GrowSand, Pure, PureGene, SeedNameUsed, BoxNoRT, WareHouseName
  FROM #new
) x ORDER BY x.idPkPORec;

-- ชุดที่ 3: มีในใหม่ ไม่มีในเดิม
SELECT 'เฉพาะใหม่' AS Side, x.* FROM (
  SELECT idPkPORec, idCountRef, CompCode, idLot, PsSale, DateWaitReturn, ReturnNo, LotNoRT, PartnerName,
         idInvMain, InvName, WeightxUnit, AmountRT, idRefLot,
         CAST(BoxSum AS decimal(18,4)) AS BoxSum, CAST(whAmount AS decimal(18,4)) AS whAmount, CAST(AmountRTBal AS decimal(18,4)) AS AmountRTBal,
         UnitName, idSaleReturnDt, BoxNo, ReturnCause, Humid, idLotMain, RTPrice,
         GrowPaper, GrowSand, Pure, PureGene, SeedNameUsed, BoxNoRT, WareHouseName
  FROM #new
  EXCEPT
  SELECT idPkPORec, idCountRef, CompCode, idLot, PsSale, DateWaitReturn, ReturnNo, LotNoRT, PartnerName,
         idInvMain, InvName, WeightxUnit, AmountRT, idRefLot,
         CAST(BoxSum AS decimal(18,4)), CAST(whAmount AS decimal(18,4)), CAST(AmountRTBal AS decimal(18,4)),
         UnitName, idSaleReturnDt, BoxNo, ReturnCause, Humid, idLotMain, RTPrice,
         GrowPaper, GrowSand, Pure, PureGene, SeedNameUsed, BoxNoRT, WareHouseName
  FROM #old
) x ORDER BY x.idPkPORec;

-- ชุดที่ 4: ยอดคงเหลือเทียบกันทีละแถว (ไว้ดูด้วยตา) — คอลัมน์ Match ต้องเป็น 'ตรง' ทุกแถว (เรียง 'ไม่ตรง' ขึ้นก่อน)
SELECT * FROM (
SELECT ISNULL(o.BoxNo, n.BoxNo) AS BoxNo, ISNULL(o.LotNoRT, n.LotNoRT) AS LotNoRT,
       ISNULL(o.idPkPORec, n.idPkPORec) AS idPkPORec, ISNULL(o.idRefLot, n.idRefLot) AS idRefLot,
       o.BoxSum      AS Old_BoxSum,      n.BoxSum      AS New_BoxSum,
       o.whAmount    AS Old_whAmount,    n.whAmount    AS New_whAmount,
       o.AmountRTBal AS Old_AmountRTBal, n.AmountRTBal AS New_AmountRTBal,
       IIF(    o.idPkPORec IS NOT NULL AND n.idPkPORec IS NOT NULL
           AND ISNULL(CAST(o.BoxSum AS decimal(18,4)), -1)      = ISNULL(n.BoxSum, -1)
           AND ISNULL(CAST(o.whAmount AS decimal(18,4)), -1)    = ISNULL(CAST(n.whAmount AS decimal(18,4)), -1)
           AND ISNULL(CAST(o.AmountRTBal AS decimal(18,4)), -1) = ISNULL(n.AmountRTBal, -1), N'ตรง', N'ไม่ตรง') AS Match
FROM #old o
FULL JOIN #new n ON n.idPkPORec = o.idPkPORec AND n.idSaleReturnDt = o.idSaleReturnDt
                AND ISNULL(n.idRefLot, -1) = ISNULL(o.idRefLot, -1)
) c
ORDER BY IIF(c.Match = N'ไม่ตรง', 0, 1), c.BoxNo;

DROP TABLE #old; DROP TABLE #rt; DROP TABLE #box; DROP TABLE #lots;
DROP TABLE #pairs; DROP TABLE #seed; DROP TABLE #new;
