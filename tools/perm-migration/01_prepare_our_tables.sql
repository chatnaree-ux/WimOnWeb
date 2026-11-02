-- ขั้นที่ 1: เพิ่มคอลัมน์/ตารางฝั่ง GR_Group สำหรับย้ายสิทธิ์ไป CoreCenter (WEB_WIM)
-- ไม่ลบข้อมูลเดิม รันซ้ำได้ — รันบน GR_Group ก่อน 02_copy_to_core.sql
USE GR_Group;
GO

IF COL_LENGTH('devsk.WIMWebMenu', 'CoreMenuCode') IS NULL
  ALTER TABLE devsk.WIMWebMenu ADD CoreMenuCode varchar(255) NULL;
GO

IF OBJECT_ID('devsk.WIMWebGroupSet') IS NULL
  CREATE TABLE devsk.WIMWebGroupSet (
    idUser   int NOT NULL PRIMARY KEY,   -- CoreCenter.dbo.MenuUser.idUser
    stSystem bit NOT NULL DEFAULT (0)    -- 1 = ได้สิทธิ์ทุกเมนูทุกบริษัท
  );
GO

IF COL_LENGTH('devsk.WIMWebGroupCompPer', 'idUser') IS NULL
  ALTER TABLE devsk.WIMWebGroupCompPer ADD idUser int NULL;
GO

IF COL_LENGTH('devsk.WIMWebUserGroup', 'idUser') IS NULL
  ALTER TABLE devsk.WIMWebUserGroup ADD idUser int NULL;
GO

IF COL_LENGTH('devsk.WIMWebPermLog', 'idUser') IS NULL
  ALTER TABLE devsk.WIMWebPermLog ADD idUser int NULL, idUserOld int NULL;
GO
