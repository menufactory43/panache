import * as THREE from "three";
import { BUILDINGS, ECONOMY, TICK_RATE, UNITS } from "../../sim/balance";
import { isInfantry, squadAlive } from "../../sim/infantry";
import { liftedBy } from "../../sim/lift";
import { nationOf } from "../../sim/rules";
import type { Building, BuildingKind, Faction, FxEvent, Unit, UnitKind, WeaponFx, World } from "../../sim/types";
import { baySeats, RIDER_SCALE, SquadRig, type BotKind, type Footprint } from "../three/infantry";
import { lookalike } from "../three/belle/placeholders";
import { discMat, eliteUniform, setVariant, type Variant } from "../three/materials";
import { CRAWLER_LEGS, buildingDef, instance, unitDef, unitScale, type ModelDef, type ModelInstance } from "../three/models";
import { BELLE_EPOQUE } from "../three/theme";
import { AIR_H, HOVER_H, type P3, type View } from "../three/view";
import { Ease } from "../three/tween";
import type { Fx } from "./fx";
import { CARRY_CLEAR, GantryView, GoliathView, type GoliathHost } from "./goliath";
import type { GroundGfx } from "../three/ground-gfx";
import { FlashClock, JUICE } from "../juice";

interface UnitView {
  kind: "unit";
  m: ModelInstance;
  air: boolean;
  hover: boolean;
  face: number;
  aim: number;
  recoil: number;
  lastFired: number;
  phase: number;
  dustT: number;
  /** Next smokestack puff, ms (Belle Époque steam machines). */
  stackT?: number;
  /** Rendered ground position (tiles) and body position/height. */
  gx: number;
  gy: number;
  bh: number;
  /** Smoothed terrain pitch/roll and aircraft bank. */
  pitch: number;
  roll: number;
  bank: number;
  visible: boolean;
  variant: Variant;
  rank: number;
  /** Chevron pop-in (1 = settled). */
  chevronPop: number;
  /** Model height (bars and labels sit above it). */
  top: number;
  scale: number;
  /** Robot infantry: the squad's rig (its root is m.root and m.body). */
  squad: SquadRig | null;
  /** The Condor's bay, ramp and hover. */
  condor: CondorView | null;
  /** A Goliath's rig and everything it shows (render/goliath.ts; its root is m.root). */
  goliath: GoliathView | null;
  /** Sim position at the last sync (a squad's death blast is matched against it). */
  sx: number;
  sy: number;
  /** The Flak Crawler's walk: where its legs are in the stride, and how far they swing (0 standing, 1 walking). */
  gait?: { phase: number; amp: number };
}

/** The Flak Crawler's stride (models.ts CRAWLER_LEGS): ground covered per full step cycle (tiles), swing about the hip (rad), foot lift (model units). */
const LEG_CYCLE = 0.6;
const LEG_SWING = 0.32;
const LEG_LIFT = 0.07;

interface CondorView {
  /** Riders' group in the body, undoing the model scale (tiles). */
  bay: THREE.Group;
  /** A seated rig per squad aboard, by unit id, and the bench it sits on. */
  riders: Map<number, { rig: SquadRig; side: number }>;
  /** Ramp open 0–1; come down to the drop height 0–1; next downwash puff (ms). */
  ramp: number;
  low: number;
  washT: number;
  /** It just dropped its squads (or took one aboard): it holds low with the ramp down while they jump clear (ms). */
  hold: number;
  /** The bay lights spilling out of the open ramp onto the ground (a child of the root). */
  pool: THREE.Mesh;
  poolMat: THREE.MeshBasicMaterial;
  /** Climbed above its flying height (tiles) to carry a Goliath on its cables. */
  lift: number;
}

interface BuildingView {
  kind: "building";
  m: ModelInstance;
  bkind: BuildingKind;
  faction: Faction;
  face: number;
  recoil: number;
  lastFired: number;
  smokeT: number;
  size: number;
  /** Footprint's top-left tile. */
  tx: number;
  ty: number;
  cx: number;
  cy: number;
  base: number;
  visible: boolean;
  /** Can the local player see (part of) its footprint right now? Else it is drawn as last seen. */
  seen: boolean;
  /** Health ratio as last seen (live while seen): the fog of war hides the rest. */
  hp: number;
  variant: Variant;
  warmUntil: number;
  top: number;
  /** Roof heights over the middle of the footprint (see roofOf). */
  roof: Float32Array;
  /** A Gantry's build stages, crane and lights (render/goliath.ts). */
  gantry: GantryView | null;
}

type View3 = UnitView | BuildingView;

/** Shortest signed angle from a to b. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
/** The smokestacks' tops on the Belle Époque steam machines (model space): the Fardier's, the Creusot's pair, the Éole's little boiler. */
const STACKS: Partial<Record<UnitKind, [number, number, number][]>> = {
  harvester: [[0, 0.84, -0.3]],
  mastodon: [[0.12, 0.7, 0.39], [-0.12, 0.7, 0.39]],
  wasp: [[0, 0.16, -0.03]]
};
/** The Condor's ramp light on the ground (a soft disc). */
const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/** A vehicle's hull half-length and half-width on the ground (tiles, its model's bounds), plus a robot's girth. */
const hulls = new Map<UnitKind, [number, number]>();
function hullHalf(kind: UnitKind): [number, number] {
  let h = hulls.get(kind);
  if (!h) {
    const b = unitDef(kind, "blue").hull.boundingBox!;
    const s = unitScale(kind);
    h = [Math.max(-b.min.z, b.max.z) * s + 0.06, Math.max(-b.min.x, b.max.x) * s + 0.07];
    hulls.set(kind, h);
  }
  return h;
}
/**
 * A Condor hovering to drop or pick up sits this high over the ground (it
 * flies at AIR_H): its belly clears the robots standing under it.
 */
const CONDOR_LOW = 0.78;
/** An enemy Condor's bay, as we're shown it. */
const NO_RIDERS: readonly Unit[] = [];
/** A smoke puff's source point, refilled per puff (Fx reads it at once). */
const puffAt: P3 = { x: 0, y: 0, h: 0 };

/** Roof heights over a 3×3 grid across the middle half of each kind of building, found once per kind. */
const roofs = new Map<ModelDef, Float32Array>();
/** roofOf's sample points (three close together per grid point) and the highest surface over each. */
const roofX = new Float32Array(27);
const roofZ = new Float32Array(27);
const roofH = new Float32Array(27);
const roofMid = [0, 0, 0];

/**
 * Where smoke leaves a damaged building's roof: heights (above the model's
 * base) at a 3×3 grid spanning the middle half of its footprint — the top
 * surface of the model, hull and turret, over each point. Each is the median
 * of three nearby points, so a lone mast or antenna doesn't count as roof.
 * One pass over the triangles, well under a millisecond a kind: it runs the
 * first time each kind appears, maybe mid-match (a raycaster, with a hit
 * object per surface crossed, took up to ~20 ms, and several times that on
 * a phone).
 */
function roofOf(def: ModelDef, size: number): Float32Array {
  let r = roofs.get(def);
  if (r) return r;
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++)
      for (let k = 0; k < 3; k++) {
        const n = (j * 3 + i) * 3 + k;
        roofX[n] = ((i - 1) * size) / 4 + (k === 1 ? 0.12 : 0);
        roofZ[n] = ((j - 1) * size) / 4 + (k === 2 ? 0.12 : 0);
        roofH[n] = 0;
      }
  topsOf(def.hull, 0, 0, 0);
  if (def.turret) topsOf(def.turret, ...def.mount);
  r = new Float32Array(9);
  for (let n = 0; n < 9; n++) {
    for (let k = 0; k < 3; k++) roofMid[k] = roofH[n * 3 + k]!;
    roofMid.sort((a, b) => a - b);
    r[n] = roofMid[1]!;
  }
  roofs.set(def, r);
  return r;
}

/** Raise each of roofOf's sample points to the height of any triangle of `geo` (moved by ox, oy, oz) above it. */
function topsOf(geo: THREE.BufferGeometry, ox: number, oy: number, oz: number): void {
  const pos = geo.getAttribute("position");
  const index = geo.getIndex();
  const n = index ? index.count : pos.count;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = index ? index.getX(t) : t;
    const b = index ? index.getX(t + 1) : t + 1;
    const c = index ? index.getX(t + 2) : t + 2;
    const ax = pos.getX(a) + ox, az = pos.getZ(a) + oz;
    const bx = pos.getX(b) + ox, bz = pos.getZ(b) + oz;
    const cx = pos.getX(c) + ox, cz = pos.getZ(c) + oz;
    // (seen from above, edge-on walls cover nothing)
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx);
    const z0 = Math.min(az, bz, cz), z1 = Math.max(az, bz, cz);
    for (let s = 0; s < 27; s++) {
      const px = roofX[s]!;
      const pz = roofZ[s]!;
      if (px < x0 || px > x1 || pz < z0 || pz > z1) continue;
      const u = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d;
      const v = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const h = u * (pos.getY(a) + oy) + v * (pos.getY(b) + oy) + (1 - u - v) * (pos.getY(c) + oy);
      if (h > roofH[s]!) roofH[s] = h;
    }
  }
}

/**
 * Units and buildings as 3D models: hulls that turn and tilt over the
 * terrain, turrets that track their targets and kick on recoil, rotors that
 * spin, aircraft that bank into turns and bob at altitude, buildings that
 * rise out of the ground when placed and smoke when hurt. Hits flash the
 * model white (warm for buildings), elites shimmer gold.
 *
 * Robot infantry squads are rigs of walking robots (three/infantry.ts): they
 * march, raise their weapons to fire, lose a robot (it topples in sparks)
 * each time the squad's HP crosses a step, and leave no wreck — the last
 * ones fall where they stood; robots step aside out of vehicles' hulls. The
 * Condor comes down and drops its ramp to load or drop squads, with its
 * riders seated in the open bay; they step off the ramp and climb aboard by it.
 *
 * A Goliath is a posed rig with a view of its own (render/goliath.ts): it
 * walks, anchors, fights and topples there, and its Condors climb over it to
 * carry it. A Gantry shows its Goliath taking shape. The enemy always sees
 * both, so they are drawn clear of the fog and never left as remembered ghosts.
 */
export class EntityRenderer {
  private views = new Map<number, View3>();
  private sold = new Set<number>();
  private time = 0;
  private flashes = new FlashClock();
  /** Ids synced this frame, and the chevron record ranked() hands out: reused, no per-frame garbage. */
  private seen = new Set<number>();
  private rankRec = { x: 0, y: 0, h: 0, rank: 0, pop: 1 };
  /** Squads that climbed into a Condor (unit → carrier) or were dropped out of one, since the last sync. */
  private boarded = new Map<number, number>();
  private dropped = new Map<number, { carrierId: number; x: number; y: number; bailout: boolean }>();
  /** Condors with a squad coming aboard close by (they come down and open up). */
  private boarders = new Set<number>();
  /** Squads off the field still on show: robots toppling (wiped out) or hopping aboard. */
  private leaving: { rig: SquadRig; alive: number }[] = [];
  /** Goliaths destroyed, still on show as they topple and sink away. */
  private toppling: GoliathView[] = [];
  /** Robot Love: the two Goliaths in love and where they meet (they walk to meet once their views are up). */
  private lovers: { ids: readonly number[]; x: number; y: number } | null = null;
  /** The world tick at the last sync (a replay seek back rewinds it). */
  private lastTick = 0;
  /** Goliaths that just walked off a Gantry since the last sync (unit → its Gantry). */
  private rolledOut = new Map<number, number>();
  private host: GoliathHost;
  private snipeTurn = 0;
  /** This frame's fraction of a tick (sim timers run at world.tick - 1 + alpha). */
  private alpha = 1;
  /** Vehicle footprints near the squad being updated (reused). */
  private avoid: Footprint[] = [];
  /** Squads on show this frame, x, y pairs: the trees thin over them (reused). */
  private inWoods: number[] = [];
  private groundFn = (x: number, z: number) => this.v.terrain.groundAt(x, z);
  readonly group = new THREE.Group();

  constructor(
    private v: View,
    private world: World,
    private fx: Fx,
    /** Is world tile position visible to the local player? */
    private visibleAt: (x: number, y: number) => boolean,
    /** Should this enemy building be drawn (seen now or remembered)? */
    private buildingShown: (b: Building) => boolean,
    private isFriendly: (f: string) => boolean,
    /**
     * Should this enemy unit be drawn? Default: its tile is visible. (A Sniper
     * Team hidden in woods isn't, though its tile is: wire the sim's unitSeenBy.)
     */
    private unitShown: ((u: Unit) => boolean) | null = null
  ) {
    v.scene.add(this.group);
    fx.squads = {
      shooters: (id, wfx) => this.shooters(id, wfx),
      fire: (id, i) => this.squadFire(id, i),
      diedAt: (x, y) => this.squadDiedAt(x, y)
    };
    this.host = {
      v, world, fx, group: this.group,
      unitPose: (id) => {
        const o = this.views.get(id);
        return o?.kind === "unit" ? o : null;
      }
    };
    // (a Goliath's mortar shells leave its shoulder pods)
    fx.shellFrom = (id) => {
      const o = this.views.get(id);
      return o?.kind === "unit" && o.goliath && o.visible ? o.goliath.shellFrom() : null;
    };
  }

  /** Decide which enemy units are drawn (see the constructor's `unitShown`); null restores the tile check. */
  setUnitShown(fn: ((u: Unit) => boolean) | null): void {
    this.unitShown = fn;
  }

  markSold(id: number): void {
    this.sold.add(id);
  }

  // ------------------------------------------------------------- queries ---

  /** Rendered position of an entity: body (x, y, h) and ground (gx, gy). */
  pos(id: number): { x: number; y: number; h: number; gx: number; gy: number; top: number } | null {
    const v = this.views.get(id);
    if (!v) return null;
    if (v.kind === "unit") return { x: v.gx, y: v.gy, h: v.bh, gx: v.gx, gy: v.gy, top: v.bh + v.top };
    return { x: v.cx, y: v.cy, h: v.base + 0.4, gx: v.cx, gy: v.cy, top: v.base + v.top };
  }

  /** Last rendered pose of a unit (wrecks start from it). */
  pose(id: number): { gx: number; gy: number; bh: number; face: number; aim: number; visible: boolean } | null {
    const v = this.views.get(id);
    if (!v || v.kind !== "unit") return null;
    return { gx: v.gx, gy: v.gy, bh: v.bh, face: v.face, aim: v.aim, visible: v.visible };
  }

  isShown(id: number): boolean {
    return this.views.get(id)?.visible ?? false;
  }

  /**
   * A building's health ratio while the player can see it; null while it is
   * only remembered (its look keeps the health last seen, but no live bar:
   * one that vanished when it died out of sight would give that away).
   */
  shownHp(id: number): number | null {
    const v = this.views.get(id);
    return v?.kind === "building" && v.visible && v.seen ? v.hp : null;
  }

  /**
   * Where a shot leaves the shooter's barrel; null if it isn't on show (out of
   * sight, or a Sniper Team hidden in the woods) — its model is where it was
   * last drawn, not where it is: the shot leaves the sim's position instead.
   */
  muzzle(id: number, fx?: WeaponFx): P3 | null {
    const v = this.views.get(id);
    if (!v || !v.visible) return null;
    // (a Goliath fires each weapon from its own guns: pods, eye, arm cannons, machine guns)
    if (v.kind === "unit" && v.goliath) return v.goliath.muzzle(fx ?? "mg");
    if (v.kind === "unit" && v.squad) {
      const up = v.squad.standing();
      if (!up.length) return null;
      v.squad.muzzle(up[0]!, tmp);
      return { x: tmp.x, y: tmp.z, h: tmp.y };
    }
    const m = v.m;
    m.root.updateMatrixWorld(true);
    tmp.set(...m.def.muzzle);
    if (m.turret) m.turret.localToWorld(tmp);
    else m.body.localToWorld(tmp);
    return { x: tmp.x, y: tmp.z, h: tmp.y };
  }

  /** Called when a shot fires: kick the recoil and snap aim toward it (a Goliath kicks the gun that fired `fx`). */
  fired(id: number, angle: number, fx?: WeaponFx): void {
    const v = this.views.get(id);
    if (!v) return;
    v.recoil = 1;
    if (v.kind === "unit" && v.goliath) {
      v.goliath.fired(fx ?? "mg");
      return;
    }
    if (v.kind === "unit" && v.m.turret) v.aim = angle;
    // (a squad's formation wheels round to its new facing in updateSquad: snapped, every robot would jump)
    else if (v.kind === "unit" && v.squad) return;
    else if (v.kind === "unit") v.face = v.aim = angle;
    else v.face = angle;
  }

  /**
   * A hit landed on a visible entity: units flash white, buildings a brief
   * warm glow. Throttled per entity so sustained fire flickers, not strobes.
   */
  hitFlash(id: number): void {
    const v = this.views.get(id);
    if (!v || !v.visible) return;
    // wall-clock timing: a flash still ends if the game is paused mid-blink
    const now = performance.now();
    if (v.kind === "unit") {
      this.flashes.hit(id, now);
      return;
    }
    // (a remembered building out of sight keeps its last-seen look)
    if (!v.seen || !this.flashes.hit(id, now, JUICE.buildingFlashMs, JUICE.buildingFlashGapMs)) return;
    v.warmUntil = now + JUICE.buildingFlashMs;
  }

  /**
   * Feed every sim fx event through here (before the views sync): squads
   * boarding and dropping out of Condors, Mastodons crushing robots.
   */
  onFx(ev: FxEvent): void {
    switch (ev.type) {
      case "embark":
        this.boarded.set(ev.unitId, ev.carrierId);
        if (this.visibleAt(ev.x, ev.y)) this.fx.wash(ev.x, ev.y, 2);
        break;
      case "disembark":
        for (const id of ev.unitIds) this.dropped.set(id, { carrierId: ev.carrierId, x: ev.x, y: ev.y, bailout: ev.bailout });
        if (this.visibleAt(ev.x, ev.y)) this.fx.wash(ev.x, ev.y, ev.bailout ? 2 : 5);
        break;
      case "crush":
        if (this.visibleAt(ev.x, ev.y)) this.fx.crush(ev.x, ev.y);
        break;
      case "goliathRollout": {
        this.rolledOut.set(ev.id, ev.buildingId);
        const b = this.views.get(ev.buildingId);
        if (b?.kind === "building") b.gantry?.rollout();
        break;
      }
      case "goliathMode":
      case "goliathWeapon":
      case "goliathLift": {
        const g = this.views.get(ev.id);
        if (g?.kind === "unit") g.goliath?.onFx(ev);
        break;
      }
    }
  }

  /**
   * Robot Love: Goliaths `ids` walk to meet at (x, y), eyes pink, hearts
   * rising (render/goliath.ts) — the sim has stopped at the draw, so their
   * views play it out on their own.
   */
  love(ids: readonly number[], x: number, y: number): void {
    this.lovers = { ids, x, y };
  }

  /** A Goliath's rendered rig, if it has one on show (or toppling): its rings and lift, for the overlay. */
  goliath(id: number): GoliathView | null {
    const v = this.views.get(id);
    return v?.kind === "unit" ? v.goliath : null;
  }

  /**
   * Every Goliath's rings on the ground (render/goliath.ts GoliathView.marks):
   * `selected` units get a bold threat ring, and `friendly` says whose they are.
   */
  goliathMarks(g: GroundGfx, selected: ReadonlySet<number>): void {
    for (const u of this.world.units.values()) {
      if (!u.goliath) continue;
      const v = this.views.get(u.id);
      if (v?.kind === "unit" && v.goliath && v.visible) v.goliath.marks(g, u, selected.has(u.id), this.isFriendly(u.faction));
    }
  }

  /** Robots of squad `id` firing a volley: every one standing (a Sniper Team takes turns). */
  private shooters(id: number, wfx: WeaponFx): number[] | null {
    const v = this.views.get(id);
    if (!v || v.kind !== "unit" || !v.squad || !v.visible) return null;
    const up = v.squad.standing();
    if (!up.length) return null;
    return wfx === "snipe" ? [up[this.snipeTurn++ % up.length]!] : up;
  }

  private squadFire(id: number, i: number): P3 | null {
    const v = this.views.get(id);
    if (!v || v.kind !== "unit" || !v.squad) return null;
    const p = v.squad.fire(i, tmp);
    return p ? { x: p.x, y: p.z, h: p.y } : null;
  }

  /** A squad on show just left the field near (x, y) without boarding anything: it died there. */
  private squadDiedAt(x: number, y: number): boolean {
    for (const [id, v] of this.views)
      if (v.kind === "unit" && v.squad && v.visible && !this.world.units.has(id) && !this.boarded.has(id) && Math.hypot(v.sx - x, v.sy - y) < 0.6)
        return true;
    return false;
  }

  /** Units with ranks, for the chevrons the overlay draws (one record, refilled per unit: read it before the next). */
  *ranked(): Generator<{ x: number; y: number; h: number; rank: number; pop: number }> {
    const r = this.rankRec;
    for (const v of this.views.values())
      if (v.kind === "unit" && v.visible && v.rank > 0) {
        r.x = v.gx;
        r.y = v.gy;
        r.h = v.bh + v.top;
        r.rank = v.rank;
        r.pop = v.chevronPop;
        yield r;
      }
  }

  // ------------------------------------------------------------- sync ---

  sync(alpha: number, prev: Map<number, { x: number; y: number }>, dtMs: number): void {
    const w = this.world;
    // (a replay seek back: what's gone just isn't there yet, and a love scene that hasn't happened is off)
    const rewound = w.tick < this.lastTick;
    this.lastTick = w.tick;
    if (this.lovers && w.winner !== "draw") this.lovers = null;
    this.time += dtMs;
    this.alpha = alpha;
    eliteUniform.value = 0.1 + 0.06 * Math.sin(this.time / 260);
    const seen = this.seen;
    seen.clear();
    const turnK = 1 - Math.pow(0.0005, dtMs / 1000); // fast but smooth turning
    // Condors with squads walking up to board them come down to meet them
    this.boarders.clear();
    for (const u of w.units.values())
      if (u.order.type === "board") {
        const c = w.units.get(u.order.carrierId);
        if (c && Math.hypot(c.x - u.x, c.y - u.y) < 2.5) this.boarders.add(c.id);
      }

    for (const u of w.units.values()) {
      seen.add(u.id);
      let v = this.views.get(u.id) as UnitView | undefined;
      if (!v) v = this.createUnit(u);
      const p = prev.get(u.id) ?? u;
      const gx = p.x + (u.x - p.x) * alpha;
      const gy = p.y + (u.y - p.y) * alpha;
      this.updateUnit(u, v, gx, gy, dtMs, turnK);
    }

    for (const b of w.buildings.values()) {
      seen.add(b.id);
      let v = this.views.get(b.id) as BuildingView | undefined;
      if (!v) v = this.createBuilding(b);
      this.updateBuilding(b, v, dtMs, turnK, alpha);
    }

    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      const root = v.m.root;
      // an enemy building destroyed out of sight stays standing, as remembered (the minimap's
      // memory too), until we see its footprint again — or the match is decided
      // (not one the enemy always sees, a Gantry: we see it die wherever it stands)
      if (
        v.kind === "building" && v.visible && !this.sold.has(id) && !this.isFriendly(v.faction) && !w.winner &&
        !BUILDINGS[v.bkind].alwaysVisible && !this.footprintSeen(v)
      )
        continue;
      if (v.kind === "building") {
        if (!this.sold.has(id) && v.visible) this.fx.rubble(v.cx, v.cy, v.size);
        if (this.sold.has(id)) {
          // packed up: it sinks back into the ground
          const y0 = root.position.y;
          this.v.tweens.add({
            dur: 380, ease: Ease.quadIn,
            update: (k) => {
              root.position.y = y0 - k * v.top * 0.9;
              root.scale.setScalar(1 - k * 0.15);
            },
            done: () => this.group.remove(root)
          });
          for (let i = 0; i < 5; i++) this.fx.dust(v.cx + (Math.random() - 0.5) * v.size, v.cy + (Math.random() - 0.5) * v.size);
        } else this.group.remove(root);
      } else if (v.squad && v.visible) this.leave(id, v);
      else if (v.goliath && !rewound) {
        // a Goliath topples, slams down and sinks away before it goes
        v.goliath.startFall();
        this.toppling.push(v.goliath);
      } else {
        this.group.remove(root);
        this.release(v);
      }
      this.views.delete(id);
    }
    // the woods thin over squads on show (ours, and enemies we can see), so they aren't lost under the trees
    const pts = this.inWoods;
    let n = 0;
    for (const v of this.views.values())
      if (v.kind === "unit" && v.squad && v.visible) {
        pts[n * 2] = v.gx;
        pts[n * 2 + 1] = v.gy;
        n++;
      }
    const rig = this.v.rig;
    this.v.terrain.thinCanopy(pts, n, 1 / Math.tan(rig.pitchFor(rig.zoom)), dtMs);
    // squads off the field: the wiped-out toppling, the boarding hopping up into the bay
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const l = this.leaving[i]!;
      l.rig.update({ dt: dtMs, speed: 0, aim: 0, pitch: 0, alive: l.alive });
      if (l.rig.done) {
        this.group.remove(l.rig.root);
        l.rig.dispose();
        this.leaving.splice(i, 1);
      }
    }
    for (let i = this.toppling.length - 1; i >= 0; i--) {
      const g = this.toppling[i]!;
      if (!g.updateFall(dtMs)) continue;
      this.group.remove(g.root);
      g.dispose();
      this.toppling.splice(i, 1);
    }
    this.boarded.clear();
    this.dropped.clear();
    this.rolledOut.clear();
  }

  /** A squad left the field: aboard a Condor (its robots hop up into the bay), or wiped out (the last fall). */
  private leave(id: number, v: UnitView): void {
    const rig = v.squad!;
    const carrierId = this.boarded.get(id) ?? this.carrierOf(id);
    const c = carrierId !== undefined ? this.views.get(carrierId) : undefined;
    if (c?.kind === "unit") {
      // (counted before they set off: robots hopping aboard aren't "standing", and must not fall)
      const alive = rig.bots.filter((b) => b.up).length;
      rig.root.updateMatrixWorld(true);
      // (a Condor out of sight isn't drawn where it is: they hop up to where it's hovering)
      const to = c.m.ramp && c.visible ? this.rampLip(c, tmp2) : tmp2.set(c.gx, this.v.terrain.groundAt(c.gx, c.gy) + CONDOR_LOW - 0.1, c.gy);
      rig.board(rig.root.worldToLocal(to));
      this.leaving.push({ rig, alive });
    } else {
      rig.fallAll();
      this.leaving.push({ rig, alive: 0 });
    }
  }

  /**
   * Free a removed view's own GPU resources: a squad rig's bone texture, a
   * Condor's light-pool material and its riders' rigs. (Models share their
   * geometry and materials: nothing else is per view.)
   */
  private release(v: View3): void {
    if (v.kind !== "unit") return;
    v.squad?.dispose();
    v.goliath?.dispose();
    if (v.condor) {
      v.condor.poolMat.dispose();
      for (const r of v.condor.riders.values()) r.rig.dispose();
      v.condor.riders.clear();
    }
  }

  /** World point of a Condor's ramp lip (where squads step off and climb aboard), into `out`. */
  private rampLip(c: UnitView, out: THREE.Vector3): THREE.Vector3 {
    const r = c.m.ramp!;
    r.updateWorldMatrix(true, false);
    return r.localToWorld(out.set(...c.m.def.ramp!.tip));
  }

  /** The Condor carrying squad `id`, if any. */
  private carrierOf(id: number): number | undefined {
    for (const u of this.world.units.values()) if (u.passengers?.some((p) => p.id === id)) return u.id;
    return undefined;
  }

  private createUnit(u: Unit): UnitView {
    if (isInfantry(u.kind)) return this.createSquad(u);
    if (u.goliath) return this.createGoliath(u);
    const stats = UNITS[u.kind];
    const m = instance(unitDef(u.kind, u.faction));
    m.body.rotation.order = "YXZ";
    this.group.add(m.root);
    const scale = unitScale(u.kind);
    m.root.scale.setScalar(scale);
    const v: UnitView = {
      kind: "unit", m, air: stats.domain === "air", hover: !!stats.hover,
      face: u.facing, aim: u.aim, recoil: 0, lastFired: u.firedTick, phase: (u.id * 1.37) % (Math.PI * 2), dustT: 0,
      gx: u.x, gy: u.y, bh: 0, pitch: 0, roll: 0, bank: 0, visible: true, variant: "normal",
      // units that arrive ranked (Last Stand waves) don't pop their chevrons
      rank: u.rank, chevronPop: 1, top: m.def.height * scale, scale,
      squad: null, condor: null, goliath: null, sx: u.x, sy: u.y
    };
    if (m.ramp) {
      const bay = new THREE.Group();
      bay.scale.setScalar(1 / scale);
      m.body.add(bay);
      const poolMat = discMat(0xffb04a, 0);
      const pool = new THREE.Mesh(poolGeo, poolMat);
      pool.renderOrder = 3;
      pool.visible = false;
      m.root.add(pool);
      v.condor = { bay, riders: new Map(), ramp: 0, low: 0, washT: 0, hold: 0, pool, poolMat, lift: 0 };
    }
    // units roll out of the factory with a quick pop-in
    if (this.world.tick > 1) {
      m.root.scale.setScalar(scale * 0.5);
      this.v.tweens.add({ dur: 320, ease: Ease.backOut, update: (k) => m.root.scale.setScalar(scale * (0.5 + 0.5 * k)) });
    }
    this.views.set(u.id, v);
    return v;
  }

  /** A robot squad: its rig stands in for a model instance (root and body are the rig's root). */
  private createSquad(u: Unit): UnitView {
    const rig = new SquadRig(lookalike(u.kind) as BotKind, u.faction, u.id, squadAlive(u));
    rig.onImpact = (p, kind) => {
      if (!this.visibleAt(p.x, p.z)) return;
      const at = { x: p.x, y: p.z, h: p.y };
      if (kind === "fall") this.fx.robotDown(at);
      else this.fx.landing(at);
    };
    const def = unitDef(u.kind, u.faction);
    const m: ModelInstance = { root: rig.root, body: rig.root, turret: null, rotors: [], cargo: null, ramp: null, parts: {}, def };
    this.group.add(rig.root);
    const v: UnitView = {
      kind: "unit", m, air: false, hover: false,
      face: u.facing, aim: u.facing, recoil: 0, lastFired: u.firedTick, phase: 0, dustT: 0,
      gx: u.x, gy: u.y, bh: this.v.terrain.groundAt(u.x, u.y), pitch: 0, roll: 0, bank: 0, visible: true, variant: "normal",
      rank: u.rank, chevronPop: 1, top: def.height, scale: 1, squad: rig, condor: null, goliath: null, sx: u.x, sy: u.y
    };
    rig.root.position.set(u.x, v.bh, u.y);
    rig.root.rotation.set(0, -u.facing, 0);
    const drop = this.dropped.get(u.id);
    if (drop) {
      // out of a Condor: the robots jump down off its ramp (bailing out of a falling one, from higher).
      // (Only a Condor on show: one out of sight is drawn where it was last seen, or never placed at all.)
      const c = this.views.get(drop.carrierId);
      const lip = c?.kind === "unit" && c.m.ramp && c.visible ? c : null;
      const from = lip ? this.rampLip(lip, tmp2) : tmp2.set(drop.x, v.bh + (drop.bailout ? 1.1 : 0.6), drop.y);
      rig.root.updateMatrixWorld(true);
      rig.dropFrom(rig.root.worldToLocal(from), drop.bailout ? 0.5 : 0.14, lip ? RIDER_SCALE : 1);
    } else if (this.world.tick > 1) rig.popIn();
    this.views.set(u.id, v);
    return v;
  }

  /**
   * A Goliath: its posed rig stands in for a model instance. One that just
   * rolled out of a Gantry starts on the cradle and walks off it (no pop-in).
   */
  private createGoliath(u: Unit): UnitView {
    const gantryId = this.rolledOut.get(u.id);
    const gantry = gantryId !== undefined ? this.views.get(gantryId) : undefined;
    const from = gantry?.kind === "building" && gantry.gantry ? gantry.gantry.cradle : null;
    const gv = new GoliathView(this.host, u, from);
    const def = unitDef(u.kind, u.faction);
    const m: ModelInstance = { root: gv.root, body: gv.rig.j.body, turret: null, rotors: [], cargo: null, ramp: null, parts: {}, def };
    this.group.add(gv.root);
    const v: UnitView = {
      kind: "unit", m, air: false, hover: false,
      face: gv.face, aim: u.aim, recoil: 0, lastFired: u.firedTick, phase: 0, dustT: 0,
      gx: gv.gx, gy: gv.gy, bh: gv.bh, pitch: 0, roll: 0, bank: 0, visible: true, variant: "normal",
      rank: u.rank, chevronPop: 1, top: gv.top, scale: gv.root.scale.x, squad: null, condor: null, goliath: gv, sx: u.x, sy: u.y
    };
    this.views.set(u.id, v);
    return v;
  }

  private setVariant(v: UnitView | BuildingView, variant: Variant): void {
    if (v.variant === variant) return;
    v.variant = variant;
    setVariant(v.m.root, variant);
  }

  private updateUnit(u: Unit, v: UnitView, gx: number, gy: number, dtMs: number, turnK: number): void {
    const stats = UNITS[u.kind];
    const visible = this.isFriendly(u.faction) || (this.unitShown ? this.unitShown(u) : this.visibleAt(u.x, u.y));
    v.visible = visible;
    v.m.root.visible = visible;
    v.sx = u.x;
    v.sy = u.y;
    if (v.squad) {
      this.updateSquad(u, v, gx, gy, dtMs, turnK);
      return;
    }
    if (v.goliath) {
      const g = v.goliath;
      const love = this.lovers;
      if (!love && g.inLove) g.endLove();
      if (love && !g.inLove && love.ids.includes(u.id)) {
        const other = this.world.units.get(love.ids.find((id) => id !== u.id) ?? -1);
        if (other) g.love(love.x, love.y, other.x, other.y);
      }
      if (visible) this.setVariant(v, this.flashes.active(u.id, performance.now()) ? "flash" : u.rank >= 3 ? "elite" : "normal");
      g.update(u, gx, gy, dtMs, turnK, this.alpha, visible);
      v.gx = g.gx;
      v.gy = g.gy;
      v.bh = g.bh;
      v.face = g.face;
      this.promote(u, v);
      return;
    }
    const moved = Math.hypot(gx - v.gx, gy - v.gy);
    v.gx = gx;
    v.gy = gy;
    if (!visible) return;
    const t = this.v.terrain;
    const flashing = this.flashes.active(u.id, performance.now());
    this.setVariant(v, flashing ? "flash" : u.rank >= 3 ? "elite" : "normal");

    const prevFace = v.face;
    v.face += angleDelta(v.face, u.facing) * turnK;
    if (stats.turret) {
      // turrets track their target, then settle back over the hull
      const aimTarget = this.world.tick - u.firedTick > 25 ? u.facing : u.aim;
      v.aim += angleDelta(v.aim, aimTarget) * turnK * 0.7;
    } else {
      v.aim = v.face; // the sim turns the whole body to shoot
    }
    if (u.firedTick !== v.lastFired) {
      v.lastFired = u.firedTick;
      v.recoil = 1;
    }
    v.recoil = Math.max(0, v.recoil - dtMs / 160);

    const sk = 1 - Math.pow(0.002, dtMs / 1000);
    const root = v.m.root;
    const body = v.m.body;
    if (v.air) {
      const bob = Math.sin(this.time / 380 + v.phase) * 0.06;
      const g = t.surfaceAt(gx, gy);
      v.bh = g * 0.3 + AIR_H + bob;
      // a Condor dropping or picking up squads comes down low over the ground; carrying a Goliath, it climbs over it
      if (v.condor) {
        v.bh += (g + CONDOR_LOW - (g * 0.3 + AIR_H)) * v.condor.low;
        v.condor.lift += (this.carryHeight(u, g * 0.3 + AIR_H) - v.condor.lift) * (1 - Math.exp(-(dtMs / 1000) * 1.8));
        v.bh += v.condor.lift;
      }
      // bank into turns, nose down when moving fast
      const turnRate = dtMs > 0 ? angleDelta(prevFace, v.face) / (dtMs / 1000) : 0;
      v.bank += (Math.max(-0.6, Math.min(0.6, -turnRate * 0.35)) - v.bank) * sk;
      const speed = dtMs > 0 ? moved / (dtMs / 1000) : 0;
      v.pitch += (Math.max(-0.25, -speed * 0.05) - v.pitch) * sk;
      body.rotation.set(v.pitch, -v.face, v.bank);
    } else {
      const f = v.face;
      const fx = Math.sin(f);
      const fz = -Math.cos(f);
      const hover = v.hover;
      const at = (x: number, y: number) => t.groundAt(x, y, hover);
      const L = 0.3;
      const hF = at(gx + fx * L, gy + fz * L);
      const hB = at(gx - fx * L, gy - fz * L);
      const hR = at(gx - fz * 0.22, gy + fx * 0.22);
      const hL = at(gx + fz * 0.22, gy - fx * 0.22);
      v.pitch += (Math.atan2(hF - hB, L * 2) - v.pitch) * sk;
      v.roll += (Math.atan2(hR - hL, 0.44) - v.roll) * sk;
      const base = (hF + hB + hR + hL) / 4;
      v.bh = hover ? base + HOVER_H + Math.sin(this.time / 300 + v.phase) * 0.02 : base;
      body.rotation.set(v.pitch, -v.face, v.roll);
      if (v.m.parts[CRAWLER_LEGS[0]!.name]) this.walk(v, moved, angleDelta(prevFace, v.face), dtMs);
    }
    root.position.set(gx, v.bh, gy);

    if (v.m.turret) {
      const rel = v.aim - v.face;
      v.m.turret.rotation.y = -rel;
      const kick = v.recoil * (u.kind === "mastodon" ? 0.08 : 0.05);
      const mount = v.m.def.mount;
      v.m.turret.position.set(mount[0] + Math.sin(-rel) * kick, mount[1], mount[2] + Math.cos(-rel) * kick);
    }
    for (const r of v.m.rotors) r.obj.rotation[r.axis] += (r.speed * dtMs) / 1000;
    if (v.m.cargo) v.m.cargo.visible = u.kind === "harvester" && u.cargo >= ECONOMY.harvesterCapacity / 2;
    if (v.condor) this.updateCondor(u, v, v.condor, gx, gy, dtMs);

    this.promote(u, v);

    // ground vehicles kick up dust when moving
    if (!v.air && !v.hover && moved > 0.006) {
      v.dustT -= dtMs;
      if (v.dustT <= 0) {
        v.dustT = 90 + Math.random() * 80;
        this.fx.dust(gx - Math.sin(v.face) * 0.25, gy + Math.cos(v.face) * 0.25);
      }
    }
    // hover tanks stir a faint spray over water
    if (v.hover && moved > 0.006 && t.heightAt(gx, gy) < -0.1 && Math.random() < 0.3) this.fx.dust(gx, gy);
    // Belle Époque steam machines puff coal smoke (or steam, aloft) from their stacks: faster on the move
    const stacks = BELLE_EPOQUE ? STACKS[u.kind] : undefined;
    if (stacks && dtMs > 0) {
      v.stackT = (v.stackT ?? Math.random() * 400) - dtMs;
      if (v.stackT <= 0) {
        const going = moved > 0.004;
        v.stackT = (going ? 200 : 700) + Math.random() * 150;
        const s = stacks[Math.floor(Math.random() * stacks.length)]!;
        root.updateMatrixWorld(true);
        body.localToWorld(tmp.set(s[0], s[1], s[2]));
        this.fx.stackPuff({ x: tmp.x, y: tmp.z, h: tmp.y }, !!v.air);
      }
    }
  }

  /** Veterancy: a promotion pops the new chevron in. */
  private promote(u: Unit, v: UnitView): void {
    if (u.rank > v.rank) {
      v.rank = u.rank;
      v.chevronPop = 0;
      this.v.tweens.add({ dur: 450, ease: Ease.backOut, update: (k) => (v.chevronPop = k) });
    }
    v.rank = u.rank;
  }

  /**
   * How far above its flying height a Condor on a lift climbs: to clear the
   * top of the Goliath it carries (or is closing in to hook onto), 0 for any
   * other Condor.
   */
  private carryHeight(c: Unit, flying: number): number {
    const g = c.order.type === "lift" ? liftedBy(this.world, c) : null;
    if (!g?.goliath?.lift) return 0;
    const gv = this.views.get(g.id);
    if (gv?.kind !== "unit" || !gv.goliath) return 0;
    if (g.goliath.lift.phase !== "carrying" && Math.hypot(c.x - g.x, c.y - g.y) > 2.2) return 0;
    return Math.max(0, gv.goliath.bh + gv.goliath.top + CARRY_CLEAR - flying);
  }

  /** A squad: it turns and marches (cadence from its ground speed), raises its weapons while fighting. */
  private updateSquad(u: Unit, v: UnitView, gx: number, gy: number, dtMs: number, turnK: number): void {
    const rig = v.squad!;
    const moved = Math.hypot(gx - v.gx, gy - v.gy);
    v.gx = gx;
    v.gy = gy;
    if (!v.visible) {
      // out of sight its animations don't wait for us: first seen, it's simply standing there, as it is now
      // (and with no sparks: a Sniper Team hidden in woods in our sight must not give itself away)
      v.face = v.aim = u.facing;
      v.bh = this.v.terrain.groundAt(gx, gy);
      rig.root.position.set(gx, v.bh, gy);
      rig.root.rotation.set(0, -v.face, 0);
      rig.settle(squadAlive(u));
      return;
    }
    const flashing = this.flashes.active(u.id, performance.now());
    this.setVariant(v, flashing ? "flash" : u.rank >= 3 ? "elite" : "normal");
    const prevFace = v.face;
    v.face += angleDelta(v.face, u.facing) * turnK;
    v.aim = v.face;
    // (wheeling round on the spot is footwork too)
    const sec = dtMs / 1000;
    const speed = sec > 0 ? moved / sec + (Math.abs(angleDelta(prevFace, v.face)) / sec) * 0.12 : 0;
    v.bh = this.v.terrain.groundAt(gx, gy);
    rig.root.position.set(gx, v.bh, gy);
    rig.root.rotation.set(0, -v.face, 0);
    // weapons up while it is fighting (it shot within an interval or so); rifles point up at aircraft
    const stats = UNITS[u.kind];
    const fighting = this.world.tick - u.firedTick <= ((stats.shotInterval ?? 1) + 0.8) * TICK_RATE;
    let pitch = 0;
    if (fighting) {
      const tid = u.order.type === "attack" ? u.order.targetId : u.autoTargetId;
      const tg = tid !== null ? this.world.units.get(tid) : undefined;
      if (tg && UNITS[tg.kind].domain === "air") pitch = Math.min(0.9, Math.atan2(AIR_H - 0.2, Math.max(0.6, Math.hypot(tg.x - u.x, tg.y - u.y))));
    }
    // vehicles rolling through (or parked on) the squad: its robots step out of their hulls
    const avoid = this.avoid;
    avoid.length = 0;
    for (const o of this.world.units.values()) {
      if (o === u || isInfantry(o.kind) || UNITS[o.kind].domain === "air") continue;
      const ov = this.views.get(o.id);
      const ox = ov?.kind === "unit" ? ov.gx : o.x;
      const oy = ov?.kind === "unit" ? ov.gy : o.y;
      const [hl, hw] = hullHalf(o.kind);
      // (a Goliath's feet reach further than a tank's hull)
      const near = Math.max(1.6, Math.max(hl, hw) + 0.4);
      if (Math.abs(ox - gx) > near || Math.abs(oy - gy) > near) continue;
      const face = ov?.kind === "unit" ? ov.face : o.facing;
      avoid.push({ x: ox, z: oy, fx: Math.sin(face), fz: -Math.cos(face), hl, hw });
    }
    rig.update({ dt: dtMs, speed, aim: fighting ? 1 : 0, pitch, alive: squadAlive(u), ground: this.groundFn, avoid });
    if (u.rank > v.rank) {
      v.rank = u.rank;
      v.chevronPop = 0;
      this.v.tweens.add({ dur: 450, ease: Ease.backOut, update: (k) => (v.chevronPop = k) });
    }
    v.rank = u.rank;
  }

  /**
   * The Flak Crawler's legs (models.ts CRAWLER_LEGS): an alternating tripod
   * gait whose phase follows the ground covered (and turning on the spot), so
   * the feet keep pace with the body; the legs ease back to stand when it stops.
   */
  private walk(v: UnitView, moved: number, turned: number, dtMs: number): void {
    const g = (v.gait ??= { phase: v.phase, amp: 0 });
    const sec = dtMs / 1000;
    const step = moved + Math.abs(turned) * 0.15;
    g.amp += ((sec > 0 && step / sec > 0.15 ? 1 : 0) - g.amp) * (1 - Math.exp(-sec * 8));
    g.phase += (step / LEG_CYCLE) * Math.PI * 2;
    for (const leg of CRAWLER_LEGS) {
      const p = v.m.parts[leg.name]!;
      const ph = g.phase + leg.tripod * Math.PI;
      // each foot swings forward and back about its hip, lifting on the way forward
      p.rotation.y = leg.side * Math.sin(ph) * LEG_SWING * g.amp;
      p.position.y = v.m.def.parts![leg.name]!.at[1] + Math.max(0, Math.cos(ph)) * LEG_LIFT * g.amp;
    }
  }

  /**
   * The Condor: down low with its ramp open while it hovers to drop its squads
   * or squads walk up to board it (downwash kicking up the dust, the bay's
   * light spilling out under the ramp), its riders sitting along the benches
   * in the bay — on their feet facing the ramp as it opens for a drop.
   */
  private updateCondor(u: Unit, v: UnitView, c: CondorView, gx: number, gy: number, dtMs: number): void {
    const k = dtMs / 1000;
    const o = u.order;
    let low = 0;
    let open = 0;
    if (o.type === "unload") {
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (o.hover >= 0 || d < 1.4) low = 1;
      if (o.hover >= 0 || d < 0.7) open = 1;
    }
    if (this.boarders.has(u.id)) low = open = 1;
    for (const d of this.dropped.values()) if (d.carrierId === u.id && !d.bailout) c.hold = 850;
    for (const carrier of this.boarded.values()) if (carrier === u.id) c.hold = Math.max(c.hold, 500);
    if (c.hold > 0) {
      c.hold -= dtMs;
      low = open = 1;
    }
    c.low += (low - c.low) * (1 - Math.exp(-k * 2.2));
    c.ramp += (open - c.ramp) * (1 - Math.exp(-k * (open > c.ramp ? 3.5 : 2)));
    v.m.ramp!.rotation.x = c.ramp * v.m.def.ramp!.open;
    // the bay lights spill out of the open ramp onto the ground under it
    const glow = c.ramp * c.low;
    c.pool.visible = glow > 0.02 && v.visible;
    if (c.pool.visible) {
      const lip = this.rampLip(v, tmp);
      const s = v.scale;
      c.pool.position.set((lip.x - gx) / s, (this.v.terrain.surfaceAt(lip.x, lip.z) + 0.04 - v.bh) / s, (lip.z - gy) / s);
      c.pool.scale.setScalar(1.15 / s);
      c.poolMat.opacity = glow * (0.5 + 0.06 * Math.sin(this.time / 90));
    }
    // downwash: dust blown out in a ring under the fans
    if (c.low > 0.55 && dtMs > 0) {
      c.washT -= dtMs;
      if (c.washT <= 0) {
        c.washT = 70 + Math.random() * 50;
        const a = Math.random() * Math.PI * 2;
        this.fx.kick(gx + Math.cos(a) * 0.55, gy + Math.sin(a) * 0.55, 1);
        this.fx.kick(gx - Math.cos(a) * 0.55, gy - Math.sin(a) * 0.55, 1);
      }
    }
    // riders: a seated rig per squad aboard (a squad that just climbed in takes its seat as it lands).
    // Only in our own Condors (or watching with the fog off): the enemy's passengers are hidden, its bay
    // shows empty — what, and how many, it carries is for us to find out the hard way.
    const ps = (this.isFriendly(u.faction) && u.passengers) || NO_RIDERS;
    for (const [id, r] of c.riders)
      if (!ps.some((p) => p.id === id)) {
        c.bay.remove(r.rig.root);
        r.rig.dispose();
        c.riders.delete(id);
      }
    ps.forEach((p, side) => {
      let r = c.riders.get(p.id);
      if (!r || r.side !== side) {
        if (r) {
          c.bay.remove(r.rig.root);
          r.rig.dispose();
        }
        const rig = new SquadRig(lookalike(p.kind) as BotKind, p.faction, p.id, squadAlive(p));
        rig.seat(baySeats(lookalike(p.kind) as BotKind, side, v.scale));
        if (this.boarded.has(p.id)) rig.popIn(300);
        c.bay.add(rig.root);
        r = { rig, side };
        c.riders.set(p.id, r);
      }
      // (on their feet, facing the ramp, as it opens to drop them)
      r.rig.update({ dt: dtMs, speed: 0, aim: 0, pitch: 0, alive: squadAlive(p), ready: o.type === "unload" ? c.ramp : 0 });
    });
  }

  private createBuilding(b: Building): BuildingView {
    const size = BUILDINGS[b.kind].size;
    const cx = b.tx + size / 2;
    const cy = b.ty + size / 2;
    const t = this.v.terrain;
    let base = 0;
    for (const [dx, dy] of [[0, 0], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]] as [number, number][])
      base = Math.max(base, t.heightAt(cx + dx * size, cy + dy * size));
    const m = instance(buildingDef(b.kind, b.faction, nationOf(this.world, b.faction)));
    m.root.position.set(cx, base - 0.02, cy);
    this.group.add(m.root);
    const v: BuildingView = {
      kind: "building", m, bkind: b.kind, faction: b.faction, face: b.facing, recoil: 0, lastFired: b.firedTick,
      smokeT: 0, size, tx: b.tx, ty: b.ty, cx, cy, base, visible: true, seen: true, hp: b.hp / BUILDINGS[b.kind].hp,
      variant: "normal", warmUntil: 0, top: m.def.height, roof: roofOf(m.def, size), gantry: null
    };
    // (the Gantry, and the Goliath taking shape on it, are always in the enemy's sight)
    if (b.kind === "gantry") v.gantry = new GantryView(this.host, m, b, cx, cy, base);
    if (this.world.tick > 1) {
      // freshly placed: it rises from the ground in a puff of dust
      m.root.scale.set(1, 0.05, 1);
      this.v.tweens.add({ dur: 480, ease: Ease.backOut, update: (k) => m.root.scale.set(0.9 + 0.1 * k, Math.max(0.05, k), 0.9 + 0.1 * k) });
      for (let i = 0; i < 8; i++) this.fx.dust(cx + (Math.random() - 0.5) * size, cy + (Math.random() - 0.5) * size);
    }
    this.views.set(b.id, v);
    return v;
  }

  /** Can the local player see any tile of a building's footprint (the sim's rule for seeing it)? */
  private footprintSeen(v: BuildingView): boolean {
    for (let dy = 0; dy < v.size; dy++)
      for (let dx = 0; dx < v.size; dx++) if (this.visibleAt(v.tx + dx + 0.5, v.ty + dy + 0.5)) return true;
    return false;
  }

  private updateBuilding(b: Building, v: BuildingView, dtMs: number, turnK: number, alpha: number): void {
    const friendly = this.isFriendly(b.faction);
    const always = !!BUILDINGS[b.kind].alwaysVisible;
    const visible = friendly || always || this.buildingShown(b);
    v.visible = visible;
    v.m.root.visible = visible;
    if (!visible) return;
    // a remembered enemy building out of sight keeps the health it had when last seen (a Gantry is never out of sight)
    v.seen = friendly || always || this.footprintSeen(v);
    v.gantry?.update(b, dtMs, alpha, visible);
    if (v.seen) v.hp = b.hp / BUILDINGS[b.kind].hp;
    const ratio = v.hp;
    this.setVariant(v, v.seen && performance.now() < v.warmUntil ? "warm" : ratio < 0.5 ? "damaged" : "normal");
    if (v.m.turret) {
      // out of sight it holds its last-seen pose: a radar that swept on (then froze as it died in
      // the fog) or a turret that kept tracking would show what the fog hides. (A shot we're shown
      // still swings it round and kicks it: fired().)
      if (v.seen) {
        if (b.kind === "radar") v.face += dtMs / 900; // radar sweeps continuously
        else v.face += angleDelta(v.face, b.facing) * turnK;
        if (b.firedTick !== v.lastFired) v.recoil = 1;
      }
      v.lastFired = b.firedTick;
      v.recoil = Math.max(0, v.recoil - dtMs / 160);
      const kick = v.recoil * 0.05;
      const mount = v.m.def.mount;
      v.m.turret.rotation.y = -v.face;
      v.m.turret.position.set(mount[0] - Math.sin(v.face) * kick, mount[1], mount[2] + Math.cos(v.face) * kick);
    }
    // damage smoke and fire, rising off the roof (not while out of sight: the fog hides it)
    if (v.seen && ratio < 0.5) {
      v.smokeT -= dtMs;
      if (v.smokeT <= 0) {
        v.smokeT = ratio < 0.25 ? 110 : 260;
        const i = Math.floor(Math.random() * 9);
        puffAt.x = v.cx + (((i % 3) - 1) * v.size) / 4 + (Math.random() - 0.5) * 0.12;
        puffAt.y = v.cy + ((Math.floor(i / 3) - 1) * v.size) / 4 + (Math.random() - 0.5) * 0.12;
        puffAt.h = v.base - 0.02 + v.roof[i]!;
        this.fx.buildingSmoke(puffAt, ratio < 0.25, always);
      }
    }
  }

  destroy(): void {
    this.v.scene.remove(this.group);
    for (const v of this.views.values()) this.release(v);
    for (const l of this.leaving) l.rig.dispose();
    for (const g of this.toppling) g.dispose();
    this.views.clear();
    this.leaving = [];
    this.toppling = [];
    if (this.fx.squads) this.fx.squads = null;
    this.fx.shellFrom = null;
  }
}
