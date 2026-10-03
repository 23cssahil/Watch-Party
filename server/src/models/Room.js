const mongoose = require('mongoose');

/**
 * Durable room metadata — the `rooms` collection inside the `watch_party`
 * database. One document per watch party.
 *
 * Deliberately *not* a full mirror of the live Room object. Socket state
 * (who is connected, whose seat is pending approval) is meaningless the moment
 * the process dies, so persisting it would just create lies to reload later.
 * What survives a restart usefully is the room's identity and where the video
 * had got to — enough for an old share link to reopen the same watch party.
 *
 * Every field earns its place:
 *  - `roomId`          what a share link carries, and the only query key
 *  - `videoId`         what to cue on restore
 *  - `title`           what makes a row readable in the Atlas UI
 *  - `currentTime`     where the video had got to
 *  - `durationSec`     so a restored room can clamp a seek immediately
 *  - `hostUserId`      whose room this is, so the owner who reloads or comes back
 *                      after a restart is met by the room as its Host. It records
 *                      ownership only: the roster, the roles held by other people
 *                      and the chat are live socket state and are deliberately not
 *                      stored (README §5, §8).
 *  - `peakParticipants` how big the party ever got
 *  - `lastActiveAt`    drives the TTL below, and answers "is this alive?"
 */
const RoomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, uppercase: true },
    // An 11-character YouTube id is a hard shape, not a suggestion: a malformed
    // row would restore a room whose player can never load anything.
    videoId: { type: String, required: true, match: /^[A-Za-z0-9_-]{11}$/ },
    title: { type: String, default: '', maxlength: 200 },
    currentTime: { type: Number, default: 0, min: 0 },
    durationSec: { type: Number, default: 0, min: 0, max: 86400 },
    hostUserId: { type: String, default: '', maxlength: 64 },
    hostName: { type: String, default: '', maxlength: 24 },
    peakParticipants: { type: Number, default: 0, min: 0 },
    lastActiveAt: { type: Date, default: Date.now },
  },
  // An explicit collection name, so what appears in Atlas is `watch_party.rooms`
  // rather than a pluralisation of the model name guessing at it.
  { timestamps: true, versionKey: false, collection: 'rooms' }
);

/**
 * Rooms are ephemeral by nature, so the row that describes one must be too.
 * TTL on `lastActiveAt` rather than `updatedAt`: every write refreshes it, which
 * is what keeps a room people are still watching while deleting one nobody has
 * touched in a week.
 */
RoomSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

module.exports = mongoose.models.WatchRoom || mongoose.model('WatchRoom', RoomSchema);
