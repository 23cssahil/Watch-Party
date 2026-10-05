const mongoose = require('mongoose');
const config = require('../config');
const WatchRoom = require('../models/Room');

/**
 * Remove credentials from a driver error string before it goes into the log.
 *
 * `MONGODB_URI` contains a password, and logs are easy to copy/share by accident.
 * We only replace the `user:pass@` part of a `scheme://user:pass@host` string, so
 * the host names that actually help with debugging stay readable.
 *
 * @param {string} message
 * @returns {string}
 */
function redact(message) {
  return String(message).replace(/:\/\/[^\s/@]+@/g, '://[credential-redacted]@');
}

/**
 * ---------------------------------------------------------------------------
 * Optional persistence layer.
 * ---------------------------------------------------------------------------
 *
 * The assignment says the database is "optional for MVP", so the realtime
 * features must not depend on it. When `MONGODB_URI` isn't set this returns a
 * no-op adapter, and the server boots fine and meets every core requirement with
 * no database at all.
 *
 * When it is set, writes are debounced per room. One drag of the scrubber fires
 * dozens of events, and saving each one would be wasted load since only the final
 * position matters after a restart.
 *
 * What gets written is the `watch_party.rooms` shape — see `models/Room.js` for
 * why each field is there and why live socket state is left out.
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
    /**
     * Shown in `/health` and the boot log, and it's a getter on purpose.
     *
     * `enabled` says what was configured; this has to say what's actually
     * happening, because the most common production problem is a URI that's
     * present but wrong — e.g. an Atlas Network Access list that doesn't include
     * the PaaS's IP range. That's invisible from outside: the app looks fine,
     * and rooms quietly get lost on the next restart. A fixed label would just
     * say "mongodb" the whole time.
     */
    get label() {
      return mongoose.connection.readyState === 1
        ? 'mongodb'
        : 'mongodb (configured, NOT connected)';
    },

    async connect() {
      try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
        console.log('[persistence] MongoDB connected — rooms will survive restarts');
        return true;
      } catch (error) {
        // Don't crash, just fall back: a bad or unreachable Atlas cluster must not
        // take the WebSocket server down with it. We print the most likely cause,
        // since that's the line worth reading in a deploy log.
        //
        // The message is scrubbed first, because a driver error can quote the
        // connection string back, and deploy logs are seen by more people than a
        // secret should be shared with — `user:password@` never leaves this process.
        console.error(
          '[persistence] MongoDB unavailable, running in-memory for now:',
          redact(error.message),
          '| if this is a deployed instance, check Atlas -> Network Access allows this host'
        );
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
              // The chat travels with the metadata write. It's already capped to
              // the last 120 lines in Room.chatLog, so a busy room can't grow the
              // document without limit, and the 2 s debounce keeps a chat burst to
              // a few writes instead of one per message.
              chat: room.chatLog,
              lastActiveAt: new Date(),
            },
            // `$max` instead of `$set`: the peak is a historical fact, so a room
            // restored after a restart (whose live peak starts at 1) must not
            // overwrite a bigger number that was saved earlier.
            $max: { peakParticipants: room.peakSize },
          },
          { upsert: true, new: true }
        ).catch((error) => console.warn('[persistence] write failed:', redact(error.message)));
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
        // Return it shaped for `RoomManager.getOrRestore`, not as a raw document:
        // the caller shouldn't have to know which fields were added when.
        return {
          videoId: doc.videoId,
          title: doc.title || '',
          currentTime: Number(doc.currentTime) || 0,
          duration: Number(doc.durationSec) || 0,
          hostUserId: doc.hostUserId || '',
          peakParticipants: Number(doc.peakParticipants) || 0,
          chat: Array.isArray(doc.chat) ? doc.chat.slice(-120) : [],
          createdAt: doc.createdAt,
        };
      } catch (error) {
        console.warn('[persistence] read failed:', redact(error.message));
        return null;
      }
    },
  };
}

module.exports = { createPersistence };
