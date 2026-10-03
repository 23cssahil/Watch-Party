const mongoose = require('mongoose');
const config = require('../config');
const WatchRoom = require('../models/Room');

/**
 * ---------------------------------------------------------------------------
 * Optional persistence layer.
 * ---------------------------------------------------------------------------
 *
 * The assignment marks the database as "optional for MVP", so the realtime
 * feature set must never depend on it. This module therefore returns a
 * no-op adapter when `MONGODB_URI` is unset, and the server boots normally and
 * passes every core requirement with no database at all.
 *
 * When it *is* configured, writes are debounced per room. A single seek-drag on
 * a scrubber emits dozens of events; writing each one would be pure load with no
 * benefit, because only the final position matters after a restart.
 *
 * @returns {{ enabled: boolean, save: Function, load: Function, connect: Function, label: string }}
 */
function createPersistence() {
  const uri = config.mongoUri;
  const pending = new Map();

  if (!uri) {
    console.log('[persistence] MONGODB_URI unset -> running with in-memory rooms only');
    return {
      enabled: false,
      label: 'in-memory',
      save: () => {},
      load: async () => null,
      connect: async () => false,
    };
  }

  return {
    enabled: true,
    label: 'mongodb',

    async connect() {
      try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
        console.log('[persistence] MongoDB connected — rooms will survive restarts');
        return true;
      } catch (error) {
        // Degrade rather than die: a misconfigured or unreachable Atlas cluster
        // must not take the WebSocket server down with it.
        console.error('[persistence] MongoDB unavailable, falling back to in-memory:', error.message);
        return false;
      }
    },

    /**
     * @param {import('../ws/Room')} room
     */
    save(room) {
      if (mongoose.connection.readyState !== 1) return;
      if (pending.has(room.id)) clearTimeout(pending.get(room.id));
      const timer = setTimeout(() => {
        pending.delete(room.id);
        const host = room.getHost();
        WatchRoom.findOneAndUpdate(
          { roomId: room.id },
          {
            roomId: room.id,
            videoId: room.state.videoId,
            currentTime: Math.round(room.positionNow() * 1000) / 1000,
            hostName: host ? host.username : '',
            lastActiveAt: new Date(),
          },
          { upsert: true, new: true }
        ).catch((error) => console.warn('[persistence] write failed:', error.message));
      }, 2000);
      timer.unref?.();
      pending.set(room.id, timer);
    },

    /**
     * @param {string} roomId
     */
    async load(roomId) {
      if (mongoose.connection.readyState !== 1) return null;
      try {
        const doc = await WatchRoom.findOne({ roomId }).lean();
        return doc ? { videoId: doc.videoId, currentTime: doc.currentTime, createdAt: doc.createdAt } : null;
      } catch (error) {
        console.warn('[persistence] read failed:', error.message);
        return null;
      }
    },
  };
}

module.exports = { createPersistence };
