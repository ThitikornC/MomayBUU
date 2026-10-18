// ==================== Multi-organization (tenant) helpers ====================
// Every booking, access log, room, meter and membership belongs to one organization
// and carries its orgId. The API works out which organization a request is for
// with resolveOrg() and every query goes through orgFilter() so data never leaks
// between organizations.

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

  await db.collection('memberships').createIndex({ orgId: 1, userId: 1 }, { unique: true });
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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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
  if (orgCache.size > 500) orgCache.clear();
  orgCache.set(slug, { org, expires: Date.now() + ORG_CACHE_MS });
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

function orgCookieHeader(slug) {
  return `${ORG_COOKIE}=${encodeURIComponent(slug)}; Path=/; SameSite=Lax; Max-Age=31536000`;
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
  orgCookieHeader
};
