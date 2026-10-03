import { useRef } from 'react';
import { useRoomStore } from '../store/roomStore';
import { useYouTubeSync } from '../hooks/useYouTubeSync';
import { requestSync } from '../actions';
import ControlBar from './ControlBar';
import ReactionBar from './ReactionBar';

/**
 * Hosts the YouTube IFrame and every overlay that can sit on top of it.
 *
 * The `<div>` handed to the API is replaced by an iframe that YouTube injects,
 * so this component renders an empty container and never touches its children —
 * React and the IFrame API must not fight over the same DOM node.
 */
export default function VideoStage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sync = useRoomStore((state) => state.sync);
  const status = useRoomStore((state) => state.status);
  const player = useYouTubeSync(containerRef);

  return (
    <section className="stage">
      <div className="stage__frame">
        <div ref={containerRef} className="stage__player" />

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
          <div className="stage__banner">Reconnecting to the room…</div>
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
