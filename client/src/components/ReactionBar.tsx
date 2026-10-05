import { react } from '../actions';
import { REACTION_EMOJIS } from '../types';
import { useRoomStore } from '../store/roomStore';

/**
 * Emoji reactions - the 'key moment' bonus.
 *
 * Reactions aren't stored in the chat log or persisted on purpose: they're
 * transient, high-frequency, and not worth keeping once seen. So we just broadcast
 * them and forget, which also stops a spammable button from growing server memory
 * without bound.
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
