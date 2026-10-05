const mongoose = require('mongoose');

/**
 * Saved room metadata — the `rooms` collection in the `watch_party` database.
 * One document per watch party.
 *
 * This is intentionally not a full copy of the live Room object. Socket state
 * (who's connected, whose request is pending) is useless once the process dies,
 * so saving it would just create bad data to load back later. What's worth
 * keeping across a restart is the room's identity and where the video had
 * reached — enough for an old share link to reopen the same watch party.
 *
 * Each field is here for a reason:
 *  - `roomId`          what a share link carries, and the only lookup key
 *  - `videoId`         what to load on restore
 *  - `title`           makes a row readable in the Atlas UI
 *  - `currentTime`     where the video had reached
 *  - `durationSec`     so a restored room can clamp a seek right away
 *  - `hostUserId`      whose room this is, so the owner who reloads or comes back
 *                      after a restart is met by the room as its Host. It records
 *                      ownership only — the roster and live roles are socket state
 *                      and are deliberately not stored (README §5, §8).
 *  - `peakParticipants` how big the party ever got
 *  - `lastActiveAt`    drives the TTL below, and answers "is this alive?"
 *  - `chat`            the last messages, so a restored room reopens with its
 *                      conversation instead of an empty chat panel
 */
const RoomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, uppercase: true },
    // A YouTube id is always exactly 11 characters, so we enforce the shape: a
    // broken row would restore a room whose player can never load a video.
    videoId: { type: String, required: true, match: /^[A-Za-z0-9_-]{11}$/ },
    title: { type: String, default: '', maxlength: 200 },
    currentTime: { type: Number, default: 0, min: 0 },
    durationSec: { type: Number, default: 0, min: 0, max: 86400 },
    hostUserId: { type: String, default: '', maxlength: 64 },
    hostName: { type: String, default: '', maxlength: 24 },
    peakParticipants: { type: Number, default: 0, min: 0 },
    lastActiveAt: { type: Date, default: Date.now },
    // The chat, kept so a room that survives a restart still shows what was said.
    // Capped when written (Room.chatLog holds the last 120); each line is already
    // cleaned at the socket boundary, and every field is bounded here so one
    // document can't grow without limit.
    chat: {
      type: [
        {
          _id: false,
          id: String,
          userId: { type: String, maxlength: 64 },
          username: { type: String, maxlength: 24 },
          role: { type: String, maxlength: 20 },
          text: { type: String, maxlength: 500 },
          at: Number,
        },
      ],
      default: [],
    },
  },
  // Set the collection name explicitly, so it shows up in Atlas as
  // `watch_party.rooms` instead of a guessed plural of the model name.
  { timestamps: true, versionKey: false, collection: 'rooms' }
);

/**
 * Rooms are temporary, so the row describing one should be too. The TTL is on
 * `lastActiveAt` rather than `updatedAt`: every write refreshes it, which keeps a
 * room people are still watching while deleting one nobody has touched in a week.
 */
RoomSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

module.exports = mongoose.models.WatchRoom || mongoose.model('WatchRoom', RoomSchema);
