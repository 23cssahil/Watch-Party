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

  /**
   * A closed panel is off-screen, not unmounted — on a narrow viewport it is
   * `translateX(100%)`, so its buttons were still in the tab order and could hold
   * focus while `aria-hidden` claimed the whole subtree did not exist. Browsers
   * now block that ("Blocked aria-hidden on an element because its descendant
   * retained focus") and screen readers get a contradiction either way.
   *
   * `inert` is the fix the warning itself names: it takes the subtree out of the
   * tab order and moves focus out if something inside it had focus. React 18 has
   * no type for the attribute, hence the cast — it is passed straight to the DOM.
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
