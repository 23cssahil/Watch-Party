import { FormEvent, useEffect, useRef, useState } from 'react';
import { sendChat } from '../actions';
import { useRoomStore } from '../store/roomStore';
import { colorFor, formatClock, initials } from '../lib/format';
import { RoleBadge } from './ParticipantList';

/**
 * Room chat.
 *
 * Kept in the store (last 120 server-side, last 50 replayed on join) instead of a
 * database. Chat that outlives the party is a different product, and keeping it in
 * memory means there's nothing sensitive to clean up later.
 */
export default function ChatPanel() {
  const chat = useRoomStore((state) => state.chat);
  const meId = useRoomStore((state) => state.me?.userId);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);

  // Newest last, pinned to the bottom - but only if the reader hasn't scrolled up
  // to re-read something. Forcing a jump mid-read is worse than a message appearing
  // just off-screen.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [chat.length]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    sendChat(draft);
    setDraft('');
  };

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scroller}>
        {chat.length === 0 && (
          <p className="chat__empty">
            Nothing said yet. Say hello — everyone in the room sees it at the same time.
          </p>
        )}
        {chat.map((message) => (
          <div
            key={message.id}
            className={`msg ${message.userId === meId ? 'msg--me' : ''}`}
          >
            <span className="msg__avatar" style={{ background: colorFor(message.username) }}>
              {initials(message.username)}
            </span>
            <div className="msg__body">
              <p className="msg__head">
                <strong>{message.userId === meId ? 'You' : message.username}</strong>
                <RoleBadge role={message.role} />
                <em>{formatClock(message.at)}</em>
              </p>
              <p className="msg__text">{message.text}</p>
            </div>
          </div>
        ))}
      </div>

      <form className="chat__form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message the room"
          maxLength={500}
        />
        <button type="submit" className="btn btn--primary btn--tiny" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
