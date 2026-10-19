// ==================== Organization, member, invite and room-setup API ====================
// Called from server.js handleAPI. Returns true when it handled the request.
//
// Not tied to one organization (handled before the org is resolved):
//   GET  /api/me/orgs                  organizations I belong to
//   POST /api/orgs                     create an organization (I become owner)
//   GET  /api/invites/:token           invite preview (no login needed)
//   POST /api/invites/:token/accept    accept an invite
//
// For the current organization (see org.js resolveOrg):
//   GET    /api/org/me                 my role here, and whether I can join
//   PATCH  /api/org/branding           display name, colour              owner
//   GET    /api/org/logo               the uploaded logo (public)
//   PUT    /api/org/logo               upload logo (raw png/jpeg/webp body) owner
//   POST   /api/org/cctv-key           new key for this org's CCTV relay owner
//   POST   /api/org/join               join (when the join policy allows it)
//   PATCH  /api/org                    name, services, join policy      owner
//   GET    /api/org/members            list members                     admin
//   PATCH  /api/org/members/:id        change role                      admin (users) / owner
//   DELETE /api/org/members/:id        remove member, or leave          admin / self
//   GET    /api/org/invites            pending invites                  admin
//   POST   /api/org/invites            create invite link               admin (user) / owner (admin)
//   DELETE /api/org/invites/:id        cancel invite                    admin
//   GET/POST /api/org/{buildings,rooms,meters}, PATCH/DELETE /api/org/{buildings,rooms,meters}/:id   admin

const crypto = require('crypto');
const { Binary } = require('mongodb');
const org = require('./org');
const members = require('./members');
const security = require('./security');

const LOGO_MAX_BYTES = 500 * 1024;
// SVG is left out on purpose: it can carry scripts and is served from this origin
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function send(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
  return true;
}

function fail(res, status, error) {
  return send(res, status, { success: false, error });
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function publicOrg(o, membership) {
  return {
    id: String(o._id),
    slug: o.slug,
    name: o.name,
    logoUrl: (o.branding && o.branding.logoUrl) || null,
    role: membership ? membership.role : null
  };
}

// Reads a raw request body up to `limit` bytes; resolves null if it is larger
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // past the limit, keep draining (so the 413 answer reaches the client) but drop the data
    req.on('data', c => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

function appBase(req) {
  // PUBLIC_URL (e.g. https://momaybuu-production.up.railway.app) avoids trusting the Host header
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

// ─── Routes that don't belong to one organization ───
async function handleAccountAPI(req, res, url, method, ctx) {
  const { db } = ctx;

  if (url === '/api/me/orgs' && method === 'GET') {
    const user = await ctx.requireAuth(req, res);
    if (!user) return true;
    // claim memberships made for this email before the account existed
    await db.collection('memberships').updateMany(
      { userId: members.pendingUserId(user.email || '-') },
      { $set: { userId: user.id, name: user.name, joinedAt: new Date() } });
    const list = await db.collection('memberships').find({ userId: user.id }).toArray();
    const orgs = await db.collection('organizations')
      .find({ _id: { $in: list.map(m => m.orgId) }, deletedAt: { $exists: false } }).toArray();
    const byId = new Map(orgs.map(o => [String(o._id), o]));
    const data = list.filter(m => byId.has(String(m.orgId))).map(m => publicOrg(byId.get(String(m.orgId)), m));
    return send(res, 200, { success: true, data, user });
  }

  if (url === '/api/orgs' && method === 'POST') {
    const user = await ctx.requireAuth(req, res);
    if (!user) return true;
    const body = await ctx.parseBody(req);
    const result = await members.createOrganization(db, user, { name: str(body.name, 100), slug: str(body.slug, 40) });
    if (result.error) return fail(res, result.status, result.error);
    return send(res, 201, { success: true, data: publicOrg(result.org, { role: 'owner' }) });
  }

  let m = /^\/api\/invites\/([A-Za-z0-9_-]+)$/.exec(url);
  if (m && method === 'GET') {
    const invite = await members.findInvite(db, m[1]);
    const state = members.inviteState(invite);
    if (state === 'not_found') return fail(res, 404, 'ไม่พบคำเชิญนี้');
    const o = await db.collection('organizations').findOne({ _id: invite.orgId });
    return send(res, 200, {
      success: true,
      data: { state, email: invite.email, role: invite.role, org: o ? publicOrg(o) : null, expiresAt: invite.expiresAt }
    });
  }

  m = /^\/api\/invites\/([A-Za-z0-9_-]+)\/accept$/.exec(url);
  if (m && method === 'POST') {
    const user = await ctx.requireAuth(req, res);
    if (!user) return true;
    const result = await members.acceptInvite(db, m[1], user);
    if (result.error) return fail(res, result.status, result.error);
    org.forgetOrg(result.org.slug);
    return send(res, 200, { success: true, data: publicOrg(result.org, result.membership) });
  }

  return false;
}

// ─── Routes for the current organization ───

// Returns { user, membership } when the caller has at least minRole here, else sends 401/403
async function requireRole(req, res, ctx, currentOrg, minRole) {
  const user = await ctx.requireAuth(req, res);
  if (!user) return null;
  const membership = minRole === 'user'
    ? await members.findOrJoinMembership(ctx.db, currentOrg, user)
    : await members.findMembership(ctx.db, currentOrg, user);
  if (!members.hasRole(membership, minRole)) {
    fail(res, 403, membership ? 'บทบาทของคุณไม่มีสิทธิ์ทำสิ่งนี้' : 'คุณยังไม่ได้เป็นสมาชิกขององค์กรนี้');
    return null;
  }
  return { user, membership };
}

// Room setup collections an admin can edit, and the fields allowed in each
const SETUP = {
  buildings: {
    fields(body) {
      const out = {};
      if (body.name !== undefined) out.name = str(body.name, 100);
      if (body.key !== undefined) out.key = str(body.key, 60);
      if (Array.isArray(body.floors)) out.floors = body.floors.map(f => str(String(f), 20)).filter(Boolean).slice(0, 100);
      if (body.order !== undefined) out.order = Number(body.order) || 0;
      return out;
    },
    required: ['name']
  },
  rooms: {
    async fields(body, ctx, currentOrg) {
      const out = {};
      if (body.key !== undefined) out.key = str(body.key, 60);
      if (body.displayName !== undefined) out.displayName = str(body.displayName, 100);
      if (body.floor !== undefined) out.floor = str(String(body.floor), 20) || null;
      if (body.bookable !== undefined) out.bookable = !!body.bookable;
      if (body.order !== undefined) out.order = Number(body.order) || 0;
      for (const [field, collection] of [['buildingId', 'buildings'], ['meterId', 'meters']]) {
        if (body[field] === undefined) continue;
        if (body[field] === null || body[field] === '') { out[field] = null; continue; }
        const id = members.toObjectId(body[field]);
        const ref = id && await ctx.db.collection(collection).findOne(org.orgFilter(currentOrg, { _id: id }));
        if (!ref) throw new Error(`${field} ไม่ถูกต้อง`);
        out[field] = id;
      }
      return out;
    },
    required: ['key']
  },
  meters: {
    fields(body) {
      const out = {};
      if (body.key !== undefined) out.key = str(body.key, 60);
      if (body.name !== undefined) out.name = str(body.name, 100);
      if (body.deviceId !== undefined) out.deviceId = str(body.deviceId, 100);
      if (body.type !== undefined) out.type = ['grid', 'solar'].includes(body.type) ? body.type : 'grid';
      if (body.energyApiUrl !== undefined) {
        if (!security.isAllowedServiceUrl(body.energyApiUrl)) throw new Error('energyApiUrl ต้องเป็นลิงก์ https สาธารณะ');
        out.energyApiUrl = body.energyApiUrl.trim().replace(/\/+$/, '');
      }
      return out;
    },
    required: ['key', 'deviceId', 'energyApiUrl']
  }
};

async function handleSetupAPI(req, res, url, method, ctx, currentOrg) {
  const m = /^\/api\/org\/(buildings|rooms|meters)(?:\/([0-9a-f]{24}))?$/.exec(url);
  if (!m || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return false;
  const [, name, id] = m;
  if ((method === 'POST' || method === 'GET') === !!id) return fail(res, 404, 'Not found');

  const auth = await requireRole(req, res, ctx, currentOrg, 'admin');
  if (!auth) return true;
  const collection = ctx.db.collection(name);
  const spec = SETUP[name];

  if (method === 'GET') {
    const list = await collection.find(org.orgFilter(currentOrg)).sort({ order: 1 }).toArray();
    return send(res, 200, { success: true, data: list });
  }

  if (method === 'DELETE') {
    const r = await collection.deleteOne(org.orgFilter(currentOrg, { _id: members.toObjectId(id) }));
    if (!r.deletedCount) return fail(res, 404, 'ไม่พบรายการนี้');
    // rooms that pointed at a deleted building/meter keep working without it
    if (name !== 'rooms') {
      const field = name === 'buildings' ? 'buildingId' : 'meterId';
      await ctx.db.collection('rooms').updateMany(org.orgFilter(currentOrg, { [field]: members.toObjectId(id) }), { $set: { [field]: null } });
    }
    return send(res, 200, { success: true });
  }

  let fields;
  try {
    fields = await spec.fields(await ctx.parseBody(req), ctx, currentOrg);
  } catch (e) {
    return fail(res, 400, e.message);
  }
  // bookings and the control server refer to a room by its key, so it can't change
  if (name === 'rooms' && method === 'PATCH') delete fields.key;
  if (method === 'POST') {
    const missing = spec.required.filter(f => !fields[f]);
    if (missing.length) return fail(res, 400, 'ต้องระบุ ' + missing.join(', '));
  }
  try {
    if (method === 'POST') {
      const doc = Object.assign({ order: 0 }, fields, { orgId: currentOrg._id, createdAt: new Date() });
      const r = await collection.insertOne(doc);
      doc._id = r.insertedId;
      return send(res, 201, { success: true, data: doc });
    }
    const r = await collection.findOneAndUpdate(
      org.orgFilter(currentOrg, { _id: members.toObjectId(id) }), { $set: fields }, { returnDocument: 'after' });
    if (!r) return fail(res, 404, 'ไม่พบรายการนี้');
    return send(res, 200, { success: true, data: r });
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'รหัส (key) นี้มีอยู่แล้วในองค์กร');
    throw e;
  }
}

async function handleOrgAPI(req, res, url, method, ctx, currentOrg) {
  const { db } = ctx;

  if (url === '/api/org/me' && method === 'GET') {
    const user = await ctx.requireAuth(req, res);
    if (!user) return true;
    const membership = await members.findMembership(db, currentOrg, user);
    return send(res, 200, {
      success: true,
      data: {
        org: publicOrg(currentOrg, membership),
        role: membership ? membership.role : null,
        canJoin: !membership && members.canSelfJoin(currentOrg, user),
        user,
        // settings only the owner edits (PATCH /api/org)
        settings: members.hasRole(membership, 'owner') ? {
          joinPolicy: (currentOrg.settings && currentOrg.settings.joinPolicy) || 'invite',
          allowedDomains: (currentOrg.settings && currentOrg.settings.allowedDomains) || [],
          cctvViewRole: (currentOrg.settings && currentOrg.settings.cctvViewRole) || 'admin',
          hasCctvKey: !!(currentOrg.cctv && currentOrg.cctv.relayKeyHash),
          services: currentOrg.services || {}
        } : null
      }
    });
  }

  if (url === '/api/org/logo' && method === 'GET') {
    const asset = await db.collection('org_assets').findOne({ orgId: currentOrg._id, kind: 'logo' });
    if (!asset) return fail(res, 404, 'ยังไม่มีโลโก้');
    res.statusCode = 200;
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');  // the URL carries ?v=<upload time>
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(Buffer.from(asset.data.buffer));
    return true;
  }

  if (url === '/api/org/logo' && method === 'PUT') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'owner');
    if (!auth) return true;
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!LOGO_TYPES.includes(type)) return fail(res, 415, 'โลโก้ต้องเป็นไฟล์ PNG, JPEG หรือ WebP');
    const data = await readRaw(req, LOGO_MAX_BYTES);
    if (!data) return fail(res, 413, 'โลโก้ต้องไม่เกิน 500 KB');
    if (!data.length) return fail(res, 400, 'ไม่พบไฟล์');
    const now = new Date();
    await db.collection('org_assets').updateOne(
      { orgId: currentOrg._id, kind: 'logo' },
      { $set: { contentType: type, data: new Binary(data), size: data.length, updatedAt: now } },
      { upsert: true });
    const logoUrl = `/api/org/logo?org=${currentOrg.slug}&v=${now.getTime()}`;
    await db.collection('organizations').updateOne({ _id: currentOrg._id }, { $set: { 'branding.logoUrl': logoUrl } });
    org.forgetOrg(currentOrg.slug);
    return send(res, 200, { success: true, data: { logoUrl } });
  }

  if (url === '/api/org/branding' && method === 'PATCH') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'owner');
    if (!auth) return true;
    const body = await ctx.parseBody(req);
    const set = {};
    if (body.displayName !== undefined) {
      const name = str(body.displayName, 100);
      if (name.length < 2) return fail(res, 400, 'ชื่อที่แสดงต้องยาวอย่างน้อย 2 ตัวอักษร');
      set['branding.displayName'] = name;
    }
    if (body.primaryColor !== undefined) {
      if (!isHexColor(body.primaryColor)) return fail(res, 400, 'สีต้องอยู่ในรูปแบบ #RRGGBB');
      set['branding.primaryColor'] = body.primaryColor.toLowerCase();
    }
    if (body.logoUrl === null) set['branding.logoUrl'] = null;
    if (!Object.keys(set).length) return fail(res, 400, 'ไม่มีอะไรให้แก้ไข');
    await db.collection('organizations').updateOne({ _id: currentOrg._id }, { $set: set });
    org.forgetOrg(currentOrg.slug);
    return send(res, 200, { success: true });
  }

  if (url === '/api/org/cctv-key' && method === 'POST') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'owner');
    if (!auth) return true;
    const key = crypto.randomBytes(24).toString('base64url');
    await db.collection('organizations').updateOne(
      { _id: currentOrg._id },
      { $set: { 'cctv.relayKeyHash': org.hashSecret(key), 'cctv.keyCreatedAt': new Date() } });
    org.forgetOrg(currentOrg.slug);
    // shown once: only its hash is stored. relay.py uses it as RELAY_KEY.
    return send(res, 200, { success: true, data: { relayKey: key } });
  }

  if (url === '/api/org/join' && method === 'POST') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'user');
    if (!auth) return true;
    return send(res, 200, { success: true, data: publicOrg(currentOrg, auth.membership) });
  }

  if (url === '/api/org' && method === 'PATCH') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'owner');
    if (!auth) return true;
    const body = await ctx.parseBody(req);
    const set = {};
    if (body.name !== undefined) {
      const name = str(body.name, 100);
      if (name.length < 2) return fail(res, 400, 'ชื่อองค์กรต้องยาวอย่างน้อย 2 ตัวอักษร');
      set.name = name;
    }
    if (body.services && typeof body.services === 'object') {
      for (const k of ['energyApiUrl', 'controlUrl', 'notifyUrl']) {
        if (body.services[k] === undefined) continue;
        if (body.services[k] === null || body.services[k] === '') { set['services.' + k] = null; continue; }
        // the server calls controlUrl itself, so internal addresses are refused (SSRF)
        if (!security.isAllowedServiceUrl(body.services[k])) return fail(res, 400, `${k} ต้องเป็นลิงก์ https สาธารณะ`);
        set['services.' + k] = body.services[k].trim().replace(/\/+$/, '');
      }
    }
    if (body.joinPolicy !== undefined) {
      if (!members.JOIN_POLICIES.includes(body.joinPolicy)) return fail(res, 400, 'joinPolicy ไม่ถูกต้อง');
      set['settings.joinPolicy'] = body.joinPolicy;
    }
    if (Array.isArray(body.allowedDomains)) {
      set['settings.allowedDomains'] = body.allowedDomains.map(d => str(d, 100).toLowerCase().replace(/^@/, '')).filter(Boolean).slice(0, 20);
    }
    if (body.cctvViewRole !== undefined) {
      if (!members.ROLES.includes(body.cctvViewRole)) return fail(res, 400, 'cctvViewRole ไม่ถูกต้อง');
      set['settings.cctvViewRole'] = body.cctvViewRole;
    }
    if (body.primaryRoomKey !== undefined) set.primaryRoomKey = str(body.primaryRoomKey, 60) || null;
    if (body.primaryMeterId !== undefined) set.primaryMeterId = members.toObjectId(body.primaryMeterId);
    if (!Object.keys(set).length) return fail(res, 400, 'ไม่มีอะไรให้แก้ไข');
    await db.collection('organizations').updateOne({ _id: currentOrg._id }, { $set: set });
    org.forgetOrg(currentOrg.slug);
    return send(res, 200, { success: true });
  }

  if (url === '/api/org/members' && method === 'GET') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'admin');
    if (!auth) return true;
    const list = await db.collection('memberships').find(org.orgFilter(currentOrg)).sort({ joinedAt: 1 }).toArray();
    return send(res, 200, { success: true, data: list.map(members.publicMembership) });
  }

  let m = /^\/api\/org\/members\/([0-9a-f]{24})$/.exec(url);
  if (m && (method === 'PATCH' || method === 'DELETE')) {
    const user = await ctx.requireAuth(req, res);
    if (!user) return true;
    const actor = await members.findMembership(db, currentOrg, user);
    const target = await db.collection('memberships').findOne(org.orgFilter(currentOrg, { _id: members.toObjectId(m[1]) }));
    if (!actor) return fail(res, 403, 'คุณยังไม่ได้เป็นสมาชิกขององค์กรนี้');
    if (!target) return fail(res, 404, 'ไม่พบสมาชิกนี้');
    const isSelf = String(actor._id) === String(target._id);

    let newRole = null;
    if (method === 'PATCH') {
      const body = await ctx.parseBody(req);
      newRole = body.role;
      if (!members.ROLES.includes(newRole)) return fail(res, 400, 'บทบาทไม่ถูกต้อง');
    }
    // anyone may leave (DELETE themselves); everything else needs the right role
    if (!(isSelf && method === 'DELETE') && !members.canManageMember(actor, target, newRole)) {
      return fail(res, 403, 'บทบาทของคุณไม่มีสิทธิ์ทำสิ่งนี้');
    }
    const losesOwner = target.role === 'owner' && (method === 'DELETE' || newRole !== 'owner');
    if (losesOwner && await members.ownerCount(db, currentOrg._id) <= 1) {
      return fail(res, 409, 'องค์กรต้องมีเจ้าของอย่างน้อย 1 คน กรุณาตั้งเจ้าของคนใหม่ก่อน');
    }
    if (method === 'DELETE') {
      await db.collection('memberships').deleteOne({ _id: target._id });
    } else {
      await db.collection('memberships').updateOne({ _id: target._id }, { $set: { role: newRole } });
    }
    return send(res, 200, { success: true });
  }

  if (url === '/api/org/invites' && method === 'GET') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'admin');
    if (!auth) return true;
    const list = await db.collection('invites')
      .find(org.orgFilter(currentOrg, { acceptedAt: null, expiresAt: { $gt: new Date() } }))
      .sort({ createdAt: -1 }).toArray();
    return send(res, 200, {
      success: true,
      data: list.map(i => ({ id: String(i._id), email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt }))
    });
  }

  if (url === '/api/org/invites' && method === 'POST') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'admin');
    if (!auth) return true;
    const body = await ctx.parseBody(req);
    const email = str(body.email, 200).toLowerCase();
    const role = body.role || 'user';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'รูปแบบอีเมลไม่ถูกต้อง');
    if (!['user', 'admin'].includes(role)) return fail(res, 400, 'เชิญได้เฉพาะบทบาท user หรือ admin');
    if (role === 'admin' && auth.membership.role !== 'owner') return fail(res, 403, 'เฉพาะเจ้าขององค์กรที่เชิญ admin ได้');
    const { invite, token } = await members.createInvite(db, currentOrg, auth.user, email, role);
    return send(res, 201, {
      success: true,
      data: {
        id: String(invite._id),
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        // shown once: only its hash is stored
        inviteUrl: `${appBase(req)}/join/?token=${token}`
      }
    });
  }

  m = /^\/api\/org\/invites\/([0-9a-f]{24})$/.exec(url);
  if (m && method === 'DELETE') {
    const auth = await requireRole(req, res, ctx, currentOrg, 'admin');
    if (!auth) return true;
    const r = await db.collection('invites').deleteOne(org.orgFilter(currentOrg, { _id: members.toObjectId(m[1]), acceptedAt: null }));
    if (!r.deletedCount) return fail(res, 404, 'ไม่พบคำเชิญนี้');
    return send(res, 200, { success: true });
  }

  return handleSetupAPI(req, res, url, method, ctx, currentOrg);
}

module.exports = { handleAccountAPI, handleOrgAPI, requireRole };
