-- ยกเลิกการคัดลอก: ลบเฉพาะข้อมูลของ WEB_WIM ใน CoreCenter และล้างค่าที่เชื่อมฝั่ง GR_Group
-- ตารางสิทธิ์เดิมฝั่งเราไม่ถูกแตะ — ใช้เมื่อเว็บยังอ่านสิทธิ์จากตารางเดิมเท่านั้น
-- สิทธิ์ที่แก้ใน WEB_WIM หลังคัดลอกจะหายไปด้วย
USE GR_Group;
SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @Sys varchar(255) = 'WEB_WIM';
DECLARE @Users TABLE (idUser int PRIMARY KEY);
DECLARE @OtherBefore bigint, @OtherAfter bigint;

BEGIN TRY
  BEGIN TRANSACTION;

  INSERT INTO @Users (idUser) SELECT idUser FROM CoreCenter.dbo.MenuUser WHERE MenuSys = @Sys;

  SELECT @OtherBefore =
      (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.dSystem WHERE SysName <> @Sys OR SysName IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.dSystemMenuGroup WHERE SysName <> @Sys OR SysName IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuData WHERE MenuSys <> @Sys OR MenuSys IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUser WHERE MenuSys <> @Sys OR MenuSys IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserPs WHERE idUser NOT IN (SELECT idUser FROM @Users) OR idUser IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserSet WHERE idUser NOT IN (SELECT idUser FROM @Users) OR idUser IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserPsComp WHERE idUser NOT IN (SELECT idUser FROM @Users) OR idUser IS NULL);

  DELETE FROM CoreCenter.dbo.MenuUserPsComp WHERE idUser IN (SELECT idUser FROM @Users);
  DELETE FROM CoreCenter.dbo.MenuUserSet WHERE idUser IN (SELECT idUser FROM @Users);
  DELETE FROM CoreCenter.dbo.MenuUserPs WHERE idUser IN (SELECT idUser FROM @Users);
  DELETE FROM CoreCenter.dbo.MenuUser WHERE MenuSys = @Sys;
  DELETE FROM CoreCenter.dbo.MenuData WHERE MenuSys = @Sys;
  DELETE FROM CoreCenter.dbo.dSystemMenuGroup WHERE SysName = @Sys;
  DELETE FROM CoreCenter.dbo.dSystem WHERE SysName = @Sys;

  SELECT @OtherAfter =
      (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.dSystem)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.dSystemMenuGroup)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuData)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUser)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserPs)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserSet)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserPsComp);

  IF @OtherBefore <> @OtherAfter
    THROW 50003, 'Row counts of other systems changed. Everything was rolled back.', 1;

  UPDATE devsk.WIMWebMenu SET CoreMenuCode = NULL;
  UPDATE devsk.WIMWebUserGroup SET idUser = NULL;
  UPDATE devsk.WIMWebGroupCompPer SET idUser = NULL;
  DELETE FROM devsk.WIMWebGroupSet;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
