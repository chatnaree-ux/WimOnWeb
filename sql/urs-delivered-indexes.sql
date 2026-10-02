-- Index สำหรับคิวรี่ยอดจัดส่งแล้ว (applyUrsDelivered ใน server.js) ของแท็บรายการร้องขอเมล็ดพันธุ์เร่งด่วน
-- ให้ DBA ตรวจก่อนรัน: เช็คว่ามี index ที่ครอบคอลัมน์เหล่านี้อยู่แล้วหรือไม่ (sp_helpindex) และรันนอกเวลางาน
-- คิวรี่ที่ใช้:
--   FROM devsk.PKPORecDt dt LEFT JOIN devsk.PkPORecMt mt ON dt.idPkPoRec = mt.idPkPoRec
--   WHERE dt.idInvMain IN (...) AND mt.idComp = @idComp AND mt.idPsCancel IS NULL AND mt.DateRec >= @fromDate

-- ตรวจ index เดิม
-- EXEC sp_helpindex 'devsk.PKPORecDt';
-- EXEC sp_helpindex 'devsk.PkPORecMt';

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PKPORecDt_idInvMain' AND object_id = OBJECT_ID('devsk.PKPORecDt'))
  CREATE NONCLUSTERED INDEX IX_PKPORecDt_idInvMain
    ON devsk.PKPORecDt (idInvMain, idPkPoRec)
    INCLUDE (idUnitNew, AmountRec);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PkPORecMt_idComp_DateRec' AND object_id = OBJECT_ID('devsk.PkPORecMt'))
  CREATE NONCLUSTERED INDEX IX_PkPORecMt_idComp_DateRec
    ON devsk.PkPORecMt (idComp, DateRec)
    INCLUDE (idPkPoRec, idPsCancel);
GO
