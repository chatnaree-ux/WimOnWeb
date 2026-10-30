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

  const VERSION = '20261030n';   // แสดงท้ายกระดาษ (ตัวเล็ก) ไว้ตรวจว่าเครื่องได้ไฟล์ใหม่แล้ว
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
  #wimRptArea, #wimRptArea *{box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact;}
  #wimRptArea .rpt-layout{width:100%; border-collapse:collapse;}
  #wimRptArea .rpt-layout > thead > tr > td, #wimRptArea .rpt-layout > tbody > tr > td, #wimRptArea .rpt-layout > tfoot > tr > td{padding:0 10mm; border:0; background:none; color:#111;}
  #wimRptArea .rpt-sp-top{height:9mm;}
  #wimRptArea .rpt-sp-bot{height:3mm;}
  #wimRptArea .rpt-head{display:flex; justify-content:space-between; align-items:flex-end; gap:10mm; border-bottom:2px solid #334; padding:0 0 3mm; margin-bottom:4mm;}
  #wimRptArea .rpt-co{display:flex; align-items:center; gap:3mm; min-width:0;}
  #wimRptArea .rpt-logo{height:15mm; max-width:38mm; object-fit:contain; flex-shrink:0;}
  #wimRptArea .rpt-co-name{font-size:11pt; font-weight:700; color:#222;}
  #wimRptArea .rpt-title{text-align:right; flex-shrink:0;}
  #wimRptArea .rpt-title .th{font-size:16pt; font-weight:700; line-height:1.25; color:#000;}
  #wimRptArea .rpt-title .en{font-size:8.5pt; letter-spacing:.08em; color:#444; text-transform:uppercase;}
  #wimRptArea{--bw:2px; --bwv:2px; --bc:#848d9c;}
  #wimRptArea .rpt-flat{padding:0 7mm;}
  /* iOS: แนวตั้ง 794px ไม่ย่อ — ตัวอักษร / ช่องเล็กลง ให้ตารางหลายคอลัมน์พอดีความกว้าง */
  #wimRptArea.ios table.rpt-t{font-size:7.6pt;}
  #wimRptArea.ios table.rpt-t th{font-size:7.6pt; padding:1mm .8mm;}
  #wimRptArea.ios table.rpt-t td{padding:.9mm 1mm;}
  #wimRptArea.ios table.rpt-t td.nw{white-space:normal;}
  #wimRptArea.ios .rpt-head{gap:4mm;}
  #wimRptArea.ios .rpt-title .th{font-size:13pt;}
  #wimRptArea.ios .rpt-info th, #wimRptArea.ios .rpt-info td{font-size:8pt; padding:1mm 1.6mm;}
  #wimRptArea.ios .rpt-grp{font-size:9pt;}
  #wimRptArea.ios .rpt-pg{position:relative; height:260mm; overflow:hidden; padding:0 7mm; break-after:page; page-break-after:always;}
  #wimRptArea.ios .rpt-pg:last-child{break-after:auto; page-break-after:auto;}
  #wimRptArea.ios .rpt-pgf{position:absolute; left:7mm; right:7mm; bottom:0; display:flex; justify-content:space-between; gap:3mm; font-size:6.8pt; color:#555; border-top:1px solid #aaa; padding-top:1mm;}
  #wimRptArea .rpt-info{width:100%; border-collapse:separate; border-spacing:0; margin:0 0 4mm; table-layout:fixed; border-top:var(--bw) solid var(--bc); border-left:var(--bwv) solid var(--bc);}
  #wimRptArea .rpt-info th, #wimRptArea .rpt-info td{border:0; border-right:var(--bwv) solid var(--bc); border-bottom:var(--bw) solid var(--bc); padding:1.4mm 2.4mm; font-size:9.5pt; text-align:left; vertical-align:top; background:none; color:#111; white-space:normal; overflow-wrap:anywhere;}
  #wimRptArea .rpt-info th{width:15%; background:#e8eef6; font-weight:700; color:#223;}
  #wimRptArea .rpt-info td{width:35%;}
  #wimRptArea .rpt-grp{border:var(--bw) solid var(--bc); border-left-width:var(--bwv); border-right-width:var(--bwv); border-bottom:0; background:#e6eaf0; padding:1.6mm 2.6mm; font-size:10pt; break-after:avoid; page-break-after:avoid;}
  #wimRptArea .rpt-grp b{font-weight:700;}
  #wimRptArea .rpt-grp .rsub{font-size:9pt; color:#333; margin-top:.6mm;}
  #wimRptArea .rpt-blk{margin:0 0 5mm;}
  #wimRptArea table.rpt-t{width:100%; border-collapse:separate; border-spacing:0; table-layout:fixed; font-size:9.2pt;}
  #wimRptArea table.rpt-t tr > :first-child{border-left:var(--bwv) solid var(--bc);}
  #wimRptArea table.rpt-t th, #wimRptArea table.rpt-t td{border:0; border-right:var(--bwv) solid var(--bc); border-bottom:var(--bw) solid var(--bc); padding:1.3mm 1.8mm; color:#111; background:none; vertical-align:top; white-space:normal; overflow-wrap:anywhere; text-align:left; font-family:inherit;}
  #wimRptArea table.rpt-t thead{display:table-header-group;}
  #wimRptArea table.rpt-t th{background:#d5deea; font-weight:700; text-align:center; vertical-align:middle; font-size:9pt; border-top:var(--bw) solid var(--bc);}
  #wimRptArea table.rpt-t tr{break-inside:avoid; page-break-inside:avoid;}
  #wimRptArea table.rpt-t td.c, #wimRptArea table.rpt-t th.c{text-align:center;}
  #wimRptArea table.rpt-t td.r{text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap;}
  #wimRptArea table.rpt-t td.nw{white-space:nowrap; overflow-wrap:normal;}
  #wimRptArea table.rpt-t tfoot{display:table-row-group;}   /* แถวรวมอยู่ท้ายตารางครั้งเดียว (ไม่ซ้ำท้ายทุกหน้า) */
  #wimRptArea table.rpt-t tfoot td{background:#f1f3f6; font-weight:700;}
  #wimRptArea table.rpt-t tr.sub-row td{background:#f6f7f9; font-weight:600;}
  #wimRptArea table.rpt-t td.neg{color:#b3261e;}
  #wimRptArea table.rpt-t td.in{color:#1b6e3c;}
  #wimRptArea table.rpt-t td.out{color:#b3261e;}
  #wimRptArea .rpt-empty{border:var(--bw) dashed var(--bc); padding:5mm; text-align:center; color:#444;}
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

  // iOS (WebKit) แบ่งหน้าพิมพ์ตารางเองไม่ได้ (ตัดแถวกลางหน้า / หัวตารางไม่ซ้ำ / เส้นขาด) → เราแบ่งเอง:
  //   วัดความสูงหัว / กรอบข้อมูล / แต่ละแถว ที่ความกว้างจริง (794px) แล้วจัดลงแผ่นสูง 260 มม.
  //   ทุกแผ่น = แถวครบ + เส้นปิดครบ + หัวตารางซ้ำ + ท้ายแผ่น "หน้า x / y" ; แถวรวมอยู่ท้ายแผ่นสุดท้ายเท่านั้น
  function paginateIOS(area, headHtml, infoStr, bodyHtml, footLeft){
    const PX = 96 / 25.4, H = 260 * PX - 9 * PX, GAP = 5 * PX;   // แผ่นสูง 260 มม. (วัดจากภาพพิมพ์จริงบน iPhone: ใช้ได้ถึงประมาณ 290 มม. ก่อนถึงขอบล่างของ iOS เว้นไว้ ~30 มม. กันเครื่อง / ขอบต่างกัน)
    const m = document.createElement('div');
    m.className = 'rpt-flat'; m.style.cssText = 'position:absolute; left:-10000px; top:0; width:794px; visibility:hidden;';
    m.innerHTML = headHtml + infoStr + '<div class="mb">' + bodyHtml + '</div>';
    area.innerHTML = ''; area.appendChild(m);
    area.style.display = 'block'; area.style.position = 'absolute'; area.style.left = '-10000px'; area.style.top = '0';
    const oh = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0); };
    const info = m.querySelector('.rpt-info');
    const topH = oh(m.querySelector('.rpt-head')) + (info ? oh(info) : 0);
    const items = [];
    const walk = (parent, blk) => {
      const start = items.length;
      [...parent.children].forEach((el) => {
        if (el.classList.contains('rpt-blk')) { walk(el, true); return; }
        if (el.tagName === 'TABLE') {
          const rowOf = (tr) => ({ h: tr.getBoundingClientRect().height, html: tr.outerHTML });
          items.push({ type: 't', cls: el.className, cg: (el.querySelector('colgroup') || { outerHTML: '' }).outerHTML,
            head: el.tHead ? el.tHead.innerHTML : '', headH: el.tHead ? el.tHead.getBoundingClientRect().height : 0,
            rows: el.tBodies[0] ? [...el.tBodies[0].rows].map(rowOf) : [], foot: el.tFoot ? [...el.tFoot.rows].map(rowOf) : [], gap: 0 });
        } else items.push({ type: 'h', html: el.outerHTML, h: oh(el), keep: el.classList.contains('rpt-grp'), gap: 0 });
      });
      if (blk && items.length > start) items[items.length - 1].gap = GAP;
    };
    walk(m.querySelector('.mb'), false);
    const pages = []; let cur = [headHtml + infoStr], used = topH;
    const newPage = () => { pages.push(cur); cur = []; used = 0; };
    const gapDiv = (g) => g ? '<div style="height:' + Math.round(g) + 'px"></div>' : '';
    items.forEach((it, idx) => {
      if (it.type === 'h') {
        const nx = items[idx + 1];
        const need = it.h + (it.keep && nx && nx.type === 't' ? nx.headH + (nx.rows[0] ? nx.rows[0].h : 0) : 0);
        if (used > 0 && used + need > H) newPage();
        cur.push(it.html + gapDiv(it.gap)); used += it.h + it.gap; return;
      }
      let i = 0; const R = it.rows;
      do {
        if (used > 0 && used + it.headH + (R[i] ? R[i].h : 0) > H) newPage();
        let k = 0, h = it.headH;
        while (i + k < R.length && used + h + R[i + k].h <= H) { h += R[i + k].h; k++; }
        if (k === 0 && i < R.length) { h += R[i].h; k = 1; }
        const fh = it.foot.reduce((a, r) => a + r.h, 0);
        if (i + k >= R.length && fh && used + h + fh > H && k > 1) { k--; h -= R[i + k].h; }   // แถวสุดท้ายย้ายไปแผ่นถัดไปพร้อมแถวรวม
        const last = i + k >= R.length;
        const rows = R.slice(i, i + k).map((r) => r.html).join('');
        const foot = last && it.foot.length ? '<tfoot>' + it.foot.map((r) => r.html).join('') + '</tfoot>' : '';
        cur.push('<table class="' + it.cls + '">' + it.cg + '<thead>' + it.head + '</thead><tbody>' + rows + '</tbody>' + foot + '</table>' + (last ? gapDiv(it.gap) : ''));
        used += h + (last && it.foot.length ? fh : 0) + (last ? it.gap : 0);
        i += k;
        if (!last) newPage();
      } while (i < R.length);
    });
    if (cur.length) pages.push(cur);
    area.style.display = ''; area.style.position = ''; area.style.left = ''; area.style.top = '';
    return pages.map((p, n) => '<div class="rpt-pg">' + p.join('') + '<div class="rpt-pgf"><span>' + esc(footLeft) + '</span><span>หน้า ' + (n + 1) + ' / ' + pages.length + '</span></div></div>').join('');
  }

  async function print(o){
    const area = ensure();
    const orient = IS_IOS || o.orient === 'portrait' ? 'portrait' : 'landscape';   // iOS พิมพ์แนวตั้งเสมอ
    const co = o.company || {};
    const headHtml = `<div class="rpt-head">
          <div class="rpt-co">
            ${co.id ? `<img class="rpt-logo" src="${LOGO_BASE_URL + encodeURIComponent(co.id)}.jpg" alt="" onerror="this.remove()">` : ''}
            <div class="rpt-co-name">${esc(co.name || '')}</div>
          </div>
          <div class="rpt-title"><div class="th">${esc(o.title || '')}</div>${o.titleEn ? `<div class="en">${esc(o.titleEn)}</div>` : ''}</div>
        </div>`;
    const infoStr = infoHtml(o.info);
    const footCenter = `พิมพ์เมื่อ ${stamp()}  ·  ผู้พิมพ์ ${printerName()}`;
    area.style.width = ''; area.style.zoom = ''; area.classList.remove('ios');
    area.style.removeProperty('--bw'); area.style.removeProperty('--bwv');
    if (IS_IOS) {
      area.classList.add('ios'); area.style.width = '794px'; area.style.setProperty('--bw', '1px'); area.style.setProperty('--bwv', '1px');
      area.innerHTML = paginateIOS(area, headHtml, infoStr, o.body || '', location.host + location.pathname + '  ·  r' + VERSION + '  ·  ' + footCenter);
    } else {
      area.innerHTML = `<table class="rpt-layout"><thead><tr><td><div class="rpt-sp-top"></div></td></tr></thead><tbody><tr><td>${headHtml}${infoStr}${o.body || ''}</td></tr></tbody><tfoot><tr><td><div class="rpt-sp-bot"></div></td></tr></tfoot></table>`;
    }
    setPageStyle(orient, location.origin + location.pathname + '  ·  r' + VERSION, footCenter);
    await waitImgs(area);
    document.body.classList.add('wim-rpt');
    if (!window.__wimRptTitle) window.__wimRptTitle = document.title;
    document.title = window.__wimRptTitle + ' · r' + VERSION;
    window.print();
  }
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('wim-rpt');
    if (window.__wimRptTitle) { document.title = window.__wimRptTitle; window.__wimRptTitle = null; }
    const a = document.getElementById('wimRptArea'); if (a) { a.style.width = ''; a.style.zoom = ''; a.classList.remove('ios'); a.style.removeProperty('--bw'); a.style.removeProperty('--bwv'); }
  });

  window.WIMReport = { esc, print, table, IS_IOS, version: VERSION };
  document.addEventListener('DOMContentLoaded', () => {
    const f = document.querySelector('footer');
    if (f && !f.querySelector('.rpt-ver')) { const sp = document.createElement('span'); sp.className = 'rpt-ver'; sp.style.cssText = 'opacity:.55; margin-left:10px;'; sp.textContent = 'report r' + VERSION + (IS_IOS ? ' (iOS)' : ''); f.appendChild(sp); }
  });
})();
