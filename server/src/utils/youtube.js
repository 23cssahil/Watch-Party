/**
 * YouTube id extraction / validation.
 *
 * The client is allowed to paste a full URL (youtube.com/watch?v=..., youtu.be/...,
 * /embed/..., shorts/...) or a bare 11-char id. We normalise it server-side
 * because the value is later broadcast to every other client in the room —
 * never trust a single client to have sanitised it.
 */
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * @param {unknown} raw
 * @returns {{ ok: boolean, videoId?: string, error?: string }}
 */
function resolveVideoId(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'A YouTube URL or video id is required.' };
  }

  const input = raw.trim();

  if (YT_ID.test(input)) {
    return { ok: true, videoId: input };
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: 'That is not a valid YouTube link.' };
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const isYoutube = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  if (!isYoutube) {
    return { ok: false, error: 'Only YouTube links are supported.' };
  }

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return YT_ID.test(id)
      ? { ok: true, videoId: id }
      : { ok: false, error: 'Could not read a video id from that youtu.be link.' };
  }

  const vParam = url.searchParams.get('v');
  if (vParam && YT_ID.test(vParam)) return { ok: true, videoId: vParam };

  // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
  const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
  if (match) return { ok: true, videoId: match[1] };

  return { ok: false, error: 'Could not find a YouTube video id in that link.' };
}

module.exports = { resolveVideoId, YT_ID };
