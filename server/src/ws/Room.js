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

/** A calm default so a freshly created room is never a black rectangle. */
const DEFAULT_VIDEO_ID = 'aqz-KE-bpKQ'; // Big Buck Bunny (CC-licensed)

/**
 * ---------------------------------------------------------------------------
 * Room — the authoritative model of one watch party.
 * ---------------------------------------------------------------------------
 *
 * Design rule: **the Room owns the truth, clients own the rendering.**
 *
 * A Room holds the shared playback state and the participant roster. It is the
 * only object allowed to mutate either. That matters because clients disagree
 * with each other by design — someone on mobile will be 400 ms behind, someone
 * will have a paused tab. If the server merely relayed messages, every client
 * would reconstruct a different history and the room would desync permanently.
 * Instead clients send *intents* ("I pressed play"), the Room folds the intent
 * into canonical state, and hands the resulting snapshot back to everyone.
 *
 * The same fold is reused for approved requests, which is why a playback
 * change approved by a Moderator and one performed by the Host are
 * byte-for-byte identical downstream.
 */
class Room {
  /**
   * @param {object} opts
   * @param {string} opts.id        room code
   * @param {import('socket.io').Server} opts.io
   * @param {string} [opts.videoId]
   */
  constructor({ id, io, videoId = DEFAULT_VIDEO_ID }) {
    this.id = id;
    this.io = io;

    /** @type {Map<string, Participant>} keyed by stable userId */
    this.participants = new Map();

    /** @type {Map<string, object>} pending approval requests keyed by requestId */
    this.requests = new Map();

    /** @type {{message:string, username:string, role:string, at:number}[]} */
    this.chatLog = [];

    /**
     * Authoritative shared playback state.
     * `currentTime` is the position *as of* `updatedAt`; while playing, the
     * true position is derived from the clock rather than being polled, so an
     * idle room costs zero CPU and no timer drift accumulates.
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

  /**
   * @param {string} socketId
   * @returns {Participant|undefined}
   */
  findBySocketId(socketId) {
    for (const participant of this.participants.values()) {
      if (participant.socketId === socketId) return participant;
    }
    return undefined;
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

  /** @returns {Participant[]} */
  listParticipants() {
    return [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt);
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

    // First person into an empty room owns it — this is the *only* place the
    // host role is ever minted, so it cannot be claimed from a client payload.
    const isFirstEver = this.participants.size === 0 && !this.hostClaimed;
    const participant = new Participant({
      userId,
      socketId,
      username,
      role: isFirstEver ? ROLES.HOST : ROLES.PARTICIPANT,
    });
    this.participants.set(userId, participant);
    if (participant.isHost) this.hostClaimed = true;
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

    // Their unanswered proposals are meaningless now.
    for (const [requestId, request] of this.requests) {
      if (request.userId === userId) this.requests.delete(requestId);
    }

    // Hostless room would freeze playback for everyone, so the role is
    // inherited by whoever has been connected longest.
    if (participant.isHost) this.promoteSuccessorHost();
    this.touch();
    return participant;
  }

  /** Reassign Host to the longest-tenured remaining person. */
  promoteSuccessorHost() {
    const heir = this.listParticipants()[0];
    if (!heir) return null;
    heir.setRole(ROLES.HOST);
    this.hostClaimed = true;
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
   * Send to only the people allowed to approve requests (Host + Moderators).
   * Keeping the pending-request queue off ordinary participants' sockets means
   * a participant cannot enumerate who else is ignoring them.
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
   * The single funnel through which all playback changes pass.
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

    // Freeze the derived position into a concrete number before mutating.
    const livePosition = this.positionNow();

    switch (action) {
      case 'play':
        this.state.currentTime = livePosition;
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
        // Intentional: a new video starts playing for the whole room. Browsers
        // may block the unmuted autoplay, which the client handles with a
        // "Tap to sync" overlay rather than by desyncing the room.
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
   * Records a video duration reported by a client (only Host/Moderator accepted
   * by the handler). Needed so `seek` can be clamped and drift maths is sane.
   * @param {number} duration
   */
  reportDuration(duration) {
    const value = Number(duration);
    if (!Number.isFinite(value) || value <= 0 || value > 86400) return;
    this.state.duration = value;
  }

  /**
   * @param {Participant|null} actor
   * @param {string} source
   */
  buildSyncPayload(actor, source) {
    return {
      // Spec field name, kept verbatim so the event table in the brief maps 1:1.
      playState: this.state.isPlaying ? 'playing' : 'paused',
      videoId: this.state.videoId,
      currentTime: this.state.currentTime,
      // ...and the position the client should actually be at, resolved against
      // the server clock, so no client has to guess how long the event spent
      // in flight.
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
   * Turn a forbidden-but-requestable intent into a queued proposal.
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

    const mine = [...this.requests.values()].filter((r) => r.userId === userId).length;
    if (mine >= config.room.maxPendingRequestsPerUser) {
      return {
        ok: false,
        error: 'You already have requests waiting for approval. Give the host a moment.',
      };
    }
    if (this.requests.size >= config.room.maxPendingRequestsPerRoom) {
      return { ok: false, error: 'This room has too many pending requests right now.' };
    }

    // One proposal per (user, action) — a second "pause" simply replaces the
    // first rather than making the host approve the same thing twice.
    for (const request of this.requests.values()) {
      if (request.userId === userId && request.action === action) {
        request.payload = payload;
        request.note = String(note).slice(0, 140);
        request.createdAt = Date.now();
        return { ok: true, request: this.serializeRequest(request), created: false };
      }
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
      // Not an error worth surfacing: the room leader may have been watching
      // the same request expire a second earlier on another device.
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

  /** Drop proposals nobody acted on before their TTL. @returns {object[]} expired ones */
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
    // Demoting the Host through assign_role would strand the room without an
    // owner; the transfer_host path is the deliberate way to do it.
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
    return message;
  }

  // --------------------------------------------------------------- snapshot

  /**
   * Everything one client needs to render the room from scratch. Sent on join
   * and on reconnect, so a client never has to "catch up" on missed events.
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
    };
  }
}

module.exports = Room;
module.exports.DEFAULT_VIDEO_ID = DEFAULT_VIDEO_ID;
