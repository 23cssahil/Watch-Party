require('dotenv').config();

// Central config. All the tunable values live here so the websocket logic has no
// magic numbers and production can be re-tuned with environment variables.
const config = {
  port: Number(process.env.PORT) || 4000,

  // Frontend origins allowed to open a Socket.IO connection.
  clientOrigins: (process.env.CLIENT_ORIGIN ||
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  mongoUri: process.env.MONGODB_URI || '',

  // The public demo room: a room anyone can join to try the app without hosting
  // one. It differs from a normal room in two ways (both handled in ws/Room.js):
  //   - No one is the host. Everyone joins as a viewer, so no one can change the
  //     video or control playback for the group.
  //   - Playback is local. Each person runs their own player (the client gets a
  //     demo flag), so pausing/scrubbing only affects their screen. Presence and
  //     chat are still shared.
  // The code has an 'O', which the room-code generator never produces, so a
  // random room can't collide with it.
  demo: {
    code: (process.env.DEMO_ROOM_CODE || 'DEMO24').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    // First track of the demo playlist (Doraemon title song). The client cycles
    // through the rest when a track ends, so this only has to be the opening one.
    videoId: process.env.DEMO_VIDEO_ID || 'iwncGYFPxmU',
  },

  room: {
    // Length of the short shareable room code (e.g. "K7XQ2P").
    codeLength: 6,
    // Hard cap on concurrent participants in one room.
    maxParticipants: 50,
    // A room with no one in it gets cleaned up after this idle time.
    emptyRoomTtlMs: 10 * 60 * 1000,
    // A pending approval request expires, so an old request can't suddenly take
    // over the room much later.
    requestTtlMs: 60 * 1000,
    // Limit how many requests one person can have pending so the host doesn't
    // get spammed.
    maxPendingRequestsPerUser: 2,
    maxPendingRequestsPerRoom: 20,
  },

  sync: {
    // How often the server sends the current state/clock to a room.
    heartbeatIntervalMs: 5000,
    // How much drift (in seconds) we tolerate on the client before re-seeking.
    // Under this we let the player run on its own to avoid janky seeks.
    driftToleranceSec: 1.5,
  },

  // Rate limiting for inbound events. The idea: don't silently drop an action a
  // user can see, because from their side it just looks like a broken button
  // rather than rate limiting. So only the very high-frequency inputs get
  // merged, and anything over budget is rejected with a visible response.
  rateLimit: {
    // Dragging the scrubber fires many seek events per second but only the final
    // position matters, so we merge them over this window.
    seekSettleMs: 90,
    // play/pause/change_video are limited rather than merged. This count is well
    // past anything a person would actually click.
    actionBurstPerWindow: 20,
    actionWindowMs: 1000,
    // Reactions are just decoration, so a simple cooldown is enough. They're on
    // their own limit so a burst of emoji can't block playback controls.
    reactionCooldownMs: 250,
    chatCooldownMs: 700,
  },
};

module.exports = config;
