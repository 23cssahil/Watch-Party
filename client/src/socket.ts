import { io, type Socket } from 'socket.io-client';
import type { ClientEvents, ServerEvents } from './types';

/**
 * The single Socket.IO connection this tab uses.
 *
 * It's a module-level singleton, not a per-component socket. React mounts and
 * unmounts components freely (and twice under StrictMode), so a socket created
 * inside a component could let one person join a room two or three times. Making
 * one connection, created only once, avoids that.
 *
 * In dev VITE_SERVER_URL is left empty, so we connect to the same origin /, which
 * Vite proxies to the Express server (see vite.config.ts). In production it points
 * at the deployed server. Same code either way.
 */
const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
const target = configured && configured.trim() ? configured.trim() : '/';

export const socket: Socket<ServerEvents, ClientEvents> = io(target, {
  // Try a real WebSocket first; fall back to long-polling if a proxy or
  // corporate network blocks the upgrade. Socket.IO will upgrade again later.
  transports: ['websocket', 'polling'],
  reconnection: true,
  // Long enough to outlast a free-tier cold start. A sleeping instance takes
  // 30-50s to answer its first request, and a client that gives up after a few
  // tries turns "wait a moment" into a page that never recovers. We keep the count
  // finite on purpose: Socket.IO only fires reconnect_failed once it hits the
  // limit, and that's what lets the UI show a real error instead of spinning
  // forever. With this back-off, 150 attempts cover about ten minutes.
  reconnectionAttempts: 150,
  // Tuned so room creation feels quick instead of a 7-10s wait. A sleeping instance
  // answers its first request slowly, and each old retry cycle could cost up to
  // timeout (12s) plus up to reconnectionDelayMax (6s) of back-off, so the client
  // could stay out a long time even after the server was up. Now attempts are cheap
  // and frequent: an unanswered try waits 4s, back-off caps at 1.2s, and it
  // reconnects within about a second of the instance being ready. The only cost is
  // a few extra failed requests during a cold start.
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
 * The server keys roles on `userId` (not the socket id), so refreshing the page
 * keeps you as Host and a dropped connection doesn't leave a room without one.
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
