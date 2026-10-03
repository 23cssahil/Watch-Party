import { useState } from 'react';
import { useRoomStore } from '../store/roomStore';
import ParticipantList from './ParticipantList';
import RequestQueue from './RequestQueue';
import ChatPanel from './ChatPanel';
import ShareCard from './ShareCard';

type Tab = 'people' | 'share' | 'requests' | 'chat';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Right-hand rail. On a narrow viewport it becomes a slide-over, because a
 * watch party is a video first and a sidebar second.
 *
 * The Requests tab is only shown to people the server marked as approvers —
 * note that this is a *rendering* decision taken from the server's own
 * `capabilities.canApprove`, not a client-side guess about roles.
 *
 * Tabs:
 * - People: scrollable, paginated user list (in-room)
 * - Share: invite link + room code
 * - Requests: host/mod only approval queue
 * - Chat: group chat
 */
export default function SidePanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('people');
  const canApprove = useRoomStore((state) => Boolean(state.me?.capabilities.canApprove));
  const requestCount = useRoomStore((state) => state.requests.length);
  const participants = useRoomStore((state) => state.participants);

  const tabs: { id: Tab; label: string; badge?: number; hidden?: boolean }[] = [
    { id: 'people', label: `People`, badge: participants.length },
    { id: 'share', label: 'Share' },
    { id: 'requests', label: 'Requests', badge: requestCount, hidden: !canApprove },
    { id: 'chat', label: 'Chat' },
  ];

  /**
   * `inert` is the fix for aria-hidden focus trapping issues on closed panels.
   * React 18 has no type for the attribute, hence the cast.
   */
  const inertWhenClosed = open ? {} : ({ inert: '' } as Record<string, string>);

  return (
    <aside className={`panel ${open ? 'panel--open' : ''}`} aria-hidden={!open} {...inertWhenClosed}>
      <div className="panel__head">
        <div className="panel__tabs" role="tablist">
          {tabs
            .filter((entry) => !entry.hidden)
            .map((entry) => (
              <button
                key={entry.id}
                role="tab"
                type="button"
                aria-selected={tab === entry.id}
                className={`panel__tab ${tab === entry.id ? 'panel__tab--on' : ''}`}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
                {entry.badge != null && entry.badge > 0 && (
                  <span className="panel__badge">{entry.badge}</span>
                )}
              </button>
            ))}
        </div>
        <button type="button" className="panel__close" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>

      <div className="panel__body">
        {tab === 'people' && <ParticipantList />}
        {tab === 'share' && <ShareCard />}
        {tab === 'requests' && <RequestQueue />}
        {tab === 'chat' && <ChatPanel />}
      </div>
    </aside>
  );
}
