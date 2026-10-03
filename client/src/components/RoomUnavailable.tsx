import { Link } from 'react-router-dom';
import { socket } from '../socket';
import { useRoomStore } from '../store/roomStore';

interface Props {
  code: string;
  /** The server's own words, so the screen never invents a reason. */
  error: string;
}

/**
 * Shown when the room behind a share link refused to be joined.
 *
 * This screen exists because of a specific failure that is otherwise invisible.
 * A room lives in the server's memory; a free instance that sleeps, restarts or
 * redeploys comes back with *no* rooms at all. So a link shared twenty minutes
 * ago is genuinely dead — and before this existed, the page handled that by
 * showing a black stage and a toast that vanished in four seconds. From the
 * other side it looked exactly like a broken app: "the link doesn't open".
 *
 * The retry does two things, and both are needed: it clears the recorded
 * refusal, which re-runs the join effect on the Room page, and it nudges
 * Socket.IO back into connecting, in case what actually failed was reaching the
 * server rather than the room itself.
 */
export default function RoomUnavailable({ code, error }: Props) {
  const retry = () => {
    useRoomStore.getState().setJoinError(null);
    if (!socket.connected) socket.connect();
  };

  const startOver = () => useRoomStore.getState().reset();

  return (
    <main className="gate">
      <div className="gate__card">
        <p className="gate__eyebrow">Room {code}</p>
        <h2>This link has no room behind it</h2>
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
