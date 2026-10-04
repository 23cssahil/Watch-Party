/* eslint-disable no-console */

/**
 * ---------------------------------------------------------------------------
 * Persistence round-trip check.
 * ---------------------------------------------------------------------------
 *
 * `npm run verify` proves the realtime contract; this proves the *database*,
 * which that suite deliberately does not depend on. It goes through the front
 * door — a real Socket.IO client emits what a browser would emit, and then this
 * script reads MongoDB directly to confirm the server wrote what it was told.
 *
 * That distinction matters in an interview: asserting on the document rather
 * than on a function's return value is the only way to catch a debounced write
 * that quietly never happened, or a field that was dropped between the Room
 * object and the schema.
 *
 * It cleans up after itself, so running it does not leave test rooms in the
 * database.
 *
 * Run:  npm run verify:db   (server must be listening, and MONGODB_URI set in
 *       the server's environment — the script exits 0 with a note if it is not)
 */

require('dotenv').config();
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const WatchRoom = require('../src/models/Room');

const URL = process.env.VERIFY_URL || 'http://localhost:4000';
const URI = process.env.MONGODB_URI || '';
const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Longer than the 2 s write debounce in `db/mongo.js`, plus slack. */
const WRITE_ALLOWANCE_MS = 4000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!URI) {
    console.log('SKIP  MONGODB_URI is unset, so there is no database to verify.');
    console.log('      The server is running in in-memory mode, which is a supported configuration.');
    return;
  }

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const database = mongoose.connection.db.databaseName;
  console.log(`      database: ${database} · collections: ${await countCollections()}`);

  const socket = io(URL, { transports: ['websocket'], timeout: 20000 });
  let roomId = '';

  try {
    // ---------------------------------------------------------------- create
    roomId = await new Promise((resolve, reject) => {
      socket.once('connect_error', reject);
      socket.on('connect', () => {
        socket.emit('create_room', { username: 'Persistence', userId: 'verify-db-user' }, (result) => {
          if (!result?.ok) reject(new Error(result?.error || 'create_room was refused'));
          else resolve(result.roomId);
        });
      });
    });
    check('a room created over the socket has a code', Boolean(roomId), roomId);

    // ------------------------------------------------------------- report data
    // Exactly what `useYouTubeSync` sends once a player has loaded: the real
    // duration and the title the player reported.
    socket.emit('report_duration', {
      duration: 596.4,
      title: 'Big Buck Bunny 60fps 4K — Official Blender Open Movie <script>',
    });

    // A chat line, to prove the conversation is persisted too — not just the
    // playback metadata. Sent as the Host, who may chat. The markup in it must
    // be stripped by the same wire-boundary sanitiser chat has always used.
    socket.emit('chat_message', { text: 'persistence probe <b>hello</b>' });

    // The debounced write happens on a timer, so give it room to land.
    await wait(WRITE_ALLOWANCE_MS);

    // ------------------------------------------------------------ read it back
    const doc = await WatchRoom.findOne({ roomId }).lean();
    check('the room was written to the database', Boolean(doc));
    if (doc) {
      check('the share code is stored upper-cased and queryable', doc.roomId === roomId, doc.roomId);
      check('the video id is the shape the schema promises', /^[A-Za-z0-9_-]{11}$/.test(doc.videoId), doc.videoId);
      check('the reported duration landed', Math.round(doc.durationSec) === 596, String(doc.durationSec));
      check('the host is recorded with a stable user id', doc.hostUserId === 'verify-db-user' && Boolean(doc.hostName), doc.hostName);
      check('the peak headcount was recorded', doc.peakParticipants >= 1, String(doc.peakParticipants));
      check('a position was recorded for a resumed room', typeof doc.currentTime === 'number', String(doc.currentTime));
      check('lastActiveAt is set, so the TTL has something to age on', doc.lastActiveAt instanceof Date);
      check('createdAt comes from the schema timestamps', doc.createdAt instanceof Date);

      // The title is untrusted client text: it must arrive sanitised, which is
      // the same guarantee chat and usernames get.
      const title = String(doc.title || '');
      check('the title is stored so an Atlas row reads like a room', title.includes('Big Buck Bunny'), title);
      check('and the markup in it was stripped before storage', !/[<>]/.test(title), title);
      check('the collection is named for the domain, not the model class', WatchRoom.collection.name === 'rooms', WatchRoom.collection.name);

      // Chat is durable now: the message sent above must be readable straight out
      // of the document, with its author intact and its markup sanitised away.
      const chat = Array.isArray(doc.chat) ? doc.chat : [];
      check('the chat log is stored so it survives a restart', chat.length >= 1, String(chat.length));
      check(
        'a stored chat line carries its author and text',
        chat.some((m) => m.username === 'Persistence' && /hello/.test(m.text || '')),
        chat[0]?.text
      );
      check(
        'chat markup is sanitised before storage (no raw angle brackets)',
        !/[<>]/.test(chat.map((m) => m.text).join('')),
        chat[0]?.text
      );
    }

    // ------------------------------------------------------- restore semantics
    // A restored room must be able to clamp a seek, which is only true if the
    // duration survived. Ask the HTTP preview for the same code.
    const preview = await fetch(`${URL}/api/rooms/${roomId}`).then((res) => res.json());
    check('the HTTP preview answers for a live room', preview.ok === true && preview.room.live === true);
    check('and it shows the title rather than a bare video id', Boolean(preview.room?.title), preview.room?.title);

    // ------------------------------------------------------------- succession
    // Ownership is durable data, not only live socket state. When the Host leaves
    // and the longest-tenured survivor takes over, the row has to name the NEW
    // owner: a restart that restored a room whose stored host walked out an hour
    // ago would put the wrong person in charge of the revived room.
    const heir = io(URL, { transports: ['websocket'], timeout: 20000 });
    await new Promise((resolve, reject) => {
      heir.once('connect_error', reject);
      heir.on('connect', () => {
        heir.emit('join_room', { roomId, username: 'Heir', userId: 'verify-db-heir' }, resolve);
      });
    });
    socket.emit('leave_room');
    await wait(WRITE_ALLOWANCE_MS);
    const handedOver = await WatchRoom.findOne({ roomId }).lean();
    check(
      'an inherited Host is the owner the row remembers',
      handedOver?.hostUserId === 'verify-db-heir',
      `${handedOver?.hostUserId} / ${handedOver?.hostName}`
    );
    heir.close();

    // Closing the socket empties the room; the row must outlive it, because that
    // is what lets an old share link reopen the party after a restart.
    socket.disconnect();
    await wait(500);
    const after = await WatchRoom.findOne({ roomId }).lean();
    check('the row survives the room emptying', Boolean(after));
  } finally {
    socket.close();
    if (roomId) await WatchRoom.deleteMany({ roomId });
    await mongoose.disconnect();
  }

  // ------------------------------------------------------------------ report
  for (const line of results) console.log(line);
  console.log('');
  if (failures) {
    console.log(`FAILED  ${failures} of ${results.length} persistence checks`);
    process.exitCode = 1;
  } else {
    console.log(`OK      ${results.length} persistence checks passed (test row deleted again)`);
  }
}

async function countCollections() {
  const names = await mongoose.connection.db.listCollections().toArray();
  const list = names.map((entry) => entry.name).join(', ');
  return list ? `already present: ${list}` : 'will be created on first write';
}

main().catch((error) => {
  console.error('PERSISTENCE CHECK CRASHED:', error.message);
  process.exitCode = 1;
});
