// ข้อมูลจำลองสำหรับ /api/* ตอนทดสอบหน้าจอ (ไม่ต่อฐานข้อมูล) — เพิ่มเคสได้ตามต้องการ
const comp = [{ idComp: 4, CompName: 'บริษัท แอ๊ดว้านซ์ซีดส์ จำกัด', CompCode: 'AV' }];
module.exports = function (url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.includes('/permissions/my')) return { success: true, unrestricted: true, allowedMenuCodes: [], wipMenuCodes: [] };
  if (p.includes('/auth/me')) return { success: true, user: { idPs: 1, PsName: 'ทดสอบ' } };
  if (p === '/api/urs/companies') return { success: true, data: [{ id: 4, name: comp[0].CompName, allowed: true }] };
  if (p === '/api/urs/requests') return { success: true, data: [1, 2].map(i => ({ idUrs: i, DocReq: 'URQ6910/000' + i, DateReq: '2026-10-20', stReq: '1', idCompTarget: 3, CompNameTarget: 'บริษัท กรีนซีดส์ จำกัด', InvName: 'เมล็ดพันธุ์ แตงกวายาว CM-736', SeedName: 'แตงกวา', AmtStockAV: 10, AmtStockGR: 5, AmtStockFL: 2, AmountReq: 20, UnitName: 'กก.', PsNameReq: 'ทดสอบ', AmtDelivered: 0, AmtRemain: 20, DateNeed: '2026-10-25' })) };
  if (p === '/api/cut-stock-report/meta') return { success: true, companies: [{ id: 4, code: 'AV', name: comp[0].CompName }], processes: [{ id: 5, name: 'การเบิกเพื่อผลิตสินค้า', defaultOn: true }, { id: 4, name: 'การขายสินค้า', defaultOn: true }, { id: 9, name: 'การโอนย้ายคลังออก', defaultOn: false }], canSetup: true };
  if (p === '/api/cut-stock-report/data') {
    const items = ['ข้าวโพดหวาน SUN-15', 'แตงกวา C-729', 'ถั่วฝักยาว OP-BLB-20', 'ฟักทองบัตเตอร์นัท EV-38'].map((n, i) => ({ id: i + 1, code: 'S' + i, name: 'เมล็ดพันธุ์ ' + n, unit: 'กก.', unitId: 2, group: 1, type: '', tab: 'seed', v: Array.from({ length: 60 }, (_, k) => (k % 12 < 8 ? Math.round(((k * 37 + i * 11) % 90) * 10) / 10 : 0)) }));
    return { success: true, year: 2026, tab: 'seed', items, procs: [{ p: 5, u: 2, amt: 900 }, { p: 4, u: 2, amt: 300 }] };
  }
  if (p === '/api/companies') return { success: true, data: comp };
  if (p.includes('/supplier-return/meta')) return { success: true, types: [{ id: 3, code: 'NR', name: 'ไม่ส่งคืน - ลดหนี้', short: 'ลดหนี้', credit: true, returnGoods: false }], causes: [], canCancel: true, canManageCause: true, canEdit: true, canAck: true, canCheck: true, canApprove: true, me: 1, companies: [{ id: 4, name: comp[0].CompName }] };
  if (p.includes('/supplier-return/list') || p.includes('/supplier-return/pending')) {
    const item = { po: 'O69/09/0001', rec: 'R69/09/0003', inv: 'INV1', name: 'กะเพรา นิโลบล V - 2563 10 กรัม/ซอง', reason: 'Purity ไม่ผ่าน', lot: 'ETC-01-690922', store: 'คลัง A', qty: 200, unit: 'ซอง', cost: 4.0182, price: 3 };
    return { success: true, data: [1, 2].map(i => ({ id: i, docNo: 'RTS6910/003' + i, docDate: '2026-10-16', returnDate: '2026-10-16', status: i, type: 3, compName: comp[0].CompName, compCode: 'AV', supName: 'P.K.S 2000', remark: '', items: [item], steps: {}, cancel: null })) };
  }
  if (p.includes('/coating/list') || p.includes('/moisture/list')) {
    const r = { idRm: 1, DocCode: 'CT6910/0004', DateDoc: '2026-10-10', DateReq: '2026-10-12', SeedName: 'แตงกวา', Note: 'เคลือบสี + เช็คคุณภาพ + เก็บเมล็ดเพื่อติดตาม 50 กรัม', StrMC: 'CT', WBefore: 39.95, WAfter: 40.2, UnitName: 'กิโลกรัม', DateRm: '2026-10-12', DateRmStart: '2026-10-12T08:00:00', DateRmEnd: '2026-10-12T11:30:00' };
    return { success: true, data: [r, { ...r, idRm: 2, DocCode: 'CT6910/0005' }] };
  }
  if (p.includes('/stockcard')) return { success: true, data: [
    { date: '2026-10-16 16:26:46', detail: 'เอกสารรับ 68/14344 - WIM: รับสินค้าเข้าคลัง, หมายเหตุ: เมล็ดตัวอย่าง', warehouse: 'G78', inQty: 0.02, outQty: 0, unit: 'กิโลกรัม', user: 'ปรียานุช จันทร์เขียว (กิ๊ฟ)', lotNo: '683-001-00000' },
    { date: '2026-11-25 16:35:09', detail: 'เอกสารเบิก CS68/30168 - SAM: การขายสินค้า 110 6811035', warehouse: 'G78', inQty: 0, outQty: 0.01, unit: 'กิโลกรัม', user: 'Auto System', lotNo: '683-001-00000' }] };
  return { success: true, data: [], rows: [], items: [], list: [] };
};
