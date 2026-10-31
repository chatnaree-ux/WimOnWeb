/* ==================================================================
   ไอคอนจางมุมขวาล่างของการ์ดสรุป (คู่กับ /css/kpi-cards.css)
   เลือกไอคอนจากชื่อการ์ด (ภาษาไทย) — ใส่ให้เองทุกครั้งที่หน้าสร้างการ์ดใหม่ (MutationObserver)
================================================================== */
(function(){
  'use strict';
  if(window.__kpiIcons) return;
  window.__kpiIcons = true;
  const P = {
    stack: '<path d="M12 2l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    scan: '<path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><path d="M7 12h10"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 10"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    x: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .8c0 1.7-2.5 2.2-2.5 3.7M12 17h.01"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    half: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 000-18z"/>',
    truck: '<rect x="1" y="5" width="14" height="11" rx="1"/><path d="M15 9h4l3 3v4h-7"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
    eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    box: '<path d="M21 16V8a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4a2 2 0 001-1.7z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>'
  };
  // ลำดับสำคัญ: คำที่เจาะจงกว่าก่อน (ไม่อนุมัติ ก่อน อนุมัติ / ยังไม่ ก่อน รอ)
  const RULES = [
    [/ยกเลิก|ไม่อนุมัติ|ปฏิเสธ|ไม่ผ่าน/, 'x'],
    [/สิ้นสุด|ปิด PO/, 'lock'],
    [/รับเกิน\s*20|เกิน\s*20/, 'alert'],
    [/ไม่พบ|ไม่นำมาคิด|ไม่ระบุ/, 'help'],
    [/ความแม่นยำ/, 'target'],
    [/บางส่วน/, 'half'],
    [/ขาด|ปรับลด|ลดลง/, 'down'],
    [/เกิน|ปรับเพิ่ม|เพิ่มขึ้น/, 'up'],
    [/ยังไม่|^รอ|รอ|ค้าง|ติดตาม|ต้องทำ/, 'clock'],
    [/ร่าง/, 'pencil'],
    [/กำลังนับ|กำลัง/, 'scan'],
    [/จัดส่ง/, 'truck'],
    [/ตรงกัน|ครบ|เสร็จ|อนุมัติ|แล้ว|สำเร็จ/, 'check'],
    [/ทั้งหมด|รายการ|เอกสาร|นับแล้ว|จำนวน/, 'stack']
  ];
  const pick = (t) => { t = String(t || '').replace(/\s+/g, ' ').trim(); const r = RULES.find(([re]) => re.test(t)); return r ? r[1] : 'box'; };
  const SEL = '.dash-card:not([data-kci]), .kpi-row .kpi:not([data-kci]), .sc-kpi > div:not([data-kci]), .mdash-card:not([data-kci])';
  function deco(){
    document.querySelectorAll(SEL).forEach(c => {
      c.setAttribute('data-kci', '1');
      if(c.querySelector('.kc-bg')) return;
      const lab = c.querySelector('.lbl, .k-label, .l');
      const text = lab ? lab.textContent : (c.firstChild && c.firstChild.nodeType === 3 ? c.firstChild.textContent : c.textContent);
      c.insertAdjacentHTML('beforeend', `<svg class="kc-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[pick(text)]}</svg>`);
    });
  }
  let queued = false;
  const run = () => { if(queued) return; queued = true; requestAnimationFrame(() => { queued = false; deco(); }); };
  new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true });
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', deco); else deco();
})();
