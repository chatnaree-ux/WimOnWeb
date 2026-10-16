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

  // ---------- ชื่อผู้ใช้ (sessionStorage wim_user) ----------
  // เปิดลิงก์ในแท็บใหม่ / จาก LINE: sessionStorage ของแท็บว่าง แต่ server ยังจำ login (cookie) → ดึงผู้ใช้จาก session
  // ยังไม่ login จริง → ไป login แล้วกลับมาหน้านี้ (เดิมพาไปหน้าแรก แล้วจบที่ main-menu ลิงก์เอกสารที่แนบมาเลยหาย)
  async function initUser() {
    let raw = sessionStorage.getItem('wim_user');
    if (!raw) {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        const data = await res.json();
        if (res.ok && data.success) {
          raw = JSON.stringify(data.user);
          sessionStorage.setItem('wim_user', raw);
        }
      } catch (err) { /* ไปหน้า login ด้านล่าง */ }
    }
    if (!raw) {
      window.location.href = '/auth/sso/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search);
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
    const norm = (p) => p.replace(/\.html$/, ''); // /coating กับ /coating.html = หน้าเดียวกัน
    const path = norm(window.location.pathname);
    const here = new URLSearchParams(window.location.search);
    // ลิงก์ที่มี query (เช่น /supplier-return-approve?step=ack) ต้องตรงทั้ง path และค่า query ที่ระบุในลิงก์
    const sameLink = (href) => {
      const u = new URL(href || '', window.location.origin);
      return norm(u.pathname) === path && [...u.searchParams].every(([k, v]) => here.get(k) === v);
    };
    root.querySelectorAll('a.nav-item, a.nav-subitem').forEach(a => {
      if (!sameLink(a.getAttribute('href'))) return;
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
          <a href="/main-menu" style="display:inline-block; background:#f2a91c; color:#0c1420; padding:12px 24px; border-radius:8px; font-family:'Oswald',sans-serif; font-weight:700; text-decoration:none; text-transform:uppercase;">กลับหน้าเมนูหลัก</a>
        </div>
      </div>`;
  }

  // ---------- เมนู On process (WIMWebMenu.stWip) ----------
  // ผู้ใช้ทั่วไป: ซ่อนเมนู (ไม่ใช่ล็อก 🔒) + ซ่อนกลุ่มที่ไม่เหลือเมนู / กลุ่มระบบ: เห็นได้ มีป้าย WIP กำกับ
  function applyWipMenus(root, wipCodes, unrestricted) {
    const wip = new Set(wipCodes || []);
    if (!wip.size) return;
    root.querySelectorAll('[data-menu]').forEach(el => {
      if (!wip.has(el.getAttribute('data-menu'))) return;
      if (unrestricted) {
        el.classList.add('menu-wip');
        el.setAttribute('title', 'On process — กำลังพัฒนา ผู้ใช้ทั่วไปยังไม่เห็นเมนูนี้');
      } else {
        el.hidden = true;
      }
    });
    if (unrestricted) return;
    // ไล่จากกลุ่มชั้นในสุดออกมา (querySelectorAll เรียงแม่ก่อนลูก → กลับลำดับ)
    [...root.querySelectorAll('.nav-group')].reverse().forEach(g => {
      const visible = [...g.querySelectorAll('a.nav-subitem, a.nav-item')].some(a => !a.hidden && !a.closest('.nav-group[hidden]'));
      if (!visible) g.hidden = true;
    });
  }

  // ---------- ล็อกเมนูที่ไม่มีสิทธิ์ / หน้านี้ไม่มีสิทธิ์ = แสดงหน้าแจ้ง ----------
  async function applyMenuPermissions(idPs, menuCode) {
    if (!idPs) return;
    try {
      const res = await fetch('/api/permissions/my?' + new URLSearchParams({ idPs }));
      const data = await res.json();
      if (!data.success) return;
      applyWipMenus(document, data.wipMenuCodes, data.unrestricted);
      if (data.unrestricted) return;

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
  // แสดงเมนูชุดล่าสุดที่จำไว้ (localStorage) ทันที ไม่ต้องรอ server — บน server จริง /sidebar.html บางครั้งช้า
  // (เรียงเมนูตาม DB ระหว่างที่หน้าหลักกำลังดึงข้อมูลหนัก ๆ) เมนูเลยหายไปจนหน้าหลักโหลดเสร็จ
  // แล้วค่อยดึงฉบับล่าสุดมาเก็บไว้ ถ้าเมนูเปลี่ยน (เพิ่ม/ย้ายเมนู) ค่อยแปะใหม่
  const SIDEBAR_CACHE_KEY = 'wim_sidebar_html';
  async function load({ menuCode = null, manageUser = true } = {}) {
    const host = document.getElementById('sidebar');
    if (!host) return;
    let cached = null;
    try { cached = localStorage.getItem(SIDEBAR_CACHE_KEY); } catch (err) { /* เปิดแบบ private / ปิด storage */ }
    const fresh = fetch('/sidebar.html').then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    });
    if (cached) {
      host.innerHTML = cached;
    } else {
      try {
        host.innerHTML = await fresh;
      } catch (err) {
        console.error('โหลด Sidebar ไม่สำเร็จ:', err);
        return;
      }
    }
    initMobileDrawer();
    initActiveAndAccordion(host);

    const ready = manageUser
      ? initUser().then(user => (user ? applyMenuPermissions(user.idPs, menuCode).then(() => user) : null))
      : Promise.resolve(null);

    fresh.then(async (html) => {
      try { localStorage.setItem(SIDEBAR_CACHE_KEY, html); } catch (err) { /* ไม่เป็นไร รอบหน้าโหลดจาก server */ }
      // หน้า Home จัดการชื่อผู้ใช้ / ล็อกเมนูเอง → ไม่แปะทับ (ใช้ฉบับใหม่ตั้งแต่ครั้งถัดไป)
      if (!cached || html === cached || !manageUser) return;
      const user = await ready;
      const scroll = (host.querySelector('.side-nav') || {}).scrollTop || 0;
      host.innerHTML = html;
      initActiveAndAccordion(host);
      const nav = host.querySelector('.side-nav');
      if (nav) nav.scrollTop = scroll;
      if (user) {
        await initUser();
        await applyMenuPermissions(user.idPs, null);
      }
    }).catch(err => {
      if (cached) console.warn('อัปเดต Sidebar ไม่สำเร็จ ใช้เมนูชุดเดิม:', err);
    });

    await ready;
  }

  window.WIMSidebar = { load, showAccessDeniedOverlay, applyWipMenus };
})();
