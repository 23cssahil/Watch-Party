import { useCallback, useEffect, useRef, useState } from 'react';
import { expectedPosition, useRoomStore } from '../store/roomStore';
import { loadYouTubeApi, describeYouTubeError, type YouTubeApi } from '../lib/youtubeApi';
import { socket } from '../socket';
import type { SyncState } from '../types';

/**
 * ---------------------------------------------------------------------------
 * useYouTubeSync — keeps a local YouTube player faithful to the room.
 * ---------------------------------------------------------------------------
 *
 * Three problems had to be solved here, and they are the three worth talking
 * about in an interview:
 *
 * 1. **Feedback loops.** A naive implementation emits "I paused" whenever the
 *    player reports a pause. But the player also reports a pause when the *server*
 *    told us to pause — so the room echoes forever and everyone fights.
 *    Fixed structurally, not with a flag race: **nothing in this file ever
 *    emits a playback event.** Only a click on our own control bar does. The
 *    player's `onStateChange` is read purely to detect local conditions such as
 *    a blocked autoplay.
 *
 * 2. **The sync-vs-user race.** When we call `pauseVideo()` the API fires
 *    `onStateChange` asynchronously, which used to make the UI flicker as if the
 *    viewer had paused it themselves. `suppressUntilRef` marks the window in
 *    which state changes are *expected* rather than interesting.
 *
 * 3. **Latency makes a timestamp stale.** `sync_state` says "position 42.0", but
 *    we receive it 120 ms later. Applying 42.0 puts the whole room 120 ms behind
 *    the host, permanently. So we always aim at `expectedPosition()`, which
 *    projects the server's number forward using the local elapsed time.
 *
 * Autoplay policy is handled honestly: a browser will refuse to start a video
 * with sound without a user gesture, so if we are told to play and the player
 * does not play, we surface a "Tap to sync" overlay instead of silently
 * desyncing or muting the room without asking.
 *
 * Position is kept in *this* component's state, not the global store — it ticks
 * several times a second, and putting it in shared state would re-render the
 * participant list, chat and controls on every tick.
 */

const DRIFT_TOLERANCE_SEC = 1.5;
const SUPPRESS_WINDOW_MS = 1200;
const DRIFT_CHECK_MS = 1000;
const POSITION_TICK_MS = 250;

export interface YouTubeSyncState {
  ready: boolean;
  error: string | null;
  /** True when the browser blocked the autoplay and we need one tap. */
  needsGesture: boolean;
  position: number;
  duration: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  /** Called by the "Tap to sync" overlay — runs inside a real user gesture. */
  satisfyGesture: () => void;
  seekLocal: (time: number) => void;
}

export function useYouTubeSync(
  containerRef: React.RefObject<HTMLDivElement | null>
): YouTubeSyncState {
  const playerRef = useRef<YT.Player | null>(null);
  const apiRef = useRef<YouTubeApi | null>(null);
  const suppressUntilRef = useRef(0);
  const loadedVideoRef = useRef<string | null>(null);
  /**
   * False until the room has actually named a video. Kept as the guard on the
   * error path: an error raised before there is anything to play is about our
   * placeholder, never about the room, and must not be shown as one.
   */
  const hadVideoRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Title as the player itself reports it — metadata for the room, never a control. */
  const [videoTitle, setVideoTitle] = useState('');

  const sync = useRoomStore((state) => state.sync);
  const roomId = useRoomStore((state) => state.roomId); // presence gate only

  /**
   * Whether the room has named a video yet.
   *
   * The player is not constructed before it has. An IFrame API instance created
   * with no `videoId` produces an iframe with no `src` at all, and from that point
   * `onReady` is the only thing our whole sync layer waits for — so on a full page
   * load of `/room/CODE`, where the room state arrives *after* the component
   * mounted, the player sat dead: no video, an error overlay, and a "Re-sync me"
   * button that could not help because nothing was ever cued. A client-side join
   * from Home worked, which is exactly why a refresh looked like a different app.
   */
  const hasVideo = Boolean(sync?.videoId);

  const [volume, setVolumeState] = useState(() => {
    const stored = Number(localStorage.getItem('watch-party:volume'));
    return Number.isFinite(stored) && stored > 0 ? Math.min(100, stored) : 80;
  });
  const [muted, setMuted] = useState(() => localStorage.getItem('watch-party:muted') === '1');

  // ------------------------------------------------------------------ create

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !hasVideo) return;

    let cancelled = false;
    const initialVideo = useRoomStore.getState().sync?.videoId;
    if (!initialVideo) return;

    loadYouTubeApi()
      .then((api) => {
        if (cancelled) return;
        apiRef.current = api;
        hadVideoRef.current = true;

        /**
         * Read the title off the player rather than tracking it next to the
         * `loadVideoById` calls, so it always describes what is actually loaded
         * and cannot go stale when the host switches video mid-room.
         */
        const readTitle = () => {
          const data = playerRef.current?.getVideoData?.();
          if (data?.title) setVideoTitle(data.title);
        };

        playerRef.current = new api.Player(element, {
          videoId: initialVideo,
          // Deliberately no `host` override.
          //
          // Declaring youtube-nocookie.com here while the API script is loaded
          // from www.youtube.com leaves www-widgetapi posting messages whose
          // target origin disagrees with the frame it is talking to, and Chrome
          // fills the console with "Failed to execute 'postMessage' on 'DOMWindow'".
          // The nocookie domain's privacy edge is not worth a red console on every
          // load; `origin` below is the parameter that actually authorises the
          // embed, and that one stays.
          playerVars: {
            // Our own control bar is the source of truth, so YouTube's chrome is
            // removed. Leaving it in would let a viewer scrub or pause through a
            // route the sync layer never sees — the classic way these apps drift.
            controls: 0,
            disablekb: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            iv_load_policy: 3,
            fs: 1,
            autoplay: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              playerRef.current?.setVolume(volume);
              if (muted) playerRef.current?.mute();
              readTitle();
              setReady(true);
            },
            onStateChange: (event) => {
              const api = apiRef.current;
              if (!api || !playerRef.current) return;
              const isPlaying = event.data === api.PlayerState.PLAYING;
              setPlaying(isPlaying);
              if (isPlaying) setNeedsGesture(false);
              // The player produced a frame, so whatever error was on screen was
              // about a state we have already left. Errors never linger here.
              setError(null);

              const nextDuration = playerRef.current.getDuration?.() || 0;
              if (nextDuration > 0) setDuration(nextDuration);
              // A state change is also the moment a newly loaded video becomes
              // queryable, so the title cannot lag the video by a whole action.
              readTitle();
            },
            onError: (event) => {
              const message = describeYouTubeError(Number(event.data));
              if (!hadVideoRef.current && !useRoomStore.getState().sync) {
                console.warn('[watch-party] player created before the room state arrived:', message);
                return;
              }
              setError(message);
            },
          },
        });
      })
      .catch((loadError: Error) => {
        if (!cancelled) setError(loadError.message);
      });

    return () => {
      cancelled = true;
      playerRef.current?.destroy?.();
      playerRef.current = null;
      loadedVideoRef.current = null;
    };
    // `hasVideo` flips exactly once in a room's life (never → named), which is the
    // point at which there is something to build a player around. Mount-once for
    // every other reason: the player is imperative and must not be rebuilt on
    // re-render, and a later video *change* is handled by `cueVideoById`, not by
    // tearing the iframe down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, hasVideo]);

  // --------------------------------------------------------------- apply sync

  const applySync = useCallback((next: SyncState) => {
    const player = playerRef.current;
    if (!player) return;

    if (next.videoId) {
      hadVideoRef.current = true;
      // A video is now genuinely in play, so any error still on the screen is
      // history — including the placeholder error described on `hadVideoRef`.
      setError(null);
    }

    // Anything the player reports for the next moment is our doing.
    suppressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;

    const target = expectedPosition({ sync: next, receivedAt: Date.now() });
    const videoChanged = loadedVideoRef.current !== next.videoId;

    if (videoChanged) {
      loadedVideoRef.current = next.videoId;
      if (next.isPlaying) {
        player.loadVideoById(next.videoId, Math.max(0, target));
      } else {
        player.cueVideoById(next.videoId, Math.max(0, target));
      }
      setDuration(0);
      return;
    }

    const current = player.getCurrentTime?.() ?? 0;
    if (Math.abs(target - current) > DRIFT_TOLERANCE_SEC) {
      player.seekTo(target, true);
    }

    if (next.isPlaying) player.playVideo();
    else player.pauseVideo();
  }, []);

  useEffect(() => {
    if (!ready || !sync) return;
    applySync(sync);
  }, [ready, sync, applySync]);

  /**
   * Coming back to a tab that was in the background.
   *
   * Two things happen to a hidden tab, neither of them chosen by anybody: the
   * browser throttles its timers (our drift loop can then run once a minute
   * instead of twice a second), and YouTube's player often pauses itself because
   * it can see the page is not visible. The room keeps running for everyone else,
   * which is correct — a host blinking at another tab is not an instruction to
   * pause a party. What was missing is the *host's own* screen: it sat paused and
   * then drifted, looking like the room had ignored the host.
   *
   * So on return we re-apply the authoritative state immediately rather than
   * waiting up to a heartbeat for the next one. A local pause caused by the
   * browser is never broadcast as a room pause, and never left to rot either.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || !ready) return;
      const current = useRoomStore.getState().sync;
      if (current) applySync(current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [ready, applySync]);

  // ----------------------------------------------------- drift + UI tick loop

  useEffect(() => {
    if (!ready) return;

    const driftTimer = window.setInterval(() => {
      const player = playerRef.current;
      const store = useRoomStore.getState();
      if (!player || !store.sync?.isPlaying) return;

      // Nothing is watching a hidden tab, its timers are throttled anyway, and a
      // seek issued to a player the browser has paused is how a background tab
      // ends up stuttering. The `visibilitychange` handler does the real repair
      // when the tab comes back, in one deliberate step.
      if (document.visibilityState === 'hidden') return;

      // A seek is still settling (or the video is buffering). Correcting during
      // that window is what makes badly-written sync code stutter, because the
      // reported position has not caught up with the seek we just issued.
      if (Date.now() < suppressUntilRef.current) return;

      const target = expectedPosition(store);
      const current = player.getCurrentTime?.() ?? 0;
      const drift = Math.abs(target - current);

      // Only correct real drift. Seeking on every beat would stall playback
      // while re-buffering and make the room look *less* stable, not more.
      if (drift > DRIFT_TOLERANCE_SEC) {
        suppressUntilRef.current = Date.now() + 600;
        player.seekTo(target, true);
      }
    }, DRIFT_CHECK_MS);

    const positionTimer = window.setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      const next = player.getCurrentTime?.();
      if (typeof next === 'number' && Number.isFinite(next)) setPosition(next);
      const nextDuration = player.getDuration?.();
      if (nextDuration && nextDuration > 0) {
        setDuration((previous) => (Math.abs(previous - nextDuration) > 1 ? nextDuration : previous));
      }
    }, POSITION_TICK_MS);

    return () => {
      clearInterval(driftTimer);
      clearInterval(positionTimer);
    };
  }, [ready]);

  // ------------------------------------------- autoplay-blocked detection

  useEffect(() => {
    if (!ready || !sync?.isPlaying) return;
    const player = playerRef.current;
    if (!player || !apiRef.current) return;

    const timer = window.setTimeout(() => {
      // A paused player in a hidden tab is the browser being efficient, not a
      // missing gesture. Raising the overlay for it would park a "Tap to join the
      // party" button over a party that is already joined.
      if (document.visibilityState !== 'hidden') {
        const state = player.getPlayerState?.();
        const api = apiRef.current!;
        const alive =
          state === api.PlayerState.PLAYING || state === api.PlayerState.BUFFERING;
        if (!alive) setNeedsGesture(true);
      }
    }, 900);

    return () => clearTimeout(timer);
  }, [ready, sync?.isPlaying, sync?.videoId, sync?.updatedAt]);

  // ------------------------------------------------------- duration reporting

  useEffect(() => {
    if (!ready || !roomId || duration <= 0) return;
    // The title rides along with the duration because both are facts about the
    // video the server cannot observe by itself, and `sync?.videoId` is a
    // dependency so a new video is reported even when its duration happens to
    // match the old one.
    socket.emit('report_duration', { duration, title: videoTitle });
  }, [ready, roomId, duration, videoTitle, sync?.videoId]);

  // ------------------------------------------------------------------ controls

  const satisfyGesture = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const store = useRoomStore.getState();
    suppressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;
    if (store.sync?.isPlaying) {
      player.unMute();
      player.playVideo();
    } else {
      player.pauseVideo();
    }
    setNeedsGesture(false);
  }, []);

  const seekLocal = useCallback((time: number) => {
    const player = playerRef.current;
    if (!player) return;
    suppressUntilRef.current = Date.now() + 600;
    player.seekTo(time, true);
    setPosition(time);
  }, []);

  const setVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    setVolumeState(clamped);
    localStorage.setItem('watch-party:volume', String(clamped));
    playerRef.current?.setVolume(clamped);
    if (clamped > 0) {
      playerRef.current?.unMute();
      setMuted(false);
      localStorage.setItem('watch-party:muted', '0');
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((previous) => {
      const next = !previous;
      localStorage.setItem('watch-party:muted', next ? '1' : '0');
      if (next) playerRef.current?.mute();
      else playerRef.current?.unMute();
      return next;
    });
  }, []);

  return {
    ready,
    error,
    needsGesture,
    position,
    duration: duration || sync?.duration || 0,
    playing,
    volume,
    muted,
    setVolume,
    toggleMute,
    satisfyGesture,
    seekLocal,
  };
}
