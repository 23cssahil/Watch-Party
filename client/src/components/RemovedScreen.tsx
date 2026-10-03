import { Link } from 'react-router-dom';
import { useRoomStore } from '../store/roomStore';

interface Props {
  removed: { by: string; reason: string };
}

/**
 * Shown after the Host ejects this client.
 *
 * A dedicated screen rather than a toast, because the alternative is the room
 * page sitting there with an empty roster — which reads as a bug. It also stops
 * the reconnect handler from quietly putting the person back into the room they
 * were just removed from: `setRemoved` clears `roomId`, so there is nothing left
 * to re-claim.
 */
export default function RemovedScreen({ removed }: Props) {
  const startOver = () => useRoomStore.getState().reset();

  return (
    <main className="gate">
      <div className="gate__card gate__card--removed">
        <h2>You left the party</h2>
        <p>
          <strong>{removed.by}</strong> removed you from the room.
        </p>
        <p className="gate__reason">{removed.reason}</p>
        <Link className="btn btn--primary" to="/" onClick={startOver}>
          Back to start
        </Link>
      </div>
    </main>
  );
}
