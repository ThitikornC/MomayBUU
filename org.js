// ==================== Multi-organization (tenant) helpers ====================
// Every booking, access log, room, meter and membership belongs to one organization
// and carries its orgId. The API works out which organization a request is for
// with resolveOrg() and every query goes through orgFilter() so data never leaks
// between organizations.

const crypto = require('crypto');

const DEFAULT_ORG_SLUG = process.env.DEFAULT_ORG_SLUG || 'buu-library';
const ORG_COOKIE = 'momay_org';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Collections that hold per-organization data (all have an orgId field)
const ORG_COLLECTIONS = ['bookings', 'access_logs', 'buildings', 'rooms', 'meters', 'memberships', 'invites'];

async function ensureOrgIndexes(db) {
  await db.collection('organizations').createIndex({ slug: 1 }, { unique: true });

  await db.collection('bookings').createIndex({ orgId: 1, date: 1, room: 1 });
  await db.collection('bookings').createIndex({ orgId: 1, bookingId: 1 }, { unique: true });
  await db.collection('access_logs').createIndex({ orgId: 1, attemptTime: -1 });

  await db.collection('buildings').createIndex({ orgId: 1, order: 1 });
  await db.collection('rooms').createIndex({ orgId: 1, key: 1 }, { unique: true });
  await db.collection('meters').createIndex({ orgId: 1, key: 1 }, { unique: true });

  // userId is "email:<address>" for a membership waiting to be claimed by email (see members.js)
  await db.collection('memberships').createIndex({ orgId: 1, userId: 1 }, { unique: true });
  await db.collection('memberships').createIndex({ orgId: 1, email: 1 });
  await db.collection('memberships').createIndex({ userId: 1 });
  await db.collection('invites').createIndex({ tokenHash: 1 }, { unique: true });
}

// Warn (don't fail) when the BUU data hasn't been migrated yet: those documents
// have no orgId and are invisible to the org-scoped API.
async function warnUnmigrated(db) {
  for (const name of ['bookings', 'access_logs']) {
    const n = await db.collection(name).countDocuments({ orgId: { $exists: false } });
    if (n > 0) {
      console.warn(`[org] ${n} document(s) in ${name} have no orgId — run: node scripts/migrate-multi-org.js`);
    }
  }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* bad cookie */ }
  });
  return out;
}

// Which organization slug a request is for, in order of precedence:
// X-Org header → ?org= query → momay_org cookie (set when a /o/<slug>/ page is served) → default
function requestedOrgSlug(req) {
  const header = (req.headers['x-org'] || '').toString().trim().toLowerCase();
  if (header) return header;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('org');
    if (q) return q.trim().toLowerCase();
  } catch (e) { /* bad url */ }
  const cookie = (parseCookies(req)[ORG_COOKIE] || '').trim().toLowerCase();
  if (cookie) return cookie;
  return DEFAULT_ORG_SLUG;
}

// Short cache: the org is looked up on every API call
const ORG_CACHE_MS = 30 * 1000;
const orgCache = new Map();  // slug -> { org, expires }

async function findOrgBySlug(db, slug) {
  if (!SLUG_RE.test(slug)) return null;
  const cached = orgCache.get(slug);
  if (cached && cached.expires > Date.now()) return cached.org;
  const org = await db.collection('organizations').findOne({ slug, deletedAt: { $exists: false } });
  if (org) {  // misses aren't cached so a new organization works right away
    if (orgCache.size > 500) orgCache.clear();
    orgCache.set(slug, { org, expires: Date.now() + ORG_CACHE_MS });
  }
  return org;
}

function forgetOrg(slug) {
  orgCache.delete(slug);
}

// Returns the organization for this request, or sends 404 and returns null
async function resolveOrg(db, req, res) {
  const slug = requestedOrgSlug(req);
  const org = await findOrgBySlug(db, slug);
  if (!org) {
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, error: 'ไม่พบองค์กรนี้', code: 'ORG_NOT_FOUND', org: slug }));
    return null;
  }
  return org;
}

// Adds the organization to a query so it can only match that organization's documents
function orgFilter(org, query = {}) {
  return Object.assign({}, query, { orgId: org._id });
}

// Static pages under /o/<slug>/... are the same files as the root app, served for one organization.
// Returns { slug, rest } for such paths, or null.
function matchOrgPath(pathname) {
  const m = /^\/o\/([a-z0-9-]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  return { slug: m[1], rest: m[2] || '/' };
}

// The device control server for this organization; BUU falls back to the CONTROL_URL env var
function controlUrlFor(currentOrg, fallback) {
  return (currentOrg.services && currentOrg.services.controlUrl) || fallback;
}

function publicMeter(m) {
  return m ? { id: String(m._id), key: m.key, name: m.name, deviceId: m.deviceId, energyApiUrl: m.energyApiUrl, type: m.type } : null;
}

// What the browser needs to draw the app for one organization. Server-only settings
// (controlUrl, keys) are left out.
async function buildOrgConfig(db, currentOrg) {
  const [buildings, rooms, meters] = await Promise.all([
    db.collection('buildings').find(orgFilter(currentOrg)).sort({ order: 1 }).toArray(),
    db.collection('rooms').find(orgFilter(currentOrg)).sort({ order: 1 }).toArray(),
    db.collection('meters').find(orgFilter(currentOrg)).toArray()
  ]);
  const meterById = new Map(meters.map(m => [String(m._id), m]));
  const primaryMeter = meterById.get(String(currentOrg.primaryMeterId)) || meters[0] || null;
  const services = currentOrg.services || {};
  const settings = currentOrg.settings || {};

  return {
    org: {
      slug: currentOrg.slug,
      name: currentOrg.name,
      branding: currentOrg.branding || {},
      timezone: settings.timezone || 'Asia/Bangkok',
      bookingEarlyMinutes: settings.bookingEarlyMinutes != null ? settings.bookingEarlyMinutes : 15
    },
    services: {
      energyApiUrl: services.energyApiUrl || (primaryMeter && primaryMeter.energyApiUrl) || null,
      notifyUrl: services.notifyUrl || null
    },
    primaryMeter: publicMeter(primaryMeter),
    primaryRoomKey: currentOrg.primaryRoomKey || (rooms[0] && rooms[0].key) || null,
    buildings: buildings.map(b => ({ id: String(b._id), key: b.key, name: b.name, floors: b.floors || [] })),
    rooms: rooms.map(r => ({
      id: String(r._id),
      key: r.key,
      displayName: r.displayName || r.key,
      buildingId: r.buildingId ? String(r.buildingId) : null,
      floor: r.floor || null,
      bookable: r.bookable !== false,
      meter: publicMeter(meterById.get(String(r.meterId)))
    }))
  };
}

// Web app manifest for one organization, served at <base>manifest.json
function buildManifest(currentOrg, base) {
  const b = currentOrg.branding || {};
  const name = b.displayName || currentOrg.name || 'Momay';
  const color = b.primaryColor || '#8B4513';
  return {
    name,
    short_name: name.length > 12 ? 'Momay' : name,
    description: 'Solar & energy dashboard',
    start_url: base + '?source=pwa',
    scope: base,
    display: 'standalone',
    orientation: 'portrait',
    background_color: color,
    theme_color: color,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  };
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function orgCookieHeader(slug, secure) {
  return `${ORG_COOKIE}=${encodeURIComponent(slug)}; Path=/; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
}

module.exports = {
  DEFAULT_ORG_SLUG,
  ORG_COLLECTIONS,
  SLUG_RE,
  ensureOrgIndexes,
  warnUnmigrated,
  requestedOrgSlug,
  findOrgBySlug,
  forgetOrg,
  resolveOrg,
  orgFilter,
  matchOrgPath,
  orgCookieHeader,
  controlUrlFor,
  hashSecret,
  buildManifest,
  buildOrgConfig
};
