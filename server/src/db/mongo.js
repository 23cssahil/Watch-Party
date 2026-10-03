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
 * The shape written is `watch_party.rooms` — see `models/Room.js` for why each
 * field is there and why live socket state is deliberately left out.
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
            $set: {
              roomId: room.id,
              videoId: room.state.videoId,
              title: room.videoTitle,
              currentTime: Math.round(room.positionNow() * 1000) / 1000,
              durationSec: Math.round(room.state.duration * 1000) / 1000,
              hostUserId: host ? host.userId : '',
              hostName: host ? host.username : '',
              lastActiveAt: new Date(),
            },
            // `$max` rather than `$set`: the peak is a fact about history, so a
            // room restored after a restart (whose live peak starts at 1) must
            // never overwrite a bigger number that was recorded earlier.
            $max: { peakParticipants: room.peakSize },
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
        if (!doc) return null;
        // Shaped for `RoomManager.getOrRestore`, not a raw document: the caller
        // should not have to know which fields were added to the schema when.
        return {
          videoId: doc.videoId,
          title: doc.title || '',
          currentTime: Number(doc.currentTime) || 0,
          duration: Number(doc.durationSec) || 0,
          hostUserId: doc.hostUserId || '',
          peakParticipants: Number(doc.peakParticipants) || 0,
          createdAt: doc.createdAt,
        };
      } catch (error) {
        console.warn('[persistence] read failed:', error.message);
        return null;
      }
    },
  };
}

module.exports = { createPersistence };
