# Sound Duel — 1v1 between two phones, over sound

Two phones on a table play a 1v1 skirmish against each other. They have no
network connection: the only link is each phone's speaker and microphone. Each
phone runs the full deterministic simulation in lockstep (as MULTIPLAYER.md
plans for internet play), and only the players' orders cross the air, carried
by an acoustic modem running in an AudioWorklet.

This document is the specification the implementation follows. It was revised
after four independent design reviews (modem DSP, lockstep, platform,
integration); their simulations are behind several of the numbers below.
Background: `reports/Audio modem for lockstep multiplayer.md` (research),
`radio-probe.html` (the measurement page) and MULTIPLAYER.md.

## What the measurements say

The probe measured an iPhone receiving another phone 10 cm and 30 cm away
(October 2026):

- Power SNR was 40–70 dB in every 1 kHz band from 1 to 21 kHz.
- The limit was echo outlasting the OFDM cyclic prefix. With 21.3 ms symbols
  and a 5.3 ms prefix, the effective SNR was 17–31 dB at 10 cm and 9–19 dB at
  30 cm, with reflections arriving 8–15 ms after the direct sound.
- The sending speaker's harmonics were 40–60 dB down above 4 kHz, but only
  about 20 dB down below 3 kHz.
- Speaker-to-own-microphone round trip was 75 ms, identical for eight chirps.
- iOS leaves a 0.1–1.4 s hole in the recording right after the microphone opens.

Two things are not measured yet. Both are tested in the lobby (own-signal
monitor, two-way link meter) and listed under *Before launch*:

- an iPhone transmitting with its microphone open (iOS may route sound to the
  earpiece);
- a phone's own transmission at its own microphone while it listens.

## Decisions

| Decision | Choice |
|---|---|
| Network model | Deterministic lockstep, one turn per 100 ms tick, input delay D ticks (3–8, chosen at pairing from the measured round trip) |
| Duplex | Both phones transmit all the time, each in its own band (frequency-division duplex) |
| Band plan "high" (default) | Host transmits 9.525–12.5 kHz, guest 15.975–18.95 kHz. The host band's 2nd harmonic starts at 19.05 kHz, and each band's 3rd-order intermodulation stays clear of the other band |
| Band plan "low" (fallback) | Host 5.025–6.5 kHz, guest 8.025–9.5 kHz. It is audible and needs an output path that carries 9.5 kHz; use it only when a phone can't play the high band |
| Modulation | OFDM with 25 Hz tone spacing (40 ms symbols + 10 ms cyclic prefix). "Fast" uses differential QPSK; "robust" uses differential BPSK over twice as many symbols per packet |
| Payload | The same in both modes, so a mode switch never changes what fits: 188 bits per packet (high plan) or 186 (low). Fast packets take 100 ms (high) or 200 ms (low); robust packets take twice as long |
| Coding | Convolutional code (K=7, rate ½, 133/171), soft Viterbi with an agreement gate, interleaving, CRC-16 per packet |
| Transport model | Latest state: each packet carries one of the newest frames the upper layer handed over, repeated until replaced. No ARQ: frames re-describe every unacknowledged turn. When the unacknowledged turns outgrow one packet, they are split into up to K segments that the packets take in rotation (see "Segments and rotation") |
| Replay protection | Turns are accepted once each (high-water mark). Game packets use a CRC keyed to the pairing's two nonces, so a recording of another match fails its CRC. Pairing needs a fresh nonce echoed back. Jamming can't be prevented, only survived: lockstep stalls, it never desyncs |
| Sides | The host plays blue unless a rematch swapped it. Rematches swap sides, never roles or bands |
| Colours, camera | Fixed side colours (blue is blue on both phones), north up on both |
| Career | No XP, medals or stars. A separate local sound-duel win/loss record |
| Pause | Local and allowed. The other phone stalls within D ticks and shows "Friend paused" |
| Game speed | 1× on average; an automatic ±10% trim balances the two phones' slack |
| Desync | A world-hash trail, checked every 5 s and at the end of the match. A mismatch ends it as "no contest" with copyable debug info |
| Rematch | Reloads the page and reopens the lobby. Each phone taps Rematch, then "Tap to reconnect" (iOS may ask for the microphone again) |
| Gating | No build flag. The duel code is a lazily loaded chunk, prefetched when the menu shows and capabilities exist; the button appears only where AudioWorklet, getUserMedia and a secure context exist |

## Architecture

```
            phone A (host)                               phone B (guest)
  GameScene ── VersusFeed (MatchFeed, local) ─┐   ┌─ VersusFeed ── GameScene
                 Lockstep · codec             │   │   Lockstep · codec
                 Pairing (lobby)              │   │   Pairing
                 Session ─────────────────────┘   └── Session
                    │ LinkTransport                     │ LinkTransport
             WorkletTransport  (MessagePort)      WorkletTransport
             AudioWorklet: ModemCore              AudioWorklet: ModemCore
              TX host band ───────────)))──────── RX host band
              RX guest band ─────────(((───────── TX guest band
```

Everything below GameScene is pure TypeScript with no DOM and no timers, and
no `Math.random` in its logic. Clocks and randomness are injected, so the same
code runs in the browser, in the AudioWorklet and in Node tests.

## Modules

| Path | Contents |
|---|---|
| `src/sim/setup.ts`, `src/sim/checksum.ts` | `setupWorld(MatchSetup)` and `worldHash(w)` (done) |
| `src/sim/*` | The `resign` command, `world.resigned` and the `resign` FxEvent (done) |
| `src/game/controller.ts` | Live `PLAYER`/`ENEMY` bindings and `setLocalSide(f)` |
| `src/game/local-side.ts` | Pure helpers: `composeTick(local, mine, theirs)` (blue's commands, then red's) and `applyOpenersCanonical(w, picks)` |
| `src/link/transport.ts` | The `LinkTransport` interface and shared link types |
| `src/link/packet-air.ts` | `PacketAir`: two connected ends of a frame-level simulated link |
| `src/link/modem/*.ts` | The modem DSP: params, CRC, convolutional code and Viterbi, interleaver, scrambler, transmitter, receiver, self-monitor, `ModemCore` |
| `src/link/sim/room.ts` | A sample-level simulated room for two `ModemCore`s, with optional screen taps (white clicks at a phone's own microphone; how loud real taps are is not measured) |
| `src/link/room-transport.ts` | `RoomLink`: two `ModemCore`s in a `Room`, exposing two `LinkTransport`s |
| `src/link/worklet.ts` | The AudioWorkletProcessor wrapping `ModemCore` |
| `src/link/worklet-protocol.ts` | The processor's name and the worklet message types (no worklet code) |
| `src/link/rig.ts` | Opening, recovering and closing the audio |
| `src/link/worklet-transport.ts` | `WorkletTransport`: the real `LinkTransport` |
| `src/versus/codec.ts` | Bit I/O, Exp-Golomb, canonicalize/split, command codec |
| `src/versus/lockstep.ts` | `Lockstep`: turns, sealing, frames, acks, stalls, hash trail, end protocol |
| `src/versus/pairing.ts` | `Pairing`: the lobby protocol |
| `src/versus/session.ts` | Glue: transport + pairing, then lockstep, driven by a clock |
| `src/versus/feed.ts` | `VersusFeed implements MatchFeed` |
| `src/versus/lobby.ts` | The lobby sheet; exports `openRig`, `showLobby`, `reconnect` |
| `src/versus/hud.ts` | In-match overlays |
| `src/versus/records.ts` | Sound-duel win/loss record; the saved battle record |
| `src/versus/loop-peer.ts` | In-page sim + AI peer for `?duel=loop` |
| `src/versus/relay-transport.ts` | `LinkTransport` through page functions for `?duel=relay` |
| `src/versus/online.ts` | The online duel: `OnlineLink`, RelayTransport's packets over a WebSocket to `relay/` (a Cloudflare Worker, one Durable Object per 4-letter room), with reconnect; room codes, invite links (`?salon=ABCD`), `?relais=` for a local relay |

Import rules (enforced by a test like arena.test.ts):

- Nothing outside `src/versus/**` and `src/link/**` statically imports them.
- `main.ts` reaches them only through `import('./versus/lobby')` (exactly one
  such call site).
- They may use `import type` from `src/arena/**`, but no value imports.

`src/game/audio.ts` gains the band guard, which is plain game code, with its
filter design in the pure `src/game/guard-fir.ts` (the room model uses it
too). `src/game` imports nothing from `src/link` or `src/versus` except types.

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
  (left) or `end = 2` (desync) for 2 s before closing the rig. The receiver
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
  - "Signal lost: bring the phones closer" after 5 s;
  - Leave after 30 s.
- **Background.** On `visibilitychange` to hidden, the feed sets `paused`
  synchronously, so the repeated frame says paused and the peer shows "Friend
  switched away". On visible, see Rig > Lifecycle.

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

## The modem (`src/link/modem/`)

### Numerology

- **Sample rate.** `sr` is the AudioContext's rate. It must be a multiple of
  100: at least 44100 for the high plan, or 24000 for the low plan. Otherwise
  `rig.open` reports "This phone's audio runs at N Hz, which the sound link
  can't use". Durations that are not whole samples are rounded to the nearest
  sample on each phone (local only, never affecting interoperability).
- **Symbols.** Tone spacing is 25 Hz: tone `k` is at `25k` Hz, an exact DFT
  bin at every supported rate, so phones at 44.1 and 48 kHz share one grid.
  The useful symbol is `TU = 40 ms` (`N = 0.04 sr` samples), the cyclic prefix
  `TCP = 10 ms`, so a symbol is `TS = 50 ms`.
- **Band tones.**

  | Plan | Host tones | Guest tones |
  |---|---|---|
  | high | `k = 381…500` (120 tones) | `k = 639…758` (120 tones) |
  | low | `k = 201…260` (60 tones) | `k = 321…380` (60 tones) |

  Within a band, tone index `i % 8 == 0` is a pilot and the rest carry data:
  15 pilots and 105 data tones in the high plan (`T = 105`), 8 and 52 in the
  low plan (`T = 52`).
- **Packets.** `P` symbols per packet:

  | Plan | Fast | Robust |
  |---|---|---|
  | high | 2 | 4 |
  | low | 4 | 8 |

  `capacity = P × T × b / 2 − 16 − 6`, with b = 2 (fast) or 1 (robust): 188
  bits (high) and 186 (low) in both modes.
- **Superframe.** One sync symbol, then 40 data symbols (41 symbols, 2.05 s).
  That is 20, 10, 10 or 5 packets for high fast, high robust, low fast and low
  robust.

### Transmitter

- **Phases.** Every tone's phase changes differentially from one symbol to the
  next.
  - Pilots carry a fixed pilot phase set, never changing.
  - In the sync symbol, data tones carry pattern A (the next superframe is
    robust) or B (fast): `A_i = π·i²/T` (Newman, low crest factor) and
    `B_i = −A_i`, over data-tone index i.
  - The sync symbol is the differential reference for the first data symbol.
  - The mode changes only at a superframe boundary.
- **Packet bits.** The payload (exactly `capacity` bits, zero-padded), then
  CRC-16, then 6 zero tail bits. These are:
  - convolutionally encoded;
  - interleaved, so coded bit j (0 ≤ j < P·T·b) goes to symbol `s = j mod P`,
    data tone `t = (A·q + B·s) mod T` and bit-in-tone `floor(q / T)`, where
    `q = floor(j / P)` and `(A, B) = (8, 56)` for T = 105 or `(17, 4)` for
    T = 52;
  - XORed in slot order with a PN sequence: a 9-bit Fibonacci LFSR with state
    bits s1…s9, output s9, feedback s9 ⊕ s5, seeded with
    `1 + ((37 · packetIndex) mod 511)`.
- **CRC-16.** CCITT, polynomial 0x1021, MSB-first over the payload bits. The
  init is 0xFFFF for lobby frames. For game frames it is the session key,
  `crcKey(role) = (hash32(hostNonce, guestNonce, 7, role === "host" ? 0 : 1)
  & 0xFFFF) || 0xFFFF`, keyed to the transmitting phone's role.
- **Bit to phase.** Robust: a 1 bit gives a phase change of π. Fast: Gray
  from two bits, 00→0, 01→π/2, 11→π, 10→3π/2.
- **Synthesis.** Each symbol is the sum of the band's tones at equal
  amplitude, over `TCP + TU`, with a raised-cosine fade of
  `TW = round(0.00125 sr)` samples overlapping the next symbol's prefix.
  - The per-tone amplitude puts the band's RMS at −15 dBFS × gain, where
    `gain ≤ 1.5` (default 1). NaN falls back to 1 (or keeps the previous
    gain), a negative gain is silence.
  - A sample beyond ±0.9 is clipped and counted in the stats. 120 tones are
    nearly Gaussian (σ ≈ 0.18), so ±0.9 is 5σ: gain 1 clips 0–1 times a
    minute, 1.1 about 0.1/s, 1.25 about 2/s and 1.5 about 30/s. The lobby
    therefore offers gain only up to 1.1.
  - Synthesis uses a persistent oscillator bank.
- **Timeline.** The transmit timeline is indexed by the AudioWorklet's
  `currentFrame`, passed to `process()`. After a jump of J frames (output that
  was never rendered), it skips J samples rather than delaying, and starts a
  new superframe (a sync symbol) at the next symbol boundary. A frame counter
  that goes back silences output until the next boundary. A capture gap (an
  input block that is all zero or not finite) leaves the transmit stream
  alone: the output was rendered on time, so the friend's lock is intact.
- **Restart on re-acquisition.** A phone that locks again on a friend it had
  not heard for over 1 s starts a new superframe of its own, so the friend
  (which may have lost it too) gets a sync quickly, but only when the
  friend's new sync is off the superframe grid of the stream it knew (the
  friend's own audio stopped and started over). At most once per 5 s, and
  not if this phone restarted for any reason since it last heard that
  friend, so two phones can't keep restarting each other.
- **Payload.** The modem holds a list of payloads (`setPayloads`), each with
  a key. A packet takes, from the newest list delivered before its first
  symbol starts, the first payload whose key is greater than the last key
  sent, wrapping to the first ("Segments and rotation"). A list of one repeats
  in every packet. Without one, it carries all zeros (an invalid frame,
  ignored upstream). When a packet latches its payload, the modem emits a
  `slot` event with that packet's start frame and key. A payload longer than
  the band now on air (after a plan switch) goes out as all zeros with slot
  key null, and the rotation moves past it: a frame cut to fit would still
  pass its CRC.

### Receiver

- **Acquisition.**
  - The input is band-passed with a real FIR on the receive band. Before the
    band-pass, any FFT bin whose power is more than 30× the median of the
    band's bins is zeroed, so a steady tone in the band cannot swamp ρ.
  - `ρ(t) = ⟨x_bp, template⟩ / (‖x_bp‖ · ‖template‖)` over the 40 ms useful
    length, for the data-tone templates of A and B (pilots excluded). It is
    computed by FFT overlap-save, spread across audio blocks; above 96 kHz the
    FFTs are split into parts, one per call.
  - A candidate is a sample with `ρ ≥ 0.4` that is the maximum within ±50 ms,
    whose pattern beats the other by at least 0.15.
  - Its timing is the first path: the earliest sample within the 15 ms before
    the maximum with `ρ ≥ 0.5 ρmax`.
  - Lock is declared only when the first packet after the candidate passes its
    CRC and the gate. Otherwise the candidate is discarded and the search
    continues 50 ms later.
  - When the search has excised a bin of the receive band itself in the
    superframe before a candidate (a steady tone in the band), the trial
    demodulates from 16 symbols before the sync, as far as the input history
    holds them, to learn each tone's steady share (Soft bits) before the
    first packet decides the lock. With a tone between two of the friend's,
    robust is then heard up to 30 dB over its tone and fast up to 26 dB
    (before, neither from 23 dB). It costs about 0.15 s of acquisition, so
    only with such a tone.
  - Acquisition keeps running in the background while locked. A sync found
    elsewhere with ρ ≥ 0.4 that passes a packet replaces the lock.
- **Window.** WOLA:
  - take `N + β` samples, `β = round(0.00125 sr)`, starting `β/2` before the
    nominal window;
  - taper the first and last β samples (0.5 − 0.5 cos);
  - fold the last β/2 onto the first β/2 and the first β/2 onto the last β/2;
  - evaluate the N-sample DFT. (The implementation evaluates each tone over
    the N + β tapered samples at their true positions, which equals the fold
    at ε̂ = 0 and leaks less at ±300 ppm.)

  The nominal window starts `TCP − backoff` after the symbol start, with
  `backoff = round(0.001 sr)`. This cuts the phone's own transmission leaking
  through the window to about −80 dB (high plan). The post-echo guard is
  `TCP − TW − backoff − β/2 ≈ 7.1 ms`.
- **Clock tracking.**
  - Keep a clock estimate ε̂, initialised from the mean pilot slope over the
    sync and 4 symbols. When the stream's previous sync is still in ρ history
    one superframe earlier, the timing difference between the two syncs picks
    which 2π turn of the pilot slope is right.
  - Evaluate each tone's DFT at `f_k / (1 + ε̂)`, not at the bin frequency
    (Goertzel, or direct with a recurrence).
  - Advance the window by `TS · sr · (1 + ε̂)` per symbol in a fractional
    accumulator. Start it at the rounded position, apply the fractional
    remainder δ as `e^{+j 2π f_k δ / sr}`, and take any whole-sample change.
  - Per symbol, fit the residual pilot slope through the origin,
    `s = Σ |d_k| f_k arg(d_k) / Σ |d_k| f_k²` with
    `d_k = X_k(m) conj(X_k(m−1))` (s = −2π·Δτ). Update
    `ε̂ ← ε̂ − 0.1 · s / (2π TS)`. Remove `e^{−j s f_k}` from every tone's
    differential product.
  - The sync symbol is skipped in the fit: its pilots are continuous, but its
    data tones are not.
  - It must track ±300 ppm (it tracks ±700 ppm relative skew).
- **Soft bits.** Positive values mean bit 0. With `μ` = the mean of `|d̃|`
  over the packet's data tones, and λ clamped to ±4:
  - robust: `λ = Re(d̃) / μ`;
  - fast: `z = d̃ e^{−jπ/4}`, `λ0 = Re(z) / μ`, `λ1 = −Im(z) / μ`.
  - **Narrowband interference.** A data tone whose mean `|d̃|` over the packet
    exceeds 2× the median of its 9-tone neighbourhood is weighted by `(2/r)³`
    and its share of μ is capped at 2× that median. A tone whose signal stands
    less than 2× above the mean of its `d̃` (a plain mean over its first 32
    symbols, then a running mean with time constant 32; scrambled data
    averages out, a steady interferer does not) is weighted by `(SIR/2)²` —
    once that mean rests on 16 symbols and stands clear of the scatter noise
    alone leaves in it: its square over 4 × the expected square noise leaves
    in the mean (1/n for a plain mean of n, falling to α/(2 − α), α = 1/32)
    times the mean of `|d̃ − mean|²`, so a burst of noise doesn't make every
    tone look interfered. The pilot slope fit and the pilot SNR weight an
    outlier pilot (over 2× the median of its 5-pilot neighbourhood) the same
    way. With no interferer all of this is the plain rule above.
  - **Impulses.** A screen tap's click spoils a symbol, and from about 20 dB
    over the friend in band each click costs about a packet. Hit symbols are
    not erased: the gate can't judge a packet with a quarter to half of its
    symbols weighted out (noise then decodes to 7% disagreement, or 0.4%).
    How loud real taps are in these bands is not measured.
- **Decoding.** Descramble, deinterleave, soft Viterbi (zero-tail), then:
  - **gate:** re-encode the decoded bits and reject the packet if more than
    10% disagree with the hard decisions. A real packet disagrees by 0–1% at
    working SNR and by 7–12% at the edge of range; garbage by 10.8% at the
    least (a real stream read the wrong way), 11.4% for noise. At 8%, robust
    at 80 cm delivered 68% of its packets, against 93%;
  - **CRC:** check the session key first (when set), then 0xFFFF. A game frame
    must match the session key, and a lobby frame 0xFFFF.
  - **Duplicates:** a delivery whose window start is within 0.75 × the
    shortest packet of one of the last 8 deliveries is the same packet again
    (after a timing step) and is dropped.
- **Quality.** The packet's effective SNR is `1 / mean(phase error²)` over its
  pilots, in dB.
- **Superframes.**
  - At each expected sync, re-correlate ±5 ms with the first-path rule. Read
    the mode, and correct the timing by at most 0.5 ms per superframe.
  - If neither pattern clears 0.3 there, keep the timing and decode that
    superframe's packets in both modes; the CRC and the gate decide.
  - Drop lock after that plus 4 consecutive packets failing.
- **Gaps.**
  - Gaps of known length are zero-filled. The phone keeps its timing and ε̂,
    and marks packets overlapping the gap as erased.
  - While transmitting, an input block that is entirely 0.0, or that holds a
    NaN or infinity, counts as missing input: a live microphone that hears its
    own speaker never produces digital silence.
  - After a gap on either phone, good packets must resume within 2.5 s.
- **Self-monitor.** A second, pilots-only receiver locks onto this phone's own
  transmission at its own microphone. It reports:
  - `ownSnrDb`, the effective SNR of its own pilots, used for the route check;
  - `loopbackMs`, from its own sync's emission to its detection.
- **Self-test mode.** When the receive band is the transmit band, the main
  receiver decodes the phone's own packets: a one-phone check of the whole
  chain.
- **Plan detection (Join).** In the lobby the guest searches both plans' host
  bands until it locks, then sets its plan. Until then it transmits in the
  high plan's guest band whenever the rate allows (clear of both host bands),
  and `capacity()` is 186, what either plan carries (lobby frames are at most
  164 bits).

### CPU rules

- `process()` allocates nothing after construction. Buffers are preallocated,
  and messages are built only for rx, stats, slot and gap.
- It generates exactly its block's output from the oscillator state and folds
  the input into per-tone accumulators incrementally.
- It starts at most one deferred heavy job (an FFT block, a Viterbi, a sync
  re-correlation) per call.
- It takes blocks of any length, in pieces of up to 512 frames, with the
  trackers' work budget proportional to the block (375 tone-samples a
  frame, 48,000 for 128), so blocks of 512 or 2048 frames keep up.
- A frame-counter jump of any length costs bounded time in its block: the
  windows that start before the input history are passed over in one step
  (0.25–0.8 ms for a jump of 1 s to 1 h).
- A vitest benchmark runs ModemCore over 60 s and fails if a 128-frame block
  takes over 0.7 ms at p99 in Node.

### `ModemCore` API

```ts
export type ModemMode = "robust" | "fast";
export type BandPlan = "high" | "low";
export type BandRole = "host" | "guest";
export interface ModemConfig {
  sampleRate: number;
  plan: BandPlan;
  tx: BandRole;
  /** The band received: the other role's, the same (self-test), or "detect" (Join in the lobby: either plan's host band). */
  rx: BandRole | "detect";
  gain?: number;
}
export interface RxPacket { bits: Uint8Array; nbits: number; mode: ModemMode; snrDb: number; sample: number; plan: BandPlan; session: boolean }
export interface ModemStats {
  sample: number; locked: boolean; plan: BandPlan; rxMode: ModemMode | null; txMode: ModemMode;
  snrDb: number | null; rxOk: number; rxBad: number; syncs: number; clockPpm: number | null; txPackets: number;
  ownSnrDb: number | null; loopbackMs: number | null; clips: number; inputPeak: number;
}
export interface OutFrame { bits: Uint8Array; nbits: number; key: number }
export class ModemCore {
  constructor(cfg: ModemConfig);
  process(input: Float32Array, output: Float32Array, frame?: number): void;  // same length, any (128 in the worklet); frame = currentFrame
  setPayloads(frames: readonly OutFrame[]): void;               // MSB-first, each nbits ≤ capacity; keys ascending; rotated per packet
  setTxMode(mode: ModemMode): void;                             // from the next superframe
  setSessionKey(hostNonce: number, guestNonce: number): void;    // enables the session CRC
  reconfigure(cfg: Partial<ModemConfig>): void;                  // at the next symbol boundary
  capacity(): number;                                            // constant per plan
  take(): RxPacket[];                                            // these three return a shared frozen
  takeSlots(): { sample: number; index: number; key: number }[]; // empty array when there is nothing:
  takeGaps(): { sample: number; frames: number }[];              // never mutate it
  rateProblem(): string | null;
  stats(): ModemStats;
}
```

- **Sample.** `RxPacket.sample` is the input-sample index (the `currentFrame`
  domain) of the first sample of the packet's first DFT window.
- **Bits.** MSB-first: bit `i` is `(bits[i >> 3] >> (7 − (i & 7))) & 1`.

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
- **`RoomLink`** runs two `ModemCore`s through a `Room` in 128-frame blocks.
- **Transports without the modem's CRC** (PacketAir, RelayTransport) must
  emulate the session key: carry the key with each game frame and drop
  mismatches, or report `session: true` only for game frames sent under the
  receiver's key.
- **`WorkletTransport`.**
  - `now() = performance.now() − t0`: monotonic, and it keeps running while
    the link context is suspended or rebuilt.
  - Each worklet message carries `sample`. A packet's
    `at = now() − max(0, (ctx.currentTime × sr − sample) / sr × 1000)` plus
    the rest of the packet after its first DFT window (backoff + (P − 1)·TS +
    TU), so `at` is when it finished arriving, as for every transport.
  - `loadWorklet(ctx)` runs `addModule` once per context (a WeakMap).
  - `stats()` and `modemStats()` go stale once the newest report is over 1 s
    old, or after a fatal error: unlocked, no SNR. `stopped` says the modem
    stopped (a fatal error, or the node's `processorerror`); it is set before
    `onError` hears why, so a handler can tell it from a message the modem
    only refused.
  - Suspensions: at every message it compares `now()` with
    `ctx.currentTime`. A step over 100 ms stands once the lowest reading of
    the last 100 ms agrees with the lowest of the 200 ms before within the
    readings' own spread (3 × the median excess of 20 baseline readings over
    their lowest, kept between 15 and 50 ms); it is then sent as a `skip`, so
    the modem starts a new superframe and its friend re-acquires it quickly
    (218–495 ms after resume in Chromium, against 1.1–1.4 s). A catch-up
    slower than the spread per 100 ms can't be told from lost time. The
    suspended phone's own receiver waits for its friend's re-acquisition
    restart (above): its microphone input comes back about 20 ms off the
    context's clock.
  - While a Join detects its plan, `capacity()` is 186 until a report of its
    own shows the lock; `detectedPlan()` says what it found.

### Worklet

- **Loading.** `src/link/worklet.ts` is imported as
  `./worklet.ts?worker&url`. A production build emits a self-contained IIFE,
  which `addModule` accepts and the PWA precaches. Rig keeps a
  `WeakMap<BaseAudioContext, Promise<void>>` so addModule runs once per
  context.
- **Allowed globals.** The worklet and everything it imports use no
  `import.meta`, dynamic `import()`, `self`, `window`, `document`, `location`,
  `performance`, timers, `TextEncoder`/`TextDecoder`, `crypto` or `fetch`. Only
  JS builtins plus `sampleRate`, `currentFrame`, `currentTime`,
  `registerProcessor`, `AudioWorkletProcessor` and `port`. Their declarations
  are module-local in worklet.ts, never `declare global`.
- **Creation.** The node is created at the Host, Join or Self-test tap, with
  `processorOptions: ModemConfig`, `channelCount: 2`, `"explicit"` and
  `"discrete"`.
- **Channel choice.** Each block uses the louder channel when the other is
  more than 40 dB quieter, and channel 0 otherwise. It never sums two live
  microphones, which comb-filters.
- **Messages.**
  - Main → worklet: `{t:"payload", frames}`, `{t:"mode", mode}`,
    `{t:"session", hostNonce, guestNonce}`,
    `{t:"config", plan, tx, rx, gain}`, `{t:"skip", frames}` (the context
    stopped rendering for that long: the modem takes it as a jump of its
    frame counter), `{t:"close"}` (after which `process()` returns false).
    The processor's name, `MODEM_PROCESSOR`, and the message types live in
    `src/link/worklet-protocol.ts`, which imports no worklet code.
  - Worklet → main: `{t:"rx", ...RxPacket}`, `{t:"slot", sample, index, key}`,
    `{t:"stats", ...ModemStats}` (about 4 per second), and
    `{t:"gap", sample, frames}` (once when a gap starts, once with its total
    when capture resumes), and `{t:"error", message, fatal}` (fatal: the
    modem could not start or stopped; any exception in `process()`, the
    modem's block or turning what it reports into messages, is one, so the
    page hears why rather than a bare `processorerror`). Every `sample` is a
    frame in the context's `currentFrame` domain as the context's clock runs
    now.
- **Tests.** `tools/worklet-smoke.mjs` builds dist, then loads the built
  worklet in Playwright Chromium. It uses an OfflineAudioContext at 48 kHz with
  two nodes (host and guest) cross-wired through gain and delay paths (own path
  loud, peer path quiet), and asserts payloads decode both ways. It should
  also be run once in WebKit or on an iPhone.

### Rig (`src/link/rig.ts`)

The rig never imports game code: the lobby turns the guard on and off. It
reports failures as a `RigError` with a reason (`no-audio`, `no-worklet`,
`mic-refused`, `no-mic`, `rate`, `update`), and `createLink(cfg)` resolves a
`RigLink`, a `LinkTransport` that survives a context rebuild underneath
(same `t0`; config, gain, frames, mode and session key replayed). A Join's
link, once its detection has locked, is rebuilt on the plan it found with
`rx: "host"`.

- **Open.** `openRig({ micMode })` runs synchronously inside the tap. It:
  - creates an AudioContext (`latencyHint: "interactive"`, default rate);
  - then sets `navigator.audioSession.type = "play-and-record"`;
  - resumes the context and plays a 1-sample silent buffer;
  - requests a wake lock;
  - starts getUserMedia;
  - returns a promise that resolves when the microphone is connected.

  After getUserMedia it calls `ctx.resume()` again and checks that the state
  is `"running"`; if not, the lobby shows "Tap to start sound".
- **The rate.** Safari gives a new context a snapshot of the shared audio
  session's rate, refreshed only when the session activates, and resamples
  the context's output to that snapshot on its way to the speaker (WebKit's
  `RemoteAudioDestinationProxy`), so asking the constructor for 48 kHz only
  changes the label. An iPhone that gave the radio probe 48000 gave the rig's
  context 16000 Hz. Two things could have left that snapshot low, and only a
  device can tell which it was, so both are guarded against: play-and-record
  (voice-chat mode) set before creating the context (hence the order above),
  or play-and-record left over from an earlier page, since Safari keeps the
  type across reloads in a tab while the new page reads "auto" (hence the
  reset at every boot and reload, "Rematch" > "Boot"). And once the microphone is
  in (capture activates the session), a context whose rate can't carry the
  high plan is replaced by a new one, which reads the rate afresh and may
  start without a tap while the page captures; the microphone is asked for
  again if its own format was fixed at the low rate. A context a reconnect
  rebuilds gets the same second try once the microphone is in. What is
  still too low after that is the true rate. The lobby's error names the
  context's rate, or the microphone's (`getSettings().sampleRate`) when that
  is the low one (a Bluetooth headset).
- **Mic modes.**
  - `raw` (default): `{echoCancellation: false, noiseSuppression: false,
    autoGainControl: false, channelCount: {ideal: 1}}`.
  - `ec`: the same with echo cancellation on.

  Changing the mode lets the old microphone go first, then requests it in
  the new mode and reconnects the source: Chrome on Android enters its
  communication mode only as the first input stream opens (if that one has
  echo cancellation) and leaves it only as the last one closes. A failed
  request falls back to the old mode. Switches run one at a time.
- **Refusal.** If the microphone is refused, the rig closes the context and
  sets the session back to `"auto"`; the lobby turns off the guard, resumes
  the menu music and shows "Microphone refused". The same holds for every
  `RigError`.
- **Capture.** Lockstep starts only after 1.5 s of gap-free capture
  (`captureOkMs()`, counted from the latest of the microphone's connection,
  the end of the last gap and the context starting to run).
- **Lifecycle.** `onLost(reason)` fires on:
  - the track ending;
  - the track muted for more than 1 s;
  - the link context not running for more than 0.5 s;
  - `devicechange`;
  - the modem stopping (`"modem"`: the worklet's fatal error, or its
    processor failing), while its link is the live one. The rig hears it
    after the link's `onError`, so the lobby, which lets the rig go on it
    before the match, owns it until the match takes the rig over. A message
    the modem only refused is no loss.

  The rig never suspends its own context. On visible, it re-requests the wake
  lock. If the context isn't running or the track has ended, a full-screen
  "Tap to reconnect the sound link" overlay appears. Its tap resumes the
  context, and re-requests the microphone into the existing worklet node if
  needed, so the modem state and `now()` survive. If the context is broken, or
  its modem stopped (only a new node brings it back), the tap rebuilds it,
  with a new node and modem and the link's state replayed; a tap that leaves
  the modem stopped counts as failed. A context that runs again by itself,
  or moves to suspended (an iOS call ending), is resumed and kept, not
  rebuilt. A microphone whose own rate can't carry the plan (a Bluetooth
  headset that joined mid-match) fails the tap with the rate error, and the
  next tap asks for it again. After a failed tap the overlay says why when
  the rig knows (`lastError`: the microphone refused or missing, the rate, a
  worklet that won't load), with the lobby's advice for it ("Try again with
  headphones and Bluetooth disconnected."); the report's reconnect button
  after the match says the same. After 2 failures it offers Leave. A tap
  after which the link is lost again within 10 s (`RECOVERED_MS`: a modem
  that stops again at every rebuild) counts as failed after all, so the
  overlay still gets there. The
  overlay closes after 1.5 s of gap-free capture. A "tap-to-start" rig moves to running by itself
  if the context starts without a tap, so the lobby watches the state.
- **No wake lock.** Where the wake lock is missing (Safari before 16.4),
  does nothing (an iOS Home Screen app before 18.4: the API is there and
  `request()` resolves, but the screen still locks; WebKit bug 254545, fixed
  in iOS 18.4), or its request is refused, the lobby says to set Auto-Lock to
  Never.
- **Close.** `close()` stops the tracks, closes the context and sets the
  session back to `"auto"`.

### Game audio guard (`src/game/audio.ts`)

`sfx.setLinkGuard(plan: BandPlan | null)`. The chain becomes:

```
master → high-pass 300 Hz → guardGain (−(GUARD_CUT_DB + makeup)) → limiter → { dry | FIR (ConvolverNode) } → destination
```

- **Limiter.** `GUARD_LIMITER`: threshold −30 dB, knee 0, ratio 20, attack
  2 ms, release 150 ms. Web Audio's automatic makeup at those settings is
  +17.1 dB, so the guard gain takes it back: otherwise sounds under the
  limiter would come out 7 dB louder than with no guard. The cut applies at
  once and the limiter settings 60 ms later, after the compressor's
  look-ahead has flushed the uncut sound (switching both at once gave a 6 ms
  burst about 16 dB too loud).
- **On and off.** `setLinkGuard(plan)` also sets `sfx.linkMode`, and
  `setLinkGuard(null)` clears it and restores the original chain exactly. It
  builds the FIR before rewiring, so a browser failure leaves the chain as it
  was (it throws; the Duel tap catches it). At a rate too low to reach the
  stopband the FIR is the identity.

- **Crossfade.** Dry and FIR crossfade over 50 ms.
- **FIR.** A Kaiser windowed sinc designed at the context rate:
  - high plan: flat to 8 kHz, ≥ 70 dB down from 9.5 kHz (about 133–145 taps);
  - low plan: flat to 4 kHz, ≥ 60 dB down from 5 kHz.

  The ConvolverNode's `normalize` is set to false before its buffer.
- **Cut.** `GUARD_CUT_DB` is 10 dB on every phone and in both microphone
  modes: an iPhone plays a play-and-record session from the loudspeaker
  beside its microphone (WebKit sets DefaultToSpeaker on every such session
  unless the page picked the receiver with `setSinkId`, which this one never
  does). `setMuted` keeps controlling master only.
- **Level.** The FIR only keeps the game's own sound out of the receive band.
  Loud game audio also hurts through the speaker's nonlinearity and by
  pushing the microphone towards clipping: in the room model, game audio at
  −20 dBFS RMS after the guard with the own path at +40 dB cut delivery to
  84–90%. A battle mix built from the game's own sound recipes and levels
  measures −19 dBFS RMS (−3.5 peak) at the master and −37.6 RMS (−19.7 peak)
  after the guard; delivery is 100% both ways at gain 1 and 1.1, both modes,
  48/48 and 48/44.1 kHz, and still 100% with the cut at 0 and the mix 20 dB
  louder (tests/link-guard.test.ts).
- **Speech.** A transient `sfx.linkMode` (never saved) turns spoken lines off:
  the announcer, `radioCheck()` and the speech priming listener skip speech,
  and `speechSynthesis.cancel()` runs on entry.
- **Reverb.** In link mode, Music bypasses its reverb send.
- **Timing.** The Duel tap turns the guard on and stops the menu music before
  anything else plays. It stays on through the lobby, the match and the report
  until the player leaves the duel. Cancel and every lobby error turn it off
  and resume the menu music, unless a game started from the menu while the
  lobby still said the end (Cancel past GO, then Play): that game keeps its
  own music.

## Game integration

### Getting into a duel

- **Prefetch.** `showMenu` starts `const duel = import('./versus/lobby')` once
  the menu mounts where the capabilities exist. The "🔊 Duel a friend (sound)"
  button (Skirmish tab) stays disabled until the chunk has loaded.
- **The tap.** The click handler runs synchronously, in this order:
  1. `sfx.unlock()` (the game's context before the rig's play-and-record, as
     the rig's own, "The rate": from the menu the first touch made it and this
     only resumes it, but the rematch boot makes none until this tap);
  2. `duel.openRig({ micMode })`;
  3. `sfx.setLinkGuard("high")`;
  4. `music.stop()`;
  5. full screen: on a practice link `void fullscreen.enter()` (last: it
     consumes the activation); otherwise, once `rig.ready` resolves,
     `fullscreen.enterOnGesture()`, so the request comes on the first tap after
     the microphone is in (on iPadOS a full-screen page hides the microphone
     prompt). A lobby that closes first disarms it;
  6. `duel.showLobby({ shownMap, mutators, start })`.

  If the import or `addModule` fails, the lobby says "A new version is ready:
  reload this phone (and your friend's)".
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
  and `battledrones.duel = { role, plan, micMode, hostSide: flipped, mapId,
  mutators }`, then reloads.
- **Boot.** Every boot sets `navigator.audioSession.type = "auto"` before any
  audio context exists (`main.ts`, at module load): Safari keeps the type a
  page set across a reload or a navigation in the tab while the new page reads
  `"auto"`, and the rig must make its context before play-and-record. Every
  reload (`fullscreen.reload`) does the same before the page goes, and the
  lobby closes the rig on `pagehide` (not into the back-forward cache) until
  the match's feed takes it over. On boot, `main.ts` sees `"duel"`. Before any
  audio context exists, it:
  - sets `sfx.linkMode`;
  - prefetches the lobby chunk;
  - shows one button, "Rematch · tap to reconnect (allow the microphone if
    asked)".

  The button runs the Duel tap sequence and then pairs with the stored role
  and plan. The host reuses the stored map and mutators. Roles and bands never
  swap.
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

A noise warning sits under the sheet's title on every step of a sound link
(not a practice link): "⚠️ Warning: unpleasant noise. The sound link plays a
constant high-pitched noise for the whole match. Many people find it
unpleasant, and it may even cause headaches. Stop if it bothers you." It shows
from the microphone prompt on, before Host or Join makes any sound.

1. **Placement.** "Lay both phones flat, 10–30 cm apart. Turn the volume to
   about 75%, silent switch off. On an iPhone the sound may come from the
   earpiece at the top: turn the phones until both bars below are full."
2. **Host / Join**, with Advanced settings: band plan (host only), mic mode,
   and Self-test (one phone: decodes its own packets).
3. **Live link meter**, both directions:
   - "You hear your friend": this phone's receive SNR and good packets;
   - "Your friend hears you": the peer's rxq;
   - the round trip.

   Two warnings may appear:
   - **Route check:** if `ownSnrDb < 10` for 3 s, "This phone can't hear its
     own signal: sound may be going to the earpiece or Bluetooth, or it can't
     play this band. Unplug headphones, turn the volume up, or switch the host
     to band Low." (In a rematch, or where this phone hosts on band Low
     already, it ends "Unplug headphones or turn the volume up.")
   - **Loud own signal:** a stats report counts when the microphone peaks
     above −6 dBFS while the self-monitor hears the own signal
     (`ownSnrDb ≥ 10`): a clap or a voice is not the phone's own signal. An
     unbroken 2 s run of them lowers the gain 3 dB, at most once a second,
     down to 0.5; it comes back up 1 dB every 2 s after 5 s with none. The
     note never shows together with the route warning.
4. **Paired:** the map name or code and the mutators, then opener cards, then
   "Waiting for your friend to pick…".
5. **GO**, then loading, then the match.
6. **Errors:**
   - version mismatch;
   - microphone refused;
   - unsupported sample rate;
   - nothing heard (after 8 s, the role-switch hint; after 30 s, tips);
   - the update-ready message;
   - the modem stopped: the worklet's errors reach the lobby through the
     link's `onError`. A fatal one (`RigLink.stopped`, set before `onError`;
     a link that can't say falls back to its stats having gone stale) shows
     "The sound link stopped working." with "Close, then tap Duel to start it
     again. (<the modem's words>)", Close and Reload, and lets the audio go
     at once. A message the modem only refused is logged. Once the match
     has begun the lobby only logs them, and the rig takes a stopped modem
     as a lost link (Rig > Lifecycle).

## Dev and test modes

- **`?side=red`** (every build): single player as red against a blue AI.
- **`?duel=loop[&delay=4][&loss=0.1][&latency=250][&side=red]`** (every
  build): the Duel button skips the rig and the guard. It pairs over PacketAir
  with an in-page peer that steps its own `setupWorld` copy from
  `VersusFeed.frame` and plays at normal difficulty (incomeMult 1). The config
  comes from the menu. Values are clamped: delay 3–8, loss 0–0.9, latency
  0–2000.
- **`?duel=relay&seat=host|guest`** (every build): the Duel button skips the
  rig and the guard.
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
- **Phone testing** needs HTTPS: the microphone and AudioWorklet need a
  secure context, and a page at a LAN address over plain http:// has no Duel
  button. `npx vite --config tools/vite-https.config.ts` runs the dev server
  over HTTPS on every address, with a self-signed certificate it makes once
  with the system's openssl (no package to install); `npx vite preview
  --config tools/vite-https.config.ts` serves a build the same way. Each phone
  warns once that the connection is not private: proceed. Chrome registers no
  service worker under a certificate it doesn't trust, so the offline check
  needs a trusted one (the Pages build).

## Tests

Long tests set explicit timeouts (60–180 s).

| Test | Checks |
|---|---|
| `tests/resign.test.ts` | Resign, a draw on a mutual resign (the arena's `endOf` and the duel's end helper agree on it, and a re-simulated record keeps it), and setup and hashing shared with records (done) |
| `tests/local-side.test.ts` | `setupWorld` gives the same world whoever is local; `applyOpenersCanonical` and `composeTick` are canonical for both local sides; a red Controller issues red commands |
| `tests/versus-codec.test.ts` | Bit I/O and Exp-Golomb. For every command `c` in a corpus from AI-vs-AI arena matches (several maps and mutators, showcase records) plus hand-written cases for every type, with `k = canonicalize(c)`: `canonicalize(k)` deep-equals `k`, and `decode(encode(k))` deep-equals `k` (Object.is per scalar, element-wise for unitIds). Split pieces are ≤ 96 bits and keep order. Malformed inputs are rejected. The enum tables are complete |
| `tests/versus-lockstep.test.ts` | Two worlds and two `Lockstep`s through `PacketAir`, normal-difficulty AIs on both sides for 5 game minutes: identical hash trails at every tick. Run at 0%, 10% and 30% loss, and with 3 s dropouts; with bursts of 30-unit orders; with pause; resign ends both on the same tick; a desync injected into one world is caught at the next checkpoint or the end check; leave and end frames work; stall time is bounded; the saved BattleRecord round-trips through `parseRecord` and `replay()` with no divergence. Segments: a 30-unit order lands in one rotation; out-of-order segments are kept; rotation never raises stall time against K = 1 at 0% loss |
| `tests/versus-pairing.test.ts` | Two `Pairing`s over `PacketAir` agree on config, seed, D and openers; a build mismatch is refused; duplicate, stale or out-of-order lobby frames are harmless; both-Host is detected; a recorded HELLO from another session can't complete pairing |
| `tests/versus-feed.test.ts` | VersusFeed with a real Controller and fake clock: a stall consumes no input, sealing happens once per tick, the order is canonical with the local side red, and nothing is sealed while paused; the record is written at the decision, and as abandoned at once by a page hidden mid-match; the visibilitychange and pagehide wiring; the stall pill, the pause menu's ways out, "Resign and leave" and "Orders queued"; the reconnect cover (a modem that stopped too), saying why a tap failed |
| `tests/versus-imports.test.ts` | The import rules above |
| `tests/duel-abort.test.ts` | GameScene's abort for each reason: the end screen with no winner, the music settled once with no sting |
| `tests/link-fec.test.ts` | CRC-16 known vectors and the session keys; convolutional code plus Viterbi corrects scattered errors; the gate rejects random input (0 false accepts in 10⁶ garbage packets, every one over the gate by a point, and none of 76,200 real streams decoded the wrong way); the interleaver properties for all four plan/mode cases; distinct, non-zero PN seeds |
| `tests/link-modem.test.ts` | Two `ModemCore`s through `Room`, transmitting at once, own path +40 dB with unaligned symbols, h2/h3/h5 speaker nonlinearity, and a game-audio jammer through the guard, at 48/48 and 48/44.1 kHz and ±300 ppm. Robust ≥ 99% good at "20 cm" and ≥ 95% at "40 cm" (with an 8–15 ms reflection cluster); fast ≥ 98% at "20 cm". Also: acquisition from 50 random starts never locks off the true timing; a 40 ms and a 700 ms jump on the sender recover within one superframe; a 1 s capture gap recovers within 2.5 s; mode switches; plan detection; self-monitor and self-test; latency bounds `(TS + P·TS) + 128/sr + room delay`; the CPU benchmark; the edge of range (80 cm, a noisy microphone: ≥ 88% robust both ways); a steady tone 26 dB over the friend between two tones, from the start and after a 2.5 s dropout; screen taps; a jump of ten minutes or an hour; blocks of 512 and 2048 frames |
| `tests/link-worklet.test.ts` | WorkletTransport against a fake port and context (clock mapping, stale stats, a stopped modem, skips, close), the real processor class in Node through a shim decoding both ways (a fault anywhere in `process()` posts the fatal error), and the worklet's import graph using only the allowed globals |
| `tests/link-rig.test.ts` | The rig's state machine against fakes: open, refusal, lost reasons, reconnect and rebuild (a Join on its detected plan), capture tracking, close during a rebuild; mic mode switches (old microphone first, one at a time); a microphone's rate on a reconnect or switch; keeping a context that recovered by itself; a modem that stops (a fatal error or the processor failing, through real WorkletTransports: one loss, after the link's onError, and a rebuild); the wake lock (iOS Home Screen apps before 18.4, refusal) |
| `tests/versus-session.test.ts` | Two Sessions over PacketAir from pairing through a match with AIs: identical trails at 0/10/30% loss and a 3 s outage, a slow loader, the session CRC after GO, mode adaptation, leave and end frames from every phase, replayed lobby frames; the mode from GO to the match (fast lost one way, a friend that missed this phone's GO); the wait for a friend that plays on after a pause |
| `tests/versus-pacing.test.ts` | Two Sessions stepped at 60 Hz over PacketAir (both plans and modes) and RoomLink: 10 ticks/s within 0.01 over three minutes, and at most 150 ms of stall |
| `tests/versus-relay.test.ts` | RelayTransport checks each CRC for its own frame type, even under a session key of 0xFFFF |
| `tests/lift-split.test.ts` | A select-all split into pieces applied in one tick equals the single command; a Goliath-only order still waits |
| `tests/link-guard.test.ts` | The FIR guard's response for both plans at 44.1 and 48 kHz, and delivery with a loud battle mix through the guard at own path +40 dB |
| `tests/duel-fullstack.test.ts` | Pairing, then a 90 s duel through `RoomLink` and VersusFeed (and, for Join, the lobby, each modem starting at its tap) with AIs and 30-unit bursts on both phones: identical hash trails, at least 90% of ticks without a stall after the first 2 s (counted as ticks that waited and as time stalled), equal saved records that replay. High and low plans; 48/44.1 kHz at ±300 ppm with the jammer and own path +40 dB; a 1 s capture gap and a 700 ms jump; Join detection on both plans |
| `tools/worklet-smoke.mjs` | The built worklet decodes both ways in Chromium |
| `tools/duel-smoke.mjs` | Two pages through the relay, end to end: the lobby by hand, opener picks, orders, a one-way outage, pause, resign, equal trails, hashes and saved records, and a rematch with sides swapped; the match runs undrawn, and main-thread stops of 3 s or more outside relay cuts don't count |

## Before launch, on real phones

- The probe's iPhone **send** runs: raw and ec, mic on and off, at 10 and 30
  cm. These decide the default mic mode and the placement text.
- Full-duplex isolation in each phone's receive band while it transmits, at
  the default gain, with game audio playing.
- 16–19 kHz output on a range of Android speakers.
- Backgrounding, phone calls and Siri, and AirPods connecting mid-match.
- Offline: both phones in airplane mode after one online visit. Pair and play,
  which proves the worklet and lobby chunk come from the precache.
- WebKit or an iPhone running `tools/worklet-smoke.mjs`.
- Switching the mic mode in the lobby on Android Chrome (in and out of
  communication mode), and the Auto-Lock note in an iOS Home Screen app
  before 18.4.
- How loud screen taps are in each band at a phone's own microphone,
  recorded with the radio probe on both phones: from about 20 dB over the
  friend each tap costs about a packet (Receiver > Impulses).
