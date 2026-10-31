# ทดสอบ iPhone (WebKit จริง)

```
cd tools/mobile-test
npm i            # ครั้งแรก (แล้ว npx playwright install webkit)
node run.js                      # ทุกหน้า
node run.js supplier-return      # เฉพาะบางหน้า
```
จำลอง iPhone 14 (390x844) ไม่ต่อฐานข้อมูล (`fixtures.js` จำลอง /api/*) ตรวจ: หน้าเลื่อนข้าง, ล้นขอบจอ, ปุ่มแถวเดียวกันสูงไม่เท่ากัน, แตะยาก (<32px), ช่องกรอก <16px (iOS ซูม), ข้อความถูกตัด, ตารางกว้าง, JS error — ภาพเต็มหน้าอยู่ `out/`.
หน้าใหม่: เพิ่มข้อมูลจำลองใน `fixtures.js` ให้เห็นสถานะที่มีข้อมูล แล้วรันก่อนส่งงานทุกครั้ง
