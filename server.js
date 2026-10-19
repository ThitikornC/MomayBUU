const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { WebSocketServer, WebSocket } = require('ws');
const org = require('./org');
const members = require('./members');
const orgRoutes = require('./org-routes');
const security = require('./security');
const zlib = require('zlib');

const port = process.env.PORT || 8000;
const root = path.resolve(__dirname);

// MongoDB Connection
// ต้องตั้งค่า MONGODB_URI เป็น environment variable (ดู .env.example)
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set. Set it as an environment variable (see .env.example).');
  process.exit(1);
}
const DB_NAME = process.env.DB_NAME || 'momay_buu';
const COLLECTION_NAME = 'bookings';

// CCTV WebSocket Relay
// ถ้าไม่ได้ตั้ง RELAY_KEY จะปฏิเสธการเชื่อมต่อจาก relay ทั้งหมด
const RELAY_KEY = process.env.RELAY_KEY;
if (!RELAY_KEY) console.warn('⚠️ RELAY_KEY is not set — CCTV relay connections will be rejected.');

// Control server URL (for Sonoff toggle proxy)
const CONTROL_URL = process.env.CONTROL_URL || 'https://controlbuu-production.up.railway.app';

// Auth: tokens are issued by the JWT auth backend (same one dashboard/auth.js logs in to)
const AUTH_URL = process.env.AUTH_URL || 'https://aut-production.up.railway.app';
// Optional: if the auth backend's HS256 secret is shared here, tokens are verified locally
// instead of calling AUTH_URL/api/auth/me
const JWT_SECRET = process.env.JWT_SECRET || '';

// Optional: when set, POST /api/verify (the door QR scanner) must send this key
// in the X-Scanner-Key header
const SCANNER_KEY = process.env.SCANNER_KEY || '';

// Largest JSON body the API accepts
const MAX_JSON_BYTES = 100 * 1024;

// CORS: comma-separated origins allowed to call the API cross-origin.
// Same-origin requests (the app and /dashboard served by this server) don't need to be listed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);

// CCTV streams, one per organization: orgId -> { relay, viewers, latestFrame }
// latestFrame: เก็บ frame ล่าสุดให้ viewer ใหม่เห็นทันที
const cctvStreams = new Map();
function cctvStream(orgId) {
  const key = String(orgId);
  if (!cctvStreams.has(key)) cctvStreams.set(key, { relay: null, viewers: new Set(), latestFrame: null });
  return cctvStreams.get(key);
}

let db = null;

// Connects to MongoDB, retrying with backoff. The server already listens meanwhile:
// /healthz answers 503 and the API answers "database not ready" until this succeeds.
async function connectDB() {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const database = client.db(DB_NAME);

      // Create indexes for faster queries
      await database.collection(COLLECTION_NAME).createIndex({ date: 1, room: 1 });
      await database.collection(COLLECTION_NAME).createIndex({ bookingId: 1 }, { unique: true });
      await org.ensureOrgIndexes(database);
      await org.warnUnmigrated(database);

      db = database;
      console.log('Connected to MongoDB with indexes');
      return;
    } catch (error) {
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      console.error(`MongoDB connection error (attempt ${attempt}), retrying in ${delay / 1000}s:`, error.message);
      await new Promise(r => setTimeout(r, delay));
    }
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
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

class BodyTooLargeError extends Error {}

// Parse JSON body (at most MAX_JSON_BYTES). Always resolves to a plain object.
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_JSON_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_JSON_BYTES) return reject(new BodyTooLargeError('Body too large'));
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('Expected a JSON object');
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Logs an unexpected error and answers with a generic message (details stay in the server log)
function sendServerError(res, error, status = 500) {
  console.error('[api]', error);
  if (res.headersSent) return res.end();
  res.statusCode = status;
  res.end(JSON.stringify({ success: false, error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' }));
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

// The user's booking for this room that is running now (with the organization's early
// allowance), or null
async function activeBookingOf(currentOrg, roomKey, user) {
  const { today, minutes } = security.orgClock(currentOrg);
  const early = security.earlyMinutes(currentOrg);
  const bookings = await db.collection(COLLECTION_NAME)
    .find(org.orgFilter(currentOrg, { date: today, room: roomKey, ownerId: user.id })).toArray();
  return bookings.find(b =>
    minutes >= security.toMinutes(b.startTime) - early && minutes <= security.toMinutes(b.endTime)) || null;
}

// The logged-in user if the request carries a valid token, else null (never answers 401)
async function optionalUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  try { return await getUserFromToken(token); } catch (e) { return null; }
}

// What a viewer may see of a booking. The bookingId is the QR code that opens the room,
// so only the booking's owner and admins get it; names are for members only.
function bookingView(b, viewer) {
  const mine = !!(viewer.user && b.ownerId && b.ownerId === viewer.user.id);
  const out = {
    _id: b._id,
    room: b.room,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    color: b.color,
    firstCheckIn: b.firstCheckIn || null,
    createdAt: b.createdAt,
    mine
  };
  if (viewer.isMember) {
    out.bookerName = b.bookerName;
    out.purpose = b.purpose;
  } else {
    out.bookerName = 'จองแล้ว';
  }
  if (mine || viewer.isAdmin) out.bookingId = b.bookingId;
  return out;
}

async function bookingViewer(req, currentOrg) {
  const user = await optionalUser(req);
  const membership = user ? await members.findMembership(db, currentOrg, user) : null;
  return { user, isMember: !!membership, isAdmin: members.hasRole(membership, 'admin') };
}

// Runs fn() for one room/date at a time, so two requests can't both pass the overlap
// check and book the same slot (this server runs as one process)
const roomLocks = new Map();
function withRoomLock(key, fn) {
  const prev = roomLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  roomLocks.set(key, tail);
  tail.then(() => { if (roomLocks.get(key) === tail) roomLocks.delete(key); });
  return run;
}

// Random, unguessable booking id (it is the QR code content)
function newBookingId() {
  return 'BK' + crypto.randomBytes(12).toString('base64url');
}

// Calls the organization's device control server. URLs set by an organization owner
// may not point at internal addresses; the CONTROL_URL fallback is trusted.
function callControlServer(currentOrg, pathname, method, payload) {
  const own = currentOrg.services && currentOrg.services.controlUrl;
  const controlUrl = new URL(pathname, own || CONTROL_URL);
  const proto = controlUrl.protocol === 'https:' ? https : http;
  const headers = {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const proxyReq = proto.request(controlUrl, {
      method, headers, timeout: 5000,
      lookup: own ? security.publicOnlyLookup : undefined
    }, (pRes) => {
      let data = '';
      let size = 0;
      pRes.on('data', c => {
        size += c.length;
        if (size > MAX_JSON_BYTES) { proxyReq.destroy(new Error('Control server reply too large')); return; }
        data += c;
      });
      pRes.on('end', () => resolve({ status: pRes.statusCode, body: data }));
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Timeout')); });
    if (payload) proxyReq.write(payload);
    proxyReq.end();
  });
}

// Passes the control server's answer on, but only as JSON
function relayControlReply(res, proxyRes) {
  let body;
  try { body = JSON.stringify(JSON.parse(proxyRes.body)); }
  catch (e) { body = JSON.stringify({ success: false, error: 'Control server sent an invalid reply' }); }
  res.statusCode = proxyRes.status >= 200 && proxyRes.status < 600 ? proxyRes.status : 502;
  res.end(body);
}

function cleanRoomName(room) {
  return room.replace(/\s*▼\s*/, '').trim();  // strip UI dropdown symbol
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

function sendRouteError(res, error) {
  if (error instanceof BodyTooLargeError) {
    res.statusCode = 413;
    res.end(JSON.stringify({ success: false, error: 'ข้อมูลที่ส่งมีขนาดใหญ่เกินไป' }));
  } else if (error instanceof SyntaxError) {
    res.statusCode = 400;
    res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
  } else {
    sendServerError(res, error);
  }
  return true;
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

  // Per-IP request limits (stricter for QR checks, sign-ups of organizations and writes)
  const ip = security.clientIp(req);
  const rule = security.rateRuleFor(url, method);
  const wait = security.rateLimited('api', ip) || (rule && security.rateLimited(rule, ip));
  if (wait) {
    res.statusCode = 429;
    res.setHeader('Retry-After', String(wait));
    res.end(JSON.stringify({ success: false, error: 'มีการเรียกใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่' }));
    return true;
  }

  if (!db) {
    res.statusCode = 503;
    res.end(JSON.stringify({ success: false, error: 'ฐานข้อมูลไม่พร้อมใช้งาน' }));
    return true;
  }

  // Every API call is for one organization (see org.js for how it is chosen)
  const ctx = { db, requireAuth, parseBody };
  try {
    // Account-level routes (my organizations, create organization, invites by token)
    if (await orgRoutes.handleAccountAPI(req, res, url, method, ctx)) return true;
  } catch (error) {
    return sendRouteError(res, error);
  }

  let currentOrg;
  try {
    currentOrg = await org.resolveOrg(db, req, res);
  } catch (error) {
    res.statusCode = 503;
    res.end(JSON.stringify({ success: false, error: 'ฐานข้อมูลไม่พร้อมใช้งาน' }));
    return true;
  }
  if (!currentOrg) return true;

  try {
    // Members, invites, roles and room setup for this organization
    if (await orgRoutes.handleOrgAPI(req, res, url, method, ctx, currentOrg)) return true;
  } catch (error) {
    return sendRouteError(res, error);
  }
  
  // GET /api/org/config - The organization's rooms, meters and public settings
  // (replaces the room lists and service URLs that were hardcoded in script.js / dashboard/script.js)
  if (url === '/api/org/config' && method === 'GET') {
    try {
      const config = await org.buildOrgConfig(db, currentOrg);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: config }));
    } catch (error) {
      sendRouteError(res, error);
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
      
      const [bookings, viewer] = await Promise.all([
        // without a date filter, return the most recent bookings only
        db.collection(COLLECTION_NAME).find(query).sort({ date: -1, startTime: 1 }).limit(date ? 0 : 5000).toArray(),
        bookingViewer(req, currentOrg)
      ]);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: bookings.map(b => bookingView(b, viewer)) }));
    } catch (error) {
      sendRouteError(res, error);
    }
    return true;
  }
  
  // POST /api/bookings - Create new booking
  if (url === '/api/bookings' && method === 'POST') {
    const auth = await orgRoutes.requireRole(req, res, ctx, currentOrg, 'user');
    if (!auth) return true;
    const user = auth.user;
    try {
      const body = await parseBody(req);
      const problem = security.bookingProblem(body);
      if (problem) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: problem }));
        return true;
      }
      const { date, startTime, endTime } = body;
      const bookerName = body.bookerName.trim();
      const purpose = (body.purpose || '').trim();
      const newRoom = cleanRoomName(body.room);
      const roomDoc = await db.collection('rooms').findOne(org.orgFilter(currentOrg, { key: newRoom }));
      if (!roomDoc || roomDoc.bookable === false) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'ไม่พบห้องนี้ในองค์กร' }));
        return true;
      }
      
      await withRoomLock(`${currentOrg._id}|${newRoom}|${date}`, async () => {
        // Check for overlapping bookings
        const overlapCheck = await checkOverlap(currentOrg, newRoom, date, startTime, endTime);
        if (overlapCheck.overlap) {
          const c = overlapCheck.conflictWith;
          res.statusCode = 409;
          res.end(JSON.stringify({
            success: false,
            error: `เวลา ${c.startTime} - ${c.endTime} มีผู้จองแล้ว`,
            conflictWith: { startTime: c.startTime, endTime: c.endTime }
          }));
          return;
        }

        // Random color for display
        const colors = ["#4dd0e1", "#81c784", "#ffb74d", "#ba68c8", "#64b5f6"];
        const color = colors[Math.floor(Math.random() * colors.length)];

        const newBooking = {
          orgId: currentOrg._id,
          bookingId: newBookingId(),
          room: newRoom,
          roomId: roomDoc._id,
          date,
          startTime,
          endTime,
          bookerName,
          purpose,
          color,
          ownerId: user.id,  // auth user id, used to allow the owner to delete
          createdAt: new Date().toISOString()
        };

        const result = await db.collection(COLLECTION_NAME).insertOne(newBooking);
        newBooking._id = result.insertedId;

        res.statusCode = 201;
        res.end(JSON.stringify({ success: true, data: bookingView(newBooking, { user, isMember: true, isAdmin: false }) }));
      });
    } catch (error) {
      sendRouteError(res, error);
    }
    return true;
  }
  
  // GET /api/active-booking - Get current active booking for a room
  if (url === '/api/active-booking' && method === 'GET') {
    try {
      const urlParams = new URL(req.url, `http://localhost:${port}`);
      const room = urlParams.searchParams.get('room');
      
      if (!room) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Missing room parameter' }));
        return true;
      }
      
      const { today, minutes: currentMinutes, seconds: currentSecs } = security.orgClock(currentOrg);
      const early = security.earlyMinutes(currentOrg);
      
      // Find bookings for today and this room (strip ▼ for matching)
      const cleanRoom = cleanRoomName(room);
      const bookings = await db.collection(COLLECTION_NAME).find(org.orgFilter(currentOrg, {
        date: today
      })).toArray();
      // Filter by room name (handle ▼ suffix in stored data)
      const roomBookings = bookings.filter(b => cleanRoomName(b.room || '') === cleanRoom);
      
      // Find the active booking (current time is within booking window, with the early allowance)
      const activeBooking = roomBookings.find(b =>
        currentMinutes >= security.toMinutes(b.startTime) - early && currentMinutes <= security.toMinutes(b.endTime));
      
      if (activeBooking) {
        // Calculate remaining seconds (organization's timezone)
        const endSecs = security.toMinutes(activeBooking.endTime) * 60;
        const remainingSeconds = Math.max(0, endSecs - currentSecs);
        const view = bookingView(activeBooking, await bookingViewer(req, currentOrg));
        
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          hasActiveBooking: true,
          isCheckedIn: !!activeBooking.firstCheckIn,
          firstCheckIn: activeBooking.firstCheckIn || null,
          remainingSeconds: remainingSeconds,
          booking: {
            bookingId: view.bookingId,
            room: view.room,
            date: view.date,
            startTime: view.startTime,
            endTime: view.endTime,
            bookerName: view.bookerName,
            purpose: view.purpose,
            mine: view.mine
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
      sendRouteError(res, error);
    }
    return true;
  }
  
  // POST /api/toggle-device — proxy to Control server to toggle Sonoff
  if (url === '/api/toggle-device' && method === 'POST') {
    const auth = await orgRoutes.requireRole(req, res, ctx, currentOrg, 'user');
    if (!auth) return true;
    try {
      const body = await parseBody(req);
      const { room, action } = body;
      if (!security.isStr(room, 100) || !room || !security.isStr(action, 40) || !action) {
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
      // admins control any room any time; users only during their own booking
      if (!members.hasRole(auth.membership, 'admin') && !await activeBookingOf(currentOrg, room, auth.user)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ success: false, error: 'เปิดปิดอุปกรณ์ได้เฉพาะช่วงเวลาที่คุณจองห้องนี้' }));
        return true;
      }

      // Forward to Control server
      const proxyRes = await callControlServer(currentOrg, '/toggle', 'POST', JSON.stringify({ room, action }));
      relayControlReply(res, proxyRes);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof BodyTooLargeError) return sendRouteError(res, error);
      console.error('[control] toggle failed:', error.message);
      res.statusCode = 502;
      res.end(JSON.stringify({ success: false, error: 'Control server unreachable' }));
    }
    return true;
  }

  // GET /api/room-state — proxy to Control server for device state
  if (url === '/api/room-state' && method === 'GET') {
    try {
      relayControlReply(res, await callControlServer(currentOrg, '/room-state', 'GET'));
    } catch (error) {
      console.error('[control] room-state failed:', error.message);
      res.statusCode = 502;
      res.end(JSON.stringify({ success: false, error: 'Control server unreachable' }));
    }
    return true;
  }

  // POST /api/verify - Verify QR code for room access
  if (url === '/api/verify' && method === 'POST') {
    if (SCANNER_KEY) {
      const sent = Buffer.from(String(req.headers['x-scanner-key'] || ''));
      const want = Buffer.from(SCANNER_KEY);
      if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ success: false, access: false, error: 'เครื่องสแกนไม่ได้รับอนุญาต' }));
        return true;
      }
    }
    try {
      const body = await parseBody(req);
      const { qrData } = body;

      if (!security.isStr(qrData, 200) || !qrData) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'ไม่พบข้อมูล QR Code' }));
        return true;
      }

      const bookingId = qrData.startsWith('BK:') ? qrData.substring(3) : qrData;

      const booking = await db.collection(COLLECTION_NAME).findOne(org.orgFilter(currentOrg, { bookingId }));

      if (!booking) {
        res.statusCode = 404;
        res.end(JSON.stringify({
          success: false,
          access: false,
          error: 'ไม่พบข้อมูลการจอง'
        }));
        return true;
      }

      // Check if within booking time (organization's timezone)
      const now = new Date();
      const { today, minutes: currentMinutes, seconds: currentSecs } = security.orgClock(currentOrg, now);
      const earlyAllowance = security.earlyMinutes(currentOrg);
      let timeCheck = { valid: false, reason: 'unknown', message: '' };

      if (booking.date !== today) {
        if (booking.date < today) {
          timeCheck = { valid: false, reason: 'expired', message: 'การจองนี้หมดอายุแล้ว' };
        } else {
          timeCheck = { valid: false, reason: 'not_today', message: `การจองนี้สำหรับวันที่ ${booking.date}` };
        }
      } else {
        const startMinutes = security.toMinutes(booking.startTime);
        const endMinutes = security.toMinutes(booking.endTime);

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

      // Calculate remaining seconds
      const remainingSeconds = Math.max(0, security.toMinutes(booking.endTime) * 60 - currentSecs);

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
      sendRouteError(res, error);
    }
    return true;
  }

  // GET /api/logs - Access logs
  if (url.startsWith('/api/logs') && method === 'GET') {
    const auth = await orgRoutes.requireRole(req, res, ctx, currentOrg, 'admin');
    if (!auth) return true;
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
      sendRouteError(res, error);
    }
    return true;
  }

  // DELETE /api/bookings/:id - Delete booking
  if (url.startsWith('/api/bookings/') && method === 'DELETE') {
    const user = await requireAuth(req, res);
    if (!user) return true;
    const membership = await members.findMembership(db, currentOrg, user);
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
      if (!isOwner && !members.hasRole(membership, 'admin')) {
        res.statusCode = 403;
        res.end(JSON.stringify({ success: false, error: 'ไม่มีสิทธิ์ลบการจองนี้' }));
        return true;
      }

      await db.collection(COLLECTION_NAME).deleteOne({ _id: booking._id });
      
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, message: 'Booking deleted' }));
    } catch (error) {
      sendRouteError(res, error);
    }
    return true;
  }
  
  res.statusCode = 404;
  res.end(JSON.stringify({ success: false, error: 'Not found' }));
  return true;
}

// Text files are compressed when the browser accepts gzip
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg)/;

function sendFile(req, res, filePath, stats, pageOrgSlug) {
  const ct = getContentType(filePath);
  res.setHeader('Content-Type', ct + (/^(text\/|application\/(javascript|json))/.test(ct) ? '; charset=utf-8' : ''));
  if (ct.includes('html')) {
    res.setHeader('Set-Cookie', org.orgCookieHeader(pageOrgSlug, security.isHttps(req)));
  }
  // Files loaded with ?v=<version> never change under that URL; everything else
  // (HTML, sw.js, unversioned assets) is revalidated with Last-Modified on each load
  const versioned = /[?&]v=/.test(req.url);
  if (versioned && !ct.includes('html')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
    const lastModified = stats.mtime.toUTCString();
    res.setHeader('Last-Modified', lastModified);
    const since = req.headers['if-modified-since'];
    if (since && !ct.includes('html') && new Date(since).getTime() >= Math.floor(stats.mtimeMs / 1000) * 1000) {
      res.statusCode = 304;
      res.end();
      return;
    }
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 500;
      res.end('Server error');
      return;
    }
    if (COMPRESSIBLE.test(ct) && data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Encoding', 'gzip');
      zlib.gzip(data, (zerr, gz) => res.end(zerr ? data : gz));
      return;
    }
    res.end(data);
  });
}

async function handleRequest(req, res) {
  security.setSecurityHeaders(req, res);

  // Health check for the hosting platform
  if (req.url === '/healthz') {
    res.statusCode = db ? 200 : 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: !!db }));
    return;
  }

  // Handle API routes first
  if (req.url.startsWith('/api/')) {
    await handleAPI(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }
  
  // Static file serving
  let decoded;
  try {
    decoded = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

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

  // The installable app (PWA) carries each organization's name, colour and start page
  if (decoded === '/manifest.json' && db) {
    try {
      const pageOrg = await org.findOrgBySlug(db, pageOrgSlug);
      if (pageOrg) {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(JSON.stringify(org.buildManifest(pageOrg, orgPath ? `/o/${pageOrg.slug}/` : '/')));
        return;
      }
    } catch (e) { /* fall back to the static manifest.json */ }
  }

  // Only the app's own pages and assets are public (see security.js), never server code or secrets
  let filePath = security.resolvePublicPath(root, decoded);
  if (!filePath) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      if (!decoded.endsWith('/')) {
        // /dashboard → /dashboard/ so the page's relative URLs resolve
        res.statusCode = 301;
        res.setHeader('Location', req.url.split('?')[0] + '/');
        res.end();
        return;
      }
      filePath = path.join(filePath, 'index.html');
      return fs.stat(filePath, (err2, stats2) => {
        if (err2 || !stats2.isFile()) { res.statusCode = 404; res.end('Not found'); return; }
        sendFile(req, res, filePath, stats2, pageOrgSlug);
      });
    }
    if (err || !stats.isFile() || !security.isServableFile(filePath)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    sendFile(req, res, filePath, stats, pageOrgSlug);
  });
}

const server = http.createServer((req, res) => {
  // An unexpected error answers this one request with 500; it never stops the server
  handleRequest(req, res).catch(error => {
    console.error('[server] request failed:', req.method, req.url, error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
    }
    if (!res.writableEnded) res.end(JSON.stringify({ success: false, error: 'เกิดข้อผิดพลาดในระบบ' }));
  });
});

// ─── CCTV WebSocket Relay ───
// Each organization has its own relay (relay.py next to its cameras) and its own viewers.
// A relay authenticates with its organization's key (set on the account page; RELAY_KEY
// still works for the default organization) in the X-Relay-Key header (?key= still works for
// older relays). Viewers send their login token as the WebSocket subprotocol
// ("bearer", <token>) so it doesn't end up in URLs and proxy logs; ?token= still works.
const wssRelay  = new WebSocketServer({ noServer: true });
// Answer the "bearer" subprotocol (never echo the token back)
const wssViewer = new WebSocketServer({
  noServer: true,
  handleProtocols: protocols => (protocols.has('bearer') ? 'bearer' : false)
});

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
}

async function relayOrg(key) {
  if (!key) return null;
  if (RELAY_KEY && key === RELAY_KEY) return org.findOrgBySlug(db, org.DEFAULT_ORG_SLUG);
  return db.collection('organizations').findOne({ 'cctv.relayKeyHash': org.hashSecret(key) });
}

// The viewer's token from Sec-WebSocket-Protocol: "bearer, <token>"
function viewerToken(req, url) {
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
  const i = protocols.indexOf('bearer');
  if (i >= 0 && protocols[i + 1]) return protocols[i + 1];
  return url.searchParams.get('token') || '';
}

async function viewerOrg(req, url) {
  if (!db) return { status: 503 };
  const currentOrg = await org.findOrgBySlug(db, org.requestedOrgSlug(req));
  if (!currentOrg) return { status: 404 };
  const token = viewerToken(req, url);
  const user = token ? await getUserFromToken(token).catch(() => null) : null;
  if (!user) return { status: 401 };
  const minRole = (currentOrg.settings && currentOrg.settings.cctvViewRole) || 'admin';
  const membership = await members.findMembership(db, currentOrg, user);
  if (!members.hasRole(membership, minRole)) return { status: 403 };
  return { org: currentOrg };
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === '/ws/relay') {
      const relayFor = db && await relayOrg(String(req.headers['x-relay-key'] || url.searchParams.get('key') || ''));
      if (!relayFor) {
        console.log('[CCTV] Relay rejected — bad key');
        return rejectUpgrade(socket, 401, 'Unauthorized');
      }
      wssRelay.handleUpgrade(req, socket, head, ws => wssRelay.emit('connection', ws, relayFor));
    } else if (url.pathname === '/ws/stream') {
      const result = await viewerOrg(req, url);
      if (!result.org) {
        const reasons = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' };
        return rejectUpgrade(socket, result.status, reasons[result.status] || 'Forbidden');
      }
      wssViewer.handleUpgrade(req, socket, head, ws => wssViewer.emit('connection', ws, result.org));
    } else {
      socket.destroy();
    }
  } catch (e) {
    console.error('[CCTV] upgrade error:', e.message);
    rejectUpgrade(socket, 503, 'Service Unavailable');
  }
});

function relayGone(stream, ws) {
  if (stream.relay !== ws) return;
  stream.relay = null;
  stream.latestFrame = null;
  // แจ้ง viewers ทั้งหมดว่า relay หลุด
  for (const v of stream.viewers) {
    if (v.readyState === WebSocket.OPEN) {
      try { v.send('relay_offline'); } catch(e) {}
    }
  }
}

// Relay: receives JPEG frames from local relay.py
wssRelay.on('connection', (ws, relayFor) => {
  const stream = cctvStream(relayFor._id);
  if (stream.relay) {
    try { stream.relay.close(); } catch(e) {}
    console.log(`[CCTV] ${relayFor.slug}: replaced existing relay`);
  }
  stream.relay = ws;
  console.log(`[CCTV] ${relayFor.slug}: ✓ relay connected — viewers: ${stream.viewers.size}`);

  ws.on('message', (data) => {
    stream.latestFrame = data;
    for (const v of stream.viewers) {
      if (v.readyState === WebSocket.OPEN) {
        v.send(data, { binary: true });
      }
    }
  });

  ws.on('close', () => {
    console.log(`[CCTV] ${relayFor.slug}: ✗ relay disconnected`);
    relayGone(stream, ws);
  });

  ws.on('error', (err) => {
    console.error(`[CCTV] ${relayFor.slug}: relay error:`, err.message);
    relayGone(stream, ws);
  });
});

// Viewer: browser connects to watch its organization's stream
wssViewer.on('connection', (ws, viewerFor) => {
  const stream = cctvStream(viewerFor._id);
  stream.viewers.add(ws);
  console.log(`[CCTV] ${viewerFor.slug}: + viewer — total: ${stream.viewers.size}`);

  // ส่ง frame ล่าสุดให้เห็นภาพทันทีไม่ต้องรอ
  if (stream.latestFrame) {
    try { ws.send(stream.latestFrame, { binary: true }); } catch(e) {}
  }

  ws.on('close', () => {
    stream.viewers.delete(ws);
    console.log(`[CCTV] ${viewerFor.slug}: - viewer — total: ${stream.viewers.size}`);
  });
  ws.on('error', () => stream.viewers.delete(ws));
});

// Connect to DB then start server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
  console.log(`[CCTV] Relay: ws://localhost:${port}/ws/relay (X-Relay-Key header)`);
  console.log(`[CCTV] Stream: ws://localhost:${port}/ws/stream`);
});
connectDB();

// Log instead of crashing on a stray rejected promise (e.g. a socket error after a reply)
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});