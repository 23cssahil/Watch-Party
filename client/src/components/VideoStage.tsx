import { useEffect, useRef, useState } from 'react';
import { useRoomStore } from '../store/roomStore';
import { useYouTubeSync } from '../hooks/useYouTubeSync';
import { requestSync } from '../actions';
import ControlBar from './ControlBar';
import ReactionBar from './ReactionBar';
import BeatVisualizer from './BeatVisualizer';

/**
 * Vendor-safe Fullscreen API calls.
 *
 * Safari still ships the prefixed form, and the property names differ across
 * engines, so every access is funnelled through these three helpers rather than
 * sprinkled through the component. Casting is localised here so the rest of the
 * file stays in the normal DOM typings.
 */
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
 * Hosts the YouTube IFrame and every overlay that can sit on top of it.
 *
 * The `<div>` handed to the API is replaced by an iframe that YouTube injects,
 * so this component renders an empty container and never touches its children —
 * React and the IFrame API must not fight over the same DOM node.
 */
export default function VideoStage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const sync = useRoomStore((state) => state.sync);
  const status = useRoomStore((state) => state.status);
  const syncPulse = useRoomStore((state) => state.syncPulse);
  // Demo room: playback is local, so a "re-sync with the room" affordance is
  // meaningless and is hidden. See `ControlBar`.
  const isDemo = useRoomStore((state) => state.isDemo);
  const player = useYouTubeSync(containerRef);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // The beat visualiser is a purely local, cosmetic preference, so it lives in
  // component state (persisted to localStorage) rather than the room store — it
  // must never leak into the shared, server-authoritative room state.
  const [beatOn, setBeatOn] = useState(() => localStorage.getItem('watch-party:beat') !== 'off');
  const toggleBeat = () =>
    setBeatOn((on) => {
      const next = !on;
      localStorage.setItem('watch-party:beat', next ? 'on' : 'off');
      return next;
    });

  // Mirror the browser's real fullscreen state, so Esc (and the OS gesture that
  // leaves fullscreen without a click) keeps the button's icon honest rather than
  // stuck reading "exit" after the room is already back in the page.
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(fullscreenNode()));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // The whole stage goes fullscreen — not just the iframe — so the ControlBar
  // stays reachable. YouTube's own fullscreen button is covered by the click
  // blocker (a native control there would bypass the permission gate), so this
  // is the room's one sanctioned way to enlarge the video.
  const toggleFullscreen = () => {
    if (fullscreenNode()) exitFullscreen();
    else if (stageRef.current) enterFullscreen(stageRef.current);
  };

  return (
    <section className="stage" ref={stageRef}>
      {/*
        Synthetic beat visualiser. It is a sibling that sits *behind* the video
        frame (not inside it), so the equaliser can occupy the dark gutter to the
        left and right of the picture instead of covering it. It runs only while
        the effect is on and the room is actually playing, and never intercepts
        clicks (the click-blocker inside the frame still owns the video surface).
      */}
      <BeatVisualizer active={beatOn && player.playing} />

      <div className="stage__frame">
        <div ref={containerRef} className="stage__player" />

        {/*
          Live sync pulse. A real playback change bumps `syncPulse` in the store;
          keying this span on that counter makes React remount it on every beat,
          which replays its one-shot ripple animation. Nothing plays when the value
          is 0 (no change has landed yet), so the stage sits calm until the room moves.
        */}
        {syncPulse > 0 && <span key={syncPulse} className="stage__pulse" aria-hidden />}

        {/*
          Transparent blocker sitting on top of the YouTube iframe.
          Purpose: YouTube's IFrame renders its own native center play/pause
          button inside the iframe. Without this overlay a Participant can click
          that button and the click goes directly into the iframe — completely
          bypassing our server-side permission gate. The blocker intercepts every
          pointer event on the video area. Our own overlays (gesture, error,
          banner) sit above this div via z-index and remain fully clickable.
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
            Wording tracks the real state. `idle` means this page has not had a
            connection yet; calling that "reconnecting" implies a drop that never
            happened. A genuine drop puts the socket in `connecting`, and a transport
            that stopped trying swaps this screen for `RoomUnavailable`, which has a
            working retry.
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
