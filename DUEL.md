# Duel — 1v1 against a friend, online

Two players play a 1v1 skirmish against each other over the internet. Each
page runs the full deterministic simulation in lockstep (MULTIPLAYER.md), and
only the players' orders cross the network, through a small relay (`relay/`:
a Cloudflare Worker, one Durable Object per 4-letter room).

The duel began as the "sound duel": two phones on a table talking through an
acoustic modem over speaker and microphone. That link is gone (October 2026),
but the stack above it stayed: the lockstep, the command codec, the pairing
and the session were written for it, and the relay emulates its packets (188
bits, every 100 or 200 ms) so all of that runs unchanged. Where a rule below
reads as sized for sound, that is why.

## Decisions

| Decision | Choice |
|---|---|
| Network model | Deterministic lockstep, one turn per 100 ms tick, input delay D ticks (3–8, chosen at pairing from the measured round trip) |
| Link | The online relay: a WebSocket per page, packets of 188 bits every 100 ms ("fast") or 200 ms ("robust"), each with a CRC-16 (src/link/crc.ts) |
| Transport model | Latest state: each packet carries one of the newest frames the upper layer handed over, repeated until replaced. No ARQ: frames re-describe every unacknowledged turn. When the unacknowledged turns outgrow one packet, they are split into up to K segments that the packets take in rotation (see "Segments and rotation") |
| Replay protection | Turns are accepted once each (high-water mark). Game packets use a CRC keyed to the pairing's two nonces, so a recording of another match fails its CRC. Pairing needs a fresh nonce echoed back |
| Sides | The host plays blue unless a rematch swapped it. Rematches swap sides, never roles |
| Colours, camera | Fixed side colours (blue is blue on both pages), north up on both |
| Career | No XP, medals or stars. A separate local duel win/loss record |
| Pause | Local and allowed. The other page stalls within D ticks and shows "Friend paused" |
| Game speed | 1× on average; an automatic ±10% trim balances the two pages' slack |
| Desync | A world-hash trail, checked every 5 s and at the end of the match. A mismatch ends it as "no contest" with copyable debug info |
| Rematch | Reloads the page and reopens the lobby in the same room. Each player taps Rematch, then "Tap to find your friend" |
| Gating | No build flag. The duel code is a lazily loaded chunk, prefetched when the menu shows; the button appears where a WebSocket exists |

## Architecture

```
            page A (host)                                page B (guest)
  GameScene ── VersusFeed (MatchFeed, local) ─┐   ┌─ VersusFeed ── GameScene
                 Lockstep · codec             │   │   Lockstep · codec
                 Pairing (lobby)              │   │   Pairing
                 Session ─────────────────────┘   └── Session
                    │ LinkTransport                     │ LinkTransport
               OnlineLink (RelayTransport)        OnlineLink (RelayTransport)
                    └────── WebSocket ── relay/ (room ABCD) ── WebSocket ──┘
```

Everything below GameScene is pure TypeScript with no DOM and no timers, and
no `Math.random` in its logic. Clocks and randomness are injected, so the same
code runs in the browser and in Node tests.

## Modules

| Path | Contents |
|---|---|
| `src/sim/setup.ts`, `src/sim/checksum.ts` | `setupWorld(MatchSetup)` and `worldHash(w)` |
| `src/sim/*` | The `resign` command, `world.resigned` and the `resign` FxEvent |
| `src/game/controller.ts` | Live `PLAYER`/`ENEMY` bindings and `setLocalSide(f)` |
| `src/game/local-side.ts` | Pure helpers: `composeTick(local, mine, theirs)` (blue's commands, then red's) and `applyOpenersCanonical(w, picks)` |
| `src/link/transport.ts` | The `LinkTransport` interface and shared link types (the band plan and modes are the sound link's names, kept) |
| `src/link/crc.ts` | CRC-16 and the session keys |
| `src/link/packet-air.ts` | `PacketAir`: two connected ends of a frame-level simulated link (tests, `?duel=loop`) |
| `src/versus/codec.ts` | Bit I/O, Exp-Golomb, canonicalize/split, command codec |
| `src/versus/lockstep.ts` | `Lockstep`: turns, sealing, frames, acks, stalls, hash trail, end protocol |
| `src/versus/pairing.ts` | `Pairing`: the lobby protocol |
| `src/versus/session.ts` | Glue: transport + pairing, then lockstep, driven by a clock |
| `src/versus/feed.ts` | `VersusFeed implements MatchFeed` |
| `src/versus/lobby.ts` | The lobby sheet; exports `showLobby`, `reconnect` |
| `src/versus/hud.ts` | In-match overlays and the report's Duel block |
| `src/versus/records.ts` | The duel's win/loss record; the saved battle record; the rematch plan |
| `src/versus/loop-peer.ts` | In-page sim + AI peer for `?duel=loop` |
| `src/versus/relay-transport.ts` | `RelayTransport`: the packet clock and CRC the relay carries, through page functions for `?duel=relay` |
| `src/versus/online.ts` | The online duel: `OnlineLink`, RelayTransport's packets over a WebSocket to `relay/`, with reconnect; room codes, invite links (`?salon=ABCD`), `?relais=` for a local relay |

Import rules (enforced by tests/versus-imports.test.ts):

- Nothing outside `src/versus/**` and `src/link/**` statically imports them.
- `main.ts` reaches them only through `import('./versus/lobby')` (exactly one
  such call site).
- They may use `import type` from `src/arena/**`, but no value imports.

## Lockstep (`src/versus/lockstep.ts`)

### Turns

A turn is one tick (100 ms). The input delay is D ticks, fixed for the match.

- **Start state.** Turns `0 … D−1` are empty for both sides. `newestSealed`,
  `ackThrough` (the peer turns this phone holds, contiguous) and `peerAck`
  (this phone's turns the peer holds, from the peer's frames) all start at
  `D − 1`. `trail` starts at `0x811c9dc5` with the setup world's
  `worldHash32` folded in.
- **Sealing.** Before stepping tick `t`, the phone seals its own turn `t + D`:
  it drains the controller, canonicalizes and splits the commands (codec), and
  adds them to its pending queue. Then it moves commands from the front of
  the queue into turn `t + D` under the window rule. Sealing happens exactly
  once per tick, before the stall check. While paused or after the match has
  ended, nothing new is sealed.
- **Pending queue.** First in, first out, with three rules. They act on the
  sender before encoding, so they cannot desync anything:
  - a `resign` goes to the front, so it lands D ticks later whatever waits;
  - a newer order replaces queued (not yet sealed) orders it overrides
    outright: a `move` or `attackMove` replaces queued `move`, `attackMove`,
    `attack`, `harvest` and `stop`; an `attack` replaces queued `attack`; a
    `stop` replaces queued `stop`. It replaces a queued command only when it
    names every unit of it and nothing queued in between names any of them
    (a Condor named as a carrier and a Goliath named as a lift target count
    as named). Only whole queued commands are dropped;
  - of a newer order's pieces, those whose units have waited longest go
    first, so no unit waits for ever behind the rest while orders come faster
    than the link carries them. Each queue entry keeps, per unit, when that
    unit started waiting; `queuedTicks` in `status()` is the oldest such wait.
- **Window rule.** Move the queue's front command into turn T only while two
  things hold:
  - the unacknowledged turns `peerAck + 1 … T` still fit in at most K
    segments (see "Segments and rotation"), each segment's frame within
    `capacity`, counting its header, a 21-bit checkpoint reserve, and every
    turn's gap, count and command bits;
  - turn T stays at or under `TURN_MAX = capacity − 57` bits and 15 commands.

  If the front command does not fit, T is sealed with what it has (perhaps
  nothing) and the command waits for acks to shrink the window. Because of the
  split rule, any command fits once the window is empty.
- **Stepping.** The phone steps tick `t` only when `ackThrough ≥ t`. It steps
  with `composeTick(local, myTurn(t), peerTurn(t))`, which is blue's commands
  then red's whichever side is local. Otherwise it stalls: it does not step,
  and keeps the interpolation where it is.
- **Decoded form.** Both phones run the decoded form of every command, their
  own included: `decode(encode(canonicalize(c)))`.
- **Faction.** The receiver stamps each of the peer's commands with the peer's
  faction. The faction is never on the wire.

The pending queue's length is visible in `status()`. The HUD shows "Orders
queued" when it holds more than 2 s of turns.

### Frames

Each phone keeps its newest frames, one per segment, and hands the list to
`transport.send()` whenever one of these changes: a turn is sealed, a packet
changes `ackThrough` or `peerAck`, or the pause or end state changes. The
transport repeats them until they are replaced. Together the frames describe
`from = min(peerAck + 1, newestSealed)` through `newestSealed`. That is
always at least one turn; the receiver ignores turns it already holds.

Game frame, MSB-first (`UE` = unsigned Exp-Golomb, `SE` = signed, see the
codec):

```
type      2   01 = game frame (10 = lobby; 00 and 11 are invalid, so an all-zero packet is nothing)
paused    1
end       2   0 playing, 1 left, 2 desync, 3 decided
rxq       3   this phone's receive quality of the peer: clamp(floor(effective SNR dB / 3), 0, 7)
to        16  newest turn described (mod 65536)
span      UE  to − from
tickLag   SE  to − this phone's current tick
ack       SE  ackThrough − to
nonEmpty  UE  turns in from..to that have commands
  per non-empty turn, ascending:
    gap   UE  turn − from for the first; turn − (previous + 1) after that
    count UE  commands − 1
    command × count            (codec)
hash      1   a checkpoint follows: hashIdx 4 (checkpoint tick / 50, mod 16), trail 16 (low 16 bits)
if end = 3:  endTick 16, endTrail 16
```

- **Unwrapping.** A mod-65536 field is unwrapped to the value nearest the
  receiver's expectation: its own `ackThrough` for `to` (only accepted turns
  move it, so stale and garbage frames cannot shift it), and its own current
  tick for ticks. `hashIdx` is unwrapped to the checkpoint nearest its own
  `tick / 50`.
- **Bounds.** The two phones' ticks never differ by more than D + 1, so
  `tickLag` lies in [−D−1, D] and `ack` in [−2D−1, 3D+1]. A frame describing
  one turn therefore has at most 57 header bits.
- **Accepting turns.** See "Receiving out of order" above. The receiver
  ignores turns it holds, stores the rest, and advances `ackThrough`.
- **Rejecting frames.** It rejects the whole frame on any codec error, `to`
  more than 200 turns from expected, span > 64, a turn past `to`, a turn of
  more than 15 commands, or a `from` below 0.
- **`peerAck`** only increases.

### Segments and rotation

With one frame per packet, everything in flight must fit in one packet:
about 120 bits of orders per round trip, roughly 300 bit/s of a link that
carries 1,880. A 30-unit order (about 190 bits, three 96-bit pieces) then
takes three round trips to land. Segments let a burst use more of the link
when the input delay leaves room for it:

- **Segments.** The sender's unacknowledged turns are cut into at most K
  segments of consecutive turns, each small enough for one frame. Boundaries
  are fixed when turns are sealed: a newly sealed turn joins the newest
  segment if that segment's frame still fits, and otherwise starts a new
  segment. The fit is checked with `tickLag` and `ack` at their bounds, the
  span field at `max(span, 2D + 1)` (the empty turns latency always leaves),
  the checkpoint reserve, and the turns' bits. An ack only trims the oldest
  segment's start or drops whole segments.
- **Frames.** Each segment is one frame. Its `key` is the segment's start turn
  as cut, never moved by acks (a moved key would make the rotation send that
  segment twice in a row). It describes `max(key, min(peerAck + 1,
  newestSealed))` through the segment's end; the newest segment ends at
  `newestSealed`, so the newest turn is always described. Every frame carries
  the current paused, end, rxq, `tickLag` and `ack` (the last two written
  clamped to their bounds; clamping `ack` only understates what this phone
  holds), and the checkpoint when it fits. `left` and `desync` ride in every
  frame; the end report rides only in the newest segment's frame, and older
  frames say `end = 0` while decided.
- **Rotation.** The transport sends one frame per packet. After a packet
  carrying key k, the next carries the first frame in the list whose key is
  greater than k, wrapping to the first. One frame repeats in every packet.
- **K and the slack gate.** `K = clamp(D − 2, 1, 4)` is a cap. A new segment
  also needs the peer's slack to cover one more packet of delay: the lowest
  slack in the peer's newest 16 frames (a full window; the window starts over
  when either phone pauses or this phone stalls) must exceed what one more
  packet costs at this phone's own transmit period (`setPacketMs`: modes are
  per direction, and it is this phone's rotation that holds its turns back; a
  new period starts the window over too). Without the gate, rotation
  stalled the peer for seconds even at 0% loss (robust: 16 ms at K = 1 against
  11.7 s). With it, stall at 0% loss equals K = 1 in every case measured,
  while order delay improves where D leaves room (D = 6 fast: 9.4 → 6.9 ticks
  mean, worst queue age 42 → 15 ticks; a 30-unit order at D = 7 lands in 5
  ticks against 17). At the D pairing usually picks, the gate rarely opens and
  matches play exactly as K = 1.
- **Receive quality.** A change of `setRxq` rebuilds the frames, so a
  stalled phone's friend hears its current receive quality.
- **One strike.** A lost packet costs the newest turns a whole rotation, and
  no sender-side gate sees loss coming. So the first time the peer stalls
  during a rotation (or within 2D ticks of one), no new segment is started
  for the rest of the match.
- **Starvation.** When the peer reports it is stalled and `peerAck` hasn't
  moved for (segments + 1) packets + 2D ticks, the list is the oldest
  segment's frame alone until the peer holds it. (Losing every second or
  third packet in step with the rotation otherwise starved one segment for
  ever.)
- **Receiving out of order.** The receiver keeps turns from any accepted frame
  whose `from` lies within 128 turns past `ackThrough`, takes each turn once,
  and advances `ackThrough` through every contiguous turn it holds.
  `lastNewTurnAt` moves only when `ackThrough` does.
- **Minimum capacity.** "Any command fits once the window is empty" needs
  `capacity ≥ minCapacity(D)`: 175, 175, 177, 177, 183, 183 bits for D = 3…8,
  because the window always holds the empty turns latency leaves. Real links
  carry 186 or 188.
- **The low plan's limit.** About one frame of orders is in flight per round
  trip, and on the low plan the round trip is near 1 s, so heavy order
  traffic queues there: with a 30-unit order from each side every 5 s
  (rtt 956 ms, D 8), orders waited 3.4–7.0 s on average and up to 17.8 s,
  with no stall. The low plan is the fallback for phones that can't play the
  high band; the HUD's "Orders queued" says when it happens.

### Hash trail and the end of the match

After each step:
`trail = Math.imul(trail ^ worldHash32, 0x01000193) >>> 0`, where
`worldHash32 = parseInt(worldHash(w), 16)`.

- **Checkpoints.** Every 50 ticks the phone saves `(tick, trail)`. Every frame
  carries the newest checkpoint whenever it fits; there is no ack for
  checkpoints. A phone keeps its own trail for its last 8 checkpoints. It
  compares a peer checkpoint as soon as it has stepped that tick, storing it
  until then. A mismatch makes the phone end the match as desync, and its
  frames then carry `end = 2`.
- **Decided match.** When the world is decided after stepping T, frames carry
  `end = 3, endTick = T, endTrail = trail(T)`. From then on the phone's frames
  describe its turns after T as empty (no phone ever steps one), so the end
  report always fits once the peer holds turn T. Until then a frame with no
  room for both its oldest unacknowledged turn and the report says `end = 0`
  for the moment: the turns come first. A decided phone that learns of a
  desync any other way reports the end check as "mismatch". The report shows "Checking
  sync…" until the peer's end checkpoint arrives:
  - "In sync ✓" if it matches;
  - desync ("no contest") if it differs;
  - desync if the peer reports a decision at T while this phone has stepped T
    without one;
  - "Not verified" after 10 s with no reply.

  The phone keeps transmitting while the report is up.
- **Leaving.** A phone that leaves or aborts sends frames with `end = 1`
  (left) or `end = 2` (desync) for 2 s before closing the link. The receiver
  ends at once with "Friend left" (abandoned, no result) or "Out of sync (no
  contest)".

### Pacing

The phones need no shared clock: the one that is ahead stalls. The feed
balances their slack to avoid stutter:

- this phone's slack as its newest packet reported it: `slack = ack +
  tickLag` of the frames on the air at its last packet start
  (`ackThrough − currentTick` until the first)
- the peer's slack, from its newest frame: `peerSlack = ack + tickLag`
- `speed = clamp(1 + 0.02 × (slack − peerSlack), 0.9, 1.1)`

Like is compared with like, so the two speeds sum to 2 on average and the
match runs at 1× whatever the latency (9.995–10.001 ticks/s). Against the
live `ackThrough − currentTick`, matches ran 0.3–1.5% slow wherever D had
slack to spare. The cost: where a packet carries several turns, the slack
the two phones keep can differ by up to half a packet's turns.

### Pause, resign, leave, background

- **Pause** is local. Frames carry `paused = 1` and nothing new is sealed. The
  peer shows "Friend paused" once it stalls.
- **Resign** (pause menu, with confirmation) closes the pause menu and
  unpauses. It enqueues `{ type: "resign", faction: PLAYER }`, locks input and
  shows "Resigning…" until the tick it lands. Both phones apply it D ticks
  later.
- **"Resign and leave"** replaces "Quit to menu" while packets are arriving:
  it resigns, shows the report, and Menu reloads.
- **"Leave (no result)"** appears only once "Signal lost" shows, or after 60 s
  of stall even while packets arrive. It sends `end = 1` frames for 2 s.
- **Stall overlays.** These count time with no new peer turn (or since the
  peer's frames stopped saying paused, if that is later), whether or not
  packets arrive:
  - "Waiting for your friend…" after 0.5 s ("…to load" while the peer still
    sends lobby frames, "Friend paused" while it is paused);
  - "Your friend isn't responding" after 5 s;
  - Leave after 30 s.
- **Background.** On `visibilitychange` to hidden, the feed sets `paused`
  synchronously, so the repeated frame says paused and the peer shows "Friend
  switched away".

## Command codec (`src/versus/codec.ts`)

Lossless for canonical commands, and stateless across turns.

### Canonicalize and split (sender side, before encoding)

- **Coordinates.** `x`, `y`: `k = clamp(floor(v × 16), 0, size × 16 − 1)`,
  `v' = (k + 0.5) / 16`, where `size` is the map width (x) or height (y).
  This keeps the tile, so harvest's `Math.floor` is unchanged.
- **Unit lists.** `unitIds` are sorted ascending and deduplicated.
- **Unload.** An `unload` has a point exactly when
  `Number.isFinite(x) && Number.isFinite(y)`. Otherwise both are absent.
- **Faction.** Set to the local side.
- **Drop** commands that cannot be encoded or do nothing:
  - an empty unit list after deduplication;
  - an id that is not an integer, is negative, or is ≥ 2^24;
  - a required x or y that is not finite;
  - `tx`/`ty` outside `0 … size − 1`;
  - an enum value missing from its table.
- **Split.** A command with a unit list (move, attackMove, attack, harvest,
  stop, anchor, packUp, board, unload) whose encoding exceeds `C_MAX = 96`
  bits is split greedily into consecutive commands of the same type and
  parameters, each at most 96 bits, keeping order. `lift` is never split. The
  sim applies these per unit, so this is desync-safe, and every command fits
  in an empty turn. It is behaviour-identical too, with one exception the sim
  closes: a Goliath whose lift is still hooking obeys a move only when its
  Condors are named in the same command (`src/sim/lift.ts`). So a hooking
  Goliath that ignores an order remembers it for the rest of the tick, and
  takes it if a later command in the same tick calls its lift off by naming
  its Condors. One command per selection, as single player sends, never
  reaches that case.

### Layout of one command (no faction)

```
type   5  index into COMMAND_TYPES (an explicit fixed table, never Object.keys order)
then by type:
  move, attackMove, harvest:     units, x, y
  attack:                        units, id(targetId)
  stop, anchor, packUp:          units
  produce, cancelProduce:        id(buildingId), unitKind 5
  startBuilding:                 buildingKind 4
  cancelBuilding, callWave:      –
  placeBuilding:                 tx, ty     (ceil(log2(size)) bits each)
  sell:                          id(buildingId)
  rally:                         id(buildingId), x, y
  calldown:                      power 3, x, y
  board:                         units, id(carrierId)
  unload:                        units, hasPoint 1, [x, y]
  lift:                          units, id(goliathId)
  resign:                        –
  waypoint, patrol:              units, x, y     (CODEC_VERSION 3: a route drawn, src/sim/route.ts)
units  = sameAsPrevious 1 (always written; 1 = the same list as the previous command in this
         turn that had units, and it must be 0 when there is none), else
         UE(count − 1), UE(first), then UE(gap − 1) for each further id
id     = UE
x, y   = the cell index k in ceil(log2(size × 16)) bits
```

- **Exp-Golomb.** `UE(v)` writes `v + 1` in binary, preceded by
  `floor(log2(v + 1))` zeros. `SE(v)` maps 0, 1, −1, 2, −2… to 0, 1, 2, 3, 4…
  and then writes `UE`.
- **Rejection.** The decoder rejects the whole frame on any of:
  - more than 24 leading zeros in a UE;
  - a read past `nbits`;
  - an enum index outside its table;
  - `sameAsPrevious = 1` with no previous list;
  - a cell index ≥ `size × 16`, or `tx`/`ty` ≥ `size`.
- **Tables.** `COMMAND_TYPES`, `UNIT_KINDS`, `BUILDING_KINDS` and `POWER_KINDS`
  are explicit arrays, versioned by `CODEC_VERSION`. A test checks they cover
  the sim's types and balance tables.

## Pairing (`src/versus/pairing.ts`)

The phone that taps **Host** transmits in the host band of the chosen plan
(Advanced settings; default high). **Join** listens for a host in both plans'
host bands, then switches itself to the plan it locks first and transmits in
that plan's guest band. Each phone repeats one lobby frame describing its whole
state:

```
type 2 (=10)  role 1 (0 host, 1 guest)  proto 4  build 16
nonce 16      (drawn uniformly from 1…65535; 0: this phone gave up, see "Failure")
heard 16      the peer nonce this phone hears (0 = none; when failed, the phone it gave up on)
rxq 3         as in game frames
ping 8        this phone's link clock at the start of the packet carrying this frame, in 10 ms units, mod 256
echo 8        the newest peer ping heard
hold 7        10 ms units from hearing that ping to the start of this packet (127 = too old or none)
hasConfig 1   (host only) then:
  map 4       0–5: built-in MAPS index; 8–12: random map of biome 0–4, followed by seed 32; other values are invalid
  mutators 12 mask in MUTATOR_IDS order
  delay 3     D − 3
  hostSide 1  0: the host plays blue
  fast 1      the match starts in fast mode
confHash 16   this phone's hash of (config, plan, both nonces); 0 = none yet
pick 2        OPENER_IDS index, or 3 = no opener (all blocked under the config)
picked 1
go 1          then theirs 2: the peer's pick as this phone holds it
[LOBBY_PROTO 2] nations 1 (1: the extension follows), nation 2 (what this phone asks for: 0 Classique / none,
              1 République, 2 Empire), then, with a config: hostNation 2  guestNation 2 (both 0: Classique)
```

Nations (LOBBY_PROTO 2, PANACHE-CONCEPTION.md §1.10) ride in a trailing
extension, so a proto-2 frame keeps proto 1's header and layout: a proto-1
phone reads it as its own (the bits after `theirs` are the modem's zero
padding to it), and a proto-2 phone that hears no extension offers no nations,
so the pair falls back to Classique with no version error. The host offers its
menu nation; the guest asks for one in the lobby's nation picker (none: the
host's rival); the nations enter the confHash only when they aren't Classique.

The longest frame is 164 bits (157 without the extension), which fits a packet. (`hold` is 7 bits: with
200 ms packets holds of 210–400 ms are normal, and 400 ms packets give up to
800 ms.)

- **Build check.** `build` is the first 16 bits of `__DUEL_HASH__`, a sha256
  that vite.config defines over `src/sim/**`, `src/versus/**`, `src/link/**`
  and `src/game/local-side.ts`. `proto` is a separate version number, so the lobby can say
  which phone is older. A mismatch stops pairing with "These phones run
  different versions: reload both". One stray frame from a nearby phone must
  not end a pairing: other-version frames are ignored while the peer is live
  (heard hearing this phone within 2 s), and otherwise the error needs 3 of
  them within 5 s.
- **Link clock.** `ping` and `hold` are stamped at air time. The transport's
  `slot` events give each packet's start, and the session rebuilds the lobby
  frame on every slot. `rtt = now − pingSentAt(echo) − hold`, where `now` is
  the echo packet's `at` (fully received). A sample down to −10 ms (one
  `hold` unit of rounding) counts as 0; lower is garbage. The host keeps the
  last 5 samples.
- **Config.** The host's config is the menu's `shownMap()` and
  `activeMutators()` at the moment of the Duel tap. A random map sends its own
  32-bit seed, so the map shown is the map played. The match seed is
  `hash32(hostNonce, guestNonce, 1)` (`src/sim/rand.ts`).
  - `D = clamp(ceil((median rtt / 2 + P_start + 50 ms) / 100 ms), 3, 8)`,
    where `P_start` is the starting mode's packet period on the plan (fast /
    robust: 100 / 200 ms high, 200 / 400 ms low). A turn waits up to one
    packet period for the air, which the round trip doesn't contain. Measured
    over the room model (two sessions with AIs, 1,200 ticks), the least D
    with stall ≤ 0.5% is 4 (high fast), 6 (high robust), 6 (low fast); the
    margin is set by high robust (40 ms sometimes stalled over 0.5%, 46 ms or
    more never did). Low robust can't get under 5–7% at D = 8. The lobby
    measures the round trip with its own (robust) packets, so a fast start
    gets about a tick of spare delay, which covers a later fallback to robust
    in most cases (0.1–1.0% stall at a 75 ms audio path, 1.5–6.8% at 50 ms).
  - `fast` is set when both phones' last 10 frames report `rxq ≥ 4` (12 dB:
    fast delivered 100% at every rxq-3 reading in the room model, and 50–100%
    at rxq 2). A phone's own window counts only frames built after it first
    heard its friend. The host offers fast as soon as both windows qualify,
    and robust only once they have failed to for 8 more of its frames in a
    row: a receiver's first packets after locking read low while its clock
    tracker settles.
  - The host freezes its config when it first hears a guest frame whose
    `confHash` equals its own, and never changes it afterwards.
- **Picks.** Once the config is agreed, both phones show the opener cards.
  Only openers that are not `openerBlocked(setupWorld({ map, seed, mutators,
  openers: {} }), side, id)` are offered. A pick is final once `picked = 1`.
  Picking times out after 20 s with `allowedOpener(…, OPENER_IDS[0])`, or 3
  (none).
- **GO.** A phone sets `go` only after hearing the peer's frame with an equal
  `confHash` and `picked = 1`, and having picked itself. It accepts the peer's
  GO only if:
  - the nonce is the peer's HELLO nonce;
  - `confHash` is equal;
  - `theirs` equals its own pick;
  - the GO's own `pick` equals the peer's pick as this phone holds it (the
    one committed in its own GO, else the peer's newest frame's), and is
    allowed for the peer's side.

  A GO whose `heard` is not this phone's nonce is read as a plain hello (its
  `go` and `theirs` ignored), so a phone whose GO is on the air can still meet
  its friend's next incarnation. The peer's pick and readiness come from its
  newest frame only; only a GO commits a pick.
- **Failure.** On a GO it can't accept, a phone shows "Pairing failed: tap to
  retry" and sends `nonce = 0` with `heard` naming the phone it gave up on.
  Only that phone restarts (with a fresh nonce, retiring the old peer, so
  replayed copies of the give-up name a nonce no longer in use); give-ups
  naming anyone else do nothing.
- **A new nonce.** A friend that reloads or retries comes back under a new
  nonce. It replaces the current peer only after 3 of its packets that hear
  this phone arrive with no live frame from the current peer in between, and
  a replaced nonce may come back only after its replacement has been silent
  for 2 s. One damaged frame, or a third phone heard while the real friend is
  live, never takes over.
- **Retry.** After `reset()` (the retry tap) the session hands the new frame to
  the link at once: the frame the link holds is the old pairing's, maybe its
  GO, and the friend would otherwise start alone on it.
- **Start.** After setting GO, a phone's payload is the GO frame alone until
  its first game frame. It starts its match once it has sent GO and heard the
  peer's GO or a game frame that passes the session CRC and says `end = 0`
  (a friend that took its result and left sends only end frames, and must not
  start anyone). The phone that loads faster stalls at tick D and shows
  "Waiting for your friend to load…".
- **Two generals.** A phone whose GO has gone out and which then resets can
  leave its friend started and waiting for it. The stall overlays' Leave
  covers that case.
- **Session CRC.** From GO on, game frames use the session CRC (see the
  modem). Lobby frames always use the default.
- **Same role on both phones.** If both phones pick Host, or both Join, they
  hear nothing. After 8 s with nothing heard, the lobby says "Nothing heard
  yet. One phone taps Host, the other Join" and offers a one-tap switch.

## Session (`src/versus/session.ts`)

The glue between one `LinkTransport` and the two protocols that take turns on
it: the Pairing until the match starts, then the Lockstep. Engine-free; it
acts only in `pump()` (called every animation frame and from a fallback
timer) and in the calls the feed makes. Its header comment records every rule
in detail; the main ones:

- **Routing.** Lobby frames go to the pairing, game frames to the lockstep.
  Game frames that fail the session CRC are always dropped, so a transport
  that can't check the CRC (a relay of bare frames) must emulate it: carry
  the key with each game frame and compare, as PacketAir does.
- **Before the match.** Game frames heard before `beginMatch` count only
  under this pairing's GO key. They are dropped (they repeat), but the newest
  is kept and the lockstep takes it first, so a friend that left while this
  phone loaded ends the match at once. One saying `end = 0` tells the
  pairing the friend started; one saying it left or desynced sets
  `status().peerEnded` instead.
- **At GO.** `transport.setSessionKey(hostNonce, guestNonce)`. The starting
  mode waits for `beginMatch`, so GO frames (and a pick sent with them) go
  out in the lobby's mode, the one every lobby frame got through in. The
  lobby frame is rebuilt and handed over on every slot (and at once after a
  retry).
- **Receive quality.** `rxqOf(stats().snrDb)`, read as 0 once nothing has
  arrived for over 1 s.
- **Mode adaptation.** During the match each phone picks its own transmit
  mode from what its friend says of it, so a link that is poor one way slows
  only that way. It goes robust when the friend's rxq of it is at or below
  `ROBUST_RXQ = 1` (6 dB, where fast starts to fail) for 2 s, or when the friend's frames keep arriving (not
  paused) but acknowledge nothing new for `max(1.5 s, rtt + 0.5 s)`. It goes
  back to fast once the friend's rxq has been at or above `FAST_RXQ = 4` for 10 s
  (doubling after a fallback the rxq didn't explain, up to 80 s, until fast
  has held for a minute). A switch holds for at least one superframe. Every
  rule needs the friend's frames to be arriving: its game frames or, once
  this phone has begun, its own lobby frames (their rxq field), so a friend
  still loading or still in GO that hears nothing sends this phone robust.
  The acknowledgement rule takes game frames only. The lockstep gets this
  phone's own packet period (`setPacketMs`, from the mode on the air) for
  its rotation.
- **Stall reasons.** `waiting.why` is "load" while the friend's newest packet
  is its own lobby frame (its role and nonce), "paused" while its newest frame
  says paused, either only while that packet is under 2.5 s old, and "link"
  otherwise. `waiting.ms` counts from the later of the friend's last new
  turn and the moment its frames stopped saying paused (a paused friend owes
  no turn, so its resume doesn't flash "Signal lost").
- **Leave.** Before this phone's GO there is nothing to tell. From GO on, with
  no match begun, a stand-in lockstep (never stepped) sends `end = 1` or `2`
  for 2 s; after a decided match `leave("left")` keeps the end report on the
  air for the 2 s. `status().closable` says when the rig may close.


## Link layer (`src/link/`)

```ts
/** at: when the packet finished arriving at this phone (its last sample; it can't be decoded earlier). */
export interface LinkPacket { bits: Uint8Array; nbits: number; snrDb: number | null; at: number; session: boolean }
export interface LinkStats {
  locked: boolean; snrDb: number | null; rxOk: number; rxBad: number; txMode: ModemMode; rxMode: ModemMode | null;
  sinceRx: number; ownSnrDb: number | null; loopbackMs: number | null; plan: BandPlan;
}
export interface OutFrame { bits: Uint8Array; nbits: number; key: number }
export interface LinkTransport {
  capacity(): number;
  send(frames: readonly OutFrame[]): void;        // one per packet in key rotation, repeated until replaced
  poll(): LinkPacket[];
  /** Packet starts since the last call, on this link's clock (lobby frames are stamped at air time). */
  slots(): number[];
  now(): number;                                   // monotonic milliseconds
  setMode(mode: ModemMode): void;
  setSessionKey(hostNonce: number, guestNonce: number): void;
  stats(): LinkStats;
  close(): void;
}
```

- **`PacketAir`** gives two connected ends, each on an injected clock
  (`advance(ms)` in tests, a real timer in `?duel=loop`).
  - Packets go out every 100 ms (fast) or 200 ms (robust), with independent
    phases per end.
  - Each is delivered after `latencyMs` (default 250, packet start to fully
    received), with seeded Bernoulli or Gilbert–Elliott loss.
  - Capacity is 188 unless overridden.
  - It honours `setSessionKey` by dropping game frames between ends whose keys
    differ.
- **Transports without a CRC of their own** (PacketAir) must
  emulate the session key: carry the key with each game frame and drop
  mismatches, or report `session: true` only for game frames sent under the
  receiver's key.


## Game integration

### Getting into a duel

- **Prefetch.** `showMenu` starts `const duel = import('./versus/lobby')` once
  the menu mounts. The "🌐 Challenge a friend" button (Skirmish tab, and the
  hub's Duel card) stays disabled until the chunk has loaded.
- **The tap.** The click handler runs `sfx.unlock()`, `music.stop()`,
  `void fullscreen.enter()` (it consumes the activation), then
  `duel.showLobby({ shownMap, mutators, start, online })`. An invite link
  (`?salon=ABCD`) opens the lobby on its code. A practice link
  (`?duel=loop|relay`) takes the same button.

  If the import fails, the button says "A new version is ready: reload this
  page (and your friend's)".
- **Start.** `start(feed)` calls `begin(false, () => duelSetup(feed.config),
  feed)`, keeping the `starting` guard. begin skips its own
  `fullscreen.enter()` and click sound when `feed.local` is set.
- **`duelSetup(cfg)`** (`mode.ts`) never saves settings. It:
  - sets `gameMode.mapId` to the agreed map (a MAPS id, or
    `randomMapId(biome, seed)`);
  - sets `mode = "skirmish"`, `mutators`, `spectator = false`,
    `daily = null`, `op = null`, `uncharted = false`;
  - calls `setLocalSide(cfg.local)`.

  So startGame loads art for the agreed map. The lobby asserts
  `feed.world.mapId === gameMode.mapId`.

### MatchFeed and GameScene

```ts
interface MatchFeed {
  // … existing members …
  /** This phone commands this side: an interactive feed (a duel), not a watched match. */
  readonly local?: Faction;
  /** Game speed this frame (the slack trim). */
  speed?(): number;
  /** Who the opponent is, for labels. */
  readonly opponent?: string;
}
```

Every new GameScene branch tests `feed?.local !== undefined`, so ReplayFeed and
spectator runs are unchanged. `VersusFeed.keyframe` returns null and `seek()`
does nothing. With an interactive feed, GameScene behaves as follows:

- **No AI.** No AI commanders.
- **Input.** The feed drains `ctrl.drainCommands()` itself, from inside
  `commands(tick)`.
- **Stalls.** A null from `commands()` keeps `acc = TICK_MS × 0.999` and
  breaks, so units hold their pose with no catch-up burst afterwards.
- **Speed.** `planTicks(acc, delta, feed.speed())`.
- **Fixed speed.** Awareness gets `fixedSpeed: true`, which means:
  - GameSpeed is built with `raw = null` (base 1), and cycleSpeed and onHold
    do nothing;
  - no speed chip is mounted;
  - TempoGuard is off and `sfx.setTempo(1)`;
  - the `.` key is ignored.
- **HUD.** `strategies: null`, and a new `HudApi.duel = { opponent, delayMs(),
  resign(), leave() }`.
- **Pause menu.** The line reads "vs your friend · 🔊 <delay> ms". The debug
  fog toggle is removed; Resign, "Resign and leave" and (later) Leave replace
  Quit.
- **No auto-harvest.** The constructor's auto-harvest command is skipped:
  openers already set harvesters mining.
- **Resign.** The `resign` FxEvent sets `finaleAt` to the resigning side's HQ
  (else the centre of its home box), with cause "resign" and no blasts.
  `finaleBanner` gains:
  - "Your friend resigned · Victory";
  - "You resigned · Defeat";
  - "Both resigned · Draw" (never the Robot Love line).

  Music plays win, lose or draw without the love sting.
- **Career.** `settleCareer` is skipped.
- **`abort(reason: "desync" | "left" | "lost", info?)`.** Sets `ended`,
  skips the finale and career, clears selection and placement, settles the
  music on its quiet coda (as a draw, with no sting and no SFX jingle), and
  calls `hud.showEnd(null, { head: { title, cls: "lose", sub } })`.
  - showEnd and showReport accept `winner: null` (a "draw" panel with a head
    override).
  - togglePause does nothing once the match has ended.
  - A desync adds "Copy debug info": config, nonces, D, the turn log and both
    trails.
- **Report.** `opponent` is set:
  - sideName gives "You"/"Friend";
  - the headline reads "vs your friend · <map> · <time> · over sound";
  - the tips leave out difficulty and AI;
  - a Sound duel section shows the record, link quality (good/bad packets,
    "Waiting on the link", and "Order delay" / "Slowest order": real time
    from the order being drained to it being stepped here, with this phone's
    own pauses left out) and the sync status.

  The actions are Rematch, Save battle and Menu.
- **In flight.** Controller keeps an `inFlight` list of every order this
  phone drained and hasn't stepped yet. The build bar, the power panel and
  the Controller's own reads (`Controller.ahead()`: a lift, a boarding, an
  anchor, a sale, a rally point, a calldown) treat them as applied, so a
  second tap within the delay does what it does in single player. One the
  lockstep replaced in its queue and never sent comes off once that turn is
  stepped, and all of them at an abort. A building placed counts only once
  it lands (the sim gives it its id).

### Records

- **Win/loss.** localStorage `battledrones.soundduel` holds
  `{ w, l, d, abandoned, noContest }`. It is written as soon as the result
  is known (the match decided, before the end check; or aborted), and moved
  to no contest if the end check then fails. A page that goes hidden
  mid-match counts the match as abandoned at once, since a phone that closes
  or kills the browser in the background fires no `pagehide`; the match's
  own end moves that count over if the page comes back. Loop and relay
  matches never write it, and their report says "Practice link (no sound)".
- **Save battle.** Downloads a BattleRecord as `.json` through a Blob link. It
  doesn't load the viewer, so main.ts keeps exactly 2
  `import("./game/replay")`. The record:

  ```
  {v:1, commit:null, sim:__SIM_HASH__, created, map, mutators, seed, round:1, maxTicks:endTick, openers,
   seats:{blue:{player:"sound-duel:host"|"sound-duel:guest"}, red:{…}}, frames:"own",
   turns:[[tick, side, commands as stepped]…] (blue's entry before red's for a tick),
   radio:[], hashes:[[tick, worldHash]] every 100 ticks, log:[], tick,
   end: endOf(tick, winner, resigned) or {tick, winner:null, reason:"aborted"}, usage:{}}
  ```

  The duel code defines its own `HASH_EVERY = 100` and end helper, and uses
  only `import type` from `src/arena/record.ts`. The two agree, a draw where
  both sides resigned included (reason "resign"), so such a record keeps
  "resign" when re-simulated.

### Rematch

- **The tap.** Rematch writes sessionStorage `battledrones.rematch = "duel"`
  and `battledrones.duel = { role, hostSide: flipped, mapId, mutators,
  nation?, online: { code, key } }`, then reloads.
- **Boot.** `main.ts` sees `"duel"`, prefetches the lobby chunk and shows one
  button, "Rematch · tap to find your friend". The button runs the Duel tap
  and pairs at once in the stored role, in the same room with the same seat
  key. The host reuses the stored map and mutators. Roles never swap.
- **Waiting.** A phone still on the report that hears its friend's lobby
  frames shows "Your friend is back in the lobby: tap Rematch".
- **Fallback.** After 60 s with nothing heard, it falls back to the menu.
- **URL cleanup.** `fullscreen.reloadWithoutLink` also strips `duel`, `seat`,
  `delay`, `loss`, `latency` and `side`.

### Playing red (Phase 0)

- **Binding.** `export let PLAYER`, `export let ENEMY`,
  `setLocalSide(f: Faction)`, set once before `new GameScene`.
- **Single player.** The AI plays `ENEMY`, and `startWithOpener` uses
  `applyOpenersCanonical` (blue then red, one tickFog). The update loop uses
  `composeTick`.
- **Minimap.** Buildings, dots, anchored rings and Goliath diamonds use side
  colours (`b.faction`/`u.faction`), with own dots brighter.
- **Icons.** `icon(kind, f = PLAYER)`, and side-aware icons in `command.ts`
  and `openers.ts`.
- **Uplink fallback.** `objectives.ts`: `player === "red" ? {x: world.width,
  y: 0} : {x: 0, y: world.height}`.
- **Production meters.** GameScene's production meters use side colours.
- **`?side=red`** works in every build (single player as red against a blue
  AI), and `window.__bd.player` exposes the local side.

## The lobby (`src/versus/lobby.ts`)

1. **Create a lobby / Join with a code**, with the nation picker. Creating
   shows the room's code, with Share and Copy for the invite link.
2. **Waiting** for the friend: the room's state ("your friend is here", the
   round trip). After 30 s with nothing heard, tips.
3. **Paired:** the map name or code and the mutators, the nations, then
   opener cards, then "Waiting for your friend to pick…".
4. **GO**, then loading, then the match.
5. **Errors:** version mismatch (naming the older page), pairing failed (tap
   to retry), the room can't be had, the friend left, the update-ready
   message.

## Dev and test modes

- **`?side=red`** (every build): single player as red against a blue AI.
- **`?duel=loop[&delay=4][&loss=0.1][&latency=250][&side=red]`** (every
  build): the Duel button pairs over PacketAir
  with an in-page peer that steps its own `setupWorld` copy from
  `VersusFeed.frame` and plays at normal difficulty (incomeMult 1). The config
  comes from the menu. Values are clamped: delay 3–8, loss 0–0.9, latency
  0–2000.
- **`?duel=relay&seat=host|guest`** (every build): the Duel button pairs
  through page functions.
  - RelayTransport calls `window.__duelOut(base64, nbits)` every 100 ms
    (fast) or 200 ms (robust), whether or not the frame changed, and receives
    through `window.__duelIn`.
  - The page exposes `window.__duel = { state, tick, trail(), hash(), result }`.
  - Without `__duelOut`, the lobby says "Relay not connected".
  - `tools/duel-smoke.mjs` connects two pages (one browser context each)
    through Node with seeded delay and loss. It advances them with
    `__bd.scene.step()`, never relying on rAF in a hidden page. Once both
    matches are up it cancels the scenes' own frame loops, so the match runs
    undrawn (drawn only for `--shots`). It drives the lobby, openers, orders,
    pause and resign, and checks equal hashes and the same result. Its waits
    leave out stops of 3 s or more of a page's main thread outside relay
    cuts (a loaded machine, not the duel); shorter stops still count.
## Tests

Long tests set explicit timeouts (60–180 s).

| Test | Checks |
|---|---|
| `tests/resign.test.ts` | Resign, a draw on a mutual resign (the arena's `endOf` and the duel's end helper agree on it, and a re-simulated record keeps it), and setup and hashing shared with records (done) |
| `tests/local-side.test.ts` | `setupWorld` gives the same world whoever is local; `applyOpenersCanonical` and `composeTick` are canonical for both local sides; a red Controller issues red commands |
| `tests/versus-codec.test.ts` | Bit I/O and Exp-Golomb. For every command `c` in a corpus from AI-vs-AI arena matches (several maps and mutators, showcase records) plus hand-written cases for every type, with `k = canonicalize(c)`: `canonicalize(k)` deep-equals `k`, and `decode(encode(k))` deep-equals `k` (Object.is per scalar, element-wise for unitIds). Split pieces are ≤ 96 bits and keep order. Malformed inputs are rejected. The enum tables are complete |
| `tests/versus-lockstep.test.ts` | Two worlds and two `Lockstep`s through `PacketAir`, normal-difficulty AIs on both sides for 5 game minutes: identical hash trails at every tick. Run at 0%, 10% and 30% loss, and with 3 s dropouts; with bursts of 30-unit orders; with pause; resign ends both on the same tick; a desync injected into one world is caught at the next checkpoint or the end check; leave and end frames work; stall time is bounded; the saved BattleRecord round-trips through `parseRecord` and `replay()` with no divergence. Segments: a 30-unit order lands in one rotation; out-of-order segments are kept; rotation never raises stall time against K = 1 at 0% loss |
| `tests/versus-pairing.test.ts` | Two `Pairing`s over `PacketAir` agree on config, seed, D and openers; a build mismatch is refused; duplicate, stale or out-of-order lobby frames are harmless; both-Host is detected; a recorded HELLO from another session can't complete pairing |
| `tests/versus-feed.test.ts` | VersusFeed with a real Controller and fake clock: a stall consumes no input, sealing happens once per tick, the order is canonical with the local side red, and nothing is sealed while paused; the record is written at the decision, and as abandoned at once by a page hidden mid-match; the visibilitychange and pagehide wiring; the stall pill, the pause menu's ways out, "Resign and leave" and "Orders queued" |
| `tests/versus-imports.test.ts` | The import rules above |
| `tests/duel-abort.test.ts` | GameScene's abort for each reason: the end screen with no winner, the music settled once with no sting |
| `tests/versus-session.test.ts` | Two Sessions over PacketAir from pairing through a match with AIs: identical trails at 0/10/30% loss and a 3 s outage, a slow loader, the session CRC after GO, mode adaptation, leave and end frames from every phase, replayed lobby frames; the mode from GO to the match (fast lost one way, a friend that missed this phone's GO); the wait for a friend that plays on after a pause |
| `tests/versus-pacing.test.ts` | Two Sessions stepped at 60 Hz over PacketAir (both modes): 10 ticks/s within 0.01 over three minutes, and at most 150 ms of stall |
| `tests/versus-relay.test.ts` | RelayTransport checks each CRC for its own frame type, even under a session key of 0xFFFF |
| `tests/lift-split.test.ts` | A select-all split into pieces applied in one tick equals the single command; a Goliath-only order still waits |
| `tools/duel-smoke.mjs` | Two pages through the relay, end to end: the lobby by hand, opener picks, orders, a one-way outage, pause, resign, equal trails, hashes and saved records, and a rematch with sides swapped; the match runs undrawn, and main-thread stops of 3 s or more outside relay cuts don't count |
