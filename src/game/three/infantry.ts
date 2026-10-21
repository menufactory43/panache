import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Faction } from "../../sim/types";
import { ModelBuilder, type Vec3 } from "./builder";
import { modelMat } from "./materials";
import { AMBER, BARREL, BRASS, CANVAS, CONDOR_BAY, GM, GM_D, GM_L, TEAMS, WHITE } from "./models";
import { BELLE_EPOQUE } from "./theme";
import { NATION_TEAMS } from "./belle/placeholders";

/**
 * Robot infantry: small articulated biped robots in the vehicles' painted
 * style (gunmetal limbs, chunky team-colour shoulder pads and back plates
 * that read from the tilted top-down camera, amber visors and lights).
 *
 * A squad is ONE sim unit drawn as several robots in a loose formation that
 * turns with the unit. All of a squad's robots are one skinned mesh — one
 * draw call — rigidly skinned: every part (thigh, shin, arm, gun…) is built
 * in its own joint's space and rides one bone, so the skeleton is just a
 * scene graph of joints the rig poses each frame: a run cycle whose feet
 * stay planted while the ground passes under them (two-bone leg IK), an idle
 * sway and head scan, a raise-and-aim firing pose with recoil, a topple
 * (outward, clear of the others) when the squad's HP drops a robot, a step
 * aside out of a vehicle's path, hops into and drops out of a Condor, and a
 * seated pose for riding in its bay (standing to face the ramp for a drop).
 *
 * World units are tiles; robots are modelled at map scale (no unitScale).
 * Robots face north (-Z) with their origin on the ground between the feet.
 *
 * (models.ts imports this module and this one imports models.ts: nothing
 * here may touch an import at module load, only inside functions.)
 *
 * Belle Époque (theme.ts): the same rigs dressed as clockwork soldiers of
 * 1900 — Pioupious, Artificiers and Chasseurs alpins (PARTS_BELLE).
 *
 * The nations' squads (PANACHE-CONCEPTION.md §1.11, WP5d): Sapeurs-électriciens
 * (République), Fusiliers and Carabiniers (Empire), on the same joints, painted
 * in their nation's colours (NATION_TEAMS) for the seat. Under ?style=original
 * they wear their stand-in's parts (Trooper, Trooper, Sniper).
 *
 * Tranchées (WP1): any squad can show a ring of sandbags round its formation —
 * pass `entrenched` (0 or 1) in RigState each frame (the sim's flag for the
 * squad, e.g. `entrenched: u.entrenched ? 1 : 0` in render/entities.ts); the
 * ring rises out of the ground and sinks back as it changes (SquadRig.dug).
 */

type Team = (typeof TEAMS)[Faction];
export type BotKind = "trooper" | "rocket-squad" | "sniper" | "sapeurs" | "fusiliers" | "carabiniers";

/** The nations' squads and their nation (their colours come from NATION_TEAMS). */
const NATION_BOT: Partial<Record<BotKind, "republique" | "empire">> = { sapeurs: "republique", fusiliers: "empire", carabiniers: "empire" };

/** A robot's joints, one bone each, in this order. */
export const J = { root: 0, hips: 1, torso: 2, head: 3, armL: 4, armR: 5, gun: 6, thighL: 7, shinL: 8, thighR: 9, shinR: 10 } as const;
const JOINTS = 11;

/** An upper-body pose (radians; arms swing forward on +x and across the body toward the other arm on ±z). */
interface Upper {
  armL: [number, number];
  armR: [number, number];
  /** Gun bone: pitch (+ up), yaw, roll (+ toward the robot's left); applied roll last. */
  gun: Vec3;
  /** …and where it sits in its parent (the right hand or the torso). */
  gunAt: Vec3;
  /** Torso pitch (+ leans back). */
  torso: number;
}

interface Spec {
  /** Robots in the squad and their formation slots (x, z; -z is ahead). */
  n: number;
  /** Robots are drawn this much bigger than modelled (readability at phone zoom); slots are not scaled. */
  size: number;
  slots: [number, number][];
  /** Robots in the order they fall as the squad's HP drops (the leader last). */
  falls: number[];
  /** Hip joint height, half the hip width, thigh and shin lengths. */
  hipY: number;
  hipX: number;
  thigh: number;
  shin: number;
  /** Waist (the torso's pivot) above the hips; shoulders and neck above the waist; arm length. */
  waist: number;
  shX: number;
  shY: number;
  neck: number;
  arm: number;
  /** The gun rides the right hand (a rifle) or the torso (a shoulder launcher, a long rifle at port arms). */
  gunOnHand: boolean;
  /** Muzzle, in gun space. */
  muzzle: Vec3;
  carry: Upper;
  aim: Upper;
  /**
   * Run: arm swing (left, right), forward lean, extra crouch (a stalk), the
   * fraction of a stride each foot spends planted, and how high a foot lifts
   * in its swing.
   */
  swing: [number, number];
  lean: number;
  crouch: number;
  stance: number;
  lift: number;
  /** Ground covered per stride (two steps), in the robot's own units: the cadence follows the ground speed. */
  cycle: number;
  /** Legs while firing at a standstill: thigh L, shin L, thigh R, shin R, and the hip drop. */
  brace: [number, number, number, number, number];
  /** Seated (riding a Condor): arms, gun pitch relative to its parent. */
  seatArms: number;
  seatGun: Vec3;
}

const SPECS: Record<BotKind, Spec> = {
  trooper: {
    n: 5, size: 1.42,
    slots: [[0, -0.25], [-0.25, -0.04], [0.25, -0.06], [-0.15, 0.23], [0.14, 0.24]],
    falls: [4, 1, 3, 2, 0],
    hipY: 0.145, hipX: 0.026, thigh: 0.062, shin: 0.06,
    waist: 0.022, shX: 0.066, shY: 0.068, neck: 0.09, arm: 0.1,
    gunOnHand: true, muzzle: [0, 0.016, -0.14],
    carry: { armL: [0.05, 0.08], armR: [0.25, -0.12], gun: [-0.85, 0, 0], gunAt: [0, -0.1, 0], torso: 0 },
    aim: { armL: [1.32, 0.62], armR: [1.42, -0.32], gun: [-1.42, 0, 0], gunAt: [0, -0.1, 0], torso: -0.04 },
    swing: [0.62, 0.3], lean: -0.16, crouch: 0, stance: 0.34, lift: 0.032, cycle: 0.4,
    brace: [0.32, -0.4, -0.24, -0.2, 0.012],
    seatArms: 0.8, seatGun: [0.5, 0, 0]
  },
  "rocket-squad": {
    n: 3, size: 1.4,
    slots: [[0, -0.2], [-0.22, 0.11], [0.21, 0.13]],
    falls: [2, 1, 0],
    hipY: 0.14, hipX: 0.034, thigh: 0.058, shin: 0.058,
    waist: 0.022, shX: 0.082, shY: 0.068, neck: 0.088, arm: 0.096,
    gunOnHand: false, muzzle: [0, 0, -0.17],
    carry: { armL: [0.05, 0.1], armR: [1.45, -0.06], gun: [0.16, 0, 0], gunAt: [0.078, 0.112, 0.012], torso: 0 },
    aim: { armL: [1.25, 0.55], armR: [1.5, -0.06], gun: [0.06, 0, 0], gunAt: [0.078, 0.112, 0.012], torso: 0.03 },
    swing: [0.55, 0.06], lean: -0.1, crouch: 0.004, stance: 0.38, lift: 0.026, cycle: 0.36,
    brace: [0.4, -0.45, -0.32, -0.22, 0.016],
    seatArms: 0.7, seatGun: [0.3, 0, 0]
  },
  sniper: {
    n: 2, size: 1.45,
    slots: [[-0.11, -0.05], [0.12, 0.09]],
    falls: [1, 0],
    hipY: 0.158, hipX: 0.022, thigh: 0.07, shin: 0.066,
    waist: 0.02, shX: 0.056, shY: 0.07, neck: 0.092, arm: 0.108,
    gunOnHand: false, muzzle: [0, 0.006, -0.27],
    carry: { armL: [0.95, 0.55], armR: [0.45, -0.12], gun: [-0.38, 0.22, 0], gunAt: [0.034, 0.028, -0.045], torso: 0 },
    aim: { armL: [1.45, 0.5], armR: [1.3, -0.25], gun: [0, 0, 0], gunAt: [0.03, 0.068, -0.042], torso: -0.05 },
    // (a low, stalking lope)
    swing: [0.12, 0.12], lean: -0.22, crouch: 0.018, stance: 0.36, lift: 0.028, cycle: 0.42,
    // the marksman drops to one knee to take a shot
    brace: [1.15, -1.2, 0.2, -1.75, 0.055],
    seatArms: 0.85, seatGun: [1.35, 0, 0]
  },
  // Sapeurs-électriciens: three stocky linesmen, the arc lance held like a rifle, levelled to strike
  sapeurs: {
    n: 3, size: 1.4,
    slots: [[0, -0.2], [-0.22, 0.11], [0.21, 0.13]],
    falls: [2, 1, 0],
    hipY: 0.142, hipX: 0.03, thigh: 0.06, shin: 0.058,
    waist: 0.022, shX: 0.072, shY: 0.068, neck: 0.088, arm: 0.098,
    gunOnHand: true, muzzle: [0, 0.016, -0.2],
    carry: { armL: [0.05, 0.08], armR: [0.25, -0.12], gun: [-0.85, 0, 0], gunAt: [0, -0.1, 0], torso: 0 },
    aim: { armL: [1.32, 0.62], armR: [1.42, -0.32], gun: [-1.42, 0, 0], gunAt: [0, -0.1, 0], torso: -0.06 },
    swing: [0.58, 0.28], lean: -0.14, crouch: 0.004, stance: 0.36, lift: 0.028, cycle: 0.38,
    brace: [0.4, -0.45, -0.32, -0.22, 0.016],
    seatArms: 0.8, seatGun: [0.5, 0, 0]
  },
  // Fusiliers: the Trooper's drill, heavier on its feet
  fusiliers: {
    n: 5, size: 1.42,
    slots: [[0, -0.25], [-0.25, -0.04], [0.25, -0.06], [-0.15, 0.23], [0.14, 0.24]],
    falls: [4, 1, 3, 2, 0],
    hipY: 0.145, hipX: 0.028, thigh: 0.062, shin: 0.06,
    waist: 0.022, shX: 0.068, shY: 0.068, neck: 0.09, arm: 0.1,
    gunOnHand: true, muzzle: [0, 0.016, -0.14],
    carry: { armL: [0.05, 0.08], armR: [0.25, -0.12], gun: [-0.85, 0, 0], gunAt: [0, -0.1, 0], torso: 0 },
    aim: { armL: [1.32, 0.62], armR: [1.42, -0.32], gun: [-1.42, 0, 0], gunAt: [0, -0.1, 0], torso: -0.04 },
    swing: [0.5, 0.26], lean: -0.12, crouch: 0, stance: 0.36, lift: 0.026, cycle: 0.38,
    brace: [0.32, -0.4, -0.24, -0.2, 0.012],
    seatArms: 0.8, seatGun: [0.5, 0, 0]
  },
  // Carabiniers: the Sniper's stalk and kneeling shot
  carabiniers: {
    n: 2, size: 1.45,
    slots: [[-0.11, -0.05], [0.12, 0.09]],
    falls: [1, 0],
    hipY: 0.158, hipX: 0.022, thigh: 0.07, shin: 0.066,
    waist: 0.02, shX: 0.056, shY: 0.07, neck: 0.092, arm: 0.108,
    gunOnHand: false, muzzle: [0, 0.006, -0.28],
    carry: { armL: [0.95, 0.55], armR: [0.45, -0.12], gun: [-0.38, 0.22, 0], gunAt: [0.034, 0.028, -0.045], torso: 0 },
    aim: { armL: [1.45, 0.5], armR: [1.3, -0.25], gun: [0, 0, 0], gunAt: [0.03, 0.068, -0.042], torso: -0.05 },
    swing: [0.12, 0.12], lean: -0.2, crouch: 0.016, stance: 0.36, lift: 0.028, cycle: 0.42,
    brace: [1.15, -1.2, 0.2, -1.75, 0.055],
    seatArms: 0.85, seatGun: [1.35, 0, 0]
  }
};

export const botSpec = (kind: BotKind): Readonly<Spec> => SPECS[kind];

/** Where a joint sits in its parent, at rest. */
function restAt(s: Spec, j: number): Vec3 {
  switch (j) {
    case J.hips: return [0, s.hipY, 0];
    case J.torso: return [0, s.waist, 0];
    case J.head: return [0, s.neck, 0];
    case J.armL: return [-s.shX, s.shY, 0];
    case J.armR: return [s.shX, s.shY, 0];
    case J.gun: return s.carry.gunAt;
    case J.thighL: return [-s.hipX, 0, 0];
    case J.thighR: return [s.hipX, 0, 0];
    case J.shinL:
    case J.shinR: return [0, -s.thigh, 0];
    default: return [0, 0, 0];
  }
}

function parentOf(s: Spec, j: number): number {
  switch (j) {
    case J.hips: return J.root;
    case J.torso: return J.hips;
    case J.head:
    case J.armL:
    case J.armR: return J.torso;
    case J.gun: return s.gunOnHand ? J.armR : J.torso;
    case J.thighL:
    case J.thighR: return J.hips;
    case J.shinL: return J.thighL;
    case J.shinR: return J.thighR;
    default: return -1;
  }
}

// --------------------------------------------------------------- parts ---

/**
 * Robot gunmetal runs a step lighter than the vehicles': a robot is nearly all
 * walls and few roofs, and walls near the ground take the model shader's
 * contact shade, so the vehicles' shades would read as a black stick figure.
 */
const R_LIGHT = 0xa3adb8;
const R_MID = 0x7d8791;
const R_DARK = 0x58606a;
const R_JOINT = 0x33373d;

type Parts = (THREE.BufferGeometry | null)[];

/** Robot parts: per-part grade so limbs separate from each other at a glance. */
const pb = () => new ModelBuilder({ grade: 0.16 });

function light(b: ModelBuilder, at: Vec3, s: number): void {
  b.box(s, s * 0.8, s, at, AMBER, { glow: 1 });
}

/** A leg: hip ball and thigh (thigh joint), shin, knee cap and boot (shin joint). */
function legs(P: Parts, s: Spec, w: number, knee: number, boot: [number, number, number]): void {
  const ankle = s.hipY - s.thigh - s.shin;
  for (const [th, sh] of [[J.thighL, J.shinL], [J.thighR, J.shinR]] as const) {
    let b = pb();
    b.cyl(w * 0.5, w * 0.5, w * 1.1, 6, [0, 0, 0], R_JOINT, { rot: [0, 0, Math.PI / 2] });
    b.block(w, s.thigh + 0.008, w * 1.15, [0, -s.thigh / 2 - 0.002, 0], R_MID, { bevel: w * 0.2 });
    P[th] = b.build();
    b = pb();
    b.block(w * 0.95, s.shin * 0.85, w * 1.05, [0, -s.shin * 0.5, 0.002], R_DARK, { bevel: w * 0.18 });
    b.block(w * 0.8, 0.026, knee, [0, -0.004, -w * 0.55], R_LIGHT, { bevel: 0.005 });
    b.block(boot[0], boot[1], boot[2], [0, -s.shin - ankle + boot[1] / 2, -boot[2] * 0.18], GM_D, { bevel: 0.006, edge: 1.6 });
    P[sh] = b.build();
  }
}

/** Plain arms: shoulder ball, upper arm, forearm, fist. */
function arms(P: Parts, s: Spec, w: number): void {
  for (const j of [J.armL, J.armR]) {
    const b = pb();
    b.sphere(w * 0.62, [0, 0, 0], R_JOINT, { w: 6, h: 4 });
    b.block(w, s.arm * 0.5, w * 1.1, [0, -s.arm * 0.29, 0], R_MID, { bevel: w * 0.2 });
    b.block(w * 1.12, s.arm * 0.46, w * 1.2, [0, -s.arm * 0.74, 0], R_DARK, { bevel: w * 0.2 });
    b.box(w * 0.85, w * 0.7, w * 0.9, [0, -s.arm, -0.002], R_JOINT);
    P[j] = b.build();
  }
}

const PARTS: Partial<Record<BotKind, (t: Team) => Parts>> & Record<"trooper" | "rocket-squad" | "sniper", (t: Team) => Parts> = {
  trooper: (t) => {
    const s = SPECS.trooper;
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.block(0.084, 0.034, 0.05, [0, 0.004, 0.002], R_DARK, { bevel: 0.008 });
    b.box(0.062, 0.012, 0.054, [0, 0.02, 0.002], R_JOINT);
    P[J.hips] = b.build();
    legs(P, s, 0.036, 0.014, [0.044, 0.022, 0.07]);
    // torso: a chest that widens to the shoulders, a light chest plate, the backpack with a team top
    b = pb();
    b.block(0.064, 0.03, 0.046, [0, 0.008, 0], R_JOINT, { bevel: 0.008 });
    b.block(0.098, 0.07, 0.066, [0, 0.055, 0], R_MID, { taper: -0.16, bevel: 0.012 });
    b.block(0.066, 0.038, 0.012, [0, 0.058, -0.035], R_LIGHT, { bevel: 0.005 });
    light(b, [0.022, 0.07, -0.042], 0.011);
    b.block(0.076, 0.062, 0.036, [0, 0.054, 0.049], R_DARK, { bevel: 0.008 });
    b.block(0.082, 0.016, 0.042, [0, 0.092, 0.05], t.main, { bevel: 0.006, edge: 1.4 });
    light(b, [-0.024, 0.068, 0.068], 0.01);
    b.drum(0.027, 0.022, 0.014, 6, [0, 0.096, 0], GM_D);
    // the big team shoulder pads, sloping out: the squad's colour from above
    for (const sx of [-1, 1])
      b.block(0.054, 0.03, 0.068, [sx * 0.071, 0.084, 0.002], t.main, { rot: [0, 0, -sx * 0.3], bevel: 0.01, edge: 1.45 });
    P[J.torso] = b.build();
    // head: a helmet with a wraparound amber visor, a team crest and a whip antenna
    b = pb();
    b.block(0.054, 0.046, 0.056, [0, 0.026, 0.002], R_LIGHT, { bevel: 0.012, edge: 1.3 });
    b.box(0.05, 0.014, 0.014, [0, 0.026, -0.024], AMBER, { glow: 1 });
    b.box(0.058, 0.01, 0.03, [0, 0.026, -0.008], AMBER, { glow: 0.8 });
    b.box(0.014, 0.006, 0.05, [0, 0.051, 0.004], t.main);
    b.cyl(0.003, 0.003, 0.04, 4, [0.021, 0.064, 0.018], GM_D);
    b.sphere(0.007, [0.021, 0.086, 0.018], AMBER, { glow: 1, w: 5, h: 3 });
    P[J.head] = b.build();
    arms(P, s, 0.03);
    // the rifle, gripped at the gun bone's origin
    b = pb();
    b.block(0.02, 0.032, 0.1, [0, 0.01, -0.035], GM_D, { bevel: 0.006 });
    b.tube(0.0065, 0.05, 6, [0, 0.016, -0.105], BARREL);
    b.tube(0.0095, 0.014, 6, [0, 0.016, -0.132], GM);
    b.box(0.014, 0.03, 0.018, [0, -0.012, -0.045], GM);
    b.box(0.016, 0.024, 0.036, [0, 0.006, 0.03], GM);
    b.box(0.01, 0.008, 0.032, [0, 0.03, -0.028], t.main);
    light(b, [0, 0.034, -0.05], 0.008);
    P[J.gun] = b.build();
    return P;
  },

  "rocket-squad": (t) => {
    const s = SPECS["rocket-squad"];
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.block(0.1, 0.038, 0.058, [0, 0.004, 0.002], R_DARK, { bevel: 0.009 });
    b.box(0.08, 0.014, 0.062, [0, 0.022, 0.002], R_JOINT);
    P[J.hips] = b.build();
    legs(P, s, 0.046, 0.02, [0.056, 0.026, 0.082]);
    // a barrel chest, a rocket rack on the back, oversized pads
    b = pb();
    b.block(0.08, 0.03, 0.056, [0, 0.008, 0], R_JOINT, { bevel: 0.009 });
    b.block(0.124, 0.074, 0.08, [0, 0.056, -0.002], R_MID, { taper: -0.1, bevel: 0.014 });
    b.block(0.084, 0.044, 0.012, [0, 0.058, -0.044], R_LIGHT, { bevel: 0.006 });
    b.box(0.06, 0.008, 0.004, [0, 0.07, -0.051], AMBER, { glow: 0.85 });
    b.block(0.094, 0.064, 0.04, [0, 0.052, 0.058], R_DARK, { bevel: 0.009 });
    b.block(0.1, 0.014, 0.046, [0, 0.09, 0.058], t.main, { bevel: 0.006, edge: 1.4 });
    for (const x of [-0.03, 0, 0.03]) {
      b.cyl(0.0095, 0.0095, 0.045, 6, [x, 0.1, 0.06], WHITE);
      b.cone(0.0095, 0.018, 6, [x, 0.13, 0.06], 0xc84a3a);
    }
    for (const sx of [-1, 1])
      b.block(0.066, 0.036, 0.082, [sx * 0.086, 0.086, 0.002], t.main, { rot: [0, 0, -sx * 0.26], bevel: 0.012, edge: 1.45 });
    P[J.torso] = b.build();
    // a squat helm sunk between the pads, a slit visor and a team brow
    b = pb();
    b.block(0.052, 0.04, 0.054, [0, 0.022, 0.004], R_LIGHT, { bevel: 0.012, edge: 1.3 });
    b.box(0.046, 0.01, 0.012, [0, 0.02, -0.022], AMBER, { glow: 1 });
    b.box(0.054, 0.008, 0.02, [0, 0.036, -0.016], t.main);
    P[J.head] = b.build();
    arms(P, s, 0.036);
    // the launcher on the right shoulder: team band, sight, warhead in the mouth
    b = pb();
    b.tube(0.027, 0.25, 8, [0, 0, -0.03], GM);
    b.tube(0.03, 0.045, 8, [0, 0, 0.03], t.main);
    b.tube(0.031, 0.022, 8, [0, 0, -0.15], GM_D);
    b.cone(0.022, 0.034, 8, [0, 0, -0.142], WHITE, { rot: [-Math.PI / 2, 0, 0] });
    b.cone(0.034, 0.03, 8, [0, 0, 0.1], GM_D, { rot: [-Math.PI / 2, 0, 0] });
    b.block(0.022, 0.022, 0.05, [-0.034, 0.012, -0.05], GM_D, { bevel: 0.005 });
    light(b, [-0.034, 0.014, -0.078], 0.01);
    b.box(0.014, 0.034, 0.016, [0, -0.034, -0.04], GM_D);
    P[J.gun] = b.build();
    return P;
  },

  sniper: (t) => {
    const s = SPECS.sniper;
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.block(0.07, 0.03, 0.044, [0, 0.004, 0.002], R_DARK, { bevel: 0.007 });
    P[J.hips] = b.build();
    legs(P, s, 0.03, 0.012, [0.04, 0.02, 0.066]);
    // a lean frame under a ragged camouflage shroud, a team mantle over the shoulders
    b = pb();
    b.block(0.07, 0.07, 0.054, [0, 0.042, 0], GM_D, { taper: -0.12, bevel: 0.01 });
    const camo = [0x5c6640, 0x6f6a45, 0x454c31, 0x7c7650];
    b.cone(0.078, 0.12, 6, [0, 0.04, 0.006], camo[0]!, { rot: [0, Math.PI / 6, 0] });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      b.box(0.036, 0.075, 0.006, [Math.sin(a) * 0.058, 0.02, Math.cos(a) * 0.058 + 0.008], camo[(i + 1) % 4]!, {
        rot: [Math.cos(a) * 0.32, a, -Math.sin(a) * 0.32]
      });
    }
    // the shroud's tail hangs to the knees behind
    b.box(0.08, 0.12, 0.008, [0, -0.005, 0.07], camo[2]!, { rot: [0.22, 0, 0] });
    b.box(0.03, 0.1, 0.009, [-0.03, -0.03, 0.078], camo[3]!, { rot: [0.2, 0.2, 0.08] });
    b.box(0.03, 0.11, 0.009, [0.028, -0.035, 0.076], camo[1]!, { rot: [0.24, -0.2, -0.08] });
    b.drum(0.06, 0.042, 0.026, 8, [0, 0.086, 0.004], t.main, { bevel: 0.009, edge: 1.45 });
    b.box(0.042, 0.054, 0.006, [0, 0.06, 0.054], t.main, { rot: [0.32, 0, 0] });
    P[J.torso] = b.build();
    // the hood: a dark face and one amber scope-eye
    b = pb();
    b.sphere(0.032, [0, 0.028, 0.006], camo[2]!, { w: 7, h: 5, scale: [1, 1.12, 1.15] });
    b.cone(0.022, 0.03, 5, [0, 0.052, 0.024], camo[0]!, { rot: [0.9, 0, 0] });
    b.box(0.014, 0.008, 0.052, [0, 0.064, 0.008], t.main);
    b.box(0.036, 0.03, 0.012, [0, 0.024, -0.024], GM_D);
    b.sphere(0.0105, [0.007, 0.027, -0.031], AMBER, { glow: 1, w: 6, h: 4 });
    P[J.head] = b.build();
    arms(P, s, 0.026);
    // the rail rifle: twin rails with glowing coils, a long scope, the stock behind the grip
    b = pb();
    b.block(0.02, 0.026, 0.13, [0, 0.004, -0.03], GM_D, { bevel: 0.005 });
    b.box(0.016, 0.022, 0.06, [0, 0.0, 0.06], GM);
    for (const x of [-0.006, 0.006]) b.box(0.005, 0.009, 0.17, [x, 0.006, -0.18], GM_L);
    for (const z of [-0.12, -0.17, -0.22]) b.box(0.02, 0.016, 0.006, [0, 0.006, z], AMBER, { glow: 0.9 });
    b.tube(0.009, 0.07, 6, [0, 0.026, -0.04], GM);
    b.box(0.012, 0.012, 0.004, [0, 0.026, -0.076], AMBER, { glow: 1 });
    b.box(0.012, 0.028, 0.012, [0, -0.02, -0.01], GM_D);
    P[J.gun] = b.build();
    return P;
  }
};

// (?style=original: the nations' squads wear their stand-in's parts)
PARTS.sapeurs = PARTS.trooper;
PARTS.fusiliers = PARTS.trooper;
PARTS.carabiniers = PARTS.sniper;

// ------------------------------------------- Belle Époque: clockwork soldiers ---

/**
 * BELLE_EPOQUE: the same robots dressed as clockwork automaton soldiers of
 * the 1900 French army — round polished-brass bodies, ivory clock-dial faces
 * with amber eyes, a wind-up key in the back, and a team-colour greatcoat,
 * tunic or cape with the team's képi, shako or béret on top, so the side
 * reads from the top-down camera. Same joints, proportions and muzzles as
 * the originals (PARTS): only the shapes and paint differ.
 */
const BE_LIGHT = 0xe2bb6a;
const BE_MID = 0xb88e4e;
const BE_DARK = 0x86683e;
const BE_JOINT = 0x4a3a2c;
const LEATHER = 0x3a2a1e;
const WOOD = 0x7a4e2a;
const STEEL = 0xc9ccd0;

/** Brass limbs: a ball hip, a trouser thigh, a brass knee, a leather gaiter over the boot. */
function legsBelle(P: Parts, s: Spec, w: number, boot: [number, number, number], trousers: number): void {
  const ankle = s.hipY - s.thigh - s.shin;
  for (const [th, sh] of [[J.thighL, J.shinL], [J.thighR, J.shinR]] as const) {
    let b = pb();
    b.sphere(w * 0.6, [0, 0, 0], BE_JOINT, { w: 6, h: 4 });
    b.cyl(w * 0.56, w * 0.5, s.thigh + 0.006, 8, [0, -s.thigh / 2 - 0.002, 0], trousers);
    P[th] = b.build();
    b = pb();
    b.sphere(w * 0.55, [0, -0.002, -0.002], BE_LIGHT, { w: 6, h: 4 });
    b.cyl(w * 0.46, w * 0.4, s.shin * 0.5, 8, [0, -s.shin * 0.3, 0], BE_MID);
    b.cyl(w * 0.52, w * 0.56, s.shin * 0.48, 8, [0, -s.shin * 0.72, 0.001], LEATHER);
    b.block(boot[0], boot[1], boot[2], [0, -s.shin - ankle + boot[1] / 2, -boot[2] * 0.18], 0x241a12, { bevel: 0.006, edge: 1.6 });
    P[sh] = b.build();
  }
}

/** Sleeved arms: a brass shoulder ball, the sleeve in `sleeve`, a brass cuff and a brass mitten. */
function armsBelle(P: Parts, s: Spec, w: number, sleeve: number): void {
  for (const j of [J.armL, J.armR]) {
    const b = pb();
    b.sphere(w * 0.66, [0, 0, 0], BE_LIGHT, { w: 7, h: 5 });
    b.cyl(w * 0.56, w * 0.5, s.arm * 0.82, 7, [0, -s.arm * 0.46, 0], sleeve);
    b.cyl(w * 0.58, w * 0.58, s.arm * 0.12, 7, [0, -s.arm * 0.86, 0], BRASS);
    b.sphere(w * 0.5, [0, -s.arm, -0.002], BE_LIGHT, { w: 6, h: 4 });
    P[j] = b.build();
  }
}

/** The face: a brass head ball and an ivory clock dial in a brass bezel, with two amber eyes. */
function dialFace(b: ModelBuilder, r: number, y: number, eyes = true, metal = BE_LIGHT): void {
  b.sphere(r, [0, y, 0.002], metal, { w: 10, h: 7 });
  b.cyl(r * 0.74, r * 0.74, 0.006, 12, [0, y - r * 0.05, -r * 0.84], WHITE, { rot: [Math.PI / 2, 0, 0] });
  b.torus(r * 0.75, r * 0.08, [0, y - r * 0.05, -r * 0.86], BRASS, { seg: 12 });
  // (the dial's hour marks)
  for (const [dx, dy] of [[0, 0.56], [0.56, 0], [-0.56, 0]] as const) b.box(r * 0.08, r * 0.08, 0.003, [dx * r, y - r * 0.05 + dy * r, -r * 0.89], BE_JOINT);
  if (eyes) for (const sx of [-1, 1]) b.box(r * 0.2, r * 0.16, 0.004, [sx * r * 0.3, y + r * 0.1, -r * 0.9], AMBER, { glow: 1 });
}

/** A clockwork key in the back at (y, z): the stem and its two-lobed bow. */
function windKey(b: ModelBuilder, y: number, z: number, s: number): void {
  b.cyl(s * 0.12, s * 0.12, s * 0.9, 5, [0, y, z + s * 0.45], BRASS, { rot: [Math.PI / 2, 0, 0] });
  for (const sx of [-1, 1]) b.torus(s * 0.4, s * 0.12, [sx * s * 0.42, y, z + s], BRASS, { rot: [0, Math.PI / 2, 0], seg: 8 });
}

/** Imperial automatons: riveted steel instead of brass (lighter than the vehicles', see R_LIGHT). */
const IR_LIGHT = 0xb4b8be;
const IR_MID = 0x8a8f96;
const IR_DARK = 0x5c6168;
const IR_JOINT = 0x34363a;
const SOOT = 0x1e1b19;
const EMBER = 0xff7a2a;
const LENS = 0xff5a3a;
const WOOD_D = 0x4e3220;
const COPPER = 0xc07a40;
const ELEC = 0x8fdcff;

/** Steel limbs: a ball hip, a trouser thigh, a steel knee, a black gaiter over the boot. */
function legsIron(P: Parts, s: Spec, w: number, boot: [number, number, number], trousers: number): void {
  const ankle = s.hipY - s.thigh - s.shin;
  for (const [th, sh] of [[J.thighL, J.shinL], [J.thighR, J.shinR]] as const) {
    let b = pb();
    b.sphere(w * 0.6, [0, 0, 0], IR_JOINT, { w: 6, h: 4 });
    b.cyl(w * 0.56, w * 0.5, s.thigh + 0.006, 7, [0, -s.thigh / 2 - 0.002, 0], trousers);
    P[th] = b.build();
    b = pb();
    b.sphere(w * 0.55, [0, -0.002, -0.002], IR_LIGHT, { w: 6, h: 4 });
    b.cyl(w * 0.46, w * 0.4, s.shin * 0.5, 7, [0, -s.shin * 0.3, 0], IR_MID);
    b.cyl(w * 0.52, w * 0.56, s.shin * 0.48, 7, [0, -s.shin * 0.72, 0.001], 0x1c1a18);
    b.block(boot[0], boot[1], boot[2], [0, -s.shin - ankle + boot[1] / 2, -boot[2] * 0.18], 0x18150f, { bevel: 0.006, edge: 1.6 });
    P[sh] = b.build();
  }
}

/** Steel arms: a riveted shoulder ball, the sleeve, a steel cuff and a steel mitten. */
function armsIron(P: Parts, s: Spec, w: number, sleeve: number): void {
  for (const j of [J.armL, J.armR]) {
    const b = pb();
    b.sphere(w * 0.66, [0, 0, 0], IR_LIGHT, { w: 7, h: 5 });
    b.cyl(w * 0.56, w * 0.5, s.arm * 0.82, 7, [0, -s.arm * 0.46, 0], sleeve);
    b.cyl(w * 0.58, w * 0.58, s.arm * 0.12, 7, [0, -s.arm * 0.86, 0], IR_MID);
    b.sphere(w * 0.5, [0, -s.arm, -0.002], IR_LIGHT, { w: 6, h: 4 });
    P[j] = b.build();
  }
}

const PARTS_BELLE: Record<BotKind, (t: Team) => Parts> = {
  // ---- Pioupiou: line infantry in the capote, képi, havresac and blanket roll, a Lebel with its long bayonet
  trooper: (t) => {
    const s = SPECS.trooper;
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.sphere(0.036, [0, 0.006, 0.002], BE_DARK, { w: 8, h: 5, scale: [1.2, 0.7, 0.9] });
    P[J.hips] = b.build();
    legsBelle(P, s, 0.032, [0.042, 0.02, 0.066], BE_MID);
    b = pb();
    // the round brass body, buttoned into the greatcoat (skirts to mid-thigh), belted, a clock dial on the chest
    b.sphere(0.046, [0, 0.052, 0], BE_LIGHT, { w: 10, h: 7, scale: [1.05, 1, 0.82] });
    b.cyl(0.04, 0.052, 0.1, 10, [0, 0.022, 0], t.main, { scale: [1.08, 1, 0.84] });
    b.sphere(0.044, [0, 0.07, 0.001], t.main, { w: 10, h: 5, phi: Math.PI / 2, scale: [1.32, 0.72, 0.92] });
    b.cyl(0.0455, 0.0455, 0.009, 10, [0, 0.012, 0], LEATHER, { scale: [1.12, 1, 0.88] });
    b.box(0.012, 0.01, 0.006, [0, 0.012, -0.04], BRASS);
    for (const sx of [-1, 1]) {
      b.box(0.016, 0.014, 0.01, [sx * 0.024, 0.014, -0.038], LEATHER);
      for (const y of [0.03, 0.048]) b.box(0.005, 0.005, 0.004, [sx * 0.012, y, -0.044], BRASS);
      // epaulettes, brass-fringed
      b.block(0.024, 0.008, 0.028, [sx * 0.062, 0.094, 0.002], t.light, { bevel: 0.003 });
      b.box(0.026, 0.006, 0.03, [sx * 0.062, 0.087, 0.002], BRASS);
    }
    b.cyl(0.011, 0.011, 0.004, 10, [0, 0.07, -0.043], WHITE, { rot: [Math.PI / 2, 0, 0] });
    b.box(0.002, 0.008, 0.002, [0, 0.073, -0.046], BE_JOINT);
    // the havresac, its blanket roll and mess tin on top, the key behind
    b.block(0.06, 0.054, 0.028, [0, 0.052, 0.046], LEATHER, { bevel: 0.006 });
    b.cyl(0.011, 0.011, 0.074, 7, [0, 0.088, 0.046], CANVAS, { rot: [0, 0, Math.PI / 2] });
    b.cyl(0.009, 0.009, 0.01, 7, [0, 0.1, 0.05], GM_L);
    windKey(b, 0.05, 0.06, 0.016);
    b.drum(0.016, 0.014, 0.008, 8, [0, 0.092, 0], BRASS);
    P[J.torso] = b.build();
    // head: the dial face, a waxed moustache, the képi with its dark band and visor
    b = pb();
    dialFace(b, 0.026, 0.026);
    b.box(0.02, 0.004, 0.004, [0, 0.017, -0.026], BE_JOINT, { rot: [0, 0, 0] });
    b.cyl(0.021, 0.025, 0.03, 10, [0, 0.052, 0.002], t.main, { rot: [-0.14, 0, 0] });
    b.cyl(0.0255, 0.0255, 0.009, 10, [0, 0.042, 0.003], t.dark);
    b.cyl(0.0215, 0.0215, 0.003, 10, [0, 0.068, -0.001], t.light, { rot: [-0.14, 0, 0] });
    b.box(0.03, 0.003, 0.016, [0, 0.039, -0.027], LEATHER, { rot: [0.3, 0, 0] });
    b.box(0.006, 0.006, 0.004, [0, 0.05, -0.026], BRASS);
    P[J.head] = b.build();
    armsBelle(P, s, 0.028, t.main);
    // the Lebel: walnut stock, blued barrel with brass bands, the long épée-bayonet
    b = pb();
    b.block(0.016, 0.026, 0.11, [0, 0.008, -0.03], WOOD, { bevel: 0.004 });
    b.box(0.016, 0.03, 0.04, [0, 0.0, 0.03], WOOD);
    b.tube(0.0055, 0.07, 6, [0, 0.016, -0.1], BARREL);
    for (const z of [-0.06, -0.09]) b.tube(0.008, 0.005, 6, [0, 0.016, z], BRASS);
    b.box(0.003, 0.004, 0.06, [0, 0.01, -0.16], STEEL);
    b.box(0.008, 0.012, 0.016, [0, -0.012, -0.03], BE_JOINT);
    b.box(0.006, 0.006, 0.012, [0.009, 0.02, -0.005], BRASS);
    P[J.gun] = b.build();
    return P;
  },

  // ---- Artificier: a stocky rocketeer in a frogged dolman, a shako with a pompon, brass goggles, a Congreve tube
  "rocket-squad": (t) => {
    const s = SPECS["rocket-squad"];
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.sphere(0.044, [0, 0.006, 0.002], BE_DARK, { w: 8, h: 5, scale: [1.2, 0.7, 0.9] });
    P[J.hips] = b.build();
    legsBelle(P, s, 0.042, [0.054, 0.024, 0.078], BE_DARK);
    b = pb();
    // a barrel of a brass body in the team dolman, brass frogging across the chest, broad shoulders
    b.sphere(0.058, [0, 0.05, 0], BE_LIGHT, { w: 10, h: 7, scale: [1.05, 0.95, 0.85] });
    b.cyl(0.054, 0.058, 0.07, 10, [0, 0.042, 0], t.main, { scale: [1.08, 1, 0.86] });
    b.sphere(0.058, [0, 0.074, 0.001], t.main, { w: 10, h: 5, phi: Math.PI / 2, scale: [1.38, 0.62, 0.92] });
    for (let i = 0; i < 3; i++) b.box(0.05 - i * 0.006, 0.004, 0.004, [0, 0.03 + i * 0.016, -0.05], BRASS);
    b.cyl(0.06, 0.06, 0.01, 10, [0, 0.008, 0], LEATHER, { scale: [1.12, 1, 0.88] });
    b.box(0.014, 0.012, 0.006, [0, 0.008, -0.052], BRASS);
    for (const sx of [-1, 1]) {
      b.block(0.03, 0.01, 0.036, [sx * 0.08, 0.098, 0.002], t.light, { bevel: 0.003 });
      b.box(0.032, 0.007, 0.038, [sx * 0.08, 0.09, 0.002], BRASS);
    }
    // the quiver of Congreve rockets on its back: iron cases, red warheads, their guide sticks hanging below
    b.block(0.07, 0.05, 0.026, [0, 0.05, 0.06], LEATHER, { bevel: 0.006 });
    for (const x of [-0.024, 0, 0.024]) {
      b.cyl(0.009, 0.009, 0.05, 6, [x, 0.098, 0.064], BE_JOINT);
      b.cone(0.0095, 0.02, 6, [x, 0.133, 0.064], 0xc84a3a);
      b.cyl(0.0025, 0.0025, 0.1, 4, [x, 0.0, 0.07], WOOD);
    }
    windKey(b, 0.04, 0.075, 0.018);
    P[J.torso] = b.build();
    // head: the dial face behind brass goggles, a shako with a brass plate and a pompon
    b = pb();
    dialFace(b, 0.027, 0.024, false);
    for (const sx of [-1, 1]) {
      b.torus(0.007, 0.0025, [sx * 0.009, 0.027, -0.026], BRASS, { seg: 8 });
      b.cyl(0.006, 0.006, 0.004, 8, [sx * 0.009, 0.027, -0.027], AMBER, { glow: 1, rot: [Math.PI / 2, 0, 0] });
    }
    b.box(0.05, 0.004, 0.004, [0, 0.027, -0.02], LEATHER);
    b.cyl(0.026, 0.023, 0.04, 10, [0, 0.056, 0.002], t.main);
    b.cyl(0.0265, 0.0265, 0.006, 10, [0, 0.074, 0.002], t.dark);
    b.box(0.012, 0.014, 0.004, [0, 0.055, -0.024], BRASS);
    b.box(0.032, 0.003, 0.016, [0, 0.038, -0.026], LEATHER, { rot: [0.25, 0, 0] });
    b.sphere(0.009, [0, 0.084, -0.012], t.light, { w: 6, h: 4 });
    P[J.head] = b.build();
    armsBelle(P, s, 0.034, t.main);
    // the Congreve tube: brass, team-banded, flared at the mouth with a warhead showing, a sight and a grip
    b = pb();
    b.tube(0.025, 0.24, 12, [0, 0, -0.03], 0x9c7644);
    b.tube(0.028, 0.04, 10, [0, 0, 0.03], t.main);
    for (const z of [-0.08, 0.06]) b.tube(0.028, 0.008, 10, [0, 0, z], BRASS);
    b.cone(0.034, 0.03, 10, [0, 0, -0.155], BRASS, { rot: [Math.PI / 2, 0, 0] });
    b.cone(0.02, 0.034, 8, [0, 0, -0.146], 0xc84a3a, { rot: [-Math.PI / 2, 0, 0] });
    b.cone(0.034, 0.03, 12, [0, 0, 0.1], BE_JOINT, { rot: [-Math.PI / 2, 0, 0] });
    b.box(0.006, 0.02, 0.006, [-0.026, 0.024, -0.06], BRASS);
    light(b, [-0.026, 0.036, -0.06], 0.009);
    b.box(0.012, 0.032, 0.014, [0, -0.034, -0.04], WOOD);
    P[J.gun] = b.build();
    return P;
  },

  // ---- Chasseur alpin: a lean marksman under the great flat béret and team cape, a long rifle with a brass scope
  sniper: (t) => {
    const s = SPECS.sniper;
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.sphere(0.032, [0, 0.006, 0.002], BE_DARK, { w: 8, h: 5, scale: [1.2, 0.7, 0.9] });
    P[J.hips] = b.build();
    legsBelle(P, s, 0.028, [0.038, 0.02, 0.062], t.dark);
    b = pb();
    // a slim brass body in the dark vareuse, the cape (pèlerine) over its shoulders, a rolled blanket across them
    b.sphere(0.038, [0, 0.046, 0], BE_LIGHT, { w: 10, h: 7, scale: [1.05, 1.15, 0.85] });
    b.cyl(0.034, 0.042, 0.08, 10, [0, 0.03, 0], t.dark, { scale: [1.05, 1, 0.85] });
    b.cone(0.07, 0.085, 10, [0, 0.05, 0.004], t.main, { scale: [1, 1, 0.9] });
    b.box(0.07, 0.07, 0.006, [0, 0.025, 0.054], t.main, { rot: [0.18, 0, 0] });
    b.torus(0.042, 0.009, [0, 0.07, 0.004], CANVAS, { rot: [Math.PI / 2, 0, 0.5], seg: 10 });
    b.cyl(0.004, 0.004, 0.012, 6, [0, 0.091, -0.004], BRASS);
    b.box(0.008, 0.008, 0.004, [0.012, 0.062, -0.044], BRASS);
    windKey(b, 0.03, 0.06, 0.015);
    P[J.torso] = b.build();
    // head: the dial face with a brass monocle, the wide béret alpin tipped over with a hunting-horn badge
    b = pb();
    dialFace(b, 0.024, 0.026);
    b.torus(0.006, 0.0018, [0.007, 0.029, -0.023], BRASS, { seg: 8 });
    b.cyl(0.043, 0.036, 0.012, 14, [0.004, 0.05, 0.004], t.main, { rot: [0.05, 0, -0.22] });
    b.cyl(0.026, 0.026, 0.006, 12, [0.002, 0.04, 0.003], t.dark);
    b.torus(0.006, 0.002, [-0.026, 0.046, 0.0], BRASS, { rot: [0, Math.PI / 2, 0], seg: 8 });
    b.cyl(0.002, 0.002, 0.008, 4, [0.008, 0.058, 0.004], t.dark);
    P[J.head] = b.build();
    armsBelle(P, s, 0.024, t.dark);
    // the long rifle: walnut stock, a long blued barrel with brass bands, a brass telescope with an amber lens
    b = pb();
    b.block(0.018, 0.024, 0.13, [0, 0.004, -0.03], WOOD, { bevel: 0.005 });
    b.box(0.016, 0.026, 0.06, [0, -0.002, 0.06], WOOD);
    b.tube(0.0055, 0.15, 6, [0, 0.006, -0.18], BARREL);
    for (const z of [-0.11, -0.2]) b.tube(0.008, 0.006, 6, [0, 0.006, z], BRASS);
    b.tube(0.0075, 0.075, 7, [0, 0.026, -0.04], BRASS);
    b.box(0.012, 0.012, 0.004, [0, 0.026, -0.078], AMBER, { glow: 1 });
    b.box(0.012, 0.028, 0.012, [0, -0.02, -0.01], BE_JOINT);
    P[J.gun] = b.build();
    return P;
  },

  // ---- Sapeur-électricien: a stocky linesman in the team vareuse, a team fireman's casque with a brass comb,
  // goggles up, the team battery pack on its back (glass accumulators, copper terminals), the arc lance
  sapeurs: (t) => {
    const s = SPECS.sapeurs;
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.sphere(0.04, [0, 0.006, 0.002], BE_DARK, { w: 8, h: 5, scale: [1.2, 0.7, 0.9] });
    P[J.hips] = b.build();
    legsBelle(P, s, 0.036, [0.048, 0.022, 0.072], t.dark);
    b = pb();
    b.sphere(0.05, [0, 0.05, 0], BE_LIGHT, { w: 10, h: 6, scale: [1.05, 1, 0.84] });
    b.cyl(0.046, 0.054, 0.08, 10, [0, 0.03, 0], t.main, { scale: [1.08, 1, 0.86] });
    b.cyl(0.052, 0.052, 0.01, 10, [0, 0.01, 0], LEATHER, { scale: [1.12, 1, 0.88] });
    // leather braces crossing the chest to the pack, a brass dial gauge
    for (const sx of [-1, 1]) b.box(0.01, 0.07, 0.006, [sx * 0.022, 0.06, -0.043], LEATHER, { rot: [0, 0, sx * 0.35] });
    b.cyl(0.011, 0.011, 0.004, 8, [0, 0.07, -0.046], WHITE, { rot: [Math.PI / 2, 0, 0] });
    for (const sx of [-1, 1]) b.block(0.026, 0.009, 0.03, [sx * 0.07, 0.094, 0.002], t.light, { bevel: 0.003 });
    // the battery pack: a team case, three glass cells lit blue, copper terminals and a coiled lead
    b.block(0.08, 0.07, 0.04, [0, 0.06, 0.058], t.main, { bevel: 0.007, edge: 1.4 });
    for (const x of [-0.024, 0, 0.024]) {
      b.cyl(0.009, 0.009, 0.03, 6, [x, 0.108, 0.058], ELEC, { glow: 0.8 });
      b.box(0.006, 0.008, 0.006, [x, 0.127, 0.058], COPPER);
    }
    b.torus(0.014, 0.003, [0.046, 0.03, 0.05], 0x2a2019, { rot: [0, Math.PI / 2, 0], seg: 8 });
    P[J.torso] = b.build();
    // head: the dial face, goggles pushed up, the team casque with its brass comb and neck guard
    b = pb();
    dialFace(b, 0.026, 0.024);
    b.sphere(0.03, [0, 0.036, 0.003], t.main, { w: 10, h: 4, phi: Math.PI / 2, scale: [1, 1.05, 1.12] });
    b.box(0.006, 0.014, 0.05, [0, 0.07, 0.004], BRASS);
    b.cyl(0.034, 0.036, 0.004, 10, [0, 0.036, 0.008], t.dark, { scale: [1, 1, 1.15] });
    for (const sx of [-1, 1]) b.torus(0.007, 0.0025, [sx * 0.01, 0.046, -0.024], BRASS, { rot: [-0.4, 0, 0], seg: 8 });
    P[J.head] = b.build();
    armsBelle(P, s, 0.03, t.main);
    // the arc lance: an insulated ash shaft, a copper coil, ivory insulators, the brass fork and its blue spark
    b = pb();
    b.box(0.014, 0.022, 0.09, [0, 0.008, -0.01], WOOD);
    b.tube(0.006, 0.12, 6, [0, 0.016, -0.1], BE_JOINT);
    b.tube(0.012, 0.04, 8, [0, 0.016, -0.09], COPPER);
    b.tube(0.01, 0.012, 6, [0, 0.016, -0.14], WHITE);
    b.pair(0.003, 0.004, 0.04, [0.007, 0.016, -0.176], BRASS);
    b.sphere(0.009, [0, 0.016, -0.2], ELEC, { glow: 1, w: 6, h: 4 });
    b.box(0.008, 0.012, 0.016, [0, -0.012, -0.02], BE_JOINT);
    P[J.gun] = b.build();
    return P;
  },

  // ---- Fusilier impérial: a riveted steel automaton under a big team cuirass, a toy-round spiked helmet in team
  // colour with a brass ball, a little smokestack on its back glowing at the firebox, the Mauser and its bayonet
  fusiliers: (t) => {
    const s = SPECS.fusiliers;
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.sphere(0.036, [0, 0.006, 0.002], IR_DARK, { w: 8, h: 5, scale: [1.2, 0.7, 0.9] });
    P[J.hips] = b.build();
    legsIron(P, s, 0.032, [0.044, 0.02, 0.068], t.dark);
    b = pb();
    b.sphere(0.046, [0, 0.052, 0], IR_MID, { w: 10, h: 6, scale: [1.05, 1, 0.84] });
    b.cyl(0.042, 0.05, 0.06, 10, [0, 0.022, 0], IR_DARK, { scale: [1.08, 1, 0.86] });
    // the cuirass: a team breast- and back-plate with a brass rim, rivets down the middle
    b.sphere(0.05, [0, 0.055, -0.004], t.main, { w: 10, h: 6, phi: Math.PI * 0.62, scale: [1.08, 1.05, 0.92] });
    b.cyl(0.05, 0.05, 0.008, 10, [0, 0.024, -0.002], BRASS, { scale: [1.1, 1, 0.9] });
    for (const y of [0.045, 0.065]) b.box(0.005, 0.005, 0.004, [0, y, -0.047], IR_LIGHT);
    for (const sx of [-1, 1]) b.block(0.026, 0.01, 0.032, [sx * 0.064, 0.094, 0.002], IR_LIGHT, { bevel: 0.003 });
    b.cyl(0.044, 0.044, 0.009, 10, [0, 0.012, 0], LEATHER, { scale: [1.12, 1, 0.88] });
    // the boiler on its back and its smokestack, the firebox glowing
    b.cyl(0.022, 0.024, 0.06, 8, [0, 0.055, 0.052], IR_DARK);
    b.box(0.018, 0.012, 0.006, [0, 0.04, 0.075], EMBER, { glow: 0.9 });
    b.cyl(0.008, 0.008, 0.05, 6, [0.012, 0.105, 0.05], SOOT);
    b.cyl(0.011, 0.009, 0.01, 6, [0.012, 0.132, 0.05], SOOT);
    P[J.torso] = b.build();
    // head: a steel dial face, the round team helmet, brass ball spike, front plate and chinstrap
    b = pb();
    dialFace(b, 0.026, 0.024, true, IR_LIGHT);
    b.sphere(0.03, [0, 0.034, 0.002], t.main, { w: 10, h: 4, phi: Math.PI / 2, scale: [1.05, 1.15, 1.1] });
    b.cyl(0.0325, 0.0325, 0.005, 10, [0, 0.035, 0.002], LEATHER, { scale: [1.05, 1, 1.2] });
    b.cyl(0.004, 0.006, 0.016, 6, [0, 0.074, 0.002], BRASS);
    b.sphere(0.009, [0, 0.085, 0.002], BRASS, { w: 6, h: 4 });
    b.box(0.016, 0.014, 0.004, [0, 0.048, -0.03], BRASS, { rot: [-0.3, 0, 0] });
    P[J.head] = b.build();
    armsIron(P, s, 0.028, t.dark);
    // the rifle: dark walnut, a blued barrel, the bayonet
    b = pb();
    b.block(0.016, 0.026, 0.11, [0, 0.008, -0.03], WOOD_D, { bevel: 0.004 });
    b.box(0.016, 0.03, 0.04, [0, 0.0, 0.03], WOOD_D);
    b.tube(0.0055, 0.07, 6, [0, 0.016, -0.1], BARREL);
    b.box(0.003, 0.004, 0.05, [0, 0.01, -0.155], STEEL);
    b.box(0.008, 0.012, 0.016, [0, -0.012, -0.03], IR_DARK);
    P[J.gun] = b.build();
    return P;
  },

  // ---- Carabinier: a lean steel marksman under the great team cape, a dark bombe helmet, one red lens glowing
  // in its dial, the long carbine with a brass scope whose lens catches the light
  carabiniers: (t) => {
    const s = SPECS.carabiniers;
    const P: Parts = new Array(JOINTS).fill(null);
    let b = pb();
    b.sphere(0.032, [0, 0.006, 0.002], IR_DARK, { w: 8, h: 5, scale: [1.2, 0.7, 0.9] });
    P[J.hips] = b.build();
    legsIron(P, s, 0.028, [0.038, 0.02, 0.062], 0x2a2a30);
    b = pb();
    b.sphere(0.038, [0, 0.046, 0], IR_MID, { w: 10, h: 6, scale: [1.05, 1.15, 0.85] });
    b.cyl(0.034, 0.042, 0.08, 10, [0, 0.03, 0], 0x2a2a30, { scale: [1.05, 1, 0.85] });
    // the cape over the shoulders, long behind, a high collar and a brass clasp
    b.cone(0.074, 0.09, 10, [0, 0.048, 0.006], t.main, { scale: [1, 1, 0.92] });
    b.box(0.076, 0.1, 0.006, [0, 0.01, 0.058], t.main, { rot: [0.16, 0, 0] });
    b.cyl(0.03, 0.034, 0.02, 10, [0, 0.098, 0.004], t.dark);
    b.box(0.01, 0.01, 0.004, [0, 0.086, -0.036], BRASS);
    P[J.torso] = b.build();
    // head: the dial with one great red monocle lens, the dark bombe helmet with a team band
    b = pb();
    dialFace(b, 0.024, 0.026, false, IR_LIGHT);
    b.box(0.006, 0.006, 0.004, [-0.007, 0.029, -0.022], AMBER, { glow: 1 });
    b.torus(0.008, 0.0025, [0.008, 0.028, -0.023], BRASS, { seg: 8 });
    b.cyl(0.0075, 0.0075, 0.004, 8, [0.008, 0.028, -0.024], LENS, { rot: [Math.PI / 2, 0, 0], glow: 1 });
    b.sphere(0.027, [0, 0.04, 0.003], IR_DARK, { w: 10, h: 4, phi: Math.PI / 2, scale: [1, 0.9, 1.1] });
    b.cyl(0.035, 0.035, 0.004, 10, [0, 0.04, 0.003], IR_DARK, { scale: [1, 1, 1.1] });
    b.cyl(0.0275, 0.0275, 0.007, 10, [0, 0.045, 0.003], t.main, { scale: [1, 1, 1.1] });
    P[J.head] = b.build();
    armsIron(P, s, 0.024, 0x2a2a30);
    // the long carbine: walnut, a long blued barrel, a brass scope with its glowing lens
    b = pb();
    b.block(0.018, 0.024, 0.13, [0, 0.004, -0.03], WOOD_D, { bevel: 0.005 });
    b.box(0.016, 0.026, 0.06, [0, -0.002, 0.06], WOOD_D);
    b.tube(0.0055, 0.16, 6, [0, 0.006, -0.185], BARREL);
    b.tube(0.0075, 0.085, 7, [0, 0.026, -0.04], BRASS);
    b.box(0.013, 0.013, 0.004, [0, 0.026, -0.083], LENS, { glow: 1 });
    b.box(0.012, 0.028, 0.012, [0, -0.02, -0.01], IR_DARK);
    P[J.gun] = b.build();
    return P;
  }
};

const partsCache = new Map<string, Parts>();
function partsOf(kind: BotKind, f: Faction): Parts {
  const key = `${kind}/${f}`;
  let p = partsCache.get(key);
  if (!p) {
    const nation = NATION_BOT[kind];
    const t = nation ? NATION_TEAMS[nation][f] : TEAMS[f];
    p = (BELLE_EPOQUE ? PARTS_BELLE : PARTS)[kind]!(t);
    partsCache.set(key, p);
  }
  return p;
}

/** A squad's robots as one rigidly skinned geometry (bone = robot × JOINTS + joint), shared per kind and side. */
const squadGeos = new Map<string, THREE.BufferGeometry>();
function squadGeo(kind: BotKind, f: Faction): THREE.BufferGeometry {
  const key = `${kind}/${f}`;
  let geo = squadGeos.get(key);
  if (geo) return geo;
  const parts = partsOf(kind, f);
  const list: THREE.BufferGeometry[] = [];
  for (let i = 0; i < SPECS[kind].n; i++)
    for (let j = 0; j < JOINTS; j++) {
      const p = parts[j];
      if (!p) continue;
      const g = p.clone();
      const n = g.attributes.position!.count;
      const idx = new Uint16Array(n * 4);
      const wt = new Float32Array(n * 4);
      for (let v = 0; v < n; v++) {
        idx[v * 4] = i * JOINTS + j;
        wt[v * 4] = 1;
      }
      g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idx, 4));
      g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wt, 4));
      list.push(g);
    }
  geo = mergeGeometries(list, false)!;
  for (const g of list) g.dispose();
  squadGeos.set(key, geo);
  return geo;
}

// ----------------------------------------------------------------- rig ---

/** A robot travelling off its slot: dropped from a Condor, or hopping aboard one. */
interface Trip {
  from: THREE.Vector3;
  /** Squad-space destination; null = its formation slot. */
  to: THREE.Vector3 | null;
  t: number;
  dur: number;
  /** Peak height of the hop above the straight line (0: a plain fall). */
  arc: number;
  /** Boarding: shrinks into the bay and is gone at the end. */
  away: boolean;
  /** Dropping: its size at the start (a rider, seated small, grows to its size on the map as it jumps). */
  s0: number;
}

interface Bot {
  b: THREE.Bone[];
  slot: [number, number];
  seat: { x: number; y: number; z: number; yaw: number } | null;
  /** Walk phase (rad) and this robot's cadence and idle quirks. */
  phase: number;
  rate: number;
  seed: number;
  /** On its feet (or in its seat). */
  up: boolean;
  /** ms since it began to fall (-1 while up); topple axes. */
  fallT: number;
  fallX: number;
  fallZ: number;
  landed: boolean;
  recoil: number;
  aim: number;
  look: number;
  yaw: number;
  scale: number;
  /** Pop-in progress (≤ 0 waits, 1 settled). */
  pop: number;
  trip: Trip | null;
  /** Gone (boarded, or sunk away after falling). */
  gone: boolean;
  /** Stepped off its slot, out of a vehicle's way (squad space). */
  px: number;
  pz: number;
}

export interface RigState {
  /** Frame time, ms. */
  dt: number;
  /** Ground speed of the squad, tiles/s (turning on the spot counts too). */
  speed: number;
  /** Fighting: weapons up (0 or 1). */
  aim: number;
  /** Aim elevation (rad, + up): troopers firing at aircraft point their rifles up. */
  pitch: number;
  /** Robots the squad has standing (squadAlive). */
  alive: number;
  /** Absolute ground height at world (x, z), so each robot stands on the terrain under it. */
  ground?: (x: number, z: number) => number;
  /** Riders only: stood up off the benches facing the ramp, ready to drop (0–1). */
  ready?: number;
  /** Vehicles close by: robots step aside out of their hulls (see Footprint). */
  avoid?: Footprint[];
  /** Tranchées (WP1): the squad is dug in (1) or not (0): its sandbag ring rises or sinks (SquadRig.dug). */
  entrenched?: number;
}

/** Sandbags, light and dark. */
const SACK = 0xb9a173;
const SACK_D = 0x9c8458;

/** A squad's sandbag ring (two courses round its formation), shared per kind; robots stand inside it. */
const bagGeos = new Map<BotKind, THREE.BufferGeometry>();
function bagGeo(kind: BotKind): THREE.BufferGeometry {
  let g = bagGeos.get(kind);
  if (g) return g;
  const s = SPECS[kind];
  const r = Math.max(...s.slots.map(([x, z]) => Math.hypot(x, z))) + 0.13;
  const b = new ModelBuilder({ grade: 0.25, ao: [0.08, 0.35] });
  const n = Math.max(12, Math.round((r * Math.PI * 2) / 0.085));
  for (let k = 0; k < 2; k++)
    for (let i = 0; i < n; i++) {
      const a = ((i + k * 0.5) / n) * Math.PI * 2;
      const rr = r - k * 0.012;
      b.block(0.085, 0.032, 0.05, [Math.sin(a) * rr, 0.016 + k * 0.03, Math.cos(a) * rr], (i + k) % 3 ? SACK : SACK_D, {
        rot: [0, a, 0],
        bevel: 0.01,
        edge: 1.15
      });
    }
  g = b.build();
  bagGeos.set(kind, g);
  return g;
}

/** A vehicle's hull on the ground: centre and heading (world, unit vector), half-length and half-width (tiles). */
export interface Footprint {
  x: number;
  z: number;
  fx: number;
  fz: number;
  hl: number;
  hw: number;
}

/** Topple, lie, sink (ms). */
const FALL_MS = 360;
const LIE_MS = 1400;
const SINK_MS = 1300;

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler(0, 0, 0, "ZYX");
const ident = new THREE.Matrix4();

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * One squad of robots on the map (or riding in a Condor's bay): a group to
 * place at the squad's position, turned to its facing (rotation.y = -facing),
 * holding the skinned mesh and its robots' bones.
 */
export class SquadRig {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly spec: Spec;
  readonly bots: Bot[] = [];
  /** A robot hit the ground (falling over, or dropping out of a Condor): world point. */
  onImpact: ((p: THREE.Vector3, kind: "fall" | "land") => void) | null = null;
  private move = 0;
  private ready = 0;
  private time = 0;
  private last: RigState = { dt: 0, speed: 0, aim: 0, pitch: 0, alive: 0 };
  /** How far the sandbag ring is up (0–1), easing toward RigState.entrenched. */
  dug = 0;
  private bags: THREE.Mesh | null = null;

  constructor(readonly kind: BotKind, readonly faction: Faction, seed = 0, alive?: number) {
    const s = (this.spec = SPECS[kind]);
    const bones: THREE.Bone[] = [];
    for (let i = 0; i < s.n; i++) {
      const b: THREE.Bone[] = [];
      for (let j = 0; j < JOINTS; j++) {
        const bone = new THREE.Bone();
        bone.position.set(...restAt(s, j));
        if (j === J.gun) bone.rotation.order = "ZYX";
        b.push(bone);
        bones.push(bone);
      }
      for (let j = 1; j < JOINTS; j++) b[parentOf(s, j)]!.add(b[j]!);
      const slot = s.slots[i]!;
      b[J.root]!.position.set(slot[0], 0, slot[1]);
      this.root.add(b[J.root]!);
      const r = hash(seed * 13.7 + i * 3.1);
      this.bots.push({
        b, slot, seat: null, phase: r * Math.PI * 2, rate: 0.94 + hash(seed + i * 7.3) * 0.12, seed: r,
        up: true, fallT: -1, fallX: 0, fallZ: 0, landed: false, recoil: 0, aim: 0, look: 0,
        yaw: (hash(seed * 3.3 + i) - 0.5) * 0.7, scale: s.size * (0.96 + hash(seed * 5.1 + i * 1.7) * 0.08), pop: 1, trip: null, gone: false, px: 0, pz: 0
      });
    }
    const mesh = new THREE.SkinnedMesh(squadGeo(kind, faction), modelMat("normal"));
    mesh.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), ident);
    // a fixed bound round the formation (the bones never stray far): no per-frame recompute
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.15, 0), 0.75);
    mesh.userData.model = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.mesh = mesh;
    this.root.add(mesh);
    // a squad that arrives already hurt shows only its survivors
    if (alive !== undefined)
      for (let r = 0; r < s.n - alive; r++) {
        const bot = this.bots[s.falls[r]!]!;
        bot.up = false;
        bot.gone = true;
        bot.b[J.root]!.scale.setScalar(1e-4);
      }
    this.update({ dt: 0, speed: 0, aim: 0, pitch: 0, alive: alive ?? s.n });
  }

  /** Robots on their feet (not falling, not gone). */
  standing(): number[] {
    const out: number[] = [];
    this.bots.forEach((b, i) => b.up && !b.trip && out.push(i));
    return out;
  }

  /** Everything has boarded or sunk away: the rig can go. */
  get done(): boolean {
    return this.bots.every((b) => b.gone);
  }

  /** Free the GPU side (the skeleton's bone texture) once the rig is off the scene for good. */
  dispose(): void {
    this.mesh.skeleton.dispose();
  }

  /** Robots pop in one after another (rolled out of the Assembly Bay), after `delay` ms. */
  popIn(delay = 0): void {
    this.bots.forEach((b, i) => (b.pop = -delay / 280 - i * 0.28));
  }

  /** Sit the robots in a Condor's bay: seats in this rig's space (tiles), facing yaw (rad, 0 = north). */
  seat(seats: { x: number; y: number; z: number; yaw: number }[]): void {
    this.bots.forEach((b, i) => (b.seat = seats[i] ?? null));
    this.root.scale.setScalar(RIDER_SCALE);
    // (a bench is longer than a formation is wide)
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.1, 0), 1.6);
  }

  /**
   * Robots drop from `from` (this rig's space) to their slots, a beat apart:
   * out of a Condor, starting at `s0` of their size (a rider's) and growing
   * to full size as they jump.
   */
  dropFrom(from: THREE.Vector3, spread: number, s0 = 1): void {
    this.bots.forEach((b, i) => {
      if (!b.up) return;
      const f = from.clone();
      f.x += (hash(b.seed * 9 + i) - 0.5) * spread;
      f.z += (hash(b.seed * 5 + i) - 0.5) * spread;
      b.trip = { from: f, to: null, t: -i * 70, dur: 420, arc: 0, away: false, s0 };
    });
  }

  /** Robots hop up into a Condor at `to` (this rig's space) and are gone. */
  board(to: THREE.Vector3): void {
    this.bots.forEach((b, i) => {
      if (!b.up) {
        b.gone = true;
        return;
      }
      const p = b.b[J.root]!.position;
      b.trip = { from: p.clone(), to: to.clone(), t: -i * 55, dur: 360, arc: 0.25, away: true, s0: 1 };
    });
  }

  /**
   * Out of sight: skip to the end of whatever was playing (no sparks). The
   * pop-in and a drop are over, robots the squad has lost are gone and the
   * rest stand in their slots — else they'd play out on first sight (dropped
   * robots streaking in from a Condor drawn far away).
   */
  settle(alive: number): void {
    const s = this.spec;
    const down = s.n - Math.max(0, Math.min(s.n, alive));
    for (let r = 0; r < s.n; r++) {
      const bot = this.bots[s.falls[r]!]!;
      bot.pop = 1;
      bot.recoil = 0;
      bot.fallT = -1;
      if (bot.trip && !bot.trip.away) bot.trip = null;
      if (r < down) {
        bot.trip = null;
        bot.up = false;
        bot.gone = true;
        bot.b[J.root]!.scale.setScalar(1e-4);
      } else if (!bot.trip) {
        bot.up = true;
        bot.gone = false;
      }
    }
  }

  /** Every standing robot falls (the squad was wiped out). */
  fallAll(): void {
    this.bots.forEach((b, i) => {
      if (!b.up) return;
      this.topple(b);
      b.fallT = -i * 90; // not quite together
    });
  }

  /**
   * Robot `i` fires: it snaps its weapon up, kicks, and its muzzle's world
   * position goes in `out`. Null if it is down (or busy hopping).
   */
  fire(i: number, out: THREE.Vector3): THREE.Vector3 | null {
    const bot = this.bots[i];
    if (!bot || !bot.up || bot.trip) return null;
    bot.aim = 1;
    bot.recoil = 1;
    this.pose(i, this.last, 0);
    const g = bot.b[J.gun]!;
    g.updateWorldMatrix(true, false);
    return g.localToWorld(out.set(...this.spec.muzzle));
  }

  /** World position of robot `i`'s muzzle as it stands (no kick). */
  muzzle(i: number, out: THREE.Vector3): THREE.Vector3 {
    const g = this.bots[i]!.b[J.gun]!;
    g.updateWorldMatrix(true, false);
    return g.localToWorld(out.set(...this.spec.muzzle));
  }

  /** World position of robot `i`'s chest. */
  chest(i: number, out: THREE.Vector3): THREE.Vector3 {
    const t = this.bots[i]!.b[J.torso]!;
    t.updateWorldMatrix(true, false);
    return t.localToWorld(out.set(0, 0.05, 0));
  }

  update(st: RigState): void {
    const s = this.spec;
    const k = st.dt / 1000;
    this.time += st.dt;
    this.last = st;
    // as HP falls, robots fall in order; healed back up, they rejoin
    const down = s.n - Math.max(0, Math.min(s.n, st.alive));
    for (let r = 0; r < s.n; r++) {
      const bot = this.bots[s.falls[r]!]!;
      const stand = r >= down;
      if (stand && !bot.up) {
        if (bot.trip?.away) continue;
        bot.up = true;
        bot.gone = false;
        bot.fallT = -1;
        bot.pop = 0;
      } else if (!stand && bot.up) this.topple(bot);
    }
    this.dig(st.entrenched ?? 0, k);
    const moveTarget = Math.min(1, st.speed / 0.5);
    this.move += (moveTarget - this.move) * (1 - Math.exp(-k * 9));
    this.ready += ((st.ready ?? 0) - this.ready) * (1 - Math.exp(-k * 6));
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i]!;
      // (strides scale with the robot: its feet keep pace with the ground)
      bot.phase += k * (st.speed / (s.cycle * bot.scale)) * Math.PI * 2 * bot.rate;
      const want = bot.seat ? 0 : st.aim;
      bot.aim += (want - bot.aim) * (1 - Math.exp(-k * (want > bot.aim ? 12 : 2.5)));
      bot.recoil = Math.max(0, bot.recoil - k * 7);
      const scan = (0.55 * Math.sin(this.time / 1500 + bot.seed * 9) + 0.3 * Math.sin(this.time / 610 + bot.seed * 3)) * (1 - bot.aim);
      bot.look += (scan * (1 - this.move * 0.8) - bot.look) * (1 - Math.exp(-k * 4));
      if (bot.pop < 1) bot.pop = Math.min(1, bot.pop + k / 0.28);
      this.pose(i, st, st.dt);
    }
  }

  /** Raise or sink the sandbag ring toward `want` (0–1), `k` seconds on; built the first time it's needed. */
  private dig(want: number, k: number): void {
    if (want <= 0 && this.dug <= 0) return;
    this.dug += (want - this.dug) * (k > 0 ? 1 - Math.exp(-k * 3) : 1);
    if (this.dug < 0.005 && want <= 0) this.dug = 0;
    if (!this.bags) {
      const m = new THREE.Mesh(bagGeo(this.kind), modelMat("normal"));
      m.userData.model = true;
      m.castShadow = true;
      m.receiveShadow = true;
      this.bags = m;
      this.root.add(m);
    }
    this.bags.visible = this.dug > 0.01;
    this.bags.scale.set(1, Math.max(1e-3, this.dug), 1);
  }

  private topple(bot: Bot): void {
    bot.up = false;
    bot.fallT = 0;
    bot.landed = false;
    bot.trip = null;
    // outward, away from the squad's centre: never across a robot still standing
    const [sx, sz] = bot.slot;
    const side = Math.abs(sx) > Math.abs(sz);
    bot.fallX = side ? 0 : sz > 0 ? 1 : -1;
    bot.fallZ = side ? (sx > 0 ? -1 : 1) : 0;
  }

  /** Pose robot `i`'s bones (advancing its fall or trip by `dt` ms). */
  private pose(i: number, st: RigState, dt: number): void {
    const s = this.spec;
    const bot = this.bots[i]!;
    const B = bot.b;
    const root = B[J.root]!;
    if (bot.gone) {
      root.scale.setScalar(1e-4);
      return;
    }
    const m = bot.seat ? 0 : this.move;
    const a = bot.aim;
    const p = bot.phase;
    // (1 with the left foot out in front, -1 the right: the arms and shoulders swing against the legs)
    const sa = Math.cos(p);
    const t = this.time;

    // ---- legs: a run cycle, braced when firing still ----
    // Each foot is planted for `stance` of the stride, sliding back under the hips at just the
    // body's speed (so it stays put on the ground), then lifts and swings forward to land again;
    // the hips ride low enough for the legs to reach (lowest at each footfall), and two-bone IK
    // turns the feet's paths into thigh and knee angles.
    const stride = (s.cycle * s.stance) / bot.rate;
    const ankle = s.hipY - s.thigh - s.shin;
    const reach = (s.thigh + s.shin) * 0.97;
    const runHip = ankle + Math.sqrt(Math.max(0, reach * reach - stride * stride * 0.25)) - s.crouch;
    const u0 = (((p / (Math.PI * 2)) % 1) + 1) % 1;
    const q = (u0 - s.stance / 2) * Math.PI * 2;
    let hipsY = lerp(s.hipY, runHip - 0.005 * Math.cos(2 * q), m);
    const leg = (u: number): [number, number] => {
      let f: number;
      let lift = 0;
      if (u < s.stance) f = stride * (0.5 - u / s.stance);
      else {
        const k = (u - s.stance) / (1 - s.stance);
        f = stride * (k * k * (3 - 2 * k) - 0.5);
        lift = s.lift * Math.sin(Math.PI * k);
      }
      return ik(f * m, hipsY - ankle - lift * m, s.thigh, s.shin);
    };
    let [thL, shL] = leg(u0);
    let [thR, shR] = leg((u0 + 0.5) % 1);
    const brace = a * (1 - m);
    if (brace > 0) {
      const br = s.brace;
      thL = lerp(thL, br[0], brace);
      shL = lerp(shL, br[1], brace);
      thR = lerp(thR, br[2], brace);
      shR = lerp(shR, br[3], brace);
      hipsY = lerp(hipsY, s.hipY - br[4], brace);
    }
    const idle = (1 - m) * (1 - a);
    hipsY += idle * 0.0025 * Math.sin(t / 700 + bot.seed * 7);

    // ---- upper body: carry (swinging with the stride) blending to aim ----
    const C = s.carry;
    const A = s.aim;
    let aLx = lerp(C.armL[0], A.armL[0], a) - s.swing[0] * sa * m * (1 - a);
    let aLz = lerp(C.armL[1], A.armL[1], a);
    let aRx = lerp(C.armR[0], A.armR[0], a) + s.swing[1] * sa * m * (1 - a);
    let aRz = lerp(C.armR[1], A.armR[1], a);
    let gx = lerp(C.gun[0], A.gun[0] + st.pitch, a);
    let gy = lerp(C.gun[1], A.gun[1], a);
    let gz = lerp(C.gun[2], A.gun[2], a);
    let torsoX = lerp(C.torso, A.torso, a) + s.lean * m * (1 - a * 0.5) + bot.recoil * 0.1;
    let torsoY = 0.14 * sa * m;
    let torsoZ = idle * 0.035 * Math.sin(t / 1100 + bot.seed * 5);
    let headX = -torsoX * 0.6;
    let headY = bot.look - torsoY;
    let rootX = 0;
    let rootZ = 0;
    let sink = 0;
    let sc = bot.scale;

    // riding: sat on the bench, hands on knees, weapon upright, looking about — or stood up
    // facing the ramp, weapon ready, as it opens for the drop
    const up = bot.seat ? this.ready * (0.75 + bot.seed * 0.25) : 0;
    if (bot.seat) {
      const sit = 1 - up;
      thL = thR = 1.5 * sit;
      shL = shR = -1.5 * sit;
      hipsY = lerp(s.hipY - s.thigh + 0.004, s.hipY, up);
      aLx = lerp(s.seatArms, C.armL[0], up);
      aRx = lerp(s.seatArms, C.armR[0], up);
      aLz = lerp(0.15, C.armL[1], up);
      aRz = lerp(-0.15, C.armR[1], up);
      gx = lerp(s.seatGun[0], C.gun[0], up);
      gy = lerp(s.seatGun[1], C.gun[1], up);
      gz = lerp(s.seatGun[2], C.gun[2], up);
      torsoX = (0.04 + 0.02 * Math.sin(t / 900 + bot.seed * 4)) * sit;
      torsoY = 0;
      torsoZ = 0;
    }

    if (bot.fallT >= 0 || bot.fallT < -1) {
      // shot down: it topples over, crumpling, lies a moment, then sinks away
      bot.fallT += dt;
      const ft = Math.max(0, bot.fallT);
      const k1 = Math.min(1, ft / FALL_MS);
      const e = k1 * k1;
      rootX = bot.fallX * 1.45 * e;
      rootZ = bot.fallZ * 1.45 * e;
      thL = lerp(thL, 0.7, k1);
      thR = lerp(thR, 0.3, k1);
      shL = lerp(shL, -1.1, k1);
      shR = lerp(shR, -0.7, k1);
      aLx = lerp(aLx, bot.fallX >= 0 ? 2.3 : -0.4, k1);
      aRx = lerp(aRx, bot.fallX >= 0 ? 1.9 : 0.2, k1);
      aLz = lerp(aLz, -0.5, k1);
      aRz = lerp(aRz, 0.6, k1);
      gx = lerp(gx, -0.9, k1);
      headX = lerp(headX, 0.5, k1);
      hipsY = lerp(hipsY, s.hipY * 0.85, k1);
      if (k1 >= 1 && !bot.landed) {
        bot.landed = true;
        if (this.onImpact) this.onImpact(this.chest(i, tmpV), "fall");
      }
      const q = Math.min(1, Math.max(0, (ft - LIE_MS) / SINK_MS));
      sc *= 1 - q * 0.85;
      if (q >= 1) {
        bot.gone = true;
        root.scale.setScalar(1e-4);
        return;
      }
      sink = -q * 0.08;
    }

    // ---- place the robot: formation slot (or seat), on the ground under it ----
    if (bot.seat) {
      // (stood up, a half step in off the bench and turned aft)
      root.position.set(bot.seat.x * (1 - up * 0.18), bot.seat.y, bot.seat.z);
      root.rotation.set(0, bot.seat.yaw * (1 + up), 0);
    } else {
      const r = this.root;
      const cy = Math.cos(r.rotation.y);
      const sy = Math.sin(r.rotation.y);
      if (st.avoid && bot.up) {
        // shoulder out of any vehicle's footprint (eased: they shuffle aside); a fallen robot stays put
        let tx = 0;
        let tz = 0;
        const wx = r.position.x + bot.slot[0] * cy + bot.slot[1] * sy;
        const wz = r.position.z - bot.slot[0] * sy + bot.slot[1] * cy;
        for (const o of st.avoid) {
          const dx = wx - o.x;
          const dz = wz - o.z;
          const along = dx * o.fx + dz * o.fz;
          const across = dx * -o.fz + dz * o.fx;
          if (Math.abs(along) >= o.hl || Math.abs(across) >= o.hw) continue;
          // sideways, out of the vehicle's path (dead centre: to the side of its slot)
          const side = Math.sign(across) || Math.sign(bot.slot[0]) || 1;
          const out = side * o.hw - across;
          tx += -o.fz * out;
          tz += o.fx * out;
        }
        const kk = 1 - Math.exp(-(dt / 1000) * 10);
        bot.px += (tx * cy - tz * sy - bot.px) * kk;
        bot.pz += (tx * sy + tz * cy - bot.pz) * kk;
      }
      const lx = bot.slot[0] + bot.px;
      const lz = bot.slot[1] + bot.pz;
      root.position.set(lx, sink, lz);
      if (st.ground) {
        const wx = r.position.x + lx * cy + lz * sy;
        const wz = r.position.z - lx * sy + lz * cy;
        const gy0 = Math.max(-0.2, Math.min(0.2, st.ground(wx, wz) - r.position.y));
        root.position.y += gy0;
      }
      root.rotation.set(rootX, bot.yaw * idle, rootZ);
    }
    if (bot.trip) this.travel(i, bot, bot.trip, dt);
    if (bot.gone) return;
    if (bot.trip) {
      // mid-air: legs tucked, arms out
      const tuck = bot.trip.away ? 0.6 : 1;
      thL = thR = 0.9 * tuck;
      shL = shR = -1.3 * tuck;
      aLz = 0.7;
      aRz = -0.7;
      aLx = aRx = 0.5;
    }
    const pop = bot.pop >= 1 ? 1 : bot.pop <= 0 ? 0 : backOut(bot.pop);
    if (bot.trip && !bot.trip.away) sc *= lerp(bot.trip.s0, 1, Math.max(0, Math.min(1, bot.trip.t / bot.trip.dur)));
    if (!bot.trip?.away) root.scale.setScalar(Math.max(1e-4, sc * pop));

    B[J.hips]!.position.y = hipsY;
    B[J.thighL]!.rotation.set(thL, 0, 0);
    B[J.thighR]!.rotation.set(thR, 0, 0);
    B[J.shinL]!.rotation.set(shL, 0, 0);
    B[J.shinR]!.rotation.set(shR, 0, 0);
    B[J.torso]!.rotation.set(torsoX, torsoY, torsoZ);
    B[J.head]!.rotation.set(headX, headY, 0);
    B[J.armL]!.rotation.set(aLx, 0, aLz);
    B[J.armR]!.rotation.set(aRx, 0, aRz);
    const g = B[J.gun]!;
    g.rotation.set(gx, gy, gz);
    const at0 = C.gunAt;
    const at1 = bot.seat ? C.gunAt : A.gunAt;
    g.position.set(lerp(at0[0], at1[0], a), lerp(at0[1], at1[1], a), lerp(at0[2], at1[2], a));
    if (bot.recoil > 0) {
      // the kick drives the weapon straight back along its own axis
      tmpE.set(gx, gy, gz, "ZYX");
      g.position.add(tmpV.set(0, 0, bot.recoil * 0.018).applyQuaternion(tmpQ.setFromEuler(tmpE)));
    }
  }

  /** Move a robot along its trip (a drop out of a Condor, or a hop into one). */
  private travel(i: number, bot: Bot, tr: Trip, dt: number): void {
    tr.t += dt;
    const root = bot.b[J.root]!;
    const k = Math.max(0, Math.min(1, tr.t / tr.dur));
    const to = tr.to ?? tmpV.set(bot.slot[0] + bot.px, root.position.y, bot.slot[1] + bot.pz);
    const toX = to.x;
    const toY = to.y;
    const toZ = to.z;
    if (tr.away) {
      // a quick hop up and in, shrinking into the bay
      const e = k * (2 - k);
      root.position.set(lerp(tr.from.x, toX, e), lerp(tr.from.y, toY, e) + Math.sin(k * Math.PI) * tr.arc, lerp(tr.from.z, toZ, e));
      root.scale.setScalar(Math.max(1e-4, bot.scale * (1 - k * 0.7)));
      if (k >= 1) {
        bot.trip = null;
        bot.gone = true;
        root.scale.setScalar(1e-4);
      }
      return;
    }
    // dropping: out over the slot, falling faster as it goes
    const e = k * k;
    root.position.set(lerp(tr.from.x, toX, Math.min(1, k * 1.6)), lerp(tr.from.y, toY, e), lerp(tr.from.z, toZ, Math.min(1, k * 1.6)));
    if (k >= 1) {
      bot.trip = null;
      if (this.onImpact) this.onImpact(this.chest(i, tmpV).setY(this.root.position.y + root.position.y), "land");
    }
  }

  /**
   * Bake the robots' current pose into one plain (unskinned) geometry in
   * this rig's space: `robots` and `joints` pick what to include (the
   * gallery, a half-built robot on the Assembly Bay's cradle).
   */
  bake(robots?: number[], joints?: number[]): THREE.BufferGeometry {
    const parts = partsOf(this.kind, this.faction);
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert();
    const list: THREE.BufferGeometry[] = [];
    for (const i of robots ?? this.bots.map((_, i) => i))
      for (const j of joints ?? [...Array(JOINTS).keys()]) {
        const p = parts[j];
        const bone = this.bots[i]?.b[j];
        if (!p || !bone) continue;
        list.push(p.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, bone.matrixWorld)));
      }
    const g = mergeGeometries(list, false)!;
    for (const l of list) l.dispose();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Two-bone leg IK in the leg's plane: thigh and shin angles (about x; the
 * thigh + swings the foot forward, the shin − folds back at the knee) that
 * put the ankle `f` ahead of the hip and `d` below it. (The Goliath walks on
 * it too: three/goliath.ts.)
 */
export function ik(f: number, d: number, a: number, b: number): [number, number] {
  const r = Math.max(Math.abs(a - b) + 1e-4, Math.min(a + b - 1e-4, Math.hypot(f, d)));
  const hip = Math.acos(Math.max(-1, Math.min(1, (a * a + r * r - b * b) / (2 * a * r))));
  const knee = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - r * r) / (2 * a * b))));
  return [Math.atan2(f, d) + hip, knee - Math.PI];
}

function backOut(k: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

/** A squad standing at ease in formation, baked into one plain geometry (the model gallery, unitDef). */
export function squadStatic(kind: BotKind, f: Faction): THREE.BufferGeometry {
  return new SquadRig(kind, f, 1).bake();
}

/** One robot standing at ease (or only some of its joints: a half-built one), in its own space. */
export function botStatic(kind: BotKind, f: Faction, joints?: number[], seed = 2): THREE.BufferGeometry {
  const rig = new SquadRig(kind, f, seed);
  const r = rig.bots[0]!.b[J.root]!;
  r.position.set(0, 0, 0);
  r.rotation.set(0, 0, 0);
  return rig.bake([0], joints);
}

/** Robot height (tiles) for bars and labels. */
export function botHeight(kind: BotKind): number {
  const s = SPECS[kind];
  return (s.hipY + s.waist + s.neck + 0.06) * s.size;
}

/**
 * Riders sit well under their size on the map: a dropship no bigger than a
 * Mastodon seats two whole squads down its benches (the map's robots are drawn
 * big for readability, see Spec.size).
 */
export const RIDER_SCALE = 0.4;

/**
 * Seats for a squad riding in the Condor's bay — `side` 0 the port bench, 1
 * starboard — facing across the bay, in a group that undoes the Condor's
 * model scale `s` (so tiles, relative to the Condor's body), for a rig
 * scaled by RIDER_SCALE (seat() does that).
 */
export function baySeats(kind: BotKind, side: number, s: number): { x: number; y: number; z: number; yaw: number }[] {
  const B = CONDOR_BAY;
  const n = SPECS[kind].n;
  const k = s / RIDER_SCALE;
  const step = Math.min(0.14, (B.z1 - B.z0 - 0.03) / n);
  const z0 = (B.z0 + B.z1) / 2 - (step * (n - 1)) / 2;
  const sx = side ? 1 : -1;
  const out: { x: number; y: number; z: number; yaw: number }[] = [];
  for (let i = 0; i < n; i++) out.push({ x: sx * B.benchX * k, y: B.floor * k, z: (z0 + i * step) * k, yaw: (sx * Math.PI) / 2 });
  return out;
}

/**
 * The nations' squads as unit models (belle/index.ts BE_UNIT_MODELS): the squad
 * standing at ease, like models.ts squadModel. `t` is the side's TEAMS entry
 * (unitDef passes it); the robots pick their nation's colours themselves.
 */
export function nationSquadDef(kind: BotKind, t: Team) {
  const f: Faction = t === TEAMS.red ? "red" : "blue";
  const h = botHeight(kind);
  return { hull: squadStatic(kind, f), mount: [0, 0, 0] as Vec3, muzzle: [0, h * 0.75, -0.3] as Vec3, rotors: [], height: h };
}
