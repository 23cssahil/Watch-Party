import { useEffect, useRef } from 'react';
import { getIdentity, socket } from '../socket';
import { expectedPosition, useRoomStore } from '../store/roomStore';
import type {
  ChatPayload,
  HostTransferredPayload,
  ParticipantRemovedPayload,
  ReactionPayload,
  RemovedPayload,
  RequestExpiredPayload,
  RequestPendingPayload,
  RequestQueuePayload,
  RequestReceivedPayload,
  RequestResolvedPayload,
  RoleAssignedPayload,
  RoomErrorPayload,
  RoomSnapshot,
  SyncState,
  UserJoinedPayload,
  UserLeftPayload,
} from '../types';

/**
 * ---------------------------------------------------------------------------
 * The inbound half of the realtime layer.
 * ---------------------------------------------------------------------------
 *
 * Every server event is folded into the store from one place, so there is a
 * single answer to "what happens when the host seeks?" — and it is in this file.
 * Outbound actions live in `actions.ts` instead; keeping them apart is what lets
 * this hook stay a strict singleton (calling it twice would double every
 * listener, and each event would be applied twice).
 *
 * The client **never** decides whether it is allowed to do something. It emits
 * the real intent (`play`, `seek`, `change_video`) and the server's permission
 * gate replies with either `sync_state` (applied) or `request_pending`
 * (escalated to the Host). If the rules were mirrored here, promoting someone
 * to Moderator would need matching code in every open browser tab, and any
 * drift between the two rule sets would be a security hole. As written, a role
 * change is one broadcast and nothing else.
 *
 * Call exactly once, from `App`.
 */
export function useSocket(): void {
  const store = useRoomStore;
  // Distinguishes a first connection from a recovery, so we only re-claim a
  // seat after an actual drop rather than on the initial page load.
  const hasConnectedOnce = useRef(false);

  useEffect(() => {
    const onConnect = () => {
      const transport = socket.io.engine?.transport?.name ?? 'unknown';
      store.getState().setStatus('connected', transport);

      const { roomId, me } = store.getState();
      if (roomId && me && hasConnectedOnce.current) {
        // Reconnect: rejoin with the *same* userId. The server keys people by
        // userId rather than socket id, which is what lets a Host keep their
        // role across a dropped connection instead of rejoining as a viewer.
        //
        // The acknowledgement matters as much as the emit: a server that restarts
        // (every deploy, and every wake-up from a free tier's sleep) has lost its
        // in-memory rooms, so this join is refused and the old code let that
        // refusal pass as a toast while the page went on showing a stale room.
        // Recording it as `joinError` makes the screen say what actually happened.
        socket.emit(
          'join_room',
          { roomId, username: me.username, userId: getIdentity().userId },
          (result) => {
            if (!result.ok) store.getState().setJoinError(result.error || 'That room no longer exists.');
          }
        );
      }
      hasConnectedOnce.current = true;
    };

    /**
     * The link dropped — but retries are already scheduled, so the honest status
     * is "connecting", not "disconnected".
     *
     * `disconnected` is reserved for `reconnect_failed` below, i.e. the transport
     * genuinely stopped. That distinction is what makes the landing page's
     * "Try again" button meaningful instead of decorative: it only appears when
     * nothing is retrying any more.
     */
    const onDisconnect = (reason: string) => {
      store.getState().setStatus('connecting');
      if (reason !== 'io client disconnect') {
        store.getState().pushToast('Connection lost — reconnecting…', 'warn');
      }
    };

    /**
     * A connection attempt failed.
     *
     * Socket.IO keeps retrying by itself, so this only keeps the status honest:
     * after a manual retry from a gave-up state, the page says "connecting" while
     * attempts are in flight instead of sitting on the terminal message.
     */
    const onConnectError = () => {
      if (!socket.connected) store.getState().setStatus('connecting');
    };

    /**
     * Every reconnection attempt has been used up.
     *
     * This is the one state where the page would otherwise sit on "Reconnecting"
     * forever with nothing left happening, so it is recorded as a join refusal:
     * that is what swaps the Room page to the screen with a working retry button
     * (which also restarts the connection, not just the join).
     *
     * It lives on the Manager (`socket.io`) rather than the Socket, because
     * "gave up reconnecting" is a transport-level fact, not a namespace one.
     */
    const onReconnectFailed = () => {
      store.getState().setStatus('disconnected');
      store.getState().setJoinError(
        store.getState().roomId
          ? 'Lost the server and could not get back in.'
          : 'Could not reach the server. It may still be waking up.'
      );
    };

    const onRoomState = (snapshot: RoomSnapshot) => store.getState().applySnapshot(snapshot);

    const onSyncState = (sync: SyncState) => {
      const previousVideo = store.getState().sync?.videoId;
      const previousPosition = expectedPosition(store.getState());
      store.getState().applySync(sync);

      // Attribute the change to a person, but stay quiet about the 5-second
      // heartbeat that only exists to correct drift.
      if (sync.source === 'heartbeat' || sync.source === 'snapshot') return;

      // A *real* playback move just landed — fire the live pulse. This is not
      // gated on `actor` or on "someone else": when the Host presses play, their
      // own tab is on the receiving end of the same broadcast, so the stage should
      // ripple for them too. The pulse is the room saying "that change was live".
      store.getState().bumpSyncPulse();

      const meId = store.getState().me?.userId;
      if (!sync.actor) return;

      const label = sync.actor.userId === meId ? 'You' : sync.actor.username;
      const verb =
        sync.source === 'approved_request'
          ? 'request approved'
          : describeSync(sync, previousVideo, previousPosition);
      if (sync.actor.userId !== meId) {
        store.getState().pushToast(
          sync.source === 'approved_request'
            ? `${sync.actor.username}'s request was approved`
            : `${sync.actor.username} ${describeSync(sync, previousVideo, previousPosition)}`,
          'info'
        );
      }
      store.getState().pushActivity({
        kind: 'playback',
        tone: 'info',
        text: `${label} ${verb}`,
      });
    };

    const onUserJoined = ({ participants, username, userId }: UserJoinedPayload) => {
      store.getState().setHostFromList(participants);
      if (userId !== store.getState().me?.userId) {
        store.getState().pushToast(`${username} joined the room`, 'info');
        store.getState().pushActivity({ kind: 'join', tone: 'success', text: `${username} joined` });
      }
    };

    const onUserLeft = ({ participants, username, userId }: UserLeftPayload) => {
      store.getState().setHostFromList(participants);
      if (userId !== store.getState().me?.userId) {
        store.getState().pushToast(`${username} left the room`, 'info');
        store.getState().pushActivity({ kind: 'leave', tone: 'info', text: `${username} left` });
      }
    };

    const onRoleAssigned = ({
      participants,
      userId,
      role,
      username,
      assignedBy,
    }: RoleAssignedPayload) => {
      store.getState().setHostFromList(participants);
      if (userId === store.getState().me?.userId) {
        store.getState().pushToast(`You are now ${role} (set by ${assignedBy})`, 'success');
        store.getState().pushActivity({ kind: 'role', tone: 'success', text: `You are now ${role}` });
      } else {
        store.getState().pushToast(`${username} is now ${role}`, 'info');
        store.getState().pushActivity({ kind: 'role', tone: 'info', text: `${username} is now ${role}` });
      }
    };

    const onHostTransferred = ({ participants, username, automatic }: HostTransferredPayload) => {
      store.getState().setHostFromList(participants);
      store.getState().pushToast(
        automatic ? `Host left — ${username} took over` : `${username} is the new host`,
        'success'
      );
      store.getState().pushActivity({
        kind: 'role',
        tone: 'success',
        text: automatic ? `Host left — ${username} took over` : `${username} is the new host`,
      });
    };

    const onParticipantRemoved = ({
      participants,
      username,
      userId,
      reason,
    }: ParticipantRemovedPayload) => {
      store.getState().setHostFromList(participants);
      if (userId !== store.getState().me?.userId) {
        const text =
          reason === 'removed' ? `${username} was removed by the host` : `${username} left`;
        store.getState().pushToast(text, 'info');
        store.getState().pushActivity({
          kind: reason === 'removed' ? 'system' : 'leave',
          tone: reason === 'removed' ? 'warn' : 'info',
          text,
        });
      }
    };

    const onRequestReceived = ({ requests }: RequestReceivedPayload) =>
      store.getState().setRequests(requests);

    const onRequestQueue = ({ requests }: RequestQueuePayload) =>
      store.getState().setRequests(requests);

    const onRequestPending = ({ request }: RequestPendingPayload) => {
      const state = store.getState();
      state.addMyPending(request);
      state.pushToast(`Asked the host to ${describeAction(request.action)} — waiting…`, 'info');
    };

    const onRequestResolved = ({ request, approved, resolvedBy }: RequestResolvedPayload) => {
      const state = store.getState();
      state.dropRequest(request.id);
      state.clearMyPending(request.id);
      if (request.userId === state.me?.userId) {
        state.pushToast(
          approved
            ? `${resolvedBy.username} approved your request`
            : `${resolvedBy.username} declined your request`,
          approved ? 'success' : 'warn'
        );
      }
    };

    const onRequestExpired = ({ request }: RequestExpiredPayload) => {
      const state = store.getState();
      state.dropRequest(request.id);
      state.clearMyPending(request.id);
      if (request.userId === state.me?.userId) {
        state.pushToast('Your request expired before anyone approved it', 'warn');
      }
    };

    const onChat = ({ message }: ChatPayload) => {
      store.getState().addChat(message);
      // Fold the line into the live feed too, so the Activity tab reads like the
      // room's story and not just a controls log. Truncated to keep rows tidy.
      const snippet = message.text.length > 48 ? `${message.text.slice(0, 47)}…` : message.text;
      store.getState().pushActivity({
        kind: 'chat',
        tone: 'info',
        text: `${message.username}: ${snippet}`,
      });
    };

    const onReaction = ({ emoji, username }: ReactionPayload) =>
      store.getState().pushReaction({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        emoji,
        username,
      });

    const onRemoved = ({ by, reason }: RemovedPayload) => {
      // A distinct state, not just "left": the Room page swaps to a locked
      // screen so the user cannot silently rejoin the room they were kicked from.
      store.getState().setRemoved({ by, reason });
    };

    // Reserved for a deliberate "end the party for everyone" action, which the
    // server does not send today: a Host pressing Leave hands the room to the
    // longest-tenured survivor instead (§5 of the README), so viewers are never
    // told the room died while it is still playing. Kept wired up because the
    // event is in the contract, and the handling is the correct one if it arrives.
    const onRoomDeleted = ({ message }: { roomId: string; message: string }) => {
      store.getState().reset();
      store.getState().setJoinError(message || 'The host ended the party.');
    };

    const onError = ({ message }: RoomErrorPayload) => store.getState().pushToast(message, 'error');

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.io.on('reconnect_failed', onReconnectFailed);
    socket.on('room_state', onRoomState);
    socket.on('sync_state', onSyncState);
    socket.on('user_joined', onUserJoined);
    socket.on('user_left', onUserLeft);
    socket.on('role_assigned', onRoleAssigned);
    socket.on('host_transferred', onHostTransferred);
    socket.on('participant_removed', onParticipantRemoved);
    socket.on('request_received', onRequestReceived);
    socket.on('request_queue', onRequestQueue);
    socket.on('request_pending', onRequestPending);
    socket.on('request_resolved', onRequestResolved);
    socket.on('request_expired', onRequestExpired);
    socket.on('chat_message', onChat);
    socket.on('reaction', onReaction);
    socket.on('removed_from_room', onRemoved);
    socket.on('room_deleted', onRoomDeleted);
    socket.on('room_error', onError);

    store.getState().setStatus(socket.connected ? 'connected' : 'connecting');

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_failed', onReconnectFailed);
      socket.off('room_state', onRoomState);
      socket.off('sync_state', onSyncState);
      socket.off('user_joined', onUserJoined);
      socket.off('user_left', onUserLeft);
      socket.off('role_assigned', onRoleAssigned);
      socket.off('host_transferred', onHostTransferred);
      socket.off('participant_removed', onParticipantRemoved);
      socket.off('request_received', onRequestReceived);
      socket.off('request_queue', onRequestQueue);
      socket.off('request_pending', onRequestPending);
      socket.off('request_resolved', onRequestResolved);
      socket.off('request_expired', onRequestExpired);
      socket.off('chat_message', onChat);
      socket.off('reaction', onReaction);
      socket.off('removed_from_room', onRemoved);
      socket.off('room_deleted', onRoomDeleted);
      socket.off('room_error', onError);
    };
  }, [store]);
}

/** "Host paused the room" — the verb is chosen from what actually changed. */
function describeSync(
  sync: SyncState,
  previousVideoId: string | undefined,
  previousPosition: number
): string {
  if (previousVideoId && previousVideoId !== sync.videoId) return 'changed the video';
  if (Math.abs(sync.position - previousPosition) > 2) return 'moved the playback position';
  return sync.isPlaying ? 'started playback' : 'paused the video';
}

function describeAction(action: string): string {
  switch (action) {
    case 'play':
      return 'resume playback';
    case 'pause':
      return 'pause the video';
    case 'seek':
      return 'jump to another time';
    case 'change_video':
      return 'change the video';
    default:
      return action;
  }
}
