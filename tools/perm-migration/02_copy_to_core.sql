-- ขั้นที่ 2: คัดลอกเมนู/กลุ่ม/สมาชิก/สิทธิ์ เข้า CoreCenter ในระบบ WEB_WIM
-- เพิ่มข้อมูลอย่างเดียว ไม่แก้และไม่ลบแถวของระบบอื่น ถ้ามี WEB_WIM อยู่แล้วจะหยุด
-- ทำทั้งหมดใน transaction เดียว และยกเลิกทั้งหมดถ้าแถวของระบบอื่นเปลี่ยน
USE GR_Group;
SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @Sys varchar(255) = 'WEB_WIM';

-- กลุ่มเมนูกลาง: ชื่อกลุ่มดึงจากแถวหัวข้อใน WIMWebMenu
DECLARE @Groups TABLE (GroupCode varchar(255) PRIMARY KEY, idMenu int NOT NULL, OrderNo int NOT NULL);
INSERT INTO @Groups (GroupCode, idMenu, OrderNo) VALUES
  ('WMSeed', 1, 1),
  ('WMReq', 27, 2),
  ('WMOps', 24, 3),
  ('WMRts', 23, 4),
  ('WMCnt', 29, 5),
  ('WMRcv', 14, 6),
  ('WMStk', 15, 7),
  ('WMSys', 3, 8);

-- รหัสกลาง -> รหัสที่โค้ดใช้ (compare-perms.js อ่านรายการนี้จากไฟล์นี้)
DECLARE @Menus TABLE (CoreCode varchar(255) PRIMARY KEY, AppCode varchar(50) NOT NULL UNIQUE);
INSERT INTO @Menus (CoreCode, AppCode) VALUES
  ('WMSeed001', 'coating'),
  ('WMSeed002', 'moisture'),
  ('WMReq001', 'urs_request'),
  ('WMOps001', 'over_po_sale'),
  ('WMOps002', 'over_po_sale_mailto'),
  ('WMOps003', 'over_po_sale_buy'),
  ('WMRts001', 'supplier_return'),
  ('WMRts002', 'supplier_return_cause'),
  ('WMRts003', 'supplier_return_cancel'),
  ('WMRts004', 'supplier_return_ack'),
  ('WMRts005', 'supplier_return_check'),
  ('WMRts006', 'supplier_return_approve'),
  ('WMCnt001', 'stock_count'),
  ('WMCnt002', 'stock_count_review'),
  ('WMCnt003', 'stock_count_cancel'),
  ('WMCnt004', 'stock_count_setup'),
  ('WMCnt005', 'stock_adjust_check'),
  ('WMCnt006', 'stock_adjust_ack'),
  ('WMCnt007', 'stock_adjust_approve'),
  ('WMCnt008', 'stock_adjust_track'),
  ('WMCnt009', 'stock_adjust_reverse'),
  ('WMRcv001', 'stock_return'),
  ('WMRcv002', 'po_receive_affiliate'),
  ('WMStk001', 'stockcard_lot'),
  ('WMStk002', 'stockcard_item'),
  ('WMStk003', 'stock_adjust_report'),
  ('WMSys001', 'menu_permission');

DECLARE @GroupMap TABLE (idGroup int PRIMARY KEY, idUser int NOT NULL);
DECLARE @OtherBefore bigint, @OtherAfter bigint;

BEGIN TRY
  BEGIN TRANSACTION;

  IF EXISTS (SELECT 1 FROM CoreCenter.dbo.dSystem WHERE SysName = @Sys)
    OR EXISTS (SELECT 1 FROM CoreCenter.dbo.MenuData WHERE MenuSys = @Sys OR MenuCode LIKE 'WM%')
    OR EXISTS (SELECT 1 FROM CoreCenter.dbo.MenuUser WHERE MenuSys = @Sys)
    OR EXISTS (SELECT 1 FROM CoreCenter.dbo.dSystemMenuGroup WHERE SysName = @Sys OR MenuGroupCode LIKE 'WM%')
    THROW 50001, 'WEB_WIM or a WM menu code already exists. Nothing was copied.', 1;

  IF EXISTS (
    SELECT 1 FROM devsk.WIMWebMenu w
    WHERE w.stDel IS NULL
      AND NOT EXISTS (SELECT 1 FROM devsk.WIMWebMenu c WHERE c.idParentMenu = w.idMenu AND c.stDel IS NULL)
      AND NOT EXISTS (SELECT 1 FROM @Menus m WHERE m.AppCode = w.MenuCode)
  ) THROW 50002, 'An active menu has no core code in @Menus. Nothing was copied.', 1;

  SELECT @OtherBefore =
      (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.dSystem)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.dSystemMenuGroup)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuData)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUser)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserPs)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserSet)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserPsComp);

  INSERT INTO CoreCenter.dbo.dSystem (SysName, Description, stDel, created_at)
  VALUES (@Sys, N'ระบบบริหารสินค้าคงคลัง', 0, GETDATE());

  INSERT INTO CoreCenter.dbo.dSystemMenuGroup (SysName, MenuGroupCode, MenuGroupName, OrderbyMenu)
  SELECT @Sys, g.GroupCode, w.MenuName, g.OrderNo
  FROM @Groups g
  JOIN devsk.WIMWebMenu w ON w.idMenu = g.idMenu;

  INSERT INTO CoreCenter.dbo.MenuData (MenuCode, MenuName, MenuSys, MenuParents, MenuLink)
  SELECT m.CoreCode, w.MenuName, @Sys, dg.idMenuMain, w.MenuUrl
  FROM @Menus m
  JOIN devsk.WIMWebMenu w ON w.MenuCode = m.AppCode AND w.stDel IS NULL
  JOIN CoreCenter.dbo.dSystemMenuGroup dg
    ON dg.SysName = @Sys AND dg.MenuGroupCode = LEFT(m.CoreCode, LEN(m.CoreCode) - 3);

  UPDATE w SET w.CoreMenuCode = m.CoreCode
  FROM devsk.WIMWebMenu w
  JOIN @Menus m ON m.AppCode = w.MenuCode
  WHERE w.stDel IS NULL;

  -- MERGE เพื่อเก็บคู่ idGroup เดิม -> idUser ใหม่ (INSERT ... OUTPUT อ้างคอลัมน์ต้นทางไม่ได้)
  MERGE CoreCenter.dbo.MenuUser AS t
  USING (SELECT idGroup, GroupName, stSystem FROM devsk.WIMWebUserGroup WHERE stDel IS NULL) AS s
  ON 1 = 0
  WHEN NOT MATCHED THEN
    INSERT (UserName, MenuSys, Note)
    VALUES (s.GroupName, @Sys, CASE WHEN s.stSystem = 1 THEN N'ได้สิทธิ์ทุกเมนูทุกบริษัท' END)
  OUTPUT s.idGroup, inserted.idUser INTO @GroupMap (idGroup, idUser);

  UPDATE g SET g.idUser = m.idUser
  FROM devsk.WIMWebUserGroup g JOIN @GroupMap m ON m.idGroup = g.idGroup;

  UPDATE p SET p.idUser = m.idUser
  FROM devsk.WIMWebGroupCompPer p JOIN @GroupMap m ON m.idGroup = p.idGroup;

  INSERT INTO devsk.WIMWebGroupSet (idUser, stSystem)
  SELECT m.idUser, ISNULL(g.stSystem, 0)
  FROM @GroupMap m JOIN devsk.WIMWebUserGroup g ON g.idGroup = m.idGroup;

  INSERT INTO CoreCenter.dbo.MenuUserPs (idUser, idPs)
  SELECT DISTINCT m.idUser, u.idPs
  FROM devsk.WIMWebUserGroupMember u
  JOIN @GroupMap m ON m.idGroup = u.idGroup
  WHERE u.stDel IS NULL;

  INSERT INTO CoreCenter.dbo.MenuUserSet (idUser, MenuCode)
  SELECT DISTINCT m.idUser, w.CoreMenuCode
  FROM devsk.WIMWebMenuPermission p
  JOIN @GroupMap m ON m.idGroup = p.idGroup
  JOIN devsk.WIMWebMenu w ON w.idMenu = p.idMenu AND w.stDel IS NULL
  WHERE p.stAllow = 1 AND p.stDel IS NULL AND w.CoreMenuCode IS NOT NULL;

  -- สิทธิ์บริษัทกลางเป็นรายคน: กระจายชุดของกลุ่มให้สมาชิกทุกคน (บริษัทที่ยังใช้งานเท่านั้น)
  INSERT INTO CoreCenter.dbo.MenuUserPsComp (idUser, idPs, idComp)
  SELECT DISTINCT m.idUser, u.idPs, p.idComp
  FROM devsk.WIMWebGroupCompPer p
  JOIN @GroupMap m ON m.idGroup = p.idGroup
  JOIN devsk.WIMWebUserGroupMember u ON u.idGroup = p.idGroup AND u.stDel IS NULL
  JOIN PchInvAndProject.dbo.dCompany c ON c.idComp = p.idComp AND c.stDel IS NULL AND c.CompName IS NOT NULL
  WHERE p.stAllow = 1 AND p.stDel IS NULL;

  -- จำนวนแถวรวมต้องเท่าเดิม + แถวของ WEB_WIM ที่เพิ่งเพิ่ม
  SELECT @OtherAfter =
      (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.dSystem WHERE SysName <> @Sys OR SysName IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.dSystemMenuGroup WHERE SysName <> @Sys OR SysName IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuData WHERE MenuSys <> @Sys OR MenuSys IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUser WHERE MenuSys <> @Sys OR MenuSys IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserPs WHERE idUser NOT IN (SELECT idUser FROM @GroupMap) OR idUser IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserSet WHERE idUser NOT IN (SELECT idUser FROM @GroupMap) OR idUser IS NULL)
    + (SELECT COUNT_BIG(*) FROM CoreCenter.dbo.MenuUserPsComp WHERE idUser NOT IN (SELECT idUser FROM @GroupMap) OR idUser IS NULL);

  IF @OtherBefore <> @OtherAfter
    THROW 50003, 'Row counts of other systems changed. Everything was rolled back.', 1;

  COMMIT TRANSACTION;

  SELECT
    (SELECT COUNT(*) FROM CoreCenter.dbo.dSystemMenuGroup WHERE SysName = @Sys) AS MenuGroups,
    (SELECT COUNT(*) FROM CoreCenter.dbo.MenuData WHERE MenuSys = @Sys) AS Menus,
    (SELECT COUNT(*) FROM CoreCenter.dbo.MenuUser WHERE MenuSys = @Sys) AS UserGroups,
    (SELECT COUNT(*) FROM CoreCenter.dbo.MenuUserPs WHERE idUser IN (SELECT idUser FROM @GroupMap)) AS Members,
    (SELECT COUNT(*) FROM CoreCenter.dbo.MenuUserSet WHERE idUser IN (SELECT idUser FROM @GroupMap)) AS MenuPerms,
    (SELECT COUNT(*) FROM CoreCenter.dbo.MenuUserPsComp WHERE idUser IN (SELECT idUser FROM @GroupMap)) AS CompPerms;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
