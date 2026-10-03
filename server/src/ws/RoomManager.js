const config = require('../config');
const Room = require('./Room');
const { generateRoomCode, normalizeRoomCode } = require('../utils/roomCode');

/**
 * ---------------------------------------------------------------------------
 * RoomManager — the registry of live rooms + the server's only timers.
 * ---------------------------------------------------------------------------
 *
 * Socket.IO already gives us a broadcast primitive (`io.to(roomId).emit(...)`),
 * so why keep our own map at all? Because Socket.IO's adapter stores *membership*,
 * not *meaning*. It knows which sockets are in "ABC123"; it does not know who the
 * host is, what the video position is, or which proposals are awaiting approval.
 * Those are domain state and they live here.
 *
 * Two background loops run the whole realtime system:
 *
 *  - **heartbeat** — pushes the authoritative position to every live room and
 *    expires stale approval requests. This is what makes the room self-healing:
 *    if a client's `sync_state` is dropped by a flaky network, the next beat
 *    pulls it back into line without anyone pressing anything.
 *
 *  - **sweeper** — destroys rooms that have been empty past their TTL, so a
 *    long-running server cannot be filled with abandoned rooms.
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
    // Codes are user-facing and short, so a collision (however unlikely) must
    // be resolved by regeneration rather than by letting one room hijack another.
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
   * Look for a live room, and if the server has restarted, try to rebuild its
   * durable metadata from the database so an old share link still works.
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
    room.state.isPlaying = false; // never auto-resume into a room of strangers
    room.state.updatedAt = Date.now();
    room.createdAt = saved.createdAt ? new Date(saved.createdAt).getTime() : Date.now();
    room.onStateChange = (dirty) => this.persist(dirty);
    this.rooms.set(code, room);
    return room;
  }

  /** @param {Room} room */
  persist(room) {
    if (typeof this.persistence.save !== 'function') return;
    // Fire-and-forget: a slow database must never delay a playback broadcast.
    Promise.resolve(this.persistence.save(room)).catch((err) => {
      console.warn(`[RoomManager] persist failed for ${room.id}:`, err.message);
    });
  }

  /** @param {string} code */
  delete(code) {
    this.rooms.delete(normalizeRoomCode(code));
  }

  /** @returns {Room[]} */
  get active() {
    return [...this.rooms.values()].filter((room) => room.size > 0);
  }

  /**
   * Periodic state push + request expiry.
   */
  tick() {
    for (const room of this.active) {
      for (const expired of room.expireStaleRequests()) {
        this.io.to(room.id).emit('request_expired', { request: expired });
      }
      if (!room.state.isPlaying) continue;
      // Only playing rooms need a position refresh; paused rooms are already
      // correct for every client, so we save the bandwidth of the whole room.
      room.io.to(room.id).emit('sync_state', room.buildSyncPayload(null, 'heartbeat'));
    }
  }

  /**
   * Reap idle rooms.
   */
  sweep() {
    const cutoff = Date.now() - config.room.emptyRoomTtlMs;
    for (const [code, room] of this.rooms) {
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

  /** Exposed for the read-only /metrics endpoint. */
  stats() {
    return {
      rooms: this.rooms.size,
      activeRooms: this.active.length,
      participants: [...this.rooms.values()].reduce((sum, room) => sum + room.size, 0),
      pendingRequests: [...this.rooms.values()].reduce(
        (sum, room) => sum + room.requests.size,
        0,
      ),
    };
  }
}

module.exports = RoomManager;
