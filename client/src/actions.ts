import { getIdentity, rememberUsername, socket } from './socket';
import type { ApprovalRequest, PlaybackAction, Role } from './types';

/**
 * Outbound actions - plain functions, not a hook.
 *
 * These are deliberately not a useActions() hook. The socket is a module singleton,
 * so anything that emits on it should be callable from anywhere without a component
 * subscribing to something. Keeping them as plain functions also makes sure the
 * inbound-listener hook (useSocket) stays a single setup: if actions lived there
 * too, importing the hook in two components would register each listener twice and
 * events would be handled two or three times.
 *
 * Note what's not here: no requestPlay(), no askToPause(). A caller just emits play()
 * and the server decides whether that's an action or a request.
 */

export interface JoinResult {
  ok: boolean;
  roomId?: string;
  role?: Role;
  error?: string;
}

function identity() {
  const { userId } = getIdentity();
  return userId;
}

export function createRoom(
  username: string,
  video?: string,
  onResult?: (result: JoinResult) => void
): void {
  const name = username.trim();
  rememberUsername(name);
  socket.emit('create_room', { username: name, userId: identity(), video }, onResult ?? (() => {}));
}

export function joinRoom(
  roomId: string,
  username: string,
  onResult?: (result: JoinResult) => void
): void {
  const name = username.trim();
  rememberUsername(name);
  socket.emit(
    'join_room',
    { roomId: roomId.trim().toUpperCase(), username: name, userId: identity() },
    onResult ?? (() => {})
  );
}

export function leaveRoom(): void {
  socket.emit('leave_room');
}

// --------------------------------------------------------------- playback
// Each of these just states an intent. A `play()` from a Participant doesn't play
// the room directly; the server's check turns it into a `request_pending` back to
// the sender and a `request_received` to the Host. It's the same call either way.

export const play = (): void => {
  socket.emit('play');
};

export const pause = (): void => {
  socket.emit('pause');
};

export function seek(time: number): void {
  if (!Number.isFinite(time) || time < 0) return;
  socket.emit('seek', { time: Math.round(time * 1000) / 1000 });
}

export function changeVideo(videoId: string): void {
  socket.emit('change_video', { videoId });
}

// ------------------------------------------------------------- governance

export function assignRole(userId: string, role: 'moderator' | 'participant'): void {
  socket.emit('assign_role', { userId, role });
}

export function removeParticipant(userId: string): void {
  socket.emit('remove_participant', { userId });
}

export function transferHost(userId: string): void {
  socket.emit('transfer_host', { userId });
}

// -------------------------------------------------------------- approvals

export function approveRequest(requestId: string): void {
  socket.emit('resolve_request', { requestId, approved: true });
}

export function rejectRequest(requestId: string): void {
  socket.emit('resolve_request', { requestId, approved: false });
}

/**
 * The explicit "ask the host" path, used by the request panel where a
 * participant can add a note. It has the same effect as pressing play and being
 * turned into a request, but it lets the participant explain themselves.
 */
export function requestApproval(
  action: PlaybackAction,
  payload?: ApprovalRequest['payload'],
  note?: string
): void {
  socket.emit('request_approval', { action, payload, note });
}

// ---------------------------------------------------------------- room

export function sendChat(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  socket.emit('chat_message', { text: trimmed });
}

export function react(emoji: string): void {
  socket.emit('reaction', { emoji });
}

/** Pull the authoritative state again - used by "Re-sync me". */
export function requestSync(): void {
  socket.emit('sync_request');
}
