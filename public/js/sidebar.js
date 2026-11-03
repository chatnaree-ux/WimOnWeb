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

  // ---------- ชื่อผู้ใช้ + ปุ่มออกจากระบบ บนแถบบน (ทุกหน้าใช้ .topbar-mobile ที่มีอยู่แล้ว) ----------
  // แถบบนลอยตามตอนเลื่อน (สูง 50px บนจอคอม) — แถบลอยของแต่ละหน้า (.bulk/.toc/.buy-side/.vw-bar) ขยับลงมาใต้แถบนี้
  // CSS อยู่ในไฟล์นี้ ไม่แยกไฟล์ — .js กับ .css ถูก Cloudflare cache คนละรอบ ถ้าแยกอาจได้ครึ่งเก่าครึ่งใหม่
  // ลำดับสำคัญ: แทรกท้าย <head> ให้ชนะ .topbar-mobile{display:none} ของหน้า แต่แพ้ .preview-mode/.printing (เจาะจงกว่า)
  const USER_BAR_CSS = `
    @media screen and (min-width:901px){
      .topbar-mobile{display:flex; justify-content:flex-end; padding:8px 24px;}
      .topbar-mobile .hamburger, .topbar-mobile .brand-text{display:none;}
      .wim-user-name{max-width:320px;}
      .bulk.on{top:60px;}
      .toc{top:66px;}
      .buy-side{top:66px;}
      #docView .vw-bar{top:50px;}
      .buy-table thead th{top:50px;}
      html{scroll-padding-top:66px;}
    }
    @media (max-width:900px){
      .topbar-mobile{padding:8px 12px; gap:8px;}
      .topbar-mobile .brand-text{color:var(--amber-500, #f2a91c); flex-shrink:0;}
      .wim-logout-text{display:none;}
      .wim-logout{width:40px; height:40px; padding:0; justify-content:center;}
    }
    .wim-user-area{display:flex; align-items:center; gap:10px; flex:1; min-width:0; justify-content:flex-end;}
    .wim-user-name{
      display:flex; align-items:center; gap:6px; min-width:0; padding:4px 2px; cursor:default;
      background:none; border:none; font:inherit; font-size:13px; font-weight:600; color:#fff;
    }
    .wim-user-name.is-cut{cursor:pointer;}
    .wim-user-name svg{flex-shrink:0;}
    .wim-user-name #userLabel{display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
    .wim-user-pop{
      position:absolute; top:calc(100% + 6px); right:12px; z-index:30; max-width:calc(100vw - 24px);
      padding:9px 12px; border-radius:8px; font-size:13px; color:#fff;
      background:var(--navy-800, #182a40); border:1px solid rgba(242,169,28,.4);
    }
    .wim-logout{
      display:inline-flex; align-items:center; gap:6px; flex-shrink:0; padding:7px 12px; border-radius:8px;
      font-size:13px; font-weight:600; text-decoration:none; white-space:nowrap; color:#ff8a75;
      border:1px solid rgba(229,83,61,.55); background:rgba(229,83,61,.1); transition:background .15s, border-color .15s;
    }
    .wim-logout:hover{background:rgba(229,83,61,.2); border-color:#e5533d;}
    .wim-confirm-back{
      position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:16px;
      background:rgba(5,10,18,.75);
    }
    .wim-confirm{
      width:100%; max-width:340px; padding:20px; border-radius:12px; text-align:center; color:#e7e4da;
      font-family:'Inter',sans-serif; background:var(--navy-900, #111d2e); border:1px solid rgba(255,255,255,.14);
    }
    .wim-confirm h2{margin:8px 0 6px; font-size:17px; font-weight:600; color:#fff;}
    .wim-confirm p{margin:0 0 16px; font-size:13px; line-height:1.5; color:#b9b4a5; overflow-wrap:anywhere;}
    .wim-confirm-btns{display:flex; gap:10px;}
    .wim-confirm-btns > *{
      flex:1; min-height:44px; display:flex; align-items:center; justify-content:center; box-sizing:border-box;
      border-radius:8px; font:inherit; font-size:14px; font-weight:600; text-decoration:none; cursor:pointer;
    }
    .wim-confirm-cancel{color:#e7e4da; background:transparent; border:1px solid rgba(255,255,255,.22);}
    .wim-confirm-go{color:#ff8a75; background:rgba(229,83,61,.1); border:1px solid rgba(229,83,61,.55);}
    @media print{.wim-user-area{display:none;}}
  `;
  const svgIcon = (body, size, color) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON_USER = '<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>';
  const ICON_LOGOUT = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>';

  function confirmLogout(href) {
    if (document.querySelector('.wim-confirm-back')) return;
    const back = document.createElement('div');
    back.className = 'wim-confirm-back';
    back.innerHTML = `
      <div class="wim-confirm" role="dialog" aria-modal="true" aria-labelledby="wimConfirmTitle">
        ${svgIcon(ICON_LOGOUT, 26, '#ff8a75')}
        <h2 id="wimConfirmTitle">ออกจากระบบ?</h2>
        <p></p>
        <div class="wim-confirm-btns">
          <button type="button" class="wim-confirm-cancel">ยกเลิก</button>
          <a class="wim-confirm-go" href="${href}">ออกจากระบบ</a>
        </div>
      </div>`;
    const label = document.getElementById('userLabel');
    back.querySelector('p').textContent = `${label ? label.textContent + ' — ' : ''}ข้อมูลที่ยังไม่บันทึกจะหายไป`;
    const prevFocus = document.activeElement;
    const close = () => {
      document.removeEventListener('keydown', onKey);
      back.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    back.querySelector('.wim-confirm-cancel').addEventListener('click', close);
    back.querySelector('.wim-confirm-go').addEventListener('click', () => {
      try { sessionStorage.removeItem('wim_user'); } catch (err) { /* ไม่เป็นไร */ }
    });
    document.body.appendChild(back);
    back.querySelector('.wim-confirm-cancel').focus();
  }

  // ย้ายชื่อ + ปุ่มออกจากระบบจากท้าย sidebar มาไว้แถบบน (เรียกซ้ำได้ — sidebar ถูกแปะใหม่เมื่อเมนูเปลี่ยน)
  function mountUserBar(host) {
    const bar = document.querySelector('.topbar-mobile');
    if (!bar) return; // หน้าไหนไม่มีแถบบน = คงท้าย sidebar ไว้เหมือนเดิม
    const foot = host.querySelector('.sidebar-foot');
    if (foot) foot.remove();
    if (bar.querySelector('.wim-user-area')) return;

    if (!document.getElementById('wimUserBarCss')) {
      const style = document.createElement('style');
      style.id = 'wimUserBarCss';
      style.textContent = USER_BAR_CSS;
      document.head.appendChild(style);
    }
    const area = document.createElement('div');
    area.className = 'wim-user-area';
    area.innerHTML = `
      <button type="button" class="wim-user-name">
        ${svgIcon(ICON_USER, 16, 'var(--amber-500, #f2a91c)')}
        <span id="userLabel">กำลังโหลด…</span>
      </button>
      <a class="wim-logout" href="/logout" aria-label="ออกจากระบบ" title="ออกจากระบบ">
        ${svgIcon(ICON_LOGOUT, 16, 'currentColor')}
        <span class="wim-logout-text">ออกจากระบบ</span>
      </a>`;
    bar.appendChild(area);

    const logout = area.querySelector('.wim-logout');
    logout.addEventListener('click', (e) => {
      e.preventDefault();
      confirmLogout(logout.getAttribute('href'));
    });

    // ชื่อยาวจนถูกตัด: แตะเพื่อดูชื่อเต็ม
    const nameBtn = area.querySelector('.wim-user-name');
    const label = area.querySelector('#userLabel');
    const closePop = () => { const p = bar.querySelector('.wim-user-pop'); if (p) p.remove(); };
    const isCut = () => label.scrollWidth > label.clientWidth;
    nameBtn.addEventListener('pointerenter', () => nameBtn.classList.toggle('is-cut', isCut()));
    nameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (bar.querySelector('.wim-user-pop')) return closePop();
      if (!isCut()) return;
      const pop = document.createElement('div');
      pop.className = 'wim-user-pop';
      pop.textContent = label.textContent;
      if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
      bar.appendChild(pop);
    });
    document.addEventListener('click', closePop);
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
  // data-menu เป็นรหัสเดียว หรือหลายรหัสคั่นด้วย , (ลิงก์ที่เปิดได้เมื่อมีสิทธิ์อย่างใดอย่างหนึ่ง เช่น คู่มือที่มี 2 ฝั่ง)
  const menuCodes = (el) => (el.getAttribute('data-menu') || '').split(',').map(x => x.trim()).filter(Boolean);
  function applyWipMenus(root, wipCodes, unrestricted) {
    const wip = new Set(wipCodes || []);
    if (!wip.size) return;
    root.querySelectorAll('[data-menu]').forEach(el => {
      if (!menuCodes(el).every(c => wip.has(c))) return;
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
        if (menuCodes(el).some(c => allowed.has(c))) return;
        el.classList.add('menu-locked');
        el.setAttribute('title', 'ไม่มีสิทธิ์เข้าถึงเมนูนี้ ติดต่อผู้ดูแลระบบ');
        el.addEventListener('click', (e) => e.preventDefault());
      });

      if (menuCode && !allowed.has(menuCode)) showAccessDeniedOverlay();
    } catch (err) {
      console.error('เช็คสิทธิ์การใช้งานไม่สำเร็จ:', err);
    }
  }

  // ---------- ตัวเลขงานรออนุมัติบนเมนู (server จำไว้ 30 วินาที) — หน้างานรออนุมัติส่งตัวเลขล่าสุดมาเองผ่าน setApprovalBadge ----------
  // เมนูแสดงเฉพาะคนที่เกี่ยวข้อง (eligible จาก server) / หน้างานรออนุมัติเรียกโดยไม่ส่ง eligible = เกี่ยวข้องแน่นอน
  let apvTotal = null, apvEligible = false;
  function setApprovalBadge(n, eligible = true) {
    apvTotal = Number(n) || 0;
    apvEligible = !!eligible || apvTotal > 0;
    document.querySelectorAll('#sidebar [data-apv-link]').forEach(a => { a.hidden = !apvEligible; });
    document.querySelectorAll('#sidebar [data-apv-badge]').forEach(b => {
      b.textContent = apvTotal > 99 ? '99+' : String(apvTotal);
      b.hidden = !apvTotal;
      b.title = apvTotal ? `มี ${apvTotal} รายการรอคุณดำเนินการ` : '';
    });
  }
  async function loadApprovalBadge() {
    if (apvTotal != null) return setApprovalBadge(apvTotal, apvEligible);
    try {
      const res = await fetch('/api/approval-inbox/count', { cache: 'no-store' });
      const d = await res.json();
      if (d && d.success) setApprovalBadge(d.total, d.eligible !== false);
    } catch (err) { /* ไม่มีตัวเลขก็ใช้เมนูได้ */ }
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
    mountUserBar(host);
    initMobileDrawer();
    initActiveAndAccordion(host);

    const ready = manageUser
      ? initUser().then(user => (user ? applyMenuPermissions(user.idPs, menuCode).then(() => user) : null))
      : Promise.resolve(null);
    ready.then(user => { if (user || !manageUser) loadApprovalBadge(); });

    fresh.then(async (html) => {
      try { localStorage.setItem(SIDEBAR_CACHE_KEY, html); } catch (err) { /* ไม่เป็นไร รอบหน้าโหลดจาก server */ }
      // หน้า Home จัดการชื่อผู้ใช้ / ล็อกเมนูเอง → ไม่แปะทับ (ใช้ฉบับใหม่ตั้งแต่ครั้งถัดไป)
      if (!cached || html === cached || !manageUser) return;
      const user = await ready;
      const scroll = (host.querySelector('.side-nav') || {}).scrollTop || 0;
      host.innerHTML = html;
      mountUserBar(host);
      initActiveAndAccordion(host);
      if (apvTotal != null) setApprovalBadge(apvTotal, apvEligible);
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

  window.WIMSidebar = { load, showAccessDeniedOverlay, applyWipMenus, setApprovalBadge };
})();
