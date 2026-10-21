/**
 * The sound duel's lobby (SOUND-DUEL.md "The lobby", "Getting into a duel",
 * "Rematch", "Dev and test modes"): the sheet between the menu's Duel tap and
 * the match. It places the phones, takes Host or Join, shows the link both
 * ways while the two phones pair, offers the opener cards, and once both said
 * GO and the microphone has had its 1.5 s of gap-free capture, builds the
 * VersusFeed and hands it to main.ts's start(). The lazily loaded duel chunk
 * starts here: main.ts reaches src/versus and src/link only through
 * `import("./versus/lobby")`.
 *
 *   the Duel tap (main.ts, synchronously):  const t = duel.tapPlan(); sfx.unlock()
 *     const rig = t.practice ? null : duel.openRig({ micMode: t.micMode })
 *     t.practice || sfx.setLinkGuard("high"); music.stop()
 *     rig ? rig.ready.then(() => fullscreen.enterOnGesture()) : void fullscreen.enter()
 *     duel.showLobby({ host: menu, rig, shownMap, mutators, start, onClose })
 *   the rematch's reconnect tap: the same with tapPlan(true), then duel.reconnect({ … })
 *
 * The lobby's logic is LobbyMachine (no DOM: a clock, a link factory and the
 * rig come in through LobbyEnv, so tests drive it over PacketAir); the sheet
 * renders its state() every frame and sends it the taps.
 *
 * Practice links (every build): `?duel=loop` pairs with an in-page friend
 * over PacketAir (loop-peer.ts), `?duel=relay&seat=host|guest` through the
 * page functions __duelOut / __duelIn (relay-transport.ts). Neither opens the
 * rig or the guard, and both expose window.__duel = { state, tick, delay,
 * trail(), trails(from), hash(), result } for test harnesses (delay and
 * trails beyond the spec: the smoke's checks follow D, and compare the trail
 * at every tick).
 *
 * Where the spec is silent:
 *  - the lobby keeps its own settings (localStorage battledrones.duelprefs):
 *    the host's band plan and the mic mode. The Duel tap needs the mic mode
 *    before the sheet exists (openRig comes first), so tapPlan() reads it;
 *  - Advanced is offered before Host or Join only, and Back (before GO)
 *    returns there: the route check's advice ("switch the host to band Low")
 *    is one Back away. A rematch keeps its band and has no Advanced, so its
 *    route warning leaves that advice out, as it does where this phone hosts
 *    on band Low already. Self-test is a host session whose receiver listens
 *    to its own band; it is not offered on practice links;
 *  - a Join's link starts in the high plan's guest band (rx "detect"), or the
 *    low plan's when the context's rate can't carry the high one; the guard
 *    follows the plan the link locks on. A host's guard follows its plan;
 *  - the route check counts ownSnrDb below 10 dB for 3 s, where no reading
 *    (the self-monitor hasn't locked) counts from one superframe (2.05 s)
 *    after the link started, the time it needs to hear its own first sync.
 *    Practice links have no own signal and skip it;
 *  - loud own signal: it is this phone's own signal that matters, so a stats
 *    report counts as loud only when its microphone peak is above −6 dBFS
 *    while the self-monitor hears the own signal (ownSnrDb ≥ 10 dB, where the
 *    route check says it does), and only an unbroken run of them for 2 s acts
 *    (a clap, a knock or a word is over by then). Not "heard well": an own
 *    signal that clips the microphone reads lower the harder it clips (own
 *    output looped back and hard-clipped at ±1: 34–42 dB at 2× full scale,
 *    21–24 dB at 3×, 15–18 dB at 4×, 11–16 dB at 5–6×), while a loud sound
 *    of another kind either leaves it as it was or buries it (a full-scale
 *    burst read −4 to 6 dB, steady noise 0 dB) and doesn't last 2 s in a row
 *    above 10. (Past about 8× the clipped own signal dips under 10 dB, 6–10
 *    at 15–40×: there neither rule acts for sure, and the route check may
 *    speak instead.) Then the transmit gain drops by 3 dB, at most once a
 *    second, down to 0.5 (−6 dB: what brings a peak just over −6 dBFS well
 *    under it, while the friend still hears this phone within 6 dB of its
 *    usual).
 *    Once 5 s pass with no loud report it climbs back by 1 dB every 2 s to
 *    the gain the lobby chose, 1 (the modem is offered up to 1.1). The note
 *    shows while the gain is below 1, never with the route warning, which
 *    says the opposite. The gain the lobby leaves at GO goes into the match;
 *  - "nothing heard": the pairing's own 8 s hint offers the one-tap role
 *    switch (not in a rematch or on a relay seat: roles are fixed there);
 *    after 30 s since the role was tapped with still nothing of the other
 *    role heard, tips;
 *  - a rematch pairs at once in its stored role and plan (the guest receives
 *    the stored plan's host band, no detection) and falls back to the menu
 *    (onClose("fallback")) after 60 s from the tap with nothing heard;
 *  - Cancel, Back and a closed error say the end to a friend that may have
 *    started (Session.leave), keep the link on until the session is
 *    closable, then close the rig, turn the guard off and call onClose
 *    (main.ts resumes the menu music). A RigError releases the audio at once
 *    and leaves its message up until it is closed;
 *  - a friend that left once this phone said GO ("Your friend left",
 *    status().peerEnded: it started on this phone's GO, which this phone
 *    never heard it answer, or this phone waits for its capture) stops the
 *    lobby there: no match is loaded;
 *  - a friend heard and then silent for 8 s (QUIET_MS) gets a line under the
 *    status ("Your friend's phone has gone quiet"), from pairing to GO: the
 *    pairing has no timeout of its own after GO, and a friend that went Back
 *    before it heard this phone's pick has nothing to say. Its next tap of
 *    Host or Join finds this phone again (the pairing lets the friend's next
 *    incarnation take over), so the lobby waits on; Cancel is the way out;
 *  - the meter shows only what is current: this phone's SNR of the friend
 *    while packets arrive (RX_SILENT_MS, as the session's rxq), and the
 *    friend's rxq of this phone while its frames do (PEER_HEARD_MS);
 *  - a retry ("Pairing failed: tap to retry") starts the tips' 30 s and a
 *    rematch's 60 s again, as the pairing starts its 8 s hint again;
 *  - the tips leave band Low (Advanced) out of a rematch, which keeps its
 *    band and has no Advanced, and on a practice link speak of the page and
 *    the relay instead of the volume, the silent switch and Bluetooth;
 *  - on the loop the meter's round trip would be the friend's hold, which
 *    forces &delay (seconds, at a long one): its line names the input delay
 *    the pairing agreed instead. The relay's round trip is the relay's own;
 *  - the opener cards say what each opener gives, as the single-player
 *    picker's pills do, from the same data (openerGives);
 *  - the guard is put on this machine's plan whenever a link starts, not
 *    trusted to be as the tap left it (main.ts takes no Duel or Rematch tap
 *    while a lobby is open or still saying the end, so two lobbies never
 *    share it);
 *  - a version error names the older phone when the protocols differ;
 *  - the page going away while the lobby holds the rig (its Reload, the
 *    player's own reload, a navigation) closes the rig at once, with no end
 *    said (closeRigOnPageGone): the rig puts iOS's audio session back to
 *    "auto", which Safari would otherwise keep as play-and-record for the
 *    next page in the tab. From the match on, VersusFeed's pagehide does it;
 *  - window.__duel.state is the lobby's step (LobbyStep) until the feed is
 *    built, then the session's phase; result is null until the match begins,
 *    then the lockstep's end, decision and end check;
 *  - the modem's errors (the link's onError) are all logged. One after which
 *    the modem no longer reports (it stopped, or never started: its stats go
 *    stale at once) ends the lobby as a RigError does, "The sound link
 *    stopped working" over the modem's own words, the audio let go at once:
 *    Close and a new Duel tap build a new modem. Without this the route
 *    check would read the silent modem as a phone that can't hear itself,
 *    and give the wrong advice. A message the modem refused (it runs on) is
 *    only logged, as is anything from a link the lobby let go or, once the
 *    match began, from the match's: there the rig, which hears a stopped
 *    modem after the lobby has (RigLink.onStopped), takes it as a lost link,
 *    and the match's reconnect cover rebuilds the modem.
 */
import "./lobby.css";
import { sfx } from "../game/audio";
import { gameMode } from "../game/mode";
import type { ModemStats } from "../link/modem/core";
import { CAPTURE_OK_MS, RIG_ADVICE, RigError, type MicMode, type Rig, type RigErrorReason } from "../link/rig";
import type { BandPlan, BandRole, LinkTransport } from "../link/transport";
import { ROLES, UNITS } from "../sim/balance";
import { displayName, pluralName } from "../sim/lexicon";
import { inRoster } from "../sim/rules";
import { nationText, type Words } from "../ui/openers";
import { portraitKind } from "../game/three/belle/placeholders";
import { worldHash } from "../sim/checksum";
import { mapById } from "../sim/maps";
import { OPENERS, type OpenerId } from "../sim/openers";
import { MUTATORS, type MutatorId } from "../sim/rules";
import type { Faction, Nation, NationOrClassic, Role, UnitKind } from "../sim/types";
import { fullscreen } from "../ui/fullscreen";
import { VersusFeed } from "./feed";
import { LoopLink, type LoopParams } from "./loop-peer";
import { FAILED_MESSAGE, NOTHING_HEARD_MESSAGE, NOTHING_HEARD_MS, VERSION_MESSAGE, configNations, rivalOf, type DuelConfig, type HostOffer, type PairingState } from "./pairing";
import { OnlineError, browserOnlineEnv, drawKey, hostRoom, inviteUrl, joinRoom, normCode, relayBase, type OnlineInfo, type OnlineLink } from "./online";
import { DUEL_KEY, parseRematch, type RematchPlan } from "./records";
import { RelayTransport } from "./relay-transport";
import { PEER_HEARD_MS, RX_SILENT_MS, Session } from "./session";

export { openRig } from "../link/rig";

declare const __DUEL_HASH__: string | undefined;

// ------------------------------------------------------------ settings ---

/** The duel build hash's first 16 bits (SOUND-DUEL.md "Build check"); 0 where the build defines none (tests). */
export const duelBuild = (): number => (typeof __DUEL_HASH__ === "string" ? parseInt(__DUEL_HASH__.slice(0, 4), 16) || 0 : 0);

/** ?duel=loop and ?duel=relay: a practice link, no sound. */
export type PracticeMode = "loop" | "relay";

export interface DuelParams {
  /** "sound": the real thing (no ?duel, or another value). */
  mode: "sound" | PracticeMode;
  /** ?duel=relay&seat=: the role this page pairs in at once (null: Host / Join as usual). */
  seat: BandRole | null;
  /** ?duel=loop's link: &delay (3–8, rounded), &loss (0–0.9), &latency (0–2000 ms). */
  loop: LoopParams;
  /** &side=red: the side a practice page plays when it hosts (the loop's friend hosts with the other). */
  side: Faction;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The dev modes' URL parameters, clamped (SOUND-DUEL.md "Dev and test modes"). */
export function parseDuelParams(search: string): DuelParams {
  const q = new URLSearchParams(search);
  const d = q.get("duel");
  const mode = d === "loop" || d === "relay" ? d : "sound";
  const num = (k: string): number | null => {
    const v = q.get(k);
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const delay = num("delay");
  const loss = num("loss");
  const latency = num("latency");
  const seat = q.get("seat");
  return {
    mode,
    seat: mode === "relay" && (seat === "host" || seat === "guest") ? seat : null,
    loop: {
      delay: delay === null ? null : clamp(Math.round(delay), 3, 8),
      loss: loss === null ? 0 : clamp(loss, 0, 0.9),
      latencyMs: latency === null ? 250 : clamp(latency, 0, 2000)
    },
    side: q.get("side") === "red" ? "red" : "blue"
  };
}

/** What the lobby remembers between duels. */
export interface LobbyPrefs {
  /** The band plan a host transmits in. */
  plan: BandPlan;
  micMode: MicMode;
}

const PREFS_KEY = "battledrones.duelprefs";

export function parsePrefs(raw: string | null): LobbyPrefs {
  const p: LobbyPrefs = { plan: "high", micMode: "raw" };
  try {
    const o = raw ? (JSON.parse(raw) as Partial<Record<keyof LobbyPrefs, unknown>> | null) : null;
    if (o?.plan === "low") p.plan = "low";
    if (o?.micMode === "ec") p.micMode = "ec";
  } catch {
    /* corrupt: defaults */
  }
  return p;
}

function loadPrefs(): LobbyPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return parsePrefs(null);
  }
}

function savePrefs(p: LobbyPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/**
 * The rematch's storage (SOUND-DUEL.md "Rematch"): sessionStorage REMATCH_KEY
 * = REMATCH_DUEL makes the next boot a duel rematch (main.ts takes it, its
 * literals tied to these by type), and DUEL_KEY holds the rematch, written
 * by records.ts writeRematch and read here with its parseRematch.
 */
export { DUEL_KEY, REMATCH_DUEL, REMATCH_KEY, parseRematch } from "./records";

/** A rematch as the report's Rematch stored it: the same roles and band plan, the sides swapped (hostSide is already the new one). */
export type DuelRematch = RematchPlan;

/** The stored rematch (`take`: and forget it, so a reload after it is a plain boot). */
function readRematch(take: boolean): DuelRematch | null {
  try {
    const r = parseRematch(sessionStorage.getItem(DUEL_KEY));
    if (take) sessionStorage.removeItem(DUEL_KEY);
    return r;
  } catch {
    return null;
  }
}

/** What the Duel tap needs before the lobby exists. */
export interface DuelTap {
  /** The microphone mode to open the rig with: the lobby's setting, or the rematch's. */
  micMode: MicMode;
  /** A practice link: no rig, no guard. */
  practice: PracticeMode | null;
  /** An online duel (src/versus/online.ts): no rig, no guard either. */
  online: boolean;
}

/** For main.ts's Duel tap (`rematch`: the rematch's reconnect tap; `online`: the online duel's button). */
export function tapPlan(rematch = false, online = false): DuelTap {
  const p = parseDuelParams(location.search);
  const stored = rematch ? readRematch(false) : null;
  const micMode = stored?.micMode ?? loadPrefs().micMode;
  const net = rematch ? !!stored?.online : online;
  return { micMode, practice: net || p.mode === "sound" ? null : p.mode, online: net };
}

/** The room code of an invite link (`?salon=ABCD`), for main.ts's boot. */
export { codeFromSearch } from "./online";

/** Uniform in [0, 1) from the platform's CSPRNG: the pairing's nonces. */
export const cryptoRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;

// ------------------------------------------------------------ the logic ---

/** Where the lobby is. */
export type LobbyStep =
  /** The rig is opening: the microphone prompt. */
  | "opening"
  /** The link's context isn't running: "Tap to start sound". */
  | "tap-to-start"
  /** Placement, Host / Join, Advanced. */
  | "choose"
  /** The link is being made (the worklet loading). */
  | "connecting"
  /** One phone listening to itself. */
  | "self-test"
  /** Listening, or linking: the meter and the hints. */
  | "pairing"
  /** Paired: the opener cards. */
  | "picking"
  /** Picked: waiting for the friend's pick. */
  | "waiting"
  /** This phone said GO: waiting for the friend's. */
  | "go"
  /** Both said GO: waiting for steady capture before the match loads. */
  | "loading"
  /** The feed is built and the match starting: the lobby is done. */
  | "started"
  | "error"
  /** Cancelled or failed: the sheet is gone (the link may still be saying the end). */
  | "closed";

export interface LobbyError {
  /** "modem": the link's modem stopped (its words are the message). "online": the relay's room can't be had. */
  kind: "rig" | "version" | "failed" | "relay" | "left" | "modem" | "online" | "other";
  message: string;
  /** A rig error's reason. */
  reason?: RigErrorReason;
  /** A version error: which phone runs the older protocol (null: can't tell). */
  older?: "this" | "friend" | null;
}

/** The link the lobby holds: a LinkTransport, with the modem's extras where it has them (RigLink). */
export interface LobbyLink extends LinkTransport {
  setGain?(gain: number): void;
  modemStats?(): ModemStats | null;
  /** The modem's errors (RigLink: the worklet's, kept across rebuilds). */
  onError?: ((message: string) => void) | null;
  /** The modem stopped (RigLink.stopped): its error was fatal, not a refused message. */
  readonly stopped?: boolean;
}

/** What the lobby uses of the rig. */
export type LobbyRig = Pick<Rig, "state" | "ready" | "wakeLockSupported" | "captureOkMs" | "reconnect" | "setMicMode" | "close" | "rateProblem">;

/** Why the lobby let the duel's audio go without a match. */
export type LobbyEnd = "cancel" | "error" | "fallback";

export interface LobbyEnv {
  /** Monotonic milliseconds (performance.now). */
  now(): number;
  build: number;
  /** The nonce draw. */
  random(): number;
  /** The rig the tap opened; null on a practice link. */
  rig: LobbyRig | null;
  practice: PracticeMode | null;
  /** An online duel: no rig, no guard, no self-test, no role switch; its room's state (onlineInfo) shows. */
  online?: boolean;
  onlineInfo?: () => OnlineInfo | null;
  /** A link in these bands; `offer` is the host's, whoever hosts (the loop's friend may). Rejects with a RigError, or an Error named "RelayError". */
  link(cfg: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" }, offer: HostOffer): Promise<LobbyLink>;
  /** The game audio's band guard (null: off), at its full cut whatever the microphone mode (audio.ts GUARD_CUT_DB). Practice links have none. */
  guard(plan: BandPlan | null): void;
  /** The menu's shownMap() and activeMutators() at the tap, the side the host plays, and the menu's nation (default Classique). */
  offer: { map: string; mutators: MutatorId[]; hostSide: Faction; nation?: NationOrClassic };
  /** Pair at once: a rematch (its role, plan, and the host's map, mutators and side), or a relay seat. */
  rematch: DuelRematch | null;
  seat: BandRole | null;
  prefs: LobbyPrefs;
  savePrefs(p: LobbyPrefs): void;
  /** The match is agreed and capture is steady: build the feed and start it (throws: the lobby shows the error). */
  begin(session: Session, link: LobbyLink): void;
  /** The audio is let go with no match (the session closed, the rig closed, the guard off). */
  released(why: LobbyEnd): void;
}

/** The link meter, both ways. */
export interface LobbyMeter {
  /** This phone's receive SNR of the friend (dB), good and bad packets, and its quality 0–7. */
  snrDb: number | null;
  good: number;
  bad: number;
  rxq: number;
  /** The friend's receive quality of this phone (0–7), from its newest frame. */
  peerRxq: number | null;
  rttMs: number | null;
}

export interface LobbyView {
  step: LobbyStep;
  role: BandRole | null;
  practice: PracticeMode | null;
  /** An online duel, and its room (null before there is one). */
  isOnline: boolean;
  online: OnlineInfo | null;
  rematch: boolean;
  /** Pairing in a role it can't switch (a rematch, a relay seat). */
  fixedRole: boolean;
  prefs: LobbyPrefs;
  /**
   * The nation this phone plays (LOBBY_PROTO 2): what it offers when it hosts, what it asks for when it joins.
   * Classique: hosting, a Classique match; joining, the host's rival nation (or Classique under a Classique host).
   */
  nation: NationOrClassic;
  error: LobbyError | null;
  /** The rig lost its audio: "Tap to reconnect the sound link". */
  lost: boolean;
  /** The screen can't be kept on: set Auto-Lock to Never. */
  noWakeLock: boolean;
  /** Nothing heard for 8 s: one phone Host, the other Join (with the switch). */
  switchRole: boolean;
  /** Nothing heard for 30 s. */
  tips: boolean;
  /** The friend was heard, and nothing since for QUIET_MS (pairing to GO). */
  quiet: boolean;
  /** The route check failed. */
  route: boolean;
  /** The transmit gain was lowered (loud own signal). */
  loud: boolean;
  meter: LobbyMeter | null;
  pairing: PairingState | null;
  /** Back to Host / Join is still possible (before GO). */
  canBack: boolean;
}

/** The route check (SOUND-DUEL.md "The lobby"): own signal under this … */
export const ROUTE_SNR_DB = 10;
/** … for this long. */
export const ROUTE_MS = 3000;
/** No own-signal reading counts only from this long after the link started: the self-monitor's first sync. */
export const ROUTE_GRACE_MS = 2050;
/** Loud own signal: a stats report whose microphone peak is above −6 dBFS … */
export const LOUD_PEAK = 10 ** (-6 / 20);
/**
 * … while the self-monitor hears this phone's own signal at all (the route
 * check's threshold: an own signal clipping the microphone reads 11–24 dB at
 * 3–6× full scale, see the header) …
 */
export const LOUD_OWN_SNR_DB = ROUTE_SNR_DB;
/** … in every report for this long (a clap, a knock or a word has gone by then) … */
export const LOUD_MS = 2000;
/** … drops the gain by 3 dB, at most once per GAIN_STEP_MS, down to GAIN_MIN (−6 dB: the friend still hears this phone within 6 dB of its usual). */
export const GAIN_STEP = 10 ** (-3 / 20);
export const GAIN_STEP_MS = 1000;
export const GAIN_MIN = 0.5;
/** The gain the lobby chooses (the modem's default; the modem is offered up to 1.1) … */
export const GAIN_START = 1;
/** … and climbs back to, by 1 dB at most once per GAIN_RISE_MS, once no loud report has come for GAIN_QUIET_MS. */
export const GAIN_RISE = 10 ** (1 / 20);
export const GAIN_RISE_MS = 2000;
export const GAIN_QUIET_MS = 5000;
/** Nothing heard this long after the role was tapped: tips. */
export const TIPS_MS = 30_000;
/** A rematch with nothing heard this long falls back to the menu. */
export const REMATCH_FALLBACK_MS = 60_000;
/** A friend heard and then silent this long: "Your friend's phone has gone quiet". */
export const QUIET_MS = NOTHING_HEARD_MS;

const otherRole = (r: BandRole): BandRole => (r === "host" ? "guest" : "host");

/** The link's modem stopped, or never started: an error after which it no longer reports. */
class ModemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModemError";
  }
}

/** The lobby's logic, DOM-free: call update() every frame, read state(), and send it the taps. */
export class LobbyMachine {
  private step: LobbyStep;
  private role: BandRole | null = null;
  private selfTest = false;
  private session: Session | null = null;
  private link: LobbyLink | null = null;
  /** Bumped by every role start and every close: a link that resolves for an older one is let go. */
  private gen = 0;
  private fatal: LobbyError | null = null;
  private released = false;
  /** Sessions saying the end (left) until they may close. */
  private ending: Session[] = [];
  /** Cancelled or failed: the audio goes once nothing is left to say. */
  private closing: LobbyEnd | null = null;
  private sessionAt = 0;
  private linkAt = 0;
  private guardPlan: BandPlan | null;
  private routeSince: number | null = null;
  private route = false;
  private gain = GAIN_START;
  /** When the gain last changed, the unbroken run of loud reports started (null: none now), and the last loud report came. */
  private gainAt = -Infinity;
  private loudSince: number | null = null;
  private loudAt = -Infinity;
  private peakSample = -1;
  /** The nation this phone plays (a rematch: the one it played). */
  private nation: NationOrClassic;

  constructor(private readonly env: LobbyEnv) {
    this.nation = env.rematch ? env.rematch.nation ?? "classique" : env.offer.nation ?? "classique";
    // (the tap turned the guard on in the high plan: practice links and online duels have none)
    this.guardPlan = env.practice || env.online ? null : "high";
    const rig = env.rig;
    if (!rig) {
      this.step = "choose";
      this.ready();
      return;
    }
    this.step = "opening";
    rig.ready.then(
      (r) => {
        if (this.step !== "opening") return;
        if (r === "running" || rig.state === "running") this.ready();
        else this.step = "tap-to-start";
      },
      (e: unknown) => this.fail(e)
    );
  }

  /** The lobby is finished with: the match started, or the audio let go. */
  get done(): boolean {
    return this.step === "started" || this.released;
  }

  // --------------------------------------------------------------- taps ---

  host(): void {
    if (this.step === "choose") void this.begin("host", false);
  }

  join(): void {
    if (this.step === "choose") void this.begin("guest", false);
  }

  startSelfTest(): void {
    if (this.step === "choose" && !this.env.practice && !this.env.online) void this.begin("host", true);
  }

  /** The 8 s hint's one-tap switch: the other role, at once. */
  switchRole(): void {
    if (this.step !== "pairing" || !this.role || this.state().fixedRole) return;
    const next = otherRole(this.role);
    this.dropSession();
    void this.begin(next, false);
  }

  /** Back to Host / Join (before GO). */
  back(): void {
    if (!this.state().canBack) return;
    this.dropSession();
    this.role = null;
    this.selfTest = false;
    this.step = "choose";
  }

  /** "Pairing failed: tap to retry". The tips' and a rematch's clocks start again, as the pairing's hint does. */
  retry(): void {
    if (!this.session) return;
    this.session.retry();
    this.sessionAt = this.env.now();
  }

  pick(id: OpenerId): boolean {
    return this.session?.pick(id) ?? false;
  }

  /** "Tap to start sound", and "Tap to reconnect the sound link": inside the tap. */
  tapToStart(): void {
    void this.env.rig?.reconnect();
  }

  /** The nation picked on the Host / Join step (not in a rematch, which keeps its own). */
  setNation(n: NationOrClassic): void {
    if (this.step === "choose" && !this.env.rematch) this.nation = n;
  }

  setPlan(plan: BandPlan): void {
    this.env.prefs.plan = plan;
    this.env.savePrefs(this.env.prefs);
  }

  setMicMode(mode: MicMode): void {
    if (mode === this.env.prefs.micMode) return;
    this.env.prefs.micMode = mode;
    this.env.savePrefs(this.env.prefs);
    // (the rig asks for the old mode again if the new request fails)
    this.env.rig?.setMicMode(mode).catch((e: unknown) => console.warn("microphone mode:", e));
  }

  /** Cancel, or Close on an error: say the end to a friend that may have started, then let the audio go. */
  cancel(): void {
    if (this.step === "started" || this.step === "closed") return;
    this.close("cancel");
  }

  // ------------------------------------------------------------ driving ---

  /** Every frame (and from a fallback timer): the rig, the session, the meter, the checks. */
  update(): void {
    if (this.released || this.step === "started") return;
    const now = this.env.now();
    // (the end on the air until the friend can have it)
    this.ending = this.ending.filter((s) => {
      s.pump();
      if (!s.status().closable) return true;
      s.close();
      return false;
    });
    if (this.closing) {
      if (!this.ending.length) this.release(this.closing);
      return;
    }
    if (this.step === "closed" || this.fatal) return;
    const rig = this.env.rig;
    if (rig && this.step === "tap-to-start" && rig.state === "running") this.ready();
    const s = this.session;
    if (!s) return;
    s.pump();
    const st = s.status();
    const link = this.link!;
    this.watchLink(link, now);
    if (this.selfTest) return;
    if (st.phase === "pairing") {
      const p = st.pairing;
      this.step = p.phase === "picking" ? "picking" : p.phase === "waiting" ? "waiting" : p.phase === "go" ? "go" : "pairing";
      if (this.env.rematch && !p.heard && now - this.sessionAt >= REMATCH_FALLBACK_MS) this.close("fallback");
    } else if (st.phase === "starting") {
      this.step = "loading";
      if (st.peerEnded) return;
      if (rig && rig.captureOkMs() < CAPTURE_OK_MS) return;
      this.step = "started";
      try {
        this.env.begin(s, link);
      } catch (e) {
        console.error(e);
        this.step = "error";
        this.fatal = { kind: "other", message: e instanceof Error ? e.message : String(e) };
        this.close("error");
      }
    }
  }

  state(): LobbyView {
    const env = this.env;
    const now = env.now();
    const st = this.session && !this.released ? this.session.status() : null;
    const p = st?.pairing ?? null;
    const fixedRole = env.rematch !== null || env.seat !== null;
    const live = st !== null && this.step !== "closed";
    const link = st?.link;
    const error = this.fatal ?? (live ? this.pairingError(st.pairing, st.peerEnded) : null);
    const before = this.step === "pairing" || this.step === "picking" || this.step === "waiting";
    // (the friend's numbers only while they are current: its frames, and packets at all)
    const peerFresh = st !== null && (st.pairing.sinceHeardMs <= PEER_HEARD_MS || (st.phase === "starting" && st.link.sinceRx <= PEER_HEARD_MS));
    return {
      step: error && this.step !== "closed" ? "error" : this.step,
      role: this.role,
      practice: env.practice,
      isOnline: !!env.online,
      online: env.onlineInfo?.() ?? null,
      rematch: env.rematch !== null,
      fixedRole,
      prefs: { ...env.prefs },
      nation: this.nation,
      error,
      lost: env.rig?.state === "lost",
      noWakeLock: env.rig !== null && !env.rig.wakeLockSupported,
      switchRole: live && !this.selfTest && !fixedRole && !env.online && !!p?.hint && !p.heard,
      tips: live && !this.selfTest && p !== null && !p.heard && now - this.sessionAt >= TIPS_MS,
      quiet: live && !this.selfTest && !error && (before || this.step === "go") && p !== null && p.heard && p.sinceHeardMs >= QUIET_MS,
      route: this.route,
      // (the route warning says the phone can't hear itself: a note that it hears itself loudly would contradict it)
      loud: this.gain < GAIN_START && !this.route,
      meter: link
        ? {
            snrDb: link.sinceRx <= RX_SILENT_MS ? link.snrDb : null,
            good: link.rxOk,
            bad: link.rxBad,
            rxq: st.rxq,
            peerRxq: this.selfTest || !peerFresh ? null : st.peerRxq,
            rttMs: st.rttMs
          }
        : null,
      pairing: p,
      canBack: !fixedRole && !error && (this.step === "self-test" || (before && p !== null && !p.go))
    };
  }

  // ------------------------------------------------------------- inside ---

  private pairingError(p: PairingState, peerEnded: "left" | "desync" | null): LobbyError | null {
    if (p.error?.kind === "version") {
      const older = p.error.older;
      return { kind: "version", message: VERSION_MESSAGE, older };
    }
    if (p.phase === "failed") return { kind: "failed", message: p.error?.message ?? FAILED_MESSAGE };
    // (from this phone's GO on: the friend may have started on it, and the session says it has gone)
    if (peerEnded && (p.go || this.step === "loading")) return { kind: "left", message: "Ton ami est parti" };
    return null;
  }

  /** The rig is in and running: pair at once (a rematch, a relay seat), or offer Host / Join. */
  private ready(): void {
    this.step = "choose";
    const role = this.env.rematch?.role ?? this.env.seat;
    if (role) void this.begin(role, false);
  }

  /** The host's offer, whoever hosts. */
  private offer(): HostOffer {
    const r = this.env.rematch;
    if (r) return { map: r.mapId, mutators: r.mutators, hostSide: r.hostSide, nation: this.nation };
    return { map: this.env.offer.map, mutators: this.env.offer.mutators, hostSide: this.env.offer.hostSide, nation: this.nation };
  }

  private async begin(role: BandRole, selfTest: boolean): Promise<void> {
    const env = this.env;
    const gen = ++this.gen;
    this.role = role;
    this.selfTest = selfTest;
    this.step = "connecting";
    this.route = false;
    this.routeSince = null;
    const stored = env.rematch?.plan;
    let cfg: { plan: BandPlan; tx: BandRole; rx: BandRole | "detect" };
    if (selfTest) cfg = { plan: env.prefs.plan, tx: "host", rx: "host" };
    else if (role === "host") cfg = { plan: stored ?? env.prefs.plan, tx: "host", rx: "guest" };
    else if (stored) cfg = { plan: stored, tx: "guest", rx: "host" };
    // (a Join detects the host's plan; it transmits in the high plan's guest band where the rate allows)
    else cfg = { plan: env.rig?.rateProblem("high") ? "low" : "high", tx: "guest", rx: "detect" };
    let link: LobbyLink;
    try {
      link = await env.link(cfg, this.offer());
    } catch (e) {
      if (gen === this.gen) this.fail(e);
      return;
    }
    if (gen !== this.gen || this.released || this.step !== "connecting") {
      link.close();
      return;
    }
    const now = env.now();
    this.link = link;
    link.onError = (message) => this.linkError(link, message);
    this.linkAt = now;
    this.sessionAt = now;
    this.gain = GAIN_START;
    this.gainAt = -Infinity;
    this.loudSince = null;
    this.loudAt = -Infinity;
    this.peakSample = -1;
    this.session = new Session({ transport: link, role, build: env.build, random: env.random, ...(role === "host" ? { host: this.offer() } : { nation: this.nation }) });
    this.step = selfTest ? "self-test" : "pairing";
    // (a Join that detects keeps the guard it has until its link locks on a plan)
    this.setGuard(cfg.rx === "detect" ? this.guardPlan ?? cfg.plan : cfg.plan, true);
  }

  /** The route check, the loud-signal gain, and a Join's guard following the plan its link found. */
  private watchLink(link: LobbyLink, now: number): void {
    const stats = link.stats();
    if (this.role === "guest" && stats.locked && !this.selfTest) this.setGuard(stats.plan);
    if (!this.env.rig) return;
    const own = stats.ownSnrDb;
    const bad = own === null ? now - this.linkAt >= ROUTE_GRACE_MS : own < ROUTE_SNR_DB;
    if (bad) this.routeSince ??= now;
    else this.routeSince = null;
    this.route = this.routeSince !== null && now - this.routeSince >= ROUTE_MS;
    // the loud own signal, once per stats report (the worklet's, every 250 ms; none while they're stale)
    const ms = link.modemStats?.();
    if (!ms || ms.sample === this.peakSample) return;
    this.peakSample = ms.sample;
    if (ms.inputPeak > LOUD_PEAK && own !== null && own >= LOUD_OWN_SNR_DB) {
      this.loudSince ??= now;
      this.loudAt = now;
    } else this.loudSince = null;
    let gain = this.gain;
    if (this.loudSince !== null && now - this.loudSince >= LOUD_MS) {
      if (now - this.gainAt >= GAIN_STEP_MS) gain = Math.max(GAIN_MIN, gain * GAIN_STEP);
    } else if (gain < GAIN_START && now - this.loudAt >= GAIN_QUIET_MS && now - this.gainAt >= GAIN_RISE_MS) {
      gain = Math.min(GAIN_START, gain * GAIN_RISE);
    }
    if (gain === this.gain) return;
    this.gain = gain;
    this.gainAt = now;
    link.setGain?.(gain);
  }

  /** The guard on `plan` (`force`: even if it should be on it already). */
  private setGuard(plan: BandPlan, force = false): void {
    if (this.env.practice || this.env.online || (plan === this.guardPlan && !force)) return;
    this.guardPlan = plan;
    this.env.guard(plan);
  }

  /**
   * The modem's error (see the header). A link that says whether its modem
   * stopped (RigLink.stopped, set before onError) is taken at its word: a
   * refused message that came before the first stats report, or while they
   * were stale, isn't fatal. One that doesn't say falls back to its stats,
   * which WorkletTransport makes stale at once for a modem that stopped.
   */
  private linkError(link: LobbyLink, message: string): void {
    const ours = link === this.link && !this.released && this.step !== "started";
    const dead = link.stopped ?? !link.modemStats?.();
    if (ours && dead) this.fail(new ModemError(message));
    else console.warn("sound link:", message);
  }

  private fail(e: unknown): void {
    if (this.released) return;
    console.warn("sound duel:", e);
    if (e instanceof RigError) this.fatal = { kind: "rig", reason: e.reason, message: e.message };
    else if (e instanceof Error && e.name === "RelayError") this.fatal = { kind: "relay", message: e.message };
    else if (e instanceof Error && e.name === "OnlineError") this.fatal = { kind: "online", message: e.message };
    else if (e instanceof ModemError) this.fatal = { kind: "modem", message: e.message };
    else this.fatal = { kind: "other", message: e instanceof Error ? e.message : String(e) };
    this.step = "error";
    this.dropSession();
    this.release("error");
  }

  /**
   * Let this role's session and link go (Back, a role switch, Cancel, an
   * error). Before GO there is nothing to tell and it closes at once; from GO
   * on it says the end (a stand-in, or the match's frames) until it may close.
   */
  private dropSession(): void {
    this.gen++;
    const s = this.session;
    const link = this.link;
    this.session = null;
    this.link = null;
    if (!s) return void link?.close();
    s.leave("left");
    if (s.status().closable) s.close();
    else this.ending.push(s);
  }

  private close(why: LobbyEnd): void {
    if (this.step !== "error") this.step = "closed";
    this.closing = why;
    this.dropSession();
    if (!this.ending.length) this.release(why);
  }

  private release(why: LobbyEnd): void {
    if (this.released) return;
    this.released = true;
    for (const s of this.ending) s.close();
    this.ending = [];
    this.session?.close();
    this.link?.close();
    this.env.rig?.close();
    if (this.guardPlan) this.env.guard(null);
    this.guardPlan = null;
    this.env.released(why);
  }
}

// ------------------------------------------------------------ the sheet ---

export interface LobbyOptions {
  /** Where the sheet goes (the menu). */
  host: HTMLElement;
  /** The rig the Duel tap opened; null on a practice link. */
  rig: Rig | null;
  /** The menu's shownMap() and activeMutators() at the tap: what a host offers. */
  shownMap: string;
  mutators: MutatorId[];
  /** main.ts: begin(false, () => duelSetup(feed.config), feed). */
  start: (feed: VersusFeed) => void;
  /** The duel's audio was let go with no match (Cancel, an error, the rematch's fallback): the menu's music comes back. */
  onClose: (why: LobbyEnd) => void;
  /** An online duel (src/versus/online.ts), and the room code an invite link brought (null: none). A rematch's is its own. */
  online?: { code: string | null } | null;
}

/**
 * Until the match takes the rig over (VersusFeed has its own pagehide) or the
 * lobby lets it go: the page going away, not into the back-forward cache,
 * closes the rig, putting iOS's audio session back to "auto" (the
 * microphone and the context would go with the page anyway; the session
 * type would not). Returns the listener's removal.
 */
export function closeRigOnPageGone(win: Pick<Window, "addEventListener" | "removeEventListener">, rig: Pick<Rig, "close">): () => void {
  const gone = (e: Event) => {
    if (!(e as PageTransitionEvent).persisted) rig.close();
  };
  win.addEventListener("pagehide", gone);
  return () => win.removeEventListener("pagehide", gone);
}

/** The lobby, after the Duel tap. */
export function showLobby(o: LobbyOptions): void {
  run(o, null);
}

/** The rematch's "Tap to reconnect": the lobby, pairing at once with the stored role and plan. */
export function reconnect(o: LobbyOptions): void {
  run(o, readRematch(true));
}

/** The relay smoke's window into the duel (practice links only). */
export interface DuelProbe {
  readonly state: string;
  readonly tick: number;
  /** The input delay D the pairing agreed (null before the match). */
  readonly delay: number | null;
  trail(): number | null;
  /** The hash trail after every tick stepped from `from` on: [tick, trail] (VersusFeed.trails). */
  trails(from: number): [number, number][];
  hash(): string | null;
  /** An online duel's room (null: none, or not online). */
  online(): OnlineInfo | null;
  readonly result: { end: string; winner: Faction | "draw" | null; resigned: Faction | null; tick: number | null; endCheck: string; desync: boolean } | null;
}

declare global {
  interface Window {
    __duel?: DuelProbe;
    __duelOut?: (base64: string, nbits: number) => void;
    __duelIn?: (base64: string, nbits: number) => void;
  }
}

class RelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayError";
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/**
 * The 30 s tips: the sound's, with band Low (Advanced) only where Advanced
 * is offered (not in a rematch, which keeps its band); a practice link has
 * no sound to turn up, only the other page (the relay) or the page itself.
 */
export function tipsText(v: Pick<LobbyView, "practice" | "rematch"> & Partial<Pick<LobbyView, "online">>): string {
  if (v.online)
    return v.online.role === "host"
      ? `Toujours personne ? Vérifie que ton ami a saisi le code ${v.online.code} (ou ouvert ton lien), et qu'il est en ligne.`
      : "Toujours rien ? Ton ami a peut-être fermé son salon : demande-lui le code affiché sur son écran.";
  if (v.practice === "loop") return "Toujours rien ? Recharge la page et touche Duel à nouveau.";
  if (v.practice === "relay") return "Toujours rien ? Vérifie que l'autre page est dans le salon et que le relais relie les deux.";
  const sound = "Toujours rien ? Monte le volume et coupe le mode silencieux. Débranche les écouteurs et coupe le Bluetooth. Garde les téléphones à 10–30 cm.";
  return v.rematch ? sound : `${sound} Ou essaie la bande Basse sur l'hôte (Avancé).`;
}
/**
 * The route warning. Band Low is advice only where it can be taken: not in a
 * rematch (it keeps its band, and has no Advanced), and not where this phone
 * hosts on band Low already.
 */
export function routeText(v: Pick<LobbyView, "rematch" | "role" | "prefs">): string {
  const head = "Ce téléphone n'entend pas son propre signal : le son part peut-être vers l'écouteur ou le Bluetooth, ou il ne peut pas jouer cette bande.";
  return v.rematch || (v.role === "host" && v.prefs.plan === "low")
    ? `${head} Débranche les écouteurs ou monte le volume.`
    : `${head} Débranche les écouteurs, monte le volume, ou passe l'hôte en bande Basse.`;
}
const QUIET_TEXT = "Le téléphone de ton ami s'est tu. Rapproche les téléphones, ou touche Annuler si ton ami est parti.";
const QUIET_ONLINE = "Ton ami ne répond plus. Attends-le un instant, ou touche Annuler s'il est parti.";
/** Under the online sheet's title. */
const ONLINE_NOTE = "Par Internet, où que soit ton ami : l'un crée un salon, l'autre entre son code (ou ouvre le lien partagé).";
const PLACEMENT =
  "Pose les deux téléphones à plat, à 10–30 cm. Volume à environ 75 %, mode silencieux coupé. Sur iPhone, le son peut sortir de l'écouteur en haut : tourne les téléphones jusqu'à ce que les deux barres ci-dessous soient pleines.";

/** Above every step of a sound link (not a practice link, which plays none), before any of it is heard. */
const NOISE_WARNING =
  "⚠️ <b>Attention : bruit désagréable.</b> La liaison sonore émet un sifflement aigu continu pendant toute la partie. Beaucoup le trouvent désagréable, et il peut même donner mal à la tête. Arrête si ça te gêne.";

const iconUrl = (kind: string, side: Faction): string => `assets/icons/${side === "red" ? "red/" : ""}${kind}.webp`;

/** The map as the paired view names it: a built-in map's name, a generated one's name and code. */
function mapLine(mapId: string, mutators: readonly MutatorId[]): string {
  const def = mapById(mapId);
  const name = def.random ? `${esc(def.name)} <span class="duel-code">#${esc(def.random.code)}</span>` : esc(def.name);
  const muts = mutators.length
    ? mutators.map((id) => `<span class="duel-mut" title="${esc(MUTATORS[id].desc)}">${MUTATORS[id].icon} ${esc(MUTATORS[id].name)}</span>`).join("")
    : `<span class="duel-mut none">Aucun mutateur</span>`;
  return `<p class="duel-map"><b>🗺 ${name}</b></p><p class="duel-muts">${muts}</p>`;
}

/** The nations as the lobby names them, with a one-line identity (PANACHE-CONCEPTION.md §1.1). */
const NATION_LABEL: Record<NationOrClassic, { name: string; line: string }> = {
  classique: { name: "Classique", line: "Mêmes unités" },
  republique: { name: "République", line: "Rapide, aérienne, électrique" },
  empire: { name: "Empire", line: "Vapeur, acier, artillerie" }
};

/** A nation's crest (public/assets/ui/crest-*.webp); Classique has a scale instead. */
export function crestHtml(n: NationOrClassic, cls = "duel-crest"): string {
  return n === "classique"
    ? `<span class="${cls} classique" aria-hidden="true">⚖</span>`
    : `<img class="${cls}" src="assets/ui/crest-${n}.webp" alt="" draggable="false"/>`;
}

/**
 * The Host / Join step's nation picker (LOBBY_PROTO 2): what this phone offers
 * when it hosts, what it asks for when it joins. Not in a rematch, which keeps
 * the nations it played.
 */
export function nationPicker(v: Pick<LobbyView, "nation" | "rematch" | "isOnline">): string {
  if (v.rematch) return "";
  const btn = (n: NationOrClassic) =>
    `<button class="duel-nat nat-${n}${v.nation === n ? " on" : ""}" data-act="nation" data-v="${n}" aria-pressed="${v.nation === n}">${crestHtml(n)}<b>${NATION_LABEL[n].name}</b><small>${NATION_LABEL[n].line}</small></button>`;
  return `<div class="duel-nation">
      <p class="duel-lbl">Ta nation</p>
      <div class="duel-nats">${btn("republique")}${btn("empire")}${btn("classique")}</div>
      <p class="duel-natnote">L'hôte décide : en Classique, les deux camps jouent Classique. Sinon chacun joue sa nation${v.nation === "classique" ? " (toi, celle qui affronte l'hôte)" : ""}.</p>
    </div>`;
}

/** Before pairing: the nation this phone brings (a host's offer, a guest's ask). */
export function myNationLine(v: Pick<LobbyView, "nation" | "role">): string {
  const n = v.nation;
  const what =
    v.role === "host"
      ? n === "classique" ? "Partie Classique : les mêmes unités des deux côtés" : `Tu joues la <b>${NATION_LABEL[n].name}</b> · ton ami choisit la sienne`
      : n === "classique" ? "Tu joueras la nation qui affronte celle de l'hôte" : `Tu demandes la <b>${NATION_LABEL[n].name}</b> (si l'hôte joue une nation)`;
  return `<p class="duel-nations">${crestHtml(n)}<span>${what}</span></p>`;
}

/** The paired view's nations line: this phone's and the friend's, under the config agreed (null: Classique). */
export function nationsLine(config: DuelConfig | null, side: Faction | null): string {
  const n = config ? configNations(config) : undefined;
  if (!config || !side) return "";
  if (!n) return `<p class="duel-nations">${crestHtml("classique")}<span>Classique : les mêmes unités des deux côtés</span></p>`;
  const mine = n[side]!;
  const theirs = n[side === "blue" ? "red" : "blue"]!;
  return `<p class="duel-nations"><span class="dn-side">${crestHtml(mine)}<span>Toi : <b>${NATION_LABEL[mine].name}</b></span></span><span class="dn-vs">contre</span><span class="dn-side">${crestHtml(theirs)}<span>Ton ami : <b>${NATION_LABEL[theirs].name}</b></span></span></p>`;
}

/**
 * What an opener gives, as the single-player picker's pills say it
 * (src/ui/openers.ts), from the same data (OPENERS, and the building and unit
 * names): "Fab Plant · 3 Stingers · 2 Harvesters · −100 scrap".
 */
export function openerGives(id: OpenerId, words: Words = CLASSIC): string {
  const o = OPENERS[id];
  const n = words.nation;
  const parts = [displayName(o.building, n)];
  const counts = new Map<UnitKind, number>();
  for (const k of o.units) counts.set(words.kindFor(k), (counts.get(words.kindFor(k)) ?? 0) + 1);
  for (const [k, c] of counts) parts.push(`${c} ${c > 1 ? pluralName(k, n) : UNITS[k].name}`);
  const worker = words.kindFor("harvester");
  parts.push(`${o.harvesters} ${o.harvesters > 1 ? pluralName(worker, n) : UNITS[worker].name}`);
  if (o.scrap > 0) parts.push(`+${o.scrap} charbon`);
  if (o.scrap < 0) parts.push(`−${-o.scrap} charbon`);
  return parts.join(" · ");
}

const CLASSIC: Words = { nation: "classique", kindFor: (k) => k };
const CLASSIC_ROLE = new Map<UnitKind, Role>();
for (const [role, kind] of Object.entries(ROLES.classique) as [Role, UnitKind][]) if (!CLASSIC_ROLE.has(kind)) CLASSIC_ROLE.set(kind, role);

/**
 * How the opener cards name things for a side's nation (sim/nations.ts
 * nationKind, without a world: the kind itself in Classique or when the
 * nation fields it, else the nation's kind for its role), and the friend's
 * workers in "leurs Fardiers".
 */
export function lobbyWords(mine: NationOrClassic, theirs: NationOrClassic = mine): Words {
  const kindFor = (n: NationOrClassic) => (k: UnitKind): UnitKind => {
    if (n === "classique" || inRoster(n, k)) return k;
    const role = CLASSIC_ROLE.get(k);
    return role ? ROLES[n][role] : k;
  };
  return {
    nation: mine,
    kindFor: kindFor(mine),
    ...(theirs !== mine ? { enemyWorker: { nation: theirs, kind: kindFor(theirs)("harvester") } } : {})
  };
}

function openerCard(id: OpenerId, side: Faction, picked: boolean, words: Words = CLASSIC): string {
  const o = OPENERS[id];
  const unit = words.kindFor(o.units[0] ?? "harvester");
  const n = o.units.length || o.harvesters;
  return `<button class="op-card op-${id}${picked ? " picked" : ""}" data-act="pick" data-id="${id}">
      <div class="op-art"><img class="op-b" src="${iconUrl(o.building, side)}" alt="" draggable="false"/><img class="op-u" src="${iconUrl(portraitKind(unit), side)}" alt="" draggable="false"/><span class="op-n">×${n}</span></div>
      <div class="op-text"><b class="op-name">${esc(o.name)}</b><span class="op-tag">${esc(nationText(o.tagline, id, words))}</span><span class="op-gives">${openerGives(id, words)
        .split(" · ")
        .map((part) => `<span>${esc(part)}</span>`)
        .join(" · ")}</span></div>
    </button>`;
}

const bar = (q: number | null): string => {
  const cls = q === null ? "" : q >= 5 ? "good" : q >= 2 ? "fair" : "poor";
  return `<span class="dm-bar ${cls}"><i style="width:${q === null ? 0 : Math.round((q / 7) * 100)}%"></i></span>`;
};

function meterHtml(v: LobbyView): string {
  const m = v.meter;
  if (!m) return "";
  if (v.step === "self-test")
    return `<div class="duel-meter"><div class="dm-row"><span class="dm-l">Ce téléphone s'entend</span>${bar(m.rxq)}<span class="dm-v" data-m="rx"></span></div></div>`;
  return `<div class="duel-meter">
      <div class="dm-row"><span class="dm-l">Tu entends ton ami</span>${bar(m.rxq)}<span class="dm-v" data-m="rx"></span></div>
      <div class="dm-row"><span class="dm-l">Ton ami t'entend</span>${bar(m.peerRxq)}<span class="dm-v" data-m="tx"></span></div>
      <p class="dm-rtt" data-m="rtt"></p>
    </div>`;
}

/**
 * The meter's last line: the round trip, except on the loop, whose friend
 * holds the lobby's packets to force &delay (loop-peer.ts), so its round trip
 * can read seconds and says nothing of the match: it names the input delay
 * the pairing agreed instead.
 */
export function rttLine(v: Pick<LobbyView, "practice" | "pairing" | "meter">): string {
  if (v.practice === "loop") {
    const d = v.pairing?.config?.delay;
    return d === undefined ? "Liaison d'entraînement" : `Liaison d'entraînement · délai d'entrée ${d * 100} ms`;
  }
  const rtt = v.meter?.rttMs ?? null;
  return rtt === null ? "Aller-retour : mesure…" : `Aller-retour ${Math.round(rtt)} ms`;
}

/** The online duel's line in place of the sound meter: the relay, the friend in the room, the round trip. */
function onlineHtml(v: LobbyView): string {
  return v.isOnline ? `<p class="duel-net" data-m="net"></p>` : "";
}

/** That line's words. */
export function onlineLine(v: Pick<LobbyView, "online" | "meter" | "practice" | "pairing">): string {
  const o = v.online;
  if (!o) return "🌐 Connexion au relais…";
  if (o.state === "closed") return "🌐 Hors ligne";
  if (o.state !== "open") return "🌐 Relais : reconnexion…";
  const friend = o.peer ? "ton ami est là" : o.peerGoneMs !== null ? "ton ami s'est déconnecté" : "ton ami n'est pas encore là";
  const rtt = v.meter?.rttMs ?? null;
  return `🌐 Salon ${o.code} · ${friend}${o.peer && rtt !== null ? ` · aller-retour ${Math.round(rtt)} ms` : ""}`;
}

/** The meter's numbers and bars, every frame. */
function fillMeter(root: HTMLElement, v: LobbyView): void {
  const net = root.querySelector<HTMLElement>(`[data-m="net"]`);
  if (net) {
    const t = onlineLine(v);
    if (net.textContent !== t) net.textContent = t;
  }
  const m = v.meter;
  if (!m) return;
  const set = (k: string, text: string) => {
    const el = root.querySelector<HTMLElement>(`[data-m="${k}"]`);
    if (el && el.textContent !== text) el.textContent = text;
  };
  set("rx", `${m.snrDb === null ? "–" : `${Math.round(m.snrDb)} dB`} · ${m.good} bons`);
  set("tx", m.peerRxq === null ? "–" : `${m.peerRxq * 3}+ dB`);
  set("rtt", rttLine(v));
  const bars = root.querySelectorAll<HTMLElement>(".dm-bar");
  const qs = v.step === "self-test" ? [m.rxq] : [m.rxq, m.peerRxq];
  bars.forEach((b, i) => {
    const q = qs[i] ?? null;
    const w = `${q === null ? 0 : Math.round((q / 7) * 100)}%`;
    const fill = b.querySelector<HTMLElement>("i");
    if (fill && fill.style.width !== w) fill.style.width = w;
    b.classList.toggle("good", q !== null && q >= 5);
    b.classList.toggle("fair", q !== null && q >= 2 && q < 5);
    b.classList.toggle("poor", q !== null && q < 2);
  });
}

/** What the sheet shows for a state: rebuilt only when this changes. */
function layoutKey(v: LobbyView): string {
  const p = v.pairing;
  return [
    v.step, v.role, v.error?.kind, v.lost, v.switchRole, v.tips, v.quiet, v.route, v.loud, v.canBack, v.prefs.plan, v.prefs.micMode,
    p?.phase, p?.pick, p?.picked, p?.offered.join(","), p?.config?.mapId, p?.side, v.online?.code, v.online?.peer, v.online?.state === "open",
    v.nation, p?.config?.nations?.host, p?.config?.nations?.guest
  ].join("|");
}

/** What the online sheet adds: the code an invite link brought, and a bad code typed. */
export interface OnlineSheet {
  linked: string | null;
  badCode: boolean;
  /** What the code box held when the sheet was last rebuilt (a nation tap rebuilds it): kept, not retyped. */
  typed?: string;
}

/** The online duel's steps where they differ from the sound's: choosing, connecting, waiting in the room. */
function onlineBody(v: LobbyView, sheet: OnlineSheet): { body: string; actions: string } | null {
  const cancel = `<button class="cta alt" data-act="cancel">Annuler</button>`;
  const back = v.canBack ? `<button class="cta alt" data-act="back">Retour</button>` : "";
  const o = v.online;
  switch (v.step) {
    case "choose": {
      const linked = sheet.linked;
      const bad = sheet.badCode ? `<p class="duel-err">Un code, ce sont 4 lettres.</p>` : "";
      const join = `<div class="duel-join">
          <p class="duel-lbl">${linked ? "Ton ami t'invite" : "Rejoindre avec un code"}</p>
          <div class="duel-joinrow"><input class="duel-codein" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="ABCD" aria-label="Code du salon" value="${esc(sheet.typed ?? linked ?? "")}"/><button class="cta" data-act="join">Rejoindre</button></div>
          ${bad}
        </div>`;
      const create = `<div class="duel-roles"><button class="duel-role" data-act="host"><b>🏛 Créer un salon</b><small>Ta carte et tes mutateurs · un code à partager</small></button></div>`;
      return {
        body: `<p class="sh-sub duel-place">${ONLINE_NOTE}</p>${nationPicker(v)}${linked ? join + `<p class="duel-or">ou</p>` + create : create + `<p class="duel-or">ou</p>` + join}`,
        actions: cancel
      };
    }
    case "connecting":
      return { body: `<p class="duel-status">${v.role === "host" ? "Création du salon…" : "Connexion au salon…"}</p>`, actions: cancel };
    case "pairing": {
      const quiet = v.quiet ? `<p class="duel-hint">${QUIET_ONLINE}</p>` : "";
      const tips = v.tips ? `<p class="duel-hint">${tipsText(v)}</p>` : "";
      if (v.role === "host") {
        const status = v.pairing?.phase === "linking" || o?.peer ? "Ton ami est là. Appairage…" : v.rematch ? "En attente que ton ami touche Revanche…" : "En attente de ton ami…";
        return {
          body: `<p class="duel-lbl duel-codelbl">Code du salon</p>
            <p class="duel-bigcode" data-code="${esc(o?.code ?? "")}">${esc(o?.code ?? "····")}</p>
            <div class="duel-share"><button class="cta" data-act="share">🔗 Partager le lien</button><button class="cta alt" data-act="copy">Copier</button></div>
            <p class="duel-copied" hidden>Lien copié</p>
            <p class="duel-status">${status}</p>${myNationLine(v)}${quiet}${onlineHtml(v)}${tips}`,
          actions: back + cancel
        };
      }
      const status = v.pairing?.phase === "linking" || o?.peer ? "Ton ami est là. Appairage…" : v.rematch ? "En attente que ton ami touche Revanche…" : "En attente de l'hôte…";
      return { body: `<p class="duel-lbl duel-codelbl">Salon</p><p class="duel-bigcode small">${esc(o?.code ?? "")}</p><p class="duel-status">${status}</p>${myNationLine(v)}${quiet}${onlineHtml(v)}${tips}`, actions: back + cancel };
    }
    default:
      return null;
  }
}

function bodyHtml(v: LobbyView, advOpen: boolean, sheet: OnlineSheet = { linked: null, badCode: false }): { body: string; actions: string } {
  if (v.isOnline && v.step !== "error") {
    const own = onlineBody(v, sheet);
    if (own) return own;
  }
  const cancel = `<button class="cta alt" data-act="cancel">Annuler</button>`;
  const back = v.canBack ? `<button class="cta alt" data-act="back">Retour</button>` : "";
  const notes: string[] = [];
  if (v.noWakeLock && (v.step === "choose" || v.step === "pairing")) notes.push(`<p class="sh-note">Règle le verrouillage auto sur Jamais : ce téléphone ne peut pas garder l'écran allumé tout seul.</p>`);
  if (v.lost && v.step !== "error")
    notes.push(`<div class="duel-warn"><p>La liaison sonore s'est arrêtée.</p><button class="cta" data-act="tap">Touche pour reconnecter la liaison sonore</button></div>`);
  if (v.route) notes.push(`<p class="duel-warn">${routeText(v)}</p>`);
  if (v.loud) notes.push(`<p class="sh-note">Ton propre signal est fort ici : ce téléphone émet maintenant un peu moins fort.</p>`);
  const quiet = v.quiet ? `<p class="duel-hint">${QUIET_TEXT}</p>` : "";
  const p = v.pairing;
  switch (v.step) {
    case "opening":
      return { body: `<p class="duel-status">Démarrage du micro… Autorise-le si demandé.</p>`, actions: cancel };
    case "tap-to-start":
      return { body: `<button class="cta big duel-tap" data-act="tap">Touche pour lancer le son</button>`, actions: cancel };
    case "choose": {
      const plan = v.prefs.plan;
      const mic = v.prefs.micMode;
      const adv = `<details class="duel-adv"${advOpen ? " open" : ""}><summary>Avancé</summary>
          <p class="duel-lbl">Bande <small>(hôte uniquement)</small></p>
          <div class="seg"><button data-act="plan" data-v="high" class="${plan === "high" ? "on" : ""}">Haute · discrète</button><button data-act="plan" data-v="low" class="${plan === "low" ? "on" : ""}">Basse · audible</button></div>
          ${v.practice ? "" : `<p class="duel-lbl">Micro</p>
          <div class="seg"><button data-act="mic" data-v="raw" class="${mic === "raw" ? "on" : ""}">Brut</button><button data-act="mic" data-v="ec" class="${mic === "ec" ? "on" : ""}">Anti-écho</button></div>
          <button class="cta alt" data-act="selftest">Auto-test : ce téléphone s'écoute</button>`}
        </details>`;
      return {
        body: `<p class="sh-sub duel-place">${PLACEMENT}</p>
          <div class="duel-roles">
            <button class="duel-role" data-act="host"><b>📡 Héberger</b><small>Ta carte et tes mutateurs</small></button>
            <button class="duel-role" data-act="join"><b>📲 Rejoindre</b><small>Ton ami héberge</small></button>
          </div>
          ${nationPicker(v)}
          ${notes.join("")}${adv}`,
        actions: cancel
      };
    }
    case "connecting":
      return { body: `<p class="duel-status">Démarrage de la liaison sonore…</p>`, actions: cancel };
    case "self-test":
      return {
        body: `<p class="duel-status">Auto-test : ce téléphone écoute son propre signal. De bons paquets = toute la liaison fonctionne ici.</p>${meterHtml(v)}${notes.join("")}`,
        actions: back + cancel
      };
    case "pairing": {
      const heard = p?.phase === "linking";
      const status = heard
        ? "Le téléphone de ton ami est là. Liaison…"
        : v.rematch
          ? "En attente que ton ami touche Revanche…"
          : v.role === "host"
            ? "Tu héberges. En attente que ton ami touche Rejoindre…"
            : "À l'écoute du téléphone de ton ami (l'hôte)…";
      const hint = v.switchRole
        ? `<div class="duel-hint"><p>${NOTHING_HEARD_MESSAGE}.</p><button class="cta alt" data-act="switch">Passer à ${v.role === "host" ? "Rejoindre" : "Héberger"}</button></div>`
        : "";
      const tips = v.tips ? `<p class="duel-hint">${tipsText(v)}</p>` : "";
      return {
        body: `<p class="sh-sub duel-place">${PLACEMENT}</p><p class="duel-status">${status}</p>${v.rematch ? "" : myNationLine(v)}${quiet}${meterHtml(v)}${hint}${tips}${notes.join("")}`,
        actions: back + cancel
      };
    }
    case "picking":
    case "waiting": {
      const side = p?.side ?? "blue";
      const offered = p?.offered ?? [];
      const picked = v.step === "waiting";
      const nations = p?.config ? configNations(p.config) : undefined;
      const words = nations ? lobbyWords(nations[side]!, nations[side === "blue" ? "red" : "blue"]!) : CLASSIC;
      const cards = offered.length
        ? `<div class="duel-cards${picked ? " chosen" : ""}">${offered.map((id) => openerCard(id, side, picked && p?.pick === id, words)).join("")}</div>`
        : `<p class="duel-status">Aucune ouverture n'est permise avec ces règles.</p>`;
      const head = picked ? `<p class="duel-status">En attente du choix de ton ami…</p>` : `<h3>Choisis ton ouverture <small data-m="pickleft"></small></h3>`;
      return {
        body: `<p class="duel-paired">✓ Appairés · tu joues <b class="duel-side ${side}">${side === "red" ? "rouge" : "bleu"}</b></p>${p?.config ? mapLine(p.config.mapId, p.config.mutators) : ""}${nationsLine(p?.config ?? null, p?.side ?? null)}${head}${quiet}${cards}${v.isOnline ? onlineHtml(v) : meterHtml(v)}${notes.join("")}`,
        actions: back + cancel
      };
    }
    case "go":
      return { body: `<p class="duel-go">GO !</p><p class="duel-status">En attente de ton ami…</p>${quiet}${v.isOnline ? onlineHtml(v) : meterHtml(v)}${notes.join("")}`, actions: cancel };
    case "loading":
      return { body: `<p class="duel-go">GO !</p><p class="duel-status">Lancement de la partie…</p>${v.isOnline ? onlineHtml(v) : meterHtml(v)}${notes.join("")}`, actions: cancel };
    case "error":
      return errorHtml(v);
    default:
      return { body: "", actions: "" };
  }
}

function errorHtml(v: LobbyView): { body: string; actions: string } {
  const e = v.error;
  const close = `<button class="cta alt" data-act="cancel">Fermer</button>`;
  if (!e) return { body: "", actions: close };
  const reload = `<button class="cta" data-act="reload">Recharger</button>`;
  switch (e.kind) {
    case "failed":
      return { body: `<button class="cta big duel-tap" data-act="retry">${esc(e.message)}</button>`, actions: `<button class="cta alt" data-act="cancel">Annuler</button>` };
    case "version": {
      const who = e.older === "this" ? "Ce téléphone a l'ancienne version." : e.older === "friend" ? "Le téléphone de ton ami a l'ancienne version." : "";
      return { body: `<p class="duel-err">${esc(e.message)}</p>${who ? `<p class="sh-note">${who}</p>` : ""}`, actions: close + reload };
    }
    case "rig": {
      const advice = e.reason ? RIG_ADVICE[e.reason] ?? "" : "";
      return {
        body: `<p class="duel-err">${esc(e.message)}</p>${advice ? `<p class="sh-note">${advice}</p>` : ""}`,
        actions: e.reason === "update" ? close + reload : close
      };
    }
    case "relay":
      return { body: `<p class="duel-err">${esc(e.message)}</p><p class="sh-note">The page has no window.__duelOut: connect it with the relay harness.</p>`, actions: close };
    case "left":
      return { body: `<p class="duel-err">${esc(e.message)}.</p>`, actions: close };
    case "online":
      return { body: `<p class="duel-err">${esc(e.message)}</p>`, actions: close };
    case "modem":
      return {
        body: `<p class="duel-err">La liaison sonore ne fonctionne plus.</p><p class="sh-note">Ferme, puis touche Duel pour la relancer. (${esc(e.message)})</p>`,
        actions: close + reload
      };
    default:
      return { body: `<p class="duel-err">Un problème est survenu : ${esc(e.message)}</p>`, actions: close };
  }
}

/** The sheet: the machine, its env in the browser, the frame loop, the taps. */
function run(o: LobbyOptions, rematch: DuelRematch | null): void {
  const params = parseDuelParams(location.search);
  // (an online duel, from its button or its rematch, is never a practice link, whatever the URL says)
  const online = rematch ? rematch.online ?? null : o.online ? { code: o.online.code ? normCode(o.online.code) : null, key: null } : null;
  const practice = online || params.mode === "sound" ? null : params.mode;
  const build = duelBuild();
  let loop: LoopLink | null = null;
  let relay: RelayTransport | null = null;
  let net: OnlineLink | null = null;
  /** The seat's key (a rematch keeps its own), and the code the guest joins (typed, or the rematch's). */
  const seatKey = online?.key ?? drawKey(cryptoRandom);
  let joinCode: string | null = rematch?.online?.code ?? null;
  const sheet: OnlineSheet = { linked: rematch ? null : online?.code ?? null, badCode: false };
  let feed: VersusFeed | null = null;
  let machine: LobbyMachine | null = null;
  let timer = 0;
  let raf = 0;
  let stopped = false;

  o.host.querySelector(".duel-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap duel-wrap";
  wrap.innerHTML = `<div class="sheet duelsheet" role="dialog" aria-label="Défier un ami">
      <h2>${online ? "🌐" : "🔊"} ${rematch ? "Revanche" : online ? "Défier un ami (en ligne)" : "Défier un ami"}</h2>
      ${online ? "" : practice ? `<p class="duel-practice">Liaison d'entraînement (sans son) : ${practice === "loop" ? "un ami dans la page" : "le relais"}</p>` : `<p class="duel-noise" role="note">${NOISE_WARNING}</p>`}
      <div class="duel-body"></div>
      <div class="sh-actions duel-actions"></div>
    </div>`;
  o.host.appendChild(wrap);
  const offPageGone = o.rig ? closeRigOnPageGone(window, o.rig) : () => undefined;
  const body = wrap.querySelector<HTMLElement>(".duel-body")!;
  const actions = wrap.querySelector<HTMLElement>(".duel-actions")!;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    cancelAnimationFrame(raf);
  };
  const closeSheet = () => {
    stop();
    wrap.remove();
  };
  const dropPractice = () => {
    loop?.close();
    relay?.close();
    net?.close();
    loop = null;
    relay = null;
    net = null;
  };

  const prefs = loadPrefs();
  const env: LobbyEnv = {
    now: () => performance.now(),
    build,
    random: cryptoRandom,
    rig: o.rig,
    practice,
    online: online !== null,
    onlineInfo: () => net?.info() ?? null,
    rematch,
    seat: practice === "relay" ? params.seat : null,
    prefs,
    savePrefs,
    offer: { map: o.shownMap, mutators: o.mutators, hostSide: practice ? params.side : "blue", nation: gameMode.nation },
    link: async (cfg, offer) => {
      if (online) {
        dropPractice();
        const base = relayBase(location.search);
        const env = browserOnlineEnv();
        let l: OnlineLink;
        if (cfg.tx === "host") l = await hostRoom({ base, key: seatKey, code: rematch?.online?.code, env, random: cryptoRandom });
        else {
          const code = joinCode;
          if (!code) throw new OnlineError("unknown");
          l = await joinRoom({ base, key: seatKey, code, env });
        }
        net = l;
        return l;
      }
      if (practice === "loop") {
        dropPractice();
        const friendOffer: HostOffer = rematch ? offer : { ...offer, hostSide: cfg.tx === "host" ? params.side : params.side === "blue" ? "red" : "blue" };
        // (the in-page friend hosting offers the nation facing this page's: a République page meets an Empire)
        if (cfg.tx === "guest" && offer.nation && offer.nation !== "classique") friendOffer.nation = rivalOf(offer.nation as Nation);
        loop = new LoopLink({ params: params.loop, role: cfg.tx, offer: friendOffer, build, seed: (cryptoRandom() * 4294967296) >>> 0 });
        return loop.page;
      }
      if (practice === "relay") {
        dropPractice();
        const r = new RelayTransport({ role: cfg.tx, win: window });
        if (!r.connected()) {
          r.close();
          throw new RelayError("Relay not connected");
        }
        relay = r;
        return r;
      }
      if (!o.rig) throw new RigError("no-audio");
      return o.rig.createLink(cfg);
    },
    guard: (plan) => {
      if (practice) return;
      try {
        sfx.setLinkGuard(plan);
      } catch (e) {
        console.warn("link guard:", e);
      }
    },
    begin: (session) => {
      const n = net;
      const onFrame = loop ? () => loop?.pump() : relay ? () => relay?.tick() : n ? () => n.tick() : undefined;
      let exited = false;
      const f = new VersusFeed({
        session,
        rig: o.rig,
        practice: practice !== null,
        online: n ? { info: () => n.info(), code: n.code, key: n.key } : null,
        onExit: () => {
          if (exited) return;
          exited = true;
          dropPractice();
          o.rig?.close();
          if (!practice && !online) sfx.setLinkGuard(null);
        },
        ...(onFrame ? { onFrame } : {})
      });
      feed = f;
      offPageGone();
      closeSheet();
      o.start(f);
      if (f.world.mapId !== gameMode.mapId) console.error(`sound duel: the feed's map ${f.world.mapId} isn't the game's ${gameMode.mapId}`);
    },
    released: (why) => {
      offPageGone();
      dropPractice();
      o.onClose(why);
    }
  };

  if (practice || online) exposeProbe(() => machine, () => feed, () => net);
  const m = (machine = new LobbyMachine(env));

  let key = "";
  let advOpen = false;
  const render = () => {
    const v = m.state();
    if (v.step === "closed" || v.step === "started") return;
    const k = layoutKey(v);
    if (k !== key) {
      key = k;
      const typed = body.querySelector<HTMLInputElement>(".duel-codein")?.value;
      if (typed !== undefined) sheet.typed = typed;
      const html = bodyHtml(v, advOpen, sheet);
      body.innerHTML = html.body;
      actions.innerHTML = html.actions;
      body.querySelector<HTMLDetailsElement>(".duel-adv")?.addEventListener("toggle", (e) => (advOpen = (e.target as HTMLDetailsElement).open));
    }
    fillMeter(body, v);
    const left = body.querySelector<HTMLElement>(`[data-m="pickleft"]`);
    const ms = v.pairing?.pickLeftMs;
    if (left) left.textContent = ms === null || ms === undefined ? "" : `${Math.ceil(ms / 1000)} s`;
  };
  const frame = () => {
    if (stopped) return;
    loop?.pump();
    m.update();
    const v = m.state();
    if (m.done) {
      // (an error stays up until it's closed; otherwise the sheet goes)
      if (v.step === "error") render();
      else closeSheet();
      stop();
      return;
    }
    // (cancelled: the sheet is gone, and the link says the end until the session may close)
    if (v.step === "closed") return void wrap.remove();
    render();
  };
  const loopFrame = () => {
    frame();
    if (!stopped) raf = requestAnimationFrame(loopFrame);
  };
  raf = requestAnimationFrame(loopFrame);
  // (a hidden page gets no frames, and the link must go on)
  timer = window.setInterval(frame, 50);

  /** The online guest's Join: the typed code (4 letters), else say so. */
  const joinTyped = () => {
    const code = normCode(body.querySelector<HTMLInputElement>(".duel-codein")?.value ?? "");
    if (!code) {
      sheet.badCode = true;
      key = "";
      return render();
    }
    sheet.badCode = false;
    sheet.linked = code;
    joinCode = code;
    m.join();
  };
  /** The invite link to the host's room, shared (Web Share) or copied. */
  const invite = async (share: boolean) => {
    const code = net?.code;
    if (!code) return;
    const url = inviteUrl(location.href, code);
    const copied = body.querySelector<HTMLElement>(".duel-copied");
    if (share && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Panache : un duel ?", text: `Viens m'affronter dans Panache ! Code du salon : ${code}`, url });
        return;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
      }
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      /* no clipboard: show it */
    }
    if (copied) {
      copied.hidden = false;
      copied.textContent = ok ? "Lien copié : envoie-le à ton ami" : url;
    }
  };
  if (online) {
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement).classList?.contains("duel-codein")) joinTyped();
    });
    wrap.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.classList?.contains("duel-codein")) t.value = t.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    });
  }

  wrap.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el || !wrap.contains(el)) return;
    switch (el.dataset.act) {
      case "host":
        return m.host();
      case "join":
        return online ? joinTyped() : m.join();
      case "share":
        return void invite(true);
      case "copy":
        return void invite(false);
      case "selftest":
        return m.startSelfTest();
      case "switch":
        return m.switchRole();
      case "back":
        return m.back();
      case "retry":
        return m.retry();
      case "tap":
        return m.tapToStart();
      case "plan":
        m.setPlan(el.dataset.v === "low" ? "low" : "high");
        return render();
      case "nation": {
        const n = el.dataset.v;
        if (n === "classique" || n === "republique" || n === "empire") {
          m.setNation(n);
          sfx.play("click", 0.5);
        }
        return render();
      }
      case "mic":
        m.setMicMode(el.dataset.v === "ec" ? "ec" : "raw");
        return render();
      case "pick":
        if (el.dataset.id && m.pick(el.dataset.id as OpenerId)) sfx.play("click", 0.5);
        return;
      case "reload":
        return fullscreen.reload();
      case "cancel":
        m.cancel();
        // (the frame loop goes on until the session may close, if it must say the end first)
        if (m.done) closeSheet();
        else wrap.remove();
        return;
    }
  });
}

/** window.__duel for the relay and loop harnesses. */
function exposeProbe(machine: () => LobbyMachine | null, feed: () => VersusFeed | null, net: () => OnlineLink | null = () => null): void {
  const probe: DuelProbe = {
    get state() {
      const f = feed();
      return f ? f.session.phase : machine()?.state().step ?? "opening";
    },
    get tick() {
      return feed()?.world.tick ?? -1;
    },
    get delay() {
      return feed()?.result.delay ?? null;
    },
    trail: () => feed()?.session.lockstep?.trail() ?? null,
    online: () => net()?.info() ?? null,
    trails: (from) => feed()?.trails(from) ?? [],
    hash: () => {
      const f = feed();
      return f ? worldHash(f.world) : null;
    },
    get result() {
      const ls = feed()?.session.lockstep;
      if (!ls) return null;
      const st = ls.status();
      return {
        end: st.end,
        winner: st.decided?.winner ?? null,
        resigned: st.decided?.resigned ?? null,
        tick: st.decided?.tick ?? null,
        endCheck: st.endCheck,
        desync: st.desync
      };
    }
  };
  window.__duel = probe;
}
