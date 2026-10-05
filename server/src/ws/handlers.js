const config = require('../config');
const {
  can,
  needsApproval,
  isApprover,
  ROLES,
  capabilitiesFor,
} = require('./permissions');
const { normalizeRoomCode } = require('../utils/roomCode');
const { resolveVideoId } = require('../utils/youtube');
const { sanitizeUsername, sanitizeChat, sanitizeReaction, sanitizeTitle } = require('../utils/sanitize');

/**
 * ---------------------------------------------------------------------------
 * MessageHandler — every inbound WebSocket event, and the check in front of it.
 * ---------------------------------------------------------------------------
 *
 * Event names come straight from the assignment's "WebSocket Events" table
 * (`join_room`, `sync_state`, `assign_role`, `role_assigned`, ...) so the
 * contract matches the brief exactly.
 *
 * `handleAction()` is the one function that implements both RBAC rules. Every
 * playback event goes through it, so there's only one place to check for a
 * permission gap:
 *
 *      can(role, action)      -> change the Room, broadcast sync_state
 *      needsApproval(...)     -> queue a request, notify only Host + Moderators
 *      otherwise              -> refuse, and tell the sender why
 *
 * All three branches reply to the sender. There's no silent fourth path — a
 * button a user can see either does something or explains why it didn't.
 *
 * Nothing here trusts the socket's idea of its own role. The role is always read
 * back from the server-side Participant record, because `socket.data` is only
 * written by this file — a client can't make itself the host by sending
 * `{ role: 'host' }`.
 */
class MessageHandler {
  /** @param {{ roomManager: import('./RoomManager') }} deps */
  constructor({ roomManager }) {
    this.roomManager = roomManager;
  }

  /** @param {import('socket.io').Server} io */
  register(io) {
    io.on('connection', (socket) => this.bind(io, socket));
  }

  /**
   * @param {import('socket.io').Server} io
   * @param {import('socket.io').Socket} socket
   */
  bind(io, socket) {
    socket.data.roomId = null;
    socket.data.userId = null;
    socket.data.lastChatAt = 0;
    socket.data.lastReactionAt = 0;
    socket.data.actionWindow = { start: Date.now(), count: 0 };
    socket.data.seekTimer = null;
    socket.data.pendingSeek = null;

    socket.on('create_room', (payload, ack) => this.createRoom(socket, payload, ack));
    socket.on('join_room', (payload, ack) => this.joinRoom(socket, payload, ack));
    socket.on('leave_room', () => this.leaveRoom(socket));

    // Playback — all four go through the same permission gate.
    socket.on('play', (payload) => this.handleAction(socket, 'play', {}));
    socket.on('pause', (payload) => this.handleAction(socket, 'pause', {}));
    socket.on('seek', (payload) =>
      this.handleAction(socket, 'seek', { time: payload?.time }),
    );
    socket.on('change_video', (payload) => this.changeVideo(socket, payload));

    // Governance.
    socket.on('assign_role', (payload) => this.assignRole(socket, payload));
    socket.on('remove_participant', (payload) => this.removeParticipant(socket, payload));
    socket.on('transfer_host', (payload) => this.transferHost(socket, payload));

    // Approval workflow (the participant path into playback).
    socket.on('request_approval', (payload) => this.requestApproval(socket, payload));
    socket.on('resolve_request', (payload) => this.resolveRequest(socket, payload));
    // Rejection is the same event with `approved: false` — there's intentionally
    // no separate `dismiss` event, so the contract has only one way to vote.

    // Room utilities.
    socket.on('sync_request', () => this.sendSyncState(socket));
    socket.on('report_duration', (payload) => this.reportDuration(socket, payload));
    socket.on('chat_message', (payload) => this.chat(socket, payload));
    socket.on('reaction', (payload) => this.react(socket, payload));

    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  // ------------------------------------------------------------- primitives

  /**
   * @param {import('socket.io').Socket} socket
   * @param {string} message
   * @param {string} [code]
   */
  deny(socket, message, code = 'forbidden') {
    if (code === 'no_room' && !socket.data.roomId) return;
    socket.emit('room_error', { message, code, at: Date.now() });
  }

  /**
   * Resolve the socket to its live Room + Participant, or refuse.
   * @param {import('socket.io').Socket} socket
   * @returns {{ room: import('./Room'), me: import('./Participant') } | null}
   */
  context(socket) {
    const code = normalizeRoomCode(socket.data.roomId);
    if (!code) {
      this.deny(socket, 'You are not in a room yet.', 'no_room');
      return null;
    }
    const room = this.roomManager.get(code);
    if (!room) {
      this.deny(socket, 'That room no longer exists.', 'no_room');
      return null;
    }
    const me = room.getParticipant(socket.data.userId);
    if (!me) {
      // We know this socket but the room has no record of the person behind it
      // (kicked, or a restore on the server raced the reconnect). Make them do a
      // clean rejoin instead of letting an old socket change state.
      this.deny(socket, 'Your seat in this room expired. Please rejoin.', 'stale_session');
      socket.data.roomId = null;
      return null;
    }
    return { room, me };
  }

  /**
   * Simple anti-spam check for decoration-level events (reactions, chat).
   *
   * Not used for playback on purpose: see `overBudget()`.
   *
   * @param {import('socket.io').Socket} socket
   * @param {string} key which timestamp to check
   * @param {number} ms minimum interval
   */
  cooledDown(socket, key, ms) {
    const now = Date.now();
    if (now - (socket.data[key] || 0) < ms) return true;
    socket.data[key] = now;
    return false;
  }

  /**
   * Sliding-window limit for playback actions.
   *
   * Dropping a `play` is the worst thing that could happen here: the person
   * clicked a button, saw nothing, and has no way to know the room ignored them.
   * So playback is never blocked by a short cooldown — it's only capped at a rate
   * no one can actually click, and going over that cap gives a visible refusal
   * instead of silence.
   *
   * @param {import('socket.io').Socket} socket
   */
  overBudget(socket) {
    const { actionWindowMs, actionBurstPerWindow } = config.rateLimit;
    const window = socket.data.actionWindow;
    const now = Date.now();
    if (now - window.start >= actionWindowMs) {
      window.start = now;
      window.count = 0;
    }
    window.count += 1;
    return window.count > actionBurstPerWindow;
  }

  /** Cancels a queued trailing `seek` when the socket's seat goes away. */
  clearPendingSeek(socket) {
    if (!socket.data.seekTimer) return;
    clearTimeout(socket.data.seekTimer);
    socket.data.seekTimer = null;
    socket.data.pendingSeek = null;
  }

  /** @param {import('./Room')} room */
  emitParticipants(room) {
    return room.listParticipants().map((p) => p.toPublicJSON());
  }

  /** @param {import('./Room')} room */
  pushRequestsToApprovers(room) {
    room.broadcastToApprovers('request_queue', { requests: room.listRequests() });
  }

  // ------------------------------------------------------------------ rooms

  createRoom(socket, payload = {}, ack) {
    const username = sanitizeUsername(payload.username) || 'Host';
    const userId = typeof payload.userId === 'string' && payload.userId ? payload.userId : socket.id;

    const requested = typeof payload.video === 'string' ? payload.video : '';
    const resolved = requested ? resolveVideoId(requested) : { ok: true };
    if (!resolved.ok) {
      this.deny(socket, resolved.error, 'bad_video');
      if (typeof ack === 'function') ack({ ok: false, error: resolved.error });
      return;
    }

    const room = this.roomManager.create(resolved.ok ? resolved.videoId : undefined);
    this.enter(socket, room, { userId, username, ack });
  }

  async joinRoom(socket, payload = {}, ack) {
    const code = normalizeRoomCode(payload.roomId);
    if (!code) {
      this.deny(socket, 'A room code is required.', 'bad_request');
      if (typeof ack === 'function') ack({ ok: false, error: 'A room code is required.' });
      return;
    }

    // The public demo room is created on demand instead of being restored from
    // the database: it's a fixed showcase with no owner, so `ensureDemo` returns
    // the live one (or makes a fresh loaded room after a boot). See `config.demo`.
    const isDemo = code === normalizeRoomCode(config.demo.code);
    const room = isDemo
      ? this.roomManager.ensureDemo()
      : await this.roomManager.getOrRestore(code);
    if (!room) {
      const error = `No room found with code ${code}.`;
      this.deny(socket, error, 'not_found');
      if (typeof ack === 'function') ack({ ok: false, error });
      return;
    }

    const username = sanitizeUsername(payload.username) || 'Guest';
    const userId = typeof payload.userId === 'string' && payload.userId ? payload.userId : socket.id;

    if (room.size >= config.room.maxParticipants) {
      const error = `This room is full (${config.room.maxParticipants} seats).`;
      this.deny(socket, error, 'room_full');
      if (typeof ack === 'function') ack({ ok: false, error });
      return;
    }

    this.enter(socket, room, { userId, username, ack, announce: true });
  }

  /**
   * Shared join path for create + join. Puts the socket in the Socket.IO room,
   * registers the Participant, then gives the newcomer a full snapshot and tells
   * everyone else they arrived.
   *
   * @param {import('socket.io').Socket} socket
   * @param {import('./Room')} room
   * @param {{ userId: string, username: string, ack?: Function, announce?: boolean }} opts
   */
  enter(socket, room, { userId, username, ack, announce = false }) {
    // One socket, one room — and just leaving the old channel isn't enough.
    //
    // Without a real exit, the room you left would keep a Participant whose
    // socket no longer exists: a fake entry in the list that inflates the count,
    // stops the room from ever reading as empty, and — if that entry was the
    // Host — leaves a room no one can control or approve anything in. You can hit
    // this by pressing the logo to go Home and then "Create room".
    //
    // Joining the *same* code again isn't a departure: the seat is still theirs,
    // and `addParticipant` re-attaches the new socket to it (this is the reload
    // and rename path, and it has to keep their role).
    const previousCode = normalizeRoomCode(socket.data.roomId);
    if (previousCode && previousCode !== room.id) {
      const previous = this.roomManager.get(previousCode);
      if (previous) this.exit(socket, previous, 'left');
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.userId = userId;

    const { participant, rejoined } = room.addParticipant({ userId, socketId: socket.id, username });

    const snapshot = room.snapshotFor(userId);
    socket.emit('room_state', snapshot);
    if (typeof ack === 'function') ack({ ok: true, roomId: room.id, role: participant.role });

    if (announce && !rejoined) {
      // Spec payload: { username, userId, role, participants }
      socket.broadcast.to(room.id).emit('user_joined', {
        username: participant.username,
        userId: participant.userId,
        role: participant.role,
        participants: this.emitParticipants(room),
      });
      // A newly arrived Host/Moderator needs the queue that already exists.
      if (participant.isApprover && room.requests.size) this.pushRequestsToApprovers(room);
    }
  }

  /**
   * Pressing Leave is leaving, not deleting the room.
   *
   * An earlier version closed the room here and told everyone else "the host
   * ended the party". That was wrong two ways. It contradicted what happened one
   * line later — `exit()` promotes the longest-tenured person still here, so the
   * room was alive with a new Host while everyone was being shown a closed-room
   * screen. And it made one person stepping away end everyone's party with no way
   * back: the shared room code would be dead, and a Host can't recreate a room
   * once it's dropped.
   *
   * So when the host leaves, the room is handed over. `room_deleted` is kept in
   * the contract for a deliberate End-party action, which the UI doesn't offer yet.
   */
  leaveRoom(socket) {
    const ctx = this.context(socket);
    if (!ctx) return;
    this.exit(socket, ctx.room, 'left');
  }

  /**
   * @param {import('socket.io').Socket} socket
   * @param {import('./Room')} room
   * @param {'left'|'removed'} reason
   */
  exit(socket, room, reason) {
    const userId = socket.data.userId;
    this.clearPendingSeek(socket);

    // Only remove the seat if this socket still owns it. A page refresh opens a
    // new connection that rebinds the *same* userId before the browser closes the
    // old one, so the disconnecting socket is often no longer the seat's owner.
    // If we removed by userId in that window we'd delete the live, rebound seat
    // and trigger a false host handover — a plain reload passing the room to
    // whoever joined next. An old disconnect should just clean itself up and not
    // change anything else.
    const seat = userId ? room.getParticipant(userId) : null;
    if (seat && seat.socketId !== socket.id) {
      socket.leave(room.id);
      socket.data.roomId = null;
      socket.data.userId = null;
      return;
    }

    const leaving = room.removeParticipant(userId);
    socket.leave(room.id);
    socket.data.roomId = null;
    socket.data.userId = null;
    if (!leaving) return;

    const participants = this.emitParticipants(room);

    // Spec payload for user_left: { username, userId, participants }
    socket.broadcast.to(room.id).emit(reason === 'removed' ? 'participant_removed' : 'user_left', {
      username: leaving.username,
      userId: leaving.userId,
      reason,
      participants,
    });

    // Leaving can quietly change who the host is, so give the survivor that's
    // left an up-to-date view of the room.
    const heir = room.getHost();
    if (leaving.isHost && heir) {
      room.broadcast('host_transferred', {
        userId: heir.userId,
        username: heir.username,
        role: heir.role,
        automatic: true,
        participants,
      });
      room.sendTo(heir.userId, 'room_state', room.snapshotFor(heir.userId));
    }

    this.pushRequestsToApprovers(room);
  }

  onDisconnect(socket) {
    const code = normalizeRoomCode(socket.data.roomId);
    if (!code) return;
    const room = this.roomManager.get(code);
    if (!room) return;
    this.exit(socket, room, 'left');
  }

  // -------------------------------------------------------------- playback

  /**
   * The permission gate.
   *
   * @param {import('socket.io').Socket} socket
   * @param {'play'|'pause'|'seek'} action
   * @param {object} payload
   */
  handleAction(socket, action, payload) {
    const ctx = this.context(socket);
    if (!ctx) return;

    // Dragging the scrubber is the one really high-frequency input, and only its
    // final value matters, so we merge it instead of limiting it.
    if (action === 'seek') {
      this.scheduleSeek(socket, payload);
      return;
    }

    if (this.overBudget(socket)) {
      this.deny(socket, 'Too many controls at once — give the room a second.', 'slow_down');
      return;
    }

    this.applyIntent(socket, ctx.room, ctx.me, action, payload);
  }

  /**
   * `seek` merger: remember the latest target and apply it once the drag stops.
   * The room ends up where the user left the handle, with one broadcast instead
   * of dozens.
   *
   * @param {import('socket.io').Socket} socket
   * @param {object} payload
   */
  scheduleSeek(socket, payload) {
    socket.data.pendingSeek = payload;
    if (socket.data.seekTimer) return;
    socket.data.seekTimer = setTimeout(() => {
      socket.data.seekTimer = null;
      const pending = socket.data.pendingSeek;
      socket.data.pendingSeek = null;
      if (!pending || !socket.connected) return;
      const ctx = this.context(socket);
      if (!ctx) return;
      // Finishing one drag shouldn't count as spam, so this last apply skips the
      // budget check.
      socket.data.actionWindow.count = Math.min(
        socket.data.actionWindow.count,
        config.rateLimit.actionBurstPerWindow
      );
      this.applyIntent(socket, ctx.room, ctx.me, 'seek', pending);
    }, config.rateLimit.seekSettleMs);
  }

  /**
   * The real three-way decision, used for both direct events and merged ones.
   *
   * @param {import('socket.io').Socket} socket
   * @param {import('./Room')} room
   * @param {import('./Participant')} me
   * @param {string} action
   * @param {object} payload
   */
  applyIntent(socket, room, me, action, payload) {
    if (can(me.role, action)) {
      this.execute(room, action, payload, me.userId, 'direct');
      return;
    }

    if (needsApproval(me.role, action)) {
      this.queueAsRequest(room, me, action, payload, socket);
      return;
    }

    this.deny(socket, `Your role (${me.role}) cannot perform "${action}".`, 'forbidden');
  }

  /**
   * Mutate authoritative state and broadcast it.
   * @param {import('./Room')} room
   * @param {string} action
   * @param {object} payload
   * @param {string} actorUserId
   * @param {'direct'|'approved_request'} source
   */
  execute(room, action, payload, actorUserId, source) {
    const result = room.applyPlayback({ action, payload, actorUserId, source });
    if (!result.ok) {
      room.sendTo(actorUserId, 'room_error', { message: result.error, code: 'bad_payload' });
      return null;
    }
    // Spec says "server broadcasts". Everyone gets it, including the person who
    // caused it, so their own local guess gets corrected instead of trusted.
    room.broadcast('sync_state', result.sync);
    return result.sync;
  }

  /**
   * `change_video` is split out just because a pasted value needs parsing (full
   * URL vs plain id) before it can go through the gate.
   */
  changeVideo(socket, payload = {}) {
    const resolved = resolveVideoId(payload.videoId ?? payload.url);
    if (!resolved.ok) {
      // `room_error` is the only channel the contract defines for a refusal, so
      // the client's normal error path already handles a bad paste — no separate
      // one-off event to keep in sync.
      this.deny(socket, resolved.error, 'bad_video');
      return;
    }
    this.handleAction(socket, 'change_video', { videoId: resolved.videoId });
  }

  // ------------------------------------------------------------- approvals

  /**
   * A restricted user pressed a control: turn it into a proposal.
   * @param {import('./Room')} room
   * @param {import('./Participant')} me
   * @param {string} action
   * @param {object} payload
   * @param {import('socket.io').Socket} socket
   */
  queueAsRequest(room, me, action, payload, socket) {
    const result = room.createRequest({ userId: me.userId, action, payload });
    if (!result.ok) {
      this.deny(socket, result.error, 'request_rejected');
      return;
    }

    // Tell the requester their action is pending, not applied. Without this the
    // participant's player would just sit there with no explanation.
    socket.emit('request_pending', { request: result.request });

    // Spec: broadcast role updates so the UI can show restricted users. The queue
    // itself only ever goes to Host/Moderators.
    room.broadcastToApprovers('request_received', {
      request: result.request,
      requests: room.listRequests(),
    });
  }

  /**
   * Started on purpose by the client (the "Ask host to..." menu, which can carry
   * an optional note). Same check as an accidental click.
   */
  requestApproval(socket, payload = {}) {
    const ctx = this.context(socket);
    if (!ctx) return;
    const { room, me } = ctx;

    const action = String(payload.action || '');
    if (!needsApproval(me.role, action)) {
      // Either they're allowed to just do it, or the action can't be requested.
      if (can(me.role, action)) {
        this.execute(room, action, payload.payload || {}, me.userId, 'direct');
        return;
      }
      this.deny(socket, `"${action}" cannot be requested from the host.`, 'not_requestable');
      return;
    }

    let requestPayload = payload.payload || {};
    if (action === 'change_video') {
      const resolved = resolveVideoId(requestPayload.videoId ?? requestPayload.url);
      if (!resolved.ok) return this.deny(socket, resolved.error, 'bad_video');
      requestPayload = { videoId: resolved.videoId };
    }
    if (action === 'seek') {
      const time = Number(requestPayload.time);
      if (!Number.isFinite(time) || time < 0) {
        return this.deny(socket, 'A seek request needs a valid time.', 'bad_payload');
      }
      requestPayload = { time };
    }

    const result = room.createRequest({
      userId: me.userId,
      action,
      payload: requestPayload,
      note: payload.note,
    });
    if (!result.ok) return this.deny(socket, result.error, 'request_rejected');

    socket.emit('request_pending', { request: result.request });
    room.broadcastToApprovers('request_received', {
      request: result.request,
      requests: room.listRequests(),
    });
  }

  /**
   * Host/Moderator decision on a proposal.
   */
  resolveRequest(socket, payload = {}) {
    const ctx = this.context(socket);
    if (!ctx) return;
    const { room, me } = ctx;

    if (!isApprover(me.role)) {
      return this.deny(socket, 'Only the Host or a Moderator can approve requests.', 'forbidden');
    }

    const requestId = String(payload.requestId || '');
    if (!requestId) return this.deny(socket, 'Missing request id.', 'bad_request');

    const approved = payload.approved !== false;
    const result = room.resolveRequest({ requestId, approved, resolverUserId: me.userId });
    if (!result.ok) return this.deny(socket, result.error, 'resolve_failed');
    if (result.alreadyGone) {
      this.pushRequestsToApprovers(room);
      return;
    }

    room.broadcast('request_resolved', {
      request: result.request,
      approved,
      resolvedBy: { userId: me.userId, username: me.username, role: me.role },
    });

    if (approved && result.executed) room.broadcast('sync_state', result.executed);
    this.pushRequestsToApprovers(room);
  }

  // ------------------------------------------------------------ governance

  assignRole(socket, payload = {}) {
    const ctx = this.context(socket);
    if (!ctx) return;
    const { room, me } = ctx;

    const result = room.assignRole({
      targetUserId: String(payload.userId || ''),
      role: payload.role,
      actorUserId: me.userId,
    });
    if (!result.ok) return this.deny(socket, result.error, 'forbidden');

    const participants = this.emitParticipants(room);
    // Spec payload: { userId, username, role, participants }
    room.broadcast('role_assigned', {
      userId: result.result.userId,
      username: result.result.username,
      role: result.result.role,
      assignedBy: me.username,
      participants,
    });

    // The person demoted/promoted now has a different capability list; re-send it
    // so their buttons update right away without a refresh.
    room.sendTo(result.result.userId, 'room_state', room.snapshotFor(result.result.userId));
  }

  removeParticipant(socket, payload = {}) {
    const ctx = this.context(socket);
    if (!ctx) return;
    const { room, me } = ctx;

    if (!can(me.role, 'remove_participant')) {
      return this.deny(socket, 'Only the Host can remove participants.', 'forbidden');
    }

    const targetUserId = String(payload.userId || '');
    if (!targetUserId) return this.deny(socket, 'Missing participant id.', 'bad_request');
    if (targetUserId === me.userId) {
      return this.deny(socket, 'Use "Leave room" to remove yourself.', 'bad_request');
    }

    const target = room.getParticipant(targetUserId);
    if (!target) return this.deny(socket, 'That participant is no longer in the room.', 'not_found');
    if (target.isHost) {
      return this.deny(socket, 'The Host cannot be removed. Transfer host first.', 'forbidden');
    }

    // Let the removed person know before we delete their seat, so the client can
    // show a specific "you were removed" screen instead of just dropping the
    // connection with no reason.
    room.sendTo(targetUserId, 'removed_from_room', {
      roomId: room.id,
      by: me.username,
      reason: payload.reason || 'The host removed you from this room.',
    });

    const removed = room.removeParticipant(targetUserId);
    const participants = this.emitParticipants(room);
    room.broadcast('participant_removed', {
      userId: targetUserId,
      username: removed?.username || 'Unknown',
      participants,
    });
    this.pushRequestsToApprovers(room);
  }

  transferHost(socket, payload = {}) {
    const ctx = this.context(socket);
    if (!ctx) return;
    const { room, me } = ctx;

    const result = room.transferHost({
      targetUserId: String(payload.userId || ''),
      actorUserId: me.userId,
    });
    if (!result.ok) return this.deny(socket, result.error, 'forbidden');

    const participants = this.emitParticipants(room);
    room.broadcast('host_transferred', {
      userId: result.result.newHost.userId,
      username: result.result.newHost.username,
      previousHost: me.username,
      automatic: false,
      participants,
    });

    // Both people just changed role — each needs a fresh snapshot.
    room.sendTo(me.userId, 'room_state', room.snapshotFor(me.userId));
    room.sendTo(result.result.newHost.userId, 'room_state', room.snapshotFor(result.result.newHost.userId));
  }

  // -------------------------------------------------------------- utilities

  sendSyncState(socket) {
    const ctx = this.context(socket);
    if (!ctx) return;
    const { room, me } = ctx;
    socket.emit('sync_state', room.buildSyncPayload(me, 'sync_request'));
  }

  /**
   * Clients tell us what their player loaded: the real duration (so the server
   * can clamp seeks) and the title (so the saved row and the share-link preview
   * say what a party is watching, not just an 11-character id).
   *
   * Accepted from anyone, and checked here at the socket boundary. Neither value
   * gives any control: a client can mislabel a room, but it can't seek, pause or
   * promote anyone through this event.
   */
  reportDuration(socket, payload = {}) {
    const ctx = this.context(socket);
    if (!ctx) return;
    ctx.room.reportDuration(payload.duration, sanitizeTitle(payload.title));
  }

  chat(socket, payload = {}) {
    const ctx = this.context(socket);
    if (!ctx) return;
    const { room, me } = ctx;

    if (!can(me.role, 'chat')) return this.deny(socket, 'Chat is disabled for you.', 'forbidden');

    if (this.cooledDown(socket, 'lastChatAt', config.rateLimit.chatCooldownMs)) return;

    const text = sanitizeChat(payload.text);
    if (!text) return;

    const message = room.addChatMessage({ userId: me.userId, text });
    if (message) room.broadcast('chat_message', { message });
  }

  react(socket, payload = {}) {
    const ctx = this.context(socket);
    if (!ctx) return;
    const { room, me } = ctx;

    const emoji = sanitizeReaction(payload.emoji);
    if (!emoji) return;
    if (this.cooledDown(socket, 'lastReactionAt', config.rateLimit.reactionCooldownMs)) return;

    room.broadcast('reaction', {
      emoji,
      userId: me.userId,
      username: me.username,
    });
  }

  /**
   * Called by the HTTP layer when a room is looked up by code (share-link
   * preview). Read-only, joins nothing, and never makes a room — a lookup for a
   * dead code shouldn't bring it back as a live object.
   *
   * If no one is in the room it answers with `live: false` and whatever the
   * database remembers, which is how you tell "that code never existed" apart
   * from "that party is over" — the two things a dead share link needs to say.
   * @param {string} code
   * @returns {Promise<object|null>}
   */
  async peek(code) {
    const room = this.roomManager.get(code);
    if (room) {
      return {
        live: true,
        roomId: room.id,
        videoId: room.state.videoId,
        title: room.videoTitle,
        position: Math.round(room.positionNow()),
        isPlaying: room.state.isPlaying,
        participants: room.size,
        peakParticipants: room.peakSize,
        hasHost: Boolean(room.getHost()),
        roleHints: capabilitiesFor(ROLES.PARTICIPANT),
      };
    }

    const saved = await this.roomManager.peekSaved(code);
    if (!saved) return null;
    return {
      live: false,
      roomId: code,
      videoId: saved.videoId,
      title: saved.title,
      position: Math.round(saved.currentTime),
      participants: 0,
      peakParticipants: saved.peakParticipants,
      lastActiveAt: saved.createdAt,
    };
  }
}

module.exports = MessageHandler;
