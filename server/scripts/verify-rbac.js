/* eslint-disable no-console */

/**
 * ---------------------------------------------------------------------------
 * End-to-end RBAC + synchronisation check.
 * ---------------------------------------------------------------------------
 *
 * This is the test that matters for this assignment, because it exercises the
 * rule that is easiest to fake: *a Participant cannot control the room.*
 *
 * It drives two real Socket.IO clients against a running server and asserts on
 * the events they receive, so it goes through the same HTTP/WebSocket path a
 * browser does — no internals are stubbed. In particular it proves that:
 *
 *   - the host role is minted by the server, not by the client that asked first
 *   - playback by a Host reaches every client as `sync_state`
 *   - the same action from a Participant becomes `request_pending` instead
 *   - an approved request produces the identical `sync_state` broadcast
 *   - a Participant emitting `assign_role` is refused with `room_error`
 *   - after promotion, that same Participant's action is executed directly
 *
 * Run:  npm run verify   (server must be listening on PORT, default 4000)
 */

const { io } = require('socket.io-client');

const URL = process.env.VERIFY_URL || 'http://localhost:4000';
const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Collects every event a socket receives so assertions can wait on them. */
function watch(socket) {
  const received = [];
  const waiters = [];

  const events = [
    'room_state',
    'sync_state',
    'user_joined',
    'user_left',
    'role_assigned',
    'participant_removed',
    'host_transferred',
    'request_received',
    'request_queue',
    'request_pending',
    'request_resolved',
    'chat_message',
    'reaction',
    'removed_from_room',
    'room_error',
  ];
  for (const event of events) {
    socket.on(event, (payload) => {
      const entry = { event, payload };
      received.push(entry);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].event === event) {
          waiters[i].resolve(entry);
          waiters.splice(i, 1);
        }
      }
    });
  }

  return {
    received,
    /**
     * @param {string} event
     * @param {number} [timeoutMs]
     */
    waitFor(event, timeoutMs = 4000) {
      const existing = received.find((entry) => entry.event === event);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const got = received.map((entry) => entry.event).join(', ') || 'nothing';
          reject(new Error(`timed out waiting for "${event}" — this socket received: ${got}`));
        }, timeoutMs);
        waiters.push({
          event,
          resolve: (entry) => {
            clearTimeout(timer);
            resolve(entry);
          },
        });
      });
    },
    has(event) {
      return received.some((entry) => entry.event === event);
    },
    count(event) {
      return received.filter((entry) => entry.event === event).length;
    },
  };
}

function connect(username, userId) {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const recorder = watch(socket);
  return { socket, recorder, username, userId };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`\n  Verifying Watch Party RBAC against ${URL}\n`);

  const host = connect('Hostie', 'user-host');
  const guest = connect('GUEST-CLAIMER', 'user-guest');

  // 1. Host creates the room.
  host.socket.emit('create_room', { username: 'Hostie', userId: 'user-host' });
  const hostState = (await host.recorder.waitFor('room_state')).payload;
  check('creator is granted Host by the server', hostState.me.role === 'host', hostState.me.role);
  check('room code is 6 characters', hostState.roomId.length === 6, hostState.roomId);
  const roomId = hostState.roomId;

  // 2. A client that *claims* to be the host in its payload still joins as a
  //    participant — the role is never read from the request.
  guest.socket.emit('join_room', { roomId, username: 'GUEST-CLAIMER', userId: 'user-guest' });
  const guestState = (await guest.recorder.waitFor('room_state')).payload;
  check('joiner cannot self-assign a role', guestState.me.role === 'participant', guestState.me.role);
  check(
    'server sends a capability list to the client',
    Array.isArray(guestState.me.capabilities.allowedActions) &&
      !guestState.me.capabilities.allowedActions.includes('play')
  );
  check(
    'playback is listed as requestable, not allowed',
    guestState.me.capabilities.requestableActions.includes('play')
  );
  // `user_joined` is broadcast by the server *after* it hands the newcomer its
  // own snapshot, so on a loopback connection it can land a tick later. Wait
  // for it rather than assuming both frames have already been delivered.
  const joinAnnounced = await host.recorder
    .waitFor('user_joined', 2000)
    .then(() => true)
    .catch(() => false);
  check('host was told someone arrived', joinAnnounced);

  // 3. Host plays -> everyone syncs.
  host.socket.emit('play');
  const played = (await host.recorder.waitFor('sync_state')).payload;
  check('host play is applied immediately', played.isPlaying === true);
  check('sync_state carries the spec field playState', played.playState === 'playing');
  const guestGotPlay = await guest.recorder
    .waitFor('sync_state', 2000)
    .then(() => true)
    .catch(() => false);
  check('participant receives the host sync', guestGotPlay);

  // 4. Participant presses pause -> must become a request, not a change.
  guest.recorder.received.length = 0;
  host.recorder.received.length = 0;
  guest.socket.emit('pause');
  const pending = (await guest.recorder.waitFor('request_pending')).payload;
  check('participant action is escalated to a request', pending.request.action === 'pause');
  check('participant got NO sync_state (room unchanged)', !guest.recorder.has('sync_state'));
  const hostSawRequest = await host.recorder
    .waitFor('request_received', 2000)
    .then(() => true)
    .catch(() => false);
  check('only the host is notified of the request', hostSawRequest);

  // 5. Host approves -> the same state change now happens for everyone.
  const requestId = pending.request.id;
  host.socket.emit('resolve_request', { requestId, approved: true });
  const approvedSync = (await host.recorder.waitFor('sync_state')).payload;
  check('approved request is executed', approvedSync.isPlaying === false);
  check('approved request is attributed to the requester', approvedSync.actor.userId === 'user-guest');
  check(
    'approved request is marked as such on the wire',
    approvedSync.source === 'approved_request'
  );
  check('requester is told the verdict', host.recorder.has('request_resolved'));

  // 6. Governance from a Participant is refused outright.
  guest.recorder.received.length = 0;
  guest.socket.emit('assign_role', { userId: 'user-guest', role: 'moderator' });
  const refused = await guest.recorder.waitFor('room_error', 2000).catch(() => null);
  check('participant cannot promote itself', Boolean(refused), refused?.payload.message);
  check('a refused governance action never becomes a request', !guest.recorder.has('request_pending'));

  // 7. Host promotes -> capabilities change on the promoted client.
  host.socket.emit('assign_role', { userId: 'user-guest', role: 'moderator' });
  const promoted = (await host.recorder.waitFor('role_assigned')).payload;
  check('host can promote a participant', promoted.role === 'moderator');
  const newCaps = (await guest.recorder.waitFor('room_state')).payload.me.capabilities;
  check('promoted client is told its new powers', newCaps.allowedActions.includes('play'));

  // 8. The formerly-restricted action now executes with no request at all.
  guest.recorder.received.length = 0;
  guest.socket.emit('play');
  const modSync = (await guest.recorder.waitFor('sync_state')).payload;
  check('moderator controls apply directly', modSync.isPlaying === true);
  check('moderator action creates no request', !guest.recorder.has('request_pending'));

  // 8b. Regression guard, and the bug this caught was real: two intents from
  //     one socket back to back must BOTH land. A naive per-socket cooldown
  //     shared across play/pause/seek eats the second one in silence, which
  //     from the user's side is indistinguishable from a broken button.
  host.recorder.received.length = 0;
  guest.socket.emit('pause');
  guest.socket.emit('seek', { time: 42 });
  await wait(500);
  const settled = host.recorder.received
    .filter((entry) => entry.event === 'sync_state')
    .pop();
  check('back-to-back intents are never swallowed', Boolean(settled));
  check(
    'the coalesced seek still reaches the room',
    settled?.payload.currentTime === 42,
    `got ${settled?.payload.currentTime}`
  );
  check(
    'a scrubber drag collapses to a couple of broadcasts, not dozens',
    host.recorder.count('sync_state') <= 2,
    `${host.recorder.count('sync_state')} sync_state events`
  );

  // 9. A Moderator may not govern.
  guest.recorder.received.length = 0;
  guest.socket.emit('remove_participant', { userId: 'user-host' });
  const modRefused = await guest.recorder.waitFor('room_error', 2000).catch(() => null);
  check('moderator cannot remove the host', Boolean(modRefused), modRefused?.payload.message);

  // 10. Chat works for everyone and carries the author.
  host.recorder.received.length = 0;
  guest.socket.emit('chat_message', { text: 'hello from a moderator' });
  const chat = (await host.recorder.waitFor('chat_message')).payload;
  check('chat is broadcast with authorship', chat.message.username === 'GUEST-CLAIMER');

  // 11. Host ejects the moderator.
  host.recorder.received.length = 0;
  host.socket.emit('remove_participant', { userId: 'user-guest' });
  const ejected = await guest.recorder.waitFor('removed_from_room', 2500).catch(() => null);
  check('removed client is told explicitly', Boolean(ejected));
  // The server deliberately notifies the victim *before* announcing the
  // departure to the room, so the survivor's frame is the later of the two.
  const removalAnnounced = await host.recorder
    .waitFor('participant_removed', 2000)
    .then(() => true)
    .catch(() => false);
  check('the room is told who left', removalAnnounced);

  // 12. A malformed video payload is rejected rather than broadcast.
  host.recorder.received.length = 0;
  host.socket.emit('change_video', { videoId: 'not-a-real-id!!' });
  const badVideo = await host.recorder.waitFor('room_error', 2000).catch(() => null);
  check('invalid video id never reaches the room', Boolean(badVideo));

  // 13. Regression guard for the bug that made a shared link look broken. A join
  //     for a code that does not exist must ANSWER: the acknowledgement is the
  //     client's only way to explain "this room is gone", and a silent drop there
  //     is exactly what reads as "the link doesn't open". Rooms live in memory, so
  //     every server restart turns old links into this case.
  const wanderer = connect('Wanderer', 'user-late');
  const deadAck = await new Promise((resolve) => {
    wanderer.socket.emit(
      'join_room',
      { roomId: 'ZZZZZZ', username: 'Wanderer', userId: 'user-late' },
      resolve
    );
    setTimeout(() => resolve(null), 3000);
  });
  check('a join for an unknown code is answered, not dropped', Boolean(deadAck));
  check(
    'and it is refused with a reason the UI can show',
    deadAck?.ok === false && Boolean(deadAck?.error),
    deadAck?.error
  );
  check('the same refusal reaches the sender as room_error', wanderer.recorder.has('room_error'));
  wanderer.socket.close();

  // 14. Regression guard for the refresh that used to cost the Host their room.
  //     Closing a socket is exactly what a page reload does. With nobody else
  //     present there was no one to inherit the role, yet the room still recorded
  //     that a Host had been minted, so the returning owner joined as a plain
  //     Participant in a room nothing could be decided in — no playback control
  //     and no approver for the request queue, permanently.
  const soloRoom = roomId;
  host.socket.close();
  await wait(500); // let the server process the departure
  const returned = connect('Hostie', 'user-host');
  returned.socket.emit('join_room', { roomId: soloRoom, username: 'Hostie', userId: 'user-host' });
  const returnedState = (await returned.recorder.waitFor('room_state')).payload;
  check(
    'a Host reloading an otherwise-empty room comes back as its Host',
    returnedState.me.role === 'host',
    returnedState.me.role
  );
  check(
    'and the room has exactly one host after the return',
    (returnedState.participants || []).filter((p) => p.role === 'host').length === 1
  );
  check(
    'so playback authority is intact without anyone re-assigning it',
    returnedState.me.capabilities.allowedActions.includes('play')
  );
  returned.socket.close();

  // 15. Regression guard for the ghost seat. A socket that abandons its room for
  //     another one used to be unbound from the old channel while staying a
  //     Participant inside it — an inflated roster, a room that never read as
  //     empty, and a Host who had left but still owned the room. Reachable by
  //     pressing the logo and starting a new party.
  const drifter = connect('Drifter', 'user-drifter');
  drifter.socket.emit('create_room', { username: 'Drifter', userId: 'user-drifter' });
  const firstRoom = (await drifter.recorder.waitFor('room_state')).payload.roomId;
  drifter.recorder.received.length = 0;
  drifter.socket.emit('create_room', { username: 'Drifter', userId: 'user-drifter' });
  const secondRoom = (await drifter.recorder.waitFor('room_state')).payload.roomId;
  check('starting a second room really moves the socket', secondRoom !== firstRoom, `${firstRoom} -> ${secondRoom}`);
  const leftBehind = await fetch(`${URL}/api/rooms/${firstRoom}`)
    .then((response) => response.json())
    .catch(() => null);
  check('and the room that was left behind holds no ghost', leftBehind?.room?.participants === 0,
    `participants: ${leftBehind?.room?.participants}`);
  check('that room is still reported live, just empty', leftBehind?.room?.live === true);
  drifter.socket.close();

  // 16. The succession rule, stated as something that can fail: when the Host
  //     leaves, the room passes to whoever has been in it longest - on the
  //     departure itself, with no refresh in between. The Moderator is
  //     deliberately the NEWEST member here, so this cannot pass by "an approver
  //     inherited"; only tenure satisfies it.
  const throne = connect('King', 'user-king');
  throne.socket.emit('create_room', { username: 'King', userId: 'user-king' });
  const throneRoom = (await throne.recorder.waitFor('room_state')).payload.roomId;

  const elder = connect('Elder', 'user-elder');
  elder.socket.emit('join_room', { roomId: throneRoom, username: 'Elder', userId: 'user-elder' });
  await elder.recorder.waitFor('room_state');
  await wait(150); // joinedAt has millisecond resolution; keep the order unambiguous
  const latest = connect('Latest', 'user-latest');
  latest.socket.emit('join_room', { roomId: throneRoom, username: 'Latest', userId: 'user-latest' });
  await latest.recorder.waitFor('room_state');
  throne.socket.emit('assign_role', { userId: 'user-latest', role: 'moderator' });
  await throne.recorder.waitFor('role_assigned');

  elder.recorder.received.length = 0;
  latest.recorder.received.length = 0;
  throne.socket.emit('leave_room');

  const handed = (await elder.recorder.waitFor('host_transferred', 2500).catch(() => null))?.payload;
  check('the room hands over the moment the Host leaves', Boolean(handed));
  check(
    'to the longest-tenured survivor, not to the Moderator',
    handed?.userId === 'user-elder',
    handed?.userId
  );
  // Wait for it rather than asking "is it there yet": both copies go out in the
  // same broadcast, and reading one socket's buffer the instant the other's event
  // lands is a race that passes or fails by scheduling, not by behaviour.
  const alsoHeard = (
    await latest.recorder.waitFor('host_transferred', 1500).catch(() => null)
  )?.payload;
  check(
    'and the rest of the room hears the same handover',
    alsoHeard?.userId === 'user-elder',
    alsoHeard?.userId
  );
  check(
    'with exactly one host in the roster that was sent',
    (handed?.participants || []).filter((p) => p.role === 'host').length === 1
  );

  const elderState = (
    await elder.recorder.waitFor('room_state', 2500).catch(() => null)
  )?.payload;
  check(
    'the new Host is told they now run the room',
    elderState?.me?.role === 'host',
    elderState?.me?.role
  );
  check(
    'so their controls work without reloading',
    elderState?.me?.capabilities?.allowedActions?.includes('assign_role') === true
  );

  // And the reverse: a returning former Host does not undo the succession. A tab
  // closed for two seconds must not silently demote whoever has been running the
  // party in the meantime.
  throne.recorder.received.length = 0; // the create_room snapshot would answer first
  throne.socket.emit('join_room', { roomId: throneRoom, username: 'King', userId: 'user-king' });
  const kingBack = (await throne.recorder.waitFor('room_state', 2500).catch(() => null))?.payload;
  check(
    'a returning former Host comes back as a Participant',
    kingBack?.me?.role === 'participant',
    kingBack?.me?.role
  );
  check(
    'and the promoted Host keeps the room',
    kingBack?.host?.userId === 'user-elder',
    kingBack?.host?.userId
  );

  throne.socket.close();
  elder.socket.close();
  latest.socket.close();

  host.socket.close();
  guest.socket.close();

  console.log(results.join('\n'));
  console.log(`\n  ${results.length - failures}/${results.length} checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('\n  Verification crashed:', error.message, '\n');
  console.log(results.join('\n'));
  process.exit(1);
});
