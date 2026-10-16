// รายการเมนูทั้งหมดของระบบ (ใช้สร้างหน้า Home + ช่องค้นหาเมนู Ctrl+K)
// code = MenuCode ใน WIMWebMenu (ใช้เช็คสิทธิ์) / เพิ่มเมนูใหม่ที่นี่ที่เดียว หน้า Home จะแสดงให้เองตามสิทธิ์
(function () {
  const icon = {
    seed: '<path d="M12 2c-4 3-7 6-7 10a7 7 0 0 0 14 0c0-4-3-7-7-10z"></path><path d="M12 22v-9"></path>',
    drop: '<path d="M12 2.7l5.7 5.6a8 8 0 1 1-11.4 0z"></path><path d="M8 14a4 4 0 0 0 4 4"></path>',
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>',
    lot: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="M8 4v16"></path>',
    box: '<rect x="3" y="7" width="18" height="14" rx="2"></rect><path d="M3 7l9-4 9 4"></path>',
    returnBox: '<polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>',
    truck: '<rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-4"></path>',
    book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"></path><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"></path>'
  };

  window.WIM_ICONS = icon;

  window.WIM_MENUS = [
    { code: 'supplier_return', group: 'คลังวัสดุและสินค้า · ส่งคืนสินค้า/ลดหนี้ Supplier', title: 'รายการส่งคืนสินค้า/ลดหนี้ Supplier', desc: 'ส่งคืนสินค้า (RTS) / ลดหนี้ Supplier พร้อมขั้นตอนรับทราบ-ตรวจสอบ-อนุมัติ', href: '/supplier-return', icon: 'returnBox', keywords: 'supplier return rts purchase return ส่งคืน คืนสินค้า ลดหนี้ ทดแทน credit note po' },
    { code: 'supplier_return_ack', group: 'คลังวัสดุและสินค้า · ส่งคืนสินค้า/ลดหนี้ Supplier', title: 'รับทราบเอกสารส่งคืนสินค้า Supplier', desc: 'รับทราบเอกสารส่งคืนสินค้า / ลดหนี้ Supplier หรือส่งกลับแก้ไข', href: '/supplier-return-approve?step=ack', icon: 'book', keywords: 'supplier return rts รับทราบ ส่งคืน ลดหนี้ acknowledge' },
    { code: 'supplier_return_check', group: 'คลังวัสดุและสินค้า · ส่งคืนสินค้า/ลดหนี้ Supplier', title: 'ตรวจสอบเอกสารส่งคืนสินค้า Supplier', desc: 'ตรวจสอบ 1 / ตรวจสอบ 2 เอกสารส่งคืนสินค้า หรือส่งกลับแก้ไข', href: '/supplier-return-approve?step=check', icon: 'lot', keywords: 'supplier return rts ตรวจสอบ ส่งคืน ลดหนี้ check review' },
    { code: 'supplier_return_approve', group: 'คลังวัสดุและสินค้า · ส่งคืนสินค้า/ลดหนี้ Supplier', title: 'อนุมัติเอกสารส่งคืนสินค้า Supplier', desc: 'อนุมัติเอกสารส่งคืนสินค้า — ปลดให้คลังเบิก / หักยอดรับ PO', href: '/supplier-return-approve?step=approve', icon: 'shield', keywords: 'supplier return rts อนุมัติ ส่งคืน ลดหนี้ approve' },
    { code: 'coating', group: 'การจัดการเมล็ดพันธุ์', title: 'การลงเวลาเคลือบเมล็ด', desc: 'ลงเวลาเริ่ม / สิ้นสุดการเคลือบเมล็ด', href: '/coating', icon: 'seed', keywords: 'coating เคลือบ' },
    { code: 'moisture', group: 'การจัดการเมล็ดพันธุ์', title: 'การลงเวลาลดความชื้น', desc: 'ลงเวลาเข้า-ออกห้องลดความชื้น พร้อมค่าความชื้น', href: '/moisture', icon: 'drop', keywords: 'moisture ความชื้น อบ ห้อง' },
    { code: 'urs_request', group: 'การจัดการเมล็ดพันธุ์', title: 'ร้องขอเมล็ดพันธุ์เร่งด่วน', desc: 'สร้าง ส่ง และติดตามคำร้องขอเมล็ดพันธุ์', href: '/urs-request', icon: 'bolt', keywords: 'urs urgent ร้องขอ ด่วน คำร้อง' },
    { code: 'stockcard_lot', group: 'รายงาน · รายงานสต๊อก', title: 'Stock Card (รายล็อต)', desc: 'ประวัติการเคลื่อนไหวเฉพาะ Lot No. ที่ระบุ', href: '/stockcard', icon: 'lot', keywords: 'stock card lot ล็อต สต๊อก' },
    { code: 'stockcard_item', group: 'รายงาน · รายงานสต๊อก', title: 'Stock Card (รายสินค้า)', desc: 'ภาพรวมการเคลื่อนไหวของสินค้า รวมทุก Lot', href: '/stockcard-item', icon: 'box', keywords: 'stock card item สินค้า สต๊อก' },
    { code: 'stock_return', group: 'รายงาน · รายงานการรับสินค้า', title: 'รายงานสินค้ารับคืน', desc: 'รายการรับคืนสินค้า Lot รับคืน และยอดคงเหลือในคลัง', href: '/stockreturn', icon: 'returnBox', keywords: 'return sale return รับคืน คืนสินค้า lot สต๊อก' },
    { code: 'po_receive_affiliate', group: 'รายงาน · รายงานการรับสินค้า', title: 'รายงานรับเมล็ดจากบริษัทในเครือ', desc: 'ติดตาม PO ว่ารับแล้วกี่ครั้ง ครั้งละเท่าไหร่ และยอด PO คงเหลือ', href: '/po-receive-affiliate', icon: 'truck', keywords: 'po purchase receive รับ เมล็ดพันธุ์ บริษัทในเครือ ใบสั่งซื้อ คงเหลือ' },
    { code: 'menu_permission', group: 'ระบบ', title: 'กำหนดสิทธิ์การใช้งาน', desc: 'จัดกลุ่มผู้ใช้ กำหนดสิทธิ์เมนูและบริษัท', href: '/permissions', icon: 'shield', keywords: 'permission สิทธิ์ กลุ่ม ผู้ใช้' },
    // คู่มือ: code = MenuCode ของเมนูที่อธิบาย (เห็นตามสิทธิ์เมนูนั้น)
    { code: 'urs_request', group: 'คู่มือการใช้งาน', title: 'คู่มือ: ร้องขอเมล็ดพันธุ์เร่งด่วน', desc: 'ขั้นตอนสร้าง ส่ง ติดตาม และตอบกลับคำร้อง', href: '/manual-urs-request', icon: 'book', keywords: 'manual help คู่มือ วิธีใช้ urs ร้องขอ ด่วน ตอบกลับ' }
  ];
})();
