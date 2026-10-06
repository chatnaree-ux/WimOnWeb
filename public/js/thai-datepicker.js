/* ==================================================================
   Thai Datepicker — ปฏิทินเลือกวันที่ของ WIM (ใช้ร่วมกันทุกหน้า)
   ------------------------------------------------------------------
   ทำไมไม่ใช้ปฏิทินของ browser: ตอนคลิก/focus <input type="date"> browser จะไฮไลต์ช่อง mm
   และแสดง mm/dd/yyyy ของมันเองทับข้อความ วว/ดด/ปปปป (ซ่อนด้วย CSS ไม่อยู่ในบาง browser)

   วิธีใช้ (markup เดิมของหน้า):
     <span class="date-overlay-wrap">
       <input type="date" min="yyyy-mm-dd" value="yyyy-mm-dd" ...>   <- ถูกซ่อน (display:none) เก็บค่าเหมือนเดิม
       <span class="date-overlay-text">วว/ดด/ปปปป</span>             <- ข้อความที่เห็น (หน้าเว็บอัปเดตเองจาก event)
     </span>
   คลิกที่กล่อง -> เปิดปฏิทินไทย (เดือนภาษาไทย / ปี พ.ศ.) -> เลือกวัน
   -> ใส่ค่า yyyy-mm-dd กลับเข้า input แล้วยิง event 'input' + 'change' (bubble) ให้โค้ดเดิมของหน้าทำงานต่อได้เลย
================================================================== */
(function(){
  'use strict';
  if(window.__thaiDatepicker) return;
  window.__thaiDatepicker = true;

  const MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const WEEKDAYS = ['อา','จ','อ','พ','พฤ','ศ','ส'];
  const CAL_ICON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23b9b4a5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='18' rx='2'/%3E%3Cline x1='16' y1='2' x2='16' y2='6'/%3E%3Cline x1='8' y1='2' x2='8' y2='6'/%3E%3Cline x1='3' y1='10' x2='21' y2='10'/%3E%3C/svg%3E\")";

  // ---------- สไตล์ (ทับ CSS ช่องวันที่เดิมของแต่ละหน้า) ----------
  const css = `
    .date-overlay-wrap{
      position:relative; display:inline-flex; align-items:center; vertical-align:middle;
      width:160px; min-height:36px; padding:0 34px 0 11px; box-sizing:border-box; cursor:pointer; user-select:none;
      background:var(--navy-950,#0c1420) ${CAL_ICON} no-repeat right 10px center / 15px 15px;
      border:1px solid rgba(255,255,255,.12); border-radius:7px; transition:border-color .18s, box-shadow .18s;
    }
    .date-overlay-wrap:hover{border-color:rgba(255,255,255,.25);}
    .date-overlay-wrap:focus, .date-overlay-wrap.tdp-open{outline:none; border-color:var(--amber-500,#f2a91c); box-shadow:0 0 0 3px rgba(242,169,28,.15);}
    .date-overlay-wrap.tdp-disabled{opacity:.5; cursor:not-allowed;}
    .date-overlay-wrap > input[type="date"]{display:none !important;}
    .date-overlay-wrap > .date-overlay-text{
      position:static; transform:none; flex:1; text-align:left; pointer-events:none;
      font-family:'Inter',sans-serif; font-size:13px; color:#fff; white-space:nowrap;
    }
    .date-overlay-wrap > .date-overlay-text.empty{color:var(--steel-500,#4a6b8a);}

    .tdp-pop{
      position:fixed; z-index:3000; width:280px; padding:12px; box-sizing:border-box;
      background:linear-gradient(180deg, var(--navy-900,#111d2e), var(--navy-850,#0f1a29));
      border:1px solid rgba(255,255,255,.12); border-radius:10px; box-shadow:0 24px 60px -18px rgba(0,0,0,.8);
      font-family:'Inter',sans-serif; color:var(--concrete-200,#e7e4da);
    }
    .tdp-head{display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;}
    .tdp-title{font-size:14px; font-weight:600; color:#fff;}
    .tdp-nav{width:30px; height:30px; border-radius:7px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.03);
      color:var(--concrete-200,#e7e4da); cursor:pointer; font-size:15px; line-height:1; display:flex; align-items:center; justify-content:center; padding:0;}
    .tdp-nav:hover{border-color:var(--amber-500,#f2a91c); color:var(--amber-500,#f2a91c);}
    .tdp-grid{display:grid; grid-template-columns:repeat(7, 1fr); gap:3px;}
    .tdp-wd{text-align:center; font-size:11.5px; color:var(--concrete-400,#b9b4a5); padding:4px 0;}
    .tdp-day{height:32px; border:0; border-radius:7px; background:none; color:#fff; font-family:inherit; font-size:13px; cursor:pointer; padding:0;}
    .tdp-day:hover{background:rgba(255,255,255,.08);}
    .tdp-day.out{color:var(--steel-500,#4a6b8a);}
    .tdp-day.today{box-shadow:inset 0 0 0 1px var(--amber-500,#f2a91c);}
    .tdp-day.sel{background:var(--amber-500,#f2a91c); color:var(--navy-950,#0c1420); font-weight:700;}
    .tdp-day:disabled{color:rgba(255,255,255,.18); cursor:not-allowed; background:none;}
    .tdp-foot{display:flex; justify-content:space-between; margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.07);}
    .tdp-link{border:0; background:none; color:var(--sky-blue,#4ea7e0); font-family:inherit; font-size:12.5px; cursor:pointer; padding:4px 2px;}
    .tdp-link:hover{text-decoration:underline;}
    .tdp-link:disabled{color:var(--steel-500,#4a6b8a); cursor:not-allowed; text-decoration:none;}
  `;
  const style = document.createElement('style');
  style.id = 'thai-datepicker-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;          // m = 0-11
  const parseISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.split('-').map(Number) : null;
  const todayISO = () => { const t = new Date(); return toISO(t.getFullYear(), t.getMonth(), t.getDate()); };

  let pop = null, input = null, wrap = null, viewY = 0, viewM = 0;

  function close(){
    if(pop){ pop.remove(); pop = null; }
    if(wrap){ wrap.classList.remove('tdp-open'); }
    input = wrap = null;
  }

  function choose(iso){
    if(!input) return;
    input.value = iso;
    // ให้โค้ดเดิมของหน้าทำงาน (อัปเดตข้อความ วว/ดด/ปปปป, เก็บค่า, ล้าง error)
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const w = wrap;
    close();
    if(w) w.focus({ preventScroll: true });
  }

  function render(){
    const min = input.min || '';
    const max = input.max || '';
    const sel = input.value || '';
    const today = todayISO();
    const first = new Date(viewY, viewM, 1);
    const start = new Date(viewY, viewM, 1 - first.getDay());   // เริ่มที่วันอาทิตย์ของสัปดาห์แรก

    let days = '';
    for(let i = 0; i < 42; i++){
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = toISO(d.getFullYear(), d.getMonth(), d.getDate());
      const off = (min && iso < min) || (max && iso > max);
      const cls = ['tdp-day', d.getMonth() !== viewM ? 'out' : '', iso === today ? 'today' : '', iso === sel ? 'sel' : ''].join(' ').trim();
      days += `<button type="button" class="${cls}" data-iso="${iso}" ${off ? 'disabled' : ''}>${d.getDate()}</button>`;
    }
    const todayOff = (min && today < min) || (max && today > max);
    pop.innerHTML = `
      <div class="tdp-head">
        <button type="button" class="tdp-nav" data-nav="-1" aria-label="เดือนก่อนหน้า">‹</button>
        <div class="tdp-title">${MONTHS[viewM]} ${viewY + 543}</div>
        <button type="button" class="tdp-nav" data-nav="1" aria-label="เดือนถัดไป">›</button>
      </div>
      <div class="tdp-grid">${WEEKDAYS.map(w => `<div class="tdp-wd">${w}</div>`).join('')}${days}</div>
      <div class="tdp-foot">
        <button type="button" class="tdp-link" data-act="clear">ล้างค่า</button>
        <button type="button" class="tdp-link" data-act="today" ${todayOff ? 'disabled' : ''}>วันนี้</button>
      </div>`;
  }

  // วางปฏิทินใต้กล่อง (ถ้าล้นจอล่างให้ขึ้นด้านบน / ไม่ล้นขอบซ้ายขวา)
  function place(){
    if(!pop || !wrap) return;
    const r = wrap.getBoundingClientRect();
    if(r.bottom < 0 || r.top > window.innerHeight){ close(); return; }   // กล่องเลื่อนพ้นจอไปแล้ว
    const h = pop.offsetHeight, w = pop.offsetWidth;
    let top = r.bottom + 6;
    if(top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    let left = Math.min(r.left, window.innerWidth - w - 8);
    pop.style.top = Math.max(8, top) + 'px';
    pop.style.left = Math.max(8, left) + 'px';
  }

  function open(w){
    const inp = w.querySelector('input[type="date"]');
    if(!inp || inp.disabled || inp.readOnly) return;
    if(wrap === w){ close(); return; }   // คลิกซ้ำ = ปิด
    close();
    wrap = w; input = inp;
    const v = parseISO(inp.value) || parseISO(inp.min && inp.min > todayISO() ? inp.min : todayISO());
    viewY = v[0]; viewM = v[1] - 1;
    pop = document.createElement('div');
    pop.className = 'tdp-pop';
    pop.setAttribute('role', 'dialog');
    document.body.appendChild(pop);
    render();
    wrap.classList.add('tdp-open');
    place();
  }

  // ทำให้กล่องกด Tab มาถึงได้ + บอก screen reader ว่าเป็นปุ่มเลือกวันที่
  function prepare(root){
    (root || document).querySelectorAll('.date-overlay-wrap').forEach(w => {
      if(w.dataset.tdpReady) return;
      w.dataset.tdpReady = '1';
      w.tabIndex = 0;
      w.setAttribute('role', 'button');
      const inp = w.querySelector('input[type="date"]');
      w.classList.toggle('tdp-disabled', !!(inp && inp.disabled));
    });
  }
  // กล่องวันที่ถูกสร้างใหม่ตลอด (render ตาราง) -> คอยเตรียมให้อัตโนมัติ
  new MutationObserver(() => prepare()).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => prepare());

  // ---------- events ----------
  document.addEventListener('mousedown', (e) => {
    if(pop && !pop.contains(e.target) && !(wrap && wrap.contains(e.target))) close();
  }, true);

  document.addEventListener('click', (e) => {
    if(pop && pop.contains(e.target)){
      const nav = e.target.closest('[data-nav]');
      if(nav){
        viewM += Number(nav.dataset.nav);
        if(viewM < 0){ viewM = 11; viewY--; }
        if(viewM > 11){ viewM = 0; viewY++; }
        render(); place();
        return;
      }
      const day = e.target.closest('[data-iso]');
      if(day && !day.disabled){ choose(day.dataset.iso); return; }
      const act = e.target.closest('[data-act]');
      if(act && !act.disabled){ choose(act.dataset.act === 'today' ? todayISO() : ''); }
      return;
    }
    const w = e.target.closest('.date-overlay-wrap');
    if(w) open(w);
  });

  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && pop){ const w = wrap; close(); if(w) w.focus(); return; }
    const w = e.target.closest && e.target.closest('.date-overlay-wrap');
    if(w && e.target === w && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); open(w); }
  });

  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', close);
})();
