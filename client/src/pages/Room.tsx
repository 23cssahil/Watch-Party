import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { joinRoom, leaveRoom } from '../actions';
import { getIdentity } from '../socket';
import { useRoomStore } from '../store/roomStore';
import VideoStage from '../components/VideoStage';
import SidePanel from '../components/SidePanel';
import ReactionLayer from '../components/ReactionLayer';
import RemovedScreen from '../components/RemovedScreen';

/**
 * The room screen.
 *
 * Owns exactly one decision that is not obvious: *when* to join. A refresh on
 * `/room/ABC123`, a link pasted into a chat app, and the button on Home all
 * arrive here, so the join is driven by "the URL says a room, the store is not
 * in it" rather than by a click handler. That keeps deep links working without
 * any of the three entry paths having to know about the others.
 */
export default function Room() {
  const { code = '' } = useParams<{ code: string }>();
  const identity = useMemo(() => getIdentity(), []);

  const roomId = useRoomStore((state) => state.roomId);
  const me = useRoomStore((state) => state.me);
  const status = useRoomStore((state) => state.status);
  const removed = useRoomStore((state) => state.removed);
  const participants = useRoomStore((state) => state.participants);
  const transport = useRoomStore((state) => state.transport);

  const [name, setName] = useState(identity.username);
  const [panelOpen, setPanelOpen] = useState(false);

  const wantsToJoin = code.trim().toUpperCase();

  useEffect(() => {
    if (status !== 'connected' || removed) return;
    if (roomId === wantsToJoin && me) return;
    if (!identity.username) return; // waiting for the name gate below
    joinRoom(wantsToJoin, identity.username);
  }, [status, roomId, me, wantsToJoin, identity.username, removed]);

  // A share link opened on a phone should not show a blank black rectangle.
  useEffect(() => {
    if (window.innerWidth >= 980) return;
    setPanelOpen(false);
  }, []);

  const submitName = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) return;
    localStorage.setItem('watch-party:identity', JSON.stringify({ ...identity, username: trimmed }));
    setName(trimmed);
    joinRoom(wantsToJoin, trimmed);
  };

  if (removed) return <RemovedScreen removed={removed} />;

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
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
            <path d="M11 7l14 9-14 9z" fill="currentColor" />
          </svg>
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
        </div>

        <div className="room__actions">
          <button
            type="button"
            className="btn btn--tiny"
            onClick={() => setPanelOpen((open) => !open)}
          >
            {panelOpen ? 'Hide panel' : `People ${participants.length ? `(${participants.length})` : ''}`}
          </button>
          <button type="button" className="btn btn--tiny btn--danger" onClick={leaveRoom}>
            Leave
          </button>
        </div>
      </header>

      <div className={`room__body ${panelOpen ? 'room__body--panel' : ''}`}>
        <VideoStage />
        <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
      </div>

      <ReactionLayer />
    </main>
  );
}
