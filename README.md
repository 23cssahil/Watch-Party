# 🍿 YouTube Watch Party

A multi-user watch party where the video in every browser stays in step, governed by
server-side roles and an approval queue.

| | |
| --- | --- |
| **Live app** | _see "Deployment" below_ |
| **Backend** | Node.js · Express · Socket.IO |
| **Frontend** | React 18 · TypeScript · Vite · zustand |
| **Database** | MongoDB (optional — the server runs fully in memory without it) |
| **Assignment** | Intern Assignment: YouTube Watch Party System |

---

## 1. What it does

One person creates a room, gets a 6-character code, and shares it. Everyone who joins
sees the same YouTube video at the same position, within about a second.

The interesting part is *who is allowed to change what*. Roles are assigned and enforced
**on the server**. Hiding a button is not a permission model — a client can always emit
whatever event it likes — so every inbound playback event passes through one gate, and
the client is separately told which actions it may take so the UI can match.

A Participant who presses play does **not** get an error. Their intent becomes a
*proposal*, delivered only to the Host and Moderators, who approve or dismiss it. On
approval the change executes and is attributed to the original requester.

### Requirements checklist

| Brief requirement | Where it lives |
| --- | --- |
| Real-time play/pause/seek/current-video sync | `server/src/ws/Room.js` → `sync_state` → `client/src/hooks/useYouTubeSync.ts` |
| Room creation with unique code | `server/src/utils/roomCode.js`, `RoomManager.create()` |
| Join by code **or** link | `client/src/App.tsx` route `/r/:code` + `ShareCard` |
| YouTube IFrame Player API | `client/src/hooks/useYouTubeSync.ts` |
| WebSocket (Socket.IO) | `server/src/ws/handlers.js`, `client/src/socket.ts` |
| Host / Moderator / Participant roles | `server/src/ws/permissions.js` |
| **Backend validates permissions before processing** | `MessageHandler.handleAction()` → `applyIntent()` |
| Host assigns roles | `assign_role` |
| Host removes participants | `remove_participant` |
| Host transfers control | `transfer_host` (+ automatic on host disconnect) |
| Broadcast role updates so the UI can disable controls | `capabilities` on every participant |
| **Participant must request approval for changes** | `needsApproval()` → request queue |
| Chat | `chat_message` |
| Emoji reactions | `reaction` |
| Persistent rooms | `server/src/models/Room.js` (Mongoose) + in-memory fallback |
| OOP design (`Room`, `Participant`, `MessageHandler`) | `server/src/ws/` |

---

## 2. Quick start

Requires Node 18+.

```bash
# 1. backend
cd server
npm install
cp .env.example .env      # every value has a working default
npm start                 # -> http://localhost:4000

# 2. frontend (new terminal)
cd client
npm install
cp .env.example .env
npm run dev               # -> http://localhost:5173
```

Open two browsers (one can be a private window, so they get separate identities), create
a room in the first, join with the code in the second, and press play.

### Verifying it

```bash
cd server
npm run verify
```

This drives **two real Socket.IO clients** against a running server and asserts on the
events they receive — 30 checks, going through the same wire path a browser uses. It
covers the adversarial cases rather than the happy path:

- a client that *claims* `role: 'host'` in its join payload still joins as a participant
- a Participant's `pause` produces `request_pending` and **no** `sync_state`
- a Participant's `assign_role` is refused and does **not** silently degrade into a request
- an approved request is byte-identical downstream to a Host's own action
- after promotion, that same Participant's `play` executes directly with no request

Expected tail: `30/30 checks passed`.

---

## 3. Deployment

The two halves deploy separately, because only the backend needs a persistent process.

| Piece | Host | Free tier | Notes |
| --- | --- | --- | --- |
| Express + Socket.IO | Render | yes | needs WebSocket support → use a **Web Service**, not a background worker |
| React static build | Vercel / Netlify | yes | `npm run build` → `dist/` |
| MongoDB Atlas | Atlas | yes (M0) | **optional**; omit it and rooms live in memory |

> **Live URL:** _add the Render/Vercel URLs here once deployed._
> Remember to add the deployed frontend origin to `CLIENT_ORIGIN` on the backend, or
> Socket.IO's CORS will reject the connection with an error that looks like a network bug.

If the database is left unconfigured the app still works completely; rooms are lost on a
server restart. That is a deliberate trade-off, discussed in §7.

---

## 4. Architecture

```
Browser A (Host)          Browser B (Participant)       Browser C (Moderator)
      │                            │                             │
      │  play / pause / seek       │  pause  ──► request         │  play (approved)
      ▼                            ▼                             ▼
┌──────────────────────────── Socket.IO ──────────────────────────────┐
│  MessageHandler          one auditable gate per inbound event       │
│    ├─ permissions.js     can() / needsApproval()  ← pure, no I/O    │
│    ├─ RoomManager        code → Room, lifecycle, expiry sweeps       │
│    └─ Room               authoritative state + the only mutation     │
│                          funnel (`applyPlayback`)                    │
└───────────────┬──────────────────────────────────────────────────────┘
                │  optional, debounced
                ▼
         MongoDB Atlas      room document + participants
                            (no-op when MONGODB_URI is unset)
```

**The core rule: the Room owns the truth, clients own the rendering.**

Clients never send state, they send *intents* — "I pressed play". The Room folds the
intent into canonical state and broadcasts the resulting snapshot back to everyone,
**including the sender**. That last part matters: the sender's optimistic guess gets
corrected rather than trusted, so two people clicking at once converge instead of each
browser privately deciding what the room looks like.

Because clients disagree by design (a mobile browser 400 ms behind, a paused background
tab), a plain message relay would let every client reconstruct a different history and
the room would desync permanently.

---

## 5. Permission model

`server/src/ws/permissions.js` is the single source of truth. It is pure — no sockets, no
database, no clock — which is why it can be reasoned about and unit-tested in isolation.

| Action | Host | Moderator | Participant |
| --- | :---: | :---: | :---: |
| `play` / `pause` / `seek` / `change_video` | ✅ | ✅ | 🟡 must request |
| `chat` / `react` / `sync_request` | ✅ | ✅ | ✅ |
| `assign_role` | ✅ | ❌ | ❌ |
| `remove_participant` | ✅ | ❌ | ❌ |
| `transfer_host` | ✅ | ❌ | ❌ |
| approve / dismiss requests | ✅ | ✅ | ❌ |

✅ executes · ❌ refused with a reason · 🟡 converted into an approval request

Three rules, and the ordering is the whole design:

```js
if (can(role, action))            → mutate + broadcast sync_state
else if (needsApproval(...))      → queue a request, notify approvers only
else                              → refuse, and tell the sender why
```

**Every branch answers the sender.** There is no fourth, silent branch — a control a user
can see never disappears without either taking effect or explaining why it did not. (An
earlier revision had a per-socket cooldown shared across playback events that quietly ate
a second click within 120 ms. On a localhost connection the integration test hit exactly
that and reported a hang. Rate limiting a *visible* control into silence is a bug, not a
feature; see §8.)

### Aliases and the "Viewer" role

The brief names Host / Moderator / Participant and also refers to a "Viewer". `Viewer` is
treated as an **alias for Participant**, not a fourth tier — the permission matrix would be
identical, and a duplicate role that behaves exactly like another one is a future
off-by-one in a `switch`. `admin` likewise aliases to `host`, since the brief uses both
words for the same person.

### Who is the Host, and what happens when they leave

- The role is minted by the server, in `Room.addParticipant`, and only for the first
  person into an empty room. It is never read from a client payload.
- Identity is keyed by a stable `userId` (a uuid in `localStorage`), **not** the socket id.
  Roles therefore survive a refresh, a phone locking, and a reconnect.
- If the Host disconnects, `promoteSuccessorHost()` hands control to the longest-tenured
  participant. A room that silently loses its only authority is a room nobody can use.

---

## 6. Wire contract

Event names are taken verbatim from the brief's table so it can be checked off line by
line. The full typed contract is `client/src/types.ts`; `ServerEvents` and `ClientEvents`
mean a renamed payload field fails a compile rather than surfacing at runtime.

### Client → server

| Event | Payload | Note |
| --- | --- | --- |
| `create_room` | `{ username, userId, video? }` | ack `{ ok, roomId, role }` |
| `join_room` | `{ roomId, username, userId }` | ack, so the Home screen can route on success |
| `play` `pause` | – | through the gate |
| `seek` | `{ time }` | coalesced server-side (§7) |
| `change_video` | `{ videoId }` | accepts a bare id or any youtu.be form |
| `assign_role` | `{ userId, role }` | Host only |
| `remove_participant` | `{ userId }` | Host only; cannot remove the Host |
| `transfer_host` | `{ userId }` | Host only |
| `request_approval` | `{ action, payload?, note? }` | explicit "ask the host" path |
| `resolve_request` | `{ requestId, approved }` | approvers only; `false` dismisses |
| `sync_request` | – | "I think I'm stuck", returns one snapshot |
| `report_duration` | `{ duration }` | lets the server clamp seeks |
| `chat_message` / `reaction` | `{ text }` / `{ emoji }` | sanitised, rate-limited |

### Server → client

`room_state` (full snapshot, on join/reconnect) · `sync_state` (playback) ·
`user_joined` · `user_left` · `participant_removed` · `role_assigned` ·
`host_transferred` · `request_pending` (to the requester) · `request_received` /
`request_queue` (**approvers only**) · `request_resolved` · `request_expired` ·
`chat_message` · `reaction` · `removed_from_room` · `room_error { message, code }`

REST is deliberately minimal — `/health` (status + room/participant counts),
`/api/rooms/:code` (read-only share-link preview) and `/`. Everything stateful is a
WebSocket, because every such call needs an authenticated connection to act on.

---

## 7. Keeping three dozen players in step

This is where the assignment actually bites, and it is three separate problems.

### 7.1 Feedback loops — the one that ruins naive implementations

YouTube's player fires `onStateChange` when *you* call `player.playVideo()`. If the sync
layer responds to that event by telling the room "someone pressed play", then every
correction it applies triggers another correction, and one pause becomes an infinite
broadcast storm.

The fix is structural, not a flag. **Nothing in the player layer ever emits a playback
event.** Only a click on the app's own control bar does, and `onStateChange` is used for
one thing: knowing that the player is ready. YouTube's native chrome is disabled
(`controls: 0`, `disablekb: 1`) so there is no input path the sync layer cannot see —
otherwise a viewer pausing via YouTube's own button would desync the room invisibly.

A boolean `isSyncing` guard would also "work" and would also race: it is set on the
JavaScript thread while the player's callbacks arrive on another timeline. Removing the
route the loop travels beats remembering to raise a flag.

### 7.2 Clock skew — and why there is no clock sync

The naive approach computes "server time + network latency" and seeks everyone to it.
That needs round-trip estimation and breaks on the first asymmetric connection.

Instead each client tracks only *its own* elapsed time since it received a snapshot:

```
expectedPosition = sync.position + (Date.now() - receivedAt) / 1000
```

Server clock skew cancels out algebraically — it appears in both `position` and
`receivedAt`, which are read from the same local clock. The system needs no absolute
timestamp to be correct, only a duration to have elapsed. NTP, latency probes and
handshake-time synchronisation all become unnecessary.

### 7.3 Drift, and not fighting the player

The server state is a derived value: while playing, the position is `currentTime +
elapsed`, so an idle room costs zero CPU and no timer accumulates error. On the client a
1 s interval compares the local position with the projection and seeks only when the gap
exceeds **1.5 s**. Below that, the player runs free — micro-correcting a video that is one
third of a second out looks worse than the drift itself.

Correction is additionally suppressed for a **1.2 s settle window** after any
programmatic mutation. Seeking and buffering take time to take effect; without the window
the drift loop sees a stale position and seeks again, and again — visible stutter every
second on a slow connection.

### 7.4 Autoplay, honestly

Browsers block unmuted autoplay. A player created in response to a *socket* message is not
inside a user gesture, so the first `play` can be refused by the browser. Rather than
pretend the video started, the stage shows a "Tap to join the party" overlay and resolves
the pending state inside that real tap. This is a browser policy, not a bug in the sync.

---

## 8. Design decisions and trade-offs

**The database is optional at runtime.** No `MONGODB_URI` → a no-op persistence adapter.
A free-tier deploy therefore cannot be broken by a misconfigured Atlas cluster, and the
in-memory path is the same one the tests run against. Cost: rooms die on restart, which is
fine for a watch party and would not be for, say, payments.

**Server-authoritative rather than CRDT/optimistic.** Every change round-trips, adding one
RTT of input latency (~30–80 ms). That is invisible for media playback and buys the only
model where permissions can mean anything: authority has to live somewhere the client
cannot write to.

**Broadcast a full snapshot, not a delta.** A `sync_state` carries the entire playback
state. Deltas are smaller and would matter at thousands of rooms; a snapshot is
idempotent, so a dropped or duplicated event is harmless and a late joiner converges from
one frame. At this payload size (~200 bytes) the bandwidth argument is not worth the
complexity.

**Seek is coalesced, play/pause never is.** A scrubber drag legitimately fires dozens of
events per second and only its final value is meaningful, so `seek` is merged over a 90 ms
window — one broadcast instead of forty, and the room ends up where the user left the
handle. `play`/`pause`/`change_video` are instead budgeted at a rate no human hand can
reach, and going over it returns a visible refusal. The asymmetry is deliberate: dropping a
seek mid-drag is invisible, dropping a play click is a broken-looking button.

**Requests expire after 60 s and are capped** (2 per user, 20 per room, deduplicated per
user + action). Without expiry a Host returning to an idle tab could yank a room that moved
on ten minutes ago; without caps one person can deny service to the queue.

**Governance is not requestable.** A Participant cannot propose "make me host". Only
playback actions can be escalated, and the test suite asserts that a refused governance
attempt does not quietly fall back into the request queue.

**Position lives in local component state.** The player position updates 4×/s; putting it
in the global store would re-render the roster, chat and controls four times a second for
no reason.

---

## 9. Scaling story

One process holds all its rooms in memory, so a room is a single authority — which is
exactly what makes the RBAC trustworthy. Scaling that out:

1. **Partition by room code.** Rooms are independent; `RoomManager` already maps
   `code → Room`, so consistent hashing on the code puts every member of a party on one
   node. No shared state to reconcile.
2. **Redis Pub/Sub for the cross-node case** — a chat message or `sync_state` is published
   to a `room:{code}` channel; every node subscribed pushes it to its own sockets. This is
   the shape of the change: `Room.broadcast()` is one function, and it becomes a publish.
   Redis also turns the in-memory request queue and rate-limit windows into shared state.
3. **Stickiness on reconnect** — Socket.IO's adapter makes a reconnected socket resume its
   room membership, and the server re-sends a full `room_state`, so a node restart is
   self-healing rather than data-losing.
4. Horizontal ceiling: the expensive thing is not CPU, it is fan-out. A 50-seat room
   emitting one event per second is 50 frames/sec — trivially small; the real limit is
   sockets per node (file descriptors, ~10k on a modest instance), which partitioning
   solves directly.

There is deliberately **no** Redis dependency in this build: it would be unexercised code
on a free tier, and the single-process design is honest about what it is.

---

## 10. Layout

```
server/src/
  index.js          Express + Socket.IO wiring, REST, graceful shutdown
  config.js         every tunable, no magic numbers in the logic
  ws/
    permissions.js  ← the RBAC matrix. Pure. Start reading here.
    Room.js         ← authoritative state + applyPlayback(), the single mutation funnel
    Participant.js  identity + role, never a client-supplied one
    RoomManager.js  code → Room, TTL sweeps, restore from DB
    handlers.js     ← MessageHandler: one gate in front of every event
  utils/            roomCode (unambiguous alphabet), youtube (URL → id), sanitize
  models/Room.js    Mongoose schema, only loaded if MONGODB_URI exists
  db/mongo.js       real adapter + no-op in-memory adapter

client/src/
  types.ts          ← the wire contract, both directions
  socket.ts         one connection per tab, stable userId
  store/roomStore.ts zustand; expectedPosition() lives here
  actions.ts        emitters (plain functions — see the singleton note in useSocket.ts)
  hooks/
    useSocket.ts       inbound events → store
    useYouTubeSync.ts  ← the player; the sync algorithm
  pages/ Home (create/join), Room
  components/       VideoStage, ControlBar, ParticipantList, RequestQueue,
                    ChatPanel, ReactionBar/Layer, ShareCard, RemovedScreen, Toasts
```

Suggested reading order for the interview: `permissions.js` → `handlers.js` (`handleAction`)
→ `Room.js` (`applyPlayback`) → `useYouTubeSync.ts` → `types.ts`.

---

## 11. Known limitations

Stated plainly, because each is a boundary rather than a defect:

- **YouTube's own buffering is not controllable.** A client on a slow connection will
  appear to freeze; the drift loop pulls it back once it catches up. Per-user quality
  selection is not exposed by the IFrame API.
- **No cross-tab identity isolation** in the same browser profile — `userId` is in
  `localStorage`, so two tabs of one browser are one person. Use a private window to
  simulate a second user.
- **In-memory mode loses rooms on restart**, and the free Render instance sleeps after
  inactivity, so a cold start adds a few seconds.
- **Rate limits are per socket, not per account** — there are no accounts. A hostile
  client can open many sockets; that needs IP-level limiting or a reverse-proxy rule.
- **The Host cannot be demoted without transferring first**, by design: a room with no
  authority cannot resolve its own requests.
- **Chat is not moderated or persisted.** Sanitised and length-capped, but a room full of
  participants can flood it at one message per 700 ms each.
```
