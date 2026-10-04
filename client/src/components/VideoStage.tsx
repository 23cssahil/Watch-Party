import { useEffect, useRef, useState } from 'react';
import { useRoomStore } from '../store/roomStore';
import { useYouTubeSync } from '../hooks/useYouTubeSync';
import { requestSync } from '../actions';
import { colorFor, initials } from '../lib/format';
import ControlBar from './ControlBar';
import ReactionBar from './ReactionBar';

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
  const participants = useRoomStore((state) => state.participants);
  const player = useYouTubeSync(containerRef);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Presence orbit: the people in the room, arranged around the frame. Capped so
  // a crowded party stays legible rather than turning into a ring of dots; the
  // full roster always lives in the People tab. Coordinates are computed here (not
  // in CSS) so we do not depend on the newer CSS trig functions being supported —
  // each chip lands on an ellipse just inside the frame edge, host first at top.
  const orbitTotal = Math.min(participants.length, 10);
  const orbit = participants.slice(0, 10).map((person, index) => {
    const angle = (index / Math.max(orbitTotal, 1)) * Math.PI * 2 - Math.PI / 2;
    return { person, angle };
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
          Presence orbit — a decorative ring of who is watching, driven purely by
          the store roster. Each chip is placed on an ellipse just inside the frame
          edge via left/top percentages. pointer-events: none, so it never
          intercepts clicks meant for the video.
        */}
        {orbit.length > 1 && (
          <div className="stage__orbit" aria-hidden>
            {orbit.map(({ person, angle }) => (
              <span
                key={person.userId}
                className={`orbit__chip orbit__chip--${person.role}`}
                style={{
                  left: `${50 + Math.cos(angle) * 47}%`,
                  top: `${50 + Math.sin(angle) * 45}%`,
                }}
                title={`${person.username} · ${person.role}`}
              >
                <span className="orbit__avatar" style={{ background: colorFor(person.username) }}>
                  {initials(person.username)}
                </span>
              </span>
            ))}
          </div>
        )}

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
            <strong>Tap to join the party</strong>
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
        <button type="button" className="btn btn--tiny stage__resync" onClick={requestSync}>
          Re-sync me
        </button>
      </div>
    </section>
  );
}
