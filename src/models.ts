// Standalone 3D models page (models.html): every unit's card (unit-info.ts)
// beside its in-game model, which you can turn and zoom and play through its
// animations: the same models (three/models.ts) and rigs (three/infantry.ts,
// three/goliath.ts) the battlefield draws, posed the way render/entities.ts
// and render/goliath.ts pose them.
//
// One WebGL renderer draws every viewer in sight, one after another, each
// copied into its own 2D canvas: a page of sixteen WebGL contexts would hit
// the browser's limit (and phones run out sooner).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GantryView, type GoliathHost } from "./game/render/goliath";
import {
  buildingDef, chuteGeometry, CRAWLER_LEGS, crateDef, instance, landmarkDef, modelMesh, rubbleGeometry, unitDef, unitScale, uplinkDef
} from "./game/three/models";
import { MOOR_POINTS, ZENITH_REST, ZenithRig, zenithTeam, type ZenithGun, type ZenithPose } from "./game/three/zenith";
import { portraitKind } from "./game/three/belle/placeholders";
import { GoliathRig, type GoliathGun, type GoliathPose } from "./game/three/goliath";
import { baySeats, SquadRig, type BotKind } from "./game/three/infantry";
import { discMat, fowUniforms, glowMat, setVariant } from "./game/three/materials";
import { SUN_DIR } from "./game/three/stage";
import { discTexture } from "./game/three/textures";
import { Ease } from "./game/three/tween";
import { HOVER_H } from "./game/three/view";
import { BUILDINGS, GOLIATH, TICK_RATE, UNITS, ZENITH } from "./sim/balance";
import { behaves } from "./sim/nations";
import type { Building, BuildingKind, Faction, Nation, NationOrClassic, UnitKind } from "./sim/types";
import { buildingGroups, card, rowId, siteCard, siteName, unitGroups, type SiteKind } from "./unit-info";

/**
 * A model on its pad, and how it plays each of its animations. `step` poses
 * it `t` seconds into animation `anim` (`dt` since the last frame) and says
 * how fast it is going (tiles/s, x east and z south), for the pad to scroll
 * under it: the model stays at the centre, so moving means the ground moves.
 */
interface Model {
  root: THREE.Object3D;
  /** Its animations, the one it opens on first. */
  anims: string[];
  step(anim: string, t: number, dt: number): [number, number];
  dispose?(): void;
  /** Belongs to no side: no Blue/Red buttons. */
  neutral?: boolean;
}

const BOTS: BotKind[] = ["trooper", "rocket-squad", "sniper", "sapeurs", "fusiliers", "carabiniers"];
/** The army a model is shown for: a nation paints shared kinds in its colours (three/models.ts unitDef `owner`). */
type Army = NationOrClassic;
const owned = (n: Army): Nation | undefined => (n === "classique" ? undefined : n);
const LASER_TINT: Record<Faction, number> = { blue: 0x7fd4ff, red: 0xff6a4a }; // (render/fx.ts)
const FLASH = 0xffd27a;
// the Flak Crawler's gait (render/entities.ts): stride length (tiles), swing (rad), foot lift
const LEG_CYCLE = 0.6;
const LEG_SWING = 0.32;
const LEG_LIFT = 0.07;
/** How high aircraft hover over the pad (the map's AIR_H, brought down so they stay in the frame with their shadow). */
const AIR_Y = 0.75;

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const v3 = new THREE.Vector3();
const fwd = new THREE.Vector3();
const quat = new THREE.Quaternion();
const buf = new THREE.Vector2();

/** Muzzle flashes, laser beams, welding sparks, smoke and floating hearts: short-lived sprites in a viewer's scene. */
class Glows {
  readonly group = new THREE.Group();
  private live: { o: THREE.Object3D; mat: THREE.Material; life: number; age: number; rise: number; grow: number; alpha: number; late: boolean }[] = [];
  private static beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5);

  /** A soft flash at `at`, `size` tiles across; `rise` (tiles/s) floats it up, fading late (a heart). */
  flash(at: THREE.Vector3, size: number, tint = FLASH, life = 0.09, rise = 0): void {
    const mat = new THREE.SpriteMaterial({
      map: discTexture(), color: tint, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    this.sprite(mat, at, size, { life, rise, grow: rise ? 0 : 6, alpha: 1, late: rise > 0 });
  }

  /** A puff of smoke (or dust, or steam) at `at`, drifting up and spreading as it fades. */
  smoke(at: THREE.Vector3, size: number, tint: number, alpha = 0.55, life = 1.6): void {
    const mat = new THREE.SpriteMaterial({ map: discTexture(), color: tint, depthWrite: false, transparent: true });
    this.sprite(mat, at, size, { life, rise: 0.45, grow: 0.9, alpha, late: false });
  }

  /** A laser beam from `at` along `dir` (unit), `len` tiles. */
  beam(at: THREE.Vector3, dir: THREE.Vector3, len: number, tint: number, width = 0.025): void {
    const mat = glowMat(tint, 0.9);
    const m = new THREE.Mesh(Glows.beamGeo, mat);
    m.position.copy(at);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    m.scale.set(width, width, len);
    this.add(m, mat, { life: 0.14, rise: 0, grow: 0, alpha: 0.9, late: false });
    this.flash(at, width * 9, tint, 0.12);
  }

  private sprite(mat: THREE.SpriteMaterial, at: THREE.Vector3, size: number, o: { life: number; rise: number; grow: number; alpha: number; late: boolean }): void {
    const s = new THREE.Sprite(mat);
    s.position.copy(at);
    s.scale.setScalar(size);
    this.add(s, mat, o);
  }

  private add(o: THREE.Object3D, mat: THREE.Material, g: { life: number; rise: number; grow: number; alpha: number; late: boolean }): void {
    this.group.add(o);
    this.live.push({ o, mat, age: 0, ...g });
  }

  update(dt: number): void {
    this.live = this.live.filter((g) => {
      g.age += dt;
      const k = g.age / g.life;
      if (k >= 1) {
        this.group.remove(g.o);
        g.mat.dispose();
        return false;
      }
      g.mat.opacity = g.alpha * (g.late ? Math.min(1, (1 - k) * 2.5) : 1 - k);
      g.o.position.y += g.rise * dt;
      if (g.grow) g.o.scale.multiplyScalar(1 + g.grow * dt);
      return true;
    });
  }

  clear(): void {
    for (const g of this.live) {
      this.group.remove(g.o);
      g.mat.dispose();
    }
    this.live = [];
  }
}

/** Fires on a clock: true once every `every` seconds of `t`, starting at once. */
function shots(): (t: number, every: number) => boolean {
  let next = 0;
  return (t, every) => {
    if (t < next - every) next = 0; // the animation restarted
    if (t < next) return false;
    next = Math.max(next + every, t);
    return true;
  };
}

/** Any unit but the squads, the Condor and the Goliath: hulls, turrets, rotors, legs. */
function vehicle(kind: UnitKind, f: Faction, glows: Glows, nation: Army = "classique"): Model {
  const u = UNITS[kind];
  const m = instance(unitDef(kind, f, nation));
  m.root.scale.setScalar(unitScale(kind));
  const air = u.domain === "air";
  const armed = u.targets !== "none" && !u.heal;
  const legs = !!m.parts[CRAWLER_LEGS[0]!.name];
  const anims = air
    ? ["Hover", "Fly", "Bank", ...(armed ? ["Fire"] : []), ...(u.heal ? ["Repair"] : []), "Wreck"]
    : [
        legs ? "Walk" : "Drive",
        "Idle",
        ...(behaves(kind, "harvester") ? ["Haul"] : []),
        ...(m.turret ? ["Aim"] : []),
        ...(armed ? ["Fire"] : []),
        "Wreck"
      ];
  let aim = 0;
  let recoil = 0;
  let face = 0;
  let bank = 0;
  let pitch = 0;
  let gait = 0;
  let amp = 0;
  let burnt = false;
  const fire = shots();
  const laser = u.dmgType === "laser";

  /** Where a shot leaves (world), and which way the barrel points. */
  const muzzle = (): THREE.Vector3 => {
    const from = m.turret ?? m.body;
    from.updateWorldMatrix(true, false);
    from.getWorldQuaternion(quat);
    fwd.set(0, 0, -1).applyQuaternion(quat);
    return from.localToWorld(v3.set(...m.def.muzzle));
  };

  return {
    root: m.root,
    anims,
    step(anim, t, dt) {
      const wreck = anim === "Wreck";
      if (wreck !== burnt) setVariant(m.root, (burnt = wreck) ? "burnt" : "normal");
      let speed = 0;
      let turn = 0;
      let aimAt = 0;
      if (anim === "Drive" || anim === "Walk" || anim === "Haul" || anim === "Fly") speed = u.speed;
      if (anim === "Bank") {
        // weaving: turning one way, then the other
        speed = u.speed * 0.7;
        turn = Math.sin(t * 0.9) * 1.3;
      }
      if (anim === "Aim") aimAt = [0.9, -0.7, 0.25, -1.5, 1.6][Math.floor(t / 2.2) % 5]!;
      if (anim === "Fire") aimAt = m.turret ? 0.35 : 0;
      face += turn * dt;
      aim += (aimAt - aim) * (1 - Math.exp(-dt * 4));
      if (anim === "Fire" && fire(t, Math.min(2, Math.max(0.3, u.shotInterval ?? 0.5)))) {
        recoil = 1;
        const at = muzzle();
        if (laser) glows.beam(at, fwd, 2.4, LASER_TINT[f]);
        else glows.flash(at, kind === "mastodon" || kind === "mortar" ? 0.55 : 0.38);
      }
      recoil = Math.max(0, recoil - dt * 6);

      const k = 1 - Math.pow(0.002, dt);
      if (air) {
        if (wreck) m.root.position.y = 0;
        else m.root.position.y = AIR_Y + Math.sin(t / 0.38) * 0.06;
        // bank into turns, nose down when moving fast (render/entities.ts)
        bank += (Math.max(-0.6, Math.min(0.6, -turn * 0.35)) - bank) * k;
        pitch += (Math.max(-0.25, -speed * 0.05) - pitch) * k;
        if (wreck) m.body.rotation.set(0.12, -face, 0.22);
        else m.body.rotation.set(pitch, -face, bank);
      } else {
        m.root.position.y = u.hover && !wreck ? HOVER_H + Math.sin(t / 0.3) * 0.02 : 0;
        // the engine's rumble on the move
        const rumble = speed > 0 && !legs && !u.hover ? Math.sin(t * 47) * 0.004 : 0;
        m.body.position.y = rumble;
        m.body.rotation.set(rumble * 2, -face, wreck ? 0.05 : 0);
      }
      if (m.turret) {
        m.turret.rotation.y = -aim;
        const kick = recoil * (kind === "mastodon" ? 0.08 : 0.05);
        const at = m.def.mount;
        m.turret.position.set(at[0] + Math.sin(-aim) * kick, at[1], at[2] + Math.cos(-aim) * kick);
      }
      if (legs) {
        // an alternating tripod gait whose feet keep pace with the ground (render/entities.ts walk)
        amp += ((speed > 0 ? 1 : 0) - amp) * (1 - Math.exp(-dt * 8));
        gait += ((speed * dt) / LEG_CYCLE) * Math.PI * 2;
        for (const leg of CRAWLER_LEGS) {
          const p = m.parts[leg.name]!;
          const ph = gait + leg.tripod * Math.PI;
          p.rotation.y = leg.side * Math.sin(ph) * LEG_SWING * amp;
          p.position.y = m.def.parts![leg.name]!.at[1] + Math.max(0, Math.cos(ph)) * LEG_LIFT * amp;
        }
      }
      if (!wreck) for (const r of m.rotors) r.obj.rotation[r.axis] += r.speed * dt;
      if (m.cargo) m.cargo.visible = anim === "Haul";
      if (anim === "Repair" && fire(t, 0.12)) {
        // the repair beam, down onto whatever it is mending
        m.body.updateWorldMatrix(true, false);
        const at = m.body.localToWorld(v3.set(...m.def.muzzle));
        const len = at.y - 0.05;
        glows.beam(at, fwd.set(0, -1, 0), len, 0x7dff9a, 0.018);
        glows.flash(v3.set(at.x, 0.06, at.z), 0.5, 0x7dff9a, 0.2);
      }
      return [Math.sin(face) * speed, -Math.cos(face) * speed];
    }
  };
}

/** The Condor: two squads seated in its bay, coming down low to drop its ramp. */
function condor(f: Faction, kind: UnitKind = "condor", nation: Army = "classique"): Model {
  const c = instance(unitDef(kind, f, nation));
  const s = unitScale(kind);
  c.root.scale.setScalar(s);
  const bay = new THREE.Group();
  bay.scale.setScalar(1 / s);
  c.body.add(bay);
  const crew: BotKind[] = kind === "titan" ? ["fusiliers", "rocket-squad"] : nation === "republique" ? ["trooper", "sapeurs"] : ["trooper", "rocket-squad"];
  const riders = crew.map((k, side) => {
    const r = new SquadRig(k, f, 30 + side, undefined, owned(nation));
    r.seat(baySeats(k, side, s));
    bay.add(r.root);
    return r;
  });
  let burnt = false;
  let face = 0;
  let bank = 0;
  return {
    root: c.root,
    anims: ["Hover", "Drop", "Fly", "Bank", "Wreck"],
    step(anim, t, dt) {
      const wreck = anim === "Wreck";
      if (wreck !== burnt) setVariant(c.root, (burnt = wreck) ? "burnt" : "normal");
      bay.visible = !wreck;
      // Drop: down low, the ramp opens and the riders stand up facing it, then it closes and climbs away
      const d = anim === "Drop" ? t % 8 : 0;
      const low = anim === "Drop" ? smooth(d / 1.5) * (1 - smooth((d - 6.5) / 1.5)) : 0;
      const ramp = anim === "Drop" ? smooth((d - 1.3) / 1.2) * (1 - smooth((d - 5.2) / 1.2)) : 0;
      const speed = anim === "Fly" ? UNITS[kind].speed : anim === "Bank" ? UNITS[kind].speed * 0.7 : 0;
      const turn = anim === "Bank" ? Math.sin(t * 0.9) * 1.2 : 0;
      face += turn * dt;
      bank += (Math.max(-0.6, Math.min(0.6, -turn * 0.35)) - bank) * (1 - Math.pow(0.002, dt));
      c.root.position.y = wreck ? 0 : lerp(AIR_Y + 0.25, 0.62, low) + Math.sin(t / 0.38) * 0.05 * (1 - low);
      if (wreck) c.body.rotation.set(0.1, -face, 0.25);
      else c.body.rotation.set(-speed * 0.04, -face, bank);
      c.ramp!.rotation.x = ramp * c.def.ramp!.open;
      if (!wreck) for (const r of c.rotors) r.obj.rotation[r.axis] += r.speed * dt;
      for (const r of riders) r.update({ dt: dt * 1000, speed: 0, aim: 0, pitch: 0, alive: r.spec.n, ready: ramp });
      return [Math.sin(face) * speed, -Math.cos(face) * speed];
    },
    dispose: () => riders.forEach((r) => r.dispose())
  };
}

/** A squad of robots: marching, weapons up, firing, falling (and standing back up). */
function squad(kind: BotKind, f: Faction, glows: Glows, nation: Army = "classique"): Model {
  const rig = new SquadRig(kind, f, 3, undefined, owned(nation));
  const u = UNITS[kind];
  const n = u.squad ?? 1;
  const fire = shots();
  return {
    root: rig.root,
    anims: ["March", "Idle", "Aim", "Fire", "Fall"],
    step(anim, t, dt) {
      const speed = anim === "March" ? u.speed : 0;
      const aim = anim === "Aim" || anim === "Fire" ? 1 : 0;
      // Fall: the robots drop one by one as the squad loses HP, then are healed back up
      const alive = anim === "Fall" ? Math.max(0, n - Math.floor((t % ((n + 2) * 1.4)) / 1.4)) : n;
      rig.update({ dt: dt * 1000, speed, aim, pitch: 0, alive });
      if (anim === "Fire" && fire(t, Math.max(0.25, (u.shotInterval ?? 0.5) / Math.min(n, 3)))) {
        const standing = rig.standing();
        const i = standing[Math.floor(Math.random() * standing.length)];
        const at = i === undefined ? null : rig.fire(i, v3);
        if (at) glows.flash(at, kind === "trooper" || kind === "fusiliers" ? 0.16 : 0.28, kind === "sniper" || kind === "carabiniers" ? 0xfff4d8 : kind === "sapeurs" ? LASER_TINT[f] : FLASH);
      }
      return [0, -speed];
    },
    dispose: () => rig.dispose()
  };
}

const REST: GoliathPose = { dt: 0, speed: 0, lower: 0, spikes: 0, unfold: 0, yaw: 0, pitch: 0, droop: 0, pods: 0, eye: 1, hang: 0, crane: 0, look: 0 };

/** The Goliath: walking, anchoring, every weapon firing, knocked offline and rebooting, and in love. */
function goliath(f: Faction, glows: Glows): Model {
  const rig = new GoliathRig(f);
  rig.root.scale.setScalar(unitScale("goliath"));
  const W = GOLIATH.weapons;
  // each weapon system on its own clock, its pair of guns taking turns
  const guns: { every: number; guns: GoliathGun[]; i: number; fire: ReturnType<typeof shots> }[] = [
    { every: W.cannons.shotInterval!, guns: ["cannonL", "cannonR"], i: 0, fire: shots() },
    { every: W.mortars.shotInterval!, guns: ["podL", "podR"], i: 0, fire: shots() },
    { every: W.mg.shotInterval!, guns: ["mgL", "mgR"], i: 0, fire: shots() },
    { every: W.laser.shotInterval!, guns: ["eye"], i: 0, fire: shots() }
  ];
  const hearts = shots();
  // anchoring: dig in, work a while with the crane slewing, pack up, stand
  const A = GOLIATH.anchorTime;
  const P = GOLIATH.packTime;
  const HOLD = 5;
  return {
    root: rig.root,
    anims: ["Walk", "Stand", "Anchor", "Fire", "Damaged", "Reboot", "Love"],
    step(anim, t, dt) {
      const p: GoliathPose = { ...REST, dt: dt * 1000 };
      let speed = 0;
      if (anim === "Walk") speed = p.speed = UNITS.goliath.speed;
      if (anim === "Stand") p.look = Math.sin(t * 0.5) * 0.45;
      if (anim === "Anchor") {
        const c = t % (A + HOLD + P + 2);
        const k = c < A ? c / A : c < A + HOLD ? 1 : Math.max(0, 1 - (c - A - HOLD) / P);
        p.lower = smooth(k * 1.4);
        p.spikes = k;
        p.unfold = smooth((k - 0.3) / 0.7);
        p.crane = c > A && c < A + HOLD ? Math.sin((c - A) * 1.1) * 0.9 : 0;
      }
      if (anim === "Fire") {
        p.yaw = Math.sin(t * 0.45) * 0.45;
        rig.update(p);
        for (const g of guns) {
          if (!g.fire(t, g.every)) continue;
          const gun = g.guns[g.i++ % g.guns.length]!;
          rig.kick(gun);
          const at = rig.muzzle(gun, v3);
          if (gun === "eye") {
            rig.j.head.getWorldQuaternion(quat);
            glows.beam(at, fwd.set(0, -0.12, -1).normalize().applyQuaternion(quat), 3, LASER_TINT[f], 0.035);
          } else glows.flash(at, gun.startsWith("mg") ? 0.3 : gun.startsWith("pod") ? 0.6 : 0.7);
        }
      }
      if (anim === "Damaged") Object.assign(p, { droop: 1, pods: -0.45, eye: 0 });
      if (anim === "Reboot") {
        // mended: the weapons come back one by one, the eye flickering on, the mortar tubes cycling
        const c = t % 6;
        const k = smooth(c / 3);
        p.droop = 1 - k;
        p.pods = c < 3 ? lerp(-0.45, 0.3, k) : 0.3 * (1 - smooth((c - 3) / 1.5)) + Math.sin(c * 6) * 0.04 * (c < 4.5 ? 1 : 0);
        p.eye = c < 0.8 ? 0 : c < 2 ? (Math.sin(c * 37) > 0.2 ? 1 : 0) : 1;
        p.yaw = c > 3 ? Math.sin((c - 3) * 2) * 0.25 : 0;
      }
      if (anim === "Love") {
        Object.assign(p, { love: 1, hug: 0.8 + Math.sin(t * 1.2) * 0.2, nod: -0.1 + Math.sin(t * 1.6) * 0.06 });
        if (hearts(t, 0.55)) {
          const at = rig.point("head", [(Math.random() - 0.5) * 0.4, 0.3, -0.1], v3);
          glows.flash(at, 0.22, [0xff5fa2, 0xff3b6b, 0xff8cc6][Math.floor(Math.random() * 3)]!, 1.6, 0.45);
        }
      }
      if (anim !== "Fire") rig.update(p);
      return [0, -speed];
    }
  };
}

const TOTAL = UNITS.goliath.buildTime * TICK_RATE;
/** The Gantry's Build Goliath loop (s): the build sped up, the rollout as the game plays it, a pause. */
const G_BUILD = 16;
const G_ROLL = 5;
const G_CYCLE = G_BUILD + G_ROLL + 1.5;
/** The deck a Goliath stands on, on the Gantry's cradle (render/goliath.ts CRADLE_H). */
const CRADLE_H = 0.285;

/** A building: idle, going up, damaged and smoking, rubble; turrets aiming and firing; the Radar sweeping; the Gantry at work. */
function building(kind: BuildingKind, f: Faction, glows: Glows, nation: Army = "classique"): Model {
  const st = BUILDINGS[kind];
  const root = new THREE.Group();
  const m = instance(buildingDef(kind, f, nation));
  // (the République's gantry is the Zénith's hangar: no Gargantua on its cradle)
  const builds = kind === "gantry" && nation !== "republique";
  root.add(m.root);
  const rubble = modelMesh(rubbleGeometry(st.size, 1));
  rubble.visible = false;
  root.add(rubble);
  const armed = st.targets !== "none";
  const anims = [
    ...(kind === "radar" && m.turret ? ["Sweep"] : []),
    ...(builds ? ["Build Goliath"] : []),
    ...(armed && m.turret ? ["Aim"] : []),
    ...(armed ? ["Fire"] : []),
    "Idle",
    "Construct",
    "Damaged",
    "Rubble"
  ];
  let variant = "normal";
  let face = 0;
  let recoil = 0;
  const fire = shots();
  const puffs = shots();
  let raised = -1;

  // the Gantry plays its build through the game's own GantryView, fed a stand-in for the sim's side of it
  let gantry: { view: GantryView; b: { id: number; faction: Faction; queue: { kind: string; remaining: number }[] }; head: { kind: string; remaining: number } | null; rig: GoliathRig; rolled: boolean } | null = null;
  if (builds) {
    const at = (p: { x: number; y: number; h: number }) => v3.set(p.x, p.h, p.y);
    const host = {
      world: { tick: 0, powers: { stunned: new Map() } },
      fx: {
        weld: (p: { x: number; y: number; h: number }, n = 4) => {
          for (let i = 0; i < n; i++) {
            const q = at(p).add(new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12));
            glows.flash(q, 0.08 + Math.random() * 0.1, 0xfff0c0, 0.08 + Math.random() * 0.12);
          }
        },
        steam: (p: { x: number; y: number; h: number }) => glows.smoke(at(p), 0.3, 0xf0f4f8, 0.5, 1.2),
        sound: () => {}
      }
    } as unknown as GoliathHost;
    const b = { id: 1, faction: f, queue: [] };
    const rig = new GoliathRig(f);
    rig.root.scale.setScalar(unitScale("goliath"));
    rig.root.rotation.y = Math.PI;
    rig.root.visible = false;
    root.add(rig.root);
    gantry = { view: new GantryView(host, m, b as unknown as Building, 0, 0, 0), b, head: null, rig, rolled: false };
  }

  return {
    root,
    anims,
    step(anim, t, dt) {
      const v = anim === "Damaged" ? "damaged" : "normal";
      if (v !== variant) setVariant(m.root, (variant = v) as "normal");
      m.root.visible = anim !== "Rubble";
      rubble.visible = anim === "Rubble";
      // Construct: it rises from the ground in a puff of dust (render/entities.ts createBuilding)
      if (anim === "Construct") {
        const c = Math.floor(t / 3);
        const k = Ease.backOut(Math.min(1, (t % 3) / 0.48));
        m.root.scale.set(0.9 + 0.1 * k, Math.max(0.05, k), 0.9 + 0.1 * k);
        if (c !== raised) {
          raised = c;
          for (let i = 0; i < 10; i++)
            glows.smoke(v3.set((Math.random() - 0.5) * st.size, 0.1, (Math.random() - 0.5) * st.size), 0.45, 0x8a7453, 0.5, 1.1);
        }
      } else m.root.scale.setScalar(1);
      // Damaged: smoke rising off the roof
      if (anim === "Damaged" && puffs(t, 0.22)) {
        const x = (Math.random() - 0.5) * st.size * 0.5;
        const z = (Math.random() - 0.5) * st.size * 0.5;
        glows.smoke(v3.set(x, m.def.height * (0.5 + Math.random() * 0.4), z), 0.35 + st.size * 0.1, 0x2c2a28, 0.6, 1.8);
      }
      if (m.turret) {
        let aimAt = face;
        if (anim === "Aim") aimAt = [0.9, -0.7, 0.25, -1.5, 2.4][Math.floor(t / 2.2) % 5]!;
        if (anim === "Fire") aimAt = 0.35;
        if (kind === "radar") face += anim === "Sweep" ? dt * (1000 / 900) : 0; // (the game's sweep: a radian every 0.9 s)
        else face += (aimAt - face) * (1 - Math.exp(-dt * 4));
      }
      if (anim === "Fire" && fire(t, Math.max(0.3, st.shotInterval ?? 0.5))) {
        recoil = 1;
        const from = m.turret ?? m.body;
        from.updateWorldMatrix(true, false);
        const at = from.localToWorld(v3.set(...m.def.muzzle));
        if (kind === "arsonval") glows.flash(at, 0.5, LASER_TINT[f], 0.14);
        else glows.flash(at, kind === "sam-site" || kind === "flak-battery" ? 0.6 : 0.4);
        if (kind === "sam-site" || kind === "flak-battery") glows.smoke(v3.clone(), 0.3, 0xdedad3, 0.5, 1);
      }
      recoil = Math.max(0, recoil - dt * 6);
      if (m.turret) {
        const kick = recoil * 0.05;
        const at = m.def.mount;
        m.turret.rotation.y = -face;
        m.turret.position.set(at[0] - Math.sin(face) * kick, at[1], at[2] + Math.cos(face) * kick);
      }
      if (gantry) {
        const g = gantry;
        const c = anim === "Build Goliath" ? t % G_CYCLE : -1;
        if (c >= 0 && c < G_BUILD) {
          // a fresh build each loop: the sim's queue counting down its ticks
          if (!g.head || c < 0.1) g.head = { kind: "goliath", remaining: TOTAL };
          g.head.remaining = TOTAL * (1 - c / G_BUILD);
          g.b.queue = [g.head];
          g.rolled = false;
          g.rig.root.visible = false;
        } else {
          g.b.queue = [];
          g.head = null;
        }
        // finished: it walks off the cradle while the arms swing clear
        if (c >= G_BUILD && !g.rolled) {
          g.rolled = true;
          g.view.rollout();
        }
        const roll = c - G_BUILD;
        const walking = c >= G_BUILD && roll > 0.7 && roll < 3.6;
        if (c >= G_BUILD) {
          const z = Math.min(2.9, Math.max(0, roll - 0.7) * UNITS.goliath.speed);
          g.rig.root.visible = true;
          g.rig.root.position.set(0, CRADLE_H * (1 - smooth((z - 1.1) / 0.5)), z);
          g.rig.update({ ...REST, dt: dt * 1000, speed: walking ? UNITS.goliath.speed : 0 });
        } else if (anim !== "Build Goliath") g.rig.root.visible = false;
        g.view.update(g.b as unknown as Building, dt * 1000, 0, true);
      }
      return [0, 0];
    }
  };
}

// the objectives' colours (render/objectives.ts)
const HOLDER: Record<Faction, number> = { blue: 0x4fa3ff, red: 0xff5a4a };
const NEUTRAL = 0xe8c66a;
const GOLD = 0xffd66e;

/** A flat glow disc on the ground, `size` tiles across. */
function groundGlow(color: number, size: number): { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial } {
  const mat = discMat(color, 0);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
  mesh.position.y = 0.04;
  mesh.scale.setScalar(size);
  mesh.renderOrder = 3;
  return { mesh, mat };
}

/**
 * The Uplink relay: its dish scanning while no one holds it, turning for its
 * holder (Blue or Red: the side buttons pick who), spinning up while it's
 * captured, the capture bar filling round it until it flips.
 */
function uplink(f: Faction): Model {
  const root = new THREE.Group();
  const m = instance(uplinkDef());
  root.add(m.root);
  const glow = groundGlow(NEUTRAL, 3.2);
  root.add(glow.mesh);
  // the capture bar: a ring round the platform on a dark track (render/objectives.ts draws it on the ground)
  const track = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.46, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b0f16, transparent: true, opacity: 0.62, depthWrite: false }));
  track.position.y = 0.03;
  const barMat = new THREE.MeshBasicMaterial({ color: HOLDER[f], transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false });
  const bar = new THREE.Mesh(new THREE.BufferGeometry(), barMat);
  bar.position.y = 0.035;
  root.add(track, bar);
  let spin = 0;
  let filled = -1;
  const setBar = (p: number) => {
    if (Math.abs(p - filled) < 0.004) return;
    filled = p;
    bar.geometry.dispose();
    // (filled clockwise from north, seen from above)
    bar.geometry = new THREE.RingGeometry(1.31, 1.45, 64, 1, Math.PI / 2 - Math.PI * 2 * p, Math.PI * 2 * p).rotateX(-Math.PI / 2);
  };
  return {
    root,
    anims: ["Held", "Capturing", "Neutral"],
    step(anim, t, dt) {
      const capture = anim === "Capturing" ? (t % 9) / 7 : 0;
      const owned = anim === "Held" || capture >= 1;
      const flash = capture >= 1 ? Math.max(0, 1 - (capture - 1) * 3.5) : 0;
      const rate = anim === "Capturing" && capture < 1 ? 2.6 : owned ? 0.7 : 0;
      spin = rate > 0 ? spin + rate * dt : Math.sin(t * 0.4) * 0.9;
      m.turret!.rotation.y = -spin;
      const breathe = 0.5 + 0.5 * Math.sin(t * 3);
      glow.mat.color.setHex(owned ? HOLDER[f] : NEUTRAL);
      glow.mat.opacity = owned ? 0.28 + 0.14 * breathe + 0.5 * flash : 0.08;
      glow.mesh.scale.setScalar(3.2 + flash * 2);
      barMat.color.setHex(HOLDER[f]);
      setBar(anim === "Neutral" ? 0 : owned ? 1 : Math.min(1, capture));
      return [0, 0];
    }
  };
}

/** A supply crate: coming down under its canopy, then landed, glowing and blinking for a taker. */
function crate(): Model {
  const root = new THREE.Group();
  const c = instance(crateDef());
  const chute = modelMesh(chuteGeometry(), false);
  const glow = groundGlow(GOLD, 1.6);
  root.add(c.root, chute, glow.mesh);
  return {
    root,
    neutral: true,
    anims: ["Drop", "Landed"],
    step(anim, t) {
      // Drop: down from on high under a striped canopy, swaying, then it lands and glows (render/objectives.ts)
      const d = anim === "Drop" ? t % 6 : 6;
      const e = Math.min(1, d / 3);
      const hgt = (1 - e) * (1 - e * 0.35);
      const sway = Math.sin(t * 4) * 0.2 * hgt;
      const h = 2.6 * hgt;
      c.root.position.set(sway * 0.4, h, 0);
      c.root.rotation.set(sway * 0.4, 0.4, sway * 0.3);
      chute.visible = e < 1;
      chute.position.set(sway * 0.4, h + 0.42, 0);
      chute.rotation.set(sway * 0.3, 0, sway * 0.5);
      const pulse = 0.5 + 0.5 * Math.sin(t * 4.5);
      glow.mat.opacity = e < 1 ? 0.15 * e : 0.32 + 0.25 * pulse;
      glow.mesh.scale.setScalar(e < 1 ? 1.6 : 1.5 + 0.3 * pulse);
      return [0, 0];
    }
  };
}

/** The Zénith: cruising, mooring (cables paid out, hangar doors open), every weapon firing, and crippled. */
function zenith(f: Faction, glows: Glows): Model {
  const rig = new ZenithRig(zenithTeam(f));
  rig.root.scale.setScalar(unitScale("zenith"));
  const W = ZENITH.weapons;
  const guns: { every: number; guns: ZenithGun[]; i: number; fire: ReturnType<typeof shots> }[] = [
    { every: W.branly.shotInterval!, guns: ["branlyL", "branlyR"], i: 0, fire: shots() },
    { every: W.arc.shotInterval!, guns: ["arc"], i: 0, fire: shots() },
    { every: W.bombs.shotInterval!, guns: ["bombs"], i: 0, fire: shots() },
    { every: W.mg.shotInterval!, guns: ["mgL", "mgR"], i: 0, fire: shots() }
  ];
  const A = ZENITH.anchorTime;
  const P = ZENITH.packTime;
  const HOLD = 5;
  const H = AIR_Y + 0.9;
  let face = 0;
  return {
    root: rig.root,
    anims: ["Fly", "Hover", "Anchor", "Fire", "Damaged"],
    step(anim, t, dt) {
      const p: ZenithPose = { ...ZENITH_REST, dt: dt * 1000, props: anim === "Fly" ? 1 : 0.4, weapons: { ...ZENITH_REST.weapons } };
      let speed = 0;
      if (anim === "Fly") speed = UNITS.zenith.speed;
      if (anim === "Anchor") {
        const c = t % (A + HOLD + P + 2);
        const k = c < A ? c / A : c < A + HOLD ? 1 : Math.max(0, 1 - (c - A - HOLD) / P);
        p.moor = smooth(k);
        p.bay = smooth((k - 0.4) / 0.6);
        p.props = 0.2;
      }
      // the cables reach the pad: the axis' height over it, in model units
      p.drop = H / unitScale("zenith") + MOOR_POINTS[0]![1];
      if (anim === "Damaged")
        p.weapons = { branly: { lit: false, dead: 1 }, arc: { lit: false, dead: 1 }, bombs: { lit: true, dead: 0 }, mg: { lit: true, dead: 0 } };
      if (anim === "Fire") p.aim = Math.sin(t * 0.45) * 0.45;
      rig.root.position.y = H + Math.sin(t / 0.9) * 0.04;
      rig.j.body.rotation.set(-speed * 0.03, -face, Math.sin(t * 0.6) * 0.02);
      rig.update(p);
      if (anim === "Fire")
        for (const g of guns) {
          if (!g.fire(t, g.every)) continue;
          const gun = g.guns[g.i++ % g.guns.length]!;
          rig.kick(gun);
          const at = rig.muzzle(gun, v3);
          if (gun === "arc") glows.beam(at, fwd.set(0, -0.35, -1).normalize(), 2.5, LASER_TINT[f], 0.035);
          else glows.flash(at, gun.startsWith("mg") ? 0.3 : 0.6);
        }
      if (anim === "Damaged" && Math.random() < dt * 6) glows.smoke(rig.muzzle("branlyL", v3), 0.4, 0x2c2a28, 0.6, 1.6);
      return [0, -speed];
    }
  };
}

/** The Tour Eiffel (a campaign landmark): it just stands there, the pride of Paris. */
function landmark(): Model {
  const m = instance(landmarkDef("eiffel"));
  return { root: m.root, neutral: true, anims: ["Idle"], step: () => [0, 0] };
}

/** Kinds the page shows beyond units and sites. */
type Extra = "eiffel";
type Shown = UnitKind | SiteKind | Extra;

function makeModel(kind: Shown, f: Faction, glows: Glows, nation: Army = "classique"): Model {
  if (kind === "eiffel") return landmark();
  if (kind === "uplink") return uplink(f);
  if (kind === "supply-crate") return crate();
  if (kind in BUILDINGS) return building(kind as BuildingKind, f, glows, nation);
  if ((BOTS as string[]).includes(kind)) return squad(kind as BotKind, f, glows, nation);
  if (kind === "condor" || kind === "titan") return condor(f, kind, nation);
  if (kind === "goliath") return goliath(f, glows);
  if (kind === "zenith") return zenith(f, glows);
  return vehicle(kind as UnitKind, f, glows, nation);
}

// ------------------------------------------------------------ the stage ---

let renderer: THREE.WebGLRenderer | null = null;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
} catch {
  renderer = null;
}
const scene = new THREE.Scene();
// lit as on a temperate map (stage.ts LOOKS): mostly sun, a sky/ground fill and a little studio environment
const hemi = new THREE.HemisphereLight(0xc6d8ff, 0x8a8a6a, 1.45);
const sun = new THREE.DirectionalLight(0xfff0d8, 3.7);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 3;
scene.add(hemi, sun, sun.target);
if (renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 0);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  pmrem.dispose();
}
// no fog of war here
fowUniforms.uFowOn.value = 0;

/** The pad's grid (two squares to a tile) and the fade at its rim. */
function padTextures(): [THREE.CanvasTexture, THREE.CanvasTexture] {
  const g = document.createElement("canvas");
  g.width = g.height = 64;
  const x = g.getContext("2d")!;
  x.fillStyle = "#3a4458";
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = "#4d5a72";
  x.fillRect(0, 0, 64, 2);
  x.fillRect(0, 0, 2, 64);
  const grid = new THREE.CanvasTexture(g);
  grid.colorSpace = THREE.SRGBColorSpace;
  grid.wrapS = grid.wrapT = THREE.RepeatWrapping;
  grid.anisotropy = 4;
  const a = document.createElement("canvas");
  a.width = a.height = 128;
  const y = a.getContext("2d")!;
  const r = y.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "#fff");
  r.addColorStop(0.6, "#fff");
  r.addColorStop(1, "#000");
  y.fillStyle = r;
  y.fillRect(0, 0, 128, 128);
  return [grid, new THREE.CanvasTexture(a)];
}
const [GRID, FADE] = padTextures();

const dpr = Math.min(2, window.devicePixelRatio || 1);

/** One unit's viewer: its canvas, camera and controls, its model on a pad, and the animation playing. */
class Viewer {
  readonly group = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
  readonly controls: OrbitControls;
  readonly glows = new Glows();
  readonly ctx: CanvasRenderingContext2D;
  private model!: Model;
  private anim = "";
  private t = 0;
  private grid = GRID.clone();
  private padR = 1.5;
  visible = false;

  constructor(readonly kind: Shown, readonly canvas: HTMLCanvasElement, private ui: HTMLElement, private faction: Faction = "blue", private nation: Army = "classique") {
    this.ctx = canvas.getContext("2d")!;
    this.group.add(this.glows.group);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, enablePan: false, autoRotate: true, autoRotateSpeed: 1.6 });
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
    this.controls.addEventListener("start", () => this.spin(false));
    this.build();
    this.frame();
    this.renderUi();
  }

  private build(): void {
    if (this.model) {
      this.group.remove(this.model.root);
      this.model.dispose?.();
      this.glows.clear();
    }
    this.model = makeModel(this.kind, this.faction, this.glows, this.nation);
    this.group.add(this.model.root);
    if (!this.model.anims.includes(this.anim)) this.play(this.model.anims[0]!);
  }

  play(anim: string): void {
    this.anim = anim;
    this.t = 0;
  }

  /** Point the camera at the model from a ¾ front view, its whole height (and its shadow under it) in the frame. */
  private frame(): void {
    this.model.step(this.model.anims[0]!, 0, 0);
    const root = this.model.root;
    root.updateMatrixWorld(true);
    root.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && (o as THREE.SkinnedMesh).computeBoundingBox());
    const box = new THREE.Box3().setFromObject(root, true);
    box.expandByPoint(v3.set(box.min.x, 0, box.min.z));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(0.45, sphere.radius);
    this.padR = Math.max(1.4, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 1.15, r * 1.5);
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(this.padR, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: this.grid, alphaMap: FADE, transparent: true, depthWrite: false, roughness: 0.95 })
    );
    this.grid.repeat.set(this.padR * 4, this.padR * 4);
    pad.receiveShadow = true;
    pad.renderOrder = -1;
    this.group.add(pad);
    const d = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(v3.set(0.8, 0.72, -0.9).normalize(), d);
    this.controls.minDistance = d * 0.35;
    this.controls.maxDistance = d * 2.5;
    this.controls.update();
  }

  spin(on: boolean): void {
    this.controls.autoRotate = on;
    this.renderUi();
  }

  private renderUi(): void {
    const ANIM_LABEL: Record<string, string> = {
      Hover: "Surplace", Fly: "Vol", Bank: "Virage", Fire: "Tir", Repair: "Réparation", Wreck: "Épave", Walk: "Marche",
      Drive: "Rouler", Idle: "Repos", Haul: "Transport", Aim: "Visée", Drop: "Largage", March: "Marche", Fall: "Chute",
      Stand: "Debout", Anchor: "Ancrage", Damaged: "Endommagé", Reboot: "Redémarrage", Love: "Amour", Sweep: "Balayage",
      "Build Goliath": "Construire Gargantua", Construct: "Construction", Rubble: "Ruines", Held: "Tenu", Capturing: "Capture",
      Neutral: "Neutre", Landed: "Posée"
    };
    const b = (label: string, pressed: boolean, act: string, cls = "") =>
      `<button type="button" data-act="${act}" aria-pressed="${pressed}"${cls ? ` class="${cls}"` : ""}>${label}</button>`;
    this.ui.innerHTML =
      this.model.anims.map((a) => b(ANIM_LABEL[a] ?? a, a === this.anim, `anim:${a}`)).join("") +
      `<span class="sep"></span>` +
      (this.model.neutral
        ? ""
        : b("Bleu", this.faction === "blue", "faction:blue") + b("Rouge", this.faction === "red", "faction:red", "red")) +
      b("↻ Rotation", this.controls.autoRotate, "spin");
  }

  click(act: string): void {
    const [what, arg] = act.split(":");
    if (what === "anim") this.play(arg!);
    if (what === "faction" && arg !== this.faction) {
      this.faction = arg as Faction;
      this.build();
    }
    if (what === "spin") this.spin(!this.controls.autoRotate);
    this.renderUi();
  }

  draw(r: THREE.WebGLRenderer, dt: number): void {
    this.t += dt;
    const [vx, vz] = this.model.step(this.anim, this.t, dt);
    // the ground goes by under it (two grid squares to a tile)
    this.grid.offset.x = (this.grid.offset.x + vx * dt * 2) % 1;
    this.grid.offset.y = (this.grid.offset.y - vz * dt * 2) % 1;
    this.glows.update(dt);
    this.controls.update(dt);

    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.camera.aspect !== w / h) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const size = r.getDrawingBufferSize(buf);
    if (size.x !== w || size.y !== h) r.setSize(w, h, false);
    // the sun's shadow box over this pad
    const s = sun.shadow.camera;
    const half = this.padR + 0.5;
    if (s.right !== half) {
      s.left = s.bottom = -half;
      s.right = s.top = half;
      s.near = 0.5;
      s.far = 40;
      s.updateProjectionMatrix();
    }
    sun.position.copy(SUN_DIR).multiplyScalar(15);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
    scene.add(this.group);
    r.render(scene, this.camera);
    scene.remove(this.group);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(r.domElement, 0, 0, w, h);
  }
}

// ------------------------------------------------------------- the page ---

/** The armies the page shows, each in its own section of both tabs (the nation filter picks which). */
const ARMIES: Army[] = ["classique", "republique", "empire"];
type Filter = Army | "all";
const ARMY_TITLE: Record<Army, string> = { classique: "Classique", republique: "La République", empire: "L'Empire de Carbonie" };
const ARMY_LINE: Record<Army, string> = {
  classique: "Les règles symétriques : les seize unités et dix bâtiments d'origine, aux couleurs bleue et rouge des camps.",
  republique: "Ingénieurs, aviateurs et savants : rapide, aérien, nombreux, électrique, fragile. Ses bâtiments doivent être alimentés par le GQG ou une Tour TSF.",
  empire: "Charbon, vapeur et acier : lent, blindé, l'artillerie la plus longue, des positions qu'on ne déloge pas. Chaque usine fabrique deux unités à la fois."
};
const icon = (k: string): string => `./assets/icons/${portraitKind(k)}.webp`;
const crest = (n: Army): string => (n === "classique" ? "" : `<img class="crest" src="./assets/ui/crest-${n}.webp" alt="" />`);

/** The page's two tabs: units and buildings, each its groups and rows of card and viewer, per army. */
const TABS = {
  units: {
    groups: (n: Army): { title: string; kinds: Shown[] }[] => unitGroups(n),
    name: (k: string) => (k === "eiffel" ? "Tour Eiffel" : UNITS[k as UnitKind].name),
    card: (k: string, n: Army) => card(k as UnitKind, { portrait: false, id: false, nation: n })
  },
  buildings: {
    groups: (n: Army): { title: string; kinds: Shown[] }[] => [
      ...buildingGroups(n),
      // the campaign's landmark stands in Paris: the République's
      ...(n === "republique" ? [{ title: "Monument de campagne", kinds: ["eiffel" as Shown] }] : [])
    ],
    name: (k: string, n: Army = "classique") => (k === "eiffel" ? "Tour Eiffel" : siteName(k as SiteKind, n)),
    card: (k: string, n: Army) =>
      k === "eiffel"
        ? `<article><div class="head"><div><h3>Tour Eiffel</h3><div class="role">Le clou de l'Exposition de 1889, décor des missions parisiennes de la Campagne de 1900.</div><div class="tags"><span class="tag">Décor</span><span class="tag">Campagne</span></div></div></div><ul class="features"><li>Un monument, pas un bâtiment : on ne le construit pas et on ne le détruit pas.</li><li>Sa silhouette se voit de loin sur la carte de Paris : un repère pour tes colonnes.</li></ul></article>`
        : siteCard(k as SiteKind, { id: false, nation: n })
  }
};
type Tab = keyof typeof TABS;

for (const [tab, t] of Object.entries(TABS) as [Tab, (typeof TABS)[Tab]][]) {
  document.querySelector(`#tab-${tab} .rows`)!.innerHTML = ARMIES.map((n) => {
    const groups = t.groups(n);
    const kinds = groups.flatMap((g) => g.kinds as string[]);
    return `<section class="army ${n}" data-army="${n}">
      <div class="armyhead">${crest(n)}<div><h2>${ARMY_TITLE[n]}</h2><p>${ARMY_LINE[n]}</p></div></div>
      <nav>${kinds.map((k) => `<a href="#${rowId(k, n)}"><img src="${k === "eiffel" ? icon("radar") : icon(k)}" alt="" />${t.name(k, n)}</a>`).join("")}</nav>
      ${groups
        .map(
          (g) =>
            `<h2 class="group">${g.title}</h2>` +
            (g.kinds as string[])
              .map(
                (k) => `<section class="row" id="${rowId(k, n)}">
              ${t.card(k, n)}
              <div class="viewer" data-kind="${k}" data-army="${n}">
                ${renderer ? `<canvas aria-label="Modèle 3D ${t.name(k, n)}"></canvas><div class="hint">Glisse pour tourner · pince ou ⌃-molette pour zoomer</div>` : `<p class="nogl">Ce navigateur ne peut pas afficher les modèles 3D (WebGL désactivé ou indisponible).</p>`}
                <div class="controls"></div>
              </div>
            </section>`
              )
              .join("")
        )
        .join("")}
    </section>`;
  }).join("");
}

/** The nation filter: Tout, or one army (?nation= keeps it across reloads and links). */
let filter: Filter = ((): Filter => {
  const q = new URLSearchParams(location.search).get("nation");
  return q === "classique" || q === "republique" || q === "empire" ? q : "all";
})();
function applyFilter(f: Filter): void {
  filter = f;
  for (const sec of document.querySelectorAll<HTMLElement>("section.army")) sec.hidden = f !== "all" && sec.dataset.army !== f;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#nfilter button")) b.setAttribute("aria-pressed", String(b.dataset.f === f));
  const url = new URL(location.href);
  if (f === "all") url.searchParams.delete("nation");
  else url.searchParams.set("nation", f);
  history.replaceState(null, "", url);
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#nfilter button"))
  b.addEventListener("click", () => applyFilter(b.dataset.f as Filter));
applyFilter(filter);

/** Show a tab: the one the link's anchor is on (#buildings, #turret, #empire-hq…), scrolled to it. */
function showTab(hash: string): void {
  const id = hash.replace(/^#/, "");
  const target = id ? document.getElementById(id) : null;
  const tab: Tab = id === "buildings" || target?.closest("#tab-buildings") ? "buildings" : "units";
  for (const t of Object.keys(TABS) as Tab[]) {
    (document.getElementById(`tab-${t}`) as HTMLElement).hidden = t !== tab;
    document.querySelector(`[data-tab="${t}"]`)!.setAttribute("aria-selected", String(t === tab));
  }
  // a row in an army the filter hides: show that army
  const army = target?.closest<HTMLElement>("section.army")?.dataset.army as Army | undefined;
  if (army && filter !== "all" && filter !== army) applyFilter(army);
  if (target?.classList.contains("row")) target.scrollIntoView();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
  b.addEventListener("click", () => {
    history.replaceState(null, "", `${location.search}#${b.dataset.tab}`);
    showTab(`#${b.dataset.tab}`);
  });
addEventListener("hashchange", () => showTab(location.hash));
showTab(location.hash);

if (renderer) {
  const r = renderer;
  // each viewer builds its model the first time it comes near the screen (a hundred rows: no up-front cost)
  const viewers = new Map<Element, Viewer>();
  const make = (el: HTMLElement): Viewer => {
    const v = new Viewer(el.dataset.kind as Shown, el.querySelector("canvas")!, el.querySelector(".controls")!, "blue", el.dataset.army as Army);
    viewers.set(el, v);
    el.querySelector(".controls")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act) v.click(act);
    });
    return v;
  };
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const v = viewers.get(e.target) ?? (e.isIntersecting ? make(e.target as HTMLElement) : undefined);
        if (v) v.visible = e.isIntersecting;
      }
    },
    { rootMargin: "100px" }
  );
  for (const el of document.querySelectorAll<HTMLElement>(".viewer")) {
    seen.observe(el);
    // a plain scroll wheel scrolls the page past the model; ⌃/⌘-scroll (and a trackpad pinch) zooms
    el.addEventListener("wheel", (e) => !e.ctrlKey && !e.metaKey && e.stopPropagation(), { capture: true });
  }
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const v of viewers.values()) if (v.visible) v.draw(r, dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
