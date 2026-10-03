import { assignRole, removeParticipant, transferHost } from '../actions';
import { useRoomStore } from '../store/roomStore';
import { colorFor, initials } from '../lib/format';
import type { Participant, Role } from '../types';

/**
 * The roster, with the Host's governance controls.
 *
 * Every action here is offered only because the *server* said this viewer may
 * take it (`capabilities.allowedActions` includes `assign_role`), and each one
 * is still re-checked on arrival. The buttons are a convenience, not a defence.
 *
 * Note what a demoted Host sees: the moment `role_assigned` arrives for them,
 * the capability list in their own store is replaced by the server's new answer
 * and these controls disappear from their screen without any local logic
 * deciding to hide them.
 */
export default function ParticipantList() {
  const participants = useRoomStore((state) => state.participants);
  const me = useRoomStore((state) => state.me);
  const requests = useRoomStore((state) => state.requests);

  const isHost = me?.role === 'host';
  const canGovern = Boolean(me?.capabilities.allowedActions.includes('assign_role'));

  const pendingByUser = new Map<string, number>();
  for (const request of requests) {
    pendingByUser.set(request.userId, (pendingByUser.get(request.userId) ?? 0) + 1);
  }

  return (
    <div className="people">
      <div className="people__header">
        <span className="people__count-pill">{participants.length}</span>
        <h3 className="people__heading">In the room</h3>
      </div>

      <ul className="people__list">
        {participants.map((person) => (
          <ParticipantRow
            key={person.userId}
            person={person}
            isMe={person.userId === me?.userId}
            canGovern={canGovern}
            isHost={isHost}
            waiting={pendingByUser.get(person.userId) ?? 0}
          />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  person: Participant;
  isMe: boolean;
  isHost: boolean;
  canGovern: boolean;
  waiting: number;
}

function ParticipantRow({ person, isMe, isHost, canGovern, waiting }: RowProps) {
  const governable = canGovern && !isMe && person.role !== 'host';

  return (
    <li className={`person ${isMe ? 'person--me' : ''}`}>
      <span
        className="person__avatar"
        style={{ background: colorFor(person.username) }}
      >
        {initials(person.username)}
        {isMe && <span className="person__avatar-ring" />}
      </span>

      <div className="person__body">
        <p className="person__name">
          {person.username}
          {isMe && <em>you</em>}
        </p>
        <div className="person__meta">
          <RoleBadge role={person.role} />
          {waiting > 0 && (
            <span className="person__waiting">
              <span className="person__waiting-dot" />
              {waiting} pending
            </span>
          )}
        </div>
      </div>

      {governable && (
        <div className="person__tools">
          {person.role === 'moderator' ? (
            <ToolButton label="Demote" onClick={() => assignRole(person.userId, 'participant')} />
          ) : (
            <ToolButton label="Make mod" onClick={() => assignRole(person.userId, 'moderator')} />
          )}
          {isHost && <ToolButton label="Hand over" onClick={() => transferHost(person.userId)} />}
          <ToolButton label="Remove" danger onClick={() => removeParticipant(person.userId)} />
        </div>
      )}
    </li>
  );
}

function ToolButton({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tool ${danger ? 'tool--danger' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  const label = role === 'host' ? '👑 Host' : role === 'moderator' ? '🛡 Mod' : 'Viewer';
  return <span className={`badge badge--${role}`}>{label}</span>;
}
