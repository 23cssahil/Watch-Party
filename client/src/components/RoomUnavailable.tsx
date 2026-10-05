import { Link } from 'react-router-dom';
import { socket } from '../socket';
import { useRoomStore } from '../store/roomStore';

interface Props {
  code: string;
  /** The server's own message, so the screen doesn't invent a reason. */
  error: string;
}

/**
 * Shown when the room behind a share link can't be joined.
 *
 * Two cases:
 * 1. Host ended the party - show a "party over" message, no retry.
 * 2. Room not found (server restarted, etc.) - show retry and a short hint.
 */
export default function RoomUnavailable({ code, error }: Props) {
  const hostEnded =
    error.toLowerCase().includes('host ended') ||
    error.toLowerCase().includes('ended the party');

  const retry = () => {
    useRoomStore.getState().setJoinError(null);
    if (!socket.connected) socket.connect();
  };

  const startOver = () => useRoomStore.getState().reset();

  if (hostEnded) {
    return (
      <main className="gate">
        <div className="gate__card">
          <p className="gate__eyebrow">Room {code}</p>
          <h2>The party has ended 🎬</h2>
          <p className="gate__reason">{error}</p>
          <p className="gate__reason">
            The host closed this room. Start your own party below!
          </p>
          <Link className="btn btn--primary" to="/" onClick={startOver}>
            Go home
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="gate">
      <div className="gate__card">
        <p className="gate__eyebrow">Room {code}</p>
        <h2>Room not found</h2>
        <p className="gate__reason">{error}</p>
        <p className="gate__reason">
          Rooms live in memory, so a server that restarted or woke from sleep has
          lost them. On a free tier the first attempt can also take a minute while
          the instance boots — try again before giving up on the link.
        </p>
        <button type="button" className="btn btn--primary" onClick={retry}>
          Try joining again
        </button>
        <Link className="gate__back" to="/" onClick={startOver}>
          Start your own room instead
        </Link>
      </div>
    </main>
  );
}
