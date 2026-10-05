/**
 * Minimal ambient typings for the YouTube IFrame Player API.
 *
 * The API is injected at runtime by https://www.youtube.com/iframe_api and has no
 * official TypeScript definitions, and @types/youtube is unmaintained, so we
 * declare just the surface this app uses. If the API gains or renames a method we
 * call, the compiler catches it here instead of at runtime.
 */

declare namespace YT {
  interface PlayerVars {
    autoplay?: 0 | 1;
    controls?: 0 | 1;
    rel?: 0 | 1;
    modestbranding?: 0 | 1;
    playsinline?: 0 | 1;
    disablekb?: 0 | 1;
    iv_load_policy?: 3;
    fs?: 0 | 1;
    origin?: string;
    host?: string;
  }

  interface PlayerEvent<T = unknown> {
    data: T;
    target: Player;
  }

  interface PlayerOptions {
    videoId?: string;
    width?: number | string;
    height?: number | string;
    host?: string;
    playerVars?: PlayerVars;
    events?: {
      onReady?: (event: PlayerEvent) => void;
      onStateChange?: (event: PlayerEvent<number>) => void;
      onError?: (event: PlayerEvent<number>) => void;
    };
  }

  enum PlayerState {
    UNSTARTED = -1,
    ENDED = 0,
    PLAYING = 1,
    PAUSED = 2,
    BUFFERING = 3,
    CUED = 5,
  }

  interface Player {
    playVideo(): void;
    pauseVideo(): void;
    stopVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    loadVideoById(videoId: string, startSeconds?: number): void;
    cueVideoById(videoId: string, startSeconds?: number): void;
    getPlayerState(): number | undefined;
    getCurrentTime(): number;
    getDuration(): number;
    /** Metadata for whatever is loaded now, so a title cannot describe the wrong video. */
    getVideoData(): { video_id?: string; title?: string; author?: string };
    setVolume(volume: number): void;
    mute(): void;
    unMute(): void;
    isMuted(): boolean;
    destroy(): void;
    getIframe(): HTMLIFrameElement;
  }

  function createPlayer(element: HTMLElement | string, options: PlayerOptions): Player;
}

interface Window {
  YT?: typeof YT & { Player?: unknown };
  onYouTubeIframeAPIReady?: () => void;
}
