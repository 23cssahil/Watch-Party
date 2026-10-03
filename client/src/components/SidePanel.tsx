import { useState } from 'react';
import { useRoomStore } from '../store/roomStore';
import ParticipantList from './ParticipantList';
import RequestQueue from './RequestQueue';
import ChatPanel from './ChatPanel';
import ShareCard from './ShareCard';

type Tab = 'people' | 'requests' | 'chat';

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
 */
export default function SidePanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('people');
  const canApprove = useRoomStore((state) => Boolean(state.me?.capabilities.canApprove));
  const requestCount = useRoomStore((state) => state.requests.length);
  const chatCount = useRoomStore((state) => state.chat.length);

  const tabs: { id: Tab; label: string; badge?: number; hidden?: boolean }[] = [
    { id: 'people', label: 'People' },
    { id: 'requests', label: 'Requests', badge: requestCount, hidden: !canApprove },
    { id: 'chat', label: 'Chat', badge: 0 },
  ];

  return (
    <aside className={`panel ${open ? 'panel--open' : ''}`} aria-hidden={!open}>
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
                {entry.id === 'chat' && chatCount > 0 && <span className="panel__muted">{chatCount}</span>}
                {entry.badge ? <span className="panel__badge">{entry.badge}</span> : null}
              </button>
            ))}
        </div>
        <button type="button" className="panel__close" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>

      <div className="panel__body">
        {tab === 'people' && (
          <>
            <ShareCard />
            <ParticipantList />
          </>
        )}
        {tab === 'requests' && <RequestQueue />}
        {tab === 'chat' && <ChatPanel />}
      </div>
    </aside>
  );
}
