const mongoose = require('mongoose');

/**
 * Durable room metadata.
 *
 * Deliberately *not* a full mirror of the live Room object. Socket state
 * (who is connected, whose seat is pending approval) is meaningless the moment
 * the process dies, so persisting it would just create lies to reload later.
 * What survives a restart usefully is the room's identity and where the video
 * had got to — enough for an old share link to reopen the same watch party.
 */
const RoomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    videoId: { type: String, required: true },
    title: { type: String, default: '' },
    currentTime: { type: Number, default: 0 },
    hostName: { type: String, default: '' },
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

RoomSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

module.exports = mongoose.models.WatchRoom || mongoose.model('WatchRoom', RoomSchema);
