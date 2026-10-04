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
  // Demo room: playback is local-only, so the controls drive this screen's own
  // player and never emit to the room. See `useYouTubeSync`.
  const isDemo = useRoomStore((state) => state.isDemo);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlOpen, setUrlOpen] = useState(false);
  /**
   * The value being dragged, or `null` when nobody is scrubbing.
   *
   * The slider used to be a fully-controlled input bound to the player's real
   * `position` — which only refreshes a few times a second and lags behind an
   * async `seekTo`. So while the host dragged, every move both flooded the server
   * with `seek` events *and* re-rendered the thumb back to the stale position it
   * had not reached yet: the handle fought the finger and looked stuck. Holding the
   * in-flight value here lets the thumb track the pointer exactly, and the seek is
   * committed once, on release.
   */
  const [scrub, setScrub] = useState<number | null>(null);

  const canControl = isDemo || Boolean(capabilities?.allowedActions.includes('play'));
  const position = player.duration > 0 ? player.position : (sync?.position ?? 0);
  const duration = player.duration || sync?.duration || 0;
  const seekValue = scrub ?? Math.min(position, duration || position);

  const pendingFor = (action: string) => pending.some((request) => request.action === action);

  /**
   * Commit a scrub: one seek to the server, and — for someone who can actually
   * control the room — an instant local jump so the host sees it right away
   * instead of waiting a round-trip. A Participant gets no local jump: their seek
   * is only a request, so previewing it would move them ahead of a room that has
   * not agreed yet.
   */
  const commitSeek = () => {
    if (scrub === null) return;
    const target = scrub;
    setScrub(null);
    // A demo seek is entirely local — move this screen's player and stop; there
    // is no room to notify and no host to ask.
    if (isDemo) {
      player.seekLocal(target);
      return;
    }
    if (canControl) player.seekLocal(target);
    seek(target);
  };

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
          onClick={() => {
            if (isDemo) return player.playing ? player.pauseLocal() : player.playLocal();
            return player.playing ? pause() : play();
          }}
          disabled={!sync}
          title={
            isDemo
              ? player.playing
                ? 'Pause (only your screen)'
                : 'Play (only your screen)'
              : canControl
                ? player.playing
                  ? 'Pause for everyone'
                  : 'Play for everyone'
                : 'Sends a request to the host'
          }
        >
          {player.playing ? '❚❚' : '▶'}
        </button>

        <span className="controls__time">
          {formatTime(seekValue)} <em>/</em> {duration ? formatTime(duration) : '--:--'}
        </span>

        <input
          className="controls__seek"
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={0.5}
          value={seekValue}
          onChange={(event) => setScrub(Number(event.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          onBlur={commitSeek}
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

        {!isDemo && (
          <button
            type="button"
            className="btn btn--tiny"
            onClick={() => setUrlOpen((open) => !open)}
            disabled={!sync}
          >
            {canControl ? 'Change video' : 'Ask to change video'}
          </button>
        )}
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
        {isDemo && (
          <p className="controls__hint">
            <strong>Demo room</strong> — everyone watches the same video and chats together, but
            play, pause and seek change only your own screen.
          </p>
        )}
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
