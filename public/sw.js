/* ==================================================================
   Service worker ของ WIM — มีไว้ให้เบราว์เซอร์ยอมให้ "ติดตั้งแอป" เท่านั้น
   ------------------------------------------------------------------
   - ไม่เก็บหน้าเว็บ / ข้อมูล ไว้ในเครื่อง: ทุกคำขอไปที่ server ตามปกติ (ตัวเลขไม่ค้างของเก่า)
   - ต่อเน็ตไม่ได้ตอนเปิดหน้า: แสดงหน้าแจ้งสั้น ๆ แทนหน้าข้อผิดพลาดของเบราว์เซอร์
   ไฟล์นี้ต้องอยู่ที่ราก (/sw.js) เพื่อให้ครอบทุกหน้าของเว็บ
================================================================== */
const OFFLINE_HTML = `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>WIM — ไม่มีอินเทอร์เน็ต</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c1420;color:#e7e4da;font-family:sans-serif;text-align:center;padding:20px;box-sizing:border-box">
<div><div style="font-size:20px;font-weight:700;color:#fff;margin-bottom:8px">เชื่อมต่ออินเทอร์เน็ตไม่ได้</div>
<p style="color:#b9b4a5;margin:0 0 20px">ตรวจสอบสัญญาณแล้วลองใหม่อีกครั้ง</p>
<button onclick="location.reload()" style="min-height:44px;padding:0 24px;border-radius:8px;border:none;background:#f2a91c;color:#0c1420;font-size:15px;font-weight:700">ลองใหม่</button></div>
</body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // ไฟล์ / API ให้เบราว์เซอร์จัดการเองตามปกติ
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  );
});
