/**
 * The cinematic camera for AI vs AI: a director that watches the battle's
 * events and decides where to look. Fights, kills and strikes heat up a
 * coarse grid of "interest" that cools off over time; the director holds
 * on the hottest action (following it as it moves), switches when somewhere
 * else gets clearly more exciting, tours both armies while it's quiet, and
 * now and then cuts straight to a surprise (a calldown, a Goliath rolling
 * out, a first strike on an HQ) when it happens far off screen. The camera
 * itself springs smoothly toward the shot, drifts a little so it never sits
 * dead still, and breathes its zoom in and out.
 *
 * Engine-free (tested in tests/director.test.ts): the scene feeds it events
 * and the current view, and puts the camera where it says.
 */
import { BUILDINGS, UNITS } from "../sim/balance";
import type { Faction, FxEvent, World } from "../sim/types";

/** localStorage: "0" when the player switched the cinematic camera off (on by default). */
export const CINE_KEY = "panache.cinecam";

export const CINE = {
  /** Interest is bucketed into square cells this many tiles wide. */
  cell: 6,
  /** Interest left after one sim second. */
  decayPerS: 0.8,
  /** Interest added per event. */
  heat: { shot: 0.04, hit: 0.12, hitBuilding: 0.2, hitHq: 0.45, death: 0.35, deathPer100: 0.1 },
  /** A subject colder than this is no fight at all: tour the armies instead. */
  warm: 0.6,
  /** Re-pick the subject this often (real seconds). */
  evalS: 0.5,
  /** Stay on a subject at least this long (real seconds) before an ordinary switch… */
  holdS: 5,
  /** …and only for one this much hotter. */
  switchRatio: 1.7,
  /** Subjects closer than this (tiles) are the same one. */
  sameTiles: 10,
  /** Quiet: look at one side's army this long, then the other's (real seconds). */
  tourS: 9,
  /** A surprise at least this big takes the camera at once (see SURPRISE). */
  surpriseMin: 3,
  /** …by cutting to it when it's farther than this (tiles) from the view, else gliding. */
  cutTiles: 24,
  /** At most one cut per this long (real seconds), and no surprise switch inside holdAfterSurpriseS. */
  cutCooldownS: 12,
  holdAfterSurpriseS: 4,
  /** A surprise's push-in (× zoom), easing out over this long (real seconds). */
  pushIn: 1.25,
  pushS: 4,
  /** Zoom (CSS px per tile): a tight fight, the default, a wide one / the tour. */
  zoom: { close: 58, mid: 42, wide: 30 },
  /** Zoom breathing: ± this fraction, one cycle per this long (s). */
  breathe: 0.07,
  breatheS: 23,
  /** The idle drift around the subject (tiles at the mid zoom). */
  drift: 1.4,
  /** Spring stiffness (rad/s) for the look-at point and for the zoom. */
  panOmega: 1.5,
  zoomOmega: 0.9,
  /** After the player pans or zooms, the director waits this long (real seconds) before taking the camera back. */
  handBackS: 8
} as const;

export interface Shot {
  /** The point to centre in the visible battlefield (tiles). */
  x: number;
  y: number;
  /** CSS px per tile. */
  zoom: number;
  /** A hard cut this frame (no glide): the scene may flash the spot. */
  cut: boolean;
}

export interface CameraView {
  x: number;
  y: number;
  zoom: number;
}

interface Cell {
  sx: number;
  sy: number;
  /** Σ w·(x² + y²), for the spread of the action. */
  sq: number;
  w: number;
}

/** A hot area: heat-weighted centre, total heat, and how spread out it is (tiles). */
export interface Subject {
  x: number;
  y: number;
  heat: number;
  spread: number;
}

/** How surprising an event is (≥ CINE.surpriseMin takes the camera), or 0. */
export function surprise(ev: FxEvent, w: World, hqHitAt: Partial<Record<Faction, number>>, t: number): number {
  switch (ev.type) {
    case "calldown":
      return 5;
    case "goliathRollout":
      return 5;
    case "uplinkFlip":
      return 3;
    case "goliathWeapon":
      return ev.state === "offline" ? 3 : 0;
    case "disembark":
      return ev.bailout ? 2 : 1;
    case "crateLanded":
      return 1;
    case "hit": {
      if (!ev.building || w.buildings.get(ev.id)?.kind !== "hq") return 0;
      // the first shot on an HQ after a long quiet is news; the rest of the siege isn't
      const last = hqHitAt[ev.faction];
      hqHitAt[ev.faction] = t;
      return last === undefined || t - last > 30 ? 4 : 0;
    }
    case "death": {
      if (ev.buildingKind === "hq") return 0; // (the finale has it)
      if (ev.unitKind === "goliath") return 5;
      if (ev.rank >= 2) return 3; // a veteran falls
      return ev.value >= 350 ? 3 : 0;
    }
    default:
      return 0;
  }
}

/** Critically damped spring step (implicit, stable at any dt). */
function spring(x: number, v: number, to: number, omega: number, dt: number): [number, number] {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const inv = 1 / (f + hhoo);
  return [(f * x + dt * v + hhoo * to) * inv, (v + hoo * (to - x)) * inv];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Zoom for a subject: close in on a tight scrap, back off for a sprawling one. */
export function zoomForSpread(spread: number): number {
  const z = CINE.zoom.mid * Math.pow(6 / (spread + 3), 0.6);
  return clamp(z, CINE.zoom.wide, CINE.zoom.close);
}

export class Director {
  private cells = new Map<number, Cell>();
  private simT = 0;
  /** Real seconds since the director started. */
  private t = 0;
  private evalClock = Infinity;
  /** The subject being shown, when it's a fight (null: touring the armies). */
  private subject: Subject | null = null;
  private since = -Infinity;
  private tourSide: Faction = "blue";
  private tourSince = -Infinity;
  /** Where the shot is aimed (tiles) and how close. */
  private aim: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: CINE.zoom.mid };
  /** The camera's eased state: look-at point, log zoom, and their velocities. */
  private cam = { x: 0, y: 0, lz: Math.log(CINE.zoom.mid), vx: 0, vy: 0, vz: 0 };
  private seeded = false;
  private pending: { x: number; y: number; score: number } | null = null;
  private lastCut = -Infinity;
  private lastSurprise = -Infinity;
  private pushAt = -Infinity;
  private hqHitAt: Partial<Record<Faction, number>> = {};
  /** Real seconds left before the camera is handed back after the player took it. */
  private heldFor = 0;

  constructor(private world: World) {}

  /** This tick's events at sim time `t`. */
  events(fx: readonly FxEvent[], t: number): void {
    const dt = Math.max(0, t - this.simT);
    this.simT = t;
    if (dt > 0) this.decay(Math.pow(CINE.decayPerS, dt));
    const H = CINE.heat;
    for (const ev of fx) {
      if (ev.type === "shot") this.add(ev.tx, ev.ty, H.shot);
      else if (ev.type === "hit") {
        const hq = ev.building && this.world.buildings.get(ev.id)?.kind === "hq";
        this.add(ev.x, ev.y, hq ? H.hitHq : ev.building ? H.hitBuilding : H.hit);
      } else if (ev.type === "death") this.add(ev.x, ev.y, H.death + (H.deathPer100 * Math.min(ev.value, 600)) / 100);
      const s = surprise(ev, this.world, this.hqHitAt, t);
      if (s <= 0 || !("x" in ev)) continue;
      // a surprise is interesting in itself: it keeps the camera there once it arrives
      this.add(ev.x, ev.y, s * 0.3);
      if (s >= CINE.surpriseMin && (!this.pending || s > this.pending.score)) this.pending = { x: ev.x, y: ev.y, score: s };
    }
  }

  /** The player panned or zoomed: stand aside for a while. */
  hold(): void {
    this.heldFor = CINE.handBackS;
  }

  /** Is the player holding the camera right now? */
  get held(): boolean {
    return this.heldFor > 0;
  }

  /** Start easing from `view` (switched on, or handed back). */
  reset(view: CameraView): void {
    this.cam = { x: view.x, y: view.y, lz: Math.log(view.zoom), vx: 0, vy: 0, vz: 0 };
    this.aim = { x: view.x, y: view.y, zoom: view.zoom };
    this.seeded = true;
    this.heldFor = 0;
    this.evalClock = Infinity;
  }

  /**
   * Every frame (`dt` real seconds), with the camera as it is now: the shot
   * to show, or null while the player has the camera.
   */
  update(dt: number, view: CameraView): Shot | null {
    this.t += dt;
    if (this.heldFor > 0) {
      this.heldFor -= dt;
      if (this.heldFor > 0) {
        this.pending = null; // (what happened meanwhile is old news by the time it hands back)
        return null;
      }
      this.reset(view);
    }
    if (!this.seeded) this.reset(view);

    let cut = false;
    const p = this.pending;
    this.pending = null;
    // (one already in shot just keeps the camera there: its heat holds the subject)
    if (p && this.t - this.lastSurprise >= CINE.holdAfterSurpriseS && Math.hypot(p.x - this.aim.x, p.y - this.aim.y) >= CINE.sameTiles / 2) {
      this.lastSurprise = this.t;
      this.pushAt = this.t;
      this.subject = { x: p.x, y: p.y, heat: p.score, spread: 3 };
      this.since = this.t;
      this.aim = { x: p.x, y: p.y, zoom: CINE.zoom.mid };
      const far = Math.hypot(p.x - this.cam.x, p.y - this.cam.y) > CINE.cutTiles;
      if (far && this.t - this.lastCut >= CINE.cutCooldownS) {
        cut = true;
        this.lastCut = this.t;
        this.cam.x = p.x;
        this.cam.y = p.y;
        this.cam.vx = this.cam.vy = 0;
      }
      this.evalClock = 0;
    }

    this.evalClock += dt;
    if (this.evalClock >= CINE.evalS) {
      this.evalClock = 0;
      this.direct();
    }

    // ease toward the aim, with a slow drift so the camera never sits dead still
    const zoomK = CINE.zoom.mid / Math.exp(this.cam.lz);
    const dx = Math.sin(this.t * 0.37) * CINE.drift * zoomK;
    const dy = Math.cos(this.t * 0.27) * CINE.drift * 0.7 * zoomK;
    const c = this.cam;
    [c.x, c.vx] = spring(c.x, c.vx, this.aim.x + dx, CINE.panOmega, dt);
    [c.y, c.vy] = spring(c.y, c.vy, this.aim.y + dy, CINE.panOmega, dt);
    const push = this.t - this.pushAt < CINE.pushS ? 1 + (CINE.pushIn - 1) * (1 - (this.t - this.pushAt) / CINE.pushS) : 1;
    const breathe = 1 + CINE.breathe * Math.sin((this.t / CINE.breatheS) * Math.PI * 2);
    const z = clamp(this.aim.zoom * push * breathe, CINE.zoom.wide * 0.9, CINE.zoom.close * 1.3);
    [c.lz, c.vz] = spring(c.lz, c.vz, Math.log(z), CINE.zoomOmega, dt);
    if (cut) c.lz = Math.log(z);
    return { x: c.x, y: c.y, zoom: Math.exp(c.lz), cut };
  }

  /** The hottest areas right now, hottest first, at least CINE.sameTiles apart. */
  subjects(): Subject[] {
    const sums: Subject[] = [];
    for (const [key, c0] of this.cells) {
      if (c0.w < 0.05) continue;
      const cx = key % 4096;
      const cy = Math.floor(key / 4096);
      let sx = 0;
      let sy = 0;
      let sq = 0;
      let w = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const c = this.cells.get((cy + oy) * 4096 + cx + ox);
          if (!c) continue;
          sx += c.sx;
          sy += c.sy;
          sq += c.sq;
          w += c.w;
        }
      if (w <= 0) continue;
      const x = sx / w;
      const y = sy / w;
      const spread = Math.sqrt(Math.max(0, sq / w - x * x - y * y));
      sums.push({ x, y, heat: w, spread });
    }
    sums.sort((a, b) => b.heat - a.heat);
    const out: Subject[] = [];
    for (const s of sums) if (!out.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < CINE.sameTiles)) out.push(s);
    return out;
  }

  /** Pick (or keep) the subject and aim at it. */
  private direct(): void {
    const list = this.subjects();
    const best = list[0];
    const cur = this.subject;
    // the current subject, followed as the fight moves
    const mine = cur ? list.find((s) => Math.hypot(s.x - cur.x, s.y - cur.y) < CINE.sameTiles) ?? null : null;
    const held = this.t - this.since;
    let next: Subject | null = mine;
    if (best && best.heat >= CINE.warm) {
      if (!mine || mine.heat < CINE.warm * 0.5) next = held >= 2 || !mine ? best : mine;
      else if (best !== mine && held >= CINE.holdS && best.heat > mine.heat * CINE.switchRatio) next = best;
    } else if (mine && mine.heat < CINE.warm * 0.5) next = null;
    if (next && next.heat < CINE.warm * 0.3) next = null;
    if (next !== mine || !cur) this.since = this.t;
    this.subject = next;
    if (next) {
      this.aim = { x: next.x, y: next.y, zoom: zoomForSpread(next.spread) };
      return;
    }
    // quiet: tour the armies, one side then the other
    if (this.t - this.tourSince >= CINE.tourS) {
      this.tourSince = this.t;
      this.tourSide = this.tourSide === "blue" ? "red" : "blue";
    }
    const a = this.army(this.tourSide) ?? this.army(this.tourSide === "blue" ? "red" : "blue");
    if (a) this.aim = { x: a.x, y: a.y, zoom: CINE.zoom.wide + (CINE.zoom.mid - CINE.zoom.wide) * 0.35 };
  }

  /** The densest knot of `side`'s fighting units (its HQ when it has none out). */
  army(side: Faction): { x: number; y: number } | null {
    const C = CINE.cell * 2;
    const grid = new Map<number, { sx: number; sy: number; n: number }>();
    for (const u of this.world.units.values()) {
      // (a Goliath's guns are its own weapon systems, not a dps figure)
      if (u.faction !== side || (UNITS[u.kind].dps <= 0 && !u.goliath)) continue;
      const key = Math.floor(u.y / C) * 4096 + Math.floor(u.x / C);
      const g = grid.get(key) ?? { sx: 0, sy: 0, n: 0 };
      g.sx += u.x;
      g.sy += u.y;
      g.n++;
      grid.set(key, g);
    }
    let best: { sx: number; sy: number; n: number } | null = null;
    for (const g of grid.values()) if (!best || g.n > best.n) best = g;
    if (best) return { x: best.sx / best.n, y: best.sy / best.n };
    for (const b of this.world.buildings.values())
      if (b.faction === side && b.kind === "hq") return { x: b.tx + BUILDINGS.hq.size / 2, y: b.ty + BUILDINGS.hq.size / 2 };
    return null;
  }

  private add(x: number, y: number, heat: number): void {
    const C = CINE.cell;
    const key = Math.floor(y / C) * 4096 + Math.floor(x / C);
    let c = this.cells.get(key);
    if (!c) {
      c = { sx: 0, sy: 0, sq: 0, w: 0 };
      this.cells.set(key, c);
    }
    c.sx += x * heat;
    c.sy += y * heat;
    c.sq += (x * x + y * y) * heat;
    c.w += heat;
  }

  private decay(k: number): void {
    for (const [key, c] of this.cells) {
      c.sx *= k;
      c.sy *= k;
      c.sq *= k;
      c.w *= k;
      if (c.w < 0.01) this.cells.delete(key);
    }
  }
}
