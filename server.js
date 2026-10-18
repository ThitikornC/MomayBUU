const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { WebSocketServer, WebSocket } = require('ws');
const org = require('./org');

const port = process.env.PORT || 8000;
const root = path.resolve(__dirname);

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://nippit62:ohm0966477158@testing.hgxbz.mongodb.net/?retryWrites=true&w=majority';
const DB_NAME = process.env.DB_NAME || 'momay_buu';
const COLLECTION_NAME = 'bookings';

// CCTV WebSocket Relay
const RELAY_KEY = process.env.RELAY_KEY || 'changeme';

// Control server URL (for Sonoff toggle proxy)
const CONTROL_URL = process.env.CONTROL_URL || 'https://controlbuu-production.up.railway.app';

// Auth: tokens are issued by the JWT auth backend (same one dashboard/auth.js logs in to)
const AUTH_URL = process.env.AUTH_URL || 'https://aut-production.up.railway.app';
// Optional: if the auth backend's HS256 secret is shared here, tokens are verified locally
// instead of calling AUTH_URL/api/auth/me
const JWT_SECRET = process.env.JWT_SECRET || '';
// Comma-separated emails allowed to delete any booking (others can delete only their own)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// CORS: comma-separated origins allowed to call the API cross-origin.
// Same-origin requests (the app and /dashboard served by this server) don't need to be listed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);

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
    await org.ensureOrgIndexes(db);
    await org.warnUnmigrated(db);
    
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
async function checkOverlap(currentOrg, room, date, startTime, endTime, excludeId = null) {
  const startMinutes = parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1]);
  const endMinutes = parseInt(endTime.split(':')[0]) * 60 + parseInt(endTime.split(':')[1]);
  
  const query = org.orgFilter(currentOrg, { room, date });
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

// ─── Auth helpers ───
function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Verify an HS256 JWT with JWT_SECRET. Returns the payload or null.
function verifyJwtLocally(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString());
    if (header.alg !== 'HS256') return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest();
    const actual = base64UrlDecode(parts[2]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString());
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Ask the auth backend who owns this token (GET /api/auth/me)
function fetchAuthMe(token) {
  return new Promise((resolve, reject) => {
    const meUrl = new URL('/api/auth/me', AUTH_URL);
    const proto = meUrl.protocol === 'https:' ? https : http;
    const authReq = proto.request(meUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
      timeout: 5000
    }, (aRes) => {
      let data = '';
      aRes.on('data', c => data += c);
      aRes.on('end', () => {
        if (aRes.statusCode !== 200) return resolve(null);
        try {
          const json = JSON.parse(data);
          resolve(json && json.user ? json.user : null);
        } catch (e) { resolve(null); }
      });
    });
    authReq.on('error', reject);
    authReq.on('timeout', () => { authReq.destroy(); reject(new Error('Timeout')); });
    authReq.end();
  });
}

// Short cache so every click doesn't round-trip to the auth backend
const AUTH_CACHE_MS = 60 * 1000;
const authCache = new Map();  // token -> { user, expires }

async function getUserFromToken(token) {
  if (JWT_SECRET) {
    const payload = verifyJwtLocally(token);
    if (!payload) return null;
    return {
      id: String(payload.id || payload.userId || payload.sub || ''),
      email: (payload.email || '').toLowerCase(),
      name: payload.name || ''
    };
  }

  const cached = authCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.user;

  const me = await fetchAuthMe(token);
  const user = me ? { id: String(me.id || me._id || ''), email: (me.email || '').toLowerCase(), name: me.name || '' } : null;
  if (user) {
    if (authCache.size > 1000) authCache.clear();
    authCache.set(token, { user, expires: Date.now() + AUTH_CACHE_MS });
  }
  return user;
}

// Returns the logged-in user, or sends 401/503 and returns null
async function requireAuth(req, res) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.statusCode = 401;
    res.end(JSON.stringify({ success: false, error: 'กรุณาเข้าสู่ระบบก่อน', code: 'AUTH_REQUIRED' }));
    return null;
  }
  try {
    const user = await getUserFromToken(token);
    if (!user) {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', code: 'AUTH_INVALID' }));
      return null;
    }
    return user;
  } catch (e) {
    res.statusCode = 503;
    res.end(JSON.stringify({ success: false, error: 'ไม่สามารถตรวจสอบสิทธิ์ได้ในขณะนี้' }));
    return null;
  }
}

function isAdmin(user) {
  return !!user.email && ADMIN_EMAILS.includes(user.email);
}

function setCorsHeaders(req, res) {
  const origin = (req.headers.origin || '').replace(/\/+$/, '');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  res.setHeader('Vary', 'Origin');
}

// API Routes
async function handleAPI(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method;
  
  // CORS: only origins in ALLOWED_ORIGINS get Access-Control-Allow-* headers
  setCorsHeaders(req, res);
  res.setHeader('Content-Type', 'application/json');
  
  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  // Every API call is for one organization (see org.js for how it is chosen)
  let currentOrg;
  try {
    currentOrg = await org.resolveOrg(db, req, res);
  } catch (error) {
    res.statusCode = 503;
    res.end(JSON.stringify({ success: false, error: 'ฐานข้อมูลไม่พร้อมใช้งาน' }));
    return true;
  }
  if (!currentOrg) return true;
  
  // GET /api/org/config - The organization's rooms, meters and public settings
  // (replaces the room lists and service URLs that were hardcoded in script.js / dashboard/script.js)
  if (url === '/api/org/config' && method === 'GET') {
    try {
      const config = await org.buildOrgConfig(db, currentOrg);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: config }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return true;
  }

  // GET /api/bookings - Get all bookings or filter by date/room
  if (url === '/api/bookings' && method === 'GET') {
    try {
      const urlParams = new URL(req.url, `http://localhost:${port}`);
      const date = urlParams.searchParams.get('date');
      const room = urlParams.searchParams.get('room');
      
      const query = org.orgFilter(currentOrg);
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
    const user = await requireAuth(req, res);
    if (!user) return true;
    try {
      const body = await parseBody(req);
      const { room, date, startTime, endTime, bookerName, purpose } = body;
      
      if (!room || !date || !startTime || !endTime || !bookerName) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Missing required fields' }));
        return true;
      }
      const newRoom = room.replace(/\s*▼\s*/, '').trim();  // strip UI dropdown symbol
      const roomDoc = await db.collection('rooms').findOne(org.orgFilter(currentOrg, { key: newRoom }));
      if (!roomDoc || roomDoc.bookable === false) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'ไม่พบห้องนี้ในองค์กร' }));
        return true;
      }
      
      // Check for overlapping bookings
      const overlapCheck = await checkOverlap(currentOrg, newRoom, date, startTime, endTime);
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
        orgId: currentOrg._id,
        bookingId,
        room: newRoom,
        roomId: roomDoc._id,
        date,
        startTime,
        endTime,
        bookerName,
        purpose: purpose || '',
        color,
        ownerId: user.id,  // auth user id, used to allow the owner to delete
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
      const bookings = await db.collection(COLLECTION_NAME).find(org.orgFilter(currentOrg, {
        date: today
      })).toArray();
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
  
  // POST /api/toggle-device — proxy to Control server to toggle Sonoff
  if (url === '/api/toggle-device' && method === 'POST') {
    const user = await requireAuth(req, res);
    if (!user) return true;
    try {
      const body = await parseBody(req);
      const { room, action } = body;
      if (!room || !action) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Missing room or action' }));
        return true;
      }
      const roomDoc = await db.collection('rooms').findOne(org.orgFilter(currentOrg, { key: room }));
      if (!roomDoc) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'ไม่พบห้องนี้ในองค์กร' }));
        return true;
      }

      // Forward to Control server
      const payload = JSON.stringify({ room, action });
      const controlUrl = new URL('/toggle', org.controlUrlFor(currentOrg, CONTROL_URL));

      const proxyRes = await new Promise((resolve, reject) => {
        const proto = controlUrl.protocol === 'https:' ? https : http;
        const proxyReq = proto.request(controlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 5000
        }, (pRes) => {
          let data = '';
          pRes.on('data', c => data += c);
          pRes.on('end', () => resolve({ status: pRes.statusCode, body: data }));
        });
        proxyReq.on('error', reject);
        proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Timeout')); });
        proxyReq.write(payload);
        proxyReq.end();
      });

      res.statusCode = proxyRes.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(proxyRes.body);
    } catch (error) {
      res.statusCode = 502;
      res.end(JSON.stringify({ success: false, error: 'Control server unreachable: ' + error.message }));
    }
    return true;
  }

  // GET /api/room-state — proxy to Control server for device state
  if (url === '/api/room-state' && method === 'GET') {
    try {
      const controlUrl = new URL('/room-state', org.controlUrlFor(currentOrg, CONTROL_URL));
      const proto = controlUrl.protocol === 'https:' ? require('https') : require('http');
      const proxyRes = await new Promise((resolve, reject) => {
        const proxyReq = proto.request(controlUrl, { method: 'GET', timeout: 5000 }, (pRes) => {
          let data = '';
          pRes.on('data', c => data += c);
          pRes.on('end', () => resolve({ status: pRes.statusCode, body: data }));
        });
        proxyReq.on('error', reject);
        proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Timeout')); });
        proxyReq.end();
      });
      res.statusCode = proxyRes.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(proxyRes.body);
    } catch (error) {
      res.statusCode = 502;
      res.end(JSON.stringify({ success: false, error: 'Control server unreachable' }));
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

      const booking = await db.collection(COLLECTION_NAME).findOne(org.orgFilter(currentOrg, { bookingId }));

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
          { _id: booking._id },
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
        orgId: currentOrg._id,
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

      const query = org.orgFilter(currentOrg);
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
    const user = await requireAuth(req, res);
    if (!user) return true;
    try {
      const id = url.split('/').pop();
      if (!ObjectId.isValid(id)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Invalid booking id' }));
        return true;
      }

      const booking = await db.collection(COLLECTION_NAME).findOne(org.orgFilter(currentOrg, { _id: new ObjectId(id) }));
      if (!booking) {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: 'Booking not found' }));
        return true;
      }

      // Owner or admin only (bookings made before auth have no owner → admin only)
      const isOwner = !!booking.ownerId && booking.ownerId === user.id;
      if (!isOwner && !isAdmin(user)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ success: false, error: 'ไม่มีสิทธิ์ลบการจองนี้' }));
        return true;
      }

      await db.collection(COLLECTION_NAME).deleteOne({ _id: booking._id });
      
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
  let decoded = decodeURIComponent(req.url.split('?')[0]);

  // /o/<slug>/... serves the same app for one organization; the cookie tells the API which one
  let pageOrgSlug = org.DEFAULT_ORG_SLUG;
  const orgPath = org.matchOrgPath(decoded);
  if (orgPath) {
    if (decoded === `/o/${orgPath.slug}`) {
      // trailing slash so the page's relative URLs (script.js, images/...) resolve under /o/<slug>/
      res.statusCode = 301;
      res.setHeader('Location', `/o/${orgPath.slug}/`);
      res.end();
      return;
    }
    pageOrgSlug = orgPath.slug;
    decoded = orgPath.rest;
  }

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
      if (ct.includes('html')) {
        res.setHeader('Set-Cookie', org.orgCookieHeader(pageOrgSlug));
      }
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