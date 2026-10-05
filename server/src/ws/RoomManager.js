const config = require('../config');
const Room = require('./Room');
const { generateRoomCode, normalizeRoomCode } = require('../utils/roomCode');

/**
 * ---------------------------------------------------------------------------
 * RoomManager — keeps the list of live rooms and runs the server's timers.
 * ---------------------------------------------------------------------------
 *
 * Socket.IO already has a broadcast (`io.to(roomId).emit(...)`), but we still
 * keep our own map because Socket.IO only tracks *who's connected*, not the
 * meaning: it doesn't know who the host is, where the video is, or which
 * requests are waiting for approval. That domain state lives here.
 *
 * Two intervals drive the realtime side:
 *
 *  - **heartbeat** — sends the current position to every live room and clears
 *    old approval requests. This is what keeps a room in sync on its own: if a
 *    `sync_state` is lost on a bad connection, the next beat fixes it with no
 *    one having to do anything.
 *
 *  - **sweeper** — deletes rooms that have been empty past their TTL, so an
 *    old abandoned room doesn't sit in memory forever.
 *
 * @typedef {import('./Room')} Room
 */
class RoomManager {
  /**
   * @param {import('socket.io').Server} io
   * @param {{ save?: Function, load?: Function }} [persistence]
   */
  constructor(io, persistence = {}) {
    this.io = io;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.persistence = persistence;

    this.heartbeat = setInterval(() => this.tick(), config.sync.heartbeatIntervalMs);
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.heartbeat.unref?.();
    this.sweeper.unref?.();
  }

  /**
   * @param {string} [videoId]
   * @returns {Room}
   */
  create(videoId) {
    let code = generateRoomCode(config.room.codeLength);
    // Room codes are short and shown to users, so on the rare chance of a
    // collision we just generate a new one rather than let one room reuse
    // another's code.
    while (this.rooms.has(code)) {
      code = generateRoomCode(config.room.codeLength);
    }
    const room = new Room({ id: code, io: this.io, videoId });
    room.onStateChange = (dirty) => this.persist(dirty);
    this.rooms.set(code, room);
    return room;
  }

  /**
   * @param {string} rawCode
   * @returns {Room|undefined}
   */
  get(rawCode) {
    return this.rooms.get(normalizeRoomCode(rawCode));
  }

  /**
   * Return the live demo room, making it if it's not currently loaded (first
   * visit after a boot or restart). Unlike a normal room it isn't restored from
   * the database and never has a host — it's a fixed showcase with the demo video
   * loaded, and Room makes sure everyone who joins is a Viewer.
   * @returns {Room}
   */
  ensureDemo() {
    const code = normalizeRoomCode(config.demo.code);
    const live = this.rooms.get(code);
    if (live) return live;
    const room = new Room({ id: code, io: this.io, videoId: config.demo.videoId, demo: true });
    // Loaded but not playing: each viewer starts it on their own screen with a
    // tap, which is also what the browser needs to allow sound autoplay.
    room.state.isPlaying = false;
    room.onStateChange = (dirty) => this.persist(dirty);
    this.rooms.set(code, room);
    return room;
  }

  /**
   * Find a live room, and if the server has restarted, try to rebuild its saved
   * metadata from the database so an old share link still works.
   *
   * What gets restored: what was playing, the position, duration, the room's age
   * and who owned it. What doesn't: the roster or anyone's live connection. The
   * host role is given by who joins first, never read from a client message —
   * `hostUserId` only records who owned the room, so the person who shared the
   * link gets their own party back as Host instead of joining as a stranger who
   * can't control it. If someone else joins first, they run it until the host
   * transfers.
   * @param {string} rawCode
   * @returns {Promise<Room|undefined>}
   */
  async getOrRestore(rawCode) {
    const code = normalizeRoomCode(rawCode);
    if (!code) return undefined;
    const live = this.rooms.get(code);
    if (live) return live;
    if (typeof this.persistence.load !== 'function') return undefined;

    const saved = await this.persistence.load(code);
    if (!saved) return undefined;

    const room = new Room({ id: code, io: this.io, videoId: saved.videoId });
    room.state.currentTime = Number(saved.currentTime) || 0;
    // Without the duration a restored room can't clamp a seek, so someone
    // joining could scrub past the end of the video.
    room.state.duration = Number(saved.duration) || 0;
    room.videoTitle = typeof saved.title === 'string' ? saved.title : '';
    room.peakSize = Number(saved.peakParticipants) || 0;
    // Chat is real content, so a restored room reopens with its history — the one
    // bit of "live" state worth keeping across a restart.
    room.chatLog = Array.isArray(saved.chat) ? saved.chat.slice(-120) : [];
    // This is ownership, not control. See the note on `Room.hostUserId`.
    room.hostUserId = typeof saved.hostUserId === 'string' ? saved.hostUserId : '';
    if (room.hostUserId) room.hostClaimed = true;
    room.state.isPlaying = false; // don't auto-start for a room of strangers
    room.state.updatedAt = Date.now();
    room.createdAt = saved.createdAt ? new Date(saved.createdAt).getTime() : Date.now();
    room.onStateChange = (dirty) => this.persist(dirty);
    this.rooms.set(code, room);
    console.log(`[RoomManager] restored ${code} from ${this.persistence.label} (seek to ${Math.round(room.state.currentTime)}s)`);
    return room;
  }

  /**
   * Read-only database lookup for the HTTP preview route.
   *
   * This is separate from `getOrRestore` on purpose: someone checking a code in
   * the browser shouldn't create a room, start its timers or give anyone the host
   * role. It just returns what was stored, or nothing.
   * @param {string} rawCode
   * @returns {Promise<object|null>}
   */
  async peekSaved(rawCode) {
    const code = normalizeRoomCode(rawCode);
    if (!code) return null;
    if (typeof this.persistence.load !== 'function') return null;
    return (await this.persistence.load(code)) || null;
  }

  /** @param {Room} room */
  persist(room) {
    if (typeof this.persistence.save !== 'function') return;
    // Fire-and-forget: a slow database must not hold up a playback broadcast.
    Promise.resolve(this.persistence.save(room)).catch((err) => {
      console.warn(`[RoomManager] persist failed for ${room.id}:`, err.message);
    });
  }

  /** @param {string} code */
  delete(code) {
    this.rooms.delete(normalizeRoomCode(code));
  }

  /**
   * Periodic state push + request expiry.
   *
   * This walks the Map directly instead of keeping a separate list of "active"
   * rooms: it's the loop that runs forever, so building a new array every beat
   * would just create garbage to throw away.
   */
  tick() {
    for (const room of this.rooms.values()) {
      if (room.size === 0) continue; // no one to send to
      for (const expired of room.expireStaleRequests()) {
        this.io.to(room.id).emit('request_expired', { request: expired });
      }
      if (!room.state.isPlaying) continue;
      // Only playing rooms need a position refresh; a paused room is already
      // correct for everyone, so we skip sending for it.
      room.io.to(room.id).emit('sync_state', room.buildSyncPayload(null, 'heartbeat'));
    }
  }

  /**
   * Reap idle rooms.
   */
  sweep() {
    const cutoff = Date.now() - config.room.emptyRoomTtlMs;
    for (const [code, room] of this.rooms) {
      // We keep the demo room alive between visitors on purpose — it's the
      // permanent showcase, and an empty one costs nothing (it never plays, so
      // the heartbeat skips it). Deleting it would just make the next joiner wait
      // for a new one and lose the shared chat.
      if (room.demo) continue;
      if (room.size === 0 && room.lastActiveAt < cutoff) {
        this.rooms.delete(code);
        console.log(`[RoomManager] reaped empty room ${code}`);
      }
    }
  }

  shutdown() {
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
  }

  /** Used by the read-only /health endpoint. One pass over the rooms. */
  stats() {
    let activeRooms = 0;
    let participants = 0;
    let pendingRequests = 0;
    for (const room of this.rooms.values()) {
      if (room.size > 0) activeRooms += 1;
      participants += room.size;
      pendingRequests += room.requests.size;
    }
    return {
      rooms: this.rooms.size,
      activeRooms,
      participants,
      pendingRequests,
    };
  }

  /**
   * The list of rooms that currently have people, for the landing page's "Live
   * rooms" panel. It's read-only and kept small on purpose: it only shows what a
   * stranger needs to decide whether to join — the code, the host, the viewer
   * count and the title. It never exposes user ids, socket ids, chat or the
   * approval queue, and joining is still checked by the socket layer (a demo
   * never hosts anyone; a full room refuses).
   *
   * The demo room is always first and always shown, even when empty, since it's
   * the permanent showcase.
   * @param {number} [limit]
   * @returns {Array<{code:string,host:string,viewers:number,title:string,isDemo:boolean}>}
   */
  listLive(limit = 30) {
    const rows = [];
    for (const room of this.rooms.values()) {
      if (room.demo || room.size === 0) continue;
      rows.push({
        code: room.id,
        host: room.getHost()?.username || 'Guest',
        viewers: room.size,
        title: room.videoTitle || '',
        isDemo: false,
      });
    }
    // Busiest first, so a lively room shows up above a nearly-empty one.
    rows.sort((a, b) => b.viewers - a.viewers);

    const live = this.rooms.get(normalizeRoomCode(config.demo.code));
    const demo = {
      code: config.demo.code,
      host: 'Despacito',
      viewers: live ? live.size : 0,
      title: live?.videoTitle || 'Despacito — Luis Fonsi ft. Daddy Yankee',
      isDemo: true,
    };
    return [demo, ...rows].slice(0, limit + 1);
  }
}

module.exports = RoomManager;
