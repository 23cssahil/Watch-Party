import { useRoomStore } from '../store/roomStore';

/**
 * Renders the emoji that other people sent, drifting up the screen.
 *
 * The list is capped and each entry self-removes after its animation, so a
 * determined user spamming reactions cannot grow this array without bound — the
 * store keeps at most 24 in flight.
 */
export default function ReactionLayer() {
  const reactions = useRoomStore((state) => state.reactions);
  if (!reactions.length) return null;

  return (
    <div className="floaties" aria-hidden>
      {reactions.map((reaction, index) => (
        <span
          key={reaction.id}
          className="floaty"
          style={{
            left: `${58 + ((index * 7) % 34)}%`,
            animationDelay: `${(index % 5) * 60}ms`,
          }}
          title={reaction.username}
        >
          {reaction.emoji}
        </span>
      ))}
    </div>
  );
}
