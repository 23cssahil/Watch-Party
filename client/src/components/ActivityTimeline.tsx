import { useEffect, useState } from 'react';
import { useRoomStore } from '../store/roomStore';
import { formatAgo } from '../lib/format';
import type { ActivityKind } from '../store/roomStore';

/**
 * The room's live story.
 *
 * This is the "activity timeline" signature feature: every join, leave, role
 * change, playback move and chat line that already produced a transient toast is
 * *also* folded into a durable (in-memory, capped) feed, so a viewer glancing at
 * the rail can read the room's recent history rather than only whatever bubble is
 * on screen right now.
 *
 * Presentational only — the store owns the list, this renders it. Newest first,
 * matching the store's prepend order, so the most recent moment sits at the top
 * without any scroll juggling.
 */
const ICON: Record<ActivityKind, string> = {
  join: '➕',
  leave: '➖',
  role: '👑',
  playback: '▶',
  chat: '💬',
  system: '⚡',
};

export default function ActivityTimeline() {
  const activity = useRoomStore((state) => state.activity);
  // A 15s tick keeps "2m ago" honest without re-rendering on every store change;
  // the feed is low-churn, so this is the only timer the tab needs.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, []);

  if (!activity.length) {
    return (
      <div className="activity activity--empty">
        <p>Nothing has happened yet.</p>
        <span>Joins, playback moves and chat will collect here as the party unfolds.</span>
      </div>
    );
  }

  return (
    <div className="activity">
      <ol className="activity__list">
        {activity.map((entry) => (
          <li key={entry.id} className={`act act--${entry.tone}`}>
            <span className="act__rail">
              <span className="act__dot" />
            </span>
            <span className="act__icon" aria-hidden>
              {ICON[entry.kind]}
            </span>
            <div className="act__body">
              <p className="act__text">{entry.text}</p>
              <em className="act__time">{formatAgo(entry.at)}</em>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
