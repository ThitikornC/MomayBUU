# MomayBUU Dashboard

แดชบอร์ดสำหรับระบบ CS by Momay — ระบบบริหารจัดการห้องอัจฉริยะ สำนักหอสมุด มหาวิทยาลัยบูรพา

## โครงสร้าง 4 ส่วนหลัก

### 1. ภาพรวมข้อมูล
- **โหมดไฟฟ้า** — ค่าไฟวันนี้, พลังงาน (kWh), Peak/Avg Power, กราฟกำลังไฟรายนาที, ค่าไฟรายชั่วโมง, กลางวัน vs กลางคืน (7 วัน)
- **โหมดการจอง** — จำนวนจอง, Check-in Rate, ใช้งานตอนนี้, ถูกปฏิเสธ, สถานะห้อง, กราฟ 7 วัน, Heatmap, ตารางรายการจอง
- รองรับการกรองตามวันที่และห้อง

### 2. แผงควบคุม
- ควบคุมอุปกรณ์ Sonoff/Tasmota แต่ละห้อง
- แสดงสถานะ ON/OFF พร้อม animation (glow effect)
- คลิกเพื่อ toggle อุปกรณ์ผ่าน API

### 3. แจ้งเตือน
- สร้างอัตโนมัติจากข้อมูลการจองและ access log
  - ห้องกำลังใช้งาน (สีเขียว)
  - ใกล้ถึงเวลาจอง ยังไม่ Check-in (สีส้ม)
  - หมดเวลาโดยไม่มี Check-in (สีแดง)
  - ถูกปฏิเสธเข้าใช้ (สีแดง)
  - เข้าใช้ QR สำเร็จ (สีฟ้า)

### 4. ประชาสัมพันธ์
- สร้างข้อความประชาสัมพันธ์เพื่อแสดงใน CS by Momay
- ตั้งวันหมดอายุและระดับความสำคัญ (ทั่วไป / สำคัญ / เร่งด่วน)
- ลบข้อความที่ไม่ต้องการได้

## ไฟล์

| ไฟล์ | คำอธิบาย |
|-------|----------|
| `index.html` | โครงสร้าง HTML — sidebar, 4 sections, mode tabs |
| `style.css` | Dark theme, responsive, device animations |
| `script.js` | Fetch APIs, Chart.js rendering, CRUD announcements |

## API ที่ใช้

| Endpoint | Method | คำอธิบาย |
|----------|--------|----------|
| `/api/bookings?date=&room=` | GET | ดึงข้อมูลการจอง |
| `/api/logs?date=` | GET | Access logs |
| `/api/room-state` | GET | สถานะอุปกรณ์แต่ละห้อง |
| `/api/toggle-device` | POST | Toggle อุปกรณ์ |
| `/api/announcements` | GET | รายการประชาสัมพันธ์ |
| `/api/announcements` | POST | สร้างประชาสัมพันธ์ |
| `/api/announcements/:id` | DELETE | ลบประชาสัมพันธ์ |

### Energy API (External)
- Base: `https://momatdeerbn-production.up.railway.app`
- `/daily-bill?date=` — ค่าไฟรายวัน
- `/hourly-bill/{date}` — ค่าไฟรายชั่วโมง
- `/daily-energy/pm_deer?date=` — ข้อมูลกำลังไฟรายนาที
- `/solar-size?date=` — กลางวัน/กลางคืน

## การใช้งาน

Dashboard ถูก serve ผ่าน main server (port 8000) โดยเข้าที่:

```
http://localhost:8000/dashboard/
```

ไม่ต้องติดตั้งอะไรเพิ่ม — ใช้ Chart.js ผ่าน CDN
