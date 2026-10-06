/* ==================================================================
   session-guard.js — จัดการตอน session ฝั่ง server หมด / หาย (เช่น server restart)
   ------------------------------------------------------------------
   ปัญหา: หน้าเว็บเช็ค login จาก sessionStorage อย่างเดียว พอ session ที่ server หาย
          ทุก API ตอบ 401 แต่หน้าเว็บไม่รู้ตัว -> ดูเหมือนติดต่อ DB ไม่ได้
   วิธีนี้ (ฝั่งหน้าเว็บอย่างเดียว ไม่ต้องตั้งค่า server):
     - ดักทุก fetch ไป /api/... ของเว็บเรา ถ้าได้ 401
       * GET (โหลดข้อมูล)        -> ไป login SSO แล้วกลับมาหน้าเดิมอัตโนมัติ (ระบบกลางยังจำ login -> ไม่ต้องกรอกรหัส)
       * POST/PUT/DELETE (บันทึก) -> ไม่รีโหลดหน้า (ข้อมูลในฟอร์มไม่หาย) ขึ้นกล่องให้เข้าสู่ระบบใหม่ในแท็บใหม่
                                    แล้วกลับมากดบันทึกอีกครั้ง
     - กันวนลูป: ถ้าเพิ่งพาไป login ภายใน 1 นาทีแล้วยังได้ 401 อีก -> ขึ้นกล่องแทนการพาไปซ้ำ
   ใช้: <script src="/js/session-guard.js"></script> ใน <head> ก่อนสคริปต์อื่นของหน้า
================================================================== */
(function(){
  'use strict';
  if (window.__wimSessionGuard) return;
  window.__wimSessionGuard = true;

  const LOOP_KEY = 'wim_relogin_at';
  const LOOP_MS = 60 * 1000;
  const origFetch = window.fetch.bind(window);

  const herePath = () => location.pathname + location.search;
  const loginUrl = (returnTo) => '/auth/sso/login?returnTo=' + encodeURIComponent(returnTo);

  // เฉพาะ API ของเว็บเรา (/api/...) — ไม่ยุ่งกับ request อื่น
  function isOwnApi(input){
    try {
      const u = new URL(typeof input === 'string' ? input : input.url, location.href);
      return u.origin === location.origin && u.pathname.startsWith('/api/');
    } catch (e) { return false; }
  }
  function methodOf(input, init){
    return String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
  }

  function recentlyRedirected(){
    try { return Date.now() - Number(sessionStorage.getItem(LOOP_KEY) || 0) < LOOP_MS; } catch (e) { return false; }
  }

  let redirecting = false;
  function reloginHere(){
    if (redirecting) return;
    if (recentlyRedirected()) { showExpiredBox(); return; }   // เพิ่งไป login แล้วยังไม่ผ่าน -> ไม่วนซ้ำ
    redirecting = true;
    try { sessionStorage.setItem(LOOP_KEY, String(Date.now())); } catch (e) {}
    location.href = loginUrl(herePath());
  }

  /* ---------- กล่องแจ้ง "หมดเวลาเข้าสู่ระบบ" (ใช้ตอนบันทึก — ไม่รีโหลดหน้า) ---------- */
  let box = null;
  function injectStyle(){
    if (document.getElementById('wimSgStyle')) return;
    const st = document.createElement('style');
    st.id = 'wimSgStyle';
    st.textContent = `
      .wim-sg-overlay{position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center;
        padding:16px; background:rgba(10,13,18,.65); backdrop-filter:blur(2px);}
      .wim-sg-box{width:100%; max-width:420px; background:#1c222b; color:#e8ecf1; border:1px solid rgba(255,255,255,.12);
        border-top:3px solid #f2a91c; border-radius:12px; padding:22px 22px 18px; box-shadow:0 18px 50px rgba(0,0,0,.45);
        font-family:'Inter','Sarabun',system-ui,sans-serif;}
      .wim-sg-box h3{margin:0 0 8px; font-size:17px; font-weight:600; color:#f5c66b;}
      .wim-sg-box p{margin:0 0 6px; font-size:13.5px; line-height:1.6; color:#c3cad4;}
      .wim-sg-box p b{color:#fff;}
      .wim-sg-msg{min-height:20px; margin-top:8px; font-size:13px;}
      .wim-sg-msg.ok{color:#8fe3bd;} .wim-sg-msg.err{color:#ff8a75;}
      .wim-sg-actions{display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; margin-top:12px;}
      .wim-sg-actions button{font:inherit; font-size:13.5px; font-weight:600; border-radius:8px; padding:9px 14px; cursor:pointer;
        border:1px solid rgba(255,255,255,.18); background:transparent; color:#e8ecf1;}
      .wim-sg-actions button.primary{background:#f2a91c; border-color:#f2a91c; color:#1a1300;}
      .wim-sg-actions button:hover{filter:brightness(1.08);}`;
    document.head.appendChild(st);
  }
  function showExpiredBox(){
    if (box) return;
    injectStyle();
    box = document.createElement('div');
    box.className = 'wim-sg-overlay';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.innerHTML = `
      <div class="wim-sg-box">
        <h3>หมดเวลาเข้าสู่ระบบ</h3>
        <p>ระบบยังไม่ได้บันทึกรายการล่าสุด แต่<b>ข้อมูลที่กรอกไว้ในหน้านี้ยังอยู่ครบ</b></p>
        <p>กด "เข้าสู่ระบบใหม่" (เปิดแท็บใหม่) เมื่อเข้าสู่ระบบเสร็จแล้วกลับมาที่หน้านี้ แล้วกดบันทึกอีกครั้ง</p>
        <div class="wim-sg-msg" id="wimSgMsg"></div>
        <div class="wim-sg-actions">
          <button type="button" data-sg="check">เข้าสู่ระบบแล้ว</button>
          <button type="button" class="primary" data-sg="login">เข้าสู่ระบบใหม่</button>
        </div>
      </div>`;
    box.addEventListener('click', onBoxClick);
    document.body.appendChild(box);
    box.querySelector('[data-sg="login"]').focus();
  }
  function closeBox(){
    if (!box) return;
    box.remove();
    box = null;
  }
  function setMsg(text, cls){
    const el = box && box.querySelector('#wimSgMsg');
    if (el) { el.textContent = text; el.className = 'wim-sg-msg ' + (cls || ''); }
  }
  // เช็คว่า session กลับมาแล้วหรือยัง (login ในแท็บอื่นแล้ว cookie ใช้ร่วมกัน)
  async function checkSession(){
    try {
      const res = await origFetch('/api/auth/me', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        try { sessionStorage.setItem('wim_user', JSON.stringify(data.user)); sessionStorage.removeItem(LOOP_KEY); } catch (e) {}
        return true;
      }
    } catch (e) { /* เน็ตหลุด -> ถือว่ายังไม่ผ่าน */ }
    return false;
  }
  async function onBoxClick(e){
    const btn = e.target.closest('[data-sg]');
    if (!btn) return;
    if (btn.dataset.sg === 'login') {
      window.open(loginUrl('/session-ok.html'), '_blank');
      setMsg('กำลังรอเข้าสู่ระบบในแท็บใหม่…', '');
      return;
    }
    setMsg('กำลังตรวจสอบ…', '');
    if (await checkSession()) {
      setMsg('✅ เข้าสู่ระบบแล้ว — กดบันทึกอีกครั้งได้เลย', 'ok');
      setTimeout(closeBox, 1200);
    } else {
      setMsg('ยังไม่ได้เข้าสู่ระบบ — กด "เข้าสู่ระบบใหม่" ก่อน', 'err');
    }
  }
  // แท็บ login แจ้งกลับมาว่าเสร็จแล้ว (session-ok.html) -> ปิดกล่องเอง
  window.addEventListener('message', async (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'wim-session-ok' || !box) return;
    if (await checkSession()) {
      setMsg('✅ เข้าสู่ระบบแล้ว — กดบันทึกอีกครั้งได้เลย', 'ok');
      setTimeout(closeBox, 1200);
    }
  });
  // กลับมาที่แท็บนี้ระหว่างกล่องเปิดอยู่ -> เช็คให้อัตโนมัติ
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !box) return;
    if (await checkSession()) {
      setMsg('✅ เข้าสู่ระบบแล้ว — กดบันทึกอีกครั้งได้เลย', 'ok');
      setTimeout(closeBox, 1200);
    }
  });

  /* ---------- ดัก fetch ---------- */
  window.fetch = async function(input, init){
    const res = await origFetch(input, init);
    if (res.status === 401 && isOwnApi(input)) {
      if (methodOf(input, init) === 'GET') reloginHere();
      else showExpiredBox();
    } else if (res.ok && isOwnApi(input)) {
      try { sessionStorage.removeItem(LOOP_KEY); } catch (e) {}
    }
    return res;
  };
})();
