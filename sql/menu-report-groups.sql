-- ==================================================================
-- จัดกลุ่มเมนูรายงานเป็น 3 ชั้น
--   รายงาน (stock_report, idMenu = 2)
--     ├─ รายงานสต๊อก        (report_stock)   → Stock Card (รายล็อต), Stock Card (รายสินค้า)
--     └─ รายงานการรับสินค้า  (report_receive) → รายงานรับเมล็ดจากบริษัทในเครือ, รายงานสินค้ารับคืน
--
-- - กลุ่มย่อย (ชั้น 2) ไม่ต้องให้สิทธิ์ — สิทธิ์ยังผูกกับเมนูปลายทาง (MenuCode เดิม) เหมือนเดิม
-- - ลำดับ: SortOrder (ทั้งกลุ่มย่อยและเมนู) — แก้ตัวเลขแล้ว sidebar / หน้า Home เรียงตาม (server cache 1 นาที)
-- - รันซ้ำได้ (เช็คก่อน INSERT)
-- ==================================================================
BEGIN TRAN;

-- 1) เปลี่ยนชื่อกลุ่มใหญ่
UPDATE WIMWebMenu SET MenuName = N'รายงาน' WHERE MenuCode = 'stock_report';

DECLARE @idReport int = (SELECT idMenu FROM WIMWebMenu WHERE MenuCode = 'stock_report');

-- 2) กลุ่มย่อยชั้นที่ 2 (ลำดับตามที่จัดไว้ใน DB ตอนนี้: รายงานการรับสินค้า 21–22 ก่อน รายงานสต๊อก 23–24)
IF NOT EXISTS (SELECT 1 FROM WIMWebMenu WHERE MenuCode = 'report_receive')
  INSERT INTO WIMWebMenu (MenuCode, MenuName, MenuUrl, idParentMenu, SortOrder)
  VALUES ('report_receive', N'รายงานการรับสินค้า', NULL, @idReport, 21);

IF NOT EXISTS (SELECT 1 FROM WIMWebMenu WHERE MenuCode = 'report_stock')
  INSERT INTO WIMWebMenu (MenuCode, MenuName, MenuUrl, idParentMenu, SortOrder)
  VALUES ('report_stock', N'รายงานสต๊อก', NULL, @idReport, 23);

DECLARE @idStock int   = (SELECT idMenu FROM WIMWebMenu WHERE MenuCode = 'report_stock');
DECLARE @idReceive int = (SELECT idMenu FROM WIMWebMenu WHERE MenuCode = 'report_receive');

-- 3) ย้ายเมนูไปอยู่ใต้กลุ่มย่อย (ชั้นที่ 3) — คง SortOrder เดิมของแต่ละเมนูไว้
UPDATE WIMWebMenu SET idParentMenu = @idReceive WHERE MenuCode IN ('po_receive_affiliate', 'stock_return');
UPDATE WIMWebMenu SET idParentMenu = @idStock   WHERE MenuCode IN ('stockcard_lot', 'stockcard_item');
UPDATE WIMWebMenu SET idParentMenu = @idStock   WHERE MenuCode IN ('stock_report_onhand', 'stock_movement'); -- เมนูที่ปิดไว้ (stDel) ย้ายตามกลุ่ม

COMMIT;

-- ตรวจผล
SELECT m.idMenu, m.MenuCode, m.MenuName, m.idParentMenu, p.MenuName AS ParentName, m.SortOrder, m.stDel
FROM WIMWebMenu m
LEFT JOIN WIMWebMenu p ON p.idMenu = m.idParentMenu
ORDER BY m.SortOrder, m.idMenu;
