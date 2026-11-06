/* ==================================================================
   wim-loading.js — Loading กลางของระบบ (ใช้คู่ /css/wim-loading.css)
   ใช้:
     WIMLoading.show(elementหรือ id, 'ข้อความรอง')   // คลุมกล่องนั้นด้วย Loading
     WIMLoading.hide(elementหรือ id)
     await WIMLoading.wrap(element, 'ข้อความรอง', () => asyncFn())   // show → รัน → hide (hide เสมอแม้ error)
   เรียกซ้อนได้: นับจำนวนครั้ง show / hide ต่อกล่อง — ปิดเมื่อ hide ครบ
================================================================== */
(function () {
  'use strict';
  if (window.WIMLoading) return;
  const LOGO = '/images/WIM_LoadingLogo.png';
  const el = (t) => (typeof t === 'string' ? document.getElementById(t) : t);
  function show(target, sub) {
    const host = el(target); if (!host) return;
    host.__wimLd = (host.__wimLd || 0) + 1;
    let ov = host.querySelector(':scope > .wim-loading');
    if (!ov) {
      host.classList.add('wim-loading-host');
      ov = document.createElement('div');
      ov.className = 'wim-loading'; ov.setAttribute('role', 'status'); ov.setAttribute('aria-live', 'polite');
      ov.innerHTML = '<div class="ld-box"><div class="ld-ring"><img src="' + LOGO + '" alt="" class="ld-logo" width="48" height="48"></div>'
        + '<div class="ld-text" aria-label="กำลังโหลด">Loading . . .</div><div class="ld-sub"></div></div>';
      host.appendChild(ov);
    }
    const s = ov.querySelector('.ld-sub'); s.textContent = sub || ''; s.style.display = sub ? '' : 'none';
  }
  function hide(target) {
    const host = el(target); if (!host || !host.__wimLd) return;
    host.__wimLd = Math.max(0, host.__wimLd - 1);
    if (!host.__wimLd) { const ov = host.querySelector(':scope > .wim-loading'); if (ov) ov.remove(); }
  }
  async function wrap(target, sub, fn) {
    show(target, sub);
    try { return await fn(); } finally { hide(target); }
  }
  window.WIMLoading = { show, hide, wrap };
})();
