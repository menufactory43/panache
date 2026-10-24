/**
 * The feed of a duel (DUEL.md "MatchFeed and GameScene"): the
 * MatchFeed GameScene plays a duel through. It builds the world both phones
 * agreed on, begins the session's lockstep, and from then on is the scene's
 * only way to the sim: each tick it seals this phone's orders (drained from
 * the scene's Controller) and hands back both sides' turn, or null to stall;
 * after each step it folds the world hash into the trail and keeps the turn
 * log and hashes for Save battle. Around that it runs the duel's in-match
 * life: the pause and background bits, the stall overlays, resign and leave, the end (aborts, the win/loss record) and the way
 * out (Menu and Rematch wait for the end to go out, then reload).
 *
 *   const feed = new VersusFeed({ session, practice, online, onExit })   (phase "starting": beginMatch now)
 *   main.ts:  begin(false, () => duelSetup(feed.config), feed)        (GameScene calls attach, commands, afterTick, frame)
 *
 * It pumps the session from construction on, every animation frame and from
 * a 50 ms timer (art loading blocks frames, and a hidden page gets none), and
 * stops when closed. A visibilitychange to hidden pauses the lockstep at once
 * (session.setHidden), so the frame the link repeats says paused, and counts
 * a match the record doesn't have yet (below).
 *
 * Lift groups first. The codec splits a long unit list into pieces the
 * lockstep seals into turns of their own, and a Goliath whose lift is still
 * hooking on obeys a move only when its Condors are named in the same command
 * (src/sim/lift.ts HeldLiftOrders): a select-all whose Goliath fell in an
 * earlier piece than its Condors would leave the Goliath behind. So the feed
 * hands the lockstep each such lift as a command of its own first (the
 * Goliath and its Condors that the order names), then the rest of the order:
 * a small command is never split, and the lift goes as one. A lift lands D
 * ticks (or a queue's wait) after its tap, so a select-all right after it
 * would find no lift in the world yet, then split, and its Goliath piece
 * would land on a lift hooking on by then: the feed also counts the lifts it
 * sent and hasn't stepped yet (LiftInFlight). The Controller's own taps never
 * send such a lift's members anywhere while it hooks on or is on its way (it
 * holds the order until the lift is up, as single player does:
 * Controller.ahead), so this is for orders made otherwise (an AI driving the
 * Controller, as the tests do).
 *
 * Engine-free where it can be: the browser's pieces (timers, document,
 * storage, reload) come through FeedEnv, and what it needs of the scene
 * through DuelScene, so tests run it in Node with a real Controller.
 *
 * Where the spec is silent:
 *  - "Waiting for your friend to load…" also shows while the friend's game
 *    frames arrive but it has sealed no turn yet (it hasn't stepped tick 0:
 *    its art is still loading), as well as on its lobby frames;
 *  - Leave in the stall pill: after 30 s of "Signal lost", or 60 s of any
 *    stall (the friend paused or loading for that long); in the pause menu,
 *    once "Signal lost" showed, a stall reached 60 s, or nothing has been
 *    heard for 5 s. "Resign and leave" while packets arrive (heard within
 *    2.5 s);
 *  - "Resign and leave" resigns like Resign and then skips the finale: the
 *    report shows as soon as the resign lands, and its Menu reloads;
 *  - "Leave (no result)" leaves at once (the end goes out for 2 s while the
 *    end screen says "You left · No result") and counts as abandoned. A
 *    friend that left before this phone's match was decided ends it as
 *    "Friend left" (abandoned); one that leaves after keeps the result;
 *  - the win/loss record is written as soon as the result is known: the
 *    match decided here (not waiting for the end check), or aborted. A page
 *    that goes hidden with the match not counted yet counts it at once, as
 *    the lockstep has it, else as abandoned for now: hidden is the last
 *    event a phone reliably fires (one closed, or killed in the background,
 *    fires no pagehide), and the match's own end moves that stand-in over
 *    if the page comes back. pagehide counts it the same way. A match
 *    decided here and found out of sync after (the end check, or the
 *    friend's end report while Menu or Rematch waits) is no contest: the
 *    result counted is moved over, as the end screen then says;
 *  - Menu and Rematch wait for the session to be closable or 2.5 s, showing
 *    "Leaving…", then close the session, call onExit and reload; a page
 *    unload does the record and onExit only;
 *  - "Your friend is back in the lobby: tap Rematch" shows on the report
 *    once a lobby frame follows the friend's game frames (its page reloaded:
 *    the lockstep's peerInLobby), on any end screen, since all offer Rematch;
 *  - "Copy debug info" copies JSON: the build, role and side, the agreed
 *    config and nonces, D, the tick, both trails' checkpoints and the end
 *    reports (Lockstep.debug), and the turn log;
 *  - every order this phone drains is in flight (Controller.inFlight) until
 *    its turn is stepped, not only placement and production: the build bar,
 *    the power panel and the Controller's own reads (a lift, a boarding, an
 *    anchor, a sale, a rally point, a calldown) take it as landed, so a tap
 *    that builds on the one before does what it does in single player. One
 *    the lockstep replaced in its queue before it went out never lands: once
 *    a drain leaves the queue empty and that tick + D is stepped, whatever
 *    was drained by then and is still in flight comes off. All of them come
 *    off at an abort. A building placed isn't taken as landed: the sim gives
 *    it its id, so what it unlocks, and a queue at it, wait until it lands;
 *  - a practice link keeps the hash trail after every tick (trails(), the
 *    relay smoke's window.__duel.trails): read from outside after each frame,
 *    the trail missed every tick a frame stepped two of, which a lossy link's
 *    stalls make common.
 */
import type { BattleRecord } from "../arena/record";
import type { Controller } from "../game/controller";
import type { AbortReason, MatchFeed } from "../game/GameScene";
import { worldHash } from "../sim/checksum";
import type { MutatorId } from "../sim/rules";
import { setupWorld } from "../sim/setup";
import type { Command, Faction, Nation, World } from "../sim/types";
import { fullscreen } from "../ui/fullscreen";
import type { DuelHud } from "../ui/hud";
import { addReportSection } from "../ui/report";
import { duelReportSection, mountDuelOverlay, type DuelOverlay, type DuelReportView, type OverlayState, type StallKind } from "./hud";
import type { PairingResult } from "./pairing";
import type { OnlineInfo } from "./online";
import {
  HASH_EVERY, ONLINE_RECORD_KEY, addOutcome, battleRecord, downloadRecord, duelEnd, moveOutcome, readTally, tallyLine, withOutcome, writeRematch,
  type DuelOutcome, type DuelTally
} from "./records";
import { PEER_HEARD_MS, type Session } from "./session";
import { tr } from "../lang";

declare const __SIM_HASH__: string | undefined;
/** The sim this build plays (vite.config.ts), or null outside a Vite build (tests). */
const BUILD_SIM: string | null = typeof __SIM_HASH__ === "undefined" ? null : __SIM_HASH__;

/** A stall shows after this long with no new turn from the friend (DUEL.md "Stall overlays"). */
export const WAIT_SHOW_MS = 500;
/** … "Signal lost: bring the phones closer" after this long … */
export const SIGNAL_LOST_MS = 5000;
/** An online friend whose connection left the room is offered Leave after this long: the relay keeps its seat a minute. */
export const LEAVE_GONE_MS = 60_000;
/** … and Leave after this long of it, or LEAVE_ANY_MS of any stall (packets arriving: the friend paused or loading). */
export const LEAVE_LOST_MS = 30_000;
export const LEAVE_ANY_MS = 60_000;
/** Menu and Rematch wait at most this long for the end frames to go out. */
export const EXIT_WAIT_MS = 2500;
/** The pending queue holds more than this many ticks of orders: "Orders queued". */
const QUEUED_TICKS = 20;
/** The fallback pump (ms): art loading blocks animation frames, and a hidden page gets none. */
const PUMP_MS = 50;
/** A lift sent this many ticks ago and still not stepped never will be (the codec dropped it): lift groups first forgets it. */
const LIFT_FLIGHT_MAX = 600;

/** What duelSetup (src/game/mode.ts) points the match at. */
export interface DuelSetupConfig {
  mapId: string;
  mutators: MutatorId[];
  local: Faction;
  /** The nations the lobby agreed (absent: Classique). */
  nations?: Partial<Record<Faction, Nation>>;
}

/** What the feed needs of the scene: GameScene, or a stand-in in tests. */
export interface DuelScene {
  readonly ctrl: Controller;
  /** End with no result (GameScene.abort). */
  abort(reason: AbortReason, info?: string): void;
  /** Show the end screen now if the finale is playing ("Resign and leave"). */
  skipFinale(): void;
}

/** The browser around the feed (tests pass their own pieces). */
export interface FeedEnv {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  /** Null: no animation frames (the timer alone pumps). */
  requestAnimationFrame: ((fn: () => void) => unknown) | null;
  cancelAnimationFrame(id: unknown): void;
  /** Null: no DOM (no overlays, no report section, no visibility). */
  document: Document | null;
  /** pagehide (the page going away): the record and onExit. */
  window: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  /** localStorage (the win/loss record) and sessionStorage (the rematch), or null where blocked. */
  local: Pick<Storage, "getItem" | "setItem"> | null;
  session: Pick<Storage, "getItem" | "setItem"> | null;
  /** Back to the menu (or into the rematch): fullscreen.reload(). */
  reload(): void;
  /** For the record's `created`. */
  date(): Date;
}

function storage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function browserEnv(): FeedEnv {
  if (typeof window === "undefined")
    return {
      setInterval: () => null, clearInterval: () => undefined, requestAnimationFrame: null, cancelAnimationFrame: () => undefined,
      document: null, window: null, local: null, session: null, reload: () => undefined, date: () => new Date()
    };
  return {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    requestAnimationFrame: (fn) => window.requestAnimationFrame(fn),
    cancelAnimationFrame: (id) => window.cancelAnimationFrame(id as number),
    document,
    window,
    local: storage("localStorage"),
    session: storage("sessionStorage"),
    reload: () => fullscreen.reload(),
    date: () => new Date()
  };
}

/** A `lift` this phone sent that hasn't been stepped yet: the Goliath, and the Condors it named. */
export interface LiftInFlight {
  goliathId: number;
  condors: readonly number[];
}

export interface VersusFeedOptions {
  /** Phase "starting": result() is set. The feed calls beginMatch in its constructor. */
  session: Session;
  /** A practice link (?duel=loop or relay): no win/loss record, and the report says so. */
  practice: boolean;
  /**
   * An online duel (src/versus/online.ts): its room's state for the stall pill (this phone's connection down, the
   * friend's gone from the room), its win/loss record, and the room the Rematch takes back. Null: a practice link.
   */
  online?: { info(): OnlineInfo; code: string; key: string } | null;
  /** The other side's label (default "your friend"). */
  opponent?: string;
  /** Once, when the duel is over for this page (the session closable, or the page going): the lobby lets its link go. */
  onExit: () => void;
  /** Every frame (a practice peer steps along). */
  onFrame?: (deltaMs: number) => void;
  /** The browser's pieces (tests). */
  env?: Partial<FeedEnv>;
}

const OTHER: Record<Faction, Faction> = { blue: "red", red: "blue" };
const isLiftOrder = (c: Command): c is Extract<Command, { type: "move" | "attackMove" | "unload" | "stop" }> =>
  c.type === "move" || c.type === "attackMove" || c.type === "unload" || c.type === "stop";

/**
 * Lift groups first (see the header): each order a lift takes that names a
 * Goliath still hooking on together with any of its Condors becomes one
 * command naming exactly that Goliath and those Condors, then the order for
 * the rest of its units (none left: nothing). A Goliath counts as hooking on
 * while its lift is in the world, and while a lift for it is on its way:
 * `inFlight` (sent, not stepped yet) or earlier in `cmds`. Lifts and other
 * commands pass unchanged.
 */
export function liftGroupsFirst(w: World, cmds: readonly Command[], inFlight: readonly LiftInFlight[] = []): Command[] {
  const out: Command[] = [];
  const sent = inFlight.slice();
  for (const c of cmds) {
    if (c.type === "lift") sent.push({ goliathId: c.goliathId, condors: c.unitIds });
    if (!isLiftOrder(c)) {
      out.push(c);
      continue;
    }
    const grouped = new Set<number>();
    const groups: number[][] = [];
    for (const id of c.unitIds) {
      const g = w.units.get(id);
      if (!g?.goliath || g.faction !== c.faction || grouped.has(id)) continue;
      // its Condors: the lift's while it hooks on, and those any lift on its way names
      const lift = g.goliath.lift;
      const condors = new Set(lift?.phase === "hooking" ? lift.carriers : []);
      for (const l of sent) if (l.goliathId === id) for (const cid of l.condors) condors.add(cid);
      const ids = [id];
      for (const cid of c.unitIds) if (condors.has(cid) && !grouped.has(cid) && !ids.includes(cid)) ids.push(cid);
      if (ids.length === 1) continue; // (its Condors not named: it waits, as a single order would leave it)
      for (const i of ids) grouped.add(i);
      groups.push(ids);
    }
    if (groups.length === 0) {
      out.push(c);
      continue;
    }
    for (const ids of groups) out.push({ ...c, unitIds: ids });
    const rest = c.unitIds.filter((id) => !grouped.has(id));
    if (rest.length > 0) out.push({ ...c, unitIds: rest });
  }
  return out;
}

const outcomeOf = (winner: Faction | "draw", local: Faction): DuelOutcome => (winner === "draw" ? "draw" : winner === local ? "win" : "loss");

export class VersusFeed implements MatchFeed {
  readonly config: DuelSetupConfig;
  readonly local: Faction;
  readonly opponent: string;
  readonly world: World;
  readonly labels: Record<Faction, string>;
  readonly session: Session;
  /** The match as the pairing agreed it. */
  readonly result: PairingResult;
  readonly practice: boolean;
  readonly online: { info(): OnlineInfo; code: string; key: string } | null;
  /** The pause menu's and the report's duel parts (GameScene hands them to the HUD). */
  readonly duel: DuelHud;

  private readonly env: FeedEnv;
  private readonly onExit: () => void;
  private readonly onFrame: ((deltaMs: number) => void) | null;
  private readonly created: string;
  private scene: DuelScene | null = null;
  private ui: DuelOverlay | null = null;
  private teardown: (() => void)[] = [];
  private timer: unknown = null;
  private raf: unknown = null;
  private closed = false;
  private exited = false;

  /** The turns as stepped (blue's entry before red's on a tick), and a world hash every HASH_EVERY ticks: Save battle. */
  private readonly turns: [number, Faction, Command[]][] = [];
  private readonly hashes: [number, string][] = [];
  /** The commands commands() handed over for the step afterTick follows. */
  private stepping: Command[] | null = null;
  /** This phone's lifts sent and not stepped yet (lift groups first), with the tick each was drained on. */
  private readonly lifts: (LiftInFlight & { at: number })[] = [];
  /**
   * Ticks whose drain left the lockstep nothing waiting for room in a turn,
   * oldest first: all drained by then is sealed for that tick + D at the
   * latest, or was replaced in the queue and never goes out. Once that turn
   * is stepped, whatever of it the Controller still has in flight comes off
   * (Controller.settled).
   */
  private readonly drainedAll: number[] = [];
  /** A practice link's hash trail after each tick stepped (index: the tick); null on a sound link. */
  private readonly trailLog: number[] | null;

  private userPaused = false;
  /** The tick a resign was ordered on (null: none), and whether it was "Resign and leave". */
  private resignAt: number | null = null;
  private resignLeave = false;
  private aborted: AbortReason | null = null;
  /** The outcome counted (once, or moved over: settle), and the record as it then stood. */
  private settled: DuelOutcome | null = null;
  /** `settled` is abandoned for now: counted when the page went hidden mid-match (wentHidden). */
  private standIn = false;
  private tally: DuelTally | null = null;
  /** The latest stall shown, kept while paused (the pause menu's Leave), cleared once the match moves. */
  private lastStall: { kind: StallKind; ms: number } | null = null;
  /** Menu or Rematch: leaving since (link clock). */
  private exiting: { to: "menu" | "rematch"; at: number } | null = null;

  constructor(o: VersusFeedOptions) {
    const r = o.session.result();
    if (!r) throw new Error("no duel agreed yet: the session has no result");
    this.session = o.session;
    this.result = r;
    this.practice = o.practice;
    this.online = o.online ?? null;
    this.trailLog = o.practice || this.online ? [] : null;
    this.onExit = o.onExit;
    this.onFrame = o.onFrame ?? null;
    this.env = { ...browserEnv(), ...o.env };
    this.local = r.local;
    this.opponent = o.opponent ?? tr("ton ami", "your friend");
    this.config = { mapId: r.mapId, mutators: r.setup.mutators.slice(), local: r.local, ...(r.setup.nations ? { nations: { ...r.setup.nations } } : {}) };
    this.labels = { [r.local]: tr("Toi", "You"), [OTHER[r.local]]: tr("Ami", "Friend") } as Record<Faction, string>;
    this.created = this.env.date().toISOString();
    this.world = setupWorld(r.setup);
    o.session.beginMatch(parseInt(worldHash(this.world), 16));
    this.duel = {
      opponent: this.opponent,
      practice: this.practice,
      online: this.online !== null,
      delayMs: () => r.delay * 100,
      resign: (leave) => this.resign(leave),
      leave: () => this.leave(),
      exits: () => this.exits(),
      resigning: () => this.resignAt !== null,
      rematch: () => this.exit("rematch"),
      menu: () => this.exit("menu"),
      actions: () => (this.env.document ? [{ id: "duel-save", label: tr("Enregistrer la bataille", "Save the battle"), cls: "alt", on: () => this.save() }] : [])
    };

    const env = this.env;
    const doc = env.document;
    if (doc) {
      const vis = () => {
        const hidden = doc.visibilityState === "hidden";
        this.session.setHidden(hidden);
        if (hidden) this.wentHidden();
      };
      doc.addEventListener("visibilitychange", vis);
      this.teardown.push(() => doc.removeEventListener("visibilitychange", vis));
      vis();
    }
    const win = env.window;
    if (win) {
      const gone = (e: Event) => {
        if (!(e as PageTransitionEvent).persisted) this.pageGone();
      };
      win.addEventListener("pagehide", gone);
      this.teardown.push(() => win.removeEventListener("pagehide", gone));
    }
    this.timer = env.setInterval(() => this.pump(), PUMP_MS);
    const raf = env.requestAnimationFrame;
    if (raf) {
      const loop = () => {
        if (this.closed) return;
        this.pump();
        this.raf = raf(loop);
      };
      this.raf = raf(loop);
    }
  }

  // ------------------------------------------------------- MatchFeed ---

  /** The scene is up: its Controller, abort and finale; the overlays and the report section go in with it. */
  attach(scene: DuelScene): void {
    this.scene = scene;
    const doc = this.env.document;
    const root = doc?.getElementById("hud");
    if (root) {
      this.ui = mountDuelOverlay(root, { leave: () => this.leave() });
      this.teardown.push(addReportSection(duelReportSection(() => this.reportView())));
    }
    this.pump();
  }

  /** Tick `tick`'s commands, both sides' (blue's then red's), or null to stall. Seals this phone's turn tick + D once. */
  commands(tick: number): Command[] | null {
    const scene = this.scene;
    if (!scene || this.closed || this.aborted) return null;
    // (paused since the last pump: nothing is sealed, whoever calls)
    this.syncPause(scene);
    let sealed = false;
    const cmds = this.session.commandsFor(tick, () => {
      sealed = true;
      const drained = scene.ctrl.drainCommands();
      const out = liftGroupsFirst(this.world, drained, this.lifts);
      for (const c of drained) if (c.type === "lift") this.lifts.push({ goliathId: c.goliathId, condors: c.unitIds.slice(), at: tick });
      return out;
    });
    if (sealed && this.session.lockstep?.status().queued === 0) this.drainedAll.push(tick);
    this.stepping = cmds;
    return cmds;
  }

  /** After each step: the trail, the turn log and hashes, and the orders that landed. */
  afterTick(w: World): void {
    const cmds = this.stepping ?? [];
    this.stepping = null;
    const t = w.tick - 1;
    const hash = worldHash(w);
    for (const side of ["blue", "red"] as const) {
      const theirs = cmds.filter((c) => c.faction === side);
      if (theirs.length > 0) this.turns.push([t, side, theirs]);
    }
    this.session.afterStep(t, parseInt(hash, 16), w.winner ? { winner: w.winner, resigned: w.resigned ?? null } : null);
    if (this.trailLog) {
      const trail = this.session.lockstep?.trail();
      if (trail !== undefined) this.trailLog[t] = trail;
    }
    if (w.tick % HASH_EVERY === 0) this.hashes.push([w.tick, hash]);
    const mine = cmds.filter((c) => c.faction === this.local);
    this.scene?.ctrl.landed(mine);
    let through: number | null = null;
    while (this.drainedAll.length > 0 && this.drainedAll[0]! + this.result.delay <= t) through = this.drainedAll.shift()!;
    if (through !== null) this.scene?.ctrl.settled(through);
    // (the lifts that landed are in the world now; one the codec dropped, naming too many Condors, never lands)
    for (const c of mine)
      if (c.type === "lift") {
        const i = this.lifts.findIndex((l) => l.goliathId === c.goliathId);
        if (i >= 0) this.lifts.splice(i, 1);
      }
    while (this.lifts.length > 0 && t - this.lifts[0]!.at > LIFT_FLIGHT_MAX) this.lifts.shift();
  }

  /** Every frame: pump, overlays, and a practice peer's step. */
  frame(deltaMs: number): void {
    this.pump();
    this.onFrame?.(deltaMs);
  }

  /** No rewinding a duel. */
  keyframe(): World | null {
    return null;
  }

  /** Game speed this frame: the slack trim (0.9–1.1). */
  speed(): number {
    return this.session.speed();
  }

  // ------------------------------------------------------------ driving ---

  /** Pump the session, then everything that follows from it: the pause bit, the end, the overlays, leaving. Cheap; call any time. */
  pump(): void {
    if (this.closed) return;
    this.session.pump();
    this.watch();
    if (this.closed) return;
    // (always: the pause menu's Leave reads the stall it last saw)
    const shown = this.overlay();
    this.ui?.update(shown);
  }

  private watch(): void {
    const ls = this.session.lockstep;
    const scene = this.scene;
    if (scene) this.syncPause(scene);
    if (this.exiting) {
      const st = this.session.status();
      if (st.closable || this.session.transport.now() - this.exiting.at >= EXIT_WAIT_MS) this.finish(this.exiting.to);
      return;
    }
    if (!ls || !scene) return;
    const st = ls.status();
    // the end: out of sync, the friend gone before this phone's match was decided, or decided (counted at once,
    // the end check still running: a failed one moves it to no contest)
    if (st.desync) this.abort("desync");
    else if (!st.decided && st.peerEnd === "left") this.abort("left");
    else if (st.decided) this.settle(outcomeOf(st.decided.winner, this.local));
    if (this.resignLeave && this.world.winner && !this.aborted) scene.skipFinale();
  }

  /** The pause menu (ctrl.paused): the frames say paused and nothing new is sealed (the game loop stops calling commands too). */
  private syncPause(scene: DuelScene): void {
    const paused = scene.ctrl.paused;
    if (paused === this.userPaused) return;
    this.userPaused = paused;
    this.session.setPaused(paused);
  }

  /** What the overlays show now (each pump; public for tests). */
  overlay(): OverlayState {
    const st = this.session.status();
    const ls = st.lockstep;
    const over = this.aborted !== null || !!this.world.winner || this.session.phase === "ended";
    let stall: OverlayState["stall"] = null;
    const wt = st.waiting;
    if (wt && !over) {
      // (the friend's frames arrive but it has no turn of its own yet: it hasn't stepped tick 0, its art is loading)
      const loading = wt.why === "load" || (!!ls && ls.ackThrough < ls.delay && st.link.sinceRx <= PEER_HEARD_MS);
      // (online: this phone's connection down, or the friend's gone from the room, say so rather than "lost")
      const net = this.online?.info() ?? null;
      const netKind: StallKind | null = !net ? null : net.state !== "open" ? "offline" : !net.peer && net.peerGoneMs !== null ? "gone" : null;
      const kind: StallKind = netKind ?? (wt.why === "paused" ? "paused" : loading ? "load" : wt.ms >= SIGNAL_LOST_MS ? "lost" : "wait");
      this.lastStall = { kind, ms: wt.ms };
      const leave =
        kind === "gone" ? (net?.peerGoneMs ?? 0) >= LEAVE_GONE_MS || wt.ms >= LEAVE_ANY_MS : ((kind === "lost" || kind === "offline") && wt.ms >= LEAVE_LOST_MS) || wt.ms >= LEAVE_ANY_MS;
      if (wt.ms >= WAIT_SHOW_MS) stall = { kind, leave };
    } else if (!this.userPaused && !st.lockstep?.paused) this.lastStall = null;
    return {
      stall,
      queued: !over && !!ls && ls.queuedTicks > QUEUED_TICKS,
      resigning: this.resignAt !== null && !over,
      leaving: this.exiting !== null
    };
  }

  // ------------------------------------------------------ the player ---

  /** Resign (the pause menu, confirmed): it lands D ticks later on both phones; input is locked meanwhile. */
  private resign(leave: boolean): void {
    const scene = this.scene;
    if (!scene || this.resignAt !== null || this.aborted || this.world.winner || this.exiting) return;
    scene.ctrl.enqueue({ type: "resign", faction: this.local });
    scene.ctrl.locked = true;
    scene.ctrl.placing = null;
    scene.ctrl.clearSelection();
    this.resignAt = this.world.tick;
    this.resignLeave = leave;
    this.pump();
  }

  /** "Leave (no result)": the end goes out for 2 s, the end screen says so, and it counts as abandoned. */
  private leave(): void {
    if (this.aborted || this.exiting) return;
    this.session.leave("left");
    this.abort("lost");
  }

  /** The pause menu's ways out besides Resign. */
  private exits(): { resignAndLeave: boolean; leave: boolean } {
    const link = this.session.status().link;
    const s = this.lastStall;
    return {
      resignAndLeave: link.sinceRx <= PEER_HEARD_MS,
      leave: (s !== null && (s.kind === "lost" || s.kind === "offline" || s.kind === "gone" || s.ms >= LEAVE_ANY_MS)) || link.sinceRx > SIGNAL_LOST_MS
    };
  }

  /** Save battle: the record as a .json download. */
  private save(): void {
    const doc = this.env.document;
    if (doc) downloadRecord(this.record(), doc);
  }

  // ------------------------------------------------------------ the end ---

  /** End with no result: count it, drop the orders in flight, and the scene's end screen. */
  private abort(reason: AbortReason): void {
    if (this.aborted) return;
    this.aborted = reason;
    this.settle(reason === "desync" ? "noContest" : "abandoned");
    this.scene?.ctrl.dropInFlight();
    this.scene?.abort(reason, reason === "desync" ? this.debugInfo() : undefined);
  }

  /**
   * Count the match once (never on a practice link), but for two moves: the
   * stand-in abandoned counted when the page went hidden mid-match gives way
   * to the match's own end; and a result counted at the decision that the
   * worlds then turn out to contradict (the end check, the friend's end = 2,
   * or its end report arriving while Menu or Rematch waits) is no contest,
   * as the end screen then says. Each moves over in the record.
   */
  private settle(o: DuelOutcome): void {
    if (this.settled === null) {
      this.settled = o;
      if (!this.practice) this.tally = addOutcome(o, this.env.local, this.recordKey);
      return;
    }
    if (this.standIn) {
      this.standIn = false;
      if (o !== this.settled && !this.practice) this.tally = moveOutcome(this.settled, o, this.env.local, this.recordKey);
      this.settled = o;
      return;
    }
    const decided = this.settled === "win" || this.settled === "loss" || this.settled === "draw";
    if (o !== "noContest" || !decided) return;
    if (!this.practice) this.tally = moveOutcome(this.settled, o, this.env.local, this.recordKey);
    this.settled = o;
  }

  /** Where the win/loss record lives. */
  private get recordKey(): string {
    return ONLINE_RECORD_KEY;
  }

  /** The outcome as the lockstep has it: out of sync, else decided; null while neither. */
  private currentOutcome(): DuelOutcome | null {
    const st = this.session.lockstep?.status();
    if (st?.desync) return "noContest";
    return st?.decided ? outcomeOf(st.decided.winner, this.local) : null;
  }

  /** The outcome as it stands, for a record not yet written (leaving): as the lockstep has it, else abandoned. */
  private pendingOutcome(): DuelOutcome {
    return this.currentOutcome() ?? "abandoned";
  }

  /** Menu or Rematch: the end goes out (closable, or EXIT_WAIT_MS at most), then onExit and reload. */
  private exit(to: "menu" | "rematch"): void {
    if (this.exiting || this.closed) return;
    this.exiting = { to, at: this.session.transport.now() };
    this.session.leave("left");
    this.pump();
  }

  private finish(to: "menu" | "rematch"): void {
    this.settle(this.pendingOutcome());
    if (to === "rematch") {
      const r = this.result;
      writeRematch(
        {
          role: r.role, hostSide: OTHER[r.config.hostSide], mapId: r.mapId, mutators: r.config.mutators.slice(),
          // (the nations follow the phones, as the roles do: the sides swap)
          ...(r.setup.nations?.[r.local] ? { nation: r.setup.nations[r.local]! } : {}),
          ...(this.online ? { online: { code: this.online.code, key: this.online.key } } : {})
        },
        this.env.session
      );
    }
    this.close();
    this.callExit();
    this.env.reload();
  }

  /**
   * The page went hidden (the player switched away, or is closing the
   * browser: a phone fires no pagehide when it closes or kills it from the
   * background). A match not counted yet counts now: as the lockstep has it,
   * else abandoned until the match's own end, should the page come back,
   * moves it over. Never on a practice link (it keeps no record).
   */
  private wentHidden(): void {
    if (this.practice || this.settled !== null) return;
    const now = this.currentOutcome();
    this.settle(now ?? "abandoned");
    this.standIn = now === null;
  }

  /** The page is going (a reload or navigation that isn't ours): count the match and let the lobby let its link go. */
  private pageGone(): void {
    if (this.exited) return;
    this.settle(this.pendingOutcome());
    this.close();
    this.callExit();
  }

  private callExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.onExit();
  }

  /** Stop pumping and close the session (the link). Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.env.clearInterval(this.timer);
    if (this.raf !== null) this.env.cancelAnimationFrame(this.raf);
    for (const f of this.teardown.splice(0)) f();
    this.ui?.destroy();
    this.ui = null;
    this.session.close();
  }

  // ------------------------------------------------------------ reading ---

  /** The win/loss outcome counted for this match (null: not yet; the stand-in a hidden page counted isn't one). */
  get outcome(): DuelOutcome | null {
    return this.standIn ? null : this.settled;
  }

  /** How the match ended with no result (null: it didn't). */
  get abortReason(): AbortReason | null {
    return this.aborted;
  }

  /** The turns as stepped so far: [tick, side, commands], blue's entry before red's on a tick. */
  turnLog(): [number, Faction, Command[]][] {
    return this.turns.slice();
  }

  /** A practice link's hash trail after each tick stepped from `from` on, [tick, trail] (none on a sound link). */
  trails(from = 0): [number, number][] {
    const out: [number, number][] = [];
    const log = this.trailLog ?? [];
    for (let t = Math.max(0, from); t < log.length; t++) if (log[t] !== undefined) out.push([t, log[t]!]);
    return out;
  }

  /** The match as a battle record (Save battle): it replays exactly in the battle viewer. */
  record(): BattleRecord {
    const r = this.result;
    const w = this.world;
    const other = r.role === "host" ? "guest" : "host";
    const seats = { [r.local]: r.role, [OTHER[r.local]]: other } as Record<Faction, "host" | "guest">;
    // (the world's own resigned: null when both sides resigned, unset otherwise)
    const end = duelEnd(w.tick, w.winner ?? null, w.resigned);
    return battleRecord({ setup: r.setup, seats, via: this.practice ? "practice-duel" : "online-duel", turns: this.turns, hashes: this.hashes, tick: w.tick, end, sim: BUILD_SIM, created: this.created });
  }

  /** Kept in the Archives once decided (GameScene keepMatch): the record Save battle downloads; none for a match with no result. */
  saveable(): BattleRecord | null {
    return this.world.winner && !this.aborted ? this.record() : null;
  }

    /** "Copy debug info" after a desync. */
  debugInfo(): string {
    const r = this.result;
    const ls = this.session.lockstep;
    return JSON.stringify({
      build: this.session.pairing.build,
      sim: BUILD_SIM,
      role: r.role,
      local: r.local,
      config: r.config,
      nonces: { host: r.hostNonce, guest: r.guestNonce },
      delay: r.delay,
      plan: r.plan,
      tick: this.world.tick,
      trails: ls?.debug() ?? null,
      desync: ls?.status().desyncReason ?? null,
      turns: this.turns
    });
  }

  /** The report's Duel block (read while the report is up; public for tests). */
  reportView(): DuelReportView {
    const st = this.session.status();
    const ls = st.lockstep;
    const check = ls?.endCheck;
    const sync: DuelReportView["sync"] =
      this.aborted ?? (ls?.desync || check === "mismatch" ? "desync" : check === "ok" || check === "unverified" ? check : "pending");
    // (not counted yet: the record as it will be)
    const now = this.currentOutcome();
    const tally = this.tally ?? (now ? withOutcome(readTally(this.env.local, this.recordKey), now) : readTally(this.env.local, this.recordKey));
    return {
      record: this.practice ? null : tallyLine(tally),
      sync,
      // (the link still brings the end check and the friend's rematch; not once this phone has left)
      // (a lobby frame after the friend's game frames: its page reloaded into the lobby)
      friendInLobby: !!ls && ls.peerInLobby && ls.framesIn > 0 && !this.exiting,
      link: { good: st.link.rxOk, bad: st.link.rxBad, stallMs: ls?.stallMs ?? 0, orders: ls?.orderWait ?? null }
    };
  }
}
