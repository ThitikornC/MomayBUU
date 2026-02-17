# MomayBUU CCTV — RTSP to Web Streaming (Python)

ระบบส่งภาพกล้อง CCTV (RTSP) ขึ้นแสดงบน Web ผ่าน WebSocket (JPEG frames)

## Architecture

```
[กล้อง CCTV]
     │ RTSP
     ▼
[relay.py]   ← รันบนเครื่อง local (OpenCV จับภาพ → JPEG)
     │ WebSocket
     ▼
[server.py]  ← รันบน Railway (FastAPI, รับ JPEG → broadcast)
     │ WebSocket
     ▼
[Browser]    ← <img> แสดง JPEG frames ใน popup MomayBUU
```

## Setup

### 1. Deploy server.py บน Railway

```bash
cd cctv/
# ตั้ง Environment Variables บน Railway:
#   PORT=3100
#   RELAY_KEY=your-secret-key
```

ใช้ Dockerfile ที่ให้มา หรือ Railway จะ auto-detect Python

### 2. รัน relay.py บนเครื่อง local

```bash
cd cctv/
cp .env.example .env
# แก้ไข .env ตามกล้อง

pip install -r requirements.txt
python relay.py
```

### 3. ดูผ่านหน้า MomayBUU

กดไอคอน CCTV → popup แสดง live stream

## Environment Variables

| Variable | ใช้ที่ | Default | คำอธิบาย |
|----------|--------|---------|----------|
| `PORT` | server | 3100 | พอร์ต |
| `RELAY_KEY` | ทั้งคู่ | changeme | รหัส relay |
| `RTSP_URL` | relay | - | URL กล้อง |
| `SERVER_URL` | relay | ws://localhost:3100/ws/relay | URL server |
| `FRAME_WIDTH` | relay | 640 | ความกว้าง |
| `FRAME_HEIGHT` | relay | 480 | ความสูง |
| `FPS` | relay | 12 | FPS |
| `JPEG_QUALITY` | relay | 60 | คุณภาพ JPEG (1-100) |
