import { getIdentity, rememberUsername, socket } from './socket';
import { useRoomStore } from './store/roomStore';
import type { ApprovalRequest, PlaybackAction, Role } from './types';

/**
 * ---------------------------------------------------------------------------
 * Outbound actions — plain functions, not a hook.
 * ---------------------------------------------------------------------------
 *
 * Deliberately *not* a `useActions()` hook. The socket is a module singleton, so
 * anything that emits on it should be callable from anywhere without a component
 * having to subscribe to something. Making these free functions also keeps the
 * inbound-listener hook (`useSocket`) a strict singleton: if actions lived
 * there too, importing the hook in two components would register every listener
 * twice and each event would be handled two or three times.
 *
 * Note what is missing: no `requestPlay()`, no `askToPause()`. A caller emits
 * `play()` and the server decides whether that is an action or a request.
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
  useRoomStore.getState().reset();
}

// --------------------------------------------------------------- playback
// Each of these is a bare intent. `play()` from a Participant does not play the
// room; the server's gate turns it into a `request_pending` back to the sender
// and a `request_received` to the Host. Same call either way.

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
 * participant can attach a note. Identical in effect to pressing play and being
 * downgraded, but it lets the participant explain themselves.
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

/** Pull the authoritative state again — used by "Re-sync me". */
export function requestSync(): void {
  socket.emit('sync_request');
}
