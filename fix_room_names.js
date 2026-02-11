const { MongoClient } = require('mongodb');
const MONGODB_URI = 'mongodb+srv://nippit62:ohm0966477158@testing.hgxbz.mongodb.net/?retryWrites=true&w=majority';

(async () => {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('momay_buu');

  // Fix all bookings with ▼ in room name
  const bookings = await db.collection('bookings').find({ room: /▼/ }).toArray();
  let fixed = 0;
  for (const b of bookings) {
    const cleanRoom = b.room.replace(/\s*▼\s*/, '').trim();
    await db.collection('bookings').updateOne({ _id: b._id }, { $set: { room: cleanRoom } });
    console.log(`Fixed: "${b.room}" → "${cleanRoom}" (${b.bookingId})`);
    fixed++;
  }
  console.log(`\nTotal fixed: ${fixed}`);

  // Remove test booking
  const del = await db.collection('bookings').deleteOne({ bookingId: 'TEST' });
  console.log(`Deleted test booking: ${del.deletedCount}`);

  await client.close();
})();
