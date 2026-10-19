// ==================== Request hardening helpers ====================
// Static file allowlist, security headers, request rate limits, input checks,
// outbound-URL checks (SSRF) and organization-local time. Used by server.js.

const dns = require('dns');
const net = require('net');
const path = require('path');

// ─── Static files ───
// Only these top-level files and folders are served to browsers. Everything else in
// the repository (server code, scripts, cctv/, node_modules/, .env files, .git) is not.
const PUBLIC_FILES = new Set([
  'index.html', 'style.css', 'script.js', 'sw.js', 'manifest.json',
  'auth-client.js', 'org-client.js', 'pageview.js', 'pages.css', 'Buulogo.png', 'a11y.js'
]);
const PUBLIC_DIRS = new Set(['icons', 'images', 'dashboard', 'login', 'account', 'join', 'qr-scanner']);
const PUBLIC_EXTS = new Set(['.html', '.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.gif', '.woff', '.woff2']);

// Maps a URL path to a file under root, or null when it isn't public.
// `pathname` must already be percent-decoded.
function resolvePublicPath(root, pathname) {
  if (pathname.includes('\0')) return null;
  const rel = path.posix.normalize('/' + pathname).replace(/^\/+/, '');
  if (rel === '' || rel === '.') return path.join(root, 'index.html');
  const parts = rel.split('/');
  if (parts.some(p => p === '..' || p.startsWith('.'))) return null;  // dotfiles: .env, .git, .vscode
  const topDir = parts.length === 1 && PUBLIC_DIRS.has(parts[0]);  // e.g. /dashboard (redirected to /dashboard/)
  if (!topDir && (parts.length === 1 ? !PUBLIC_FILES.has(parts[0]) : !PUBLIC_DIRS.has(parts[0]))) return null;
  const isDir = topDir || rel.endsWith('/');
  if (!isDir && !PUBLIC_EXTS.has(path.extname(rel).toLowerCase())) return null;
  const filePath = path.join(root, rel);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

// The folders above may hold a README or editor files; only web assets are served from them
function isServableFile(filePath) {
  return PUBLIC_EXTS.has(path.extname(filePath).toLowerCase());
}

// ─── Security headers ───
// script-src is not restricted yet: index.html still has inline scripts and onclick handlers.
const CSP = [
  "default-src 'self' https: data: blob: wss: ws:",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

function isHttps(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || !!(req.socket && req.socket.encrypted);
}

function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

// ─── Client IP and rate limits ───
// Railway's proxy appends the real client address as the last X-Forwarded-For entry,
// so the last entry can't be forged by the client.
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || 'unknown');
}

// Fixed-window counters per (rule, ip). In memory: fine for one server instance.
// Limits are generous because a whole campus can share one public IP (NAT).
const RATE_RULES = {
  api:     { limit: 1200, windowMs: 60 * 1000 },
  verify:  { limit: 30,  windowMs: 60 * 1000 },
  write:   { limit: 120, windowMs: 60 * 1000 },
  invite:  { limit: 30,  windowMs: 60 * 1000 },
  orgs:    { limit: 5,   windowMs: 60 * 60 * 1000 }
};
const rateBuckets = new Map();  // `${rule}:${ip}` -> { count, resetAt }

// Returns seconds to wait when over the limit, or 0
function rateLimited(rule, ip) {
  const { limit, windowMs } = RATE_RULES[rule];
  const key = rule + ':' + ip;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    if (rateBuckets.size > 20000) {
      for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
    }
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count++;
  return b.count > limit ? Math.ceil((b.resetAt - now) / 1000) : 0;
}

// Which stricter rule (besides 'api') a request falls under
function rateRuleFor(url, method) {
  if (url === '/api/verify') return 'verify';
  if (url === '/api/orgs' && method === 'POST') return 'orgs';
  if (url.startsWith('/api/invites/')) return 'invite';
  if (method !== 'GET' && method !== 'OPTIONS') return 'write';
  return null;
}

// ─── Input checks ───
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

function isStr(v, max = 200) {
  return typeof v === 'string' && v.length <= max;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Validates a new booking body. Returns an error message, or '' when it is fine.
function bookingProblem(b) {
  if (!isStr(b.room, 100) || !b.room.trim()) return 'กรุณาเลือกห้อง';
  if (!isStr(b.date, 10) || !DATE_RE.test(b.date)) return 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)';
  if (!isStr(b.startTime, 5) || !TIME_RE.test(b.startTime) || b.startTime === '24:00') return 'รูปแบบเวลาเริ่มไม่ถูกต้อง (HH:MM)';
  if (!isStr(b.endTime, 5) || !TIME_RE.test(b.endTime)) return 'รูปแบบเวลาสิ้นสุดไม่ถูกต้อง (HH:MM)';
  if (toMinutes(b.startTime) >= toMinutes(b.endTime)) return 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม';
  if (!isStr(b.bookerName, 100) || !b.bookerName.trim()) return 'กรุณากรอกชื่อผู้จอง (ไม่เกิน 100 ตัวอักษร)';
  if (b.purpose !== undefined && b.purpose !== null && !isStr(b.purpose, 500)) return 'วัตถุประสงค์ต้องไม่เกิน 500 ตัวอักษร';
  return '';
}

// ─── Outbound URLs set by organization owners (SSRF) ───
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') ||
      v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
  }
  return true;
}

// http.request `lookup` option that refuses private/internal addresses. Checking at connect
// time (not only when the URL is saved) also stops DNS names that later point inside.
function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, Object.assign({}, options, { all: true }), (err, addresses) => {
    if (err) return callback(err);
    const ok = addresses.filter(a => !isPrivateAddress(a.address));
    if (!ok.length) return callback(new Error('ปลายทางเป็นที่อยู่ภายใน ไม่อนุญาต'));
    if (options && options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

// A service URL an owner may save: https only, not an IP literal in a private range, no credentials
function isAllowedServiceUrl(v) {
  if (typeof v !== 'string' || v.length > 500) return false;
  let u;
  try { u = new URL(v); } catch (e) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (net.isIP(host) && isPrivateAddress(host)) return false;
  return true;
}

// ─── Organization-local clock ───
// Today's date (YYYY-MM-DD) and the time of day in the organization's timezone
function orgClock(currentOrg, now = new Date()) {
  const tz = (currentOrg && currentOrg.settings && currentOrg.settings.timezone) || 'Asia/Bangkok';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(now);
  } catch (e) {
    return orgClock(null, now);  // unknown timezone name → Bangkok
  }
  const get = t => parts.find(p => p.type === t).value;
  const h = Number(get('hour')), m = Number(get('minute')), s = Number(get('second'));
  return {
    today: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: h * 60 + m,
    seconds: h * 3600 + m * 60 + s
  };
}

function earlyMinutes(currentOrg) {
  const v = currentOrg && currentOrg.settings && currentOrg.settings.bookingEarlyMinutes;
  return Number.isFinite(v) && v >= 0 ? v : 15;
}

module.exports = {
  resolvePublicPath,
  isServableFile,
  setSecurityHeaders,
  isHttps,
  clientIp,
  rateLimited,
  rateRuleFor,
  bookingProblem,
  isStr,
  toMinutes,
  isPrivateAddress,
  publicOnlyLookup,
  isAllowedServiceUrl,
  orgClock,
  earlyMinutes
};
