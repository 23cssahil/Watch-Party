/**
 * Loads the YouTube IFrame Player API only once per page.
 *
 * The API works differently from a normal script: iframe_api is a script that,
 * once it finishes, calls a global window.onYouTubeIframeAPIReady(). So the only
 * way to know it's safe to build a player is to install that callback before adding
 * the script. Wrapping that in a cached Promise makes it something React can await,
 * and the cache stops a remounted component from adding the script a second time.
 */

let loading: Promise<YouTubeApi> | null = null;

/**
 * How long to wait for `iframe_api` before treating it as a failure.
 *
 * script.onerror only fires if the request itself fails. A browser extension or a
 * stalled connection can leave the script neither loaded nor errored, and without a
 * deadline the UI would sit on "Loading player…" forever. An endless spinner is
 * worse than an error message here, since it gives the viewer nothing to act on.
 */
const LOAD_TIMEOUT_MS = 15000;

/** The subset of window.YT we depend on, named for readability. */
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
    // Finish only once: the API callback, the timeout and onerror can all race,
    // and a late second settle would be ignored anyway.
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      // Clearing the cached promise is what makes a retry possible - a second try
      // injects the script tag again instead of waiting on the one that already
      // hung.
      loading = null;
      reject(new Error(message));
    };
    const succeed = (api: YouTubeApi) => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      resolve(api);
    };

    const bail = setTimeout(
      () => fail('The YouTube player did not load. Check your connection, or any extension that blocks youtube.com.'),
      LOAD_TIMEOUT_MS
    );

    const previous = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) succeed(window.YT as unknown as YouTubeApi);
      else fail('YouTube API loaded but YT.Player is missing.');
    };

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = () => fail('Could not load the YouTube IFrame API (network or blocker).');
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
