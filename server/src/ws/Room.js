const crypto = require('crypto');
const config = require('../config');
const Participant = require('./Participant');
const {
  ROLES,
  can,
  needsApproval,
  normalizeRole,
  capabilitiesFor,
} = require('./permissions');

/** A sensible default so a new room isn't just a black box. */
const DEFAULT_VIDEO_ID = 'aqz-KE-bpKQ'; // Big Buck Bunny (CC-licensed)

/**
 * ---------------------------------------------------------------------------
 * Room — the authoritative model of one watch party.
 * ---------------------------------------------------------------------------
 *
 * The main idea: the Room holds the truth, the clients just render it.
 *
 * A Room keeps the shared playback state and the participant list, and it's the
 * only thing allowed to change either. This matters because clients naturally
 * disagree — someone on mobile is a bit behind, someone has a paused tab. If the
 * server just passed messages along, each client would build a slightly different
 * picture and the room would drift out of sync for good. Instead clients send
 * intents ("I pressed play"), the Room applies them to one shared state, and
 * sends the result back to everyone.
 *
 * The same code path is used for approved requests, so a playback change approved
 * by a Moderator and one done by the Host end up identical to everyone else.
 */
class Room {
  /**
   * @param {object} opts
   * @param {string} opts.id        room code
   * @param {import('socket.io').Server} opts.io
   * @param {string} [opts.videoId]
   * @param {boolean} [opts.demo]   a public demo party: never hosts anyone
   */
  constructor({ id, io, videoId = DEFAULT_VIDEO_ID, demo = false }) {
    this.id = id;
    this.io = io;
    /**
     * A demo room is a shared space with no owner: everyone who joins is a Viewer
     * and playback is each person's own thing (the client is told through `demo`
     * in the snapshot). See `config.demo` and the checks in `addParticipant` /
     * `ensureHost`.
     */
    this.demo = Boolean(demo);

    /** @type {Map<string, Participant>} keyed by stable userId */
    this.participants = new Map();

    /**
     * Cached join-ordered view of `participants` (see `listParticipants`).
     * It's only cleared where the Map itself grows or shrinks.
     * @type {Participant[]|null}
     */
    this.roster = null;

    /** @type {Map<string, object>} pending approval requests keyed by requestId */
    this.requests = new Map();

    /** @type {{message:string, username:string, role:string, at:number}[]} */
    this.chatLog = [];

    /**
     * Title of the video currently loaded, sent by a client that read it from the
     * player. It's kept out of `state` on purpose: it's just a label for the saved
     * record and the share preview, and no playback rule uses it, so a client
     * lying about it can only mess up a label, not a decision.
     */
    this.videoTitle = '';

    /** Largest the room has ever been. Saved so the Atlas rows show real use. */
    this.peakSize = 0;

    /**
     * Whether a Host has ever been set for this room. A room that's been handed
     * over shouldn't let whoever joins a temporarily-empty room claim it.
     */
    this.hostClaimed = false;

    /**
     * The userId this room belongs to, which outlives their socket.
     *
     * Without this a refresh would cost the Host the room: their connection drops,
     * and if no one else is there there's no one to inherit the role, so the room
     * would sit hostless with no playback control and no one to approve requests.
     * We remember the owner so they come back as the owner.
     */
    this.hostUserId = '';

    /**
     * The shared playback state everyone agrees on.
     * `currentTime` is the position *as of* `updatedAt`; while playing, the real
     * position is worked out from the clock instead of being polled, so an idle
     * room uses no CPU and timer drift doesn't build up.
     */
    this.state = {
      videoId,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      updatedAt: Date.now(),
    };

    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    this.persistDirty = false;
    /** Called by RoomManager whenever durable state changes. @type {null|function} */
    this.onStateChange = null;
  }

  // ---------------------------------------------------------------- lifecycle

  /** @returns {number} number of connected people */
  get size() {
    return this.participants.size;
  }

  /**
   * @returns {number} the shared position right now, in seconds
   */
  positionNow() {
    if (!this.state.isPlaying) return this.state.currentTime;
    const elapsed = (Date.now() - this.state.updatedAt) / 1000;
    const position = this.state.currentTime + elapsed;
    return this.state.duration > 0 ? Math.min(position, this.state.duration) : position;
  }

  /** @param {string} userId @returns {Participant|undefined} */
  getParticipant(userId) {
    return this.participants.get(userId);
  }

  /** @returns {Participant|undefined} */
  getHost() {
    for (const participant of this.participants.values()) {
      if (participant.role === ROLES.HOST) return participant;
    }
    return undefined;
  }

  /**
   * The participant list in join order — the order people see in the sidebar, and
   * the order the host role is passed down in.
   *
   * It's cached instead of re-sorted on every call. One playback event can ask for
   * this list a few times (participants payload, approver queue, a snapshot), and
   * each ask would otherwise be a sort. `joinedAt` never changes once someone
   * joins, so the order only changes when the Map grows or shrinks, and that's
   * where the cache is cleared.
   *
   * Treat the returned array as read-only — it's shared between callers.
   * @returns {Participant[]}
   */
  listParticipants() {
    if (!this.roster) {
      this.roster = [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    }
    return this.roster;
  }

  /** Called wherever a participant is added or removed. */
  dropRosterCache() {
    this.roster = null;
  }

  /**
   * Add, or re-attach on reconnect.
   * @param {object} opts
   * @returns {{ participant: Participant, rejoined: boolean }}
   */
  addParticipant({ userId, socketId, username }) {
    const existing = this.participants.get(userId);
    if (existing) {
      existing.rebindSocket(socketId);
      existing.username = username;
      this.touch();
      return { participant: existing, rejoined: true };
    }

    // The first person into an empty room becomes the host. This is the only
    // place the host role is given from someone arriving, so it can't be claimed
    // from a client message. A demo room is the exception: it's meant to have no
    // owner, so every arrival — including the first — joins as a plain Viewer.
    const isFirstEver = !this.demo && this.participants.size === 0 && !this.hostClaimed;
    const participant = new Participant({
      userId,
      socketId,
      username,
      role: isFirstEver ? ROLES.HOST : ROLES.PARTICIPANT,
    });
    this.participants.set(userId, participant);
    this.dropRosterCache();
    if (participant.isHost) this.hostUserId = userId;
    // Handle the case where just being first isn't enough: the room has no host
    // right now, and this person is either its saved owner coming back, or the
    // only one here. Either way the room shouldn't be left with no one who can
    // make decisions.
    this.ensureHost();
    if (this.participants.size > this.peakSize) this.peakSize = this.participants.size;
    this.touch();
    return { participant, rejoined: false };
  }

  /**
   * @param {string} userId
   * @returns {Participant|null}
   */
  removeParticipant(userId) {
    const participant = this.participants.get(userId);
    if (!participant) return null;
    this.participants.delete(userId);
    this.dropRosterCache();

    // Their still-unanswered proposals don't matter now.
    for (const [requestId, request] of this.requests) {
      if (request.userId === userId) this.requests.delete(requestId);
    }

    // Don't leave a room without someone who can make decisions.
    this.ensureHost();
    this.touch();
    return participant;
  }

  /**
   * Make sure the room has a Host, and return who it is.
   *
   * Order: whoever already has the role; then this room's saved owner if they're
   * present, so a Host refreshing an otherwise-empty page comes back as the Host
   * instead of a Participant; then the person who's been here longest. It's safe
   * to call on every join and every leave.
   *
   * @returns {Participant|null} the host, or null while the room is empty
   */
  ensureHost() {
    // A demo room must never get a Host. Without this the code below would
    // promote the longest-tenured Viewer as soon as anyone arrived, and they
    // could then change the shared video for the whole demo.
    if (this.demo) return null;

    const current = this.getHost();
    if (current) {
      this.hostClaimed = true;
      if (this.hostUserId !== current.userId) this.hostUserId = current.userId;
      return current;
    }

    const heir =
      (this.hostUserId ? this.participants.get(this.hostUserId) : null) ||
      this.listParticipants()[0] ||
      null;
    if (!heir) return null;

    heir.setRole(ROLES.HOST);
    this.hostUserId = heir.userId;
    this.hostClaimed = true;
    // A role change moves the person around in the roster view they're shown.
    this.dropRosterCache();
    // Ownership is saved data, not just live socket state: a room whose host was
    // inherited needs to remember that, or a restart would hand back the restored
    // row still naming the person who left. Writes are debounced per room
    // (db/mongo.js) and a succession is rare, so this basically costs nothing.
    this.markDirty();
    return heir;
  }

  touch() {
    this.lastActiveAt = Date.now();
  }

  // ------------------------------------------------------------- transmission

  /**
   * @param {string} event
   * @param {object} payload
   * @param {string} [exceptUserId]  skip one participant (used to avoid echoing
   *                                 an action back to the person who caused it)
   */
  broadcast(event, payload, exceptUserId) {
    let sender = this.io.to(this.id);
    if (exceptUserId) {
      const skipped = this.participants.get(exceptUserId);
      if (skipped) sender = sender.except(skipped.socketId);
    }
    sender.emit(event, payload);
  }

  /**
   * Send to only the people who can approve requests (Host + Moderators). Not
   * sending the pending-request queue to normal participants means a participant
   * can't see who else is being ignored.
   */
  broadcastToApprovers(event, payload) {
    const socketIds = this.listParticipants()
      .filter((p) => p.isApprover)
      .map((p) => p.socketId);
    if (socketIds.length) this.io.to(socketIds).emit(event, payload);
  }

  /**
   * @param {string} userId
   * @param {string} event
   * @param {object} payload
   */
  sendTo(userId, event, payload) {
    const participant = this.participants.get(userId);
    if (participant) this.io.to(participant.socketId).emit(event, payload);
  }

  // ------------------------------------------------------- playback mutation

  /**
   * The one place all playback changes go through.
   * Returns the broadcast body, or an error object if the payload is invalid.
   *
   * @param {object} opts
   * @param {string} opts.action        play | pause | seek | change_video
   * @param {object} [opts.payload]
   * @param {string} [opts.actorUserId]
   * @param {'direct'|'approved_request'} [opts.source]
   * @returns {{ ok: true, sync: object } | { ok: false, error: string }}
   */
  applyPlayback({ action, payload = {}, actorUserId, source = 'direct' }) {
    const actor = actorUserId ? this.participants.get(actorUserId) : null;
    const now = Date.now();

    // Turn the derived position into a real number before we change anything.
    const livePosition = this.positionNow();

    switch (action) {
      case 'play':
        // If the video reached the end, playing again should restart it.
        // Otherwise, YouTube's player restarts it locally but the server thinks
        // it's still at the end, causing a drift loop.
        this.state.currentTime = (this.state.duration > 0 && livePosition >= this.state.duration)
          ? 0
          : livePosition;
        this.state.isPlaying = true;
        break;

      case 'pause':
        this.state.currentTime = livePosition;
        this.state.isPlaying = false;
        break;

      case 'seek': {
        const time = Number(payload.time);
        if (!Number.isFinite(time) || time < 0) {
          return { ok: false, error: 'A seek needs a non-negative numeric time.' };
        }
        this.state.currentTime = this.state.duration > 0
          ? Math.min(time, this.state.duration)
          : time;
        break;
      }

      case 'change_video': {
        const videoId = typeof payload.videoId === 'string' ? payload.videoId : '';
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
          return { ok: false, error: 'Invalid video id reached the room.' };
        }
        this.state.videoId = videoId;
        this.state.currentTime = 0;
        this.state.duration = 0;
        // On purpose: a new video starts playing for the whole room. Browsers
        // might block the unmuted autoplay, which the client handles with a
        // "Tap to sync" overlay instead of letting the room drift apart.
        this.state.isPlaying = true;
        break;
      }

      default:
        return { ok: false, error: `Unknown playback action "${action}".` };
    }

    this.state.updatedAt = now;
    this.touch();
    this.markDirty();

    return { ok: true, sync: this.buildSyncPayload(actor, source) };
  }

  /**
   * Saves what a client's player actually loaded.
   *
   * The duration is functional: without it `seek` can't clamp and the drift
   * maths has no upper limit. The title is just a label (see `videoTitle`).
   *
   * We accept this from anyone in the room — the value doesn't grant any control,
   * and the first person to finish loading a video usually isn't the Host. The
   * input is checked at the socket boundary, not in this method.
   * @param {number} duration
   * @param {string} [title]
   */
  reportDuration(duration, title) {
    const value = Number(duration);
    if (Number.isFinite(value) && value > 0 && value <= 86400) this.state.duration = value;

    const next = typeof title === 'string' ? title : '';
    if (next && next !== this.videoTitle) {
      this.videoTitle = next;
      // The title is the only human-readable field in the saved row, so learning
      // it is worth a write even when nothing about playback changed.
      this.markDirty();
    }
  }

  /**
   * @param {Participant|null} actor
   * @param {string} source
   */
  buildSyncPayload(actor, source) {
    return {
      // Name matches the spec so the event table in the brief maps directly.
      playState: this.state.isPlaying ? 'playing' : 'paused',
      videoId: this.state.videoId,
      currentTime: this.state.currentTime,
      // ...and the position the client should really be at, worked out against
      // the server clock, so no client has to guess how long the event took to
      // arrive.
      position: this.positionNow(),
      duration: this.state.duration,
      isPlaying: this.state.isPlaying,
      serverTime: Date.now(),
      updatedAt: this.state.updatedAt,
      source,
      actor: actor
        ? { userId: actor.userId, username: actor.username, role: actor.role }
        : null,
    };
  }

  markDirty() {
    this.persistDirty = true;
    if (typeof this.onStateChange === 'function') this.onStateChange(this);
  }

  // ------------------------------------------------------- approval workflow

  /**
   * Turn an action the user can't do directly (but can ask for) into a queued
   * proposal.
   * @param {object} opts
   * @param {string} opts.userId
   * @param {string} opts.action
   * @param {object} [opts.payload]
   * @param {string} [opts.note]
   * @returns {{ ok: true, request: object, created: boolean } | { ok: false, error: string }}
   */
  createRequest({ userId, action, payload = {}, note = '' }) {
    const requester = this.participants.get(userId);
    if (!requester) return { ok: false, error: 'You are no longer in this room.' };
    if (!needsApproval(requester.role, action)) {
      return { ok: false, error: `"${action}" cannot be requested.` };
    }

    if (this.requests.size >= config.room.maxPendingRequestsPerRoom) {
      return { ok: false, error: 'This room has too many pending requests right now.' };
    }

    // One pass over the queue answers two things at once: how many proposals this
    // person already has open (so they can't spam), and whether they're re-sending
    // something already waiting. Re-sending `pause` replaces the pending one
    // instead of making the host approve the same thing twice.
    let mine = 0;
    let already = null;
    for (const request of this.requests.values()) {
      if (request.userId !== userId) continue;
      mine += 1;
      if (!already && request.action === action) already = request;
    }

    if (mine >= config.room.maxPendingRequestsPerUser) {
      return {
        ok: false,
        error: 'You already have requests waiting for approval. Give the host a moment.',
      };
    }

    if (already) {
      already.payload = payload;
      already.note = String(note).slice(0, 140);
      already.createdAt = Date.now();
      return { ok: true, request: this.serializeRequest(already), created: false };
    }

    const request = {
      id: crypto.randomUUID(),
      userId,
      username: requester.username,
      role: requester.role,
      action,
      payload,
      note: String(note).slice(0, 140),
      createdAt: Date.now(),
    };
    this.requests.set(request.id, request);
    return { ok: true, request: this.serializeRequest(request), created: true };
  }

  /** @param {object} request */
  serializeRequest(request) {
    return {
      id: request.id,
      userId: request.userId,
      username: request.username,
      action: request.action,
      payload: request.payload,
      note: request.note,
      createdAt: request.createdAt,
      expiresAt: request.createdAt + config.room.requestTtlMs,
    };
  }

  /** @returns {object[]} */
  listRequests() {
    return [...this.requests.values()].map((r) => this.serializeRequest(r));
  }

  /**
   * Host/Moderator decision on a queued proposal.
   * @param {object} opts
   * @param {string} opts.requestId
   * @param {boolean} opts.approved
   * @param {string} opts.resolverUserId
   * @returns {{ ok: true, executed?: object, request?: object, alreadyGone?: boolean } | { ok: false, error: string }}
   */
  resolveRequest({ requestId, approved, resolverUserId }) {
    const request = this.requests.get(requestId);
    if (!request) {
      // Not worth surfacing as an error: the host might have just watched this
      // same request expire a second earlier on another device.
      return { ok: true, alreadyGone: true };
    }
    this.requests.delete(requestId);

    if (!approved) {
      return { ok: true, request: this.serializeRequest(request) };
    }

    const executed = this.applyPlayback({
      action: request.action,
      payload: request.payload,
      actorUserId: request.userId,
      source: 'approved_request',
    });
    if (!executed.ok) return { ok: false, error: executed.error };

    return { ok: true, request: this.serializeRequest(request), executed: executed.sync };
  }

  /** Remove proposals no one acted on before their TTL. @returns {object[]} the expired ones */
  expireStaleRequests() {
    const cutoff = Date.now() - config.room.requestTtlMs;
    const expired = [];
    for (const [id, request] of this.requests) {
      if (request.createdAt <= cutoff) {
        this.requests.delete(id);
        expired.push(this.serializeRequest(request));
      }
    }
    return expired;
  }

  // -------------------------------------------------------------- governance

  /**
   * @param {object} opts
   * @param {string} opts.targetUserId
   * @param {string} opts.role
   * @param {string} opts.actorUserId
   * @returns {{ ok: true, result: object } | { ok: false, error: string }}
   */
  assignRole({ targetUserId, role, actorUserId }) {
    const actor = this.participants.get(actorUserId);
    if (!actor) return { ok: false, error: 'Session expired, please rejoin.' };
    if (!can(actor.role, 'assign_role')) {
      return { ok: false, error: 'Only the Host can assign roles.' };
    }

    const target = this.participants.get(targetUserId);
    if (!target) return { ok: false, error: 'That participant is no longer in the room.' };
    if (target.userId === actor.userId) {
      return { ok: false, error: 'You cannot change your own role. Transfer host instead.' };
    }

    const nextRole = normalizeRole(role);
    // Letting assign_role demote the Host would leave the room with no owner;
    // transfer_host is the intended way to move the role.
    if (target.isHost || nextRole === ROLES.HOST) {
      return { ok: false, error: 'Use "Transfer host" to move the Host role.' };
    }

    target.setRole(nextRole);
    this.touch();
    this.markDirty();
    return { ok: true, result: target.toPublicJSON() };
  }

  /**
   * @param {object} opts
   * @param {string} opts.targetUserId
   * @param {string} opts.actorUserId
   */
  transferHost({ targetUserId, actorUserId }) {
    const actor = this.participants.get(actorUserId);
    if (!actor) return { ok: false, error: 'Session expired, please rejoin.' };
    if (!can(actor.role, 'transfer_host')) {
      return { ok: false, error: 'Only the Host can transfer the room.' };
    }
    const target = this.participants.get(targetUserId);
    if (!target) return { ok: false, error: 'That participant is no longer in the room.' };
    if (target.userId === actor.userId) {
      return { ok: false, error: 'You are already the Host.' };
    }

    actor.setRole(ROLES.PARTICIPANT);
    target.setRole(ROLES.HOST);
    // Ownership moves with the role, so a later refresh restores the new host.
    this.hostUserId = target.userId;
    this.touch();
    this.markDirty();
    return {
      ok: true,
      result: { previousHost: actor.toPublicJSON(), newHost: target.toPublicJSON() },
    };
  }

  // ------------------------------------------------------------------ chat

  /**
   * @param {object} opts
   * @param {string} opts.userId
   * @param {string} opts.text
   */
  addChatMessage({ userId, text }) {
    const author = this.participants.get(userId);
    if (!author) return null;
    const message = {
      id: crypto.randomUUID(),
      userId,
      username: author.username,
      role: author.role,
      text: String(text).slice(0, 500),
      at: Date.now(),
    };
    this.chatLog.push(message);
    if (this.chatLog.length > 120) this.chatLog.shift();
    this.touch();
    // Chat is saved now: mark it so the debounced write keeps the conversation
    // across a restart. The 2 s debounce (db/mongo.js) turns a burst of messages
    // into a single write instead of one per line.
    this.markDirty();
    return message;
  }

  // --------------------------------------------------------------- snapshot

  /**
   * Everything a client needs to draw the room from scratch. Sent on join and on
   * reconnect, so a client never has to catch up on events it missed.
   * @param {string} userId
   */
  snapshotFor(userId) {
    const me = this.participants.get(userId);
    return {
      roomId: this.id,
      state: { ...this.buildSyncPayload(null, 'snapshot'), position: this.positionNow() },
      participants: this.listParticipants().map((p) => p.toPublicJSON()),
      host: this.getHost()?.toPublicJSON() || null,
      me: me ? me.toPublicJSON() : null,
      capabilities: me ? capabilitiesFor(me.role) : capabilitiesFor(ROLES.PARTICIPANT),
      pendingRequests: me?.isApprover ? this.listRequests() : [],
      chat: this.chatLog.slice(-50),
      createdAt: this.createdAt,
      // Tells the client to run its own player (local play/pause/seek) instead of
      // following the room's shared clock. See `useYouTubeSync`.
      demo: this.demo,
    };
  }
}

module.exports = Room;
module.exports.DEFAULT_VIDEO_ID = DEFAULT_VIDEO_ID;
