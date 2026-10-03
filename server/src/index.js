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

/**
 * ---------------------------------------------------------------------------
 * Entry point — wires HTTP and WebSocket onto a *single* Node server.
 * ---------------------------------------------------------------------------
 *
 * Sharing one http.Server is the important bit: it means the API and the
 * realtime layer are the same process and the same origin, so there is no
 * second port to open, no second deploy to keep in step, and no cross-origin
 * cookie dance. Socket.IO multiplexes over the same port and only upgrades to
 * a WebSocket where the browser can, falling back to long-polling when a
 * restrictive network blocks the upgrade.
 */
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: config.clientOrigins,
    credentials: false, // no cookies are used; identity lives in the payload
  },
  // A 50-person room on a free tier should degrade slowly, not instantly.
  maxHttpBufferSize: 1e5,
  pingInterval: 20000,
  pingTimeout: 25000,
});

const persistence = createPersistence();
const roomManager = new RoomManager(io, persistence);
const handler = new MessageHandler({ roomManager });
handler.register(io);

/**
 * Where the built React app lives, if it was built at all.
 *
 * Resolved before the routes because the route table depends on it: Express
 * answers a path with the *first* matching handler, so the service-info route
 * has to know whether the SPA is going to own `/`.
 *
 * Two candidates, in this order:
 *   - `server/client-dist` — what the build step copies in (see the Build
 *     command in the README). Preferred because it makes the directory that
 *     ships self-contained, rather than depending on how the build host lays out
 *     the checkout: Render's log shows the app running from
 *     `/opt/render/project/src/server`, so the sibling `client/dist` does exist
 *     there, but "it should exist" is not something a boot path should rely on.
 *   - `client/dist` — the local monorepo layout, so `npm start` works here with
 *     no copy step.
 */
const CLIENT_BUNDLE_CANDIDATES = [
  path.resolve(__dirname, '../client-dist'),
  path.resolve(__dirname, '../../client/dist'),
];

const clientDist = CLIENT_BUNDLE_CANDIDATES.find((dir) =>
  fs.existsSync(path.join(dir, 'index.html'))
);

// ------------------------------------------------------------------ HTTP API

/**
 * gzip/brotli for everything text-shaped.
 *
 * This is not a micro-optimisation: the measured production bundle is 237 kB and
 * was going over the wire whole, taking ~1.75 s on a cold connection. Compressed
 * it is ~78 kB. On the free tier's single CPU that trade (a few ms of deflate for
 * three fewer seconds of user waiting) is overwhelmingly worth it, and Render
 * does not do it for us — the deploy log shows nothing adding `Content-Encoding`.
 *
 * Socket.IO is unaffected: it takes over its own path on the raw http.Server
 * before Express is ever consulted, and a WebSocket frame is not an HTTP response.
 */
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

/**
 * Share-link preflight: read-only inspection of one room code.
 *
 * Not used by the app itself — the client learns whether a join worked from the
 * `join_room` acknowledgement, and keeping that the single source of truth means
 * there is no second, disagreeable answer to "does this room exist?". This route
 * exists so a dead share link can be diagnosed with one curl instead of by
 * reading server logs.
 *
 * With `MONGODB_URI` set it can also say *why* a code is dead: `live: true` with
 * a participant count, or `live: false` plus what the database still remembers
 * about the party that used to be there.
 */
app.get('/api/rooms/:code', async (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  try {
    const preview = code ? await handler.peek(code) : null;
    if (!preview) return res.status(404).json({ ok: false, error: 'Room not found or closed.' });
    res.json({ ok: true, room: preview });
  } catch (error) {
    // Express 4 does not catch a rejected async handler, and an unhandled
    // rejection here would hang the request instead of answering it.
    console.warn('[http] room preview failed:', error.message);
    res.status(500).json({ ok: false, error: 'Room lookup failed.' });
  }
});

/**
 * Service info. It only claims `/` when there is no client bundle to serve;
 * otherwise the SPA owns `/` and this stays reachable at `/api`. Registering it
 * unconditionally would shadow the app shell forever, and the symptom is
 * confusing from the outside: a healthy deploy that appears to serve only JSON.
 */
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

/**
 * When the React app has been built, this same process serves it.
 *
 * One origin for the API, the WebSocket and the page is not just convenient for
 * a free tier — it deletes an entire class of deployment bug. The split
 * frontend/backend topology needs the frontend URL to be copied into the
 * backend's `CLIENT_ORIGIN` and the backend URL copied back into the frontend's
 * build-time `VITE_SERVER_URL`, and the failure when you get that wrong is a
 * Socket.IO error that looks like a network problem.
 *
 * The API routes are registered above, so they win; this only ever sees
 * anything else. Socket.IO is also safe because it intercepts its own path on
 * the raw HTTP server before Express is consulted.
 */
if (clientDist) {
  const assetsDir = path.join(clientDist, 'assets');

  /**
   * Cache policy, in two halves — and the split is the point.
   *
   * Vite fingerprints every filename under `/assets`, so a name can never point
   * at two different files over time: a year in the browser cache is safe, and it
   * is what makes the *second* visit to a shared link essentially instant.
   *
   * The HTML shell is the opposite: it is the one file whose name never changes
   * and whose content changes on every deploy. Caching it is how a deploy appears
   * to do nothing, because the old shell keeps asking for bundle names that no
   * longer exist. `no-cache` (revalidate, and `express.static` answers with a
   * cheap 304) is the correct setting, not `no-store`.
   */
  const cacheFor = (file) =>
    path.dirname(file) === assetsDir
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

  // `index: false` so the shell is always handed out by the catch-all below and
  // a stale cached copy of it cannot pin clients to an old bundle.
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
    // `cacheControl: false` stops `send` from writing its own Cache-Control over
    // the one set here.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'), { cacheControl: false });
  });
}

// --------------------------------------------------------------------- boot

async function start() {
  if (persistence.enabled) await persistence.connect();

  server.listen(config.port, () => {
    // Read the real bound address rather than assuming localhost: on a PaaS the
    // external host is not `localhost`, and a misleading line here wastes time
    // exactly when the deploy logs are the only thing you have to go on.
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

/**
 * The one event that is never allowed to take the process down. A single bad
 * payload from a curious client should refuse that socket, not kill every other
 * room on the server.
 */
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
