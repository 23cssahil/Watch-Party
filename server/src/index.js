const http = require('http');
const express = require('express');
const cors = require('cors');
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

// ------------------------------------------------------------------ HTTP API

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
 * Share-link preflight. The client calls this before opening a socket so a typo
 * in a room code shows "no such room" instantly instead of a connection error.
 */
app.get('/api/rooms/:code', (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  const preview = code ? handler.peek(code) : null;
  if (!preview) return res.status(404).json({ ok: false, error: 'Room not found or closed.' });
  res.json({ ok: true, room: preview });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'YouTube Watch Party — API',
    realtime: 'Socket.IO on this same origin, path /socket.io',
    docs: '/health',
  });
});

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
