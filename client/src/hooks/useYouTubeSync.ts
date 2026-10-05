import { useCallback, useEffect, useRef, useState } from 'react';
import { expectedPosition, useRoomStore } from '../store/roomStore';
import { loadYouTubeApi, describeYouTubeError, type YouTubeApi } from '../lib/youtubeApi';
import { socket } from '../socket';
import type { SyncState } from '../types';

/**
 * useYouTubeSync - keeps the local YouTube player in sync with the room.
 *
 * Three things were tricky here:
 *
 * 1. Feedback loops. If we sent "I paused" every time the player reports a
 *    pause, it would also fire when the server told us to pause, and the room
 *    would echo forever. So nothing in this file emits a playback event - only
 *    clicks on our own control bar do. onStateChange is read just to detect
 *    local things like a blocked autoplay.
 *
 * 2. Sync vs user race. When we call pauseVideo() the API fires onStateChange
 *    a moment later, which used to flicker the UI as if the viewer paused it.
 *    suppressUntilRef marks the window where those changes are expected.
 *
 * 3. Latency makes a timestamp stale. sync_state says "position 42.0" but we
 *    get it ~120ms later, so applying 42.0 exactly would leave the room behind
 *    the host. We aim at expectedPosition() instead, which projects the number
 *    forward using local elapsed time.
 *
 * Autoplay: a browser won't start a video with sound without a user gesture, so
 * if we're told to play and nothing happens we show a "Tap to sync" overlay
 * rather than silently muting or desyncing.
 *
 * Position lives in this component's state, not the global store - it ticks a
 * few times a second and putting it in shared state would re-render everything.
 */

const DRIFT_TOLERANCE_SEC = 0.4;
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
  /** Called by the "Tap to sync" overlay, inside a real user gesture. */
  satisfyGesture: () => void;
  seekLocal: (time: number) => void;
  /** Move the local player only, no socket emit. Used in the demo room, where
   *  play/pause is just for this screen, not the whole room. */
  playLocal: () => void;
  pauseLocal: () => void;
}

export function useYouTubeSync(
  containerRef: React.RefObject<HTMLDivElement | null>
): YouTubeSyncState {
  const playerRef = useRef<YT.Player | null>(null);
  const apiRef = useRef<YouTubeApi | null>(null);
  const suppressUntilRef = useRef(0);
  const loadedVideoRef = useRef<string | null>(null);
  // Stays false until the room names a video. Used to guard the error path: an
  // error before there's anything to play is about our placeholder, not the room.
  const hadVideoRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Video title read from the player - shown as info, never used as a control. */
  const [videoTitle, setVideoTitle] = useState('');

  const sync = useRoomStore((state) => state.sync);
  const roomId = useRoomStore((state) => state.roomId); // presence gate only
  // Demo room: playback is local-only, so we ignore the shared room clock and
  // follow this screen's own play/pause/seek. See ControlBar.
  const isDemo = useRoomStore((state) => state.isDemo);

  // True once the room has named a video. We don't build the player before this:
  // an IFrame API instance with no videoId makes an iframe with no src, and our
  // whole sync layer waits on onReady. On a fresh load of /room/CODE the room
  // state arrives after mount, so the player used to sit dead (no video, error
  // overlay, useless re-sync button). Joining from Home worked fine, which is why
  // a refresh looked broken.
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

        // Read the title straight off the player instead of tracking it next to
        // loadVideoById, so it always matches what's actually loaded.
        const readTitle = () => {
          const data = playerRef.current?.getVideoData?.();
          if (data?.title) setVideoTitle(data.title);
        };

        playerRef.current = new api.Player(element, {
          videoId: initialVideo,
          // No `host` override on purpose. Setting youtube-nocookie.com here while
          // the API script loads from www.youtube.com makes www-widgetapi post
          // messages to the wrong origin, and Chrome floods the console with
          // postMessage errors. The `origin` param below is what actually
          // authorises the embed, and that one stays.
          playerVars: {
            // We use our own control bar, so hide YouTube's. Leaving it would let a
            // viewer scrub/pause through a path the sync layer never sees.
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
              // Player produced a frame, so any old error was about a state we've
              // already left - clear it so errors don't linger.
              setError(null);

              const nextDuration = playerRef.current.getDuration?.() || 0;
              if (nextDuration > 0) setDuration(nextDuration);
              // A state change is when a newly loaded video becomes queryable, so
              // grab the title here too rather than lagging a whole action behind.
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
    // hasVideo flips once per room (never -> named), which is when there's finally
    // something to build a player around. Otherwise mount once: the player is
    // imperative and shouldn't be rebuilt on re-render. Later video *changes* go
    // through cueVideoById, not by tearing the iframe down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, hasVideo]);

  // --------------------------------------------------------------- apply sync

  const applySync = useCallback((next: SyncState) => {
    const player = playerRef.current;
    if (!player) return;

    if (next.videoId) {
      hadVideoRef.current = true;
      // A video is now actually playing, so any error on screen is stale.
      setError(null);
    }

    // Any state change in the next moment is our own doing, ignore it.
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

    // The host is the source of truth - the server derives position from them.
    // Seeking the host's own player back causes re-buffering (the "1s play then
    // stop" stutter a new host sees after taking over). Only viewers need fixing.
    const myRole = useRoomStore.getState().me?.role;
    if (myRole !== 'host') {
      const current = player.getCurrentTime?.() ?? 0;
      if (Math.abs(target - current) > DRIFT_TOLERANCE_SEC) {
        player.seekTo(target, true);
      }
    }

    if (next.isPlaying) player.playVideo();
    else player.pauseVideo();
  }, []);

  useEffect(() => {
    // In a demo room the shared clock is meaningless - applying it would yank this
    // viewer back to the room position and undo their own pause/seek.
    if (!ready || !sync || isDemo) return;
    applySync(sync);
  }, [ready, sync, applySync, isDemo]);

  /**
   * Coming back to a tab that was in the background.
   *
   * A hidden tab gets throttled (our drift loop may run once a minute instead of
   * twice a second) and YouTube often pauses itself since the page isn't visible.
   * The room keeps running for everyone else, which is right. The problem was the
   * returning viewer's own screen sitting paused and then drifting. So on return
   * we re-apply the room state immediately instead of waiting for the next
   * heartbeat. A browser-caused pause is never broadcast as a room pause.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || !ready) return;
      // A demo viewer's pause is theirs to keep - don't resume it on tab return.
      if (useRoomStore.getState().isDemo) return;
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

      // Skip hidden tabs: nobody's watching, timers are throttled anyway, and a
      // seek on a browser-paused player is how a background tab ends up stuttering.
      // The visibilitychange handler does the real repair when the tab comes back.
      if (document.visibilityState === 'hidden') return;

      // A seek is still settling (or buffering). Correcting during this window is
      // what makes sync code stutter, since the reported position hasn't caught up.
      if (Date.now() < suppressUntilRef.current) return;

      // Host is the source of truth again - the server's clock is built from their
      // position, so seeking the host causes buffering stutter. Only fix viewers.
      const myRole = store.me?.role;
      if (myRole === 'host') return;

      const target = expectedPosition(store);
      const current = player.getCurrentTime?.() ?? 0;
      const drift = Math.abs(target - current);

      // Only correct real drift. Seeking every beat would stall playback on
      // re-buffering and make the room look less stable, not more.
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
    if (!ready) return;
    const player = playerRef.current;
    if (!player || !apiRef.current) return;

    // A demo needs one tap to start its cued video (a real gesture is the only way
    // past the browser's autoplay-with-sound block). Elsewhere we only need a tap
    // when the room says it's playing but we aren't.
    const wantsPlayback = isDemo ? true : Boolean(sync?.isPlaying);
    if (!wantsPlayback) return;

    const timer = window.setTimeout(() => {
      // A paused player in a hidden tab is just the browser being efficient, not a
      // missing gesture. Showing the overlay there would park a tap button over a
      // party that's already joined.
      if (document.visibilityState !== 'hidden') {
        const state = player.getPlayerState?.();
        const api = apiRef.current!;
        const alive =
          state === api.PlayerState.PLAYING || state === api.PlayerState.BUFFERING;
        if (!alive) setNeedsGesture(true);
      }
    }, 900);

    return () => clearTimeout(timer);
  }, [ready, isDemo, sync?.isPlaying, sync?.videoId, sync?.updatedAt]);

  // ------------------------------------------------------- duration reporting

  useEffect(() => {
    if (!ready || !roomId || duration <= 0) return;
    // The title is sent with the duration because both are things about the video
    // the server can't see itself. sync?.videoId is a dependency so a new video is
    // reported even when its duration matches the old one.
    socket.emit('report_duration', { duration, title: videoTitle });
  }, [ready, roomId, duration, videoTitle, sync?.videoId]);

  // ------------------------------------------------------------------ controls

  const satisfyGesture = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const store = useRoomStore.getState();
    suppressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;
    // In a demo the tap always starts the cued video (no room clock to read a
    // decision from); elsewhere we honour whatever the room is doing.
    if (store.isDemo || store.sync?.isPlaying) {
      player.unMute();
      player.playVideo();
    } else {
      player.pauseVideo();
    }
    setNeedsGesture(false);
  }, []);

  const playLocal = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    suppressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;
    setNeedsGesture(false);
    player.playVideo();
  }, []);

  const pauseLocal = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    suppressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;
    player.pauseVideo();
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
    playLocal,
    pauseLocal,
  };
}
