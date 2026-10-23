/**
 * Battle awareness and tempo, wired into the scene: game speed (chip, hold
 * the clock, '.' key), "enemy inbound" warnings, off-screen hotspot arrows
 * with a camera glide, the ⚡ jump button and the battle meter. The rules are
 * in ./awareness (engine-free, tested); the widgets in ../ui/awareness.
 */
import { UNITS } from "../sim/balance";
import type { Faction, FxEvent, Unit, World } from "../sim/types";
import { sfx } from "./audio";
import type { CameraRig } from "./three/camera";
import { announce } from "./announce";
import type { Announcer } from "./announcer";
import {
  AWARE,
  BattleMeter,
  GameSpeed,
  HeatMap,
  InboundWatch,
  SPEED_KEY,
  TempoGuard,
  edgePoint,
  mergeHotspots,
  placeOnEdge,
  tallyView,
  type Hotspot,
  type InboundWarning,
  type Rect,
  type TempoDrop
} from "./awareness";
import type { Hud } from "../ui/hud";
import { MARKER, mountAwareness, type ArrowSpec, type AwarenessUi } from "../ui/awareness";
import { tr } from "../lang";

export interface AwarenessHooks {
  rig: CameraRig;
  /** The battlefield canvas (touching it cancels a glide). */
  canvas: HTMLElement;
  world: World;
  player: Faction;
  spectator: boolean;
  hud: Hud;
  radio: Announcer;
  /** Can the local player see this tile point (fog, or fog switched off)? */
  sees(x: number, y: number): boolean;
  /** …and this enemy unit itself (a Sniper Team hidden in the woods is not seen)? Default: yes. */
  seesUnit?(u: Unit): boolean;
  /** A marker flash where the camera lands (tiles). */
  pulse?(x: number, y: number, color: number): void;
  /** The HQ-kill cinematic owns the camera: no glides, jumps or edge arrows meanwhile. */
  cinematic?(): boolean;
  /**
   * The game runs at 1× and nobody may change it (a sound duel: both phones
   * play at one speed). No speed chip or hold-to-fast-forward, the stored
   * speed is ignored, and nothing drops the speed: there is nothing to drop.
   */
  fixedSpeed?: boolean;
  /** No "enemy inbound" warnings (the Instruction stages its own enemies and says so itself). */
  calm?: boolean;
  /** A glide (an arrow, ⚡, a squad chip) took the camera: the AI vs AI director stands aside. */
  took?(): void;
}

/** Camera glide time for arrow / jump taps, ms. */
const GLIDE_MS = 350;
/** Hotspots are recomputed this often (ms of real time). */
const SPOT_MS = 100;

const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

export class Awareness {
  readonly speed: GameSpeed;
  readonly heat: HeatMap;
  readonly inbound: InboundWatch;
  private tempo: TempoGuard;
  /** The last automatic drop to 1× (sim time), so presenters can fold their line into its note. */
  private dropped: { cause: TempoDrop["cause"]; t: number } | null = null;
  private meter = new BattleMeter();
  private ui: AwarenessUi;
  private spots: Hotspot[] = [];
  private spotClock = SPOT_MS;
  private meterClock = SPOT_MS;
  private tally: ReturnType<typeof tallyView> | null = null;
  private lastShotInView = -Infinity;
  private simT = 0;
  private glide: { x0: number; y0: number; x1: number; y1: number; t: number } | null = null;
  private jumpIdx = -1;
  private lastJumpAt = -Infinity;
  private lastView = { x: 0, y: 0 };
  private viewJumped = false;
  private offPointer: () => void;

  constructor(private h: AwarenessHooks) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(SPEED_KEY);
    } catch {
      /* storage blocked: 1× */
    }
    this.speed = new GameSpeed(h.spectator, h.fixedSpeed ? null : raw);
    this.heat = new HeatMap({ world: h.world, player: h.player, spectator: h.spectator });
    this.inbound = new InboundWatch({ world: h.world, player: h.player });
    this.tempo = new TempoGuard({ world: h.world, player: h.player });
    this.ui = mountAwareness(document.getElementById("hud")!, {
      spectator: h.spectator,
      fixedSpeed: !!h.fixedSpeed,
      onCycleSpeed: () => this.cycleSpeed(),
      onHold: (held) => {
        if (h.fixedSpeed) return;
        this.speed.held = held;
        this.syncSpeed();
      },
      onArrow: (key) => {
        const s = this.spots.find((p) => p.key === key);
        if (s) this.goTo(s);
      },
      onJump: () => this.jump()
    });
    // touching the battlefield cancels a glide (the player takes the camera)
    const stop = () => (this.glide = null);
    h.canvas.addEventListener("pointerdown", stop);
    this.offPointer = () => h.canvas.removeEventListener("pointerdown", stop);
    this.syncSpeed();
  }

  /** The sim speed multiplier right now. */
  get value(): number {
    return this.speed.value;
  }

  cycleSpeed(): void {
    if (this.h.fixedSpeed) return;
    this.speed.cycle();
    try {
      localStorage.setItem(SPEED_KEY, this.speed.serialize());
    } catch {
      /* ignore */
    }
    sfx.play("click", 0.5);
    this.syncSpeed();
  }

  private syncSpeed(): void {
    this.ui.setSpeed(this.speed.value, this.speed.base, this.speed.held);
    // battle sounds space out at speed so 2× isn't twice the din
    sfx.setTempo(this.speed.value);
  }

  // ------------------------------------------------------------ sim side --

  /** This tick's events at sim time `t` (call before the radio sees them). */
  events(fx: readonly FxEvent[], t: number): void {
    this.simT = t;
    this.heat.events(fx, t);
    const play = this.ui.layout().play;
    for (const ev of fx)
      if (ev.type === "shot") {
        if (t - this.lastShotInView < 0.2) break;
        const a = this.toScreen(ev.x, ev.y);
        const b = this.toScreen(ev.tx, ev.ty);
        // (a Goliath firing from the fog is still seen firing: it can't hide)
        const src = this.h.world.units.get(ev.sourceId);
        const always = !!src && !!UNITS[src.kind].alwaysVisible;
        if ((inside(play, a.x, a.y) && (always || this.h.sees(ev.x, ev.y))) || (inside(play, b.x, b.y) && this.h.sees(ev.tx, ev.ty)))
          this.lastShotInView = t;
      }
    if (this.h.spectator || this.h.calm) return;
    const warnings = this.inbound.events(fx, t);
    // tempo safety: something needs the player's hands, so back to 1× (never off it at a fixed speed)
    const drop = this.h.fixedSpeed ? null : this.tempo.check(fx, t, warnings, this.speed.value > 1);
    if (drop) this.slowDown(drop, t);
    for (const wn of warnings) this.warn(wn, drop?.cause === "inbound");
  }

  /**
   * Present an inbound warning on one channel: a banner for the first raid of
   * its kind, later ones as a ticker line + radio — but nothing extra while an
   * inbound banner is still up or waiting (that banner already says it).
   * Always: the siren and a minimap pulse.
   */
  private warn(wn: InboundWarning, slowed: boolean): void {
    if (!wn.loud) return; // inside the global gap: the arrow alone
    const h = this.h;
    h.radio.callouts.inbound(wn.domain, wn.t);
    if (wn.first)
      announce({
        key: `inbound-${wn.domain}`, text: wn.short, sub: tr(`Contre : ${wn.advice}${slowed ? " · vitesse 1×" : ""}`, `Counters: ${wn.advice}${slowed ? " · speed 1×" : ""}`), tone: "bad", priority: 1,
        x: wn.x, y: wn.y, say: wn.text
      });
    else if (!h.hud.bannerUp("inbound-")) {
      h.hud.alert(`${slowed ? tr("Vitesse 1× — ", "Speed 1× — ") : ""}${wn.text} — ${wn.advice}`, wn.x, wn.y);
      h.radio.push({ key: "inbound", text: wn.text, priority: 1, tone: "bad", x: wn.x, y: wn.y, caption: false });
    }
    sfx.play("inbound", 0.85);
    h.hud.ping(wn.x, wn.y, "inbound");
  }

  /** Drop to 1× (the chosen speed stays stored for the next match) and say why, once. */
  private slowDown(d: TempoDrop, t: number): void {
    this.speed.base = 1;
    this.speed.held = false;
    this.ui.cancelHold();
    this.syncSpeed();
    this.ui.flashSpeed();
    this.dropped = { cause: d.cause, t };
    // a raid's warning line carries the note itself (one line per event)
    if (d.cause !== "inbound") this.h.hud.notice(tr(`Vitesse 1× — ${d.note}`, `Speed 1× — ${d.note}`), "bad", d.x, d.y);
  }

  /** Did the game just drop to 1× for this cause (this tick)? Its note already tells the player. */
  slowedFor(cause: TempoDrop["cause"]): boolean {
    return !!this.dropped && this.dropped.cause === cause && this.dropped.t === this.simT;
  }

  // --------------------------------------------------------- render side --

  /**
   * World tiles → CSS px on screen (current camera, no one-frame lag). A point
   * behind the camera (far south of it) comes back far below the screen, in its
   * direction from the arrows' centre.
   */
  private toScreen(x: number, y: number): { x: number; y: number } {
    const m = this.ui.layout().markers;
    return this.h.rig.toward(x, y, (m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2);
  }

  /** Middle of the visible battlefield (tiles), clear of the HUD. */
  viewCentre(): { x: number; y: number } {
    const c = this.playCentre();
    return this.toWorld(c.x, c.y);
  }

  /** Middle of the visible battlefield on screen (CSS px). */
  playCentre(): { x: number; y: number } {
    const p = this.ui.layout().play;
    return { x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2 };
  }

  /** Is tile point (x, y) at least `margin` CSS px inside the visible battlefield? */
  inPlay(x: number, y: number, margin = 0): boolean {
    const p = this.ui.layout().play;
    const s = this.toScreen(x, y);
    return s.x >= p.x0 + margin && s.x <= p.x1 - margin && s.y >= p.y0 + margin && s.y <= p.y1 - margin;
  }

  /** Glide the camera so (x, y) sits in the middle of the visible battlefield. */
  glideTo(x: number, y: number): void {
    if (this.h.cinematic?.()) return;
    this.h.took?.();
    const p = this.ui.layout().play;
    const to = this.h.rig.targetFor(x, y, (p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2);
    const rig = this.h.rig;
    this.glide = { x0: rig.x, y0: rig.y, x1: to.x, y1: to.y, t: 0 };
  }

  private goTo(s: Hotspot): void {
    if (this.h.cinematic?.()) return;
    this.glideTo(s.x, s.y);
    sfx.play("click", 0.5);
    const col = s.kind === "attack" || s.kind === "fight" ? 0xffc04a : 0xff5a4a;
    this.h.pulse?.(s.x, s.y, col);
  }

  /** ⚡: cycle through the hotspots, most urgent first. */
  jump(): void {
    if (this.h.cinematic?.()) return;
    const list = this.spots;
    if (list.length === 0) {
      this.ui.jumpNothing();
      return;
    }
    const now = performance.now();
    this.jumpIdx = now - this.lastJumpAt < 4000 ? (this.jumpIdx + 1) % list.length : 0;
    this.lastJumpAt = now;
    // skip one we're already looking at
    const p = this.ui.layout().play;
    const c = { x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2 };
    for (let i = 0; i < list.length; i++) {
      const s = list[(this.jumpIdx + i) % list.length]!;
      const q = this.toScreen(s.x, s.y);
      if (list.length === 1 || Math.hypot(q.x - c.x, q.y - c.y) > 60) {
        this.jumpIdx = (this.jumpIdx + i) % list.length;
        this.goTo(s);
        return;
      }
    }
    this.goTo(list[this.jumpIdx]!);
  }

  /** Every frame, after the HUD update. */
  update(deltaMs: number, paused: boolean): void {
    const rig = this.h.rig;
    const cinematic = !!this.h.cinematic?.();
    if (cinematic) this.glide = null; // (one already running lets go of the camera)
    if (this.glide) {
      const g = this.glide;
      g.t = Math.min(GLIDE_MS, g.t + deltaMs);
      const k = 1 - Math.pow(1 - g.t / GLIDE_MS, 3);
      rig.x = g.x0 + (g.x1 - g.x0) * k;
      rig.y = g.y0 + (g.y1 - g.y0) * k;
      rig.apply();
      if (g.t >= GLIDE_MS) this.glide = null;
    }
    const L = this.ui.layout();
    this.spotClock += deltaMs;
    if (this.spotClock >= SPOT_MS || cinematic) {
      this.spotClock = 0;
      // (the cinematic clears the edge arrows and idles ⚡)
      this.spots = cinematic ? [] : mergeHotspots(this.heat.hotspots(), this.h.spectator ? [] : this.inbound.hotspots(this.simT));
      this.ui.setJump(this.spots.length, this.spots.some((s) => s.kind === "defend" || s.kind === "inbound"));
    }
    this.ui.setArrows(this.arrows(L));

    // battle meter: tally the view every 100 ms, ease every frame
    this.meterClock += deltaMs;
    if (this.meterClock >= SPOT_MS || !this.tally) {
      this.meterClock = 0;
      const vc = this.toWorld((L.play.x0 + L.play.x1) / 2, (L.play.y0 + L.play.y1) / 2);
      this.viewJumped = this.viewJumped || Math.hypot(vc.x - this.lastView.x, vc.y - this.lastView.y) > 3;
      this.lastView = vc;
      const inView = (x: number, y: number) => {
        const s = this.toScreen(x, y);
        return inside(L.play, s.x, s.y) && s.y > L.markers.y0 - MARKER.size / 2;
      };
      // (tallyView itself counts a kind that is always visible, the enemy Goliath, fog or not)
      this.tally = tallyView(
        this.h.world, this.h.spectator ? "blue" : this.h.player, inView, (x, y) => this.h.sees(x, y),
        (u) => this.h.seesUnit?.(u) ?? true
      );
    }
    if (!paused) {
      const m = this.meter.update(this.tally, this.lastShotInView, this.simT, deltaMs, this.viewJumped);
      this.viewJumped = false;
      this.ui.setMeter(m.shown, m.share);
      if (m.turning) this.ui.turning(m.turning);
    }
  }

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return this.h.rig.ground(sx, sy);
  }

  /** Edge arrows for the off-screen hotspots: capped, merged by direction, clear of the HUD. */
  private arrows(L: ReturnType<AwarenessUi["layout"]>): ArrowSpec[] {
    const out: ArrowSpec[] = [];
    const dirs: number[] = [];
    const avoid = [...L.avoid];
    // a hotspot counts as on screen inside the battlefield, clear of the top HUD band
    const vis: Rect = { x0: L.play.x0, y0: L.markers.y0 - MARKER.size / 2, x1: L.play.x1, y1: L.play.y1 };
    const c = { x: (L.markers.x0 + L.markers.x1) / 2, y: (L.markers.y0 + L.markers.y1) / 2 };
    for (const s of this.spots) {
      if (out.length >= AWARE.maxArrows) break;
      const q = this.toScreen(s.x, s.y);
      if (inside(vis, q.x, q.y)) continue;
      const dir = Math.atan2(q.y - c.y, q.x - c.x);
      // merge: one arrow per direction
      if (dirs.some((d) => Math.abs(Math.atan2(Math.sin(d - dir), Math.cos(d - dir))) < 0.32)) continue;
      const e = edgePoint(L.markers, q.x, q.y);
      const p = placeOnEdge(L.markers, e, MARKER.size + 4, avoid, 200);
      if (!p) continue;
      dirs.push(dir);
      avoid.push({ x0: p.x - MARKER.size / 2 - 4, y0: p.y - MARKER.size / 2 - 4, x1: p.x + MARKER.size / 2 + 4, y1: p.y + MARKER.size / 2 + 4 });
      out.push({
        key: s.key, kind: s.kind, label: s.label, x: p.x, y: p.y,
        angle: Math.atan2(q.y - p.y, q.x - p.x),
        scale: 1 + Math.min(0.25, s.heat / 24)
      });
    }
    return out;
  }

  /** Hotspots right now (debug/tests). */
  get hotspots(): readonly Hotspot[] {
    return this.spots;
  }

  destroy(): void {
    this.offPointer();
    sfx.setTempo(1);
    this.ui.destroy();
  }
}
