/* ==================================================================
   wim-excel.js — มาตรฐานไฟล์ Excel ที่ export จากทุกหน้า (ใช้ ExcelJS โหลดจาก cdnjs เมื่อกด export ครั้งแรก)

   รูปแบบ (ตามที่อนุมัติจากรายงานสถิติการเบิกสินค้า/วัสดุ):
     แถว 1  แถบชื่อรายงาน (พื้นกรมท่า ตัวขาวหนา)
     แถว 2  แถบรอง: ชื่อภาษาอังกฤษ · Export Date · Export By (ขีดล่างสีอำพัน)
     แถว 3+ กรอบเงื่อนไข: ช่องป้ายพื้นฟ้าอ่อนตัวหนา + ช่องค่าพื้นขาว (จับคู่ 1–3 ชุดต่อแถว · ค่ายาวใส่ 'full' ได้แถวเต็ม)
     ตาราง  หัวตารางมีสี/กรอบ · ตรึงหัว · filter · ตัวเลขมีคอมม่า · แถวรวมตัวหนา
     ชีต "เงื่อนไขรายงาน" (ไม่บังคับ): เงื่อนไขแบบเต็ม + Export Date/By + หมายเหตุ

   ใช้:
     await WIMExcel.download({
       filename: 'stockcard_xxx.xlsx',
       title: 'Stock Card', titleEn: 'STOCK CARD',
       info: [['ล็อต', 'L001'], ['สินค้า', '...'], ['บริษัท', '...', 'full']],     // [ป้าย, ค่า, 'full'?]
       sheets: [{ name: 'Stock Card', head: ['วันที่', ...], body: [[...]], foot: [[...]],
                  widths: [12, 40], fmts: { 3: '#,##0.00' }, align: { 1: 'left' }, freezeCols: 0, title: '(ชื่อหัวชีต ถ้าต่างจากรายงาน)', info: [...] }],
       conditions: [['บริษัท', '...ยาว...']],   // ถ้าใส่ จะเพิ่มชีต "เงื่อนไขรายงาน"
       notes: ['หมายเหตุ ...']
     });
   หมายเหตุ: ห้ามใช้กับ "ใบนับ" ของ stock-count (ไฟล์เทมเพลตที่นำกลับเข้าระบบตามตำแหน่งเซลล์ — ห้ามเปลี่ยนโครงสร้าง)
   ================================================================== */
(function(){
  'use strict';
  const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  const NAVY = 'FF14233A', NAVY2 = 'FF1D2F4A', AMBER = 'FFF2A91C', LBL = 'FFE8EEF6', HEAD = 'FFD5DEEA', FOOT = 'FFE8EEF6';
  const FONT = { name: 'Tahoma', size: 10 };
  const thin = { style: 'thin', color: { argb: 'FFBBBBBB' } }, BD = { top: thin, left: thin, bottom: thin, right: thin };
  const solid = (c) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });

  let loading = null;
  function loadLib(){
    if (window.ExcelJS) return Promise.resolve();
    return loading || (loading = new Promise((ok, no) => { const s = document.createElement('script'); s.src = EXCELJS_URL; s.onload = ok; s.onerror = () => { loading = null; no(new Error('โหลดตัวสร้างไฟล์ Excel ไม่สำเร็จ')); }; document.head.appendChild(s); }));
  }
  const userName = () => { try { const u = JSON.parse(sessionStorage.getItem('wim_user') || '{}'); return u.PsName || u.Username || '-'; } catch (e) { return '-'; } };
  const stamp = () => new Date().toLocaleString('th-TH', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const textLen = (v) => { if (v == null) return 0; const s = isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v); return s.split('\n').reduce((m, l) => Math.max(m, l.length), 0); };

  function band(ws, row, n, fill, text, font, ht, border){
    ws.getRow(row).height = ht;
    for (let c = 1; c <= n; c++){ const cell = ws.getCell(row, c); cell.fill = solid(fill); if (border) cell.border = { bottom: border }; }
    const t = ws.getCell(row, 1); t.value = text; t.font = font; t.alignment = { vertical: 'middle', horizontal: 'left' };
  }
  function lab(ws, r, c1, c2, text){
    if (c2 > c1) ws.mergeCells(r, c1, r, c2);
    for (let c = c1; c <= c2; c++){ const cell = ws.getCell(r, c); cell.fill = solid(LBL); cell.border = BD; }
    const t = ws.getCell(r, c1); t.value = text; t.font = { ...FONT, bold: true, color: { argb: 'FF223355' } }; t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  }
  function val(ws, r, c1, c2, text){
    if (c2 > c1) ws.mergeCells(r, c1, r, c2);
    for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = BD;
    const t = ws.getCell(r, c1); t.value = text; t.font = FONT; t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  }

  // กรอบเงื่อนไข: จับคู่ [ป้าย|ค่า] 1–3 ชุดต่อแถว ตามจำนวนคอลัมน์ · ค่า 'full' ได้แถวเต็ม · คืนจำนวนแถวที่ใช้
  function infoGrid(ws, startRow, n, info){
    if (!info || !info.length) return 0;
    const ppr = n >= 9 ? 3 : n >= 5 ? 2 : 1, span = Math.max(2, Math.floor(n / ppr)), lw = span >= 6 ? 2 : 1;
    let row = startRow, i = 0;
    while (i < info.length){
      const a = info[i];
      ws.getRow(row).height = 21;
      if (a[2] === 'full' || ppr === 1){
        lab(ws, row, 1, Math.min(lw, n - 1), a[0]); val(ws, row, Math.min(lw, n - 1) + 1, n, a[1] == null || a[1] === '' ? '-' : a[1]); i++; row++; continue;
      }
      let p = 0;
      while (p < ppr && i < info.length && info[i][2] !== 'full'){
        const it = info[i], c0 = 1 + p * span, c1 = (p === ppr - 1) ? n : c0 + span - 1;
        lab(ws, row, c0, c0 + lw - 1, it[0]); val(ws, row, c0 + lw, c1, it[1] == null || it[1] === '' ? '-' : it[1]);
        p++; i++;
      }
      row++;
    }
    return row - startRow;
  }

  // เขียนตาราง 1 ชุด (หัว + แถว + แถวรวม) เริ่มที่แถว hr → คืนแถวสุดท้ายที่ใช้
  function writeTable(ws, hr, head, body, foot, sh){
    const n = head.length;
    ws.getRow(hr).height = 24;
    head.forEach((h, i) => { const c = ws.getCell(hr, i + 1); c.value = h; c.font = { ...FONT, bold: true, color: { argb: 'FF111111' } }; c.fill = solid(HEAD); c.border = BD; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
    // รูปแบบตัวเลขรายคอลัมน์: กำหนดเอง (fmts) หรือตรวจจากข้อมูล (จำนวนเต็ม → #,##0 / มีทศนิยม → #,##0.00)
    const fmts = sh.fmts || {}, aligns = sh.align || {};
    const colFmt = head.map((_, ci) => {
      if (fmts[ci] !== undefined) return fmts[ci];     // สตริงรูปแบบ หรือฟังก์ชัน (v) => รูปแบบ
      let seen = 0, allInt = true, other = false;
      body.forEach(r => { const v = r[ci]; if (isNum(v)){ seen++; if (!Number.isInteger(v)) allInt = false; } else if (v !== '' && v != null) other = true; });
      return seen && !other ? (allInt ? '#,##0' : '#,##0.00') : null;
    });
    const put = (r, rowVals, bold, fill) => rowVals.forEach((v, ci) => {
      if (ci >= n) return; const cell = ws.getCell(r, ci + 1); cell.value = v === '' ? null : v; cell.font = bold ? { ...FONT, bold: true } : FONT; cell.border = BD;
      if (fill) cell.fill = solid(fill);
      if (isNum(v) && colFmt[ci]) cell.numFmt = typeof colFmt[ci] === 'function' ? colFmt[ci](v) : colFmt[ci];
      const al = aligns[ci] || (isNum(v) ? 'right' : null); cell.alignment = al ? { horizontal: al, vertical: 'top', wrapText: true } : { vertical: 'top', wrapText: true };
    });
    body.forEach((rv, i) => put(hr + 1 + i, rv, false));
    foot.forEach((rv, i) => put(hr + 1 + body.length + i, rv, true, FOOT));
    return hr + body.length + foot.length;
  }

  // sh = { name, head, body, foot?, widths?, fmts?, align?, freezeCols?, title?, titleEn?, info? }
  //   หรือแบบหลายตาราง (เช่น แต่ละสินค้าใน PO): { name, sections: [{ title?, head, body, foot? }], widths }
  // แถบชื่อ (แถว 1-2) + กรอบเงื่อนไข → คืนแถวที่หัวตารางควรเริ่ม (ใช้กับหน้าที่สร้างตารางเอง)
  function header(ws, n, cfg){
    band(ws, 1, n, NAVY, cfg.title, { name: 'Tahoma', size: 16, bold: true, color: { argb: 'FFFFFFFF' } }, 32);
    band(ws, 2, n, NAVY2, (cfg.titleEn ? cfg.titleEn + '     ·     ' : '') + 'Export Date ' + stamp() + '     ·     Export By ' + userName(), { name: 'Tahoma', size: 9.5, color: { argb: 'FFCBD5E1' } }, 19, { style: 'medium', color: { argb: AMBER } });
    const used = infoGrid(ws, 3, n, cfg.info || []);
    const hr = 3 + used + (used ? 1 : 0);
    if (used) ws.getRow(hr - 1).height = 8;
    return hr;
  }

  function addDataSheet(wb, sh, common){
    const ws = wb.addWorksheet(sh.name || 'Sheet1', { views: [{ showGridLines: true }] });
    const secs = sh.sections || null, head0 = secs ? secs[0].head : sh.head, n = head0.length;
    const title = sh.title || common.title, titleEn = sh.titleEn || common.titleEn || '';
    const info = sh.info || common.info || [];
    band(ws, 1, n, NAVY, title, { name: 'Tahoma', size: 16, bold: true, color: { argb: 'FFFFFFFF' } }, 32);
    band(ws, 2, n, NAVY2, (titleEn ? titleEn + '     ·     ' : '') + 'Export Date ' + stamp() + '     ·     Export By ' + userName(), { name: 'Tahoma', size: 9.5, color: { argb: 'FFCBD5E1' } }, 19, { style: 'medium', color: { argb: AMBER } });
    const used = infoGrid(ws, 3, n, info);
    let r = 3 + used + (used ? 1 : 0);              // เว้น 1 แถวหลังกรอบเงื่อนไข
    if (used) ws.getRow(r - 1).height = 8;
    let hr = r, allBody = [], allFoot = [];
    if (secs){
      secs.forEach(sec => {
        if (sec.title){ ws.mergeCells(r, 1, r, n); for (let c = 1; c <= n; c++){ const cell = ws.getCell(r, c); cell.fill = solid(LBL); cell.border = BD; } const t = ws.getCell(r, 1); t.value = sec.title; t.font = { ...FONT, size: 11, bold: true, color: { argb: 'FF223355' } }; t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true }; ws.getRow(r).height = 22; r++; }
        const last = writeTable(ws, r, sec.head, sec.body || [], sec.foot || [], sh);
        allBody = allBody.concat(sec.body || []); allFoot = allFoot.concat(sec.foot || []);
        r = last + 2;
      });
    } else {
      writeTable(ws, hr, sh.head, sh.body || [], sh.foot || [], sh);
      allBody = sh.body || []; allFoot = sh.foot || [];
    }
    // ความกว้างคอลัมน์
    head0.forEach((h, ci) => {
      let w = sh.widths && sh.widths[ci];
      if (!w){ let m = textLen(h); allBody.slice(0, 300).forEach(row => { m = Math.max(m, textLen(row[ci])); }); allFoot.forEach(row => { m = Math.max(m, textLen(row[ci])); }); w = Math.min(50, Math.max(8, Math.ceil(m * 1.15) + 2)); }
      ws.getColumn(ci + 1).width = w;
    });
    // ตรึงหัว + filter + ตั้งค่าพิมพ์ (หลายตาราง: ตรึงเฉพาะแถบชื่อ ไม่ใส่ filter)
    ws.views = [{ state: 'frozen', xSplit: secs ? 0 : (sh.freezeCols || 0), ySplit: secs ? 2 : hr, showGridLines: true }];
    if (!secs && (sh.body || []).length) ws.autoFilter = { from: { row: hr, column: 1 }, to: { row: hr, column: n } };
    ws.pageSetup = { orientation: n > 7 ? 'landscape' : 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: secs ? '1:2' : hr + ':' + hr };
    return ws;
  }

  function addConditionsSheet(wb, common){
    const ws = wb.addWorksheet('เงื่อนไขรายงาน', { views: [{ showGridLines: false }] });
    ws.getColumn(1).width = 26; ws.getColumn(2).width = 100;
    band(ws, 1, 2, NAVY, 'เงื่อนไขรายงาน', { name: 'Tahoma', size: 16, bold: true, color: { argb: 'FFFFFFFF' } }, 32);
    band(ws, 2, 2, NAVY2, common.title + (common.titleEn ? '  ·  ' + common.titleEn : ''), { name: 'Tahoma', size: 9.5, color: { argb: 'FFCBD5E1' } }, 19, { style: 'medium', color: { argb: AMBER } });
    const kv = [...(common.conditions || []), ['Export Date', stamp()], ['Export By', userName()]];
    kv.forEach(([k, v], i) => { const r = 4 + i, a = ws.getCell(r, 1), b = ws.getCell(r, 2);
      a.value = k; a.fill = solid(LBL); a.font = { ...FONT, bold: true, color: { argb: 'FF223355' } }; a.border = BD; a.alignment = { vertical: 'top', horizontal: 'left', indent: 1, wrapText: true };
      b.value = v == null || v === '' ? '-' : v; b.font = FONT; b.border = BD; b.alignment = { vertical: 'top', horizontal: 'left', wrapText: true, indent: 1 };
      ws.getRow(r).height = Math.max(20, 15 * String(b.value).split('\n').length + 5); });
    const notes = common.notes || [];
    if (notes.length){ const nr = 4 + kv.length + 1; ws.getCell(nr, 1).value = 'หมายเหตุ'; ws.getCell(nr, 1).font = { ...FONT, bold: true, color: { argb: 'FF223355' } };
      notes.forEach((t, i) => { const c = ws.getCell(nr + 1 + i, 1); c.value = '•  ' + t; c.font = { ...FONT, color: { argb: 'FF444444' } }; }); }
  }

  async function build(cfg){
    await loadLib();
    const wb = new ExcelJS.Workbook(); wb.creator = userName(); wb.created = new Date();
    (cfg.sheets || []).forEach(sh => addDataSheet(wb, sh, cfg));
    if ((cfg.conditions && cfg.conditions.length) || (cfg.notes && cfg.notes.length)) addConditionsSheet(wb, cfg);
    return wb;
  }
  async function download(cfg){
    const wb = await build(cfg), buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.href = url; a.download = cfg.filename || 'export.xlsx'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  window.WIMExcel = { download, build, loadLib, header, band, lab, val, infoGrid, userName, stamp, colors: { NAVY, NAVY2, AMBER, LBL, HEAD, FOOT } };
})();
