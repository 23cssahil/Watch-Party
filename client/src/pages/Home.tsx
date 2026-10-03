import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom, joinRoom } from '../actions';
import { getIdentity, socket } from '../socket';
import { useRoomStore } from '../store/roomStore';
import { extractVideoId } from '../lib/format';
import type { JoinResult } from '../actions';

/**
 * Shown when a button was pressed after the transport had *stopped* retrying.
 *
 * Distinct from the waking case below: there is nothing in flight to queue a click
 * into, so this is the one refusal that must send the user to the visible retry
 * control. The rule it encodes is the one the server follows for rate limits too —
 * a control the user can see must never be clickable into silence.
 */
const OFFLINE_COPY =
  'The realtime server is unreachable and retries have stopped. Press "Try again" beside the status line below, then send this again.';

/**
 * Shown when a click landed while the socket was still opening *and* was kept.
 *
 * A free instance that has gone to sleep cannot be made fast from client code —
 * the boot takes tens of seconds and no amount of retrying shortens it. What was
 * fixed here is that the click used to be thrown away during that wait, so the
 * user paid the full boot time and then had to press the button a second time.
 */
const WAKING_COPY =
  'The service is waking up — a few seconds normally, up to half a minute if it has been idle. Your click is queued: the room action runs on its own the moment the connection opens.';

/**
 * Landing page: choose a name, then start a room or enter somebody else's code.
 *
 * The room code does not exist until the server answers `create_room`, so
 * navigation happens inside the Socket.IO acknowledgement rather than
 * optimistically. An ack is the only honest way to know a join worked — and it
 * is what lets us show "no room with that code" instead of a blank screen.
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
  /**
   * An action pressed while the socket was still opening, replayed on connect.
   * `queued` exists so the button can say what is actually happening; the ref
   * holds the closure captured at click time, which is the click being honoured.
   */
  const [queued, setQueued] = useState<'create' | 'join' | null>(null);
  const queuedRef = useRef<{ intent: 'create' | 'join'; run: () => void } | null>(null);

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
    // `disconnected` is terminal — the transport has stopped trying. Keeping an
    // invisible queue alive behind a spinner would be a lie, so the button is
    // handed back and the visible "Try again" becomes the only action left.
    if (status === 'disconnected' && queuedRef.current) {
      queuedRef.current = null;
      setQueued(null);
      setBusy(null);
    }
  }, [status]);

  /** Send now, or send the instant the connection opens. Never drop a click that can be kept. */
  const runOrQueue = (intent: 'create' | 'join', run: () => void) => {
    if (status === 'connected') {
      setBusy(intent);
      run();
      return;
    }
    // Terminal: no attempt is in flight, so a queue would hang behind a spinner
    // that promises something nobody is going to deliver.
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
    if (trimmed.length < 2) return setError('Pick a display name of at least 2 characters.');
    setError('');
    runOrQueue('create', () => createRoom(trimmed, videoId || undefined, onResult('create')));
  };

  const onJoin = (event: FormEvent) => {
    event.preventDefault();
    const target = code.trim().toUpperCase();
    if (target.length < 4) return setError('That room code looks too short.');
    // Each refusal states its own reason. This used to be a single silent
    // `if (!ready) return`, so a correct code typed while the socket was still
    // connecting — or before a name was filled in — did nothing at all, and the
    // button read as dead.
    if (trimmed.length < 2) return setError('Pick a display name of at least 2 characters first.');
    setError('');
    runOrQueue('join', () => joinRoom(target, trimmed, onResult('join')));
  };

  /**
   * Restart a connection the transport already gave up on.
   *
   * `reconnect_failed` is terminal: Socket.IO stops trying, and nothing in the UI
   * was able to start it again short of reloading the page.
   */
  const retryConnection = () => {
    setError('');
    socket.connect();
  };

  return (
    <main className="home">
      <div className="home__glow" aria-hidden />

      <header className="home__brand">
        <span className="logo-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="28" height="28">
            <path d="M11 7l14 9-14 9z" fill="currentColor" />
          </svg>
        </span>
        <div>
          <h1>Watch Party</h1>
          <p>YouTube, in step with everyone in the room.</p>
        </div>
      </header>

      <section className="home__card">
        <label className="field">
          <span className="field__label">Display name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
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
              <label className="field">
                <span className="field__label">Room code</span>
                <input
                  className="code-input"
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                  placeholder="ABC123"
                  maxLength={8}
                  autoComplete="off"
                />
              </label>
              <button type="submit" className="btn btn--ghost" disabled={busy !== null || code.trim().length < 4}>
                {queued === 'join' ? 'Waiting for the server…' : busy === 'join' ? 'Joining…' : 'Join room'}
              </button>
            </form>
          </div>
        </div>

        {error && <p className="home__error">{error}</p>}

        <p className="home__status">
          <span className={`dot dot--${status === 'connected' ? 'ok' : status === 'connecting' ? 'wait' : 'bad'}`} />
          {/*
            `connecting` means an attempt is in flight or the transport is
            retrying after a drop; `disconnected` is reserved for "we stopped
            trying", which is the only state where a manual retry is the answer.
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
    </main>
  );
}
