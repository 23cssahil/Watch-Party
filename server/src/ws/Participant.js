const { normalizeRole, capabilitiesFor, ROLES } = require('./permissions');

/**
 * One connected person inside a Room.
 *
 * We key by `userId` (a uuid the client makes and stores in localStorage)
 * instead of `socketId`, because the socket drops on every network blip but the
 * person is still there. On reconnect the same Participant just gets a new
 * socketId, which means:
 *   - roles survive a refresh (the Host doesn't lose their room),
 *   - `remove_participant { userId }` stays stable,
 *   - the list doesn't fill up with stale entries from dropped sockets.
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
   * The shape that's safe to send to *other* clients. `socketId` is left out on
   * purpose — it's only used for routing on the server and clients have no need
   * for it.
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
