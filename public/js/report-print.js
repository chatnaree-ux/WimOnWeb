/* ==================================================================
   report-print.js — รายงานทางการ (A4) ใช้ร่วมกัน: Stock Card / รายงานรับเมล็ดจากบริษัทในเครือ ฯลฯ
   ------------------------------------------------------------------
   สร้างเป็น HTML ของเอกสารเอง (ไม่พิมพ์หน้าจอ) แล้วพิมพ์ด้วย Chrome (window.print)
     - หัวเอกสาร: โลโก้ + ชื่อบริษัท (ซ้าย) / ชื่อรายงานไทย-อังกฤษ (ขวา)
     - กรอบข้อมูลรายงาน (เงื่อนไข) / ตารางเส้นบาง หัวตารางซ้ำทุกหน้า / แถวรวม
     - ท้ายกระดาษทุกหน้า: ลิงก์ · พิมพ์เมื่อ + ผู้พิมพ์ · หน้า x / y (Chrome)
     - iPhone / iPad: iOS จัดหน้าพิมพ์เป็นกระดาษแนวตั้งและไม่สนแนวนอน → จัดที่ความกว้างจริงแล้วย่อด้วย zoom ให้พอดีหน้า
   ใช้:
     WIMReport.print({ orient:'landscape'|'portrait', title, titleEn, company:{ id, name },
                       info:[[label, value], ...], body: htmlString })
     WIMReport.table({ cols:[%...], head:[...], align:['l'|'c'|'r'...], rows:[[html...]...], foot:[[html, colspan?]...] })
   ทุกค่าที่ส่งเข้าต้องผ่าน WIMReport.esc() มาก่อน (ฟังก์ชันนี้ไม่ escape ให้)
================================================================== */
(function(){
  'use strict';
  if (window.WIMReport) return;

  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const LOGO_BASE_URL = 'https://seedsgroup.dyndns.org/spm/Center/Logo/';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
  #wimRptArea{display:none;}
  @media print{
    body.wim-rpt{background:#fff !important; margin:0 !important; padding:0 !important;}
    body.wim-rpt > *:not(#wimRptArea){display:none !important;}
    body.wim-rpt #wimRptArea{display:block !important;}
  }
  #wimRptArea{font-family:'Inter','Noto Sans Thai',Tahoma,sans-serif; color:#111; background:#fff; font-size:10pt; line-height:1.4;}
  #wimRptArea *{box-sizing:border-box;}
  #wimRptArea .rpt-layout{width:100%; border-collapse:collapse;}
  #wimRptArea .rpt-layout > thead > tr > td, #wimRptArea .rpt-layout > tbody > tr > td, #wimRptArea .rpt-layout > tfoot > tr > td{padding:0 10mm; border:0; background:none; color:#111;}
  #wimRptArea .rpt-sp-top{height:9mm;}
  #wimRptArea .rpt-sp-bot{height:3mm;}
  #wimRptArea .rpt-head{display:flex; justify-content:space-between; align-items:flex-end; gap:10mm; border-bottom:1.5pt solid #333; padding-bottom:3mm; margin-bottom:4mm;}
  #wimRptArea .rpt-co{display:flex; align-items:center; gap:3mm; min-width:0;}
  #wimRptArea .rpt-logo{height:15mm; max-width:38mm; object-fit:contain; flex-shrink:0;}
  #wimRptArea .rpt-co-name{font-size:11pt; font-weight:700; color:#222;}
  #wimRptArea .rpt-title{text-align:right; flex-shrink:0;}
  #wimRptArea .rpt-title .th{font-size:16pt; font-weight:700; line-height:1.25; color:#000;}
  #wimRptArea .rpt-title .en{font-size:8.5pt; letter-spacing:.08em; color:#444; text-transform:uppercase;}
  #wimRptArea .rpt-info{width:100%; border-collapse:collapse; margin:0 0 4mm; table-layout:fixed;}
  #wimRptArea .rpt-info th, #wimRptArea .rpt-info td{border:.75pt solid #888; padding:1.4mm 2.4mm; font-size:9.5pt; text-align:left; vertical-align:top; background:none; color:#111;}
  #wimRptArea .rpt-info th{width:15%; background:#eef1f5; font-weight:700; color:#222;}
  #wimRptArea .rpt-info td{width:35%;}
  #wimRptArea .rpt-grp{border:.75pt solid #888; border-bottom:0; background:#e6eaf0; padding:1.6mm 2.6mm; font-size:10pt; break-after:avoid; page-break-after:avoid;}
  #wimRptArea .rpt-grp b{font-weight:700;}
  #wimRptArea .rpt-grp .rsub{font-size:9pt; color:#333; margin-top:.6mm;}
  #wimRptArea .rpt-blk{margin:0 0 5mm;}
  #wimRptArea table.rpt-t{width:100%; border-collapse:collapse; table-layout:fixed; font-size:9.2pt;}
  #wimRptArea table.rpt-t th, #wimRptArea table.rpt-t td{border:.5pt solid #888; padding:1.3mm 1.8mm; color:#111; background:none; vertical-align:top; white-space:normal; overflow-wrap:anywhere; text-align:left; font-family:inherit;}
  #wimRptArea table.rpt-t thead{display:table-header-group;}
  #wimRptArea table.rpt-t th{background:#dfe5ec; font-weight:700; text-align:center; vertical-align:middle; font-size:9pt;}
  #wimRptArea table.rpt-t tr{break-inside:avoid; page-break-inside:avoid;}
  #wimRptArea table.rpt-t td.c, #wimRptArea table.rpt-t th.c{text-align:center;}
  #wimRptArea table.rpt-t td.r{text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap;}
  #wimRptArea table.rpt-t td.nw{white-space:nowrap; overflow-wrap:normal;}
  #wimRptArea table.rpt-t tfoot td{background:#f1f3f6; font-weight:700;}
  #wimRptArea table.rpt-t tr.sub-row td{background:#f6f7f9; font-weight:600;}
  #wimRptArea table.rpt-t td.neg{color:#b3261e;}
  #wimRptArea table.rpt-t td.in{color:#1b6e3c;}
  #wimRptArea table.rpt-t td.out{color:#b3261e;}
  #wimRptArea .rpt-empty{border:.75pt dashed #888; padding:5mm; text-align:center; color:#444;}
  #wimRptArea .rpt-note{font-size:8.5pt; color:#444; margin:2mm 0 0;}
  `;

  function ensure(){
    if (!document.getElementById('wimRptStyle')) {
      const st = document.createElement('style'); st.id = 'wimRptStyle'; st.textContent = CSS; document.head.appendChild(st);
    }
    let area = document.getElementById('wimRptArea');
    if (!area) { area = document.createElement('div'); area.id = 'wimRptArea'; document.body.appendChild(area); }
    return area;
  }

  function setPageStyle(orient, left, center){
    const css = (t) => '"' + String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    let st = document.getElementById('wimRptPage');
    if (!st) { st = document.createElement('style'); st.id = 'wimRptPage'; document.head.appendChild(st); }
    const box = 'font-family:Inter,Tahoma,sans-serif; font-size:8.5pt; color:#555; vertical-align:middle; border-top:0.5pt solid #bbb;';
    st.textContent = `@page{size:A4 ${orient}; margin:0 0 10mm 0;
      @bottom-left{content:${css(left)}; ${box} text-align:left; padding-left:10mm;}
      @bottom-center{content:${css(center)}; ${box} text-align:center;}
      @bottom-right{content:"หน้า " counter(page) " / " counter(pages); ${box} text-align:right; padding-right:10mm;}}`;
  }

  // ตาราง: cols = % ต่อคอลัมน์ / head = หัว / align = ['l'|'c'|'r'] / rows = [[html หรือ {h, cls, span}]] / foot = [[...]]
  function table(o){
    const al = o.align || [];
    const cell = (v, i, tag) => {
      const isObj = v && typeof v === 'object';
      const html = isObj ? v.h : v;
      const cls = [isObj && v.cls ? v.cls : '', tag === 'td' ? (al[i] === 'r' ? 'r' : al[i] === 'c' ? 'c' : '') : (al[i] === 'r' || al[i] === 'c' ? 'c' : '')].filter(Boolean).join(' ');
      return `<${tag}${cls ? ` class="${cls}"` : ''}${isObj && v.span ? ` colspan="${v.span}"` : ''}>${html == null || html === '' ? '&nbsp;' : html}</${tag}>`;
    };
    const rowHtml = (r) => {
      const trCls = r && r.cls ? ` class="${r.cls}"` : '';
      const cells = Array.isArray(r) ? r : r.cells;
      let i = 0;
      return `<tr${trCls}>${cells.map((v) => { const h = cell(v, i, 'td'); i += (v && v.span) || 1; return h; }).join('')}</tr>`;
    };
    return `<table class="rpt-t">
      <colgroup>${o.cols.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>
      <thead><tr>${o.head.map((h, i) => cell(h, i, 'th')).join('')}</tr></thead>
      <tbody>${(o.rows || []).map(rowHtml).join('') || `<tr><td colspan="${o.cols.length}" class="c">ไม่มีข้อมูล</td></tr>`}</tbody>
      ${o.foot && o.foot.length ? `<tfoot>${o.foot.map(rowHtml).join('')}</tfoot>` : ''}
    </table>`;
  }

  function infoHtml(info){
    if (!info || !info.length) return '';
    const rows = [];
    for (let i = 0; i < info.length; i += 2) {
      const a = info[i], b = info[i + 1];
      rows.push(`<tr><th>${esc(a[0])}</th><td${b ? '' : ' colspan="3"'}>${a[1] == null || a[1] === '' ? '-' : a[1]}</td>${b ? `<th>${esc(b[0])}</th><td>${b[1] == null || b[1] === '' ? '-' : b[1]}</td>` : ''}</tr>`);
    }
    return `<table class="rpt-info">${rows.join('')}</table>`;
  }

  function waitImgs(root){
    const imgs = [...root.querySelectorAll('img')];
    return Promise.all(imgs.map((img) => {
      if (!img.getAttribute('src')) return Promise.resolve();
      if (img.complete) { if (!img.naturalWidth) img.style.display = 'none'; return Promise.resolve(); }
      return new Promise((resolve) => {
        let done = false;
        const fin = (ok) => { if (done) return; done = true; if (!ok) img.style.display = 'none'; resolve(); };
        img.addEventListener('load', () => fin(true), { once: true });
        img.addEventListener('error', () => fin(false), { once: true });
        setTimeout(() => fin(img.complete && img.naturalWidth > 0), 4000);
      });
    }));
  }

  const printerName = () => { try { const u = JSON.parse(sessionStorage.getItem('wim_user') || '{}'); return u.PsName || u.Username || '-'; } catch (e) { return '-'; } };
  const stamp = () => new Date().toLocaleString('th-TH', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  async function print(o){
    const area = ensure();
    const orient = o.orient === 'portrait' ? 'portrait' : 'landscape';
    const co = o.company || {};
    area.innerHTML = `<table class="rpt-layout">
      <thead><tr><td><div class="rpt-sp-top"></div></td></tr></thead>
      <tbody><tr><td>
        <div class="rpt-head">
          <div class="rpt-co">
            ${co.id ? `<img class="rpt-logo" src="${LOGO_BASE_URL + encodeURIComponent(co.id)}.jpg" alt="" onerror="this.remove()">` : ''}
            <div class="rpt-co-name">${esc(co.name || '')}</div>
          </div>
          <div class="rpt-title"><div class="th">${esc(o.title || '')}</div>${o.titleEn ? `<div class="en">${esc(o.titleEn)}</div>` : ''}</div>
        </div>
        ${infoHtml(o.info)}
        ${o.body || ''}
      </td></tr></tbody>
      <tfoot><tr><td><div class="rpt-sp-bot"></div></td></tr></tfoot>
    </table>`;
    setPageStyle(orient, location.origin + location.pathname, `พิมพ์เมื่อ ${stamp()}  ·  ผู้พิมพ์ ${printerName()}`);
    await waitImgs(area);
    area.style.width = ''; area.style.zoom = '';
    if (IS_IOS) { const w = orient === 'landscape' ? 1122 : 794; area.style.width = w + 'px'; area.style.zoom = String(Math.min(1, 740 / w)); }
    document.body.classList.add('wim-rpt');
    window.print();
  }
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('wim-rpt');
    const a = document.getElementById('wimRptArea'); if (a) { a.style.width = ''; a.style.zoom = ''; }
  });

  window.WIMReport = { esc, print, table, IS_IOS };
})();
