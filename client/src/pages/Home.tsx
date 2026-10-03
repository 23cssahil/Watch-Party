import { FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom, joinRoom } from '../actions';
import { getIdentity } from '../socket';
import { useRoomStore } from '../store/roomStore';
import { extractVideoId } from '../lib/format';
import type { JoinResult } from '../actions';

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

  const videoId = extractVideoId(video);
  const trimmed = name.trim();
  const ready = trimmed.length >= 2 && status === 'connected';

  const onResult = (route: 'create' | 'join') => (result: JoinResult) => {
    setBusy(null);
    if (result.ok && result.roomId) {
      navigate(`/room/${result.roomId}`);
      return;
    }
    setError(result.error || (route === 'join' ? 'Could not join that room.' : 'Could not create the room.'));
  };

  const onCreate = () => {
    if (!ready) {
      setError(trimmed.length < 2 ? 'Pick a display name of at least 2 characters.' : 'Still connecting to the server…');
      return;
    }
    setError('');
    setBusy('create');
    createRoom(trimmed, videoId || undefined, onResult('create'));
  };

  const onJoin = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const target = code.trim().toUpperCase();
    if (target.length < 4) return setError('That room code looks too short.');
    setError('');
    setBusy('join');
    joinRoom(target, trimmed, onResult('join'));
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
              {busy === 'create' ? 'Creating…' : 'Create room'}
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
                {busy === 'join' ? 'Joining…' : 'Join room'}
              </button>
            </form>
          </div>
        </div>

        {error && <p className="home__error">{error}</p>}

        <p className="home__status">
          <span className={`dot dot--${status === 'connected' ? 'ok' : status === 'connecting' ? 'wait' : 'bad'}`} />
          {status === 'connected'
            ? 'Connected to the realtime server'
            : status === 'connecting'
              ? 'Connecting to the realtime server…'
              : 'Disconnected — retrying automatically'}
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
