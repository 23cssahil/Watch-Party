import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom, joinRoom } from '../actions';
import { getIdentity, rememberUsername, socket } from '../socket';
import { useRoomStore } from '../store/roomStore';
import { extractVideoId } from '../lib/format';
import type { JoinResult } from '../actions';
import SiteFooter from '../components/SiteFooter';

// Shown when a button was pressed after the transport had stopped retrying.
// Different from the waking case below: nothing is in flight to queue into, so
// this one has to point the user at the visible retry control.
const OFFLINE_COPY =
  'The realtime server is unreachable and retries have stopped. Press "Try again" beside the status line below, then send this again.';

// Shown when a click landed while the socket was still opening and was kept.
// A sleeping free instance takes tens of seconds to boot and client code can't
// speed that up. The fix here was that the click used to get thrown away during
// the wait - now it's queued and runs on connect.
const WAKING_COPY =
  'The service is waking up — a few seconds normally, up to half a minute if it has been idle. Your click is queued: the room action runs on its own the moment the connection opens.';

// The public demo party's fixed code, matching config.demo.code on the server.
// It has an `O`, which the room-code generator excludes, so a random room can't
// collide with it. It's ownerless: everyone joins as a Viewer and their controls
// are local to them.
const DEMO_ROOM_CODE = 'DEMO24';

// One row of the landing page's "Live rooms" list, from GET /api/rooms.
// Just a summary - no ids, chat or queue.
interface LiveRoom {
  code: string;
  host: string;
  viewers: number;
  title: string;
  isDemo: boolean;
}

/**
 * Landing page: pick a name, then start a room or enter someone else's code.
 *
 * The room code doesn't exist until the server answers create_room, so we
 * navigate inside the Socket.IO acknowledgement instead of guessing. The ack is
 * the only reliable way to know a join worked, and it lets us show "no room with
 * that code" instead of a blank screen.
 */
export default function Home() {
  const navigate = useNavigate();
  const status = useRoomStore((state) => state.status);
  const identity = useMemo(() => getIdentity(), []);

  const [name, setName] = useState(identity.username);
  const [code, setCode] = useState('');
  const [video, setVideo] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState('');
  // An action pressed while the socket was still opening, replayed on connect.
  // `queued` drives the button text; the ref holds the actual click to run later.
  const [queued, setQueued] = useState<'create' | 'join' | null>(null);
  const queuedRef = useRef<{ intent: 'create' | 'join'; run: () => void } | null>(null);
  // Name input + an alert flag. An error that only shows in the bottom strip is
  // easy to miss, so we also flash the field itself (see needName).
  const nameRef = useRef<HTMLInputElement>(null);
  const [nameAlert, setNameAlert] = useState(false);

  // Code input too: the Join button stays enabled even with an empty code, so a
  // press rings + shakes this field (see needCode) instead of feeling dead.
  const codeRef = useRef<HTMLInputElement>(null);
  const [codeAlert, setCodeAlert] = useState(false);

  // The "Live rooms" list on the right: a polled, read-only list. Joining a listed
  // room reuses the one name field above. With no name yet we remember which room
  // (pendingRoom) so Enter can finish the join.
  const [liveRooms, setLiveRooms] = useState<LiveRoom[]>([]);
  const [pendingRoom, setPendingRoom] = useState<string | null>(null);

  const videoId = extractVideoId(video);
  const trimmed = name.trim();

  useEffect(() => {
    if (status === 'connected') {
      const pending = queuedRef.current;
      if (!pending) return;
      queuedRef.current = null;
      setQueued(null);
      setError('');
      setBusy(pending.intent);
      pending.run();
      return;
    }
    // `disconnected` is terminal - the transport stopped trying. Keeping a hidden
    // queue alive behind a spinner would be misleading, so we hand the button back
    // and leave the visible "Try again" as the only action.
    if (status === 'disconnected' && queuedRef.current) {
      queuedRef.current = null;
      setQueued(null);
      setBusy(null);
    }
  }, [status]);

  // Poll the live-rooms list. Same-origin /api/rooms (Vite proxies it in dev), so
  // no server URL needed. A failed fetch just keeps the last list - the demo row
  // is rendered client-side anyway, so the panel is never blank.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/rooms', { headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const data = await res.json();
        if (alive && Array.isArray(data.rooms)) setLiveRooms(data.rooms);
      } catch {
        /* offline or a waking cold start - keep whatever we last showed */
      }
    };
    load();
    const timer = window.setInterval(load, 6000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Run now, or the moment the connection opens. Try not to drop a click we can keep.
  const runOrQueue = (intent: 'create' | 'join', run: () => void) => {
    if (status === 'connected') {
      setBusy(intent);
      run();
      return;
    }
    // Terminal: nothing in flight, so a queue would just hang behind a spinner
    // promising something nobody's going to deliver.
    if (status === 'disconnected') {
      setError(OFFLINE_COPY);
      return;
    }
    queuedRef.current = { intent, run };
    setQueued(intent);
    setBusy(intent);
    setError(WAKING_COPY);
  };

  const onResult = (route: 'create' | 'join') => (result: JoinResult) => {
    setBusy(null);
    if (result.ok && result.roomId) {
      navigate(`/room/${result.roomId}`);
      return;
    }
    setError(result.error || (route === 'join' ? 'Could not join that room.' : 'Could not create the room.'));
  };

  const onCreate = () => {
    if (trimmed.length < 2) return needName('Pick a display name of at least 2 characters to start a room.');
    setError('');
    runOrQueue('create', () => createRoom(trimmed, videoId || undefined, onResult('create')));
  };

  const onJoin = (event: FormEvent) => {
    event.preventDefault();
    const target = code.trim().toUpperCase();
    if (target.length < 4) return needCode('Enter the room code first — then tap Join room.');
    // Each refusal states its own reason. This used to be a single silent
    // `if (!ready) return`, so a correct code typed while still connecting (or
    // before a name) did nothing and the button felt dead.
    if (trimmed.length < 2) return needName('Pick a display name of at least 2 characters first.');
    setError('');
    runOrQueue('join', () => joinRoom(target, trimmed, onResult('join')));
  };

  // Refuse an action that needs a name, but make the refusal visible. Just writing
  // to the bottom error strip was easy for a first-timer to miss, so we also scroll
  // the field into view, focus it and ring it.
  const needName = (message: string) => {
    setError(message);
    setNameAlert(true);
    nameRef.current?.focus();
    nameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setNameAlert(false), 2600);
  };

  // Same as needName but for the code box, since the Join button isn't disabled
  // on an empty code - a press with nothing typed still needs to be seen.
  const needCode = (message: string) => {
    setError(message);
    setCodeAlert(true);
    codeRef.current?.focus();
    codeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setCodeAlert(false), 2600);
  };

  // Open the public demo party. A name is required first, gated on the same rule
  // as joining a real room, so whoever opens the demo gets greeted by name.
  const onDemo = () => {
    if (trimmed.length < 2) return needName('Type your display name in the box above first — then tap 🎉 Demo room again.');
    setError('');
    rememberUsername(trimmed);
    navigate(`/room/${DEMO_ROOM_CODE}`);
  };

  // Join a room straight from the list. Reuses the one name field at the top - no
  // second box. With no name yet we remember the room and ring the field, so typing
  // a name + Enter (or tapping Join again) finishes it.
  const joinListedRoom = (roomCode: string) => {
    if (trimmed.length < 2) {
      setPendingRoom(roomCode);
      return needName('Enter a display name above, then press Enter to join this room.');
    }
    setPendingRoom(null);
    rememberUsername(trimmed);
    navigate(`/room/${roomCode.toUpperCase()}`);
  };

  // Enter in the name field completes a listed room that's still waiting on a name.
  // Anywhere else, Enter is left to the browser.
  const onNameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && pendingRoom) {
      event.preventDefault();
      joinListedRoom(pendingRoom);
    }
  };

  // Demo is always the first row: the server pins it, and this fallback keeps it
  // there even before the first fetch lands or if a cold server is still asleep.
  const demoRoom: LiveRoom =
    liveRooms.find((room) => room.isDemo) ?? {
      code: DEMO_ROOM_CODE,
      host: 'Doraemon',
      viewers: 0,
      title: 'Doraemon Title Song',
      isDemo: true,
    };
  const rows: LiveRoom[] = [demoRoom, ...liveRooms.filter((room) => !room.isDemo)];

  // Restart a connection the transport already gave up on. reconnect_failed is
  // terminal - Socket.IO stops trying, and before this nothing short of a page
  // reload could start it again.
  const retryConnection = () => {
    setError('');
    socket.connect();
  };

  return (
    <main className="home">
      <div className="home__glow" aria-hidden />

      <header className="home__brand">
        <span className="logo-mark" aria-hidden>
          <img src="/favicon.svg" alt="" width="48" height="48" />
        </span>
        <div>
          <div className="home__brandline">
            <h1>Watch Party</h1>
            {/* A decorative CSS sound-wave under the title, loops to feel on-air. */}
            <span className="brand-wave" aria-hidden>
              {Array.from({ length: 18 }).map((_, i) => (
                <i key={i} />
              ))}
            </span>
          </div>
          <p>YouTube, in step with everyone in the room.</p>
        </div>
      </header>

      <div className="home__layout">
      <section className="home__card">
        <label className={`field ${nameAlert ? 'field--alert' : ''}`}>
          <span className="field__label">Display name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onNameKeyDown}
            placeholder="How the room will see you"
            maxLength={24}
            autoComplete="nickname"
          />
        </label>

        <div className="home__split">
          <div className="pane">
            <h2>Start a party</h2>
            <p className="pane__hint">You become the Host and control playback for everyone.</p>

            <label className="field">
              <span className="field__label">
                YouTube link <em>optional</em>
              </span>
              <input
                value={video}
                onChange={(event) => setVideo(event.target.value)}
                placeholder="https://youtu.be/…"
                inputMode="url"
              />
            </label>
            {video && (
              <p className={`pane__check ${videoId ? 'pane__check--ok' : 'pane__check--bad'}`}>
                {videoId ? 'Video recognised.' : 'That does not look like a YouTube link.'}
              </p>
            )}

            <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={onCreate}>
              {queued === 'create' ? 'Waiting for the server…' : busy === 'create' ? 'Creating…' : 'Create room'}
            </button>
          </div>

          <div className="pane">
            <h2>Join a party</h2>
            <p className="pane__hint">Ask the host for their six-character code.</p>

            <form onSubmit={onJoin}>
              <label className={`field ${codeAlert ? 'field--alert' : ''}`}>
                <span className="field__label">Room code</span>
                <input
                  ref={codeRef}
                  className="code-input"
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                  placeholder="ABC123"
                  maxLength={8}
                  autoComplete="off"
                />
              </label>
              <div className="pane__actions">
                <button type="submit" className="btn btn--ghost" disabled={busy !== null}>
                  {queued === 'join' ? 'Waiting for the server…' : busy === 'join' ? 'Joining…' : 'Join room'}
                </button>
                <button
                  type="button"
                  className="btn btn--demo"
                  disabled={busy !== null}
                  onClick={onDemo}
                  title="Open the always-on demo party - Doraemon songs, everyone joins as a viewer"
                >
                  🎉 Demo room
                </button>
              </div>
            </form>
          </div>
        </div>

        {error && <p className="home__error">{error}</p>}

        <p className="home__status">
          <span className={`dot dot--${status === 'connected' ? 'ok' : status === 'connecting' ? 'wait' : 'bad'}`} />
          {/*
            `connecting` means an attempt is in flight or retrying after a drop;
            `disconnected` is saved for "we stopped trying", the only state where a
            manual retry is the answer.
          */}
          {status === 'connected'
            ? 'Connected to the realtime server'
            : status === 'connecting'
              ? 'Connecting to the realtime server…'
              : 'Cannot reach the realtime server.'}
          {status === 'disconnected' && (
            <button type="button" className="home__retry" onClick={retryConnection}>
              Try again
            </button>
          )}
        </p>
      </section>

        <aside className="live-rooms" aria-label="Live rooms">
          <div className="live-rooms__head">
            <span className="live-rooms__dot" aria-hidden />
            <h2>Live rooms</h2>
            <span className="live-rooms__count">{rows.length}</span>
          </div>

          {/* One room per line, demo first. ~five show at a time, rest scroll. Each
              row's Join reuses the one name field above (see joinListedRoom). */}
          <ul className="live-rooms__list">
            {rows.map((room) => (
              <li key={room.code} className="live-room">
                <span className="live-room__host">
                  {room.isDemo && <span className="live-room__tag">★ Demo</span>}
                  <span className="live-room__hostname">{room.host}</span>
                </span>
                <span className="live-room__viewers">{room.viewers} watching</span>
                <button type="button" className="btn btn--tiny" onClick={() => joinListedRoom(room.code)}>
                  Join
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <ul className="home__features">
        <li>
          <strong>Synced to the second</strong>
          <span>Play, pause and seek are applied by the server, then pushed to every client.</span>
        </li>
        <li>
          <strong>Host &amp; Moderator control playback</strong>
          <span>Everyone else watches — and can ask the host to make a change.</span>
        </li>
        <li>
          <strong>No accounts, no install</strong>
          <span>Share a link, and whoever opens it is in the room.</span>
        </li>
      </ul>

      <SiteFooter />
    </main>
  );
}
