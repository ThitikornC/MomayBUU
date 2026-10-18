// ==================== Organization members, roles and invites ====================
// A user (from the JWT auth backend) belongs to an organization through a membership
// with one role: owner > admin > user. See the role table in the multi-org plan.

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const org = require('./org');

const ROLES = ['user', 'admin', 'owner'];
const INVITE_DAYS = 7;
// joinPolicy: 'open' = any logged-in user joins as user on first use,
// 'domain' = only emails in settings.allowedDomains, 'invite' = invite link only
const JOIN_POLICIES = ['open', 'domain', 'invite'];

function roleRank(role) {
  return ROLES.indexOf(role);
}

function hasRole(membership, minRole) {
  return !!membership && roleRank(membership.role) >= roleRank(minRole);
}

function emailDomain(email) {
  const i = (email || '').lastIndexOf('@');
  return i > 0 ? email.slice(i + 1).toLowerCase() : '';
}

function canSelfJoin(currentOrg, user) {
  const settings = currentOrg.settings || {};
  const policy = settings.joinPolicy || 'invite';
  if (policy === 'open') return true;
  if (policy === 'domain') return (settings.allowedDomains || []).includes(emailDomain(user.email));
  return false;
}

// Placeholder userId for a membership made for an email before the person has an account
// (bootstrap owner, migrated admins). It is claimed the first time they log in.
function pendingUserId(email) {
  return 'email:' + email.toLowerCase();
}

// The user's membership in this organization, or null.
async function findMembership(db, currentOrg, user) {
  const memberships = db.collection('memberships');
  let m = await memberships.findOne({ orgId: currentOrg._id, userId: user.id });
  if (m) return m;
  if (user.email) {
    m = await memberships.findOneAndUpdate(
      { orgId: currentOrg._id, userId: pendingUserId(user.email) },
      { $set: { userId: user.id, name: user.name, joinedAt: new Date() } },
      { returnDocument: 'after' });
    if (m) return m;
  }
  return null;
}

// Like findMembership, but joins the organization as 'user' when its join policy allows it
async function findOrJoinMembership(db, currentOrg, user) {
  const m = await findMembership(db, currentOrg, user);
  if (m || !canSelfJoin(currentOrg, user)) return m;
  return addMembership(db, currentOrg._id, user, 'user');
}

async function addMembership(db, orgId, user, role) {
  const doc = {
    orgId,
    userId: user.id,
    email: user.email,
    name: user.name || '',
    role,
    joinedAt: new Date()
  };
  try {
    const r = await db.collection('memberships').insertOne(doc);
    doc._id = r.insertedId;
    return doc;
  } catch (e) {
    if (e.code === 11000) return db.collection('memberships').findOne({ orgId, userId: user.id });
    throw e;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createInvite(db, currentOrg, invitedBy, email, role) {
  const token = crypto.randomBytes(32).toString('base64url');
  const doc = {
    orgId: currentOrg._id,
    email: email.toLowerCase(),
    role,
    tokenHash: hashToken(token),
    invitedBy: invitedBy.id,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
    acceptedAt: null
  };
  const r = await db.collection('invites').insertOne(doc);
  doc._id = r.insertedId;
  return { invite: doc, token };
}

async function findInvite(db, token) {
  if (!token || token.length < 20) return null;
  return db.collection('invites').findOne({ tokenHash: hashToken(token) });
}

function inviteState(invite) {
  if (!invite) return 'not_found';
  if (invite.acceptedAt) return 'accepted';
  if (invite.expiresAt < new Date()) return 'expired';
  return 'pending';
}

// Accepts an invite for a logged-in user. Returns { membership, org } or { error, status }.
async function acceptInvite(db, token, user) {
  const invite = await findInvite(db, token);
  const state = inviteState(invite);
  if (state !== 'pending') {
    const messages = { not_found: 'ไม่พบคำเชิญนี้', accepted: 'คำเชิญนี้ถูกใช้ไปแล้ว', expired: 'คำเชิญนี้หมดอายุแล้ว' };
    return { status: state === 'not_found' ? 404 : 410, error: messages[state] };
  }
  if (invite.email !== user.email) {
    return { status: 403, error: `คำเชิญนี้สำหรับ ${invite.email} กรุณาเข้าสู่ระบบด้วยอีเมลนั้น` };
  }
  const currentOrg = await db.collection('organizations').findOne({ _id: invite.orgId });
  if (!currentOrg) return { status: 404, error: 'ไม่พบองค์กรนี้' };

  // Mark used first so the same link can't be accepted twice
  const used = await db.collection('invites').updateOne(
    { _id: invite._id, acceptedAt: null },
    { $set: { acceptedAt: new Date(), acceptedBy: user.id } });
  if (!used.modifiedCount) return { status: 410, error: 'คำเชิญนี้ถูกใช้ไปแล้ว' };

  let membership = await findMembership(db, currentOrg, user);
  if (!membership) {
    membership = await addMembership(db, currentOrg._id, user, invite.role);
  } else if (roleRank(invite.role) > roleRank(membership.role)) {
    await db.collection('memberships').updateOne({ _id: membership._id }, { $set: { role: invite.role } });
    membership.role = invite.role;
  }
  return { membership, org: currentOrg };
}

async function ownerCount(db, orgId) {
  return db.collection('memberships').countDocuments({ orgId, role: 'owner' });
}

// What `actor` may do to `target` (both memberships of the same organization)
function canManageMember(actor, target, newRole) {
  if (!hasRole(actor, 'admin')) return false;
  if (actor.role === 'owner') return true;
  // admins manage users only, and can't promote anyone to admin/owner
  return target.role === 'user' && (!newRole || newRole === 'user');
}

function publicMembership(m) {
  return {
    id: String(m._id),
    userId: m.userId,
    email: m.email,
    name: m.name || '',
    role: m.role,
    pending: m.userId.startsWith('email:'),
    joinedAt: m.joinedAt || null
  };
}

function toObjectId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

function slugify(name) {
  const base = (name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base.length >= 2 ? base : 'org';
}

// Creates an organization with the creator as owner. Picks a free slug if none was given.
async function createOrganization(db, user, { name, slug }) {
  name = (name || '').trim();
  if (name.length < 2 || name.length > 100) return { status: 400, error: 'ชื่อองค์กรต้องยาว 2–100 ตัวอักษร' };

  let wanted = (slug || '').trim().toLowerCase();
  if (wanted && !org.SLUG_RE.test(wanted)) {
    return { status: 400, error: 'ชื่อในลิงก์ใช้ได้เฉพาะ a-z, 0-9 และ - (2–40 ตัวอักษร)' };
  }
  const base = wanted || slugify(name);
  const doc = {
    name,
    branding: { displayName: name, logoUrl: null, primaryColor: '#8B4513', backgroundUrl: null },
    services: {},
    settings: { timezone: 'Asia/Bangkok', bookingEarlyMinutes: 15, joinPolicy: 'invite', allowedDomains: [] },
    createdBy: user.id,
    createdAt: new Date()
  };

  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    if (!org.SLUG_RE.test(candidate)) continue;
    try {
      const r = await db.collection('organizations').insertOne(Object.assign({ slug: candidate }, doc));
      const created = Object.assign({ _id: r.insertedId, slug: candidate }, doc);
      await addMembership(db, created._id, user, 'owner');
      return { org: created };
    } catch (e) {
      if (e.code !== 11000) throw e;
      if (wanted) return { status: 409, error: 'ชื่อในลิงก์นี้มีองค์กรอื่นใช้แล้ว' };
    }
  }
  return { status: 409, error: 'ไม่สามารถสร้างชื่อในลิงก์ได้ กรุณาระบุเอง' };
}

module.exports = {
  ROLES,
  pendingUserId,
  JOIN_POLICIES,
  roleRank,
  hasRole,
  canSelfJoin,
  findMembership,
  findOrJoinMembership,
  addMembership,
  createInvite,
  findInvite,
  inviteState,
  acceptInvite,
  ownerCount,
  canManageMember,
  publicMembership,
  toObjectId,
  createOrganization
};
