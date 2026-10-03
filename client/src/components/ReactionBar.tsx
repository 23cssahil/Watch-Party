import { react } from '../actions';
import { REACTION_EMOJIS } from '../types';
import { useRoomStore } from '../store/roomStore';

/**
 * Emoji reactions — the "key moment" bonus.
 *
 * Reactions are deliberately *not* stored in the room's chat log or persisted:
 * they are transient, high-frequency, and worthless once they have been seen.
 * Broadcasting and forgetting is the right durability choice here, and it keeps
 * a spammable control from growing unbounded server memory.
 */
export default function ReactionBar() {
  const muted = useRoomStore((state) => state.status !== 'connected');

  return (
    <div className="reactions" role="group" aria-label="Send a reaction">
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="reactions__btn"
          disabled={muted}
          onClick={() => react(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
