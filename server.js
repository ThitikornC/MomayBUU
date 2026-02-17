const http = require('http');
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { WebSocketServer, WebSocket } = require('ws');

const port = process.env.PORT || 8000;
const root = path.resolve(__dirname);

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://nippit62:ohm0966477158@testing.hgxbz.mongodb.net/?retryWrites=true&w=majority';
const DB_NAME = 'momay_buu';
const COLLECTION_NAME = 'bookings';

// CCTV WebSocket Relay
const RELAY_KEY = process.env.RELAY_KEY || 'changeme';
let relaySocket = null;
const viewerClients = new Set();
let latestFrame = null;  // เก็บ frame ล่าสุดให้ viewer ใหม่เห็นทันที

let db = null;

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    
    // Create indexes for faster queries
    await db.collection(COLLECTION_NAME).createIndex({ date: 1, room: 1 });
    await db.collection(COLLECTION_NAME).createIndex({ bookingId: 1 }, { unique: true });
    
    console.log('Connected to MongoDB with indexes');
  } catch (error) {
    console.error('MongoDB connection error:', error);
  }
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html';
    case '.js': return 'application/javascript';
    case '.css': return 'text/css';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

// Parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Check for overlapping bookings
async function checkOverlap(room, date, startTime, endTime, excludeId = null) {
  const startMinutes = parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1]);
  const endMinutes = parseInt(endTime.split(':')[0]) * 60 + parseInt(endTime.split(':')[1]);
  
  const query = { room, date };
  if (excludeId) {
    query._id = { $ne: new ObjectId(excludeId) };
  }
  
  const existingBookings = await db.collection(COLLECTION_NAME).find(query).toArray();
  
  for (const booking of existingBookings) {
    const existingStart = parseInt(booking.startTime.split(':')[0]) * 60 + parseInt(booking.startTime.split(':')[1]);
    const existingEnd = parseInt(booking.endTime.split(':')[0]) * 60 + parseInt(booking.endTime.split(':')[1]);
    
    // Check overlap: (start1 < end2) && (end1 > start2)
    if (startMinutes < existingEnd && endMinutes > existingStart) {
      return {
        overlap: true,
        conflictWith: booking
      };
    }
  }
  
  return { overlap: false };
}

// API Routes
async function handleAPI(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method;
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  
  if (method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return true;
  }
  
  // GET /api/bookings - Get all bookings or filter by date/room
  if (url === '/api/bookings' && method === 'GET') {
    try {
      const urlParams = new URL(req.url, `http://localhost:${port}`);
      const date = urlParams.searchParams.get('date');
      const room = urlParams.searchParams.get('room');
      
      const query = {};
      if (date) query.date = date;
      if (room) query.room = room;
      
      const bookings = await db.collection(COLLECTION_NAME).find(query).toArray();
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: bookings }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return true;
  }
  
  // POST /api/bookings - Create new booking
  if (url === '/api/bookings' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const { room, date, startTime, endTime, bookerName, purpose } = body;
      
      if (!room || !date || !startTime || !endTime || !bookerName) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Missing required fields' }));
        return true;
      }
      
      // Check for overlapping bookings
      const overlapCheck = await checkOverlap(room, date, startTime, endTime);
      if (overlapCheck.overlap) {
        res.statusCode = 409;
        res.end(JSON.stringify({ 
          success: false, 
          error: `เวลา ${overlapCheck.conflictWith.startTime} - ${overlapCheck.conflictWith.endTime} มีผู้จองแล้ว (${overlapCheck.conflictWith.bookerName})`,
          conflictWith: overlapCheck.conflictWith
        }));
        return true;
      }
      
      // Generate booking ID
      const bookingId = `BK${Date.now().toString(36).toUpperCase()}`;
      
      // Random color for display
      const colors = ["#4dd0e1", "#81c784", "#ffb74d", "#ba68c8", "#64b5f6"];
      const color = colors[Math.floor(Math.random() * colors.length)];
      
      const newBooking = {
        bookingId,
        room: (room || '').replace(/\s*▼\s*/, '').trim(),  // strip UI dropdown symbol
        date,
        startTime,
        endTime,
        bookerName,
        purpose: purpose || '',
        color,
        createdAt: new Date().toISOString()
      };
      
      const result = await db.collection(COLLECTION_NAME).insertOne(newBooking);
      newBooking._id = result.insertedId;
      
      res.statusCode = 201;
      res.end(JSON.stringify({ success: true, data: newBooking }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return true;
  }
  
  // GET /api/active-booking - Get current active booking for a room
  if (url.startsWith('/api/active-booking') && method === 'GET') {
    try {
      const urlParams = new URL(req.url, `http://localhost:${port}`);
      const room = urlParams.searchParams.get('room');
      
      if (!room) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Missing room parameter' }));
        return true;
      }
      
      const now = new Date();
      // ใช้ Bangkok timezone (UTC+7)
      const bangkokNow = new Date(now.getTime() + (7 * 60 * 60 * 1000));
      const today = bangkokNow.toISOString().split('T')[0];
      const bangkokHours = bangkokNow.getUTCHours();
      const bangkokMinutes = bangkokNow.getUTCMinutes();
      const bangkokSeconds = bangkokNow.getUTCSeconds();
      const currentMinutes = bangkokHours * 60 + bangkokMinutes;
      
      // Find bookings for today and this room (strip ▼ for matching)
      const cleanRoom = (room || '').replace(/\s*▼\s*/, '').trim();
      const bookings = await db.collection(COLLECTION_NAME).find({
        date: today
      }).toArray();
      // Filter by room name (handle ▼ suffix in stored data)
      const roomBookings = bookings.filter(b => (b.room || '').replace(/\s*▼\s*/, '').trim() === cleanRoom);
      
      // Find the active booking (current time is within booking window, with 15 min early allowance)
      let activeBooking = null;
      for (const booking of roomBookings) {
        const [startH, startM] = booking.startTime.split(':').map(Number);
        const [endH, endM] = booking.endTime.split(':').map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        
        if (currentMinutes >= startMinutes - 15 && currentMinutes <= endMinutes) {
          activeBooking = booking;
          break;
        }
      }
      
      if (activeBooking) {
        // Calculate remaining seconds (Bangkok timezone)
        const [endH, endM] = activeBooking.endTime.split(':').map(Number);
        const currentSecs = bangkokHours * 3600 + bangkokMinutes * 60 + bangkokSeconds;
        const endSecs = endH * 3600 + endM * 60;
        const remainingSeconds = Math.max(0, endSecs - currentSecs);
        
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          hasActiveBooking: true,
          isCheckedIn: !!activeBooking.firstCheckIn,
          firstCheckIn: activeBooking.firstCheckIn || null,
          remainingSeconds: remainingSeconds,
          booking: {
            bookingId: activeBooking.bookingId,
            room: activeBooking.room,
            date: activeBooking.date,
            startTime: activeBooking.startTime,
            endTime: activeBooking.endTime,
            bookerName: activeBooking.bookerName,
            purpose: activeBooking.purpose
          }
        }));
      } else {
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          hasActiveBooking: false,
          message: 'ไม่มีการจองในเวลานี้'
        }));
      }
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return true;
  }
  
  // POST /api/verify - Verify QR code for room access
  if (url === '/api/verify' && method === 'POST') {
    try {
      const body = await parseBody(req);
      let { qrData } = body;

      if (!qrData) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'ไม่พบข้อมูล QR Code' }));
        return true;
      }

      let bookingId = qrData;
      if (qrData.startsWith('BK:')) {
        bookingId = qrData.substring(3);
      }

      const booking = await db.collection(COLLECTION_NAME).findOne({ bookingId });

      if (!booking) {
        res.statusCode = 404;
        res.end(JSON.stringify({
          success: false,
          access: false,
          error: 'ไม่พบข้อมูลการจอง',
          bookingId
        }));
        return true;
      }

      // Check if within booking time (use Bangkok timezone UTC+7)
      const now = new Date();
      const bangkokNow = new Date(now.getTime() + (7 * 60 * 60 * 1000));
      const today = bangkokNow.toISOString().split('T')[0];
      const bangkokHours = bangkokNow.getUTCHours();
      const bangkokMinutes = bangkokNow.getUTCMinutes();
      const bangkokSeconds = bangkokNow.getUTCSeconds();
      let timeCheck = { valid: false, reason: 'unknown', message: '' };

      if (booking.date !== today) {
        const bookingDate = new Date(booking.date);
        const todayDate = new Date(today);
        if (bookingDate < todayDate) {
          timeCheck = { valid: false, reason: 'expired', message: 'การจองนี้หมดอายุแล้ว' };
        } else {
          timeCheck = { valid: false, reason: 'not_today', message: `การจองนี้สำหรับวันที่ ${booking.date}` };
        }
      } else {
        const [startHour, startMin] = booking.startTime.split(':').map(Number);
        const [endHour, endMin] = booking.endTime.split(':').map(Number);
        const currentMinutes = bangkokHours * 60 + bangkokMinutes;
        const startMinutes = startHour * 60 + startMin;
        const endMinutes = endHour * 60 + endMin;
        const earlyAllowance = 15;

        if (currentMinutes < startMinutes - earlyAllowance) {
          const waitMinutes = startMinutes - earlyAllowance - currentMinutes;
          timeCheck = { valid: false, reason: 'too_early', message: `ยังไม่ถึงเวลา กรุณารออีก ${waitMinutes} นาที` };
        } else if (currentMinutes > endMinutes) {
          timeCheck = { valid: false, reason: 'too_late', message: 'เลยเวลาการจองแล้ว' };
        } else {
          timeCheck = { valid: true, reason: 'ok', message: 'เข้าห้องได้' };
        }
      }

      // Handle first check-in
      let firstCheckIn = booking.firstCheckIn;
      let isFirstCheckIn = false;
      if (timeCheck.valid && !firstCheckIn) {
        firstCheckIn = now.toISOString();
        isFirstCheckIn = true;
        await db.collection(COLLECTION_NAME).updateOne(
          { bookingId: booking.bookingId },
          { $set: { firstCheckIn: firstCheckIn } }
        );
      }

      // Calculate remaining seconds (Bangkok time)
      const [endH, endM] = booking.endTime.split(':').map(Number);
      const currentSecs = bangkokHours * 3600 + bangkokMinutes * 60 + bangkokSeconds;
      const endSecs = endH * 3600 + endM * 60;
      const remainingSeconds = Math.max(0, endSecs - currentSecs);

      // Log access
      await db.collection('access_logs').insertOne({
        bookingId: booking.bookingId,
        room: booking.room,
        bookerName: booking.bookerName,
        attemptTime: now.toISOString(),
        accessGranted: timeCheck.valid,
        reason: timeCheck.reason,
        isFirstCheckIn: isFirstCheckIn
      });

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        access: timeCheck.valid,
        message: timeCheck.message,
        reason: timeCheck.reason,
        isFirstCheckIn: isFirstCheckIn,
        firstCheckIn: firstCheckIn,
        remainingSeconds: remainingSeconds,
        booking: {
          bookingId: booking.bookingId,
          room: booking.room,
          date: booking.date,
          startTime: booking.startTime,
          endTime: booking.endTime,
          bookerName: booking.bookerName,
          purpose: booking.purpose
        }
      }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return true;
  }

  // GET /api/logs - Access logs
  if (url.startsWith('/api/logs') && method === 'GET') {
    try {
      const urlParams = new URL(req.url, `http://localhost:${port}`);
      const date = urlParams.searchParams.get('date');
      const room = urlParams.searchParams.get('room');

      const query = {};
      if (date) {
        query.attemptTime = {
          $gte: `${date}T00:00:00`,
          $lte: `${date}T23:59:59`
        };
      }
      if (room) query.room = room;

      const logs = await db.collection('access_logs')
        .find(query)
        .sort({ attemptTime: -1 })
        .limit(100)
        .toArray();

      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: logs }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return true;
  }

  // DELETE /api/bookings/:id - Delete booking
  if (url.startsWith('/api/bookings/') && method === 'DELETE') {
    try {
      const id = url.split('/').pop();
      const result = await db.collection(COLLECTION_NAME).deleteOne({ _id: new ObjectId(id) });
      
      if (result.deletedCount === 0) {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: 'Booking not found' }));
        return true;
      }
      
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, message: 'Booking deleted' }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return true;
  }
  
  return false;
}

const server = http.createServer(async (req, res) => {
  // Handle API routes first
  if (req.url.startsWith('/api/')) {
    await handleAPI(req, res);
    return;
  }
  
  // Static file serving
  const decoded = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(root, decoded);
  if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
  if (!filePath.startsWith(root)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 500;
        res.end('Server error');
        return;
      }
      const ct = getContentType(filePath);
      res.setHeader('Content-Type', ct);
      // ไม่ให้ browser cache HTML/JS/CSS เพื่อให้ได้ไฟล์ใหม่ทุกครั้ง
      if (ct.includes('html') || ct.includes('javascript') || ct.includes('css')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
      }
      res.end(data);
    });
  });
});

// ─── CCTV WebSocket Relay ───
const wssRelay  = new WebSocketServer({ noServer: true });
const wssViewer = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname === '/ws/relay') {
    const key = url.searchParams.get('key');
    if (key !== RELAY_KEY) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      console.log('[CCTV] Relay rejected — bad key');
      return;
    }
    wssRelay.handleUpgrade(req, socket, head, ws => wssRelay.emit('connection', ws));
  } else if (url.pathname === '/ws/stream') {
    wssViewer.handleUpgrade(req, socket, head, ws => wssViewer.emit('connection', ws));
  } else {
    socket.destroy();
  }
});

// Relay: receives JPEG frames from local relay.py
wssRelay.on('connection', (ws) => {
  if (relaySocket) {
    try { relaySocket.close(); } catch(e) {}
    console.log('[CCTV] Replaced existing relay');
  }
  relaySocket = ws;
  console.log(`[CCTV] ✓ Relay connected — viewers: ${viewerClients.size}`);

  ws.on('message', (data) => {
    latestFrame = data;
    for (const v of viewerClients) {
      if (v.readyState === WebSocket.OPEN) {
        v.send(data, { binary: true });
      }
    }
  });

  ws.on('close', () => {
    console.log('[CCTV] ✗ Relay disconnected');
    if (relaySocket === ws) {
      relaySocket = null;
      latestFrame = null;
      // แจ้ง viewers ทั้งหมดว่า relay หลุด
      for (const v of viewerClients) {
        if (v.readyState === WebSocket.OPEN) {
          try { v.send('relay_offline'); } catch(e) {}
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[CCTV] Relay error:', err.message);
    if (relaySocket === ws) {
      relaySocket = null;
      latestFrame = null;
      for (const v of viewerClients) {
        if (v.readyState === WebSocket.OPEN) {
          try { v.send('relay_offline'); } catch(e) {}
        }
      }
    }
  });
});

// Viewer: browser connects to watch stream
wssViewer.on('connection', (ws) => {
  viewerClients.add(ws);
  console.log(`[CCTV] + Viewer — total: ${viewerClients.size}`);

  // ส่ง frame ล่าสุดให้เห็นภาพทันทีไม่ต้องรอ
  if (latestFrame) {
    try { ws.send(latestFrame, { binary: true }); } catch(e) {}
  }

  ws.on('close', () => {
    viewerClients.delete(ws);
    console.log(`[CCTV] - Viewer — total: ${viewerClients.size}`);
  });
  ws.on('error', () => viewerClients.delete(ws));
});

// Connect to DB then start server
connectDB().then(() => {
  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
    console.log(`[CCTV] Relay: ws://localhost:${port}/ws/relay?key=***`);
    console.log(`[CCTV] Stream: ws://localhost:${port}/ws/stream`);
  });
});