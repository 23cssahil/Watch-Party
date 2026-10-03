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
  reconnectionAttempts: 12,
  // Randomised back-off, so 100 clients whose server restarted do not all
  // reconnect on the same tick and knock it over again.
  reconnectionDelay: 800,
  reconnectionDelayMax: 6000,
  timeout: 12000,
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
