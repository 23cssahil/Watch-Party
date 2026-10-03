import { useEffect, useState } from 'react';
import { approveRequest, rejectRequest } from '../actions';
import { useRoomStore } from '../store/roomStore';
import { formatCountdown, formatTime } from '../lib/format';
import { REQUEST_LABELS } from '../types';
import type { ApprovalRequest } from '../types';

/**
 * The approval inbox — the visible half of the "participant must request
 * approval" requirement.
 *
 * Two details worth defending:
 *
 * - The queue is delivered **only to Host and Moderators** by the server
 *   (`broadcastToApprovers`). A participant's socket never learns what anybody
 *   else proposed.
 * - The countdown is real, not decorative. Requests expire after 60 s on the
 *   server, so a proposal made five minutes ago can never be approved into
 *   action — otherwise a Host returning to an idle tab could suddenly yank a
 *   room that had moved on.
 */
export default function RequestQueue() {
  const requests = useRoomStore((state) => state.requests);
  const [, forceTick] = useState(0);

  // Re-render once a second purely so the expiry countdown stays honest.
  useEffect(() => {
    if (!requests.length) return;
    const timer = window.setInterval(() => forceTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [requests.length]);

  if (!requests.length) {
    return (
      <div className="queue queue--empty">
        <p>No requests waiting.</p>
        <span>
          When a viewer presses a control, it lands here for you to approve or
          dismiss instead of changing the room.
        </span>
      </div>
    );
  }

  return (
    <div className="queue">
      <h3 className="panel__title">
        Needs your approval <span>{requests.length}</span>
      </h3>
      <ul className="queue__list">
        {requests.map((request) => (
          <RequestCard key={request.id} request={request} />
        ))}
      </ul>
    </div>
  );
}

function RequestCard({ request }: { request: ApprovalRequest }) {
  const approve = useRoomStore((state) => state.pushToast);

  return (
    <li className="req">
      <div className="req__head">
        <strong>{request.username}</strong>
        <span className="req__timer">{formatCountdown(request.expiresAt)}</span>
      </div>

      <p className="req__what">
        wants to <em>{REQUEST_LABELS[request.action]}</em>
        {request.action === 'seek' && typeof request.payload.time === 'number' && (
          <span className="req__detail"> → {formatTime(request.payload.time)}</span>
        )}
        {request.action === 'change_video' && request.payload.videoId && (
          <span className="req__detail"> → {request.payload.videoId}</span>
        )}
      </p>

      {request.note && <p className="req__note">“{request.note}”</p>}

      {request.action === 'change_video' && request.payload.videoId && (
        <img
          className="req__thumb"
          src={`https://i.ytimg.com/vi/${request.payload.videoId}/mqdefault.jpg`}
          alt=""
        />
      )}

      <div className="req__buttons">
        <button
          type="button"
          className="btn btn--primary btn--tiny"
          onClick={() => approveRequest(request.id)}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--tiny"
          onClick={() => {
            rejectRequest(request.id);
            approve('Request dismissed — nothing changed for the room.', 'info');
          }}
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}
