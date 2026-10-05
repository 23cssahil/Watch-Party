import { useEffect, useRef, useState } from 'react';
import { useRoomStore } from '../store/roomStore';
import { useYouTubeSync } from '../hooks/useYouTubeSync';
import { requestSync } from '../actions';
import ControlBar from './ControlBar';
import ReactionBar from './ReactionBar';
import BeatVisualizer from './BeatVisualizer';

// Small wrappers around the Fullscreen API.
// Safari still uses the prefixed form and the names differ between engines, so
// every access goes through these three helpers instead of being scattered around.
// The type casts are kept here so the rest of the file stays in normal DOM types.
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};

const fullscreenNode = (): Element | null => {
  const doc = document as FsDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
};

const enterFullscreen = (el: HTMLElement) => {
  const node = el as FsElement;
  if (node.requestFullscreen) void node.requestFullscreen();
  else node.webkitRequestFullscreen?.();
};

const exitFullscreen = () => {
  const doc = document as FsDocument;
  if (doc.exitFullscreen) void doc.exitFullscreen();
  else doc.webkitExitFullscreen?.();
};

/**
 * Hosts the YouTube IFrame and the overlays that sit on top of it.
 *
 * The <div> given to the API gets replaced by an iframe YouTube injects, so this
 * renders an empty container and never touches its children - React and the IFrame
 * API shouldn't fight over the same DOM node.
 */
export default function VideoStage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const sync = useRoomStore((state) => state.sync);
  const status = useRoomStore((state) => state.status);
  const syncPulse = useRoomStore((state) => state.syncPulse);
  // Demo room: playback is local, so a "re-sync with the room" button is
  // meaningless here and gets hidden. See ControlBar.
  const isDemo = useRoomStore((state) => state.isDemo);
  const player = useYouTubeSync(containerRef);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // The beat visualiser is a local, cosmetic preference, so it stays in component
  // state (saved to localStorage) instead of the room store - it shouldn't leak
  // into the shared, server-authoritative state.
  const [beatOn, setBeatOn] = useState(() => localStorage.getItem('watch-party:beat') !== 'off');
  const toggleBeat = () =>
    setBeatOn((on) => {
      const next = !on;
      localStorage.setItem('watch-party:beat', next ? 'on' : 'off');
      return next;
    });

  // Mirror the browser's real fullscreen state, so Esc (and the OS gesture that
  // leaves fullscreen) keeps the button's icon honest instead of stuck on "exit".
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(fullscreenNode()));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // The whole stage goes fullscreen, not just the iframe, so the ControlBar stays
  // reachable. YouTube's own fullscreen button is covered by the click blocker (a
  // native control there would skip the permission gate), so this is the sanctioned
  // way to enlarge the video.
  const toggleFullscreen = () => {
    if (fullscreenNode()) exitFullscreen();
    else if (stageRef.current) enterFullscreen(stageRef.current);
  };

  return (
    <section className="stage" ref={stageRef}>
      {/*
        Synthetic beat visualiser. It's a sibling behind the video frame (not inside
        it), so the equaliser can fill the dark gutter on the sides instead of
        covering the picture. Runs only when the effect is on and the room is
        playing, and never intercepts clicks.
      */}
      <BeatVisualizer active={beatOn && player.playing} />

      <div className="stage__frame">
        <div ref={containerRef} className="stage__player" />

        {/*
          Live sync pulse. A real playback change bumps syncPulse in the store;
          keying this span on that counter makes React remount it every beat, which
          replays its one-shot ripple animation. Nothing plays at 0 (no change yet),
          so the stage stays calm until the room moves.
        */}
        {syncPulse > 0 && <span key={syncPulse} className="stage__pulse" aria-hidden />}

        {/*
          Transparent blocker over the YouTube iframe. YouTube's IFrame has its own
          native center play/pause button, and without this a Participant could click
          it straight into the iframe, skipping our server-side permission gate. This
          catches every pointer event on the video area. Our own overlays (gesture,
          error, banner) sit above it via z-index and stay clickable.
        */}
        <div className="stage__click-blocker" aria-hidden="true" />

        {player.ready && !player.error && (
          <button
            type="button"
            className="stage__fs"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit full screen' : 'Full screen'}
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          >
            {isFullscreen ? '✕' : '⛶'}
          </button>
        )}

        {!player.ready && !player.error && (
          <div className="stage__overlay">
            <span className="spinner" />
            <p>Loading player…</p>
          </div>
        )}

        {player.error && (
          <div className="stage__overlay stage__overlay--error">
            <h3>Player problem</h3>
            <p>{player.error}</p>
            <button type="button" className="btn btn--ghost" onClick={requestSync}>
              Ask the server for the current state
            </button>
          </div>
        )}

        {player.needsGesture && !player.error && (
          <button type="button" className="stage__overlay stage__overlay--gesture" onClick={player.satisfyGesture}>
            <span className="gesture-icon" aria-hidden>▶</span>
            <strong>{isDemo ? 'Tap to start the music' : 'Tap to join the party'}</strong>
            <small>Browsers block video with sound until you interact with the page.</small>
          </button>
        )}

        {status !== 'connected' && (
          /*
            Wording tracks the real state. `idle` means this page hasn't connected
            yet, so calling that "reconnecting" implies a drop that never happened.
            A real drop puts the socket in `connecting`, and a transport that stopped
            trying swaps this for RoomUnavailable, which has a working retry.
          */
          <div className="stage__banner">
            {status === 'idle' ? 'Connecting to the room…' : 'Reconnecting to the room…'}
          </div>
        )}

        {sync && !player.ready && !player.error && (
          <div className="stage__title">
            <img src={`https://i.ytimg.com/vi/${sync.videoId}/hqdefault.jpg`} alt="" />
          </div>
        )}
      </div>

      <ControlBar player={player} />

      <div className="stage__under">
        <ReactionBar />
        <button
          type="button"
          className={`btn btn--tiny stage__beat ${beatOn ? 'stage__beat--on' : ''}`}
          onClick={toggleBeat}
          aria-pressed={beatOn}
          title="Toggle the live beat visualiser"
        >
          🎵 Beats {beatOn ? 'on' : 'off'}
        </button>
        {!isDemo && (
          <button type="button" className="btn btn--tiny stage__resync" onClick={requestSync}>
            Re-sync me
          </button>
        )}
      </div>
    </section>
  );
}
