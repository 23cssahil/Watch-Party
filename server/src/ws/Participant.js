const { normalizeRole, capabilitiesFor, ROLES } = require('./permissions');

/**
 * One connected human inside a Room.
 *
 * Keyed by `userId` (a uuid the client generates and keeps in localStorage)
 * rather than by `socketId`, because a socket dies on every network blip but
 * the person does not. On reconnect the same Participant record simply gets a
 * new socketId, which means:
 *   - roles survive a refresh (the Host cannot accidentally lose their room),
 *   - `remove_participant { userId }` is meaningful and stable,
 *   - the participant list does not fill up with ghosts of dropped sockets.
 */
class Participant {
  /**
   * @param {object} opts
   * @param {string} opts.userId
   * @param {string} opts.socketId
   * @param {string} opts.username
   * @param {string} [opts.role]
   */
  constructor({ userId, socketId, username, role = ROLES.PARTICIPANT }) {
    this.userId = userId;
    this.socketId = socketId;
    this.username = username;
    this.role = normalizeRole(role);
    this.joinedAt = Date.now();
    this.lastSeenAt = Date.now();
  }

  /** @param {string} socketId */
  rebindSocket(socketId) {
    this.socketId = socketId;
    this.lastSeenAt = Date.now();
  }

  /** @param {string} role */
  setRole(role) {
    this.role = normalizeRole(role);
  }

  /** @returns {boolean} */
  get isHost() {
    return this.role === ROLES.HOST;
  }

  /** @returns {boolean} */
  get isApprover() {
    return this.role === ROLES.HOST || this.role === ROLES.MODERATOR;
  }

  /**
   * The shape that is safe to put on the wire to *other* clients.
   * Note `socketId` is deliberately excluded — it is a server-side routing
   * detail and leaking it invites clients to try addressing sockets directly.
   * @returns {object}
   */
  toPublicJSON() {
    return {
      userId: this.userId,
      username: this.username,
      role: this.role,
      joinedAt: this.joinedAt,
      capabilities: capabilitiesFor(this.role),
    };
  }
}

module.exports = Participant;
