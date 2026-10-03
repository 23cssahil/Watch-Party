/**
 *== Role-Based Access Control — the single source of truth for permissions.
 */

const ROLES = Object.freeze({
  HOST: 'host',
  MODERATOR: 'moderator',
  PARTICIPANT: 'participant',
});

/*
 * The brief lists "Viewer" as "Same as Participant (alias, if you want to
 * distinguish)". We accept the word on the wire but collapse it to
 * `participant` immediately, so no downstream code ever branches on a role
 * that has no distinct behaviour. Fewer roles ==       fewer permission bugs.
 */
const ROLE_ALIASES = Object.freeze({
  viewer: ROLES.PARTICIPANT,
  admin: ROLES.HOST,
});

/** Actions that change shared playback state for everyone in the room. */
const PLAYBACK_ACTIONS = Object.freeze(['play', 'pause', 'seek', 'change_video']);

/** Actions that govern the room itself. */
const GOVERNANCE_ACTIONS = Object.freeze([
  'assign_role',
  'remove_participant',
  'transfer_host',
]);

/** Actions anybody in the room may do. */
const OPEN_ACTIONS = Object.freeze(['chat', 'react', 'sync_request']);

/**
 * action -> roles allowed to execute it *directly*.
 * Anything absent from this map is denied to everyone.
 */
const PERMISSIONS = Object.freeze({
  play: [ROLES.HOST, ROLES.MODERATOR],
  pause: [ROLES.HOST, ROLES.MODERATOR],
  seek: [ROLES.HOST, ROLES.MODERATOR],
  change_video: [ROLES.HOST, ROLES.MODERATOR],

  assign_role: [ROLES.HOST],
  remove_participant: [ROLES.HOST],
  transfer_host: [ROLES.HOST],

  chat: [ROLES.HOST, ROLES.MODERATOR, ROLES.PARTICIPANT],
  react: [ROLES.HOST, ROLES.MODERATOR, ROLES.PARTICIPANT],
  sync_request: [ROLES.HOST, ROLES.MODERATOR, ROLES.PARTICIPANT],
});

/**
 * The subset of actions a non-privileged user may *propose*.
 * Governance actions are intentionally excluded — a Participant cannot
 * "request to kick someone", that would defeat the point of the role.
 */
const REQUESTABLE_ACTIONS = new Set(PLAYBACK_ACTIONS);

/** Roles that are allowed to see and resolve pending requests. */
const APPROVER_ROLES = new Set([ROLES.HOST, ROLES.MODERATOR]);

/** Roles a Host is allowed to promote/demote somebody into. */
const ASSIGNABLE_ROLES = new Set([ROLES.MODERATOR, ROLES.PARTICIPANT, 'viewer']);

/**
 * Normalise any role-ish string into a canonical role.
 * @param {unknown} role
 * @returns {string}
 */
function normalizeRole(role) {
  const raw = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (ROLE_ALIASES[raw]) return ROLE_ALIASES[raw];
  return Object.values(ROLES).includes(raw) ? raw : ROLES.PARTICIPANT;
}

/**
 * Can `role` execute `action` outright?
 * @param {string} role
 * @param {string} action
 * @returns {boolean}
 */
function can(role, action) {
  const allowed = PERMISSIONS[action];
  if (!allowed) return false;
  return allowed.includes(normalizeRole(role));
}

/**
 * Should `role` performing `action` be turned into an approval request
 * instead of executed (or refused)?
 * @param {string} role
 * @param {string} action
 * @returns {boolean}
 */
function needsApproval(role, action) {
  if (can(role, action)) return false;
  return REQUESTABLE_ACTIONS.has(action);
}

/**
 * Is this role allowed to approve other people's requests?
 * @param {string} role
 * @returns {boolean}
 */
function isApprover(role) {
  return APPROVER_ROLES.has(normalizeRole(role));
}

/**
 * The capability list handed to a client on join / on every role change.
 * This is what lets the React UI disable controls for restricted users
 * *without* the UI containing any authorisation logic of its own.
 *
 * @param {string} role
 * @returns {{ role: string, allowedActions: string[], requestableActions: string[], canApprove: boolean }}
 */
function capabilitiesFor(role) {
  const canonical = normalizeRole(role);
  return {
    role: canonical,
    allowedActions: Object.keys(PERMISSIONS).filter((action) => can(canonical, action)),
    requestableActions: canonical === ROLES.HOST || canonical === ROLES.MODERATOR
      ? []
      : [...REQUESTABLE_ACTIONS],
    canApprove: isApprover(canonical),
  };
}

module.exports = {
  ROLES,
  ROLE_ALIASES,
  PLAYBACK_ACTIONS,
  GOVERNANCE_ACTIONS,
  OPEN_ACTIONS,
  REQUESTABLE_ACTIONS: [...REQUESTABLE_ACTIONS],
  APPROVER_ROLES: [...APPROVER_ROLES],
  ASSIGNABLE_ROLES,
  normalizeRole,
  can,
  needsApproval,
  isApprover,
  capabilitiesFor,
};
