# 🍿 YouTube Watch Party

A multi-user watch party where the video in every browser stays in step, governed by
server-side roles and an approval queue.

| | |
| --- | --- |
| **Live app** | https://watch-party-ay7d.onrender.com |
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
| **Database (MongoDB + Mongoose)** | `watch_party.rooms` — one document per party, `models/Room.js` + `db/mongo.js`, with an in-memory fallback when `MONGODB_URI` is unset (§8) |
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
events they receive — 39 checks, going through the same wire path a browser uses. It
covers the adversarial cases rather than the happy path:

- a client that *claims* `role: 'host'` in its join payload still joins as a participant
- a Participant's `pause` produces `request_pending` and **no** `sync_state`
- a Participant's `assign_role` is refused and does **not** silently degrade into a request
- an approved request is byte-identical downstream to a Host's own action
- after promotion, that same Participant's `play` executes directly with no request
- a `join_room` for a code that does not exist is *answered* with a reason, never dropped
  (this is the acknowledgement the share-link screen depends on)

Expected tail: `39/39 checks passed`.

If you set `MONGODB_URI`, there is a second suite for the database itself:

```bash
cd server
npm run verify:db
```

It does the thing `npm run verify` cannot: after driving a real socket, it reads the
MongoDB document back and asserts that the debounced write actually landed with the right
fields — code, video id shape, duration, host id, peak headcount, timestamps — plus that the
title arrived sanitised. Asserting on the document rather than on a function's return value
is the only way to catch a background write that quietly never happened. It deletes the row
it created (`npm run verify` is not so surgical: against a database-enabled server it leaves
a test row or two behind, which the TTL ages out after 7 days), and exits 0 with a note when
no database is configured.

Expected tail: `16 persistence checks passed`.

---

## 3. Deployment

**One Render web service runs everything.** When `client/dist` exists at boot, the Express
process serves the built React app alongside the API and Socket.IO on the same origin.

That is a deliberate choice over the usual two-service split, because it removes a whole
class of deployment failure rather than just saving a tab: the split topology needs the
frontend URL pasted into the backend's `CLIENT_ORIGIN` *and* the backend URL pasted into
the frontend's build-time `VITE_SERVER_URL`, and getting either wrong produces a Socket.IO
error that looks exactly like a network problem.

| Setting | Value |
| --- | --- |
| Root Directory | `server` |
| Build command | `npm install && cd ../client && npm install && npm run build && cp -r dist ../server/client-dist` |
| Start command | `npm start` |
| Instance | Free |
| Health check path | `/health` |

The final `cp` is a safety measure, not the fix for the bug this layout originally seemed
to cause. Render's deploy log showed the app running from `/opt/render/project/src/server`,
which means the sibling `client/` directory *is* present at runtime — the reason the first
deploy served JSON at `/` was route precedence, covered in "What the HTTP layer does about
speed" below. The copy is still worth keeping: `server/client-dist` makes the shipped
directory self-contained instead of depending on how the build box happens to lay out the
checkout. The server probes `server/client-dist` first and falls back to `client/dist`, so
local `npm start` needs no copy step and the same code runs in both layouts.

Environment variables (all optional):

| Name | Purpose |
| --- | --- |
| `MONGODB_URI` | set on the deployed service → rooms are restored after a restart or redeploy (`watch_party.rooms`). Unset → in-memory only, and the app is still fully functional. It is a credential, so it belongs in the host's environment screen and in the gitignored `server/.env` — never in a commit |
| `CLIENT_ORIGIN` | only needed if you split the frontend onto Vercel/Netlify instead |
| `PORT` | set by Render (default 4000 locally) |

> **Live app:** https://watch-party-ay7d.onrender.com
> · API info at `/api` · status at `/health`

### Setting the database variable on Render without opening the cluster to the world

The variable itself is two clicks. The part that matters is that a connection string is a
**password in a URL**, and once it sits on a hosting provider it is readable by anyone with
access to that dashboard — so the cluster has to be reachable *only* from where it should be,
and the credential has to be worth less than it looks.

1. **Render → your service → Environment → Add Environment Variable**
   - Key: `MONGODB_URI`
   - Value: the Atlas *Connect → Drivers* string (the `mongodb://…?ssl=true&replicaSet=…&authSource=admin`
     form, or the `mongodb+srv://` one — the driver accepts either, and TLS is mandatory in
     both, so there is no plaintext fallback to worry about)
   - Add **nothing** to the repository. `server/.env` is gitignored, and `git ls-files` proves
     no env file or run capture is tracked.
   - Save → Render redeploys. That restart *is* the deploy; no separate Manual Deploy needed
     unless the code also changed.

2. **Atlas → Security → Network Access → Add IP Address → `0.0.0.0/0`**
   This is not sloppiness, it is the shape of the problem: Render's free tier does not publish
   static egress IPs, so an allowlist of specific addresses cannot describe "my service".
   Setting it means *any* host may attempt a connection and the credential is the only barrier,
   which is exactly why step 3 is not optional.
   (The alternative that keeps the allowlist tight — a fixed IP / VPC peering / a tunnel — costs
   money or a second service, neither of which an assignment needs.)

3. **Atlas → Database Access → create a dedicated user for this project**, e.g. `watchparty`,
   with `Built-in Role → readWrite → db: watch_party`, and use *that* user in the URI.
   Reusing an admin user that can also write your other databases turns one leaked string into
   a much bigger incident than "someone changed a room's video". Least privilege is the whole
   point: the worst this URI can now do is damage one collection.

4. **If the string was ever pasted somewhere it should not have been** — a chat, a screenshot,
   a deploy log, a repo that was briefly public — regenerate that user's password in Atlas and
   update the one variable in Render. Rotation is cheap here (one restart) and worthless to
   delay, because the old string keeps working until it is rotated.

5. **Verify it the honest way: `curl https://…/health`.** The `persistence` field is one of
   exactly three strings, and the third one exists because the failure it describes is silent
   from the outside:
   - `in-memory` → no `MONGODB_URI` at all. Rooms die on restart.
   - `mongodb` → connected. Rooms are restored after a restart, and `npm run verify:db` passes.
   - `mongodb (configured, NOT connected)` → the variable is set and useless: wrong password,
     or an allowlist that does not include this host. The app still works completely, which is
     why this reading is a live value from the driver's connection state rather than a constant
     copied from the config (`db/mongo.js`). Without it, a deploy that silently lost its
     database looks identical to one that has it.

### Why a shared link can look dead — and what the app now does about it

Three honest failure modes, the first two consequences of one free single-instance tier:

| Cause | What it used to look like | What the viewer gets now |
| --- | --- | --- |
| Instance asleep: the first request after ~15 min idle waits ~30–50 s for the boot | a spinner, and then nothing at all once the client's retries ran out | retries with back-off for a couple of minutes; if it genuinely gives up, the room screen says so and its button restarts the connection |
| Room gone: a restart, redeploy or wake-up used to wipe the in-memory rooms | a black stage and a toast that expired after 4 s | a screen naming the room code and the server's own reason, with **Try again** and **Start your own room**; and with the database configured the room is restored rather than lost |
| A click while the socket was not ready — display name still empty, or the connection not up yet | **nothing at all**. The handler returned early without a message, so a correct room code typed too early looked like a dead button | every refusal states its own reason; and a click that lands while a retry is in flight is **queued and replayed by itself** the moment the connection opens, so the wait is paid once instead of once per attempt |
| A reload of the room URL, on the phone that is watching | an error overlay ("invalid video id") over a video that was fine, and a Host who came back as a Viewer with no controls | the player is only built once the room has named a video (§7.6), and the room remembers its owner (§5) |

The first two are fixed properly rather than cosmetically, in two places. `join_room` has always
acknowledged `{ ok: false, error }` — the client simply was not reading it, so the refusal
had nowhere to go; it is now stored as `joinError` and rendered. And because `MONGODB_URI`
is set on the deployed service, `RoomManager.getOrRestore()` rebuilds the room from the
`watch_party.rooms` document on the first join after a restart (paused, never auto-resumed
into a room of strangers), so a link shared an hour ago still opens the same video at the
same position. What a restart does still lose is the people: the roster, the roles and the
chat are live socket state and are deliberately not persisted — §8 explains why storing
them would only create lies to reload later.

For a demo, pointing any free uptime checker at `/health` every 5 minutes keeps the instance
awake and the links instant. That is an operational trick, deliberately not app code: a
service cannot keep itself alive.

### What the HTTP layer does about speed

Measured on the deployed app, not estimated:

| | before | after |
| --- | --- | --- |
| JS bundle over the wire | 237 kB, `Content-Encoding: none`, ~1.75 s | 78 kB, gzip/brotli |
| `/assets/*` (Vite-fingerprinted) | `max-age=3600` | `max-age=31536000, immutable` |
| `index.html` | `public, maxAge=0` — a directive no browser understands, so heuristic caching applied | `no-cache`, revalidated with a 304 |

`compression` sits in front of the static handler in `server/src/index.js`. The split in
cache policy is the part worth defending: a fingerprinted filename can never refer to two
different files, so a year is safe and makes the second visit to a shared link nearly
instant; `index.html` is the one file whose *content* changes on every deploy while its
*name* never does, and caching that is precisely how a successful deploy appears to do
nothing. Socket.IO is untouched by any of this — it claims its own path on the raw HTTP
server before Express is consulted, and a WebSocket frame is not an HTTP response.

### What the client does about speed

"Room creation takes 7-10 seconds" was measured, not guessed. A socket-level probe
against the deployed service timed the two parts separately:

| | localhost | deployed (warm instance) |
| --- | --- | --- |
| socket `connect` | 206 ms | 1 648 ms |
| `create_room` → acknowledgement | **8 ms** | **337 ms** |

The server makes a room in single-digit milliseconds, so the wait was never in the
room logic. It was in the client's own patience, and two numbers in `socket.ts` were
responsible: `timeout: 12000` (one unanswered attempt could eat twelve seconds) and
`reconnectionDelayMax: 6000` (up to another six seconds of back-off *after* the
sleeping instance had already finished booting). They are now `4000 / 400 / 1200 ms`:
attempts are cheap and frequent, so the browser notices the server is back within
about a second instead of up to eighteen. The trade is a handful of extra failed
requests during a cold start, which one free instance does not notice. The attempt
ceiling stayed finite on purpose — `reconnect_failed` only fires when it is reached,
and that event is what lets the UI tell the truth instead of spinning forever.

What no client code can do is shorten a boot, so the second half of the fix is to stop
wasting the user's click during one: the Home screen keeps the pressed action and replays
it on connect, with the button saying "Waiting for the server…" rather than showing a
spinner that is not attached to anything.

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
                │  optional, debounced 2 s per room
                ▼
         MongoDB Atlas      one document per room: code, video id + title,
                            position, duration, host label, peak headcount
                            (no-op when MONGODB_URI is unset;
                             live socket state is never stored)
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
- `Room.ensureHost()` is the single rule that keeps a room decidable, called on every
  arrival and every departure: if the room has a Host it is left alone; otherwise the
  room's recorded owner (`hostUserId`) is restored; otherwise the longest-tenured
  participant inherits it. A room that silently loses its only authority is a room
  nobody can use — no playback control, and nobody left to approve a request.
- **Ownership outlives the socket**, which is what makes a refresh survivable. The first
  version of this only promoted a successor *when somebody was left to inherit*, and kept
  a flag saying a Host had already been minted. So a Host alone in a room who reloaded the
  page came back as a Participant in a room that could never have a Host again: the role
  could not be minted (flag set), and there was no one to promote (they were alone). The
  room was a zombie until its idle sweep removed it. `hostUserId` is what the returning
  owner is matched against, and it moves with an explicit `transfer_host`, so handing the
  room over really is handing it over.
- A departing socket leaves the room *for real*. `enter()` used to unbind the socket from
  the old room's broadcast channel while leaving its `Participant` in that room's roster —
  a ghost that inflated the headcount, kept the room from ever reading as empty, and could
  hold the Host role from a connection that no longer existed. Reachable by pressing the
  logo and starting a new party; the harness now asserts the abandoned room is empty
  (`npm run verify`, check 15).

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
| `report_duration` | `{ duration, title? }` | the duration lets the server clamp seeks; the title labels the durable record. Neither grants control, and both are sanitised |
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

**A backgrounded tab is a special case of "the browser did it, not the user".** Chrome
throttles a hidden tab's timers (the drift loop can drop from twice a second to about once
a minute) and YouTube's player frequently pauses itself when it can see the page is not
visible. Neither is an instruction to pause a party, so nothing is broadcast — which is the
behaviour the brief wants: the viewers keep watching while the Host flicks through other
tabs. What was missing, and looked like the room ignoring its own Host, is the *return*:
the Host's screen stayed paused and off-position until the next heartbeat happened to
arrive. So the drift loop now keeps its hands off a hidden tab entirely, and a
`visibilitychange` handler re-applies the authoritative state the moment the tab is visible
again — one deliberate correction instead of a throttled trickle. While a tab is genuinely
hidden, a page cannot force YouTube's iframe to keep rendering; that is browser policy, and
claiming otherwise in an interview would be a lie.

### 7.4 Autoplay, honestly

Browsers block unmuted autoplay. A player created in response to a *socket* message is not
inside a user gesture, so the first `play` can be refused by the browser. Rather than
pretend the video started, the stage shows a "Tap to join the party" overlay and resolves
the pending state inside that real tap. This is a browser policy, not a bug in the sync.

### 7.5 Console messages, and which of them are actually ours

A synced YouTube player is a cross-origin iframe, so it produces browser noise that reads as
alarming. Four appeared during development, and the useful skill is separating *my bug* from
*somebody else's warning*:

| Message | Verdict | What happened |
| --- | --- | --- |
| `Failed to execute 'postMessage' on 'DOMWindow': The target origin provided ('https://www.youtube-nocookie.com') does not match the recipient window's origin` | **ours** | The player was constructed with `host: 'https://www.youtube-nocookie.com'` while the IFrame API script itself loads from `www.youtube.com`, so `www-widgetapi` posted messages aimed at an origin the frame was not on. The `host` override is gone from `useYouTubeSync.ts`. `origin` in `playerVars` stays, because that is the parameter that actually authorises the embed — and the nocookie domain's privacy edge is not worth a red console on every load. |
| `The powerPreference option is currently ignored when calling requestAdapter()` | **not ours** | The player inside YouTube's own iframe asks WebGL for a high-performance GPU, and Chrome on Windows logs that it ignores the hint. Nothing in this app is on that call path (crbug.com/369219127), and a watch party cannot fix a browser warning about a third-party frame. |
| `Blocked aria-hidden on an element because its descendant retained focus` | **ours, and it was a real bug** | The side panel is a slide-over: *closed* means `translateX(100%)`, not unmounted, so its buttons stayed in the tab order while `aria-hidden` asserted the subtree did not exist. Keyboard users could tab into an off-screen panel. It is now `inert` while closed — exactly what the browser's own message recommends — which drops the subtree from the tab order and moves focus out of it. Closing it then hands focus back to the **People** button (`Room.closePanel`), because a closed `inert` panel cannot hold focus and a keyboard user left at the top of the document cannot reopen it. |
| `Failed to execute 'postMessage' on 'DOMWindow': The target origin provided ('https://www.youtube.com') does not match the recipient window's origin` | **not ours** | The same *words* as the first row, which is why it is worth separating them: this one comes from YouTube's own widget script inside the frame posting to the parent page. The client calls `postMessage` nowhere (the only occurrence of the string in `client/` is a comment explaining the row above), the player is constructed on the domain the API script came from, and `origin` in `playerVars` matches the page. It appears intermittently on a local `http://` origin and is not something a hosting page can suppress. |
| `Unrecognized feature: 'web-share'` | **not ours** | Raised about the `allow` permission list of YouTube's iframe. No file in `client/` sets `web-share` or an `allow=` attribute — the attribute is on the iframe the API builds for itself. |

### 7.6 Why the player waits for the room to name a video

The stage used to construct the IFrame API player as soon as the component mounted, with
whatever video id it happened to know — which on a full load of `/room/CODE` is *none*,
because the room state arrives a few hundred milliseconds later over the socket. A player
built with no `video id` yields an iframe with **no `src` at all**, and `onReady` — the one
flag every part of the sync layer waits on (`applySync`, the drift loop, duration reporting)
— never arrives. The result was precisely what was reported from a phone: an error overlay
about an invalid video id and a "Re-sync me" button that could not help, over a room that
was working perfectly for everyone else. The reason it looked random is that the same code
entered from the Home screen *did* work: there the room state is already in the store before
the room page mounts. `useYouTubeSync` now gates construction on the room having named a
video, so the iframe is only ever built around something it can actually load — and an error
raised while there is nothing to play is logged rather than shown, because it cannot be
about the room.

---

## 8. Design decisions and trade-offs

**The database is optional at runtime, and the deployed service has one.** No `MONGODB_URI` →
a no-op persistence adapter, so a free-tier deploy cannot be broken by a misconfigured Atlas
cluster, and the in-memory path is the same one the RBAC tests exercise. With it set,
`watch_party.rooms` holds one document per party: `roomId` (unique, and the only key the app
queries by), `videoId` — validated on write against the 11-character shape, because a
malformed row would restore a room whose player can never load anything — plus `title`,
`currentTime`, `durationSec`, `hostUserId`/`hostName`, `peakParticipants`, `lastActiveAt` and
Mongoose timestamps. A TTL index on `lastActiveAt` deletes anything untouched for 7 days; every
write refreshes that field, so a party people are still watching is never aged out.

**What is deliberately *not* stored, and why.** Live socket state — who is connected, whose
seat is waiting on approval, the chat log — is meaningless the moment the process dies, so
persisting it would only create lies to reload later. Authority is the sharpest case: the Host
role is minted by being the first person into an empty room (`Room.addParticipant`), and no
document can know that whoever owned a room yesterday still owns it. A restored room is
therefore a *fresh* room with the same video and position, and whoever walks in first runs it.
`hostUserId` is recorded as metadata for the share-link preview, not as a claim on the next
session.

Writes are debounced 2 s per room, because a scrubber drag emits dozens of positions and only
the last one deserves a round trip, and they are fire-and-forget from the broadcast path so a
slow database cannot delay a `sync_state`. Reads happen only when a join asks for a code that
is not in memory.

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

**The join-ordered roster is memoised, not re-sorted per ask.** One playback event asks for
the participant list three times — the broadcast payload, the approver queue, a snapshot —
and a join or role change sends it to the whole room, so a naive implementation sorted the
same immutable-by-`joinedAt` data three times per event. The cache is dropped only where the
Map grows or shrinks, which is the only thing that can change that ordering. The same
reasoning removed the array built for every heartbeat tick: the loop that runs forever is the
loop worth keeping allocation-free.

**Where the O(1) already was, and where it is not.** Permissions are a constant-time matrix
lookup, room lookup is a `Map` keyed by code, and every handler resolves its sender through
`socket.data.userId` → `Map.get`, never a scan of the roster — which is also why the dead
`findBySocketId()` linear search is gone rather than optimised. What stays O(n) is honest
fan-out: a broadcast to a room of n people is n frames, and `getHost()`'s scan of a
≤50-seat roster is not worth another piece of state to keep in sync.

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
  models/Room.js    Mongoose schema — the shape of `watch_party.rooms`
  db/mongo.js       real adapter + no-op in-memory adapter
  scripts/          verify-rbac.js (39 checks), verify-persistence.js (16 checks)

client/src/
  types.ts          ← the wire contract, both directions
  socket.ts         one connection per tab, stable userId
  store/roomStore.ts zustand; expectedPosition() lives here
  actions.ts        emitters (plain functions — see the singleton note in useSocket.ts)
  hooks/
    useSocket.ts       inbound events → store
    useYouTubeSync.ts  ← the player; the sync algorithm
  pages/ Home (create/join), Room
  components/       VideoStage, ControlBar, ParticipantList, RequestQueue, ChatPanel,
                    ReactionBar/Layer, ShareCard, RemovedScreen, RoomUnavailable, Toasts
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
- **A restart restores the room and its owner, not its people.** With the database configured
  the video, the position and whose room it was come back; the roster and the chat do not, and
  whoever is in the rebuilt room first runs it until the owner returns (§5, §8). Unconfigured,
  the room is gone and the link says so.
- **The free Render instance sleeps** after inactivity, so the first visitor after a quiet
  spell waits ~30–50 s for the boot while the client retries.
- **Rate limits are per socket, not per account** — there are no accounts. A hostile
  client can open many sockets; that needs IP-level limiting or a reverse-proxy rule.
- **The Host cannot be demoted without transferring first**, by design: a room with no
  authority cannot resolve its own requests.
- **Chat is not moderated or persisted.** Sanitised and length-capped, but a room full of
  participants can flood it at one message per 700 ms each.

### `npm audit` findings, and why they were not "fixed"

`npm audit` in `client/` reports 4 issues (3 moderate, 1 high). They were reviewed rather
than auto-resolved, because both fixes are breaking major upgrades:

| Advisory | Reachable here? | Why |
| --- | --- | --- |
| `esbuild` / `vite` dev-server request forwarding | **No** | Affects `vite dev` only. Production is a static bundle served by Express; the dev server is never deployed. Fix requires Vite 5 → 8. |
| React Router open redirect via backslash in `to` | **No** | Every `to` in this app is built from a fixed prefix (`/` or `/room/`) and user text can only appear *after* it, so a value can never become protocol-relative. Fix requires 6 → 7. |
| React Router SSR `deserializeErrors()` | **No** | There is no SSR — this is a client-only SPA. |

A blind `npm audit fix --force` would have made the build red for no security gain. The
right answer to an audit report is a reachability argument, not a version bump.
