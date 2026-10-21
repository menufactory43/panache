import * as THREE from "three";
import { GOLIATH, TICK_RATE, UNITS } from "../../sim/balance";
import { goliathReach, isSuperKind } from "../../sim/goliath";
import { unitTicks } from "../../sim/nations";
import { isStunned } from "../../sim/powers";
import { rulesOf } from "../../sim/rules";
import type { Building, Faction, FxEvent, GoliathMode, GoliathWeapon, Unit, WeaponFx, World } from "../../sim/types";
import { ModelBuilder } from "../three/builder";
import { GoliathRig, type GoliathGun, type GoliathPose } from "../three/goliath";
import { clearMat, clearOfFog, setVariant } from "../three/materials";
import { modelMesh, TRACK, unitScale, type ModelInstance } from "../three/models";
import type { GroundGfx } from "../three/ground-gfx";
import { Ease } from "../three/tween";
import type { P3, View } from "../three/view";
import type { Fx } from "./fx";

/**
 * The Goliath and its Gantry on the map (render only: it reads the sim and
 * never writes it). EntityRenderer keeps one GoliathView per Goliath and one
 * GantryView per Gantry and feeds them every frame.
 *
 * A Goliath walks on planted feet with dust at every footfall, its torso
 * twisting to whatever it shoots, each weapon kicking from its own muzzle.
 * Anchoring, it sinks on its hydraulics, splays its legs, swings out its
 * stabiliser spikes and drives them in (dust, a thump, a little shake), then
 * unfolds its hopper and crane while its build ring pulses out in team
 * colour; packing up runs the same in reverse with steam. Damage shows per
 * weapon: a smoking shoulder when the mortars are down, a dark eye when the
 * laser is, cannons hanging limp; a reboot relights the eye in flickers and
 * cycles the mortar tubes. Lifted, it hangs between its two Condors on four
 * cables, legs dangling. Destroyed, it staggers and topples, slams down in
 * a cloud of dust and shards, smoulders and sinks away.
 *
 * A Gantry shows its build to both sides, stage by stage (three/goliath.ts
 * GANTRY_STAGES): legs bolted to the cradle under welding sparks, the
 * hips and torso frame with the crane lowering armour plates in, the arm
 * cannons and mortars mounted, then the head (eye dark) and team panels with
 * steam venting and beacons blinking — and the scaffold arms swing clear as
 * the finished Goliath walks off the cradle.
 */

/** What the views need from the entity renderer. */
export interface GoliathHost {
  v: View;
  world: World;
  fx: Fx;
  /** The group the views' extra meshes (lift cables) go in. */
  group: THREE.Group;
  /** Another unit's rendered ground point and body height (a carrier Condor), or null. */
  unitPose(id: number): { gx: number; gy: number; bh: number; visible: boolean } | null;
}

/** Team colours of rings on the ground. */
const TEAM: Record<Faction, number> = { blue: 0x3d8bff, red: 0xff4a3a };
/** A carried Goliath hangs this high (tiles, its feet clear of the ground). */
export const LIFT_H = 0.55;
/** A Condor carrying a Goliath flies this far above the top of it (tiles). */
export const CARRY_CLEAR = 0.5;
/** The topple: staggering, falling, lying there smouldering, sinking away (ms of render time). */
const STAGGER_MS = 520;
const FALL_MS = 950;
const LIE_MS = 2600;
const SINK_MS = 1700;
/** Topple, from death to the slam (wrecks.ts throws the scrap piles out then). */
export const TOPPLE_SLAM_MS = STAGGER_MS + FALL_MS;
/**
 * Robot Love (ms): they turn to face each other, walk to meet, pause shyly,
 * then reach out — finale.ts LOVE_FINALE bursts the hearts as their arms
 * meet. Each stops this far (tiles) short of the point between them.
 */
const LOVE_TURN_MS = 900;
const LOVE_WALK_MS = 2000;
const LOVE_SHY_MS = 700;
const LOVE_REACH_MS = 700;
const LOVE_GAP = 1.05;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (k: number) => Math.max(0, Math.min(1, k));
const smooth = (a: number, b: number, x: number) => {
  const k = clamp01((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
/** Shortest signed angle from a to b. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
/** A point handed to the effects (they read it at once): reused. */
const at: P3 = { x: 0, y: 0, h: 0 };
function p3(v: THREE.Vector3, out = at): P3 {
  out.x = v.x;
  out.y = v.z;
  out.h = v.y;
  return out;
}

/** A lift cable: a unit-tall dark steel box, stretched between a Condor and a pauldron (shared, never disposed). */
let cableGeo: THREE.BufferGeometry | null = null;
function cable(): THREE.Mesh {
  if (!cableGeo) {
    const b = new ModelBuilder();
    b.box(1, 1, 1, [0, 0.5, 0], TRACK);
    cableGeo = b.build();
  }
  const m = modelMesh(cableGeo, false);
  m.userData.clear = true;
  m.material = clearMat("normal"); // (drawn over the fog, like the Goliath it holds up)
  return m;
}

/** How far weapon `k` of Goliath `u` is through its reboot (0–1, at the frame's fraction of a tick), or -1 if it isn't rebooting. */
function rebooted(u: Unit, k: GoliathWeapon, tickFrac: number): number {
  const ws = u.goliath!.weapons[k];
  return ws.reboot >= 0 ? clamp01(1 - (ws.reboot + tickFrac) / Math.round(GOLIATH.reboot * TICK_RATE)) : -1;
}

/** Which gun fires a weapon's shot, alternating left and right where it has two. */
const GUNS: Record<"cannon" | "pod" | "mg", [GoliathGun, GoliathGun]> = {
  cannon: ["cannonL", "cannonR"],
  pod: ["podL", "podR"],
  mg: ["mgL", "mgR"]
};

/** The stabiliser spikes' rods (their points bite the ground). */
const RODS = ["rodFL", "rodFR", "rodBL", "rodBR"] as const;

/** The topple in progress. */
interface Fall {
  t: number;
  /** It falls about this axis, round this point at a foot's edge (both in the rig's own space). */
  axis: THREE.Vector3;
  pivot: THREE.Vector3;
  sign: number;
  slammed: boolean;
  /** Came down over water or lava: no slam, it is swallowed. */
  liquid: boolean;
  smokeT: number;
}

// ------------------------------------------------------------ Goliath ---

export class GoliathView {
  readonly rig: GoliathRig;
  readonly faction: Faction;
  readonly id: number;
  /** Rendered ground point, body height (hanging under a lift: above the ground), hull and torso facing. */
  gx: number;
  gy: number;
  bh = 0;
  face: number;
  private aim: number;
  /** Threat ring radius as drawn: eases to its reach as weapons go and come back. */
  reach: number;
  /** Anchoring as shown: body lowered, spikes, hopper and crane (0–1 each). */
  private lower = 0;
  private spikes = 0;
  private unfold = 0;
  private mode: GoliathMode = "walking";
  /** How far into its current mode change (0–1, never backward), and where packing up started from. */
  private modeK = 0;
  private packFrom = { lower: 1, spikes: 1, unfold: 1 };
  /** The build ring's flare as it anchors (1 → 0). */
  ringFlash = 0;
  private eye = 1;
  private droop = 0;
  private pods = 0;
  private side = { cannon: 0, pod: 0, mg: 0 };
  private last: Partial<Record<WeaponFx, GoliathGun>> = {};
  /** Where its last mortar shell left (for the shell's arc), or null. */
  private shell: P3 = { x: 0, y: 0, h: 0 };
  private shellSet = false;
  /** Hanging height under a lift (tiles) and its fall speed when dropped. */
  private hangH = 0;
  private vy = 0;
  private dropping = false;
  /** Walking off its Gantry's cradle: the offset from its spawn point, eased away. */
  private rollout: { dx: number; dy: number; dh: number; t: number; dur: number } | null = null;
  /** ms since it rolled out (its eye lights up), -1 once done. */
  private boot = -1;
  private pitch = 0;
  private time = 0;
  private smokeT = 0;
  private sparkT = 0;
  private steamT = 0;
  private stepT = 0;
  private visible = true;
  private cables: THREE.Mesh[] = [];
  /** The Condors of its last lift: the cables stay on them while it eases down after a set-down. */
  private carriers: [number, number] | null = null;
  private fall: Fall | null = null;
  /** This frame's pose for the rig (reused, no per-frame garbage), and the ground under its feet. */
  private pose: GoliathPose = {
    dt: 0, speed: 0, lower: 0, spikes: 0, unfold: 0, yaw: 0, pitch: 0, droop: 0, pods: 0, eye: 1, hang: 0, crane: 0, look: 0
  };
  private ground = (x: number, z: number) => this.host.v.terrain.groundAt(x, z);
  /** Robot Love: walking to meet the one it fell for (render-driven: the sim has stopped at the draw). */
  private script: { t: number; x0: number; y0: number; x1: number; y1: number; f0: number; f1: number; heartT: number } | null = null;

  constructor(
    private host: GoliathHost,
    u: Unit,
    /** It just rolled out of a Gantry: it starts on the cradle at (x, y), standing at height h. */
    from: { x: number; y: number; h: number } | null
  ) {
    this.id = u.id;
    this.faction = u.faction;
    this.rig = new GoliathRig(u.faction);
    this.rig.root.scale.setScalar(unitScale("goliath"));
    clearOfFog(this.rig.root);
    this.rig.onStep = (_i, p) => this.footfall(p);
    this.gx = u.x;
    this.gy = u.y;
    this.face = this.aim = u.facing;
    this.reach = goliathReach(u);
    const g = u.goliath;
    if (g) {
      // (one seen first anchored, out of a fed match's skip or a Nomads start, is simply dug in)
      this.mode = g.mode;
      const settled = g.mode === "anchored" || g.mode === "packing" ? 1 : 0;
      this.lower = this.spikes = this.unfold = settled;
      this.droop = g.weapons.cannons.online ? 0 : 1;
      this.eye = g.weapons.laser.online ? 1 : 0;
      this.pods = g.weapons.mortars.online ? 0 : -0.45;
    }
    if (from) {
      const d = Math.hypot(u.x - from.x, u.y - from.y);
      const dh = from.h - host.v.terrain.groundAt(from.x, from.y);
      this.rollout = { dx: from.x - u.x, dy: from.y - u.y, dh, t: 0, dur: Math.max(1200, (d / 1.15) * 1000) };
      this.face = Math.atan2(u.x - from.x, -(u.y - from.y));
      this.boot = 0;
      this.eye = 0;
      this.gx = from.x;
      this.gy = from.y;
    }
    this.bh = host.v.terrain.groundAt(this.gx, this.gy) + (this.rollout?.dh ?? 0);
    this.place(this.gx, this.gy);
  }

  get root(): THREE.Group {
    return this.rig.root;
  }

  /** Height (tiles) of its top above its body point. */
  get top(): number {
    return GOLIATH_TOP * this.rig.root.scale.x;
  }

  // ------------------------------------------------------------ events ---

  /** A shot is fired: the gun it leaves kicks (two-gun weapons take turns). */
  fired(fx: WeaponFx): void {
    let gun: GoliathGun;
    if (fx === "laser") gun = "eye";
    else {
      const kind = fx === "shell" ? "pod" : fx === "heavy-cannon" || fx === "cannon" ? "cannon" : "mg";
      gun = GUNS[kind][this.side[kind]]!;
      this.side[kind] ^= 1;
    }
    this.last[fx] = gun;
    this.rig.kick(gun);
  }

  /** Where the last shot of this weapon left the Goliath (world tiles + height). */
  muzzle(fx: WeaponFx): P3 {
    const gun = this.last[fx] ?? (fx === "laser" ? "eye" : fx === "shell" ? "podL" : fx === "heavy-cannon" ? "cannonL" : "mgL");
    this.rig.muzzle(gun, tmp);
    const out = { x: tmp.x, y: tmp.z, h: tmp.y };
    if (fx === "shell") {
      this.shell.x = out.x;
      this.shell.y = out.y;
      this.shell.h = out.h;
      this.shellSet = true;
    }
    return out;
  }

  /** Where its latest mortar shell left its shoulder (for the shell's arc), or null. */
  shellFrom(): P3 | null {
    return this.shellSet ? this.shell : null;
  }

  /** Its sim events: anchoring and packing, weapons going and coming back, the lift. */
  onFx(ev: FxEvent): void {
    if (ev.type === "goliathLift" && ev.state === "dropped") {
      // a Condor went down: it falls off its cables
      this.dropping = true;
      this.vy = 0;
    }
    if (!this.visible) return;
    const fx = this.host.fx;
    const x = this.gx;
    const y = this.gy;
    if (ev.type === "goliathMode") {
      if (ev.mode === "anchored") {
        // the build ring pulses out across the ground in team colour
        const R = GOLIATH.buildRing;
        fx.ring(x, y, TEAM[this.faction], 0.6, R + 0.4, 900);
        this.host.v.tweens.after(160, () => fx.ring(x, y, TEAM[this.faction], 0.4, R, 1100, 0.7));
        this.ringFlash = 1;
      } else if (ev.mode === "packing") {
        // a blast of steam off its hydraulics, a clank as it unlocks
        for (const j of ["thighL", "thighR", "torso"] as const) fx.steam(p3(this.rig.point(j, [0, 0.1, 0.2], tmp)), 3);
        fx.sound("packup", x, y);
      } else if (ev.mode === "walking") {
        fx.dust(x, y, 2);
      }
    } else if (ev.type === "goliathWeapon") this.weaponFx(ev.weapon, ev.state);
    else if (ev.type === "goliathLift") {
      if (ev.state === "hooked") {
        fx.sound("hook", x, y);
        fx.wash(x, y, 4);
      } else if (ev.state === "setDown") {
        this.host.v.tweens.after(500, () => {
          fx.dust(this.gx, this.gy, 4);
          fx.sound("stomp", this.gx, this.gy, 0.9);
        });
      }
    }
  }

  /** A weapon went offline (sparks, a power-down), began to reboot, or came back. */
  private weaponFx(k: GoliathWeapon, state: "offline" | "rebooting" | "online"): void {
    const fx = this.host.fx;
    const pts = k === "laser" ? ["eye"] : k === "cannons" ? ["cannonL", "cannonR"] : k === "mortars" ? ["podL", "podR"] : [];
    for (const g of pts as GoliathGun[]) {
      const p = p3(this.rig.muzzle(g, tmp));
      if (state === "offline") {
        fx.sparks(p, 8);
        fx.flash(p, 0.6, 0xffc070, 0.8);
        fx.debris(p, 2);
      } else fx.flash(p, state === "online" ? 0.7 : 0.4, state === "online" ? 0xfff0c0 : 0x9fd8ff, 0.9);
    }
    if (state === "offline") fx.sound("offline", this.gx, this.gy);
    else if (state === "rebooting") fx.sound("reboot", this.gx, this.gy);
  }

  /** A foot came down: dust, a stomp, and the ground shakes a little under a close look. */
  private footfall(p: THREE.Vector3): void {
    if (!this.visible) return;
    const fx = this.host.fx;
    fx.dust(p.x, p.z, 2);
    fx.kick(p.x, p.z, 1);
    if (this.stepT <= 0) {
      this.stepT = 260;
      fx.sound("stomp", p.x, p.z, 0.55);
    }
    const rig = this.host.v.rig;
    if (rig.zoom > 64 && rig.onScreen(p.x, p.z, 40)) rig.shake(70, 0.0009);
  }

  /** Robot Love: it turns to face the Goliath at (px, py), walks to meet it near (mx, my), and falls in love. */
  love(mx: number, my: number, px: number, py: number): void {
    if (this.script || this.fall) return;
    const d = Math.hypot(px - this.gx, py - this.gy) || 1;
    const dx = (px - this.gx) / d;
    const dy = (py - this.gy) / d;
    this.rollout = null;
    this.script = {
      t: 0, x0: this.gx, y0: this.gy, x1: mx - dx * LOVE_GAP, y1: my - dy * LOVE_GAP,
      f0: this.face, f1: Math.atan2(dx, -dy), heartT: 0
    };
  }

  /** Back to following the sim (a replay rewound past the meeting). */
  endLove(): void {
    this.script = null;
  }

  /** Is it playing out Robot Love? */
  get inLove(): boolean {
    return this.script !== null;
  }

  /** Robot Love, frame by frame: turn, walk, a shy pause with a little dip, then arms out — eyes pink, hearts rising. */
  private loveScene(dtMs: number, visible: boolean): void {
    const s = this.script!;
    const sec = dtMs / 1000;
    s.t += dtMs;
    const t = s.t;
    const prevFace = this.face;
    this.face = s.f0 + angleDelta(s.f0, s.f1) * Ease.sineInOut(clamp01(t / LOVE_TURN_MS));
    const walk = Ease.sineInOut(clamp01((t - LOVE_TURN_MS) / LOVE_WALK_MS));
    const x = lerp(s.x0, s.x1, walk);
    const y = lerp(s.y0, s.y1, walk);
    const moved = Math.hypot(x - this.gx, y - this.gy);
    this.gx = x;
    this.gy = y;
    const shy = clamp01((t - LOVE_TURN_MS - LOVE_WALK_MS) / LOVE_SHY_MS);
    const reach = Ease.sineInOut(clamp01((t - LOVE_TURN_MS - LOVE_WALK_MS - LOVE_SHY_MS) / LOVE_REACH_MS));
    // stood up out of any anchoring, weapons forgotten; a little dip of the knees in the pause
    const ease = 1 - Math.exp(-sec * 6);
    this.lower += (0.3 * Math.sin(Math.PI * shy) - this.lower) * ease;
    this.spikes += (0 - this.spikes) * ease;
    this.unfold += (0 - this.unfold) * ease;
    this.droop += (0 - this.droop) * ease;
    this.pods += (0 - this.pods) * ease;
    this.hangH += (0 - this.hangH) * ease;
    const t3 = this.host.v.terrain;
    this.bh = t3.groundAt(x, y) + this.hangH;
    this.place(x, y);
    this.rig.j.body.rotation.set(0, 0, 0);
    const turn = sec > 0 ? Math.abs(angleDelta(prevFace, this.face)) / sec : 0;
    const p = this.pose;
    p.dt = dtMs;
    p.speed = sec > 0 ? moved / sec + turn * 0.5 : 0;
    p.lower = this.lower;
    p.spikes = this.spikes;
    p.unfold = this.unfold;
    p.yaw = 0;
    p.pitch = 0;
    p.droop = this.droop;
    p.pods = this.pods;
    p.eye = 1;
    p.hang = 0;
    p.crane = 0;
    p.look = 0;
    p.love = shy > 0.15 ? 1 : 0;
    p.hug = reach;
    p.nod = 0.32 * Math.sin(Math.PI * shy) * (1 - reach) - 0.12 * reach;
    p.ground = this.ground;
    this.rig.update(p);
    for (const c of this.cables) c.visible = false;
    if (!visible || dtMs <= 0 || shy <= 0) return;
    // the pink eye glows; hearts bubble up out of it, faster as its arms reach out
    if (p.love && Math.random() < dtMs / 120) this.host.fx.flash(p3(this.rig.muzzle("eye", tmp)), 0.55, 0xff5fa2, 0.7);
    s.heartT -= dtMs;
    if (s.heartT <= 0) {
      s.heartT = (110 + Math.random() * 90) * (1 - reach * 0.5);
      this.host.fx.hearts(p3(this.rig.point("head", [(Math.random() - 0.5) * 0.3, 0.38, 0], tmp)), 1 + (Math.random() < 0.4 ? 1 : 0));
      if (Math.random() < 0.5) this.host.fx.hearts(p3(this.rig.point("torso", [(Math.random() - 0.5) * 0.9, 0.8, 0.1], tmp)), 1);
    }
  }

  // ------------------------------------------------------------ per frame ---

  /**
   * Pose it for this frame: (gx, gy) is its interpolated sim position,
   * `alpha` how far between ticks the frame falls (sim timers run at
   * world.tick - 1 + alpha).
   */
  update(u: Unit, gx: number, gy: number, dtMs: number, turnK: number, alpha: number, visible: boolean): void {
    const w = this.host.world;
    const g = u.goliath!;
    const sec = dtMs / 1000;
    this.time += dtMs;
    this.stepT -= dtMs;
    this.visible = visible;
    if (this.script) {
      this.loveScene(dtMs, visible);
      return;
    }
    // walking off the cradle: start where it stood on the Gantry, blend to where the sim has it
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
    // (a giant turns slowly)
    this.face += angleDelta(this.face, u.facing) * turnK * 0.55;
    const frozen = isStunned(w, u.id);
    const tickFrac = frozen ? 0 : 1 - alpha;

    // ---- the torso tracks its target while it fights, then settles back over the hips
    const fired = Math.max(g.weapons.mg.firedTick, g.weapons.mortars.firedTick, g.weapons.laser.firedTick, g.weapons.cannons.firedTick);
    const aimTarget = w.tick - fired > 25 ? this.face : u.aim;
    this.aim += angleDelta(this.aim, aimTarget) * turnK * 0.5;
    const twist = Math.max(-1.3, Math.min(1.3, angleDelta(this.face, this.aim)));

    // ---- anchoring and packing, from the sim's own timer
    if (g.mode !== this.mode) {
      if (g.mode === "packing") this.packFrom = { lower: this.lower, spikes: this.spikes, unfold: this.unfold };
      this.mode = g.mode;
      this.modeK = 0;
    }
    if (g.mode === "anchoring" || g.mode === "packing") {
      const total = Math.round((g.mode === "anchoring" ? GOLIATH.anchorTime : GOLIATH.packTime) * TICK_RATE);
      this.modeK = Math.max(this.modeK, clamp01(1 - (g.modeTicks + tickFrac) / total));
    }
    const k = this.modeK;
    let tl = 0;
    let ts = 0;
    let tu = 0;
    if (g.mode === "anchoring") {
      tl = smooth(0, 0.4, k);
      ts = smooth(0.22, 0.62, k);
      tu = smooth(0.55, 0.95, k);
    } else if (g.mode === "anchored") tl = ts = tu = 1;
    else if (g.mode === "packing") {
      const f = this.packFrom;
      tu = Math.min(f.unfold, 1 - smooth(0, 0.35, k));
      ts = Math.min(f.spikes, 1 - smooth(0.3, 0.6, k));
      tl = Math.min(f.lower, 1 - smooth(0.55, 0.97, k));
    }
    const ease = 1 - Math.exp(-sec * 10);
    const spikesBefore = this.spikes;
    this.lower += (tl - this.lower) * ease;
    this.spikes += (ts - this.spikes) * ease;
    this.unfold += (tu - this.unfold) * ease;
    this.ringFlash = Math.max(0, this.ringFlash - sec * 0.8);

    // ---- weapons: limp cannons, a dark eye, sagging pods; a reboot brings each back as you watch
    const W = g.weapons;
    const cr = rebooted(u, "cannons", tickFrac);
    const droopT = W.cannons.online ? 0 : cr >= 0 ? 1 - smooth(0.25, 1, cr) : 1;
    this.droop += (droopT - this.droop) * (1 - Math.exp(-sec * 4));
    const mr = rebooted(u, "mortars", tickFrac);
    const podsT = W.mortars.online ? 0 : mr >= 0 ? lerp(-0.45, 0, mr) + 0.3 * Math.sin(mr * Math.PI * 4) : -0.45;
    this.pods += (podsT - this.pods) * (1 - Math.exp(-sec * (mr >= 0 ? 12 : 4)));
    const lr = rebooted(u, "laser", tickFrac);
    // (the eye flickers back to life as it reboots, lit more of the time as it goes)
    let eye = W.laser.online ? 1 : lr >= 0 ? ((this.time * 0.011 + Math.sin(this.time * 0.037)) % 1 < lr * lr ? 1 : 0) : 0;
    if (this.boot >= 0) {
      this.boot += dtMs;
      if (this.boot < 650) eye = 0;
      else if (this.boot - dtMs < 650 && visible) {
        // rolled out: its eye lights up
        const p = p3(this.rig.muzzle("eye", tmp));
        this.host.fx.flash(p, 0.9, 0xffc070, 1);
        this.host.fx.sound("rollout", this.gx, this.gy);
      }
      if (this.boot > 1500) this.boot = -1;
    }
    this.eye = eye;
    this.reach += (goliathReach(u) - this.reach) * (1 - Math.exp(-sec * 2.5));

    // ---- the lift: up off the ground on its cables, down again, or dropped
    const lift = g.lift;
    const carrying = lift?.phase === "carrying";
    if (this.dropping) {
      this.vy -= 9.8 * sec;
      this.hangH += this.vy * sec;
      if (this.hangH <= 0) {
        this.hangH = 0;
        this.dropping = false;
        if (visible) this.landed();
      }
    } else {
      const target = carrying ? LIFT_H : 0;
      this.hangH += (target - this.hangH) * (1 - Math.exp(-sec * (target > this.hangH ? 1.8 : 2.4)));
    }
    const hang = clamp01(this.hangH / 0.25);

    // ---- place it: on the ground (tilted to it), or hanging
    const t = this.host.v.terrain;
    const ground = t.groundAt(gx, gy);
    const fx = Math.sin(this.face);
    const fz = -Math.cos(this.face);
    const L = 0.7;
    const pitchT = Math.atan2(t.groundAt(gx + fx * L, gy + fz * L) - t.groundAt(gx - fx * L, gy - fz * L), L * 2) * 0.6;
    this.pitch += (pitchT - this.pitch) * (1 - Math.exp(-sec * 6));
    // (stepping down off the cradle)
    const step = this.rollout ? this.rollout.dh * (1 - smooth(0, 900, this.rollout.t)) : 0;
    this.bh = ground + this.hangH + step;
    this.place(gx, gy);
    const body = this.rig.j.body;
    body.rotation.set(Math.sin(this.time / 900) * 0.03 * hang, 0, Math.sin(this.time / 700) * 0.04 * hang);
    const turn = sec > 0 ? Math.abs(angleDelta(prevFace, this.face)) / sec : 0;
    const speed = sec > 0 ? moved / sec + turn * 0.5 : 0;
    const pose = this.pose;
    pose.dt = dtMs;
    pose.speed = hang > 0.5 ? 0 : speed;
    pose.lower = this.lower;
    pose.spikes = this.spikes;
    pose.unfold = this.unfold;
    pose.yaw = -twist;
    pose.pitch = this.pitch;
    pose.droop = this.droop;
    pose.pods = this.pods;
    pose.eye = this.eye;
    pose.hang = hang;
    pose.crane = Math.sin(this.time / 2600) * 0.6;
    pose.look = (1 - Math.min(1, speed)) * 0.35 * Math.sin(this.time / 1900) * (w.tick - fired > 25 ? 1 : 0);
    pose.ground = this.ground;
    this.rig.update(pose);
    if (lift) this.carriers = lift.carriers;
    else if (this.hangH <= 0.05) this.carriers = null;
    this.cablesTo(lift?.carriers ?? this.carriers, carrying || (!!this.carriers && this.hangH > 0.05));
    if (!visible || dtMs <= 0) return;

    // ---- one-shots and running effects
    const fxs = this.host.fx;
    if (g.mode === "anchoring" && spikesBefore < 0.88 && this.spikes >= 0.88) this.spikesIn();
    if (g.mode === "packing" && spikesBefore > 0.55 && this.spikes <= 0.55) {
      // spikes wrenched free
      for (const r of RODS) {
        const p = this.rig.point(r, [0, -0.7, 0], tmp);
        fxs.kick(p.x, p.z, 1);
      }
      fxs.sound("stomp", gx, gy, 0.6);
    }
    // steam off the hydraulics as it settles and rises
    const hydraulics = (g.mode === "anchoring" && k < 0.45) || g.mode === "packing";
    this.steamT -= dtMs;
    if (hydraulics && this.steamT <= 0) {
      this.steamT = g.mode === "packing" ? 110 + Math.random() * 90 : 220 + Math.random() * 120;
      const j = Math.random() < 0.5 ? "thighL" : "thighR";
      fxs.steam(p3(this.rig.point(j, [0, 0.12, 0.18], tmp)), 1);
      if (g.mode === "packing" && Math.random() < 0.4) fxs.steam(p3(this.rig.point("torso", [Math.random() - 0.5, 0.55, 0.5], tmp)), 1);
    }
    // a smoking shoulder (mortars down), sparks off limp arms and a dead eye; burning when near death
    this.smokeT -= dtMs;
    if (!W.mortars.online && this.smokeT <= 0) {
      const share = u.hp / UNITS.goliath.hp;
      this.smokeT = share < 0.25 ? 120 : 220;
      const pod = Math.random() < 0.5 ? "podL" : "podR";
      fxs.buildingSmoke(p3(this.rig.point(pod, [0, 0.3, 0.1], tmp)), share < 0.25, true);
    }
    this.sparkT -= dtMs;
    if (this.sparkT <= 0 && (!W.cannons.online || !W.laser.online)) {
      this.sparkT = 500 + Math.random() * 700;
      const gun: GoliathGun = !W.laser.online && (W.cannons.online || Math.random() < 0.4) ? "eye" : Math.random() < 0.5 ? "cannonL" : "cannonR";
      fxs.sparks(p3(gun === "eye" ? this.rig.muzzle("eye", tmp) : this.rig.point(gun, [0, 0, 0.05], tmp)), 3);
    }
  }

  /** Root at the rendered point, turned to its facing. */
  private place(gx: number, gy: number): void {
    this.rig.root.position.set(gx, this.bh, gy);
    this.rig.root.rotation.set(0, -this.face, 0);
  }

  /** Its spikes bite: a thump, dirt thrown out at each, a small shake. */
  private spikesIn(): void {
    const fx = this.host.fx;
    for (const r of RODS) {
      const p = this.rig.point(r, [0, -0.75, 0], tmp);
      fx.kick(p.x, p.z, 2);
      fx.dust(p.x, p.z, 1);
    }
    fx.sound("anchor", this.gx, this.gy);
    const rig = this.host.v.rig;
    if (rig.onScreen(this.gx, this.gy, 40)) rig.shake(150, 0.003);
  }

  /** Dropped off its lift onto land: a heavy landing. */
  private landed(): void {
    const fx = this.host.fx;
    fx.slam(this.gx, this.gy, 2);
    fx.sound("topple", this.gx, this.gy, 0.7);
    const rig = this.host.v.rig;
    if (rig.onScreen(this.gx, this.gy, 40)) rig.shake(260, 0.006);
  }

  /** The cables from each carrier Condor's belly to its pauldron, two a side (hidden when there's no lift). */
  private cablesTo(carriers: [number, number] | null, show: boolean): void {
    if (!show || !carriers || !this.visible) {
      for (const c of this.cables) c.visible = false;
      return;
    }
    while (this.cables.length < 4) {
      const c = cable();
      this.host.group.add(c);
      this.cables.push(c);
    }
    for (let side = 0; side < 2; side++) {
      const cp = this.host.unitPose(carriers[side]!);
      for (let n = 0; n < 2; n++) {
        const c = this.cables[side * 2 + n]!;
        if (!cp) {
          c.visible = false;
          continue;
        }
        this.rig.point(side ? "shoulderR" : "shoulderL", [side ? 0.1 : -0.1, 0.24, n ? 0.16 : -0.16], tmp);
        // (a Condor out of sight has no height on show: where it would fly, above the Goliath)
        tmp2.set(cp.gx, (cp.visible ? cp.bh : this.bh + this.top + CARRY_CLEAR) - 0.08, cp.gy);
        const len = tmp.distanceTo(tmp2);
        c.visible = len > 0.05;
        c.position.copy(tmp);
        c.quaternion.setFromUnitVectors(UP, tmp2.sub(tmp).normalize());
        c.scale.set(0.03, len, 0.03);
      }
    }
  }

  // --------------------------------------------------------------- death ---

  /** It was destroyed: begin the topple (call updateFall every frame until it says it's done). */
  startFall(): void {
    if (this.fall) return;
    // it falls across the screen (east or west, a little toward the camera), where a fall reads best:
    // over the edge of a foot, about the axis square to that way (taken into its own turned space)
    const sign = Math.random() < 0.5 ? -1 : 1;
    const d = new THREE.Vector3(sign, 0, 0.35).normalize();
    const own = new THREE.Quaternion().setFromAxisAngle(UP, this.face);
    const axis = new THREE.Vector3(d.z, 0, -d.x).applyQuaternion(own);
    const pivot = d.clone().multiplyScalar(0.6).applyQuaternion(own);
    this.fall = { t: 0, axis, sign, pivot, slammed: false, liquid: false, smokeT: 0 };
    for (const c of this.cables) c.visible = false;
    if (this.hangH > 0.05) this.dropping = true;
  }

  /** Topple and sink: true once it has gone (remove and dispose it then). */
  updateFall(dtMs: number): boolean {
    const f = this.fall!;
    const fx = this.host.fx;
    const sec = dtMs / 1000;
    const t = this.host.v.terrain;
    // still dropping off a lift: down it comes first
    if (this.dropping) {
      this.vy -= 9.8 * sec;
      this.hangH = Math.max(0, this.hangH + this.vy * sec);
      if (this.hangH <= 0) {
        this.dropping = false;
        f.liquid = fx.liquid(this.gx, this.gy);
        if (f.liquid && this.visible) fx.splash(this.gx, this.gy, 14);
      }
      this.bh = t.groundAt(this.gx, this.gy) + this.hangH;
      this.place(this.gx, this.gy);
      this.rig.update(this.deadPose(dtMs, 1, 1));
      return false;
    }
    f.t += dtMs;
    const body = this.rig.j.body;
    if (f.liquid) {
      // swallowed: it tips and goes under
      const k = clamp01(f.t / SINK_MS);
      body.rotation.set(0.4 * k, 0, 0.6 * k * f.sign);
      body.position.set(0, -3.2 * k * k, 0);
      if (this.visible && Math.random() < dtMs / 120) fx.splash(this.gx + (Math.random() - 0.5), this.gy + (Math.random() - 0.5), 2);
      this.rig.update(this.deadPose(dtMs, 1, 0));
      return k >= 1;
    }
    // staggering: knees buckling, sparks and small blasts across its body
    const stagger = clamp01(f.t / STAGGER_MS);
    if (f.t < STAGGER_MS && this.visible && Math.random() < dtMs / 90) {
      const j = (["torso", "shoulderL", "shoulderR", "pelvis"] as const)[Math.floor(Math.random() * 4)]!;
      const p = p3(this.rig.point(j, [(Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4], tmp));
      fx.sparks(p, 5);
      fx.flash(p, 0.5, 0xffb347, 0.7);
    }
    // then over it goes, round a foot's edge, faster and faster
    const fk = clamp01((f.t - STAGGER_MS) / FALL_MS);
    const angle = (Math.PI / 2 - 0.1) * fk * fk;
    body.quaternion.setFromAxisAngle(f.axis, angle);
    // (round the pivot: the body moves so the pivot stays put)
    tmp.copy(f.pivot).applyQuaternion(body.quaternion);
    body.position.copy(f.pivot).sub(tmp);
    // lying there, then sinking away
    const sink = clamp01((f.t - STAGGER_MS - FALL_MS - LIE_MS) / SINK_MS);
    body.position.y -= sink * sink * 1.6;
    this.rig.update(this.deadPose(dtMs, stagger, 0));
    if (!f.slammed && fk >= 1) {
      f.slammed = true;
      if (this.visible) this.slam();
    }
    if (f.slammed && sink < 1 && this.visible) {
      f.smokeT -= dtMs;
      if (f.smokeT <= 0) {
        const lie = clamp01((f.t - STAGGER_MS - FALL_MS) / LIE_MS);
        f.smokeT = 140 + lie * 260;
        fx.buildingSmoke(p3(this.rig.point("torso", [(Math.random() - 0.5) * 0.6, 0.6, (Math.random() - 0.5) * 0.4], tmp)), lie < 0.5, true);
      }
    }
    return sink >= 1;
  }

  /** How a dead Goliath holds itself: knees going, arms limp, eye out. */
  private deadPose(dtMs: number, slump: number, hang: number): GoliathPose {
    const p = this.pose;
    p.dt = dtMs;
    p.speed = 0;
    p.lower = 0.55 * slump;
    p.yaw = p.pitch = p.crane = p.look = p.eye = 0;
    p.droop = 1;
    p.pods = -0.45 * slump;
    p.hang = hang;
    p.ground = undefined;
    return p;
  }

  /** It hits the ground: the slam, a column of smoke, a crash, the camera jolts. */
  private slam(): void {
    const fx = this.host.fx;
    const p = this.rig.point("torso", [0, 0.4, 0], tmp);
    fx.slam(p.x, p.z, 2.6);
    this.host.v.tweens.after(120, () => fx.plume(p.x, p.z, this.host.v.terrain.surfaceAt(p.x, p.z) + 0.4, 1.3, 5));
    fx.sound("topple", p.x, p.z);
    setVariant(this.rig.root, "burnt");
    const rig = this.host.v.rig;
    if (rig.onScreen(p.x, p.z, 60)) rig.shake(520, 0.009);
  }

  // --------------------------------------------------------------- marks ---

  /**
   * Its rings on the ground (drawn through the fog: it is always seen): the
   * threat ring at its reach (strong when selected, faint for an enemy's),
   * the build ring in team colour while dug in, and a progress arc round
   * its feet while it anchors or packs up.
   */
  marks(g: GroundGfx, u: Unit, selected: boolean, ours: boolean): void {
    const goliath = u.goliath;
    // (in love, nothing of the fight or the dig: no rings, no progress arc)
    if (!goliath || this.fall || this.script) return;
    const x = this.gx;
    const y = this.gy;
    const team = TEAM[this.faction];
    // the build ring: where outposts may go up
    const dug = this.lower * this.spikes;
    if (dug > 0.02) {
      const R = GOLIATH.buildRing;
      const flare = this.ringFlash;
      g.fillStyle(team, (ours ? 0.05 : 0.03) * dug + 0.08 * flare).fillCircle(x, y, R);
      g.lineStyle(1.6 + 2 * flare, team, ((ours ? 0.5 : 0.28) + 0.4 * flare) * dug, 0.4).strokeCircle(x, y, R);
    }
    // the threat ring: dashes at its reach, shrinking as weapons go
    if (this.reach > 0.1 && (selected || !ours)) {
      const a = selected ? 0.7 : 0.22;
      const n = 48;
      const turn = this.time * 0.00012;
      g.lineStyle(selected ? 1.6 : 1.2, ours ? 0xffffff : 0xff7a6a, a, selected ? 0.4 : 0);
      for (let i = 0; i < n; i += 2) {
        const a0 = (i / n) * Math.PI * 2 + turn;
        g.arc(x, y, this.reach, a0, a0 + (Math.PI * 2) / n);
      }
    }
    // digging in or packing up: a progress arc round its feet
    if (goliath.mode === "anchoring" || goliath.mode === "packing") {
      const r = 1.45;
      const k = this.modeK;
      const h = this.host.v.terrain.surfaceAt(x, y) + 0.05;
      const a0 = -Math.PI / 2;
      const a1 = a0 + Math.PI * 2 * k;
      g.lineStyle(7, 0x0c1016, 0.6, 0).strokeCircle(x, y, r, h);
      g.lineStyle(4.5, goliath.mode === "packing" ? 0xffb347 : team, 0.95, 0).arc(x, y, r, a0, a1, h + 0.005);
      g.fillStyle(0xffffff, 0.9).fillCircle(x + Math.cos(a1) * r, y + Math.sin(a1) * r, g.px(x, y) * 3.5, h + 0.01);
    }
  }

  dispose(): void {
    for (const c of this.cables) this.host.group.remove(c);
    this.cables = [];
  }
}

/** The Goliath's height above its root (model units): bars and labels sit above it. */
const GOLIATH_TOP = 2.55;

// ------------------------------------------------------------- Gantry ---

/** The crane's stops: the plate rack and over the cradle (slew from the mast, trolley out along the jib, hook drop). */
const RACK = { slew: Math.atan2(0.35, 0.4), r: Math.hypot(0.35, 0.4), drop: 3.36 };
const MECH = { slew: Math.atan2(1.3, -0.77), r: Math.hypot(1.3, 0.77) };
/** The cradle's deck and the crane's jib above the pad (tiles), and the top of the half-built mech at each stage (model units). */
const CRADLE_H = 0.285;
const JIB_H = 3.84;
const STAGE_TOP = [1.3, 2.2, 2.45, 2.55];
/** The welding arms' clear swing (rad). */
const ARMS_CLEAR = 1.45;
/** Rollout beats (ms): arms swing clear, hold while it walks off, swing back. */
const ROLL_OPEN = 700;
const ROLL_HOLD = 3200;
const ROLL_CLOSE = 1300;

/**
 * A Gantry: its build stages, crane and welding, lights and steam (both
 * sides see it: the enemy always does). See GoliathView's header.
 */
export class GantryView {
  /** Build progress shown (0–1, never backward within a build) and which build it was. */
  private k = 0;
  private head: object | null = null;
  private stage = -1;
  /** Its own clock for the crane and the welding: stopped while it's EMP'd or the game is paused. */
  private work = 0;
  /** ms since a Goliath rolled out (-1: none). */
  private roll = -1;
  private weldT = 0;
  private steamT = 0;
  private craneOut = 0;
  private plateOn = false;
  /** Shown once already (a stage first seen mid-build goes up without a shower). */
  private shown = false;

  constructor(
    private host: GoliathHost,
    private m: ModelInstance,
    private b: Building,
    private cx: number,
    private cy: number,
    private base: number
  ) {
    clearOfFog(m.root);
    m.parts.jib!.rotation.order = "YXZ";
    this.show(-1);
  }

  /** Where a Goliath stands on the cradle (tiles, height on the deck). */
  get cradle(): { x: number; y: number; h: number } {
    return { x: this.cx, y: this.cy, h: this.base + CRADLE_H };
  }

  /** A Goliath just walked off it. */
  rollout(): void {
    this.roll = 0;
    this.show(-1);
  }

  /** Show the half-built mech of stage `i` (-1: an empty cradle). */
  private show(i: number): void {
    for (let s = 0; s < 4; s++) {
      const p = this.m.parts[`stage${s}`];
      if (p) p.visible = s === i;
    }
    this.stage = i;
  }

  update(b: Building, dtMs: number, alpha: number, visible: boolean): void {
    const w = this.host.world;
    const P = this.m.parts;
    const stunned = isStunned(w, b.id);
    if (!stunned) this.work += dtMs;
    // ---- build progress, at the frame's fraction of a tick (held still while it's EMP'd)
    const head = b.queue[0];
    const building = !!head && isSuperKind(head.kind);
    if (building) {
      if (head !== this.head) {
        this.head = head;
        this.k = 0;
      }
      const total = unitTicks(w, b.faction, head.kind);
      const ahead = stunned ? 0 : rulesOf(w).buildSpeed * (1 - alpha);
      this.k = Math.max(this.k, clamp01(1 - (head.remaining + ahead) / total));
    } else this.head = null;
    const stage = building ? Math.min(3, Math.floor(this.k * 4)) : -1;
    if (stage !== this.stage) {
      const fresh = stage > this.stage && stage >= 0 && this.shown;
      this.show(stage);
      // (a stage goes on in a shower of sparks)
      if (fresh && visible && !stunned) for (let i = 0; i < 4; i++) this.weld(true);
    }
    this.shown = true;
    // ---- rollout: the arms swing clear while it walks off, then back
    let open = 0;
    if (this.roll >= 0) {
      this.roll += dtMs;
      const r = this.roll;
      open = r < ROLL_OPEN ? Ease.sineInOut(r / ROLL_OPEN) : r < ROLL_HOLD ? 1 : 1 - Ease.sineInOut(clamp01((r - ROLL_HOLD) / ROLL_CLOSE));
      if (r > ROLL_HOLD + ROLL_CLOSE) this.roll = -1;
    }
    const nod = building && stage <= 2 ? Math.sin(this.work / 700) * 0.12 : 0;
    P.armL!.rotation.y = open * ARMS_CLEAR + nod;
    P.armR!.rotation.y = open * ARMS_CLEAR - nod;
    // ---- floor lights on while it works; beacons blink while it's finishing
    const lit = building || this.roll >= 0;
    P.lightsOn!.visible = lit;
    P.lightsOff!.visible = !lit;
    P.blink!.visible = (building && stage === 3 && this.work % 900 < 450) || (this.roll >= 0 && this.roll % 500 < 250);
    // ---- the crane: folded up when idle, working the plates from the rack to the cradle while it builds
    const working = building && stage <= 2;
    this.craneOut += ((working ? 1 : 0) - this.craneOut) * (1 - Math.exp(-(dtMs / 1000) * 1.5));
    const jib = P.jib!;
    const c = (this.work / 6000) % 1;
    // the cycle: out to the rack and down, up with a plate, over the cradle, down onto the mech, up empty
    const toMech = c < 0.3 ? 0 : c < 0.55 ? Ease.sineInOut((c - 0.3) / 0.25) : c < 0.85 ? 1 : 1 - Ease.sineInOut((c - 0.85) / 0.15);
    const slew = lerp(RACK.slew, MECH.slew, toMech);
    const r = lerp(RACK.r, MECH.r, toMech);
    // (the plate comes down just over the top of what's built so far)
    const mechTop = CRADLE_H + unitScale("goliath") * STAGE_TOP[Math.max(0, stage)]!;
    const dropTo = lerp(RACK.drop, JIB_H - mechTop - 0.35, toMech);
    const dip = c < 0.3 ? Math.sin((c / 0.3) * Math.PI) : c >= 0.55 && c < 0.85 ? Math.sin(((c - 0.55) / 0.3) * Math.PI) : 0;
    const drop = lerp(0.4, dropTo, dip * 0.85 + 0.15);
    // (parked, the jib lies along the east tower; working, it slews out over the pad)
    jib.rotation.set(0.03 * (1 - this.craneOut), lerp(Math.PI, slew, this.craneOut), 0);
    const hookOut = this.craneOut > 0.85;
    P.cable!.visible = P.hook!.visible = hookOut;
    P.cable!.position.set(0, 0, -r);
    P.cable!.scale.set(1, drop, 1);
    P.hook!.position.set(0, -drop, -r);
    const carrying = hookOut && c > 0.15 && c < 0.75;
    P.plate!.visible = carrying;
    if (this.plateOn && !carrying && c >= 0.7 && visible) {
      // the plate goes on: a flash of welding where it fits
      this.weld(true);
    }
    this.plateOn = carrying;
    if (!visible || dtMs <= 0 || stunned) return;
    // ---- welding sparks on the mech while the early stages go up; steam while it's finishing
    if (building && stage <= 2) {
      this.weldT -= dtMs;
      if (this.weldT <= 0) {
        this.weldT = 110 + Math.random() * 220;
        this.weld(false);
      }
    }
    if (building && stage === 3) {
      this.steamT -= dtMs;
      if (this.steamT <= 0) {
        this.steamT = 160 + Math.random() * 200;
        const s = unitScale("goliath");
        const sx = (Math.random() < 0.5 ? -0.45 : 0.45) * s;
        this.host.fx.steam({ x: this.cx + sx, y: this.cy + 0.3 * (this.b.faction === "red" ? 1 : -1), h: this.base + CRADLE_H + 1.9 * s }, 1);
      }
    }
  }

  /** A welding arc somewhere on the mech as far as it's built (`loud`: a bigger shower, a hiss). */
  private weld(loud: boolean): void {
    const s = unitScale("goliath");
    const top = STAGE_TOP[Math.max(0, this.stage)]! * 0.9;
    const h = this.base + CRADLE_H + (0.2 + Math.random() * (top - 0.2)) * s;
    const side = Math.random() < 0.5 ? -1 : 1;
    const p = { x: this.cx + side * (0.25 + Math.random() * 0.4) * s, y: this.cy + (Math.random() - 0.5) * 0.5 * s, h };
    this.host.fx.weld(p, loud ? 9 : 4);
    if (loud || Math.random() < 0.15) this.host.fx.sound("weld", p.x, p.y, loud ? 0.7 : 0.4);
  }
}
