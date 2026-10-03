import { FormEvent, useState } from 'react';
import { changeVideo, pause, play, seek } from '../actions';
import { useRoomStore } from '../store/roomStore';
import { extractVideoId, formatTime } from '../lib/format';
import type { YouTubeSyncState } from '../hooks/useYouTubeSync';

interface Props {
  player: YouTubeSyncState;
}

/**
 * Playback controls.
 *
 * The rule this component lives by: **it never asks itself for permission.**
 * A click always calls `play()` / `pause()` / `seek()`, and the server's gate
 * decides whether that becomes an action or an approval request. So there is no
 * `if (role === 'participant') emitRequest()` branch here — which is precisely
 * the branch that would drift out of sync with the backend and become a hole.
 *
 * What the capability list *is* used for is presentation: showing "Ask the host
 * to…" instead of "Pause", and dimming the control, so the user is never
 * surprised by a request dialog they did not expect.
 */
export default function ControlBar({ player }: Props) {
  const capabilities = useRoomStore((state) => state.me?.capabilities);
  const sync = useRoomStore((state) => state.sync);
  const pending = useRoomStore((state) => state.myPendingActions);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlOpen, setUrlOpen] = useState(false);

  const canControl = Boolean(capabilities?.allowedActions.includes('play'));
  const position = player.duration > 0 ? player.position : (sync?.position ?? 0);
  const duration = player.duration || sync?.duration || 0;

  const pendingFor = (action: string) => pending.some((request) => request.action === action);

  const submitVideo = (event: FormEvent) => {
    event.preventDefault();
    const videoId = extractVideoId(urlDraft);
    if (!videoId) return;
    changeVideo(videoId);
    setUrlDraft('');
    setUrlOpen(false);
  };

  return (
    <div className="controls">
      <div className="controls__row">
        <button
          type="button"
          className={`controls__play ${canControl ? '' : 'controls__play--ask'}`}
          onClick={() => (player.playing ? pause() : play())}
          disabled={!sync}
          title={canControl ? (player.playing ? 'Pause for everyone' : 'Play for everyone') : 'Sends a request to the host'}
        >
          {player.playing ? '❚❚' : '▶'}
        </button>

        <span className="controls__time">
          {formatTime(position)} <em>/</em> {duration ? formatTime(duration) : '--:--'}
        </span>

        <input
          className="controls__seek"
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={0.5}
          value={Math.min(position, duration || position)}
          onChange={(event) => seek(Number(event.target.value))}
          disabled={!sync || duration <= 0}
          aria-label="Seek"
        />

        <div className="controls__volume">
          <button type="button" className="icon-btn" onClick={player.toggleMute} title="Mute (local only)">
            {player.muted || player.volume === 0 ? '🔇' : player.volume < 45 ? '🔉' : '🔊'}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={player.muted ? 0 : player.volume}
            onChange={(event) => player.setVolume(Number(event.target.value))}
            aria-label="Volume (affects only you)"
          />
        </div>

        <button
          type="button"
          className="btn btn--tiny"
          onClick={() => setUrlOpen((open) => !open)}
          disabled={!sync}
        >
          {canControl ? 'Change video' : 'Ask to change video'}
        </button>
      </div>

      {urlOpen && (
        <form className="controls__video" onSubmit={submitVideo}>
          <input
            value={urlDraft}
            autoFocus
            placeholder="Paste a YouTube link"
            onChange={(event) => setUrlDraft(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn--primary btn--tiny"
            disabled={!extractVideoId(urlDraft)}
          >
            {canControl ? 'Play for everyone' : 'Send request'}
          </button>
        </form>
      )}

      <div className="controls__foot">
        {!canControl && (
          <p className="controls__hint">
            You are watching as a <strong>{capabilities?.role}</strong>. Controls send an approval
            request to the host instead of changing the room.
          </p>
        )}
        {pending.length > 0 && (
          <p className="controls__pending">
            {pending.length === 1
              ? `Waiting for the host to ${describe(pending[0].action)}…`
              : `${pending.length} requests waiting for the host…`}
          </p>
        )}
        {canControl && pendingFor('play') && <p className="controls__pending">A request is pending.</p>}
      </div>
    </div>
  );
}

function describe(action: string): string {
  switch (action) {
    case 'play':
      return 'resume playback';
    case 'pause':
      return 'pause the video';
    case 'seek':
      return 'move the playback position';
    case 'change_video':
      return 'change the video';
    default:
      return action;
  }
}
