/**
 * Loads the YouTube IFrame Player API exactly once per page.
 *
 * The API is unusual: `iframe_api` is a script that, when it finishes, calls a
 * global `window.onYouTubeIframeAPIReady()`. So the only way to know it is safe
 * to construct a player is to install that callback *before* injecting the
 * script. Wrapping that in a cached Promise turns it into something React can
 * actually `await`, and the cache is what stops a remounted component from
 * injecting the script a second time.
 */

let loading: Promise<YouTubeApi> | null = null;

/** The subset of `window.YT` we depend on, named for readability. */
export interface YouTubeApi {
  Player: new (element: HTMLElement | string, options: YT.PlayerOptions) => YT.Player;
  PlayerState: typeof YT.PlayerState;
}

export function loadYouTubeApi(): Promise<YouTubeApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('YouTube IFrame API requires a browser.'));
  }

  if (window.YT?.Player) {
    return Promise.resolve(window.YT as unknown as YouTubeApi);
  }

  if (loading) return loading;

  loading = new Promise<YouTubeApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT as unknown as YouTubeApi);
      else reject(new Error('YouTube API loaded but YT.Player is missing.'));
    };

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = () => {
      loading = null;
      reject(new Error('Could not load the YouTube IFrame API (network or blocker).'));
    };
    document.head.appendChild(tag);
  });

  return loading;
}

/** Human-readable text for the numeric `onError` codes the API reports. */
export function describeYouTubeError(code: number): string {
  switch (code) {
    case 2:
      return 'That video id is not valid.';
    case 5:
      return 'The HTML5 player could not load this video.';
    case 100:
      return 'This video is no longer available (removed or private).';
    case 101:
    case 150:
      return "The uploader doesn't allow this video to be embedded. Pick another one.";
    default:
      return `The YouTube player reported an error (code ${code}).`;
  }
}
