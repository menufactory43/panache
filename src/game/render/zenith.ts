import * as THREE from "three";
import { TICK_RATE, UNITS, ZENITH, type ZenithWeapon } from "../../sim/balance";
import type { Faction, FxEvent, GoliathMode, Unit, WeaponFx, World } from "../../sim/types";
import { clearOfFog, setVariant } from "../three/materials";
import { unitScale } from "../three/models";
import type { GroundGfx } from "../three/ground-gfx";
import { Ease } from "../three/tween";
import { AIR_H, type P3, type View } from "../three/view";
import { GUN_WEAPON, MOOR_POINTS, ZENITH_TOP, ZenithRig, zenithTeam, type ZenithGun, type ZenithPose } from "../three/zenith";
import type { Fx } from "./fx";

/**
 * The Zénith on the map (render only: it reads the sim and never writes it),
 * the République's counterpart of render/goliath.ts GoliathView. EntityRenderer
 * keeps one ZenithView per Zénith and feeds it every frame, exactly as it does
 * a GoliathView: update(u, gx, gy, dtMs, turnK, alpha, visible), fired(fx),
 * muzzle(fx), onFx(ev), marks(g, u, selected, ours), startFall() /
 * updateFall(dtMs), dispose().
 *
 * It cruises high (ZENITH_H), turning slowly with a gentle bob and roll. To
 * moor it slows its propellers, sinks to MOOR_H, pays out four cables and
 * drops its grapnels (dust and a thump as they bite), its build ring pulsing
 * out; moored it opens its hangar doors. Casting off reels them back in, with
 * steam. Weapons show per system: the Branly pods' coils lit blue, the bow
 * arc's ball, the bomb rack's lamp; a lost system goes dark, its guns sag,
 * smoke and sparks trail from it; a reboot relights it in flickers.
 * Destroyed, it noses down burning, slowly, and crashes in a long slam.
 *
 * What it reads from the sim is the plain, read-only shape ZenithSim (see
 * zenithSim() below: WP2's state, under `u.zenith` or, failing that, the
 * Goliath's `u.goliath`), so the sim can be finished independently.
 */

// ----------------------------------------------------------- sim contract ---

/** One weapon system as the sim keeps it (GoliathWeaponState's fields; all but `online` optional). */
export interface ZenithWeaponSim {
  /** Firing. False while lost to damage and through the reboot that brings it back. */
  online: boolean;
  /** Ticks left of the reboot that brings it back (−1 or absent: not rebooting). */
  reboot?: number;
  /** Tick it last fired (the guns train on `targetId` for a while after). */
  firedTick?: number;
}

/**
 * What the view needs of a Zénith's sim state. Either the Goliath's mode
 * machine (mode + modeTicks, ZENITH.anchorTime / packTime long), or the plain
 * fields `moored` and `mooring`: whichever the sim provides.
 */
export interface ZenithSim {
  /** "walking" = flying free, "anchoring" = mooring, "anchored" = moored, "packing" = casting off. */
  mode?: GoliathMode;
  /** Ticks left of a mooring or casting-off transition (with `mode`). */
  modeTicks?: number;
  /** Plain alternative to `mode`: moored (and producing). */
  moored?: boolean;
  /** Plain alternative to `modeTicks`: how far into the current mooring (or casting off, if `moored`) it is, 0–1; absent or 0: not moving. */
  mooring?: number;
  /** Per system; a system absent here is taken as lost below its ZENITH.weapons[k].lostBelow share of max HP. */
  weapons?: Partial<Record<ZenithWeapon, ZenithWeaponSim>>;
}

/** A Zénith's sim state as the view reads it: `u.zenith` if WP2 gives it its own, else `u.goliath`, else nothing. */
export function zenithSim(u: Unit): ZenithSim {
  const own = (u as Unit & { zenith?: ZenithSim }).zenith;
  return own ?? (u.goliath as ZenithSim | undefined) ?? {};
}

/** Its mode, and how far through a mooring or a casting off it is (0–1). */
export function zenithMode(z: ZenithSim, tickFrac = 0): { mode: GoliathMode; k: number } {
  if (z.mode) {
    if (z.mode !== "anchoring" && z.mode !== "packing") return { mode: z.mode, k: z.mode === "anchored" ? 1 : 0 };
    const total = Math.round((z.mode === "anchoring" ? ZENITH.anchorTime : ZENITH.packTime) * TICK_RATE);
    return { mode: z.mode, k: clamp01(1 - ((z.modeTicks ?? 0) + tickFrac) / total) };
  }
  const k = clamp01(z.mooring ?? 0);
  if (z.moored) return k > 0 && k < 1 ? { mode: "packing", k } : { mode: "anchored", k: 1 };
  return k > 0 ? { mode: k >= 1 ? "anchored" : "anchoring", k } : { mode: "walking", k: 0 };
}

/** The four systems, in the order they are lost. */
export const ZENITH_WEAPONS: readonly ZenithWeapon[] = ["branly", "arc", "bombs", "mg"];

/** System `k`: working (1), lost (0), or rebooting (its progress, 0–1, as a fraction strictly between). */
export function weaponState(u: Unit, z: ZenithSim, k: ZenithWeapon, tickFrac = 0): { online: boolean; reboot: number } {
  const w = z.weapons?.[k];
  if (!w) return { online: u.hp / UNITS.zenith.hp >= ZENITH.weapons[k].lostBelow, reboot: -1 };
  const r = w.reboot ?? -1;
  return { online: w.online, reboot: r >= 0 ? clamp01(1 - (r + tickFrac) / Math.round(ZENITH.reboot * TICK_RATE)) : -1 };
}

/** How far its working weapons reach (tiles): the threat ring. */
export function zenithReach(u: Unit, z: ZenithSim = zenithSim(u)): number {
  let r = 0;
  for (const k of ZENITH_WEAPONS) if (weaponState(u, z, k).online) r = Math.max(r, ZENITH.weapons[k].range);
  return r;
}

// ---------------------------------------------------------------- view ---

/** What the view needs from the entity renderer (GoliathHost's first four). */
export interface ZenithHost {
  v: View;
  world: World;
  fx: Fx;
  group: THREE.Group;
}

/** Team colours of rings on the ground. */
const TEAM: Record<Faction, number> = { blue: 0x3d8bff, red: 0xff4a3a };
/** Cruising and moored heights over the ground (tiles, at its axis). */
export const ZENITH_H = AIR_H + 0.75;
export const MOOR_H = 1.35;
/** The crash: nosing down and falling, lying burning, sinking away (ms). */
const FALL_MS = 2400;
const LIE_MS = 2600;
const SINK_MS = 1800;

const clamp01 = (k: number) => Math.max(0, Math.min(1, k));
const smooth = (a: number, b: number, x: number) => {
  const k = clamp01((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const tmp = new THREE.Vector3();
const at: P3 = { x: 0, y: 0, h: 0 };
function p3(v: THREE.Vector3, out = at): P3 {
  out.x = v.x;
  out.y = v.z;
  out.h = v.y;
  return out;
}

/** Which gun fires each weapon fx, taking turns where there are two. */
const FX_GUNS: Partial<Record<WeaponFx, [ZenithGun, ZenithGun]>> = {
  "arc-shell": ["branlyL", "branlyR"],
  shell: ["branlyL", "branlyR"],
  laser: ["arc", "arc"],
  bomb: ["bombs", "bombs"],
  mg: ["mgL", "mgR"]
};

/** The guns of each system (sparks and smoke come off them when it is lost). */
const SYSTEM_GUNS: Record<ZenithWeapon, ZenithGun[]> = {
  branly: ["branlyL", "branlyR"], arc: ["arc"], bombs: ["bombs"], mg: ["mgL", "mgR"]
};

export class ZenithView {
  readonly rig: ZenithRig;
  readonly faction: Faction;
  readonly id: number;
  gx: number;
  gy: number;
  /** Height of its axis (tiles), and its facing (sim-style: clockwise from north). */
  bh = 0;
  face: number;
  private aim = 0;
  /** Threat ring radius as drawn (eases as weapons go and come back). */
  reach: number;
  /** Shown: mooring (0 free … 1 moored), the hangar doors, each system's droop. */
  private moor = 0;
  private bay = 0;
  private mode: GoliathMode = "walking";
  private modeK = 0;
  ringFlash = 0;
  private lift = 0;
  private bank = 0;
  private pitch = 0;
  private side: Record<string, number> = {};
  private last: Partial<Record<WeaponFx, ZenithGun>> = {};
  private time = 0;
  private smokeT = 0;
  private sparkT = 0;
  private visible = true;
  private bitten = false;
  /** Rising out of its hangar: the offset from its spawn point and height, eased away. */
  private rollout: { dx: number; dy: number; dh: number; t: number; dur: number } | null = null;
  private fall: { t: number; sign: number; slammed: boolean; smokeT: number; vh: number } | null = null;
  private pose: ZenithPose = {
    dt: 0, props: 1, moor: 0, drop: 1, bay: 0, aim: 0,
    weapons: { branly: { lit: true, dead: 0 }, arc: { lit: true, dead: 0 }, bombs: { lit: true, dead: 0 }, mg: { lit: true, dead: 0 } }
  };

  constructor(
    private host: ZenithHost,
    u: Unit,
    /** It just left its hangar: it starts there, at (x, y), its axis at height h. */
    from: { x: number; y: number; h: number } | null = null
  ) {
    this.id = u.id;
    this.faction = u.faction;
    this.rig = new ZenithRig(zenithTeam(u.faction));
    this.rig.root.scale.setScalar(unitScale("zenith"));
    this.rig.j.body.rotation.order = "YXZ";
    clearOfFog(this.rig.root);
    this.gx = u.x;
    this.gy = u.y;
    this.face = u.facing;
    const z = zenithSim(u);
    this.reach = zenithReach(u, z);
    const m = zenithMode(z);
    this.mode = m.mode;
    // (one first seen moored is simply moored)
    if (m.mode === "anchored" || m.mode === "packing") this.moor = this.bay = this.modeK = 1;
    for (const k of ZENITH_WEAPONS) {
      const dead = weaponState(u, z, k).online ? 0 : 1;
      this.pose.weapons[k] = { lit: !dead, dead };
    }
    this.bh = this.cruise(u.x, u.y);
    if (from) {
      this.rollout = { dx: from.x - u.x, dy: from.y - u.y, dh: from.h - this.bh, t: 0, dur: 2600 };
      this.gx = from.x;
      this.gy = from.y;
      this.bh = from.h;
    }
    this.lift = this.bh;
    this.place();
  }

  get root(): THREE.Group {
    return this.rig.root;
  }

  /** Height (tiles) of its top above its axis point. */
  get top(): number {
    return ZENITH_TOP * this.rig.root.scale.x;
  }

  /** Its axis height at (x, y): cruising (over the surface, as aircraft fly), or down to its mooring height over the ground as it moors. */
  private cruise(x: number, y: number): number {
    const t = this.host.v.terrain;
    const free = t.surfaceAt(x, y) * 0.3 + ZENITH_H;
    return free + (t.groundAt(x, y) + MOOR_H - free) * smooth(0, 0.7, this.moor);
  }

  // ------------------------------------------------------------ events ---

  /** A shot is fired: the gun it leaves kicks (two-gun systems take turns). */
  fired(fx: WeaponFx): void {
    const pair = FX_GUNS[fx] ?? FX_GUNS.mg!;
    const i = (this.side[fx] = (this.side[fx] ?? 0) ^ 1);
    const gun = pair[i]!;
    this.last[fx] = gun;
    this.rig.kick(gun);
  }

  /** Where the last shot of this weapon left it (world tiles + height). */
  muzzle(fx: WeaponFx): P3 {
    const gun = this.last[fx] ?? (FX_GUNS[fx] ?? FX_GUNS.mg!)[0];
    this.rig.muzzle(gun, tmp);
    return { x: tmp.x, y: tmp.z, h: tmp.y };
  }

  /** Its sim events (WP2 may reuse the Goliath's: goliathMode, goliathWeapon with a ZenithWeapon name). */
  onFx(ev: FxEvent): void {
    if (!this.visible || !("id" in ev) || ev.id !== this.id) return;
    const fx = this.host.fx;
    if (ev.type === "goliathMode") {
      if (ev.mode === "anchored") {
        const R = ZENITH.buildRing;
        fx.ring(this.gx, this.gy, TEAM[this.faction], 0.6, R + 0.4, 900);
        this.host.v.tweens.after(160, () => fx.ring(this.gx, this.gy, TEAM[this.faction], 0.4, R, 1100, 0.7));
        this.ringFlash = 1;
      } else if (ev.mode === "packing") {
        for (let i = 0; i < 4; i++) fx.steam(p3(this.rig.hardpoint(i, tmp)), 2);
        fx.sound("packup", this.gx, this.gy);
      }
    } else if (ev.type === "goliathWeapon") {
      const k = ev.weapon as string as ZenithWeapon;
      const guns = SYSTEM_GUNS[k];
      if (!guns) return;
      for (const g of guns) {
        const p = p3(this.rig.muzzle(g, tmp));
        if (ev.state === "offline") {
          fx.sparks(p, 8);
          fx.flash(p, 0.6, 0xffc070, 0.8);
          fx.debris(p, 2);
        } else fx.flash(p, ev.state === "online" ? 0.7 : 0.4, ev.state === "online" ? 0xfff0c0 : 0x9fd8ff, 0.9);
      }
      fx.sound(ev.state === "offline" ? "offline" : "reboot", this.gx, this.gy);
    }
  }

  // ------------------------------------------------------------ per frame ---

  /**
   * Pose it for this frame: (gx, gy) is its interpolated sim position,
   * `alpha` how far between ticks the frame falls.
   */
  update(u: Unit, gx: number, gy: number, dtMs: number, turnK: number, alpha: number, visible: boolean): void {
    const w = this.host.world;
    const sec = dtMs / 1000;
    this.time += dtMs;
    this.visible = visible;
    const z = zenithSim(u);
    const tickFrac = 1 - alpha;
    if (this.rollout) {
      const r = this.rollout;
      r.t += dtMs;
      const k = Ease.sineInOut(clamp01(r.t / r.dur));
      gx += r.dx * (1 - k);
      gy += r.dy * (1 - k);
      if (r.t >= r.dur) this.rollout = null;
    }
    const moved = Math.hypot(gx - this.gx, gy - this.gy);
    this.gx = gx;
    this.gy = gy;
    const prevFace = this.face;
    // (a ship this size turns slowly)
    this.face += angleDelta(this.face, u.facing) * turnK * 0.45;

    // ---- mooring, from the sim's own timer
    const m = zenithMode(z, tickFrac);
    if (m.mode !== this.mode) {
      this.mode = m.mode;
      this.modeK = 0;
    }
    if (m.mode === "anchoring" || m.mode === "packing") this.modeK = Math.max(this.modeK, m.k);
    const target = m.mode === "anchored" ? 1 : m.mode === "anchoring" ? this.modeK : m.mode === "packing" ? 1 - this.modeK : 0;
    const before = this.moor;
    this.moor += (target - this.moor) * (1 - Math.exp(-sec * 8));
    this.bay += ((m.mode === "anchored" ? 1 : 0) - this.bay) * (1 - Math.exp(-sec * 2));
    this.ringFlash = Math.max(0, this.ringFlash - sec * 0.8);
    if (before < 0.95 && this.moor >= 0.95 && !this.bitten) {
      this.bitten = true;
      if (visible) this.anchorsBite();
    }
    if (this.moor < 0.5) this.bitten = false;

    // ---- weapons: lit, lost (sagging), or flickering back on a reboot
    let fired = -1;
    for (const k of ZENITH_WEAPONS) {
      const s = weaponState(u, z, k, tickFrac);
      const wp = this.pose.weapons[k];
      const deadT = s.online ? 0 : s.reboot >= 0 ? 1 - smooth(0.25, 1, s.reboot) : 1;
      wp.dead += (deadT - wp.dead) * (1 - Math.exp(-sec * 4));
      wp.lit = s.online || (s.reboot >= 0 && (this.time * 0.011 + Math.sin(this.time * 0.037)) % 1 < s.reboot * s.reboot);
      fired = Math.max(fired, z.weapons?.[k]?.firedTick ?? -1);
    }
    if (fired < 0) fired = u.firedTick;
    this.reach += (zenithReach(u, z) - this.reach) * (1 - Math.exp(-sec * 2.5));
    // the guns train on their target while it fights, then settle back to the bow
    const aimT = w.tick - fired > 25 ? 0 : angleDelta(u.facing, u.aim);
    this.aim += angleDelta(this.aim, -aimT) * turnK * 0.6;

    // ---- height: cruising, sinking to moor, rising out of its hangar
    const t = this.host.v.terrain;
    const ground = t.groundAt(gx, gy);
    let h = this.cruise(gx, gy) + Math.sin(this.time / 1300 + this.id) * 0.05 * (1 - this.moor * 0.6);
    if (this.rollout) h += this.rollout.dh * (1 - smooth(0, this.rollout.dur, this.rollout.t));
    this.lift += (h - this.lift) * (1 - Math.exp(-sec * 2));
    this.bh = this.lift;
    // banking into turns, a nose-down trim under way
    const turnRate = sec > 0 ? angleDelta(prevFace, this.face) / sec : 0;
    const speed = sec > 0 ? moved / sec : 0;
    const sk = 1 - Math.exp(-sec * 2.5);
    this.bank += (Math.max(-0.12, Math.min(0.12, -turnRate * 0.3)) - this.bank) * sk;
    this.pitch += (Math.max(-0.06, -speed * 0.03) - this.pitch) * sk;
    this.place();
    this.rig.j.body.rotation.set(this.pitch + Math.sin(this.time / 1700) * 0.012, 0, this.bank + Math.sin(this.time / 2100 + 1) * 0.015);

    // ---- the cables' full length: from the hardpoints down to the ground under them (model units)
    const s = this.rig.root.scale.x;
    const hp = MOOR_POINTS[0]![1];
    const pose = this.pose;
    pose.dt = dtMs;
    pose.props = 1 - 0.75 * this.moor;
    pose.moor = this.moor;
    pose.drop = Math.max(0.2, (this.bh - ground) / s + hp);
    pose.bay = this.bay;
    pose.aim = this.aim;
    this.rig.update(pose);
    if (!visible || dtMs <= 0) return;

    // ---- smoke and sparks off lost systems
    const fx = this.host.fx;
    this.smokeT -= dtMs;
    const lost = ZENITH_WEAPONS.filter((k) => pose.weapons[k].dead > 0.5);
    if (lost.length && this.smokeT <= 0) {
      const share = u.hp / UNITS.zenith.hp;
      this.smokeT = share < 0.25 ? 120 : 240;
      const k = lost[Math.floor(Math.random() * lost.length)]!;
      const guns = SYSTEM_GUNS[k];
      fx.buildingSmoke(p3(this.rig.muzzle(guns[Math.floor(Math.random() * guns.length)]!, tmp)), share < 0.25, true);
    }
    this.sparkT -= dtMs;
    if (lost.length && this.sparkT <= 0) {
      this.sparkT = 500 + Math.random() * 700;
      const guns = SYSTEM_GUNS[lost[Math.floor(Math.random() * lost.length)]!];
      fx.sparks(p3(this.rig.muzzle(guns[0]!, tmp)), 3);
    }
  }

  /** The grapnels bite: dust and a kick at each, a thump. */
  private anchorsBite(): void {
    const fx = this.host.fx;
    for (let i = 0; i < 4; i++) {
      const p = this.rig.anchorPoint(i, tmp);
      fx.kick(p.x, p.z, 2);
      fx.dust(p.x, p.z, 1);
    }
    fx.sound("anchor", this.gx, this.gy);
  }

  /** Root at the rendered point, turned to its facing. */
  private place(): void {
    this.rig.root.position.set(this.gx, this.bh, this.gy);
    this.rig.root.rotation.set(0, -this.face, 0);
  }

  // --------------------------------------------------------------- death ---

  /** It was destroyed: begin the crash (call updateFall every frame until it says it's done). */
  startFall(): void {
    if (this.fall) return;
    this.fall = { t: 0, sign: Math.random() < 0.5 ? -1 : 1, slammed: false, smokeT: 0, vh: 0 };
  }

  /** Nose down, burning, into the ground, then sinking away: true once it has gone (remove and dispose it then). */
  updateFall(dtMs: number): boolean {
    const f = this.fall!;
    const fx = this.host.fx;
    f.t += dtMs;
    const t = this.host.v.terrain;
    const ground = t.groundAt(this.gx, this.gy);
    const body = this.rig.j.body;
    const k = clamp01(f.t / FALL_MS);
    // nosing down and rolling a little as it goes, picking up speed
    body.rotation.set(-0.32 * smooth(0, 0.6, k), 0, 0.18 * f.sign * k);
    this.bh = Math.max(ground + 0.25, this.bh - (dtMs / 1000) * (0.3 + 1.6 * k * k));
    const sink = clamp01((f.t - FALL_MS - LIE_MS) / SINK_MS);
    this.rig.root.position.set(this.gx, this.bh - sink * sink * 1.2, this.gy);
    for (const w of ZENITH_WEAPONS) this.pose.weapons[w] = { lit: false, dead: 1 };
    this.pose.dt = dtMs;
    this.pose.props = Math.max(0, 1 - k * 2);
    this.pose.moor = 0;
    this.rig.update(this.pose);
    if (!this.visible) return sink >= 1;
    if (!f.slammed && (k >= 1 || this.bh <= ground + 0.26)) {
      f.slammed = true;
      const p = this.rig.point("body", [0, 0, -1.2], tmp);
      fx.slam(p.x, p.z, 2.6);
      this.host.v.tweens.after(120, () => fx.plume(p.x, p.z, t.surfaceAt(p.x, p.z) + 0.4, 1.3, 5));
      fx.sound("topple", p.x, p.z);
      setVariant(this.rig.root, "burnt");
      const cam = this.host.v.rig;
      if (cam.onScreen(p.x, p.z, 60)) cam.shake(520, 0.009);
    }
    f.smokeT -= dtMs;
    if (sink < 1 && f.smokeT <= 0) {
      f.smokeT = f.slammed ? 160 : 90;
      const p = p3(this.rig.point("body", [(Math.random() - 0.5) * 0.5, 0.3, (Math.random() - 0.5) * 2.6], tmp));
      fx.buildingSmoke(p, true, true);
      if (!f.slammed && Math.random() < 0.3) fx.sparks(p, 3);
    }
    return sink >= 1;
  }

  // --------------------------------------------------------------- marks ---

  /**
   * Its rings on the ground (drawn through the fog: it is always seen): the
   * build ring while moored, the threat ring at its reach, and a progress arc
   * under it while it moors or casts off.
   */
  marks(g: GroundGfx, u: Unit, selected: boolean, ours: boolean): void {
    if (this.fall) return;
    const x = this.gx;
    const y = this.gy;
    const team = TEAM[this.faction];
    const moored = smooth(0.7, 1, this.moor);
    if (moored > 0.02) {
      const R = ZENITH.buildRing;
      const flare = this.ringFlash;
      g.fillStyle(team, (ours ? 0.05 : 0.03) * moored + 0.08 * flare).fillCircle(x, y, R);
      g.lineStyle(1.6 + 2 * flare, team, ((ours ? 0.5 : 0.28) + 0.4 * flare) * moored, 0.4).strokeCircle(x, y, R);
    }
    if (this.reach > 0.1 && (selected || !ours)) {
      const n = 48;
      const turn = this.time * 0.00012;
      g.lineStyle(selected ? 1.6 : 1.2, ours ? 0xffffff : 0xff7a6a, selected ? 0.7 : 0.22, selected ? 0.4 : 0);
      for (let i = 0; i < n; i += 2) {
        const a0 = (i / n) * Math.PI * 2 + turn;
        g.arc(x, y, this.reach, a0, a0 + (Math.PI * 2) / n);
      }
    }
    const m = zenithMode(zenithSim(u));
    if (m.mode === "anchoring" || m.mode === "packing") {
      const r = 1.6;
      const k = this.modeK;
      const h = this.host.v.terrain.surfaceAt(x, y) + 0.05;
      const a0 = -Math.PI / 2;
      const a1 = a0 + Math.PI * 2 * k;
      g.lineStyle(7, 0x0c1016, 0.6, 0).strokeCircle(x, y, r, h);
      g.lineStyle(4.5, m.mode === "packing" ? 0xffb347 : team, 0.95, 0).arc(x, y, r, a0, a1, h + 0.005);
      g.fillStyle(0xffffff, 0.9).fillCircle(x + Math.cos(a1) * r, y + Math.sin(a1) * r, g.px(x, y) * 3.5, h + 0.01);
    }
  }

  /** Which system a gun belongs to (for tooltips and tests). */
  static weaponOf(gun: ZenithGun): ZenithWeapon {
    return GUN_WEAPON[gun];
  }

  dispose(): void {
    this.rig.root.removeFromParent();
  }
}
