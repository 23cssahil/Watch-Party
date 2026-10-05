import { create } from 'zustand';
import type {
  ApprovalRequest,
  ChatMessage,
  Participant,
  RoomSnapshot,
  SyncState,
} from '../types';

/**
 * A client-side copy of the server's Room.
 *
 * This store holds no authoritative data - it's just a cache of what the server
 * last told us, plus the local clock reading we need to project it forward.
 *
 * The projection is the tricky part. A sync_state says "position 42.0 s", but by
 * the time it arrives the room is already at 42.3 s. Instead of syncing clocks
 * with the server (which needs round-trip sampling and still drifts), we record
 * receivedAt in local time and compute the expected position as
 *
 *     position + (Date.now() - receivedAt) / 1000
 *
 * Server clock skew cancels out here because both sides use the same local clock -
 * we only need an elapsed time, never an absolute timestamp.
 */

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface Toast {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'warn' | 'error';
}

export interface FloatingReaction {
  id: string;
  emoji: string;
  username: string;
}

interface RoomStore {
  status: ConnectionStatus;
  transport: string;
  roomId: string | null;
  me: Participant | null;
  participants: Participant[];
  host: Participant | null;
  /** Last authoritative playback state from the server. */
  sync: SyncState | null;
  /** Local ms timestamp at which `sync` was received (see header comment). */
  receivedAt: number;
  requests: ApprovalRequest[];
  /** Requests this client has sent and that are still awaiting a verdict. */
  myPendingActions: ApprovalRequest[];
  chat: ChatMessage[];
  toasts: Toast[];
  reactions: FloatingReaction[];
  /**
   * Bumped once per real playback change the server broadcasts (not for the 5s
   * heartbeat). VideoStage keys a ripple on this value so every viewer sees the
   * room move at the same moment - the "we're live" pulse. The animation only
   * needs a counter that goes up.
   */
  syncPulse: number;
  /** Set when the Host kicks us; the Room page swaps to a locked screen. */
  removed: { by: string; reason: string } | null;
  /**
   * Why the last join attempt failed, or null while things are working.
   *
   * Without this the failure is just a toast that fades: a dead share link would
   * leave the room page sitting on a black stage with no explanation, which looks
   * the same as "the app is broken". The Room page shows a real screen instead,
   * and clearing this is also how a retry gets asked for.
   */
  joinError: string | null;
  /** True while the local player has not caught up with `sync`. */
  needsTapToSync: boolean;
  /**
   * True for the public demo party (from snapshot.demo). The player runs locally -
   * play/pause/seek only affect this screen - and the room's shared clock is
   * ignored. See useYouTubeSync and ControlBar.
   */
  isDemo: boolean;

  applySnapshot: (snapshot: RoomSnapshot) => void;
  applySync: (sync: SyncState) => void;
  setParticipants: (participants: Participant[]) => void;
  setHostFromList: (participants: Participant[]) => void;
  setRequests: (requests: ApprovalRequest[]) => void;
  dropRequest: (requestId: string) => void;
  addMyPending: (request: ApprovalRequest) => void;
  clearMyPending: (requestId: string) => void;
  addChat: (message: ChatMessage) => void;
  pushToast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: string) => void;
  pushReaction: (reaction: FloatingReaction) => void;
  popReaction: (id: string) => void;
  bumpSyncPulse: () => void;
  setStatus: (status: ConnectionStatus, transport?: string) => void;
  setNeedsTapToSync: (value: boolean) => void;
  setRemoved: (removed: { by: string; reason: string } | null) => void;
  setJoinError: (message: string | null) => void;
  reset: () => void;
}

const initial = {
  status: 'idle' as ConnectionStatus,
  transport: '',
  roomId: null as string | null,
  me: null as Participant | null,
  participants: [] as Participant[],
  host: null as Participant | null,
  sync: null as SyncState | null,
  receivedAt: 0,
  requests: [] as ApprovalRequest[],
  myPendingActions: [] as ApprovalRequest[],
  chat: [] as ChatMessage[],
  toasts: [] as Toast[],
  reactions: [] as FloatingReaction[],
  syncPulse: 0,
  removed: null as { by: string; reason: string } | null,
  joinError: null as string | null,
  needsTapToSync: false,
  isDemo: false,
};

/**
 * @returns {number} where the room should be, in seconds, right now.
 */
export function expectedPosition(store: {
  sync: SyncState | null;
  receivedAt: number;
}): number {
  if (!store.sync) return 0;
  if (!store.sync.isPlaying) return store.sync.position;
  const elapsed = (Date.now() - store.receivedAt) / 1000;
  const projected = store.sync.position + elapsed;
  return store.sync.duration > 0 ? Math.min(projected, store.sync.duration) : projected;
}

export const useRoomStore = create<RoomStore>((set, get) => ({
  ...initial,

  applySnapshot: (snapshot) =>
    set({
      roomId: snapshot.roomId,
      sync: snapshot.state,
      receivedAt: Date.now(),
      participants: snapshot.participants,
      me: snapshot.me,
      host: snapshot.host,
      requests: snapshot.pendingRequests,
      chat: snapshot.chat,
      removed: null,
      // The demo flag comes straight from the server snapshot - the client never
      // decides for itself that a room is a demo, so there's only one source.
      isDemo: Boolean(snapshot.demo),
      // The server just gave us the room, so any earlier failure is in the past -
      // this is what stops an old "no such room" from outlasting the join that
      // finally worked.
      joinError: null,
    }),

  applySync: (sync) => {
    // Ignore a heartbeat about a video we're no longer on; this can happen
    // harmlessly when a `change_video` and a heartbeat pass each other in flight.
    const previous = get().sync;
    if (previous && previous.videoId !== sync.videoId && sync.source === 'heartbeat') {
      return;
    }
    set({ sync, receivedAt: Date.now() });
  },

  setParticipants: (participants) => set({ participants }),

  /**
   * Replace the roster, which also updates "who runs this room".
   *
   * `me` is refreshed from the same list on purpose. Every event that carries a
   * roster (user_left, host_transferred, role_assigned, participant_removed) is a
   * moment when my own role might have just changed under me: a Host leaving hands
   * the room to the longest-tenured person still here, and the new Host's controls
   * should become live then instead of waiting for the next snapshot. The UI reads
   * permissions from me.capabilities, so a stale `me` means a host's seat showing
   * viewer buttons - and the server would still accept those clicks, which is
   * confusing.
   */
  setHostFromList: (participants) =>
    set((state) => {
      const mine = state.me
        ? participants.find((p) => p.userId === state.me?.userId) ?? state.me
        : state.me;
      return {
        participants,
        host: participants.find((p) => p.role === 'host') ?? null,
        me: mine,
      };
    }),

  setRequests: (requests) => set({ requests }),

  dropRequest: (requestId) =>
    set((state) => ({ requests: state.requests.filter((r) => r.id !== requestId) })),

  addMyPending: (request) =>
    set((state) => ({
      myPendingActions: [
        ...state.myPendingActions.filter((r) => r.id !== request.id),
        request,
      ],
    })),

  clearMyPending: (requestId) =>
    set((state) => ({
      myPendingActions: state.myPendingActions.filter((r) => r.id !== requestId),
    })),

  addChat: (message) =>
    set((state) => ({
      chat: [...state.chat, message].slice(-120),
    })),

  pushToast: (message, tone = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, message, tone }] }));
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 6000 : 3800);
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  pushReaction: (reaction) => {
    set((state) => ({ reactions: [...state.reactions, reaction].slice(-24) }));
    setTimeout(() => get().popReaction(reaction.id), 2200);
  },

  popReaction: (id) =>
    set((state) => ({ reactions: state.reactions.filter((reaction) => reaction.id !== id) })),

  bumpSyncPulse: () => set((state) => ({ syncPulse: state.syncPulse + 1 })),

  setStatus: (status, transport) =>
    set((state) => ({ status, transport: transport ?? state.transport })),

  setNeedsTapToSync: (value) => set({ needsTapToSync: value }),

  setRemoved: (removed) =>
    set((state) => ({
      removed,
      // Dropping roomId here is what stops the reconnect handler in useSocket
      // from silently rejoining a room the Host just ejected us from.
      roomId: removed ? null : state.roomId,
      participants: removed ? [] : state.participants,
      requests: removed ? [] : state.requests,
    })),

  setJoinError: (message) => set({ joinError: message }),

  /**
   * Forget the room, but not the connection.
   *
   * `status` and `transport` describe the socket, which is still alive after you
   * leave a room - setting them back to `idle` is what made the stage sit on
   * "Reconnecting to the room…" forever after pressing Leave, with nothing to
   * clear it, and stopped the page's own re-join effect (which waits for a
   * connected socket) from ever running again.
   */
  reset: () => set((state) => ({ ...initial, status: state.status, transport: state.transport })),
}));

/**
 * The only role check the UI is allowed to make, and it's really a rendering
 * check: the list comes from the server's `capabilities` payload, so the client
 * is showing the backend's decision rather than working it out again itself.
 */
export function useCan(action: string): boolean {
  const capabilities = useRoomStore((state) => state.me?.capabilities);
  return Boolean(capabilities?.allowedActions.includes(action as never));
}

/** True when `action` is something this user may only propose. */
export function useMustRequest(action: string): boolean {
  const capabilities = useRoomStore((state) => state.me?.capabilities);
  return Boolean(capabilities?.requestableActions.includes(action as never));
}
