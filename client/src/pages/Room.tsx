import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { joinRoom, leaveRoom } from '../actions';
import { getIdentity } from '../socket';
import { useRoomStore } from '../store/roomStore';
import VideoStage from '../components/VideoStage';
import SidePanel from '../components/SidePanel';
import ChatPanel from '../components/ChatPanel';
import ReactionLayer from '../components/ReactionLayer';
import RemovedScreen from '../components/RemovedScreen';
import RoomUnavailable from '../components/RoomUnavailable';

/**
 * The room screen.
 *
 * Owns exactly one decision that is not obvious: *when* to join. A refresh on
 * `/room/ABC123`, a link pasted into a chat app, and the button on Home all
 * arrive here, so the join is driven by "the URL says a room, the store is not
 * in it" rather than by a click handler. That keeps deep links working without
 * any of the three entry paths having to know about the others.
 *
 * The join's acknowledgement is consumed, not ignored. A refused join used to
 * arrive as a toast over a black stage, which reads as a broken page; now the
 * refusal is stored and this page swaps to `RoomUnavailable`, which says what
 * happened and offers a retry.
 */
export default function Room() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  // Held in state rather than memoised, so that saving a name is visible to the
  // join effect on the next render. A first-time visitor on a dead link would
  // otherwise be bounced back to the name gate after pressing retry and asked to
  // introduce themselves again.
  const [identity, setIdentity] = useState(() => getIdentity());

  const roomId = useRoomStore((state) => state.roomId);
  const me = useRoomStore((state) => state.me);
  const status = useRoomStore((state) => state.status);
  const removed = useRoomStore((state) => state.removed);
  const joinError = useRoomStore((state) => state.joinError);
  const participants = useRoomStore((state) => state.participants);
  const transport = useRoomStore((state) => state.transport);

  const [name, setName] = useState(identity.username);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelToggleRef = useRef<HTMLButtonElement>(null);

  /**
   * Closing the panel makes it `inert`, and at that moment focus is normally
   * *inside* it — the ✕ that triggered the close lives there. Leaving it stranded
   * drops a keyboard user to the top of the document with nothing to come back to
   * (and is the exact condition Chrome warns about with "Blocked aria-hidden on an
   * element because its descendant retained focus"), so focus is handed to the one
   * control that can reopen the panel.
   */
  const closePanel = () => {
    setPanelOpen(false);
    panelToggleRef.current?.focus();
  };

  const wantsToJoin = code.trim().toUpperCase();

  /**
   * Leaving has to actually leave.
   *
   * `leaveRoom()` clears the store, and the join effect just below reads an empty
   * store as "not in a room yet" — so while this page stayed mounted, the effect
   * re-joined the very code being left, and the only visible result was a
   * "Reconnecting to the room…" banner that never went away. Unmounting first
   * makes the button mean what it says.
   */
  const onLeave = () => {
    leaveRoom();
    navigate('/');
  };

  useEffect(() => {
    // `joinError` is in the dependency list on purpose: it both stops the retry
    // loop (a refused join must not be re-sent on every render) and restarts it,
    // because clearing it is exactly what the retry button does.
    if (status !== 'connected' || removed || joinError) return;
    if (roomId === wantsToJoin && me) return;
    if (!identity.username) return; // waiting for the name gate below
    joinRoom(wantsToJoin, identity.username, (result) => {
      if (!result.ok) useRoomStore.getState().setJoinError(result.error || 'Could not join that room.');
    });
  }, [status, roomId, me, wantsToJoin, identity.username, removed, joinError]);

  // A share link opened on a phone should not show a blank black rectangle.
  useEffect(() => {
    if (window.innerWidth >= 980) return;
    setPanelOpen(false);
  }, []);

  const submitName = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) return;
    const next = { ...identity, username: trimmed };
    localStorage.setItem('watch-party:identity', JSON.stringify(next));
    setIdentity(next);
    // Setting the identity above re-runs the join effect, which is the same emit
    // — so this path sends `join_room` once, from the effect, not twice.
  };

  if (removed) return <RemovedScreen removed={removed} />;

  if (joinError) return <RoomUnavailable code={wantsToJoin} error={joinError} />;

  if (!identity.username) {
    return (
      <main className="gate">
        <div className="gate__card">
          <p className="gate__eyebrow">Room {wantsToJoin}</p>
          <h2>What should the room call you?</h2>
          <input
            className="gate__input"
            value={name}
            autoFocus
            maxLength={24}
            placeholder="Display name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submitName()}
          />
          <button type="button" className="btn btn--primary" disabled={name.trim().length < 2} onClick={submitName}>
            Join room
          </button>
          <Link className="gate__back" to="/">
            Start a different room instead
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="room">
      <header className="room__bar">
        <Link to="/" className="room__brand" aria-label="Watch Party home">
          <img src="/favicon.svg" alt="" width="22" height="22" />
          <span>Watch Party</span>
        </Link>

        <div className="room__meta">
          <span className="room__code" title="Room code">
            {wantsToJoin}
          </span>
          <span className={`dot dot--${status === 'connected' ? 'ok' : 'bad'}`} />
          <span className="room__transport" title={`Socket.IO over ${transport || 'pending'}`}>
            {transport === 'websocket' ? 'live' : transport || 'connecting'}
          </span>
          {/* The same live sound-wave from the landing title, parked after the
              "live" tag so the room bar reads as on-air too. Purely decorative. */}
          <span className="brand-wave brand-wave--room" aria-hidden>
            {Array.from({ length: 18 }).map((_, i) => (
              <i key={i} />
            ))}
          </span>
        </div>

        <div className="room__actions">
          <button
            type="button"
            className="btn btn--tiny"
            ref={panelToggleRef}
            aria-expanded={panelOpen}
            onClick={() => (panelOpen ? closePanel() : setPanelOpen(true))}
          >
            {panelOpen ? '✕ Close' : `☰ People ${participants.length ? `(${participants.length})` : ''}`}
          </button>
          <button type="button" className="btn btn--tiny btn--danger" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      <div className={`room__body ${panelOpen ? 'room__body--panel' : ''}`}>
        <VideoStage />

        {/*
          Always-on live chat, docked right beside the video. It is the very
          same ChatPanel that the drawer carries on phones — one store, one
          socket path — so anything anyone types lands here for every client
          the instant the server broadcasts it. The tabbed SidePanel above it
          became a slide-over drawer so this rail can own the right edge.
        */}
        <aside className="livechat" aria-label="Live chat">
          <header className="livechat__head">
            <span className="livechat__pulse" aria-hidden />
            <h2>Live chat</h2>
            <span className="livechat__count">{participants.length} watching</span>
          </header>
          <div className="livechat__body">
            <ChatPanel />
          </div>
        </aside>

        <SidePanel open={panelOpen} onClose={closePanel} />
      </div>

      <ReactionLayer />
    </main>
  );
}
