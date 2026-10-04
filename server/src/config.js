require('dotenv').config();

/**
 * Central runtime configuration.
 *
 * Every tunable lives here so the WebSocket logic contains no magic numbers
 * and so production can be re-tuned with environment variables only.
 */
const config = {
  port: Number(process.env.PORT) || 4000,

  // Frontend origins allowed to open a Socket.IO connection.
  clientOrigins: (process.env.CLIENT_ORIGIN ||
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  mongoUri: process.env.MONGODB_URI || '',

  /**
   * The public demo party.
   *
   * A single, always-available room anyone can drop into to see the product
   * working without hosting one themselves. It is deliberately unlike a normal
   * room in two ways, both enforced in `ws/Room.js`:
   *
   *   - **Nobody is ever the Host.** Every arrival is a Viewer, so no one can
   *     change the shared video or drive everyone's playback — the demo is the
   *     same for everyone and cannot be taken over.
   *   - **Playback is local.** The client runs its own player (see the `demo`
   *     flag it receives on the snapshot), so pausing or scrubbing affects only
   *     that one screen. Presence and chat stay shared.
   *
   * The code contains an `O`, which `utils/roomCode`'s generator excludes, so a
   * random room can never collide with it.
   */
  demo: {
    code: (process.env.DEMO_ROOM_CODE || 'DEMO24').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    // "Despacito" — Luis Fonsi ft. Daddy Yankee. Set by default for the demo.
    videoId: process.env.DEMO_VIDEO_ID || 'kJQP7kiw5Fk',
  },

  room: {
    // Length of the short shareable room code (e.g. "K7XQ2P").
    codeLength: 6,
    // Hard cap on concurrent participants in one room.
    maxParticipants: 50,
    // A room with nobody in it is destroyed after this idle window.
    emptyRoomTtlMs: 10 * 60 * 1000,
    // A pending approval request auto-expires so a stale request can never
    // silently take over the room ten minutes later.
    requestTtlMs: 60 * 1000,
    // Back-pressure: a participant cannot spam the host with requests.
    maxPendingRequestsPerUser: 2,
    maxPendingRequestsPerRoom: 20,
  },

  sync: {
    // How often the server pushes the authoritative clock/state to a room.
    heartbeatIntervalMs: 5000,
    // Client-side drift tolerance in seconds. Below this we let the YouTube
    // player run on its own instead of hard-seeking (which would look janky).
    driftToleranceSec: 1.5,
  },

  /**
   * Inbound pressure control.
   *
   * The rule this block follows: a control a person can see must never be
   * dropped without an answer, because from their side the failure looks like
   * "this button is broken", not like "I was rate limited". So only the
   * genuinely high-frequency inputs are coalesced, and anything over budget is
   * rejected *audibly*.
   */
  rateLimit: {
    // Dragging a scrubber fires dozens of `seek` events per second, and only
    // the final position is meaningful — so they are merged over this window.
    seekSettleMs: 90,
    // play/pause/change_video are budgeted rather than dropped. This many per
    // window is far beyond any human click rate.
    actionBurstPerWindow: 20,
    actionWindowMs: 1000,
    // Reactions are decoration, so a plain cooldown suffices — kept on its own
    // key so a burst of emoji can never stall playback control.
    reactionCooldownMs: 250,
    chatCooldownMs: 700,
  },
};

module.exports = config;
