/* ==================================================================
   Sidebar กลางของ WIM (ใช้ร่วมกันทุกหน้า)
   ------------------------------------------------------------------
   เดิมโค้ดชุดนี้ (โหลด sidebar / ชื่อผู้ใช้ / ไฮไลต์เมนู / เปิด-ปิดกลุ่ม / ล็อกตามสิทธิ์) คัดลอกไว้ทุกหน้า
   ย้ายมาไว้ที่เดียว — หน้าเว็บเรียกแค่:

     <aside class="sidebar" id="sidebar"></aside>
     <script src="/js/sidebar.js"></script>
     WIMSidebar.load({ menuCode: 'stockcard_lot' });   // menuCode = MenuCode ของหน้านี้ (null = ไม่บังคับสิทธิ์)
     WIMSidebar.load({ manageUser: false });           // หน้า Home: จัดการผู้ใช้ + สิทธิ์เอง (ใช้แค่เมนู/ไฮไลต์/เปิด-ปิดกลุ่ม)

   เมนูซ้อนได้หลายชั้น: .nav-group > .nav-parent (ปุ่ม) + .nav-submenu > .nav-submenu-inner > (.nav-subitem | .nav-group ...)
     - เปิดกลุ่มหนึ่ง = ปิดเฉพาะกลุ่มระดับเดียวกัน (กลุ่มแม่ยังเปิดอยู่)
     - หน้าที่เปิดอยู่: ไฮไลต์เมนู + เปิดกลุ่มที่ครอบทุกชั้นให้อัตโนมัติ
   ลำดับเมนูย่อยมาจาก WIMWebMenu.SortOrder (server เรียงให้ตอนส่ง /sidebar.html)
================================================================== */
(function () {
  'use strict';

  function setOpen(group, on) {
    group.classList.toggle('open', on);
    const btn = group.querySelector(':scope > .nav-parent');
    if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  // ---------- ชื่อผู้ใช้ (sessionStorage wim_user) / ไม่มี = กลับหน้า login ----------
  function initUser() {
    const raw = sessionStorage.getItem('wim_user');
    if (!raw) {
      window.location.href = '/index.html';
      return null;
    }
    const user = JSON.parse(raw);
    const fullName = [user.PsNameF, user.PsNameS].filter(Boolean).join(' ').trim();
    const displayName = user.PsName || fullName || user.Username || user.username || user.UN || 'ผู้ใช้งาน';
    const label = document.getElementById('userLabel');
    if (label) label.textContent = displayName;
    return user;
  }

  // ---------- Mobile drawer (ปุ่ม hamburger / พื้นหลังมืด อยู่ในแต่ละหน้า) ----------
  function initMobileDrawer() {
    const toggle = document.getElementById('sidebarToggle');
    const overlay = document.getElementById('sidebarOverlay');
    if (!toggle || !overlay || toggle.dataset.wimSidebar) return;
    toggle.dataset.wimSidebar = '1';
    toggle.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
    overlay.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  }

  // ---------- ไฮไลต์เมนูของหน้านี้ + เปิดกลุ่มที่ครอบทุกชั้น / accordion ----------
  function initActiveAndAccordion(root) {
    const path = window.location.pathname;
    root.querySelectorAll('a.nav-item, a.nav-subitem').forEach(a => {
      if (a.getAttribute('href') !== path) return;
      a.classList.add('active');
      for (let g = a.closest('.nav-group'); g; g = g.parentElement && g.parentElement.closest('.nav-group')) {
        setOpen(g, true);
      }
    });

    const nav = root.querySelector('.side-nav');
    if (!nav || nav.dataset.wimAccordion) return;
    nav.dataset.wimAccordion = '1';
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-parent');
      if (!btn) return;
      const group = btn.closest('.nav-group');
      if (!group) return;
      const willOpen = !group.classList.contains('open');
      // ปิดเฉพาะกลุ่มพี่น้อง (ระดับเดียวกัน) — กลุ่มแม่ไม่ถูกปิด
      [...group.parentElement.children].forEach(sib => {
        if (sib !== group && sib.classList.contains('nav-group')) setOpen(sib, false);
      });
      setOpen(group, willOpen);
    });
  }

  function showAccessDeniedOverlay() {
    document.body.innerHTML = `
      <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0c1420; color:#e7e4da; font-family:'Inter',sans-serif; text-align:center; padding:20px;">
        <div>
          <div style="font-size:48px; margin-bottom:16px;">🔒</div>
          <div style="font-family:'Oswald',sans-serif; font-size:22px; font-weight:700; text-transform:uppercase; margin-bottom:10px; color:#fff;">ไม่มีสิทธิ์เข้าถึงหน้านี้</div>
          <p style="color:#b9b4a5; margin-bottom:24px;">กรุณาติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์การใช้งาน</p>
          <a href="/main-menu.html" style="display:inline-block; background:#f2a91c; color:#0c1420; padding:12px 24px; border-radius:8px; font-family:'Oswald',sans-serif; font-weight:700; text-decoration:none; text-transform:uppercase;">กลับหน้าเมนูหลัก</a>
        </div>
      </div>`;
  }

  // ---------- ล็อกเมนูที่ไม่มีสิทธิ์ / หน้านี้ไม่มีสิทธิ์ = แสดงหน้าแจ้ง ----------
  async function applyMenuPermissions(idPs, menuCode) {
    if (!idPs) return;
    try {
      const res = await fetch('/api/permissions/my?' + new URLSearchParams({ idPs }));
      const data = await res.json();
      if (!data.success || data.unrestricted) return;

      const allowed = new Set(data.allowedMenuCodes);
      document.querySelectorAll('[data-menu]').forEach(el => {
        if (allowed.has(el.getAttribute('data-menu'))) return;
        el.classList.add('menu-locked');
        el.setAttribute('title', 'ไม่มีสิทธิ์เข้าถึงเมนูนี้ ติดต่อผู้ดูแลระบบ');
        el.addEventListener('click', (e) => e.preventDefault());
      });

      if (menuCode && !allowed.has(menuCode)) showAccessDeniedOverlay();
    } catch (err) {
      console.error('เช็คสิทธิ์การใช้งานไม่สำเร็จ:', err);
    }
  }

  // ---------- โหลด sidebar.html มาแปะใน #sidebar แล้วเริ่มทำงาน ----------
  async function load({ menuCode = null, manageUser = true } = {}) {
    const host = document.getElementById('sidebar');
    if (!host) return;
    try {
      const res = await fetch('/sidebar.html');
      host.innerHTML = await res.text();
    } catch (err) {
      console.error('โหลด Sidebar ไม่สำเร็จ:', err);
      return;
    }
    initMobileDrawer();
    initActiveAndAccordion(host);
    if (!manageUser) return;
    const user = initUser();
    if (user) await applyMenuPermissions(user.idPs, menuCode);
  }

  window.WIMSidebar = { load, showAccessDeniedOverlay };
})();
