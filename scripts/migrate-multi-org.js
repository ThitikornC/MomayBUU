// ==================== Migrate the existing BUU data to multi-organization ====================
// Creates the BUU organization with its buildings, rooms and meters (the values that used to be
// hardcoded in script.js and dashboard/script.js), then stamps orgId on every existing booking and
// access log. Only adds fields: it never deletes or rewrites existing values, and it is safe to run
// again (documents that already have an orgId are left alone).
//
// Usage:
//   mongodump --uri "$MONGODB_URI" --db momay_buu      # back up first
//   MONGODB_URI=... node scripts/migrate-multi-org.js           # dry run: prints what would change
//   MONGODB_URI=... node scripts/migrate-multi-org.js --apply   # writes the changes
//
// Owners and admins: --owner you@example.com (repeatable) makes that email an owner of BUU, and
// every email in ADMIN_EMAILS (the env var the server used before roles existed) becomes an admin.
// They are linked to the account the first time that person logs in.

const { MongoClient } = require('mongodb');
const org = require('../org');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'momay_buu';
const APPLY = process.argv.includes('--apply');
const members = require('../members');

function argValues(flag) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1].toLowerCase()); });
  return out;
}
const OWNER_EMAILS = argValues('--owner');
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

const BUU = {
  slug: org.DEFAULT_ORG_SLUG,
  name: 'สำนักหอสมุด ม.บูรพา',
  branding: {
    displayName: 'สำนักหอสมุด ม.บูรพา',
    logoUrl: '/Buulogo.png',
    primaryColor: '#8B4513',
    backgroundUrl: null
  },
  services: {
    // main app: solar, bill, notifications and the building's energy graph (script.js API_BASE)
    energyApiUrl: 'https://momaysandbn-production.up.railway.app',
    controlUrl: process.env.CONTROL_URL || 'https://controlbuu-production.up.railway.app',
    notifyUrl: 'https://momaydocbn-production.up.railway.app'
  },
  primaryMeterKey: 'sand',
  primaryRoomKey: 'ห้อง 101',  // the room the main app shows live data for
  settings: { timezone: 'Asia/Bangkok', bookingEarlyMinutes: 15, joinPolicy: 'open', allowedDomains: [] }
};

// Meters: dashboard/script.js reads ห้อง 101 from the "deer" service and the others from "sand"
const METERS = [
  { key: 'sand', name: 'มิเตอร์หลัก', deviceId: 'pm_sand', energyApiUrl: 'https://momaysandbn-production.up.railway.app', type: 'grid' },
  { key: 'deer', name: 'มิเตอร์ห้อง 101', deviceId: 'pm_sand', energyApiUrl: 'https://momatdeerbn-production.up.railway.app', type: 'grid' }
];

const BUILDING = { key: 'library', name: 'หอสมุด', floors: ['1', '2', '3'], order: 0 };

// key = the room name stored in bookings and sent to the control server; keep it byte-for-byte
const ROOMS = [
  { key: 'ห้อง 101', displayName: 'ห้อง 101', floor: '1', meterKey: 'deer', order: 0 },
  { key: 'ห้อง200', displayName: 'ห้อง 200', floor: '2', meterKey: 'sand', order: 1 },
  { key: 'ห้อง300', displayName: 'ห้อง 300', floor: '3', meterKey: 'sand', order: 2 }
];

// Room names used in bookings before the renames (see git log), mapped to today's key
const LEGACY_ROOM_NAMES = {
  'House': 'ห้อง 101',
  'room1': 'ห้อง200',
  'room2': 'ห้อง300',
  'ห้อง101โถงชั้น1': 'ห้อง 101'
};

function cleanRoomName(name) {
  return (name || '').replace(/\s*▼\s*/, '').trim();
}

async function upsert(db, collection, filter, doc) {
  const existing = await db.collection(collection).findOne(filter);
  if (existing) {
    console.log(`  = ${collection} ${JSON.stringify(filter)} มีอยู่แล้ว`);
    return existing._id;
  }
  console.log(`  + ${collection} ${JSON.stringify(filter)}`);
  if (!APPLY) return null;
  const result = await db.collection(collection).insertOne(Object.assign({}, filter, doc, { createdAt: new Date() }));
  return result.insertedId;
}

(async () => {
  if (!MONGODB_URI) {
    console.error('Set MONGODB_URI first');
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log(APPLY ? `Applying to ${DB_NAME}` : `Dry run on ${DB_NAME} (add --apply to write)`);

  const before = {
    bookings: await db.collection('bookings').countDocuments(),
    access_logs: await db.collection('access_logs').countDocuments()
  };
  console.log('Document counts:', before);

  // 1. Organization
  console.log('\n1. Organization');
  const { slug, primaryMeterKey, ...orgFields } = BUU;
  let orgId = await upsert(db, 'organizations', { slug }, orgFields);

  // Dry run on an empty database: nothing to stamp yet
  if (!orgId) {
    console.log('\n(dry run) the organization does not exist yet, so the steps below are counted only');
  }

  // 2. Building, meters, rooms
  console.log('\n2. Building, meters, rooms');
  const buildingId = orgId && await upsert(db, 'buildings', { orgId, key: BUILDING.key }, { name: BUILDING.name, floors: BUILDING.floors, order: BUILDING.order });
  const meterIds = {};
  for (const m of METERS) {
    const { key, ...rest } = m;
    meterIds[key] = orgId && await upsert(db, 'meters', { orgId, key }, rest);
  }
  const roomIds = {};
  for (const r of ROOMS) {
    const { key, meterKey, ...rest } = r;
    roomIds[key] = orgId && await upsert(db, 'rooms', { orgId, key },
      Object.assign(rest, { buildingId, meterId: meterIds[meterKey] || null, bookable: true }));
  }
  if (orgId && APPLY) {
    await db.collection('organizations').updateOne(
      { _id: orgId, primaryMeterId: { $exists: false } },
      { $set: { primaryMeterId: meterIds[primaryMeterKey] } });
    await db.collection('organizations').updateOne(
      { _id: orgId, primaryRoomKey: { $exists: false } },
      { $set: { primaryRoomKey: BUU.primaryRoomKey } });
  }

  // 3. Stamp orgId on existing documents
  console.log('\n3. orgId on existing data');
  for (const name of ['bookings', 'access_logs']) {
    const n = await db.collection(name).countDocuments({ orgId: { $exists: false } });
    console.log(`  ${name}: ${n} document(s) without orgId`);
    if (APPLY && orgId && n) {
      const r = await db.collection(name).updateMany({ orgId: { $exists: false } }, { $set: { orgId } });
      console.log(`    updated ${r.modifiedCount}`);
    }
  }

  // 4. roomId on bookings and access logs, matching by room name
  console.log('\n4. roomId by room name');
  const unmatched = {};
  for (const name of ['bookings', 'access_logs']) {
    const cursor = db.collection(name).find({ roomId: { $exists: false } }, { projection: { room: 1, bookingId: 1 } });
    let matched = 0;
    for await (const d of cursor) {
      const clean = cleanRoomName(d.room);
      const key = roomIds[clean] !== undefined ? clean : LEGACY_ROOM_NAMES[clean];
      if (!key) {
        unmatched[d.room] = (unmatched[d.room] || 0) + 1;
        continue;
      }
      matched++;
      if (APPLY && roomIds[key]) {
        await db.collection(name).updateOne({ _id: d._id }, { $set: { roomId: roomIds[key] } });
      }
    }
    console.log(`  ${name}: ${matched} matched`);
  }
  if (Object.keys(unmatched).length) {
    console.log('  Room names that match no room (left as they are, check by hand):');
    for (const [room, n] of Object.entries(unmatched)) console.log(`    "${room}": ${n}`);
  }

  // 5. Owners and admins
  console.log('\n5. Owners and admins');
  const roles = new Map();
  ADMIN_EMAILS.forEach(e => roles.set(e, 'admin'));
  OWNER_EMAILS.forEach(e => roles.set(e, 'owner'));
  if (!roles.size) console.log('  (none given — pass --owner you@example.com so someone can manage the organization)');
  for (const [email, role] of roles) {
    const existing = orgId && await db.collection('memberships').findOne({ orgId, email });
    if (existing) {
      console.log(`  = ${email} is already ${existing.role}`);
      continue;
    }
    console.log(`  + ${email} → ${role}`);
    if (APPLY && orgId) {
      await db.collection('memberships').insertOne({
        orgId, userId: members.pendingUserId(email), email, name: '', role, joinedAt: null
      });
    }
  }

  // 6. Indexes and check
  if (APPLY) {
    await org.ensureOrgIndexes(db);
    console.log('\n6. Check');
    for (const name of ['bookings', 'access_logs']) {
      const total = await db.collection(name).countDocuments();
      const missing = await db.collection(name).countDocuments({ orgId: { $exists: false } });
      console.log(`  ${name}: ${total} total (before: ${before[name]}), ${missing} without orgId`);
    }
  }

  await client.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
