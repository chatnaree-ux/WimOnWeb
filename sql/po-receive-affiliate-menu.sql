-- เพิ่มเมนู "รายงานรับเมล็ดจากบริษัทในเครือ" ใต้กลุ่ม รายงานสต๊อก (idMenu = 2)
-- รันครั้งเดียว แล้วไปกำหนดสิทธิ์ให้กลุ่มผู้ใช้ที่หน้า "กำหนดสิทธิ์การใช้งาน" (กลุ่มระบบเห็นทุกเมนูอยู่แล้ว)
IF NOT EXISTS (SELECT 1 FROM WIMWebMenu WHERE MenuCode = 'po_receive_affiliate')
BEGIN
  INSERT INTO WIMWebMenu (MenuCode, MenuName, MenuUrl, idParentMenu, SortOrder)
  VALUES ('po_receive_affiliate', N'รายงานรับเมล็ดจากบริษัทในเครือ', '/po-receive-affiliate.html', 2, 26);
END

SELECT * FROM WIMWebMenu WHERE MenuCode = 'po_receive_affiliate';
