/** Display helpers kept out of the components so they stay presentational. */

/** 83 -> "1:23", 3725 -> "1:02:05" */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

/** 14:07 — a wall-clock stamp for chat lines. */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "just now" / "2m ago" — used in the chat and request list. */
export function formatAgo(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Countdown until a pending request expires. */
export function formatCountdown(expiresAt: number): string {
  const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return `${remaining}s`;
}

/**
 * Accepts anything a user pastes and returns a bare 11-character id, or null.
 * Mirrors `server/src/utils/youtube.js` — the client does this purely for fast
 * feedback, the server re-validates and is the one that decides.
 */
export function extractVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;

  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (!host.endsWith('youtube.com')) return null;

    const param = url.searchParams.get('v');
    if (param && /^[A-Za-z0-9_-]{11}$/.test(param)) return param;

    const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Deterministic accent colour per participant, so a name always looks the same. */
export function colorFor(name: string): string {
  const palette = ['#ff4757', '#ffa502', '#2ed573', '#1e90ff', '#a55eea', '#ff6b81', '#7ed6df'];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

export function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || '?';
}
