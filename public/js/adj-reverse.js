/* ==================================================================
   ขอกลับรายการปรับยอดสต๊อก — หน้าต่างกลาง ใช้ร่วม: รายงานการปรับยอดสต๊อก / ใบขอปรับยอดสต๊อก (หน้าอนุมัติ · รายการขอปรับยอด)
   AdjReverse.open(idUpdate, { onDone(result) }) — idUpdate = dInvLotCountMt (เอกสารปรับเดิม ทั้งจาก WIM Desktop และเว็บ)
   เลือกรายการ + เหตุผล → POST /api/stock-adjust/reverse/:id → ได้ใบขอปรับยอดใหม่ (กลับรายการ) รอรับทราบ / ตรวจสอบ / อนุมัติ
   ต้องมีสิทธิ์ stock_adjust_reverse (หน้าเรียกใช้เช็คก่อนแสดงปุ่ม — server เช็คซ้ำ)
================================================================== */
(function(){
  'use strict';
  if(window.AdjReverse) return;
  const esc = (s) => s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtQty = (v) => {
    if(v === null || v === undefined || v === '' || isNaN(v)) return '-';
    const n = Number(v);
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 0.01 ? 6 : 2 });
  };
  const thDate = (iso) => { if(!iso) return '-'; const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y + 543}`; };
  const sign = (op) => op === '-' ? '−' : op === '=' ? '=' : '+';
  const STATE = { ok: '', done: 'กลับรายการแล้ว', pending: 'รออนุมัติกลับรายการ', zero: 'ไม่มีผลต่าง', noloc: 'ไม่พบตำแหน่ง', locked: 'Lot ถูกล็อก', neg: 'ยอดไม่พอ' };
  const UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.5 15a9 9 0 102.1-9.4L1 10"/></svg>';
  const CSS = `
  .rvx-ov{position:fixed; inset:0; z-index:1200; background:rgba(4,8,14,.72); display:flex; align-items:center; justify-content:center; padding:20px;}
  .rvx-box{width:100%; max-width:1080px; max-height:92vh; display:flex; flex-direction:column; background:#111d2e; border:1px solid rgba(255,255,255,.1); border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,.5); color:#e3e8ef; font-family:'Inter','Noto Sans Thai',sans-serif;}
  .rvx-hd{display:flex; justify-content:space-between; align-items:center; gap:12px; padding:16px 20px; border-bottom:1px solid rgba(255,255,255,.08);}
  .rvx-hd h3{margin:0; font-family:'Oswald',sans-serif; font-size:16px; font-weight:600; letter-spacing:.02em; color:#fff;}
  .rvx-x{width:34px; height:34px; border-radius:8px; border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.04); color:#b8c3d1; cursor:pointer; font-size:18px; line-height:1;}
  .rvx-x:hover{border-color:#e5533d; color:#ff8a75;}
  .rvx-bd{padding:16px 20px; overflow-y:auto;}
  .rvx-ft{display:flex; justify-content:flex-end; gap:10px; padding:14px 20px; border-top:1px solid rgba(255,255,255,.08); flex-wrap:wrap;}
  .rvx-meta{display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px 16px; font-size:13px; color:#b8c3d1; margin-bottom:12px;}
  .rvx-meta b{display:block; color:#fff; font-size:14px; font-weight:600; margin-top:2px; word-break:break-word;}
  .rvx-meta .w{grid-column:1 / -1;}
  .rvx-info{font-size:13.5px; line-height:1.55; padding:10px 14px; border-radius:10px; background:rgba(242,169,28,.08); border:1px solid rgba(242,169,28,.35); color:#f3dfb4; margin-bottom:14px;}
  .rvx-err{font-size:13.5px; padding:10px 14px; border-radius:10px; background:rgba(229,83,61,.12); border:1px solid rgba(229,83,61,.5); color:#ffb4a6; margin-bottom:12px;}
  .rvx-ok{font-size:15px; line-height:1.6; padding:16px; border-radius:10px; background:rgba(62,207,142,.1); border:1px solid rgba(62,207,142,.45); color:#c8f5df;}
  .rvx-ok b{color:#fff;}
  .rvx-all{display:flex; align-items:center; gap:8px; font-size:13.5px; margin-bottom:8px; color:#e3e8ef; cursor:pointer; width:max-content;}
  .rvx-list{container-type:inline-size;}
  .rvx-tbl{width:100%; border-collapse:collapse; font-size:13.5px;}
  .rvx-tbl th{font-size:12px; font-weight:600; color:#b8c3d1; text-align:left; padding:8px; border-bottom:1px solid rgba(255,255,255,.1); white-space:nowrap;}
  .rvx-tbl td{padding:9px 8px; border-bottom:1px solid rgba(255,255,255,.06); vertical-align:middle;}
  .rvx-tbl .n{text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums;}
  .rvx-tbl tr.off td{opacity:.6;}
  .rvx-tbl tr.off td.st{opacity:1;}
  .rvx-lot{font-family:'JetBrains Mono',monospace; font-size:12.5px; color:#f2a91c; white-space:nowrap;}
  .rvx-p{color:#4ea7e0; font-weight:700;} .rvx-m{color:#ff8a75; font-weight:700;} .rvx-s{color:#c4b5fd; font-weight:700;}
  .rvx-chip{display:inline-block; font-size:11.5px; font-weight:600; padding:2px 8px; border-radius:999px; border:1px solid rgba(255,255,255,.2); color:#b8c3d1; white-space:nowrap;}
  .rvx-chip.done, .rvx-chip.pending{border-color:rgba(167,139,250,.5); color:#c4b5fd; background:rgba(167,139,250,.1);}
  .rvx-chip.neg, .rvx-chip.locked, .rvx-chip.noloc{border-color:rgba(229,83,61,.5); color:#ffb4a6; background:rgba(229,83,61,.1);}
  .rvx-msg{display:block; font-size:12px; color:#b8c3d1; margin-top:3px; white-space:normal; min-width:140px;}
  .rvx-ck{width:18px; height:18px; accent-color:#f2a91c; cursor:pointer;}
  .rvx-cards{display:none;}
  @container (max-width:640px){
    .rvx-tbl{display:none;}
    .rvx-cards{display:flex; flex-direction:column; gap:10px;}
  }
  .rvx-card{display:block; border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:12px; background:rgba(255,255,255,.02); cursor:pointer;}
  .rvx-card.sel{border-color:rgba(242,169,28,.7); background:rgba(242,169,28,.07);}
  .rvx-card.off{cursor:default;}
  .rvx-card .t{display:flex; gap:10px; align-items:flex-start;}
  .rvx-card .t b{color:#fff; font-size:14px;}
  .rvx-card .s{font-size:12.5px; color:#b8c3d1; margin-top:2px;}
  .rvx-card .g{display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; margin-top:10px; font-size:12px; color:#b8c3d1;}
  .rvx-card .g b{display:block; font-size:14.5px; color:#fff; margin-top:2px; font-variant-numeric:tabular-nums;}
  .rvx-card .g b.rvx-p{color:#4ea7e0;} .rvx-card .g b.rvx-m{color:#ff8a75;} .rvx-card .g b.rvx-s{color:#c4b5fd;}
  .rvx-fg{margin-top:14px;}
  .rvx-fg label{display:block; font-size:13.5px; font-weight:600; margin-bottom:6px;}
  .rvx-fg label .req{color:#ff8a75; margin-left:3px;}
  .rvx-fg textarea{width:100%; box-sizing:border-box; min-height:74px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.15); background:#0b1420; color:#fff; font:inherit; font-size:16px; resize:vertical;}
  .rvx-fg textarea:focus{outline:none; border-color:#f2a91c;}
  .rvx-btn{min-height:44px; padding:0 18px; border-radius:9px; font:inherit; font-size:14.5px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:8px; border:1px solid rgba(255,255,255,.22); background:rgba(255,255,255,.05); color:#e3e8ef;}
  .rvx-btn:hover{background:rgba(255,255,255,.1);}
  .rvx-btn svg{width:17px; height:17px;}
  .rvx-btn.go{background:#f2a91c; border-color:#f2a91c; color:#1b1404;}
  .rvx-btn.go:hover{filter:brightness(1.08);}
  .rvx-btn:disabled{opacity:.45; cursor:not-allowed; filter:none;}
  .rvx-load{padding:30px 0; text-align:center; color:#b8c3d1;}
  @media (max-width:700px){
    .rvx-ov{padding:0;}
    .rvx-box{max-height:none; height:100%; border-radius:0;}
    .rvx-bd{padding:14px 14px;}
    .rvx-hd, .rvx-ft{padding:12px 14px;}
    .rvx-ft .rvx-btn{flex:1 1 auto; justify-content:center;}
  }`;

  let ov = null, data = null, picked = new Set(), opts = {}, busy = false;
  function ensure(){
    if(ov) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    ov = document.createElement('div'); ov.className = 'rvx-ov'; ov.style.display = 'none';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = '<div class="rvx-box"><div class="rvx-hd"><h3 id="rvxTitle">ขอกลับรายการปรับยอดสต๊อก</h3><button type="button" class="rvx-x" data-rvx="close" aria-label="ปิด">×</button></div><div class="rvx-bd" id="rvxBody"></div><div class="rvx-ft" id="rvxFoot"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', onClick);
    ov.addEventListener('change', onChange);
    ov.addEventListener('input', (e) => { if(e.target.id === 'rvxNote') foot(); });
    document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && ov.style.display !== 'none' && !busy) close(); });
  }
  const $ = (id) => document.getElementById(id);
  function close(){ ov.style.display = 'none'; document.body.style.overflow = ''; }
  async function open(idUpdate, o){
    ensure(); opts = o || {}; data = null; picked = new Set(); busy = false;
    $('rvxTitle').textContent = 'ขอกลับรายการปรับยอดสต๊อก';
    $('rvxBody').innerHTML = '<div class="rvx-load">กำลังโหลด…</div>'; $('rvxFoot').innerHTML = '<button type="button" class="rvx-btn" data-rvx="close">ปิด</button>';
    ov.style.display = 'flex'; document.body.style.overflow = 'hidden';
    try{
      const res = await fetch('/api/stock-adjust/reverse/' + encodeURIComponent(idUpdate));
      let j = null; try{ j = await res.json(); } catch(e){}
      if(!j || !j.success) throw new Error((j && j.message) || `โหลดข้อมูลไม่สำเร็จ (${res.status})`);
      data = j;
      data.lines.filter(l => l.state === 'ok').forEach(l => picked.add(l.id));
      render();
    } catch(err){ $('rvxBody').innerHTML = `<div class="rvx-err">${esc(err.message)}</div>`; }
  }
  const okLines = () => data.lines.filter(l => l.state === 'ok');
  function chip(l){ return l.state === 'ok' ? '<span class="rvx-chip">กลับรายการได้</span>' : `<span class="rvx-chip ${l.state}">${esc(STATE[l.state] || l.state)}</span><span class="rvx-msg">${esc(l.msg)}</span>`; }
  const opCls = (op) => op === '-' ? 'rvx-m' : op === '=' ? 'rvx-s' : 'rvx-p';
  function render(){
    const h = data.head, ok = okLines();
    $('rvxTitle').textContent = `ขอกลับรายการปรับยอดสต๊อก ${h.docCode}`;
    const allOn = ok.length && ok.every(l => picked.has(l.id));
    const rows = data.lines.map(l => `<tr class="${l.state === 'ok' ? '' : 'off'}">
        <td>${l.state === 'ok' ? `<input type="checkbox" class="rvx-ck" data-rvxpick="${l.id}" ${picked.has(l.id) ? 'checked' : ''} aria-label="เลือก Lot ${esc(l.lotNo)}">` : ''}</td>
        <td><span class="rvx-lot">${esc(l.lotNo)}</span><br>${esc(l.invName || '')}</td><td>${esc(l.wh || '-')}</td>
        <td class="n"><span class="${opCls(l.op)}">${sign(l.op)}${fmtQty(l.amount)}</span><br><small style="color:#b8c3d1">${fmtQty(l.before)} → ${fmtQty(l.after0)}</small></td>
        <td class="n"><span class="${opCls(l.revOp)}">${sign(l.revOp)}${fmtQty(l.revAmount)}</span></td>
        <td class="n">${fmtQty(l.now)}</td><td class="n"><b>${fmtQty(l.newAfter)}</b></td><td>${esc(l.unit || '')}</td><td class="st">${chip(l)}</td></tr>`).join('');
    const cards = data.lines.map(l => `<label class="rvx-card ${l.state === 'ok' ? (picked.has(l.id) ? 'sel' : '') : 'off'}">
        <div class="t">${l.state === 'ok' ? `<input type="checkbox" class="rvx-ck" data-rvxpick="${l.id}" ${picked.has(l.id) ? 'checked' : ''}>` : ''}<div><b>${esc(l.invName || '')}</b><div class="s"><span class="rvx-lot">${esc(l.lotNo)}</span> · ${esc(l.wh || '-')}</div></div></div>
        <div class="g"><div>ปรับเดิม<b class="${opCls(l.op)}">${sign(l.op)}${fmtQty(l.amount)}</b></div><div>กลับรายการ<b class="${opCls(l.revOp)}">${sign(l.revOp)}${fmtQty(l.revAmount)}</b></div>
          <div>คงเหลือ<b>${fmtQty(l.now)} → ${fmtQty(l.newAfter)}</b></div></div>
        <div class="s" style="margin-top:8px">${esc(l.unit || '')} ${l.state === 'ok' ? '' : '· ' + chip(l)}</div></label>`).join('');
    $('rvxBody').innerHTML = `
      <div class="rvx-meta"><div>เอกสารปรับเดิม<b>${esc(h.docCode)}</b></div><div>วันที่ปรับ<b>${thDate(h.date)}</b></div><div>ใบขอปรับยอด<b>${esc(h.rqCode || '-')}</b></div>
        <div class="w">เหตุผลเดิม<b>${esc(h.note || '-')}</b></div></div>
      ${h.isRev ? '<div class="rvx-err">เอกสารนี้เป็นการกลับรายการอยู่แล้ว — กลับรายการซ้ำไม่ได้</div>' : `
      <div class="rvx-info">ระบบจะสร้าง<b>ใบขอปรับยอดสต๊อกใหม่</b> ที่ปรับทิศตรงข้ามกับรายการที่เลือก (คิดจากยอดคงเหลือตอนนี้) — ต้องผ่าน รับทราบ → ตรวจสอบ → อนุมัติ ก่อนปรับสต๊อกจริง · Stock Card จะลงบรรทัดใหม่วันที่ปรับ หมายเหตุ "กลับรายการปรับยอดสต๊อก ${esc(h.docCode)}" (บรรทัดเดิมไม่ถูกแก้)</div>`}
      <div id="rvxErr"></div>
      ${!h.isRev && ok.length ? `<label class="rvx-all"><input type="checkbox" class="rvx-ck" data-rvxall="1" ${allOn ? 'checked' : ''}> เลือกทั้งหมดที่กลับรายการได้ (${ok.length})</label>` : ''}
      ${!h.isRev && !ok.length ? '<div class="rvx-err">ไม่มีรายการที่กลับรายการได้ในเอกสารนี้</div>' : ''}
      <div class="rvx-list"><table class="rvx-tbl"><thead><tr><th></th><th>Lot / สินค้า</th><th>คลัง</th><th class="n">ปรับเดิม</th><th class="n">กลับรายการ</th><th class="n">คงเหลือตอนนี้</th><th class="n">หลังกลับรายการ</th><th>หน่วย</th><th>สถานะ</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="rvx-cards">${cards}</div></div>
      ${!h.isRev && ok.length ? '<div class="rvx-fg"><label for="rvxNote">เหตุผลการกลับรายการ<span class="req">*</span></label><textarea id="rvxNote" maxlength="400" placeholder="เช่น ปรับผิด Lot / ใส่จำนวนผิด"></textarea></div>' : ''}`;
    foot();
  }
  function foot(){
    const can = data && !data.head.isRev && okLines().length;
    const n = picked.size, note = $('rvxNote') ? $('rvxNote').value.trim() : '';
    $('rvxFoot').innerHTML = `<button type="button" class="rvx-btn" data-rvx="close">ปิด</button>${can ? `<button type="button" class="rvx-btn go" data-rvx="send" ${n && note && !busy ? '' : 'disabled'} title="${!n ? 'เลือกรายการก่อน' : !note ? 'กรอกเหตุผลก่อน' : ''}">${UNDO} ส่งขอกลับรายการ (${n})</button>` : ''}`;
  }
  function onChange(e){
    const t = e.target;
    if(t.dataset.rvxpick){ const id = Number(t.dataset.rvxpick); if(t.checked) picked.add(id); else picked.delete(id); keepNote(render); }
    else if(t.dataset.rvxall){ okLines().forEach(l => t.checked ? picked.add(l.id) : picked.delete(l.id)); keepNote(render); }
  }
  // วาดใหม่โดยไม่ทิ้งเหตุผลที่พิมพ์ไว้
  function keepNote(fn){ const v = $('rvxNote') ? $('rvxNote').value : ''; fn(); if($('rvxNote')) $('rvxNote').value = v; foot(); }
  async function onClick(e){
    const t = e.target;
    if(t === ov && !busy){ close(); return; }
    const a = t.closest('[data-rvx]'); if(!a) return;
    if(a.dataset.rvx === 'close'){ if(!busy) close(); return; }
    if(a.dataset.rvx === 'send'){
      const note = $('rvxNote').value.trim();
      if(!picked.size || !note || busy) return;
      busy = true; a.disabled = true; a.innerHTML = 'กำลังส่ง…'; $('rvxErr').innerHTML = '';
      try{
        const res = await fetch('/api/stock-adjust/reverse/' + data.head.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...picked], note }) });
        let j = null; try{ j = await res.json(); } catch(x){}
        if(!j || !j.success) throw new Error((j && j.message) || `ส่งไม่สำเร็จ (${res.status})`);
        busy = false;
        $('rvxBody').innerHTML = `<div class="rvx-ok">สร้างใบขอกลับรายการ <b>${esc(j.rqCode)}</b> แล้ว (${j.lines} รายการ)<br>รอ รับทราบ → ตรวจสอบ → อนุมัติ — ระบบปรับสต๊อกจริงเมื่ออนุมัติครบ 3 ขั้น<br>ติดตามได้ที่เมนู รายการขอปรับยอดสต๊อก</div>`;
        $('rvxFoot').innerHTML = '<button type="button" class="rvx-btn" data-rvx="close">ปิด</button>';
        if(typeof opts.onDone === 'function') opts.onDone(j);
      } catch(err){
        busy = false; foot();
        $('rvxErr').innerHTML = `<div class="rvx-err">${esc(err.message)}</div>`; $('rvxErr').scrollIntoView({ block: 'nearest' });
      }
    }
  }
  window.AdjReverse = { open };
})();
