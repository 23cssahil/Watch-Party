const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { Server } = require('socket.io');

const config = require('./config');
const { createPersistence } = require('./db/mongo');
const RoomManager = require('./ws/RoomManager');
const MessageHandler = require('./ws/handlers');
const { normalizeRoomCode } = require('./utils/roomCode');

// App entry point. HTTP (Express) and WebSocket (Socket.IO) run on the same
// Node server, so the API and the realtime layer share one process and one
// origin. That means a single port, a single deploy, and Socket.IO can fall
// back to long-polling on its own when a network blocks the websocket upgrade.
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: config.clientOrigins,
    credentials: false, // we don't use cookies; who you are is in the message payload
  },
  // Cap the message size so a big room on the free tier doesn't get overwhelmed.
  maxHttpBufferSize: 1e5,
  pingInterval: 20000,
  pingTimeout: 25000,
});

const persistence = createPersistence();
const roomManager = new RoomManager(io, persistence);
const handler = new MessageHandler({ roomManager });
handler.register(io);

// Where the built React app is, if it has been built. Checked before the routes
// because Express matches handlers top to bottom, so we need to know up front
// whether the SPA is going to own `/`. We try `server/client-dist` first (that's
// the folder the build copies into, so the deployed app is self-contained) and
// fall back to `client/dist` for local `npm start` with no copy step.
const CLIENT_BUNDLE_CANDIDATES = [
  path.resolve(__dirname, '../client-dist'),
  path.resolve(__dirname, '../../client/dist'),
];

const clientDist = CLIENT_BUNDLE_CANDIDATES.find((dir) =>
  fs.existsSync(path.join(dir, 'index.html'))
);

// ------------------------------------------------------------------ HTTP API

// Compress text responses (gzip/brotli). The bundle is ~237 kB raw and took
// about 1.75 s to load on a cold connection; compressed it's ~78 kB, so it's
// worth the small CPU cost on the free tier. Render doesn't add this for us.
// Socket.IO isn't affected since it handles its own path on the raw server.
app.use(compression({ level: 6 }));
app.use(cors({ origin: config.clientOrigins }));
app.use(express.json({ limit: '16kb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'watch-party-server',
    uptimeSec: Math.round(process.uptime()),
    persistence: persistence.label,
    ...roomManager.stats(),
  });
});

// The "Live rooms" list shown on the landing page: read-only, only rooms that
// currently have people, demo pinned first. It's public on purpose so a stranger
// can see activity and join. The list is capped and carries no user ids or chat,
// and the code is just a hint because the real join still goes through the
// socket layer's own checks.
app.get('/api/rooms', (_req, res) => {
  res.json({ ok: true, rooms: roomManager.listLive() });
});

// Share-link check: look up one room code without joining. The app itself
// doesn't use this (it learns the answer from the join_room ack), but it lets us
// debug a dead share link with a quick curl instead of reading server logs. If
// MONGODB_URI is set it can also tell whether a code is live now or was a room
// that has since closed.
app.get('/api/rooms/:code', async (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  try {
    const preview = code ? await handler.peek(code) : null;
    if (!preview) return res.status(404).json({ ok: false, error: 'Room not found or closed.' });
    res.json({ ok: true, room: preview });
  } catch (error) {
    // Express 4 doesn't catch a rejected async handler, so without this the
    // request would hang instead of getting a response.
    console.warn('[http] room preview failed:', error.message);
    res.status(500).json({ ok: false, error: 'Room lookup failed.' });
  }
});

// Basic service info. It only answers on `/` when there's no client bundle to
// serve; otherwise the SPA owns `/` and this stays at `/api`. Registering it on
// `/` always would hide the app shell, which looks like a server that only
// returns JSON.
const serviceInfo = (_req, res) => {
  res.json({
    name: 'YouTube Watch Party — API',
    realtime: 'Socket.IO on this same origin, path /socket.io',
    docs: '/health',
    client: clientDist ? 'served from ' + clientDist : 'not built',
  });
};
app.get('/api', serviceInfo);
if (!clientDist) app.get('/', serviceInfo);

// ----------------------------------------------------------- static client

// If the React app is built, this same process serves it. One origin for the
// API, the socket and the page avoids a whole category of deploy bugs: with a
// split frontend/backend you have to copy the frontend URL into CLIENT_ORIGIN and
// the backend URL into VITE_SERVER_URL, and getting that wrong just looks like a
// network error in Socket.IO. The API routes are registered above so they still
// win; this only handles everything else.
if (clientDist) {
  const assetsDir = path.join(clientDist, 'assets');

  // Two different cache rules, and the split matters. Files under /assets have a
  // hash in the name (Vite fingerprints them), so the name never points to two
  // different files and we can cache them for a year. index.html keeps the same
  // name but changes every deploy, so it's set to no-cache (revalidate) instead;
  // caching the shell is how a deploy looks like it did nothing.
  const cacheFor = (file) =>
    path.dirname(file) === assetsDir
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

  // index:false so the shell is always served by the catch-all below and a stale
  // cached copy can't pin clients to an old bundle.
  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders: (res, file) => res.setHeader('Cache-Control', cacheFor(file)),
    })
  );

  app.get('*', (req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) {
      return next();
    }
    // cacheControl:false stops `send` from overwriting the Cache-Control we set.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'), { cacheControl: false });
  });
}

// --------------------------------------------------------------------- boot

async function start() {
  if (persistence.enabled) await persistence.connect();

  server.listen(config.port, () => {
    // Log the address the server actually bound to instead of assuming
    // localhost, since on a PaaS the external host isn't localhost and a wrong
    // line here is confusing when you're only looking at deploy logs.
    const bound = server.address();
    const local = bound && typeof bound === 'object'
      ? `${bound.address === '::' ? '0.0.0.0' : bound.address}:${bound.port}`
      : String(bound);
    console.log(`\n  YouTube Watch Party server`);
    console.log(`  ├─ listening        : http://${local}`);
    console.log(`  ├─ external host    : ${process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '(not set — dev)'}`);
    console.log(`  ├─ socket.io path   : /socket.io`);
    console.log(`  ├─ allowed origins  : ${config.clientOrigins.join(', ')}`);
    console.log(`  ├─ client bundle    : ${clientDist ? `served from ${clientDist}` : 'NOT FOUND (API only) — check the build step'}`);
    console.log(`  └─ persistence      : ${persistence.label}`);
    console.log('');
  });
}

// These shouldn't crash the whole process. If one client sends a bad payload we
// want to drop that socket, not take down every other room on the server.
process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaughtException:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

function shutdown(signal) {
  console.log(`\n${signal} received, closing server.`);
  roomManager.shutdown();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}

['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
