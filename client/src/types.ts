/**
 * ---------------------------------------------------------------------------
 * The wire contract.
 * ---------------------------------------------------------------------------
 *
 * These interfaces mirror the payloads produced by
 * `server/src/ws/{Room,handlers}.js`. Keeping them in one file means the
 * TypeScript compiler is the thing that notices when a server payload field is
 * renamed — an event that compiles is an event whose shape is known.
 *
 * Event names are the assignment's own (`join_room`, `sync_state`,
 * `role_assigned`, ...) so the brief's table can be checked off line by line.
 */

export type Role = 'host' | 'moderator' | 'participant';

export type PlaybackAction = 'play' | 'pause' | 'seek' | 'change_video';

export type GovernanceAction = 'assign_role' | 'remove_participant' | 'transfer_host';

export type RoomAction = PlaybackAction | GovernanceAction | 'chat' | 'react';

/**
 * Sent by the server alongside every participant. The client renders controls
 * from this list rather than from its own opinion about roles — so the UI can
 * never drift out of sync with the backend rules.
 */
export interface Capabilities {
  role: Role;
  allowedActions: RoomAction[];
  requestableActions: PlaybackAction[];
  canApprove: boolean;
}

export interface Participant {
  userId: string;
  username: string;
  role: Role;
  joinedAt: number;
  capabilities: Capabilities;
}

/** Payload of the `sync_state` broadcast. */
export interface SyncState {
  /** Spec field: 'playing' | 'paused'. */
  playState: 'playing' | 'paused';
  videoId: string;
  /** Position at the moment `updatedAt` was recorded. */
  currentTime: number;
  /** Position the client should be at right now, resolved on the server clock. */
  position: number;
  duration: number;
  isPlaying: boolean;
  serverTime: number;
  updatedAt: number;
  /** Who caused this change, for the "Host paused the room" toast. */
  actor: { userId: string; username: string; role: Role } | null;
  source: 'direct' | 'approved_request' | 'heartbeat' | 'snapshot' | 'sync_request';
}

/** A playback change a Participant proposed and that needs approval. */
export interface ApprovalRequest {
  id: string;
  userId: string;
  username: string;
  action: PlaybackAction;
  payload: { time?: number; videoId?: string };
  note: string;
  createdAt: number;
  expiresAt: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  role: Role;
  text: string;
  at: number;
}

/** Full authoritative picture, sent on join and on reconnect. */
export interface RoomSnapshot {
  roomId: string;
  state: SyncState;
  participants: Participant[];
  host: Participant | null;
  me: Participant | null;
  capabilities: Capabilities;
  pendingRequests: ApprovalRequest[];
  chat: ChatMessage[];
  createdAt: number;
}

/** Inbound payload shapes, named so both the event map and the listeners share them. */
export interface UserJoinedPayload {
  username: string;
  userId: string;
  role: Role;
  participants: Participant[];
}

export interface UserLeftPayload {
  username: string;
  userId: string;
  reason?: string;
  participants: Participant[];
}

export interface RoleAssignedPayload {
  userId: string;
  username: string;
  role: Role;
  assignedBy: string;
  participants: Participant[];
}

export interface ParticipantRemovedPayload {
  userId: string;
  username: string;
  participants: Participant[];
  reason?: string;
}

export interface HostTransferredPayload {
  userId: string;
  username: string;
  previousHost: string;
  automatic: boolean;
  participants: Participant[];
}

export interface RequestReceivedPayload {
  request: ApprovalRequest;
  requests: ApprovalRequest[];
}

export interface RequestQueuePayload {
  requests: ApprovalRequest[];
}

export interface RequestPendingPayload {
  request: ApprovalRequest;
}

export interface RequestResolvedPayload {
  request: ApprovalRequest;
  approved: boolean;
  resolvedBy: { userId: string; username: string; role: Role };
}

export interface RequestExpiredPayload {
  request: ApprovalRequest;
}

export interface ChatPayload {
  message: ChatMessage;
}

export interface ReactionPayload {
  emoji: string;
  userId: string;
  username: string;
}

export interface RemovedPayload {
  roomId: string;
  by: string;
  reason: string;
}

export interface RoomErrorPayload {
  message: string;
  code: string;
  at: number;
}

/** Server -> client events. */
export interface ServerEvents {
  room_state: (snapshot: RoomSnapshot) => void;
  sync_state: (state: SyncState) => void;
  user_joined: (payload: UserJoinedPayload) => void;
  user_left: (payload: UserLeftPayload) => void;
  role_assigned: (payload: RoleAssignedPayload) => void;
  participant_removed: (payload: ParticipantRemovedPayload) => void;
  host_transferred: (payload: HostTransferredPayload) => void;
  request_received: (payload: RequestReceivedPayload) => void;
  request_queue: (payload: RequestQueuePayload) => void;
  request_resolved: (payload: RequestResolvedPayload) => void;
  request_expired: (payload: RequestExpiredPayload) => void;
  request_pending: (payload: RequestPendingPayload) => void;
  chat_message: (payload: ChatPayload) => void;
  reaction: (payload: ReactionPayload) => void;
  removed_from_room: (payload: RemovedPayload) => void;
  room_error: (payload: RoomErrorPayload) => void;
}

/** Client -> server events. */
export interface ClientEvents {
  create_room: (
    payload: { username: string; userId: string; video?: string },
    ack?: (response: { ok: boolean; roomId?: string; role?: Role; error?: string }) => void
  ) => void;
  join_room: (
    payload: { roomId: string; username: string; userId: string },
    ack?: (response: { ok: boolean; roomId?: string; role?: Role; error?: string }) => void
  ) => void;
  leave_room: () => void;
  play: () => void;
  pause: () => void;
  seek: (payload: { time: number }) => void;
  change_video: (payload: { videoId: string }) => void;
  assign_role: (payload: { userId: string; role: Role }) => void;
  remove_participant: (payload: { userId: string }) => void;
  transfer_host: (payload: { userId: string }) => void;
  request_approval: (payload: {
    action: PlaybackAction;
    payload?: { time?: number; videoId?: string };
    note?: string;
  }) => void;
  resolve_request: (payload: { requestId: string; approved: boolean }) => void;
  sync_request: () => void;
  report_duration: (payload: { duration: number }) => void;
  chat_message: (payload: { text: string }) => void;
  reaction: (payload: { emoji: string }) => void;
}

export const REACTION_EMOJIS = ['👏', '😂', '❤️', '🔥', '😮', '👍'] as const;

/** Human labels for the request queue, so a Host reads "pause the video" not "pause". */
export const REQUEST_LABELS: Record<PlaybackAction, string> = {
  play: 'resume playback',
  pause: 'pause the video',
  seek: 'jump to a different time',
  change_video: 'switch the video',
};
