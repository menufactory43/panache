# 1v1 Multiplayer — design proposal

## Status

**Built, in a simpler form (October 2026):** "🌐 Défier un ami (en ligne)"
runs the sound duel's own stack (pairing, lockstep, session, feed:
SOUND-DUEL.md) over a WebSocket to a tiny relay, `relay/` (one Durable
Object per 4-letter room, packets forwarded as they are, a minute to
reconnect). The client is `src/versus/online.ts`; the relay's rules are in
`relay/README.md`. What follows is the original, fuller proposal, kept for
its reasoning: lobby state in the Durable Object, server logs and the battle
archive are not built.

The proposal (none of it built as written). It covers online 1v1 skirmish between two
phones (or any two browsers), using a small Cloudflare Worker with WebSockets.
One player creates a match and sends a link, and the other player taps it to
join. Where there is a real choice, the options are laid out with a
**Recommended** pick and the reason for it. The decisions:

| Decision | Recommended | Alternatives |
|---|---|---|
| Hidden unless configured | Build-time `VITE_MULTIPLAYER_URL`; the code is not even in the bundle without it | Runtime `multiplayer.json`; build-time plus a health probe |
| Network model | **Deterministic lockstep**: only commands cross the wire | Host-authoritative state streaming; server-authoritative sim |
| Who keeps the clock | **Clients**: one turn message per tick, and the Worker relays | A metronome in the Durable Object |
| Invite link | `…/battledrones/#vs=K7QM2X` (fragment) | `?vs=` query; a path (no: Pages has no rewrites) |
| Server | One **Durable Object per room** (WebSocket Hibernation API, SQLite storage) | PartyServer on top of DOs; WebRTC with the Worker only for signalling |
| Sides | Host plays blue (lower left), guest plays red (top right); **swap on every rematch** | Same sides every rematch; random sides |
| Colours | **Fixed side colours**: blue is blue and red is red on both screens | Friend/foe (your own army always looks blue) |
| Orientation | **The same for both**: north up, no rotation | Rotate red's view 180° (later, if playtests call for it) |
| Reconnect | **Replay the command log** from tick 0 | Snapshot from the peer |
| Desync | Detect with checksums and end the match as "no contest" (v1) | Resync from a host snapshot (v2) |
| Career | A separate local Versus record; no XP, stars or medals | Count XP with a Versus medal |
| Battle records | **Kept forever**: an R2 record plus a D1 index row, ~20 KB gzipped each; the invite link becomes the replay link | D1 only; each room's DO storage |
| Old replays | **One archived build per sim hash** in R2 | Matching versions only; a Pages archive |

The phases are at the end. Phase 0 makes no visible change: it is the
groundwork that every option needs (cross-engine determinism, and a local
side that can be red).

## Goals

- **1v1 between friends over the internet**, phone to phone, on any map and
  with any mutators. A full skirmish with Uplinks, supply drops, calldowns and
  the Sky Hammer, the same as against the AI.
- **Invite by link.** The host taps *Challenge a friend*, gets a URL, and
  sends it with the phone's share sheet (Messages, WhatsApp, Discord…). The
  friend taps the link and is in the lobby. No accounts, no lobby browser.
- **Invisible unless configured.** A build without a Worker URL has no trace
  of multiplayer: no button, no help text, no network requests, no handling
  of invite links, no code in the bundle.
- **Cheap and small.** One Worker and one Durable Object class, a few hundred
  lines, inside Cloudflare's free tier for hobby traffic.
- **Fair.** The two sides are mirror images. The maps are point-symmetric and
  `tests/symmetry.test.ts` holds the rules to that.

## Non-goals (for now)

Matchmaking with strangers, accounts, ranked play, more than two players,
team games, playing across game versions, Ops, and co-op Last
Stand. Co-op Last Stand is the natural next step, and the lockstep layer
below would carry it unchanged.

AI models playing each other are in **AGENT-BATTLES.md**. Those battles run
in one process on one machine, so they need none of the Worker, WebSockets
or lockstep below.

## What the code already gives us

The README says it and DESIGN.md keeps the door open ("Online multiplayer (the
deterministic command-driven sim keeps the door open)"):

- **The sim is deterministic and command-driven.** `step(w, commands)` runs at
  a fixed 10 Hz. All input reaches the sim as plain-JSON `Command` objects
  (`src/sim/types.ts`). All randomness is `hash32(seed, salt, …)`
  (`src/sim/rand.ts`). Several tests replay matches identically from a seed
  plus commands (`infantry`, `objectives`, `openers`, `ops`).
- **The sim never trusts the client about who owns a unit.**
  `applyCommand` skips any unit whose faction isn't the command's faction.
- **The maps are point-symmetric**: red's half is blue's turned 180°, and
  openers are placed in each side's own frame (`frame(w, faction)` in
  `openers.ts`).
- **A match is short and the traffic is tiny.** Measured headless on this
  repo (Node, AI vs AI, normal difficulty, objectives on):

  | | Riverlands (56²) | Archipelago (108²) |
  |---|---|---|
  | `step()` cost | 0.44 ms/tick | 0.54 ms/tick |
  | Ticks played | 4,801 (blue won) | 6,000 (still going at 10:00) |
  | Commands from both sides | 1,398 | 2,023 |
  | Command JSON, whole match | 133 KB (~95 B each) | 193 KB |
  | Most commands in one tick, one side | 22 | 14 |
  | Entity state as JSON (units, buildings, projectiles, wrecks, powers, objectives) | 21 KB | 37 KB |

  Replaying a whole 10-minute match from scratch costs about 3 s of `step()`
  on a desktop CPU. A phone will be slower, so this needs measuring there,
  but it should be seconds, not minutes. That makes "rejoin by replaying the
  log" practical.

What's missing (all of it is Phase 0):

1. **The local side is fixed as blue.** `PLAYER: Faction = "blue"` is used
   about 125 times in 8 files, and `"red"` meaning "the enemy" appears 31
   times in 9 files under `src/game` and `src/ui`.
2. **Some setup runs outside `step()`.** `applyOpener` and the first
   `tickFog` are called in `GameScene`, in "mine first, then red" order.
3. **Pause and game speed are local** (`ctrl.paused`, `planTicks(…, speed)`).
   So is the debug fog toggle in the pause menu, which in a versus match
   would be a built-in maphack.
4. **The sim uses Math functions whose results can differ between engines.**
   See *Determinism across browsers* below. This is the biggest technical
   risk, because the most common pairing for a phone game is an iPhone
   (Safari, JavaScriptCore) against an Android phone (Chrome, V8).

## Invisible unless configured

The Worker URL is a build-time variable:

```bash
VITE_MULTIPLAYER_URL=wss://battledrones-mp.<account>.workers.dev npm run build
```

`vite.config.ts` reads it with `loadEnv`, so `.env.local` works too. It
then defines `__MULTIPLAYER_URL__` as a string literal, the same way it
already defines `__TERRAIN_REVS__`. `main.ts` loads everything about
multiplayer behind it:

```ts
declare const __MULTIPLAYER_URL__: string;
if (__MULTIPLAYER_URL__) void import("./net/versus-menu").then((m) => m.mount(menu, hashInvite()));
```

When the variable is unset, the condition is the literal `""`. Rollup drops
the dead branch and never emits the `net/` chunk. A `define` is safer here
than reading `import.meta.env.VITE_…` in the condition, because an unset env
key isn't guaranteed to fold to a constant. The dark-build test (see
*Testing*) checks this. Without the variable, that means:

- no *Challenge a friend* button, no Versus line in How to play, and no
  Versus record on the career sheet;
- a stray `#vs=…` link opens the normal menu (the hash is ignored);
- no WebSocket, `fetch` or DNS lookup towards any Worker;
- none of the multiplayer code in `dist/`. A test greps the build for it (see
  *Testing*).

How the published site gets the URL:

| Option | How | For | Against |
|---|---|---|---|
| **A. Build-time env** (recommended) | The Pages workflow passes `VITE_MULTIPLAYER_URL: ${{ vars.MULTIPLAYER_URL }}` (a repository *variable*, not a secret: it ends up in public JS anyway). Locally, `.env.local`. | Truly absent when unset. No extra request. Turning it off is one variable plus a redeploy. | Moving the Worker needs a rebuild. Historical versions are rebuilt from cached ZIPs (`tools/pages-archive.mjs`), so each `/vN/` keeps the URL it was built with. That is the right behaviour: an old version keeps talking to whichever Worker understands its protocol. |
| B. Runtime config | `build-pages.mjs` writes `/battledrones/multiplayer.json`, and the menu fetches it. | Turn it on, off or move it with no rebuild, and old versions follow. | A request on every menu load (a visible 404 when off). The code ships in every build. |
| C. A plus a probe | As A, but the button only appears after `GET /health` answers. | Hides multiplayer while the Worker is down or switched off. | A request and a short delay on every menu load, for a rare case. Failing on tap with "Multiplayer is unavailable right now" is enough. |

## The player's flow

### Host

1. **Menu, Skirmish tab**: a **👥 Challenge a friend** button joins the
   `Watch AI vs AI · How to play` row. It is hidden on the Last Stand and Ops
   tabs. It uses the map and mutators the menu already shows. Difficulty
   doesn't apply.
2. Tap it. The client calls `POST /rooms` and gets a room code and a secret
   seat token. The **lobby sheet** opens:
   - "Send this link to your opponent" with the URL, then **Share…**
     (`navigator.share`, the native share sheet on phones) and **Copy link**
     (`navigator.clipboard`). The code is also shown big (`K7QM 2X`) so it
     can be read aloud.
   - The map card, the mutators, "You play 🔵 blue, from the lower left",
     "Waiting for opponent… invite expires in 29:41", and **Cancel**.
3. **Sharing usually backgrounds the game** (the share sheet opens
   Messages). iOS freezes the page and soon drops its WebSocket. The room
   lives on the server, not on the socket, so nothing is lost. When the page
   becomes visible again, the client reconnects with its token. If the
   browser threw the page away, the next launch finds the open room in
   `localStorage` (`battledrones.versus`), not just `sessionStorage`, and
   reopens the lobby: "Your invite is still open".

### Guest

1. They tap the link. The game boots as usual, but `main.ts` sees
   `#vs=K7QM2X`. It strips the fragment with `history.replaceState`, keeps
   the code in `sessionStorage`, calls `GET /rooms/K7QM2X` (a preview that
   claims nothing) and shows a **Join sheet** in place of the menu: "⚔ Cadet
   Simon challenges you · Riverlands · Blitz mutator · You play 🔴 red, from
   the top right", then **Join match**
   and **Not now** (which goes to the normal menu).
   - The tap on Join is also the user gesture that unlocks audio and full
     screen. Both need a tap, so the sheet costs nothing.
   - **Expired**, **already started** or **full**: one line ("This invite has
     expired: ask for a new one") and the normal menu.
   - **Different game version**: see *Version gate*.
   - **The host opened their own link** (the same device, so the token is
     in storage): "That's your own invite. Send it to a friend."
2. Join opens the socket, claims the guest seat and gets a token. Both
   players now see the opponent's name and rank.

### Both

1. **Loading.** Each client downloads the map art (`loadTerrainArt`, a few
   MB per map) and reports its progress: "Opponent loading… 60%".
2. **Opener cards** (the existing picker) with a 20 s countdown. "Opponent
   has picked ✓" shows *that* they picked, not *what*. The server holds both
   picks and reveals them together. On a timeout, the client picks the first
   card the rules allow.
3. **Start.** The server sends `start`: a seed from `crypto.getRandomValues`,
   the map, the mutators, both openers and the input delay. Each client
   builds the same world with one shared function, `setupVersusWorld(start)`.
   It is used by both clients, by rejoin, and by the tests:
   `createMapWorld(map, { seed, objectives: true, mutators })`, then
   `applyOpener` for **blue and then red** (always that order, whoever is
   local), then `tickFog`. The opening harvest order for your own harvester
   goes through the command stream like any other order.
4. **The match.** The clock always runs at 1×. The speed chip, hold to
   fast-forward and the fog toggle are hidden. Pause and resign are in the
   pause menu (see *Pause, away and leaving*).
5. **The end.** Both clients see `world.winner` on the same tick. Each sends
   `over { winner, tick, checksum }`, and the server records the result if
   they agree. The finale and the after-action report play from your point of
   view. **Rematch** needs both players to tap it. It is a new seed in the
   same room with the sides swapped, back to the opener cards. **Menu**
   leaves the room.

### The invite URL

| Option | Example | Notes |
|---|---|---|
| **Fragment** (recommended) | `https://simonw.github.io/battledrones/#vs=K7QM2X` | The precached shell serves it instantly and offline. The fragment never reaches GitHub Pages or its logs. It works on any version path. |
| Query | `…/battledrones/?vs=K7QM2X` | Workbox's precache lookup only ignores `utm_*` and `fbclid` by default, so this misses the cache unless `ignoreURLParametersMatching` gets `/^vs$/`. Otherwise it's equivalent. |
| Path | `…/battledrones/vs/K7QM2X` | No: GitHub Pages has no rewrites, so it would need a `404.html` trick. |

The link is the host's `location.origin + location.pathname` plus the
fragment. A host playing an archived `/v9/` invites to `/v9/`.

**Room codes** are 6 characters from Crockford's base32 alphabet (no
`0/O/1/I/L/U`), about 10⁹ codes. Rooms expire after 30 minutes unjoined, and
room creation is rate-limited, so guessing a code is impractical. A guessed
code would only let a stranger take the guest seat of an open invite, which
is annoying but harmless. If that ever matters, the host can approve the
guest ("Cadet Bob wants to join · Accept"). Once a battle has been played,
its code is never reused, because the same link then opens its replay (see
*Battle archive and replays*).

## Network model

| | **A. Deterministic lockstep** (recommended) | B. Host-authoritative streaming | C. Server-authoritative sim in the DO |
|---|---|---|---|
| What crosses the wire | Commands only (~100 B each, ~2,000 a match) | World state from the host's phone to the guest at ~10 Hz | World state from the DO to both clients |
| Bandwidth | A few hundred KB a match | 20–37 KB a snapshot as JSON. Workable with deltas and binary encoding, but heavy on mobile data | The same as B, to both players |
| Feel | Both players see their own orders after the same delay (~250 ms, hidden by instant local feedback) | The host plays with no delay and the guest with a full round trip. That's unfair | Both get a round trip |
| Client changes | The renderer keeps reading a local `World` as it does now | The guest renders snapshots instead of running the sim. Every presenter reads `world` and `w.fx` directly: chronicle, juice, callouts, voices, music mood | The same rewrite as B, for both players |
| Server | A relay (~300 lines) | A relay | Runs `step()` at 10 Hz per room. The sim is engine-free TS, so it bundles fine, but rooms are always awake |
| Maphack | Possible: both clients hold the whole world | Possible on the host | **Impossible**: the server can send only what each side sees |
| Desync | Possible, so it needs cross-engine determinism and checksums | Impossible | Impossible |
| Reconnect | Replay the log, or take a snapshot | A snapshot | A snapshot |

**Why A.** The game was built for it, and the presentation layer stays as it
is. Only commands are sent, so the cost of a match doesn't grow with army
size. Both players get the same delay. The two real costs are cross-engine
determinism (needed anyway for trustworthy replays and Daily Op parity) and an
accepted maphack risk. Between friends who swapped a link, a maphack is a
reasonable thing to accept. C is the only real cure, and a later upgrade path
exists (see *Later*).

WebRTC data channels, with the Worker only signalling, would give
peer-to-peer latency. But carrier-grade NAT on mobile networks often needs a
TURN relay anyway, which adds a second service and more failure modes. That
makes it a possible later optimisation behind the same lockstep layer, not a
starting point.

## Lockstep

### Turns and input delay

A **turn is one tick** (100 ms). At the start of tick *k*, each client sends
exactly one message for turn *k + D*: the commands its player issued since
the last message, usually none. Then it runs tick *k* with both players'
commands for *k*. A client may run tick *k* only once it holds **both**
players' turn *k*. Turns 0 to *D − 1* are empty by definition, so both
players can start at once.

```ts
// GameScene.update, versus branch (replaces the AI / drainCommands path)
for (let i = 0; i < plan.ticks; i++) {
  if (!net.ready(world.tick)) { stall.mark(); break; }        // the peer's turn hasn't arrived
  net.send(world.tick + net.delay, ctrl.drainCommands());     // my turn k + D (often empty)
  step(world, net.commandsFor(world.tick));                   // blue's then red's, canonical order
  if (world.tick % 10 === 0) net.checksum(world.tick, worldHash(world));
  this.afterTick();
}
```

**D** is fixed when the match starts, from a few pings in the lobby. A
command has to cross from one player to the server to the other player, so it
needs about the average of the two round-trip times, plus a margin for jitter:
`D = clamp(ceil((rttHost / 2 + rttGuest / 2 + 60 ms) / 100 ms), 2, 6)`. In one
region that's 2–3 ticks, so an order takes effect 250–350 ms after the tap.
Across continents it's 4–6 ticks. Changing D during a match needs both sides
to agree on a turn, so it waits for v2.

**Local feedback hides the delay**, the same trick RTS games have always
used. Selection, the camera, the placement ghost, the waypoint ring
(`ctrl.lastFeedback`) and the unit's voice line ("Moving out") all happen at
the tap. Only the unit moving waits for the turn. Build buttons show the
queued state at once. A placed building shows its ghost as "placing…" until
its turn runs.

### Who keeps the clock

| | **1. Clients pace, the server relays** (recommended) | 2. A metronome in the Durable Object |
|---|---|---|
| How | The scheme above. The DO checks each turn, stamps it with the sender's side, logs it and forwards it | The DO runs a 100 ms `setInterval`, stamps incoming commands with a tick, and broadcasts each tick's commands to both players |
| Pace | The slower player or link sets it: both stall together. That's fair between friends | The server's clock sets it. A lagging client falls behind and has to fast-forward, which is jarring |
| Server code | No timers. The server barely knows about ticks | Timer, catch-up and pause logic in the DO, and timer jitter adds to the delay |
| Hibernation | Can hibernate whenever no message is being handled (lobby, pauses, between messages) | A live timer keeps the object in memory, so it is billed for the whole wall-clock time of every match |
| Incoming messages (billed) | 2 players × 10 a second | Commands plus about one ack a second |

The two cost about the same on the free tier (see *Costs*). Option 1 wins on
simplicity and fairness.

### Clock drift and stalls

Each client runs its own 10 Hz clock (`planTicks` at speed 1). Two phones'
clocks drift, and lockstep turns drift into small stalls on the faster
phone. The fix is the usual jitter buffer. A client tracks how many turns
ahead its peer's messages are. If it keeps stalling, it runs 2% slow. If the
peer's turns pile up (this client is behind, for example after a dropped
frame), it runs up to two extra ticks a frame until it catches up.

A stall shorter than 500 ms shows nothing: units hold their last
interpolated pose, and effects, music and the camera carry on. After that, a
quiet "Waiting for opponent…" chip appears.

### What's in the command stream

- Every existing `Command`. **The server overwrites `faction` with the
  sender's seat.** A seat can only ever command its own side, whatever the
  client sends.
- **New: `{ type: "resign"; faction }`.** The sim sets `winner` to the other
  side. It rides the stream so both clients end on the same tick and run the
  same finale.
- Nothing else. Pause, away and chat are lobby messages, not sim input. In
  lockstep, two clients that stop on different ticks are fine, because a
  stall is always safe. What has to match is the commands each tick gets,
  not when each client happens to stop.

### Pause, away and leaving

| Situation | Behaviour |
|---|---|
| **Pause** (pause menu) | Each player has **2 pauses of up to 60 s** a match. Both screens show "Paused by Simon · 0:52", and either player can resume. When the timer runs out, the match resumes by itself. The alternative is no pausing in versus, but phones get calls. |
| **Away** (the app goes to the background: `visibilitychange` → hidden) | The client sends `away` as a best effort, and the server also notices a closed socket. The opponent sees "Opponent stepped away · 1:30 to return". The game is stalled anyway, because no turns arrive. |
| **Back** | If the socket survived, the game carries on. If not, it reconnects with its token and catches up the missing turns (see *Reconnect*). |
| **Gone for good** (the timer runs out) | The opponent chooses: **Claim victory** (recorded as a forfeit), **Play on vs AI** (see below) or **Keep waiting**. |
| **Resign** | A sim command, so both clients see the normal finale. |

**Play on vs AI.** Once the other player has gone, nothing needs to stay in
lockstep. The remaining client can hand the absent side to
`createAiState(…)` and carry on as a single-player match. The commander is
pure sim code that reads the world through fog, so it should cope with
starting mid-match. That needs a test.

### Desync detection

Every 10 ticks, each client hashes the world (`src/sim/checksum.ts`) and
sends the hash with its next turn. The peer compares it with its own hash for
that tick, and the server sees both as they pass through.

The hash is `hash32` over the exact float bits, not rounded values, so a
difference in the last bit is caught at once rather than minutes later. It
covers the tick, `nextId`, each unit (id, kind, faction, x, y, hp, order type,
cargo), each building (id, hp, queue head, progress), the projectiles, the
wrecks, each side's scrap, the meters and the objectives. That's a few hundred
numbers, cheap every 10 ticks.

When the hashes differ:

| Option | |
|---|---|
| **v1: no contest** (recommended to start) | Both screens say "The match fell out of sync, sorry! No result." with **Copy debug info**: the seed, the settings, the full command log, both hash trails and the user agents. The log reproduces the match exactly, so the bug can be replayed in Node, Chromium and WebKit to find the first tick that differs. |
| v2: resync from the host | The host serialises its world (`Map`s and typed arrays need a small encoder; derived caches like `regionCache` rebuild themselves) and the guest swaps it in. The match goes on, but from then on it is host-authoritative. |

### Reconnect

The DO keeps every **non-empty** turn (most turns are empty, about 2,000 rows
in a long match) and each player's high-water mark.

- **The socket dropped but the page is alive** (the common case on phones).
  It reconnects with `hello { token, have: lastTurn }`, and the server sends
  the peer's turns after `have`.
- **The page was reloaded or discarded.** At boot, `localStorage` has a
  live seat. Then **Rejoining… 64%**: `resume` brings the settings, the
  openers and every non-empty turn, and the client runs `setupVersusWorld`
  and fast-forwards with rendering off (`GameScene.step(ms, n)` already
  exists for tools). That's about 3 s for a 10-minute match on a desktop,
  probably 2–4× slower on a phone. It also checks determinism for free.
- **The alternative** is a snapshot from the peer. It's faster for very long
  matches, but it needs the world encoder from desync v2, and the peer's
  phone has to be awake to send it.

While a player rejoins, the other sees "Opponent reconnecting…" with that
player's progress.

## Determinism across browsers

ECMAScript leaves most `Math` functions *implementation-approximated*. V8
(Chrome, Android, Edge and Cloudflare's workerd) and JavaScriptCore (every
iOS browser) don't promise the same last bit for `Math.sin`, `cos`, `atan2`,
`hypot`, `pow`/`**`, `exp` or `log`. One differing bit in a unit's position
changes a target, a path and then the match. `src/sim` currently uses:

| Function | Calls | Where |
|---|---|---|
| `Math.hypot` | ~70 | combat, movement, transport, objectives, powers, economy, AI… |
| `Math.sin` / `Math.cos` | ~20 | movement, transport, powers, Condor and airlift AI |
| `Math.atan2` | ~10 | movement, combat, powers, openers, economy, lifeline, survival |
| `Math.pow`, `**` | 2 | survival, fog |

These are always safe: `+ − × ÷` (IEEE 754, and JS engines never fuse
`a * b + c`), `Math.sqrt` (it compiles to the hardware square root, which
IEEE 754 requires to be correctly rounded), `floor`, `ceil`, `round`,
`trunc`, `abs`, `min`, `max`, `sign`, `imul` and `fround`.

The plan (Phase 0, worth having even with no multiplayer: replays and the
Daily Op stop depending on which browser ran them):

1. **`src/sim/fmath.ts`**: `hypot(x, y) = Math.sqrt(x * x + y * y)`, and
   `sin`, `cos` and `atan2` as fixed polynomial approximations built from
   arithmetic only. Gameplay needs maybe 1e-7 accuracy (headings, scatter,
   orbit points), and these give the same bits on every engine. Change
   `x ** 2` to `x * x`. Results move by noise, so re-run the balance and
   pacing panel once to confirm nothing shifts.
2. **A ban test** (`tests/determinism.test.ts`) that reads `src/sim/**/*.ts`
   and fails on `Math.(sin|cos|tan|atan2?|asin|acos|hypot|pow|exp|log\w*|cbrt)`,
   on `**`, and on `Math.random` outside `createAiState`'s default.
3. **A cross-engine replay check** (`tools/determinism.mjs`): run a recorded
   AI-vs-AI match (seed plus command log) in Chromium, WebKit and Firefox
   through Playwright, and compare the hash trails tick for tick. Run it in
   CI (`npx playwright install webkit firefox`). This is the test that would
   have caught `Math.hypot`.
4. **Other hazards, already fine (keep them that way):** `Map` and `Set`
   iterate in insertion order. `Array.prototype.sort` is stable everywhere,
   so with consistent comparators all 23 sorts in the sim match. No `Date`
   or locale functions. `incomeMult` is only set by the AI's difficulty and
   stays 1 in versus.

## Playing red

### The local side

Change `export const PLAYER` in `controller.ts` to
`export let PLAYER: Faction = "blue"` plus `setPlayer(f)`. ES module live
bindings mean every importer reads the current value, so the ~125 existing
uses don't change. Then go through the 31 `"red"` literals in `src/game` and
`src/ui` and change each one that means "the enemy" to `ENEMY`
(`other(PLAYER)`). These are in chronicle, awareness, callouts, the
objectives renderer, calldown credit, `GameScene`, career and the report.
The ones in `three/models.ts` pick the red side's paint, and stay.

A dev-only switch (`import.meta.env.DEV` and `?side=red`) plays **as red
against a blue AI**. Every red-side bug can be found this way without a
network.

### Colours

**Recommended: fixed side colours.** The blue side's army is royal blue and
the red side's is crimson, on both screens, whoever is looking. Two friends on
a call can say "your red tanks", spectators and replays show exactly what the
players saw, and screenshots from the two phones match.

The game uses two kinds of colour, and each keeps its own rule:

- **Team colours say which army.** They follow the side. The models' team
  paint (`three/models.ts`), the combat rings and death pulses (`TEAM` in
  `render/juice-view.ts`) and the minimap's Uplink pips already do. The
  **minimap's unit dots** don't: they colour yours `#9fd0ff` and theirs
  `#ffb0a0` (`ui/hud.ts`), so a red player's crimson army would show as blue
  dots. They change to side colours, with your own dots a little brighter so
  they're still easy to pick out. That is the only colour change.
- **Signal colours say good or bad for you.** They stay relative to the local
  player: health bars (yours green, then amber and red as they drop; theirs
  red), edge arrows (red when you're hit, amber when you attack), enemy
  strike warnings in red and yours in yellow, and the announcer. For the red
  player, red then sometimes means "my army" and sometimes "danger". That's
  the usual trade-off in RTS games with fixed colours, and the shapes and
  positions of the cues carry the meaning.

**The alternative: friend/foe colours**, where your own army always looks
blue on your screen. Every signal colour then agrees with the team colours,
but the two screens stop matching, players can't talk in colours, and
replays have to pick one scheme. If every team colour goes through one
`teamColour(faction)` helper, it can be added later as a setting.

### View orientation

**Recommended: the same view for both.** North is up on both screens. Blue's
base is in the lower left and red's is in the top right, as the maps are
already laid out. This is how StarCraft, Command & Conquer and Age of Empires
work: players spawn top or bottom and the camera never turns. It needs no
work beyond the local side above. `frameStart` already frames either side's
HQ clear of the HUD, the edge arrows already point every way (south too, at
fights behind the camera), and the lighting is the same for both.

The known cost is a small asymmetry, so it's worth watching in playtests:

- **The tilted camera shows more ground above the centre of the screen than
  below it.** With the camera's pitch of 62° zoomed out to 47° zoomed in and
  its 34° field of view, that's about 1.4× zoomed out and 1.8× zoomed in. The
  difference in area is bigger still, because the top edge of the view is
  wider. From blue's base, the deep part of the view looks towards the enemy.
  From red's base, it looks out past the map edge, and attacks arrive through
  the shallow bottom of the screen.
- **On a phone held upright, the bottom of the screen is the build bar and
  selection panel**, which is where red's attacks come in.

Players pan anyway, and the edge arrows and the ⚡ jump button bring a fight
to the centre of the screen. **Swapping sides on every rematch** (see
*Results, career and rematch*) evens out what's left over a session.

**If playtests show red plays worse: rotate red's view 180°**, so red sees
their base at the bottom as blue does. The two screens then stop matching
(blue's "top right" is red's "lower left"), and spectators and replays pick
one orientation. The work:

- **Camera and input.** A `flip` flag on `CameraRig`: put the camera on the
  other side of the look-at point and negate `pan`. `project`/`unproject` go
  through the camera matrices, so picking, edge arrows, `viewQuad` and the
  placement ghost follow on their own. Draw the minimap rotated
  (`setTransform(-1, 0, 0, -1, w, h)`) and invert its taps.
- **Lighting, with no new art.** Rotating the camera alone isn't enough: the
  painted terrain bakes in a hillshade lit from the upper left
  (`art/terrain.py`), and lit from below, mesas can read as pits. The maps
  are point-symmetric, so the tile at *p* is the same as the tile at
  *rot(p)*, and so are the heights derived from it. Under the rotated camera,
  red's terrain can **sample the painting with its UVs rotated 180°**
  (`uv → 1 − uv` per chunk, reading the mirrored chunk). Red's screen then
  shows exactly the image blue's does, still lit from the upper left. Turn
  the real-time sun 180° too, so unit and building shadows agree with it.
- **Decoration.** Trees, crags and doodads are placed by a per-tile hash, so
  under the rotated paint they would no longer sit on their painted canopy
  and shadows. Hash the canonical half instead (`hash(min(p, rot(p)))`, with
  the offset mirrored), which also makes the decoration itself symmetric. If
  that turns out ugly, a second painted set per map (`art:terrain --red`) is
  the fallback. Only red downloads it, but it doubles the art to maintain.

## The Worker

### Layout

```
worker/
  package.json        # wrangler as a dev dependency (kept out of the game's npm ci)
  wrangler.jsonc
  src/index.ts        # routes, Origin/CORS check, rate limits → Room
  src/room.ts         # the Durable Object: seats, lobby state machine, relay, log
  test/room.test.ts   # Room logic with fake sockets (plain vitest)
src/net/protocol.ts   # message types + validators, imported by the client AND the worker
```

Keeping the Worker in this repo, rather than its own repo, lets it import
`src/net/protocol.ts` (and `Command` from `src/sim/types.ts`) for validation,
so the wire format can't drift between the two.

```jsonc
// worker/wrangler.jsonc
{
  "name": "battledrones-mp",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],
  "vars": { "ALLOWED_ORIGINS": "https://simonw.github.io,http://localhost:5173" }
}
```

To deploy, run `npx wrangler deploy` from `worker/` by hand. An optional
`worker.yml` workflow can deploy on changes to `worker/**`, using a
`CLOUDFLARE_API_TOKEN` secret. For local development, `wrangler dev` (port
8787) plus `VITE_MULTIPLAYER_URL=ws://localhost:8787` in `.env.local`.

**Raw Durable Objects or PartyServer?** Cloudflare's `partyserver` library
wraps DOs with rooms and connection helpers. For one room type and a dozen
message kinds, the raw API is about as short and adds no dependency, which
matches the repo's one-dependency habit. **Recommended: raw.**

**Where it lives:** `*.workers.dev` is free and needs no DNS. A custom domain
(`mp.example.com`) can be added later without a client change if the client
reads the URL from the env.

### Endpoints

| Route | |
|---|---|
| `POST /rooms` `{ proto, sim, map, mutators, name? }` | Make a code, `idFromName(code)` (retrying on the rare collision), set up the room. Returns `{ code, token }`. |
| `GET /rooms/:code` | A preview for the Join sheet: `{ state: waiting \| playing \| over, map, mutators, host: { name, rank }, sim }`, or 404 if it expired. Claims nothing. |
| `GET /rooms/:code/socket?token=…` (WebSocket upgrade) | A token rejoins its seat. No token claims the free guest seat (409 if there isn't one). |
| `GET /health` | For option C of the config, and for monitoring. |

Every route checks `Origin` against `ALLOWED_ORIGINS` and answers CORS. Room
creation is rate-limited per IP with the Workers rate-limiting binding, for
example 10 an hour.

### The Room object

It uses the **WebSocket Hibernation API**. Between messages the object can
be evicted from memory while both sockets stay connected, and idle time isn't
billed. That shapes the code: anything that has to outlive a message goes in
the socket attachment (`serializeAttachment`) or in SQLite storage, never
only in a field.

```ts
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const seat = await this.claimSeat(new URL(req.url).searchParams.get("token"));
    if (!seat) return new Response("room full", { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [seat.side]);      // hibernatable, tagged "blue" / "red"
    server.serializeAttachment({ side: seat.side });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const { side } = ws.deserializeAttachment() as { side: Faction };
    const msg = parseClientMessage(raw);                // protocol.ts: shape, sizes, finite numbers
    if (!msg) return ws.close(1008, "bad message");
    if (msg.t === "turn") {
      for (const c of msg.c) c.faction = side;          // a seat only ever commands its own side
      if (msg.c.length) this.logTurn(side, msg);        // non-empty turns → SQLite, for rejoin
      this.markHigh(side, msg.n);
      for (const peer of this.ctx.getWebSockets(other(side))) peer.send(JSON.stringify(msg));
      return;
    }
    await this.lobby(side, msg);                        // hello, pick, loaded, pause, away, over, rematch…
  }

  async webSocketClose(ws: WebSocket) {
    this.tellPeer(ws, { t: "peer", state: "away" });
  }

  async alarm() {
    // an unjoined room after 30 min, a finished one after 10 (its record is already archived), an abandoned one after 2 h
    await this.ctx.storage.deleteAll();
  }
}
```

The lobby's states are `waiting → joined → loading → picking → playing ⇄
paused → over`, and `over → picking` on a rematch. Each transition is saved,
so a hibernated room wakes up where it was.

### Validation and abuse

- **The faction is stamped by the server** (above). This is the one rule
  that matters. The sim already ignores orders for units that aren't the
  command's faction's.
- **The shape is checked in `protocol.ts`**, shared with the client: only
  known command types; ids are integers; `x`/`y` are finite and inside the
  map; at most 200 `unitIds` per command and 32 commands per turn; at most
  8 KB per message. A `NaN` would be deterministic, but it could still wedge
  both games, so it never gets in.
- **Turns must be monotonic.** Turn `n` must be exactly the next one for that
  seat, with no gaps or replays.
- **Rate cap.** More than about 40 messages a second on a socket closes it.
- **Version gate.** `sim` is a hash of `src/sim/**` plus `protocol.ts`,
  computed in `vite.config.ts` the same way `terrainRevisions()` works and
  exposed as `__SIM_HASH__`. The room locks to the host's hash, and a guest
  with a different one gets `error: version`. Hashing the sim, not the
  commit, means two builds that only differ in UI can still play each other.
  The Join sheet then runs `appUpdate`. If a newer build is waiting, it
  reloads into it with the `#vs=` restored. Otherwise: "Your friend is on a
  different version: ask them to update (Menu → Update ↻)".
- **What a cheater can do anyway**: read the whole world (the maphack, which
  we accept), or stall the game, which the away timer limits. Speed hacks
  can't work, because every tick needs both players' turns.
- **Stored data**: room state, seat tokens, display names and the command
  log. When the room expires, its own copy is deleted and the seat tokens go
  with it. The battle record moves to the archive (see *Battle archive and
  replays*). No IPs beyond Cloudflare's own logs.

### Costs

Cloudflare's Workers Free plan includes Durable Objects, with **100,000
requests a day** and **13,000 GB-s of duration a day**. Incoming WebSocket
messages count as requests at **20:1**, outgoing messages are free, and an
object that is idle and able to hibernate isn't billed for duration
([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
Check these before relying on them. For a 10-minute match:

| | Clients pace (recommended) | DO metronome |
|---|---|---|
| Incoming messages | 2 × 10/s × 600 s = 12,000, billed as **600 requests** | ~2,000 commands and acks, billed as ~100 requests |
| Duration | Only while handling a message: about **a few GB-s** | 600 s × 128 MB, about **75 GB-s** |
| Free matches a day | **~160** (requests run out first) | ~170 (duration runs out first) |

Both are plenty for a game played between friends. The $5 Workers Paid plan
covers far more. To raise the client-paced ceiling, send a turn every 2 ticks
(it halves the requests and adds about 50 ms of delay), or merge runs of
empty turns into one message.

## Protocol

JSON text frames. Every message has `t`. Commands are the sim's own
`Command` objects, unchanged.

**Client → server**

| `t` | Fields | |
|---|---|---|
| `hello` | `proto, sim, token?, name?, rank?, have?` | The first message on every socket |
| `ping` | `at` | Measures the RTT, used to pick D |
| `loaded` | `pct` | Map art progress |
| `pick` | `opener` | Held until both players have picked |
| `turn` | `n, c: Command[], h?` | One per tick. `h` is the checksum every 10th tick |
| `pause` / `resume` | — | Counts against the pause budget |
| `away` / `back` | — | Visibility changes |
| `over` | `winner, tick, h` | Both report, and the server compares |
| `claim` | — | Claim victory after the away timer |
| `rematch` / `leave` | — | |

**Server → client**

| `t` | Fields | |
|---|---|---|
| `welcome` | `side, token, room: { map, mutators, host, guest, state }` | |
| `peer` | `state: joined \| loading \| picked \| away \| back \| left, pct?, name?, rank?` | What the opponent is doing |
| `start` | `seed, map, mutators, openers: { blue, red }, delay` | Tick 0 |
| `turn` | (the peer's turn, with the faction stamped) | |
| `resume` | `start, turns: [non-empty…], high: { blue, red }` | After a rejoin |
| `paused` / `resumed` | `by, until?` | |
| `desync` | `tick` | |
| `result` | `winner, reason: hq \| resign \| forfeit \| desync` | |
| `error` | `code: full \| expired \| version \| bad \| rate` | |
| `pong` | `at` | |

`proto` versions the envelope. A Worker serves every protocol version still
in use by archived `/vN/` builds, or answers `error: version` to the ones it
has dropped.

## Client code

New code, all of it loaded only through the `MULTIPLAYER_URL` dynamic import:

| File | |
|---|---|
| `src/net/config.ts` | `MULTIPLAYER_URL` from `__MULTIPLAYER_URL__` (`main.ts` itself only tests the constant) |
| `src/net/protocol.ts` | Message types and validators, shared with the Worker |
| `src/net/session.ts` | The socket, reconnect with backoff, the token store, ping/RTT, visibility handling |
| `src/net/lockstep.ts` | The turn buffer, input delay, drift control, checksum exchange. Engine-free and tested |
| `src/net/versus-menu.ts`, `src/ui/versus.ts` | The button, lobby, Join sheet, waiting/away/rejoin overlays, ping chip |
| `src/sim/checksum.ts`, `src/sim/fmath.ts` | Pure and tested. These are Phase 0, in the main bundle, and are not "multiplayer code" |

Changes to existing code:

- **`GameScene`**: a `net` hook. The versus branch of `update()` (above)
  replaces the `tickAi`/`drainCommands` path. The opener cards send a
  `pick` and wait for `start`. There is no AI, and `holdStart` lasts until
  `start` arrives.
- **`controller.ts`**: `PLAYER` becomes a live binding, and `ENEMY` is added.
- **`hud.ts` / `ui/awareness.ts`**: in versus, hide the speed chip, hold to
  fast-forward, the fog toggle and the difficulty line. The pause sheet gets
  the pause budget, **Resign**, and "vs Simon · Riverlands" in place of the
  AI line.
- **`announcer.ts` / `callouts.ts`**: a few lines, such as "Enemy commander
  has joined the field" and "Enemy commander has left the battle".
- **`report.ts` / `career.ts`**: the report from your point of view, with
  the opponent's name in place of the AI personality.

## Results, career and rematch

| Option | |
|---|---|
| **A separate Versus record** (recommended) | A local "Versus 5–3" on the career sheet, plus the last opponent's name. No XP, stars or medals, because two friends could farm them. |
| XP with a "Versus" medal | More reward, but it changes the meaning of ranks. Could be added later. |

**Rematch swaps sides.** The host plays blue in the first match, red in the
second, and so on, so each player gets both starts and the top-or-bottom
difference (see *View orientation*) evens out over a session. The server
assigns sides, so this is one line, and the opener cards say which side
you're on this time ("You play 🔴 red, from the top right"). Keeping the same
sides every time is the alternative.

## Battle archive and replays

**In short:** storing every battle forever is close to free. A battle's
record is about 20 KB gzipped. The hard part is that a record replays
faithfully only in a build with the **same sim code**, and the sim changes
often: 37 of the last 132 commits touched `src/sim`. So the real work is
keeping old builds playable, not storing the logs.

### What a battle record holds

```jsonc
{
  "v": 1,
  "code": "K7QM2X",
  "commit": "cddf6e2…", "sim": "3f9a…", "proto": 1,  // which build played it
  "startedAt": "2026-10-11T18:02:11Z",
  "map": "riverlands", "mutators": [], "seed": 1803442113,
  "openers": { "blue": "blitz", "red": "air-wing" },
  "players": { "blue": { "name": "Simon", "rank": "Captain" }, "red": { … } },
  "delay": 3,
  "turns": [[142, "blue", [/* Command… */]], …],     // non-empty turns only
  "hashes": [/* every 100th tick, both sides */],
  "end": { "tick": 7012, "winner": "blue", "reason": "hq" },
  "recap": { /* the after-action numbers, see Logs for coding agents */ }
}
```

Measured from AI-vs-AI matches (Node, normal difficulty, seed 4321, both
matches still going at 10:00):

| | Riverlands | Archipelago |
|---|---|---|
| Ticks | 6,000 | 6,000 |
| Ticks with any command | 285 | 290 |
| Turns as JSON | 144 KB | 181 KB |
| **gzipped** | **18 KB** | **20 KB** |

Human players will issue more, smaller orders than the AI's bursts. Still,
expect tens of KB per battle, not hundreds.

Agent battles (AGENT-BATTLES.md) write records in nearly the same shape, so
the two should share one format and one replay viewer.

### Where it goes

When a battle ends (an agreed `over`, a claim, a forfeit or a desync), the
Room DO writes the record and its index row, and only then lets its alarm
clear the room's own storage.

| Option | |
|---|---|
| **R2 for the records, D1 for the index** (recommended) | Each record goes to R2 at `battles/K7QM2X.json.gz`. D1 gets one small row per battle (code, dates, map, mutators, players, winner, reason, length, commit, sim hash and the recap's headline numbers) for listing and SQL. D1's free plan caps each database at 500 MB, which is why the records themselves don't go there. |
| D1 only | One binding instead of two. About 25,000 records fill a free 500 MB database, then you shard or move them. |
| Each room's own DO storage | No new services, but nothing can list across rooms, so admins and agents couldn't browse. |

Free-plan cost at 100 battles a day: R2 grows by about 2 MB a day, 0.7 GB a
year, against 10 GB-month free with no egress fees. D1 writes 100 rows a day,
against 100,000 a day allowed. R2 does 100 writes a day, against 1 million a
month. It stays effectively free until there are thousands of battles a day
([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

### Replaying from the original link

The invite link becomes the battle's permanent address. `#vs=K7QM2X` opens
on whatever state the room is in:

- **waiting**: the Join sheet, as above;
- **playing**: "Match in progress" (a live watch link is Phase 3);
- **over**: **▶ Watch replay · Simon beat Bob in 11:42 · Riverlands**;
- **deleted**: the normal menu, plus one line saying so.

This means **codes are never reused.** The D1 index has the code as its
primary key, and `POST /rooms` skips codes already taken. There are about
10⁹ codes, against roughly 36,500 battles a year at 100 a day. A permanent
replay link is an unlisted link, so `GET /rooms/:code` is rate-limited per IP
(for example 60 an hour). At that density, finding one real battle by
guessing takes about 27,000 tries per year's worth of battles, which is
weeks per IP. If replays should be properly private, use 8-character codes
(about 10¹²). Players should know battles are kept: the lobby says "Battles
are saved: anyone with this link can watch the replay."

**The viewer** is the existing AI-vs-AI spectator mode (fog off by default,
up to 4× speed), fed by the record's turns instead of `tickAi`. It adds:

- **Seeking.** Forward steps the sim with rendering off (a whole match in a
  few seconds). Backward uses keyframes taken every 30 s as the replay
  plays: `structuredClone(world)` handles the `Map`s and typed arrays.
- **"Through Simon's eyes"**: set `PLAYER` to that side and turn fog on, and
  the screen shows exactly what that player saw.
- **The hash trail is checked as it plays.** If the replay drifts from the
  battle, it says "⚠ This replay diverged at 4:12" rather than showing a
  fiction.
- The after-action report at the end, from `chronicle.ts`, as after a live
  match.

A replay watched in another browser needs the same cross-engine determinism
as a live match. A battle between two Chrome phones has to replay
identically in an admin's Safari, which Phase 0 provides.

### Old versions

| Option | How | Cost |
|---|---|---|
| **A. One archived build per sim hash** (recommended) | After building, the Pages workflow uploads `dist/` to R2 under `builds/<simhash>/`. The newest build with a given sim hash replaces the older one, so renderer fixes reach old replays. Files are stored once each by content hash, with a manifest per build mapping paths to hashes. The Worker serves `/b/<simhash>/<path>` from the manifest. When the current game opens a replay with a different sim hash, it redirects to `/b/<simhash>/#replay=K7QM2X`. | The three.js chunk (734 KB) and the map art (11 MB of the 16 MB build) rarely change, so they dedupe away. A new sim version adds about the main JS, CSS and HTML (~0.7 MB). At this month's rate of about 40 sim versions, that's ~30 MB a month in R2. About a day or two of pipeline and Worker work. |
| B. Extend the Pages version archive | Publish `/battledrones/s/<simhash>/` the way `/vN/` tags are, with ZIP reuse. | Each full build is 16 MB, and Pages sites are meant to stay under 1 GB, so that's about 60 versions. Sharing the art between versions would bring back the repainted-map bug that the terrain revision hashes fixed. Not recommended. |
| C. Matching versions only | Record everything permanently, but the browser only plays records with its own sim hash. Others say "This replay is from an older version of the game". | Free, and a good first step. At this repo's pace most replays would stop playing in the browser within days, but agents can still use every one (below). |
| D. Record what the screen needs, not commands | Snapshots and events, mostly version-proof. | Megabytes per battle, plus a render format the renderer would have to keep reading forever. No. |

### Admins

- `/admin` on the Worker sits behind **Cloudflare Access** (Zero Trust login
  by email one-time PIN, free for small teams). The Worker writes no login
  code: it only verifies the `Cf-Access-Jwt-Assertion` header.
- A list from D1 shows date, players, map, mutators, winner, reason, length
  and version. Each row links to **▶ Watch** (the right archived build),
  **⬇ Record** and **Delete**.
- Filters by map, by version, and **desyncs only**. That last one makes the
  archive a debugging tool: every desync arrives with the full log that
  reproduces it.

### Logs for coding agents

There are two layers, one cheap and one thorough.

1. **The recap row: SQL with no re-simulation.** At the end, each client
   sends the numbers it already worked out for the after-action report:
   openers, units built and lost by kind, scrap harvested and salvaged,
   calldowns, Uplink time, the chronicle's first blood, biggest battle and
   turning point. The DO stores them if both clients agree. That answers
   questions like these:
   - What is blue's win rate against red across all human battles? This
     checks with real players the fairness that the symmetry tests assert.
   - What is the win rate by opener, and by opener pairing?
   - What is the median battle length per map, against the ~10-minute
     pillar?
   - How often is the Sky Hammer fired, and does the side that fires first
     win?

   Access is `GET /admin/battles.ndjson?since=…` with a Cloudflare Access
   service token, or `wrangler d1 execute` directly.
2. **Full re-simulation: `tools/battles.ts`.**
   - `pull [--since]` downloads records into `battles/` (gitignored).
   - `replay <record>` makes a temporary `git worktree` at the record's
     commit and runs the replay headless there with vite-node. That works
     for **any** record, archived build or not. It checks the hash trail and
     writes per-minute stats: army value, scrap, income, unit mix, Uplinks
     held. These are the numbers `tools/pacing.ts` reports for AI matches,
     plus the chronicle's story (`chronicle.ts` is engine-free).
   - `aggregate` builds tables like DESIGN.md's pacing panel, for human
     battles.
   - `branch <record> --at 4:00 --tune '{…}'` plays the battle to 4:00, then
     hands both sides to the AI commander under a tweak. For example: would
     this comeback still happen with Mastodons at 1,100 HP? This is the only
     kind of what-if a log supports. Re-running the human orders under
     different numbers diverges almost at once, because the orders name
     unit ids that no longer exist, and the players would have reacted
     differently anyway.

None of this needs infrastructure beyond the archive, and the agents'
compute is local.

## Testing

- **Unit** (vitest, in `npm test`): protocol validators (fuzzed); the
  lockstep buffer under seeded jitter, loss and reordering; checksum
  stability; the `fmath` accuracy bounds; the ban test.
- **Twin worlds**: two `Lockstep` instances wired through an in-memory
  relay with random seeded delays, each driving its own world with an AI on
  its side. They must match hashes every 10 ticks for a whole match. A third
  instance "reloads" at tick 3,000, replays the log, and must reach the same
  hash.
- **Loopback in dev**: a `LoopbackTransport` with an AI as the far-end
  client, so the full lockstep path can be played in the browser with
  latency set by a slider, and no Worker.
- **Worker**: the `Room` logic as a plain class with fake sockets. An
  optional integration test runs under `@cloudflare/vitest-pool-workers`, the
  real workerd, for hibernation and storage behaviour.
- **End to end** (`tools/versus-smoke.mjs`): `wrangler dev` plus
  `vite preview`, and two Playwright contexts. The host creates a room and
  reads the link, the guest opens it, both pick, they play scripted
  commands, and the hashes and result must agree. Then the guest is killed
  and reopened mid-match, and must rejoin.
- **Cross-engine replay** (`tools/determinism.mjs`): see *Determinism*.
- **Dark build**: a `node --test` check builds with no
  `VITE_MULTIPLAYER_URL` and asserts that `dist/` has no `Challenge a
  friend`, no `#vs=` handling and no `workers.dev`. That is the "no
  indication" requirement as a test.
- **Archive**: a record round-trips (write, then pull, then replay) to the
  same final hash. `tools/battles.ts replay` passes on a record from an
  older commit.

## Phases

0. **Groundwork, shipped dark** (no visible change): `fmath` plus the ban
   test plus the cross-engine replay in CI; `checksum.ts`; `PLAYER` as a
   live binding and the `"red"` audit; side-coloured minimap dots; the
   `resign` command; `setupVersusWorld`; the dev-only "play as red vs AI".
   Each of these is useful and testable on its own.
1. **The happy path**: the Worker and Room; `POST`/preview/socket; the lobby,
   share link and Join sheet; loading sync; hidden opener picks; lockstep
   with a fixed D; the end and result; the version gate; the dark-build test;
   the Pages variable.
2. **Phones in the real world**: away and back, reconnecting the socket,
   rejoin by replay after a reload, the pause budget, the stall chip, desync
   detection with "no contest", claim victory, play on vs AI.
3. **Polish**: rematch, names and ranks, the ping chip, announcer lines, the
   Versus record, adaptive D, and a "watch" link for a third person (the
   spectator view already exists).
4. **The battle archive**: the record and index row at the end of every
   battle; the replay from the original link (matching versions only to
   start, option C); the replay viewer with seeking and "through X's eyes"
   (the same viewer AGENT-BATTLES.md needs, so whichever comes first builds
   it);
   the admin list behind Access; `tools/battles.ts` pull, replay and
   aggregate. Then the per-sim-hash build archive, so old replays keep
   playing.

## Later

- **Co-op Last Stand**: blue and red as allies against the waves. The
  director is already deterministic, so the network layer is unchanged and
  the work is in the rules.
- **A referee in the Durable Object**: the sim bundles into the Worker, so
  the DO could replay the log when needed to settle a disputed result or
  build a rejoin snapshot. Running it on every tick is option C, which is the
  only maphack cure.
- **WebRTC** data channels for lower latency, falling back to the WebSocket
  relay.
- **Rotating red's view 180°**, if playtests show the top-right start plays
  worse (see *View orientation*), and **friend/foe colours** as a setting.
- **Online agent seats**: an AI model playing a person, or another model on
  another machine, through the tools in AGENT-BATTLES.md served as remote MCP
  seats. The Room DO would run the sim itself (it's pure TS and bundles into
  the Worker; a 5-second round is about 25 ms of CPU), so fog is enforced on
  the server. Cloudflare's Agents SDK has a stateless `createMcpHandler` for
  this; its Durable Object-backed `McpAgent` class is now deprecated.

## Open questions

1. Sides: should the host always start as blue, or should the first match's
   sides be random? Rematches swap either way.
2. Pausing: 2 × 60 s each, or none?
3. Should versus results count towards the career (XP, a medal) or stay a
   separate record?
4. Display names: free text (it would need a length limit and a mild
   filter), the career rank only ("Captain vs Cadet"), or both?
5. A `workers.dev` URL, or a custom domain from day one?
6. Are the Archipelago's bigger downloads (map art) acceptable for a versus
   invite on mobile data, or should invites suggest the smaller maps?
7. Replays: should anyone with the link be able to watch them, or only admins?
   And should the codes be 6 characters or 8?
