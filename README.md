# 🍿 YouTube Watch Party

A multi-user watch party. Everyone in a room sees the same YouTube video at (almost) the
same position. Who can control playback is decided on the server, and a viewer who wants a
change sends a request the Host approves.

| | |
| --- | --- |
| Live app | https://watch-party-ay7d.onrender.com |
| Backend | Node.js, Express, Socket.IO |
| Frontend | React 18, TypeScript, Vite, zustand |
| Database | MongoDB (optional; the server also runs fully in memory) |
| Assignment | Intern Assignment: YouTube Watch Party System |

---

## 1. What it does

One person creates a room, gets a 6-character code, and shares it (code or link). Everyone
who joins watches the same video, in sync to within about a second.

The main idea is that permissions live on the server, not in the UI. Hiding a button is not
a real permission check, because a client can always emit any event it wants. So every
inbound playback event goes through one gate (`server/src/ws/permissions.js`), and each
client is separately told which actions it may take so the UI can match that.

A Participant who presses play does not get an error. Their action turns into a request that
only the Host and Moderators see. On approval the change runs and is credited to whoever
asked for it.

### Requirement mapping

| Brief requirement | Where it lives |
| --- | --- |
| Real-time play/pause/seek/current-video sync | `server/src/ws/Room.js`, `client/src/hooks/useYouTubeSync.ts` |
| Room creation with unique code | `server/src/utils/roomCode.js`, `RoomManager.create()` |
| Join by code or link | `client/src/App.tsx` route `/room/:code` + `ShareCard` |
| YouTube IFrame Player API | `client/src/hooks/useYouTubeSync.ts` |
| WebSocket (Socket.IO) | `server/src/ws/handlers.js`, `client/src/socket.ts` |
| Host / Moderator / Participant roles | `server/src/ws/permissions.js` |
| Backend validates permissions before acting | `MessageHandler.handleAction()` → `applyIntent()` |
| Host assigns roles / removes / transfers | `assign_role`, `remove_participant`, `transfer_host` |
| Broadcast role updates so UI can disable controls | `capabilities` on every participant |
| Participant must request approval | `needsApproval()` → request queue |
| Chat and emoji reactions | `chat_message`, `reaction` |
| Database (MongoDB + Mongoose) | `models/Room.js`, `db/mongo.js` (in-memory fallback when `MONGODB_URI` is unset) |
| OOP design (`Room`, `Participant`, `MessageHandler`) | `server/src/ws/` |

---

## 2. Quick start

Requires Node 18+.

```bash
# backend
cd server
npm install
cp .env.example .env      # every value has a working default
npm start                 # -> http://localhost:4000

# frontend (new terminal)
cd client
npm install
cp .env.example .env
npm run dev               # -> http://localhost:5173
```

Open two browsers (one can be a private window so they get separate identities), create a
room in the first, join with the code in the second, and press play.

### Tests

```bash
cd server
npm run verify        # drives two real Socket.IO clients, 53 checks
npm run verify:db     # needs MONGODB_URI, checks the writes actually land
```

`npm run verify` goes through the same wire path a browser uses and checks the awkward cases,
like: a client that claims `role: 'host'` in its payload still joins as a participant, a
Participant's pause produces a request and no state change, and a refresh keeps the same
seat and role. `npm run verify:db` reads the MongoDB document back after a real socket
action and asserts the debounced write landed with the right fields, then deletes the row it
made.

---

## 3. Deployment

One Render web service runs everything. If `client/dist` exists at boot, the Express process
serves the built React app alongside the API and Socket.IO on the same origin.

This is simpler than the usual two-service split. A split needs the frontend URL in the
backend's `CLIENT_ORIGIN` and the backend URL in the frontend's `VITE_SERVER_URL`, and getting
either wrong produces a Socket.IO error that looks like a network problem.

| Setting | Value |
| --- | --- |
| Root Directory | `server` |
| Build command | `npm install && cd ../client && npm install && npm run build && cp -r dist ../server/client-dist` |
| Start command | `npm start` |
| Instance | Free |
| Health check path | `/health` |

The server looks in `server/client-dist` first and falls back to `client/dist`, so a local
`npm start` needs no copy step and the same code works in both layouts.

Environment variables (all optional):

| Name | Purpose |
| --- | --- |
| `MONGODB_URI` | set → rooms are restored after a restart (`watch_party.rooms`); unset → in-memory only. It holds a password, so keep it in the host's environment screen and the gitignored `server/.env`, never in a commit |
| `CLIENT_ORIGIN` | only needed if you split the frontend onto Vercel/Netlify |
| `PORT` | set by Render (default 4000 locally) |

### Setting up the database on Render

A connection string is a password in a URL, so once it's on a hosting dashboard the cluster
has to be reachable only from where it should be:

1. Render → service → Environment → add `MONGODB_URI` with the Atlas connection string. Add
   nothing to the repo (`server/.env` is gitignored).
2. Atlas → Network Access → allow `0.0.0.0/0`. Render's free tier doesn't publish static
   egress IPs, so a specific-address allowlist can't describe "my service". This is why the
   credential has to matter on its own.
3. Atlas → Database Access → create a dedicated user (e.g. `watchparty`) with `readWrite` on
   `watch_party` only, and use that in the URI. Least privilege: the worst this string can do
   is damage one collection.
4. If the string ever leaked (chat, screenshot, a briefly public repo), rotate that user's
   password in Atlas and update the one variable in Render.
5. Check with `curl https://…/health`. The `persistence` field reads `in-memory`, `mongodb`,
   or `mongodb (configured, NOT connected)` (that last one means the URI is set but wrong, or
   the allowlist doesn't include the host; the app still works either way).

One small safety: a driver error can quote the connection string back, and people paste logs
into issues. Persistence log lines go through `redact()` in `db/mongo.js`, which hides only
the `user:password` part and keeps the host names.

### Free tier cold starts

A free instance sleeps after ~15 min idle, so the first request can wait 30-50s for boot.
Rooms live in memory, so a restart or wake-up wipes them. Both are handled so the page never
looks broken:

| Situation | What the viewer sees now |
| --- | --- |
| Instance asleep | the client retries with back-off; if it gives up, the room screen says so and its button restarts the connection |
| Room gone after a restart | a screen naming the code and the server's reason, with Try again / Start your own room (and with the DB set, the room is restored instead of lost) |
| A click while the socket wasn't ready | each refusal states its reason, and a click that lands during a retry is queued and replayed on connect, so the wait is paid once |
| A refresh of the room URL on a phone | the player is only built once the room has named a video (§7.4), and the room remembers its owner (§5) |

`join_room` has always answered with `{ ok: false, error }` for a bad code; the client just
wasn't reading it. Now it's stored as `joinError` and rendered. Pointing any free uptime
checker at `/health` every few minutes keeps the instance awake for a demo.

### Speed

`compression` sits in front of the static handler, and the built JS is served gzipped
(~237kB down to ~78kB over the wire). Cache policy is split on purpose: fingerprinted
`/assets/*` get `max-age=31536000, immutable` (a hashed name can't point to two files), while
`index.html` gets `no-cache` (it's the one file whose content changes every deploy but whose
name doesn't, and caching it is how a good deploy looks like nothing happened).

On the client, "room creation takes 7-10s" was traced to two socket options, not the server
(a room is made in single-digit ms): `timeout: 12000` and `reconnectionDelayMax: 6000` meant
one unanswered attempt plus back-off could keep the browser out for a long time even after the
server was up. They're now `4000 / 400 / 1200`, so retries are cheap and the browser notices
the server is back within about a second. The attempt count stays finite because
`reconnect_failed` only fires when it's reached, and that's what lets the UI show a real error
instead of spinning forever.

---

## 4. Architecture

```
Browser A (Host)          Browser B (Participant)       Browser C (Moderator)
      │                            │                             │
      │  play / pause / seek       │  pause  -> request          │  play (approved)
      ▼                            ▼                             ▼
┌──────────────────────────── Socket.IO ──────────────────────────────┐
│  MessageHandler          one gate per inbound event                 │
│    ├─ permissions.js     can() / needsApproval()  - no I/O          │
│    ├─ RoomManager        code -> Room, lifecycle, expiry sweeps     │
│    └─ Room               authoritative state + applyPlayback()      │
└───────────────┬──────────────────────────────────────────────────────┘
                │  optional, debounced 2s per room
                ▼
         MongoDB Atlas      one document per room (live socket state is not stored)
```

The core rule: the Room owns the truth, clients own the rendering.

Clients don't send state, they send intent ("I pressed play"). The Room folds that into
canonical state and broadcasts the result back to everyone, including the sender. The sender
is corrected rather than trusted, so two people clicking at once converge instead of each
browser deciding its own version. A plain message relay would let every client rebuild a
different history, so the server has to hold the one copy.

---

## 5. Permission model

`server/src/ws/permissions.js` is the single source of truth. It's pure (no sockets, no
database, no clock), which is why it's easy to test on its own.

| Action | Host | Moderator | Participant |
| --- | :---: | :---: | :---: |
| play / pause / seek / change_video | ✅ | ✅ | 🟡 must request |
| chat / react / sync_request | ✅ | ✅ | ✅ |
| assign_role | ✅ | ❌ | ❌ |
| remove_participant | ✅ | ❌ | ❌ |
| transfer_host | ✅ | ❌ | ❌ |
| approve / dismiss requests | ✅ | ✅ | ❌ |

✅ runs · ❌ refused with a reason · 🟡 turned into a request

The logic, in order:

```js
if (can(role, action))       → mutate + broadcast sync_state
else if (needsApproval(...)) → queue a request, notify approvers only
else                         → refuse, and tell the sender why
```

Every branch answers the sender, so a control a user can see never does nothing without
either taking effect or saying why.

There are two gates, but only the server one is authoritative. A hand-made
`socket.emit('pause')` that never touches the UI still hits `permissions.js` and is refused.
The second gate is the `.stage__click-blocker` div over the YouTube iframe: the embedded
player has its own native play/pause button and scrub bar, and a click on those goes straight
into a cross-origin iframe. Without the blocker, a Participant could pause or drag everyone's
video without emitting anything. Our own overlays (tap-to-join, error, banner) sit above it,
so they stay clickable. The tradeoff is that YouTube's own fullscreen button does nothing.

### Roles

The brief says Host / Moderator / Participant but also uses "Viewer". Viewer is treated as an
alias for Participant, and admin as an alias for host, rather than extra tiers that behave
exactly like ones that already exist.

### Who the Host is, and what happens on leave

- The Host role is minted by the server in `Room.addParticipant`, only for the first person
  into an empty room. It's never read from a client payload.
- Identity is keyed by a stable `userId` (a uuid in localStorage), not the socket id, so a
  refresh, a phone locking, or a reconnect keeps your role.
- `Room.ensureHost()` runs on every arrival and departure: keep the Host if there is one,
  otherwise restore the recorded owner (`hostUserId`), otherwise promote the longest-tenured
  participant.
- Ownership outlives the socket, which is what makes a refresh survivable. An early version
  only promoted a successor when someone was left to inherit, so a Host alone in a room who
  reloaded came back as a Participant in a room that could never get a Host again.
  `hostUserId` fixes that, and it moves with an explicit `transfer_host`.
- Pressing Leave hands the room over on the spot, and the promotion is in the same broadcast,
  so the new Host's controls go live immediately. Tenure is the rule, not rank. A returning
  former Host does not reclaim it (a tab shut for two seconds shouldn't demote whoever has
  been running the party).
- A refresh is not a departure. A reload rebinds the same `userId` to its seat, and the old
  socket disconnects a moment later; `exit()` only removes a seat if the disconnecting socket
  is still the one bound to it, so a stale disconnect doesn't fire a bogus host transfer.
- `room_deleted` is kept in the contract but not emitted today. It's reserved for a future
  "end the party for everyone" action; a Host leaving hands over instead, so viewers are never
  told the room died while it's still playing.

---

## 6. Wire contract

Event names are taken from the brief so they line up. The full typed contract is
`client/src/types.ts`; `ServerEvents` / `ClientEvents` mean a renamed payload field fails a
compile instead of surprising you at runtime.

### Client → server

| Event | Payload | Note |
| --- | --- | --- |
| `create_room` | `{ username, userId, video? }` | ack `{ ok, roomId, role }` |
| `join_room` | `{ roomId, username, userId }` | ack, so the Home screen can route on success |
| `play` / `pause` | – | through the gate |
| `seek` | `{ time }` | coalesced server-side (§7.3) |
| `change_video` | `{ videoId }` | accepts a bare id or any youtu.be form |
| `assign_role` | `{ userId, role }` | Host only |
| `remove_participant` | `{ userId }` | Host only |
| `transfer_host` | `{ userId }` | Host only |
| `request_approval` | `{ action, payload?, note? }` | explicit "ask the host" path |
| `resolve_request` | `{ requestId, approved }` | approvers only |
| `sync_request` | – | "I think I'm stuck", returns one snapshot |
| `report_duration` | `{ duration, title? }` | duration lets the server clamp seeks; both are sanitised |
| `chat_message` / `reaction` | `{ text }` / `{ emoji }` | sanitised, rate-limited |

### Server → client

`room_state` (full snapshot on join/reconnect) · `sync_state` (playback) · `user_joined` ·
`user_left` · `participant_removed` · `role_assigned` · `host_transferred` ·
`request_pending` (to the requester) · `request_received` / `request_queue` (approvers only) ·
`request_resolved` · `request_expired` · `chat_message` · `reaction` · `removed_from_room` ·
`room_error`

REST is small on purpose: `/health`, `/api/rooms/:code` (a read-only share preview), and `/`.
Everything stateful is a WebSocket, because it needs an authenticated connection to act on.

---

## 7. How sync works

This is the part that took the most care. There are a few separate problems.

### 7.1 Feedback loops

YouTube's player fires `onStateChange` when you call `player.playVideo()` yourself. If the
sync layer reacted to that by telling the room "someone pressed play", each correction would
trigger another one, and one pause could become a broadcast storm.

So the fix is structural: nothing in the player layer ever emits a playback event. Only a
click on the app's own control bar does. `onStateChange` is read just to know the player is
ready and to catch local things like a blocked autoplay. A boolean `isSyncing` flag would also
work but could race (the player's callbacks arrive on a different timeline), so removing the
path the loop travels is cleaner. YouTube's own controls are disabled (`controls: 0`,
`disablekb: 1`) so there's no input path the sync layer can't see.

### 7.2 No clock sync needed

The naive approach computes "server time + latency" and seeks everyone to it, which needs
round-trip estimates and breaks on the first odd connection. Instead each client only tracks
its own elapsed time since it got a snapshot:

```
expectedPosition = sync.position + (Date.now() - receivedAt) / 1000
```

Server clock skew cancels out, because `position` and `receivedAt` are both read from the same
local clock. We never need an absolute timestamp, only a duration, so NTP and handshake-time
syncing aren't needed.

### 7.3 Drift, without fighting the player

While playing, the server position is a derived value (`currentTime + elapsed`), so an idle
room costs no CPU. On the client a 1s interval compares local position with the projection and
seeks only when the gap is over the tolerance (0.4s). Below that the player runs free, since
micro-correcting a video that's a third of a second out looks worse than the drift itself.

Correction is also suppressed for 1.2s after any programmatic seek. Seeking and buffering take
time to land; without that window the drift loop sees a stale position and keeps seeking, which
is visible stutter on a slow connection.

A backgrounded tab is a special case. Chrome throttles a hidden tab's timers and YouTube often
pauses the player when the page isn't visible. Neither means "pause the party", so nothing is
broadcast (the viewers keep watching). The bug was on return: the tab came back paused and
off-position. So the drift loop leaves hidden tabs alone entirely, and a `visibilitychange`
handler re-applies the room state once the tab is visible again. A hidden tab can't be forced
to keep rendering YouTube's iframe; that's browser policy.

### 7.4 Autoplay

Browsers block unmuted autoplay without a user gesture. A player built in response to a socket
message isn't inside a gesture, so the first play can be refused. Rather than pretend it
started, the stage shows a "Tap to join the party" overlay and resolves the pending state
inside that real tap. That's browser policy, not a sync bug.

### 7.5 Console noise

A cross-origin YouTube iframe produces warnings that look alarming. The one that was ours came
from constructing the player with `host: 'youtube-nocookie.com'` while the API script loads
from `www.youtube.com`, which flooded the console with postMessage origin errors. That override
is removed; the `origin` playerVar stays because that's the parameter that actually authorises
the embed. Another real one was the side panel: closing it used `translateX`, not unmount, so
its buttons stayed in the tab order while `aria-hidden` said they didn't exist. It's now
`inert` while closed, and focus moves back to the People button.

### 7.6 The player waits for a video

The stage used to build the player on mount with whatever id it knew, which on a fresh load of
`/room/CODE` is none (the room state arrives a bit later). A player with no video id gives an
iframe with no `src`, and `onReady` (which everything waits on) never fires, so a refresh looked
broken even though joining from Home worked. Construction is now gated on the room having named
a video.

---

## 8. Design decisions

- **Database optional at runtime, set on the deploy.** No `MONGODB_URI` uses a no-op adapter,
  so a misconfigured Atlas can't break a free-tier deploy. With it, `watch_party.rooms` holds
  one document per party: `roomId` (unique), `videoId` (validated on write, since a malformed
  row would restore a room whose player can't load), `title`, position, duration, host id,
  peak headcount, a capped chat log, and timestamps. A TTL on `lastActiveAt` drops anything
  untouched for 7 days; every write refreshes it, so an active party isn't aged out.
- **Live socket state is not stored.** Who's connected is meaningless once the process dies, so
  persisting it would just create stale data to reload. A restored room is a fresh room with
  the same video, position and chat, and whoever joins first runs it until the owner returns.
- **Chat is stored** (last 120 messages), since it's content people come back to. It rides the
  same debounced write, so a burst costs a few writes, not one per line.
- **Writes debounced 2s per room and fire-and-forget**, so a drag doesn't write dozens of
  positions and a slow DB can't delay a broadcast.
- **Server-authoritative, not CRDT/optimistic.** Every change round-trips (adds ~30-80ms),
  which is invisible for playback and is the only model where permissions mean anything:
  authority has to live where a client can't write.
- **Full snapshot, not a delta.** Snapshots are idempotent, so a dropped or duplicated event is
  harmless and a late joiner converges from one frame. At ~200 bytes, bandwidth isn't a concern.
- **Seek coalesced (90ms), play/pause never.** A drag fires many events and only the last one
  matters. play/pause/change_video are budgeted at a rate no hand can hit, and going over it
  gives a visible refusal. Dropping a seek mid-drag is invisible; dropping a play click looks
  like a broken button.
- **Requests expire after 60s and are capped** (2 per user, 20 per room), so an old request
  can't yank a room that moved on, and one person can't flood the queue.
- **Governance is not requestable.** A Participant can't propose "make me host". A test asserts
  a refused governance attempt doesn't quietly fall back into the request queue.
- **Player position stays in component state**, not the store, so a 4×/s update doesn't
  re-render the roster, chat and controls.

---

## 9. Scaling (not done, but here's the shape)

One process holds rooms in memory, so a room is a single authority (which is what makes the
RBAC trustworthy). To scale:

1. Partition by room code. Rooms are independent, so consistent hashing on the code puts a
   party's members on one node.
2. Redis Pub/Sub for the cross-node case. `Room.broadcast()` becomes a publish to a
   `room:{code}` channel.
3. Socket.IO's adapter handles reconnect stickiness, and a rejoin gets a full `room_state`.
4. The real limit is sockets per node (file descriptors), not CPU.

No Redis is wired in this build: on a free tier it would be untested code, and the single
process design is honest about what it is.

---

## 10. Layout

```
server/src/
  index.js          Express + Socket.IO wiring, REST, graceful shutdown
  config.js         tunables, so no magic numbers in the logic
  ws/
    permissions.js  the RBAC matrix (pure, start here)
    Room.js         authoritative state + applyPlayback()
    Participant.js  identity + role, never a client-supplied one
    RoomManager.js  code -> Room, TTL sweeps, restore from DB
    handlers.js     MessageHandler: one gate per event
  utils/            roomCode, youtube (URL -> id), sanitize
  models/Room.js    Mongoose schema for watch_party.rooms
  db/mongo.js       real adapter + no-op in-memory adapter
  scripts/          verify-rbac.js, verify-persistence.js

client/src/
  types.ts          the wire contract, both directions
  socket.ts         one connection per tab, stable userId
  store/roomStore.ts zustand; expectedPosition() lives here
  actions.ts        emitters (plain functions, not a hook)
  hooks/
    useSocket.ts       inbound events -> store
    useYouTubeSync.ts  the player and the sync
  pages/ Home (create/join), Room, Legal (About/Privacy)
  components/ VideoStage, ControlBar, ParticipantList, RequestQueue, ChatPanel,
              ReactionBar/Layer, ShareCard, RemovedScreen, RoomUnavailable, Toasts
```

A good reading order: `permissions.js` → `handlers.js` (`handleAction`) → `Room.js`
(`applyPlayback`) → `useYouTubeSync.ts` → `types.ts`.

---

## 11. Known limitations

These are boundaries, not defects:

- YouTube's own buffering isn't controllable. A slow client looks frozen; the drift loop pulls
  it back once it catches up. Per-user quality isn't exposed by the IFrame API.
- No cross-tab identity isolation in one browser profile: `userId` is in localStorage, so two
  tabs are one person. Use a private window to simulate a second user.
- A restart restores the room, its position and its owner, not the people in it. Whoever joins
  first runs it until the owner returns.
- The free Render instance sleeps, so the first visitor waits ~30-50s.
- Rate limits are per socket, not per account (there are no accounts). A hostile client could
  open many sockets; that needs IP-level limiting.
- The Host can't be demoted without transferring first: a room with no authority can't resolve
  its own requests.
- Chat is sanitised and length-capped but not moderated or filtered beyond that.

### npm audit

`npm audit` in `client/` reports a few issues, all in the dev server or unreachable in this
app, and the fixes are breaking major upgrades:
- esbuild / vite dev-server forwarding: only affects `vite dev`, never deployed.
- React Router open redirect: every `to` is built from a fixed prefix (`/` or `/room/`), so
  user text can't make it protocol-relative.

A blind `npm audit fix --force` would break the build for no real gain.
