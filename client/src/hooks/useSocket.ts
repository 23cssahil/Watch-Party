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
 * The inbound half of the realtime layer.
 *
 * Every server event is applied to the store from one place, so there's a single
 * answer to "what happens when the host seeks?" and it's in this file. Outbound
 * actions live in actions.ts instead; keeping them apart is what lets this hook
 * stay a one-time setup (calling it twice would double every listener, and each
 * event would be applied twice).
 *
 * The client never decides whether it's allowed to do something. It just emits the
 * real intent (play, seek, change_video) and the server's permission check replies
 * with either sync_state (applied) or request_pending (turned into a request to the
 * Host). If we copied the rules here, promoting someone to Moderator would need
 * matching code in every open tab, and any mismatch would be a security hole. As it
 * is, a role change is just one broadcast.
 *
 * Call this once, from App.
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
        // Reconnect: rejoin with the same userId. The server keys people by userId
        // rather than socket id, which is what lets a Host keep their role across a
        // dropped connection instead of rejoining as a viewer.
        //
        // The acknowledgement matters as much as the emit: a server that restarts
        // (every deploy, and every wake-up from the free tier's sleep) has lost its
        // in-memory rooms, so this join gets refused. The old code let that refusal
        // pass as a toast while the page kept showing a stale room. Saving it as
        // `joinError` makes the screen say what really happened.
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
     * The link dropped, but retries are already scheduled, so the truthful status
     * is "connecting", not "disconnected".
     *
     * `disconnected` is saved for `reconnect_failed` below, i.e. when the transport
     * really did stop. That difference is what makes the landing page's "Try again"
     * button useful instead of just decoration: it only shows when nothing is
     * retrying any more.
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
     * Socket.IO keeps retrying on its own, so this just keeps the status accurate:
     * after a manual retry from a gave-up state, the page shows "connecting" while
     * attempts are in flight instead of staying on the final message.
     */
    const onConnectError = () => {
      if (!socket.connected) store.getState().setStatus('connecting');
    };

    /**
     * Every reconnection attempt has run out.
     *
     * This is the one case where the page would otherwise sit on "Reconnecting"
     * forever with nothing happening, so we record it as a join failure: that's
     * what swaps the Room page to the screen with a working retry button (which
     * also restarts the connection, not just the join).
     *
     * It's on the Manager (`socket.io`) rather than the Socket, because "gave up
     * reconnecting" is a transport-level fact, not a namespace one.
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

      // Say who caused the change, but stay quiet about the 5-second heartbeat
      // whose only job is to correct drift.
      if (sync.source === 'heartbeat' || sync.source === 'snapshot') return;

      // A real playback move just landed - fire the live pulse. It's not gated on
      // `actor` or on "someone else": when the Host presses play, their own tab
      // gets the same broadcast, so the stage should ripple for them too. The pulse
      // is the room saying "that change was live".
      store.getState().bumpSyncPulse();

      const meId = store.getState().me?.userId;
      if (!sync.actor) return;

      if (sync.actor.userId !== meId) {
        store.getState().pushToast(
          sync.source === 'approved_request'
            ? `${sync.actor.username}'s request was approved`
            : `${sync.actor.username} ${describeSync(sync, previousVideo, previousPosition)}`,
          'info'
        );
      }
    };

    const onUserJoined = ({ participants, username, userId }: UserJoinedPayload) => {
      store.getState().setHostFromList(participants);
      if (userId !== store.getState().me?.userId) {
        store.getState().pushToast(`${username} joined the room`, 'info');
      }
    };

    const onUserLeft = ({ participants, username, userId }: UserLeftPayload) => {
      store.getState().setHostFromList(participants);
      if (userId !== store.getState().me?.userId) {
        store.getState().pushToast(`${username} left the room`, 'info');
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
      } else {
        store.getState().pushToast(`${username} is now ${role}`, 'info');
      }
    };

    const onHostTransferred = ({ participants, username, automatic }: HostTransferredPayload) => {
      store.getState().setHostFromList(participants);
      store.getState().pushToast(
        automatic ? `Host left — ${username} took over` : `${username} is the new host`,
        'success'
      );
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
    };

    const onReaction = ({ emoji, username }: ReactionPayload) =>
      store.getState().pushReaction({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        emoji,
        username,
      });

    const onRemoved = ({ by, reason }: RemovedPayload) => {
      // A separate state, not just "left": the Room page switches to a locked
      // screen so the user can't quietly rejoin the room they were kicked from.
      store.getState().setRemoved({ by, reason });
    };

    // Reserved for a deliberate "end the party for everyone" action, which the
    // server doesn't send today: a Host pressing Leave hands the room to the
    // longest-tenured person still here (README §5), so viewers are never told the
    // room died while it's still playing. It's kept wired up because the event is
    // in the contract, and this handling is the right one if it ever arrives.
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

/** "Host paused the room" - the verb is picked from what actually changed. */
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
