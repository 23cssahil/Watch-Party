import { io, type Socket } from 'socket.io-client';
import type { ClientEvents, ServerEvents } from './types';

/**
 * ---------------------------------------------------------------------------
 * The one Socket.IO connection this tab owns.
 * ---------------------------------------------------------------------------
 *
 * A module-level singleton rather than a per-component socket: React mounts and
 * unmounts components freely (and twice in StrictMode), and a socket created in
 * a component body would mean a room can be joined two or three times by the
 * same person. One connection, created exactly once, is the fix.
 *
 * In development `VITE_SERVER_URL` is left empty and the connection is made to
 * same-origin `/`, which Vite proxies to the Express server (see
 * vite.config.ts). In production it points at the deployed server. Same code
 * either way, no branch on `import.meta.env.DEV` inside the app.
 */
const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
const target = configured && configured.trim() ? configured.trim() : '/';

export const socket: Socket<ServerEvents, ClientEvents> = io(target, {
  // Try a real WebSocket first; fall back to long-polling if a proxy or
  // corporate network blocks the upgrade. Socket.IO will upgrade again later.
  transports: ['websocket', 'polling'],
  reconnection: true,
  // Long enough to outlast a free-tier cold start. A sleeping instance takes
  // 30-50 s to answer the first request, and a client that gives up after a
  // dozen tries turns "wait a moment" into a page that never recovers. The count
  // stays finite on purpose: Socket.IO only fires `reconnect_failed` when it hits
  // the ceiling, and that event is what lets the UI tell the truth instead of
  // spinning forever. At this back-off, 150 attempts cover roughly ten minutes.
  reconnectionAttempts: 150,
  // ---------------------------------------------------------------------------
  // These three numbers are the whole difference between "room created instantly"
  // and the 7-10 second wait that was reported. A sleeping instance answers its
  // first request with a *slow* one, and every retry cycle used to cost up to
  // `timeout` (12 s) of waiting plus up to `reconnectionDelayMax` (6 s) of back-off
  // — so the client could sit out a window long after the server was already up.
  // Attempts are now cheap and frequent: give an unanswered try 4 s, wait at most
  // 1.2 s, and reconnect within about a second of the instance becoming ready.
  // The trade is a few more failed requests during a cold start, which one free
  // instance does not notice.
  reconnectionDelay: 400,
  reconnectionDelayMax: 1200,
  randomizationFactor: 0.3,
  timeout: 4000,
});

const IDENTITY_KEY = 'watch-party:identity';

export interface Identity {
  userId: string;
  username: string;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Older Android WebViews / non-secure contexts.
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A stable per-browser identity.
 *
 * `userId` (not the socket id) is what the server keys roles on, so refreshing
 * the page keeps you as Host and a dropped connection does not orphan a room.
 */
export function getIdentity(): Identity {
  let stored: Partial<Identity> = {};
  try {
    stored = JSON.parse(localStorage.getItem(IDENTITY_KEY) || '{}') as Partial<Identity>;
  } catch {
    stored = {};
  }

  const userId = typeof stored.userId === 'string' && stored.userId ? stored.userId : randomId();
  const username = typeof stored.username === 'string' ? stored.username : '';

  const identity = { userId, username };
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Private mode / storage disabled: a per-session identity is still fine.
  }
  return identity;
}

/** @param {string} username */
export function rememberUsername(username: string) {
  const identity = getIdentity();
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ ...identity, username }));
  } catch {
    /* non-fatal */
  }
}
