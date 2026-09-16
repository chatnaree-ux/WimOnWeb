# WIM Login API

Backend สำหรับเชื่อมต่อ SQL Server (`GR_Group`) โดยหน้าเว็บ (`public/index.html`) จะเรียก API นี้แทนการต่อฐานข้อมูลตรงจาก browser

## วิธีติดตั้งและรัน

1. ติดตั้ง [Node.js](https://nodejs.org) เวอร์ชัน 18 ขึ้นไป
2. เปิด terminal ไปที่โฟลเดอร์นี้ แล้วรัน:
   ```bash
   npm install
   ```
3. ตรวจสอบไฟล์ `.env` ว่าค่าการเชื่อมต่อถูกต้อง (server, database, user, password)
4. รัน server:
   ```bash
   npm start
   ```
5. เปิดเบราว์เซอร์ไปที่ `http://localhost:3001` จะเห็นหน้า WIM พร้อมฟอร์ม login
   ที่เชื่อมกับฐานข้อมูลจริงแล้ว

## ก่อนใช้งานจริง ต้องตรวจสอบ 
 **Firewall / การเข้าถึง SQL Server จาก IP นี้** — ต้องแน่ใจว่าเครื่องที่รัน server.js
   สามารถเข้าถึง `203.151.27.229:1433` ได้ (เปิด port และอนุญาต IP ที่ SQL Server แล้ว)

## ความปลอดภัยที่ควรทำเพิ่มก่อนขึ้น production

- อย่า commit ไฟล์ `.env` เข้า git (มี `.gitignore` เตรียมไว้ให้แล้ว)
- เปลี่ยนรหัสผ่าน DB เป็นระยะ และใช้ user ที่มีสิทธิ์จำกัดเฉพาะ SELECT บน view ที่จำเป็น
- เพิ่ม rate limiting กับ endpoint `/api/login` เพื่อกัน brute-force
- ถ้ารหัสผ่านยังเป็น plain text ควรวางแผน migrate ไปใช้ hash (bcrypt) โดยเร็ว
- เปิดใช้ HTTPS เมื่อ deploy จริง (ตอนนี้ตัวอย่างรันแบบ HTTP บนเครื่อง local)

## ทดสอบว่าเชื่อมต่อ DB สำเร็จหรือไม่

หลังรัน server แล้ว เปิด:
```
http://localhost:3001/api/health
```
ถ้าเชื่อมต่อสำเร็จจะเห็น `{ "success": true, "message": "เชื่อมต่อฐานข้อมูลปกติ" }`
