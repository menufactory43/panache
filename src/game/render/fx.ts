import * as THREE from "three";
import { sfx, type SfxName } from "../audio";
import type { Biome, Faction, FxEvent, Projectile, WeaponFx } from "../../sim/types";
import { ModelBuilder } from "../three/builder";
import { fowUniforms, glowMat, modelMat } from "../three/materials";
import { GM_D, modelMesh, rubbleGeometry } from "../three/models";
import { TEX, type EmitCfg } from "../three/particles";
import { WATER_LEVEL } from "../three/terrain";
import { BELLE_EPOQUE } from "../three/theme";
import { AIR_H, type P3, type View } from "../three/view";
import { Arcs, type BoltOpts } from "../three/arcs";
import * as BE from "./belle-fx";

type ShotEvent = Extract<FxEvent, { type: "shot" }>;

/**
 * What the weapon fx need from the robot squads on show (EntityRenderer
 * provides it): a squad's volley leaves every standing robot's own muzzle.
 */
export interface SquadFire {
  /** Robots of unit `id` taking part in this volley (rig indices), or null if it isn't a squad on show. */
  shooters(id: number, fx: WeaponFx): number[] | null;
  /** Robot `i` of squad `id` fires now: it kicks, and this is its muzzle (null if it has gone down). */
  fire(id: number, i: number): P3 | null;
  /** Did a squad on show just die at (x, y)? (Its robots topple: no vehicle fireball.) */
  diedAt(x: number, y: number): boolean;
}

/** A purely visual projectile (tracer, rocket, missile) flying for `dur` ms. */
interface Flier {
  obj: THREE.Object3D;
  a: P3;
  b: P3;
  /** Bezier control point (missiles curve), else null. */
  c: P3 | null;
  t: number;
  dur: number;
  trail: boolean;
  /** A Belle Époque Congreve rocket: sputtering sparks and powder smoke instead of a clean contrail. */
  rocket: boolean;
  /** Distance flown since the last trail puff (tiles). */
  acc: number;
  onHit?: () => void;
}

const LASER_TINT: Record<Faction, number> = { blue: 0x7fd4ff, red: 0xff6a4a };
const DUST_TINT: Record<Biome, number> = {
  temperate: 0x8a7453, desert: 0xd8b77a, arctic: 0xf2f6ff, volcanic: 0x5d5752, tropical: 0xe6dcc4
};
/** Smoke leans gently downwind: away from the sun, to the south-east. */
const WIND: [number, number] = [0.16, 0.08];
/** A missile or shell leaves a puff of trail every this many tiles (more sparsely as the smoke pool fills). */
const TRAIL_STEP = 0.15;

/** Thick, sun-lit battle smoke: dark at the source, thinning to grey as it climbs. */
const SMOKE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [1000, 1800], speed: [0.06, 0.3], up: [0.35, 0.75], size: [0.42, 0.56], grow: [2.2, 3],
  alpha: [0.72, 0], tints: [0x47433f, 0x3a3734, 0x524d47], end: 0x8f8a83, drag: 0.6, spin: 0.5, rot: 0.4, wind: WIND, fadeIn: 0.1, easeOut: true
};
/** The rail rifle's ionised wake, glowing a moment along the shot's line. */
const RAIL_WAKE: EmitCfg = {
  tex: TEX.glow, additive: true, life: [260, 420], speed: [0, 0.05], up: [0.02, 0.08], size: [0.1, 0.14], grow: [1.6, 2.2],
  alpha: [0.55, 0], tints: [0xffe9b8, 0xfff4d8], end: 0xff9a3a
};
/** Grey smoke off a damaged building's roof. */
const DAMAGE_SMOKE: EmitCfg = {
  ...SMOKE, life: [1500, 2400], up: [0.5, 0.85], size: [0.38, 0.5], grow: [2.6, 3.4], alpha: [0.62, 0],
  tints: [0x6e6962, 0x7a756d], end: 0xa8a39b, wind: [0.4, 0.2]
};
/** Black smoke billowing off a burning one. Both lean well downwind, so the plume shows against the ground, not just the dark roof. */
const BURN_SMOKE: EmitCfg = BELLE_EPOQUE ? BE.COAL_BURN : {
  ...SMOKE, life: [1800, 2800], up: [0.6, 1.0], size: [0.5, 0.65], grow: [2.8, 3.6], alpha: [0.82, 0],
  tints: [0x3a3633, 0x45403b, 0x4f4a44], end: 0x8a857e, wind: [0.4, 0.2]
};
/** Pale gun smoke at a muzzle. */
const GUNSMOKE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [450, 800], speed: [0.05, 0.2], up: [0.15, 0.35], size: [0.16, 0.22], grow: [2, 2.8],
  alpha: [0.5, 0], tints: [0xb8b2a8, 0xa39d94], end: 0xd6d1c8, drag: 0.5, spin: 0.4, rot: 0.4, wind: WIND, fadeIn: 0.15, easeOut: true
};
/** Flames licking a burning building: hot yellow cooling to red as they rise and shrink. */
const FIRE: EmitCfg = {
  tex: TEX.fire, additive: true, life: [320, 620], speed: [0.05, 0.3], up: [0.6, 1.2], size: [0.55, 0.75], grow: [0.45, 0.7],
  alpha: [0.85, 0], tints: [0xffc257, 0xff9a2e, 0xffd98a], end: 0xc23a10, drag: 0.5, spin: 2.5
};
const SPARKS: EmitCfg = {
  tex: TEX.spark, additive: true, life: [150, 450], speed: [1, 4], up: [0.5, 2.6], size: [0.18, 0.26], grow: [0.2, 0.3],
  alpha: [1, 0], tints: [0xffffff, 0xfff0c0], end: 0xff8a2a, gravity: -6
};
/** Glowing bits tossed out of a big blast that drift down. */
const EMBERS: EmitCfg = {
  tex: TEX.glow, additive: true, life: [600, 1100], speed: [0.5, 1.7], up: [1.4, 3], size: [0.1, 0.15], grow: [0.4, 0.6],
  alpha: [1, 0], tints: [0xffd27a, 0xffb347], end: 0xff3a0a, gravity: -2.6, drag: 0.55
};
const DEBRIS: EmitCfg = {
  tex: TEX.chunk, tex2: TEX.debris, life: [600, 950], speed: [0.8, 2.6], up: [2, 3.6], size: [0.12, 0.2], grow: [0.8, 1],
  alpha: [1, 0.5], tints: BELLE_EPOQUE ? BE.DEBRIS_TINTS : [0x5d6168, 0x4c4741, 0x6e655a, 0x3c3f44], gravity: -9.5, spin: 14
};
const TRAIL: EmitCfg = {
  tex: TEX.smoke, life: [320, 600], speed: [0, 0.06], up: [0.04, 0.14], size: [0.16, 0.21], grow: [2.4, 3.2],
  alpha: [0.5, 0], tints: [0xdedad3], end: 0xb4b0aa, wind: WIND, fadeIn: 0.08, easeOut: true
};
/** The rocket motor's flame at the tail (a fresh one every frame reads as a steady burn). */
const EXHAUST: EmitCfg = {
  tex: TEX.fire, additive: true, life: [50, 90], size: [0.13, 0.17], grow: [0.5, 0.7], alpha: [0.9, 0], tints: [0xffd27a, 0xffb347], end: 0xff6a1e
};
/** Spray thrown up where a blast or a falling hull hits the water. */
const SPLASH: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [450, 800], speed: [0.4, 1.1], up: [1.2, 2.4], size: [0.16, 0.24], grow: [1.8, 2.4],
  alpha: [0.75, 0], tints: [0xe8f4ff, 0xcfe6f5], end: 0xffffff, gravity: -4, drag: 0.5, rot: 0.5, easeOut: true
};
/** Mist kicked off the water (a hover hull's wake, a small splash). */
const SPRAY: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [350, 650], speed: [0.05, 0.2], up: [0.1, 0.3], size: [0.14, 0.2], grow: [2, 2.6],
  alpha: [0.45, 0], tints: [0xeef6ff, 0xd6e8f4], drag: 0.6, rot: 0.5, fadeIn: 0.1, easeOut: true
};
/** Molten spatter flung up where something plunges into the lava, crusting dark as it falls back (light would vanish on the glow). */
const LAVA_GOUT: EmitCfg = {
  tex: TEX.fire, life: [380, 650], speed: [0.4, 1.1], up: [1.4, 2.6], size: [0.13, 0.19], grow: [0.8, 1],
  alpha: [1, 0.35], tints: [0xffc040, 0xff9a2e], end: 0x3a1a10, gravity: -6, drag: 0.7, spin: 3
};
const HEAL: EmitCfg = {
  tex: TEX.spark, additive: true, life: [300, 600], speed: [0.1, 0.4], up: [0.4, 0.9], size: [0.22, 0.3], grow: [0, 0.1],
  alpha: [1, 0], tints: [0x7dff9a]
};
/** Steam venting off a Goliath's hydraulics (packing up, a Gantry finishing one): white, quick, rising and thinning downwind. */
const STEAM: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [550, 950], speed: [0.15, 0.45], up: [0.6, 1.0], size: [0.16, 0.24], grow: [2.4, 3.2],
  alpha: [0.6, 0], tints: [0xe8eef2, 0xdfe6ea], end: 0xf6f8fa, drag: 0.55, spin: 0.4, rot: 0.4, wind: [0.3, 0.12], fadeIn: 0.12, easeOut: true
};
/** Hearts bubbling up out of a Goliath in love: pink and red, rising, rocking and fading. */
const HEARTS: EmitCfg = {
  tex: TEX.heart, life: [1600, 2500], speed: [0.1, 0.35], up: [0.5, 0.9], size: [0.26, 0.4], grow: [1.15, 1.5],
  alpha: [1, 0], tints: [0xff5fa2, 0xff3b6b, 0xff8cc6, 0xe0245e], drag: 0.5, spin: 0.9, rot: 0.35, fadeIn: 0.08, easeOut: true
};
/** A welding arc's spatter: white-hot, cooling to amber, falling. */
const WELD: EmitCfg = {
  tex: TEX.spark, additive: true, life: [180, 420], speed: [0.6, 2.2], up: [0.2, 1.6], size: [0.1, 0.16], grow: [0.2, 0.3],
  alpha: [1, 0], tints: [0xffffff, 0xfff4d0], end: 0xffa040, gravity: -7
};

/** Bigger black-powder clouds for the cannon and the big guns. */
const POWDER_MID: EmitCfg = { ...BE.POWDER, size: [0.16, 0.22] };
const POWDER_BIG: EmitCfg = { ...BE.POWDER, size: [0.24, 0.32], life: [2200, 3400] };

const tracerGeo = new THREE.BoxGeometry(0.035, 0.035, 1);
let tracerMat: THREE.MeshBasicMaterial | null = null;
let missileGeo: THREE.BufferGeometry | null = null;
let shellGeo: THREE.BufferGeometry | null = null;
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
const up = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();
/** Tracers stay at least this many CSS px thick and long, so they still read zoomed out. */
const TRACER_MIN_W = 1.7;
const TRACER_MIN_L = 13;

/** Is tile point (x, y) out of the player's sight? Read from the fog texture the terrain keeps (a texel per tile, plus a border). */
function fogged(x: number, y: number): boolean {
  const tex = fowUniforms.uFowMap.value as THREE.DataTexture | null;
  if (!tex || fowUniforms.uFowOn.value === 0) return false;
  const { data, width, height } = tex.image as { data: Uint8Array; width: number; height: number };
  const tx = Math.min(width - 1, Math.max(0, Math.floor(x) + 1));
  const ty = Math.min(height - 1, Math.max(0, Math.floor(y) + 1));
  return data[ty * width + tx]! > 64;
}

function missile(): THREE.BufferGeometry {
  if (missileGeo) return missileGeo;
  const b = new ModelBuilder();
  // built pointing +Z (Object3D.lookAt aims +Z at the target)
  b.tube(0.022, 0.2, 6, [0, 0, 0], 0xd9dde3);
  b.cone(0.022, 0.06, 6, [0, 0, 0.13], 0xc84a3a, { rot: [Math.PI / 2, 0, 0] });
  b.box(0.07, 0.006, 0.04, [0, 0, -0.08], 0x7c8490);
  b.box(0.006, 0.07, 0.04, [0, 0, -0.08], 0x7c8490);
  b.sphere(0.025, [0, 0, -0.11], 0xffd27a, { glow: 1, w: 5, h: 3 });
  return (missileGeo = b.build());
}

function shell(): THREE.BufferGeometry {
  if (shellGeo) return shellGeo;
  const b = new ModelBuilder();
  b.sphere(0.06, [0, 0, 0], GM_D, { w: 7, h: 5, scale: [1, 1, 1.5] });
  return (shellGeo = b.build());
}

export class Fx {
  /** Robot squads on show (set by the entity renderer). */
  squads: SquadFire | null = null;
  /**
   * Where a slow shell fired by unit `sourceId` leaves its barrel, if not
   * from the usual low launch point (a Goliath's shoulder mortars, set by the
   * entity renderer): read once, as the shell appears.
   */
  shellFrom: ((sourceId: number) => P3 | null) | null = null;
  /** What fired (a unit or building kind, set by GameScene): the Belle Époque look tells the Blériot's guns from the Batterie Ruggieri's rockets. */
  sourceKind: ((sourceId: number) => string | null) | null = null;
  /** Electric arcs (Belle Époque only). */
  readonly arcs: Arcs | null;
  private fliers: Flier[] = [];
  private shells = new Map<number, THREE.Mesh>();
  private rubbles: THREE.Object3D[] = [];
  private dustCfg: EmitCfg;
  /** Dirt thrown out along the ground by a blast. */
  private kickCfg: EmitCfg;
  /** Blast smoke: paler ash over the dark volcanic ground, where black smoke would vanish. */
  private smoke: EmitCfg;
  private plumeTints: number[];
  /** The map's liquid is lava (else water or icy water). */
  private lava: boolean;

  constructor(
    private v: View,
    biome: Biome,
    /** Volume for a sound at tile point (x, y): 0 when far off-screen. */
    private earshot: (x: number, y: number) => number
  ) {
    const dust = DUST_TINT[biome];
    this.dustCfg = {
      tex: TEX.puff, tex2: TEX.puff2, life: [500, 900], speed: [0.03, 0.15], up: [0.05, 0.22], size: [0.2, 0.28], grow: [2.4, 3],
      alpha: [0.42, 0], tints: [dust], drag: 0.7, rot: 0.5, fadeIn: 0.1, easeOut: true
    };
    this.kickCfg = {
      tex: TEX.puff, tex2: TEX.puff2, life: [550, 950], speed: [1.3, 2.4], up: [0.05, 0.3], size: [0.2, 0.3], grow: [2, 2.8],
      alpha: [0.6, 0], tints: [dust], drag: 0.06, rot: 0.5, fadeIn: 0.05, easeOut: true
    };
    const ash = biome === "volcanic";
    // (Belle Époque: coal-black smoke, except over the dark volcanic ground, where it would vanish)
    this.smoke = ash ? { ...SMOKE, tints: [0x6a645d, 0x5d5852, 0x77716a], end: 0xaaa49c } : BELLE_EPOQUE ? BE.COAL_SMOKE : SMOKE;
    this.plumeTints = ash ? [0x57524c, 0x625c56, 0x6d6760] : BELLE_EPOQUE ? [0x1c1a18, 0x24211f, 0x2b2825] : [0x2c2a28, 0x353230, 0x403b37];
    this.lava = biome === "volcanic";
    // (Belle Époque: a short brass-orange shell streak)
    tracerMat ??= glowMat(BELLE_EPOQUE ? 0xffa646 : 0xffe2a0, 1);
    this.arcs = BELLE_EPOQUE ? new Arcs(v.rig) : null;
    if (this.arcs) v.scene.add(this.arcs.mesh);
  }

  /** A sound at tile point (x, y): as loud as it is close to the view. */
  sound(name: SfxName, x: number, y: number, vol = 1): void {
    sfx.play(name, vol * this.earshot(x, y));
  }

  emit(cfg: EmitCfg, p: P3, n: number): void {
    this.v.particles.emit(cfg, p.x, p.y, p.h, n);
  }

  // ------------------------------------------------------------- shots ---

  /** A weapon fired from `from` toward `to` (tiles + height). `faction` colours lasers. */
  shot(ev: ShotEvent, from: P3, to: P3, faction: Faction): void {
    const fx: WeaponFx = ev.fx;
    const flash = (scale: number, tint = 0xffd27a) => this.muzzle(from, scale, tint);
    const squad = this.squads?.shooters(ev.sourceId, fx);
    if (squad) {
      this.volley(ev, squad, from, to);
      return;
    }
    if (BELLE_EPOQUE) {
      this.belleShot(ev, from, to);
      return;
    }
    switch (fx) {
      case "cannon":
        flash(0.5);
        this.emit(GUNSMOKE, from, 1);
        this.tracer(from, to, 1, () => this.impact(to, 0.35, ev.air));
        this.sound("cannon", from.x, from.y, 0.8);
        break;
      case "heavy-cannon":
        flash(0.95);
        this.emit({ ...GUNSMOKE, size: [0.22, 0.3] }, from, 2);
        this.tracer(from, to, 1.8, () => this.impact(to, 0.7, ev.air));
        this.sound("heavy", from.x, from.y);
        break;
      case "mg":
        flash(0.34);
        this.tracer(from, to, 0.6);
        this.sound("mg", from.x, from.y, 0.6);
        break;
      case "flak": {
        flash(0.42);
        this.tracer(from, to, 0.7, () => {
          const p = { x: to.x + (Math.random() - 0.5) * 0.45, y: to.y + (Math.random() - 0.5) * 0.45, h: to.h + (Math.random() - 0.3) * 0.4 };
          this.flash(p, 0.55, 0xffb35a);
          this.emit({ ...this.smoke, size: [0.22, 0.28], life: [600, 1000] }, p, 1);
          this.emit(SPARKS, p, 3);
        });
        this.sound("flak", from.x, from.y, 0.7);
        break;
      }
      case "rockets":
        for (const side of [-1, 1]) {
          const nx = -(to.y - from.y);
          const ny = to.x - from.x;
          const len = Math.hypot(nx, ny) || 1;
          const o = { x: from.x + (nx / len) * 0.11 * side, y: from.y + (ny / len) * 0.11 * side, h: from.h };
          this.missile(o, to, 240 + side * 30, false, () => this.impact(to, 0.45, ev.air));
        }
        this.flash(from, 0.35, 0xffc070, 0.7);
        this.sound("rocket", from.x, from.y, 0.7);
        break;
      case "missile":
        this.missile(from, to, 420, true, () => this.impact(to, 0.5, ev.air));
        this.flash(from, 0.3, 0xffc070, 0.7);
        this.sound("missile", from.x, from.y, 0.7);
        break;
      case "laser":
        this.beam(from, to, LASER_TINT[faction], 5, 200);
        this.flash(from, 0.42, LASER_TINT[faction]);
        this.flash(to, 0.6, LASER_TINT[faction]);
        this.emit(SPARKS, to, 3);
        this.sound("laser", from.x, from.y, 0.7);
        break;
      case "shell":
        flash(0.85);
        this.emit({ ...GUNSMOKE, size: [0.22, 0.3] }, from, 3);
        this.sound("shell", from.x, from.y);
        break;
      case "bomb":
        this.sound("bomb", from.x, from.y, 0.6);
        break;
      case "rifle":
        flash(0.24);
        this.tracer(from, to, 0.45);
        this.sound("rifle", from.x, from.y, 0.55);
        break;
      case "snipe":
        this.rail(from, to);
        break;
    }
  }

  /**
   * A robot squad's volley: each standing robot fires from its own muzzle a
   * beat apart (it kicks as its shot leaves) — a crackle of rifle tracers,
   * a ripple of shoulder rockets with backblast, or one rail-rifle streak.
   */
  private volley(ev: ShotEvent, robots: number[], from: P3, to: P3): void {
    const id = ev.sourceId;
    const spread = ev.fx === "snipe" ? 0 : ev.fx === "rockets" ? 0.18 : 0.3;
    robots.forEach((i, k) => {
      const delay = ev.fx === "rockets" ? k * 120 + Math.random() * 40 : ev.fx === "rifle" ? k * 30 + Math.random() * 70 : 0;
      const go = () => {
        const m = this.squads?.fire(id, i) ?? (k === 0 ? from : null);
        if (!m) return;
        const t = { x: to.x + (Math.random() - 0.5) * spread, y: to.y + (Math.random() - 0.5) * spread, h: to.h + (Math.random() - 0.4) * spread * 0.5 };
        if (BELLE_EPOQUE) this.belleVolley(ev, k, m, t);
        else if (ev.fx === "rifle") {
          this.muzzle(m, 0.2, 0xffd27a);
          this.tracer(m, t, 0.42, k < 2 ? () => this.emit({ ...SPARKS, size: [0.12, 0.18] }, t, 2) : undefined);
          if (k === 0) this.sound("rifle", m.x, m.y, 0.55);
        } else if (ev.fx === "rockets") {
          // the launcher's backblast puffs out behind the robot
          const dx = t.x - m.x;
          const dy = t.y - m.y;
          const d = Math.hypot(dx, dy) || 1;
          this.emit({ ...GUNSMOKE, size: [0.12, 0.17] }, { x: m.x - (dx / d) * 0.24, y: m.y - (dy / d) * 0.24, h: m.h }, 2);
          this.flash(m, 0.3, 0xffc070, 0.75);
          this.missile(m, t, 280, false, () => this.impact(t, 0.42, ev.air));
          this.sound("rocket", m.x, m.y, 0.55);
        } else this.rail(m, t);
      };
      if (delay > 0) this.v.tweens.after(delay, go);
      else go();
    });
  }

  /** The Sniper's rail shot: one instant, white-hot streak, a glowing wake along it and a crack. */
  private rail(from: P3, to: P3): void {
    this.beam(from, to, 0xffc65a, 3.2, 300);
    this.muzzle(from, 0.36, 0xfff0c8);
    this.flash(to, 0.45, 0xffe2a0);
    this.emit(SPARKS, to, 5);
    const n = Math.max(2, Math.round(Math.hypot(to.x - from.x, to.y - from.y) * 1.6));
    for (let i = 1; i < n; i++) {
      const k = i / n;
      this.emit(RAIL_WAKE, { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, h: from.h + (to.h - from.h) * k }, 1);
    }
    this.sound("snipe", from.x, from.y, 0.8);
  }

  // ------------------------------------------------- Belle Époque shots ---

  /**
   * A weapon fired, Belle Époque style: black powder and brass. Guns bark a
   * bright flash and a big white-grey cloud that drifts off; shells streak
   * brass-orange; machine guns chatter in quick little flashes and spit
   * casings; flak bursts black in the sky; rockets are sputtering Congreves;
   * the lance and the Gargantua's eye throw crackling electric arcs.
   * (Every hit still lands when the original's does.)
   */
  private belleShot(ev: ShotEvent, from: P3, to: P3): void {
    switch (ev.fx) {
      case "cannon":
        this.muzzle(from, 0.55, 0xfff0c8);
        this.flash(from, 0.45, 0xffa040, 0.6);
        this.powder(from, to, 2, POWDER_MID);
        this.tracer(from, to, 1, () => this.impact(to, 0.35, ev.air));
        this.sound("cannon", from.x, from.y, 0.8);
        break;
      case "heavy-cannon":
        this.muzzle(from, 1.05, 0xfff0c8);
        this.flash(from, 0.9, 0xffa040, 0.7);
        this.powder(from, to, 4, POWDER_BIG);
        this.tracer(from, to, 1.8, () => this.impact(to, 0.7, ev.air));
        this.sound("heavy", from.x, from.y);
        break;
      case "mg":
        this.burst(from, to, 3, 0.3, 70);
        this.sound("mg", from.x, from.y, 0.6);
        break;
      case "flak": {
        // the Faucheux's Gatling: a quick ripple of rounds, and a black "Archie" burst up there
        this.burst(from, to, 2, 0.36, 60);
        this.tracer(from, to, 0.7, () => this.archie(to));
        this.sound("flak", from.x, from.y, 0.7);
        break;
      }
      case "rockets":
        for (const side of [-1, 1]) {
          const nx = -(to.y - from.y);
          const ny = to.x - from.x;
          const len = Math.hypot(nx, ny) || 1;
          const o = { x: from.x + (nx / len) * 0.11 * side, y: from.y + (ny / len) * 0.11 * side, h: from.h };
          this.missile(o, to, 240 + side * 30, false, () => this.rocketBurst(to, 0.45, ev.air));
        }
        this.flash(from, 0.35, 0xffc070, 0.7);
        this.emit(BE.POWDER_SMALL, from, 2);
        this.sound("rocket", from.x, from.y, 0.7);
        break;
      case "missile":
        if (this.sourceKind?.(ev.sourceId) === "raptor") {
          // the Blériot has no rockets: a burst from its machine gun
          this.burst(from, to, 3, 0.3, 60, () => this.impact(to, 0.3, ev.air));
          this.sound("mg", from.x, from.y, 0.7);
          break;
        }
        // a Batterie Ruggieri: a big Congreve, weaving up at its prey
        this.missile(from, to, 420, true, () => this.rocketBurst(to, 0.5, ev.air));
        this.flash(from, 0.4, 0xffc070, 0.8);
        this.emit(BE.POWDER, from, 2);
        this.sound("missile", from.x, from.y, 0.7);
        break;
      case "laser":
        this.zap(from, to);
        this.sound("laser", from.x, from.y, 0.7);
        break;
      case "shell":
        this.muzzle(from, 0.95, 0xfff0c8);
        this.flash(from, 0.8, 0xffa040, 0.7);
        this.powder(from, to, 5, POWDER_BIG);
        this.sound("shell", from.x, from.y);
        break;
      case "bomb":
        this.sound("bomb", from.x, from.y, 0.6);
        break;
      case "rifle":
        this.muzzle(from, 0.24, 0xfff0c8);
        this.emit(BE.POWDER_SMALL, from, 1);
        this.tracer(from, to, 0.45);
        this.sound("rifle", from.x, from.y, 0.55);
        break;
      case "snipe":
        this.crack(from, to);
        break;
    }
  }

  /** One robot of a squad fires, Belle Époque style (see volley()). */
  private belleVolley(ev: ShotEvent, k: number, m: P3, t: P3): void {
    if (ev.fx === "rifle") {
      this.muzzle(m, 0.2, 0xfff0c8);
      if (k < 3) this.emit(BE.POWDER_SMALL, m, 1);
      this.tracer(m, t, 0.42, k < 2 ? () => this.emit({ ...SPARKS, size: [0.12, 0.18] }, t, 2) : undefined);
      if (k === 0) this.sound("rifle", m.x, m.y, 0.55);
    } else if (ev.fx === "rockets") {
      // an artificier's rocket: a puff of powder at the trough, a Congreve away
      this.emit(BE.POWDER_SMALL, m, 2);
      this.flash(m, 0.3, 0xffc070, 0.75);
      this.missile(m, t, 280, false, () => this.rocketBurst(t, 0.42, ev.air));
      this.sound("rocket", m.x, m.y, 0.55);
    } else this.crack(m, t);
  }

  /**
   * Black-powder smoke out of a muzzle: `n` puffs blown out along the line of
   * fire, the first ones biggest, then left to drift downwind.
   */
  private powder(from: P3, to: P3, n: number, cfg: EmitCfg): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy) || 1;
    const pt = this.v.particles;
    for (let i = 0; i < n; i++) {
      const s = 0.04 + i * 0.1;
      pt.emit(cfg, from.x + (dx / d) * s, from.y + (dy / d) * s, from.h + 0.02, 1);
    }
  }

  /** A machine gun's chatter: `n` rounds `gap` ms apart, each a small flash, a puff, a casing and a brass streak. */
  private burst(from: P3, to: P3, n: number, scale: number, gap: number, onHit?: () => void): void {
    for (let i = 0; i < n; i++) {
      const go = () => {
        this.muzzle(from, scale * (0.8 + Math.random() * 0.4), 0xfff0c8);
        if (i === 0 || Math.random() < 0.5) this.emit(BE.POWDER_SMALL, from, 1);
        this.emit(BE.CASINGS, from, 1);
        const t = i === n - 1 ? to : { x: to.x + (Math.random() - 0.5) * 0.2, y: to.y + (Math.random() - 0.5) * 0.2, h: to.h + (Math.random() - 0.5) * 0.1 };
        this.tracer(from, t, scale * 1.6, i === n - 1 ? onHit : undefined);
      };
      if (i === 0) go();
      else this.v.tweens.after(i * gap, go);
    }
  }

  /** A flak shell bursting in the sky: a brief orange flash in a hanging cloud of black smoke. */
  private archie(to: P3): void {
    const p = { x: to.x + (Math.random() - 0.5) * 0.45, y: to.y + (Math.random() - 0.5) * 0.45, h: to.h + (Math.random() - 0.3) * 0.4 };
    this.flash(p, 0.5, 0xff9a40);
    this.emit(BE.ARCHIE, p, 2);
    this.emit(SPARKS, p, 2);
  }

  /** A powder rocket bursting: the blast and a few firework stars. */
  private rocketBurst(p: P3, size: number, air: boolean): void {
    this.impact(p, size, air);
    this.emit(BE.FIREWORK, p, 4);
  }

  /** A rifle shot (the chasseurs alpins): a crack, a small flash and puff, a faint brass streak. */
  private crack(from: P3, to: P3): void {
    this.muzzle(from, 0.3, 0xfff0c8);
    this.emit(BE.POWDER_SMALL, from, 2);
    this.tracer(from, to, 0.5, () => {
      this.flash(to, 0.35, 0xffe2a0);
      this.emit(SPARKS, to, 4);
    });
    this.sound("snipe", from.x, from.y, 0.8);
  }

  /**
   * An electric arc from `from` to `to` (the Hydroglisseur's lance, the
   * Gargantua's eye): two crackling bolts, a glow at both ends and a spray
   * of blue-white sparks where it strikes.
   */
  private zap(from: P3, to: P3): void {
    this.bolt(from, to, { life: 280, width: 0.12, minPx: 7, tint: BE.ARC_BLUE, jag: 0.1, reroll: 45, fork: 0.5 });
    this.bolt(from, to, { life: 200, width: 0.07, minPx: 4.5, tint: 0x9fb8ff, jag: 0.16, reroll: 35, fork: 0.25, alpha: 0.8 });
    this.flash(from, 0.45, 0xbfd4ff, 0.9);
    this.flash(to, 0.65, 0xbfd4ff, 0.9);
    // the arc lights the air along its path
    const pt = this.v.particles;
    tmpC.setHex(0x6f8fff);
    for (let i = 1; i <= 3; i++) {
      const k = i / 4;
      pt.spawn(
        { x: from.x + (to.x - from.x) * k, y: from.h + (to.h - from.h) * k, z: from.y + (to.y - from.y) * k, life: 220, tex: TEX.glow, size0: 0.7, size1: 0.8, alpha0: 0.45, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b },
        true
      );
    }
    this.v.tweens.after(110, () => this.flash(to, 0.5, 0xe0ecff, 0.8));
    this.emit(BE.ARC_SPARKS, to, 5);
  }

  /** A crackling electric bolt between two points (tiles + height). */
  bolt(from: P3, to: P3, o: BoltOpts): void {
    this.arcs?.bolt(from.x, from.h, from.y, to.x, to.h, to.y, o);
  }

  /** A Pasteur's repair: brass sparks flying over, a spray of them and a puff of steam where they land. */
  private belleHeal(from: P3, to: P3): void {
    const pt = this.v.particles;
    for (let i = 0; i < 5; i++) {
      const life = 300 + Math.random() * 120;
      const k = 1000 / life;
      tmpC.setHex(i % 2 ? 0xffd27a : 0xfff0c0);
      pt.spawn(
        {
          x: from.x, y: from.h, z: from.y, vx: (to.x - from.x) * k, vy: (to.h - from.h) * k, vz: (to.y - from.y) * k,
          life, tex: TEX.glint, size0: 0.2, size1: 0.12, alpha0: 1, alpha1: 0.6, spin: 4, r: tmpC.r, g: tmpC.g, b: tmpC.b
        },
        true
      );
    }
    this.emit(BE.REPAIR_STEAM, from, 1);
    this.v.tweens.after(320, () => {
      this.emit(BE.BRASS_SPARKS, to, 4);
      this.emit(BE.REPAIR_STEAM, to, 2);
      this.flash(to, 0.35, 0xffd27a, 0.6);
    });
    this.sound("heal", to.x, to.y, 0.35);
  }

  /** A robot goes down: a spray of sparks and a clank where it lands. */
  robotDown(p: P3): void {
    this.emit({ ...SPARKS, size: [0.13, 0.2], speed: [0.6, 2.2], up: [0.6, 1.8] }, p, 6);
    this.emit({ ...DEBRIS, size: [0.07, 0.11], speed: [0.4, 1.4], up: [1, 2] }, p, 2);
    this.flash(p, 0.32, 0xffd27a, 0.7);
    this.sound("clank", p.x, p.y, 0.5);
  }

  /** A Mastodon grinds through a squad: sparks and scrap kicked out from under its tracks. */
  crush(x: number, y: number): void {
    const p = { x, y, h: this.v.terrain.surfaceAt(x, y) + 0.08 };
    this.emit({ ...SPARKS, speed: [0.8, 2.6], up: [0.4, 1.6] }, p, 7);
    this.emit({ ...DEBRIS, size: [0.08, 0.13], speed: [0.8, 2], up: [1.2, 2.4] }, p, 3);
    this.kick(x, y, 1);
    this.sound("crush", x, y, 0.75);
  }

  /** A dropship's downwash where squads climb aboard or jump down: dust blown out along the ground. */
  wash(x: number, y: number, n = 3): void {
    for (let i = 0; i < n; i++) this.kick(x + (Math.random() - 0.5) * 0.5, y + (Math.random() - 0.5) * 0.5, 1);
    this.sound("thrust", x, y, 0.5);
  }

  /** A robot lands from a drop: a thruster blip and a puff of dust. */
  landing(p: P3): void {
    this.flash({ x: p.x, y: p.y, h: p.h + 0.04 }, 0.28, 0xffb347, 0.7);
    this.dust(p.x, p.y);
  }

  /** A quick additive bloom. */
  flash(p: P3, scale: number, tint: number, alpha = 1): void {
    tmpC.setHex(tint);
    this.v.particles.spawn(
      { x: p.x, y: p.h, z: p.y, life: 110, tex: TEX.glow, size0: scale * 1.1, size1: scale * 1.6, alpha0: alpha, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b },
      true
    );
  }

  /** A muzzle flash: a ragged burst over a small bloom, gone in a few frames. */
  private muzzle(p: P3, scale: number, tint: number): void {
    tmpC.setHex(tint);
    const pt = this.v.particles;
    pt.spawn(
      { x: p.x, y: p.h, z: p.y, life: 75, tex: TEX.flare, size0: scale * 1.05, size1: scale * 1.35, alpha0: 1, alpha1: 0.2, r: tmpC.r, g: tmpC.g, b: tmpC.b, rot: Math.random() * Math.PI * 2 },
      true
    );
    pt.spawn({ x: p.x, y: p.h, z: p.y, life: 110, tex: TEX.glow, size0: scale * 0.8, size1: scale * 1.2, alpha0: 0.7, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b }, true);
  }

  private tracer(from: P3, to: P3, scale: number, onHit?: () => void): void {
    const d = Math.hypot(to.x - from.x, to.y - from.y, to.h - from.h);
    const m = new THREE.Mesh(tracerGeo, tracerMat!);
    // zoomed out, a true-to-scale tracer is thinner than a pixel: keep it legible
    const wpp = this.v.rig.worldPerPx(from.x, from.y, from.h);
    const w = Math.max(0.035 * scale, TRACER_MIN_W * wpp) / 0.035;
    // (a Belle Époque shell streak is shorter: a glowing slug, not a laser-straight line)
    m.scale.set(w, w, Math.max((BELLE_EPOQUE ? 0.2 : 0.32) * scale, (BELLE_EPOQUE ? 0.75 : 1) * TRACER_MIN_L * wpp));
    m.renderOrder = 7;
    this.v.scene.add(m);
    this.fliers.push({ obj: m, a: from, b: to, c: null, t: 0, dur: Math.min(180, Math.max(50, d * 22)), trail: false, rocket: false, acc: 0, onHit });
    this.place(m, from, to);
  }

  private missile(from: P3, to: P3, dur: number, curve: boolean, onHit?: () => void): void {
    const m = new THREE.Mesh(BELLE_EPOQUE ? BE.congreveGeometry() : missile(), modelMat("normal"));
    m.userData.model = true;
    this.v.scene.add(m);
    let c: P3 | null = null;
    if (curve) {
      const k = (Math.random() - 0.5) * 0.6;
      c = {
        x: (from.x + to.x) / 2 - (to.y - from.y) * k,
        y: (from.y + to.y) / 2 + (to.x - from.x) * k,
        h: Math.max(from.h, to.h) + 0.6
      };
    } else c = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, h: Math.max(from.h, to.h) + 0.25 };
    if (BELLE_EPOQUE) {
      // a powder rocket never flies quite true
      const w = (Math.random() - 0.5) * 0.35;
      c.x -= (to.y - from.y) * w;
      c.y += (to.x - from.x) * w;
    }
    this.fliers.push({ obj: m, a: from, b: to, c, t: 0, dur, trail: true, rocket: BELLE_EPOQUE, acc: 0, onHit });
    this.place(m, from, to);
  }

  private place(o: THREE.Object3D, at: P3, toward: P3): void {
    o.position.set(at.x, at.h, at.y);
    o.lookAt(toward.x, toward.h, toward.y);
  }

  /**
   * A glowing beam between two points that fades over `dur` ms: a white-hot
   * core in a sheath of the beam's colour. The sheath is alpha-blended, not
   * additive, so a blue or red laser keeps its team colour over bright sand
   * and snow instead of washing out to white.
   */
  beam(from: P3, to: P3, tint: number, width: number, dur: number): void {
    const a = new THREE.Vector3(from.x, from.h, from.y);
    const b = new THREE.Vector3(to.x, to.h, to.y);
    const len = a.distanceTo(b);
    if (len < 0.01) return;
    const dir = b.clone().sub(a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const parts: { m: THREE.Mesh; mat: THREE.MeshBasicMaterial; o: number }[] = [];
    for (const [r, o, col] of [[width * 0.017, 0.62, tint], [width * 0.007, 1, 0xffffff]] as const) {
      const mat = glowMat(col, o);
      if (col !== 0xffffff) mat.blending = THREE.NormalBlending;
      const m = new THREE.Mesh(beamGeo, mat);
      m.position.copy(a).addScaledVector(dir, len / 2);
      m.quaternion.copy(q);
      m.scale.set(r, len, r);
      m.renderOrder = col === 0xffffff ? 7.1 : 7; // core over its sheath
      this.v.scene.add(m);
      parts.push({ m, mat, o });
    }
    this.v.tweens.add({
      dur,
      update: (k) => {
        for (const p of parts) {
          p.mat.opacity = p.o * (1 - k * k);
          p.m.scale.x = p.m.scale.z = p.m.scale.x * (1 - k * 0.02);
        }
      },
      done: () => {
        for (const p of parts) {
          this.v.scene.remove(p.m);
          p.mat.dispose();
        }
      }
    });
  }

  heal(from: P3, to: P3): void {
    if (BELLE_EPOQUE) {
      this.belleHeal(from, to);
      return;
    }
    this.beam(from, to, 0x7dff9a, 3.5, 420);
    this.emit(HEAL, to, 2);
    this.sound("heal", to.x, to.y, 0.35);
  }

  sparks(p: P3, n: number, tints?: number[]): void {
    this.emit(tints ? { ...SPARKS, tints, end: tints[0], gravity: -2 } : SPARKS, p, n);
  }

  // --------------------------------------------------------- explosions ---

  private impact(p: P3, size: number, air: boolean): void {
    if (BELLE_EPOQUE) {
      // a shell bursting: a puff of dirty powder smoke hangs where it struck
      this.v.particles.emit(BE.POWDER_SMALL, p.x, p.y, p.h + 0.05, size > 0.4 ? 2 : 1);
      if (!air && this.liquid(p.x, p.y)) this.splash(p.x, p.y, 2);
    }
    this.emit(SPARKS, p, Math.round(3 + size * 4));
    if (size > 0.4) this.boom(p, size * 0.6, air, false, 1, 0.7);
    else {
      this.flash(p, size * 1.2, 0xffc26a);
      this.muzzle(p, size * 1.3, 0xffe2b0);
    }
    if (!air && size > 0.3) this.dust(p.x, p.y);
  }

  /**
   * A layered blast: a brief white-hot flash, a fireball of ragged flame
   * that cools from yellow to red and burns out fast as it swells (so it
   * hands over to the smoke instead of lingering as a muddy ball), a hot
   * core glowing inside the smoke a moment longer, a column of sun-lit
   * smoke that outlives it all, and on the ground a shock ring, a skirt of
   * kicked-up dust and a scorch mark (spray and no scorch on water).
   * `flashK`/`flashA` size the bloom: small deaths keep it modest so the
   * fight underneath stays readable; building deaths keep the full flare.
   */
  private boom(p: P3, size: number, air: boolean, decal: boolean, flashK = 1.5, flashA = 1): void {
    const pt = this.v.particles;
    // big blasts overlap many additive puffs: dim each so the fireball stays orange, not white
    const k = size > 1 ? 1 / Math.sqrt(size) : 1;
    this.flash(p, size * flashK, 0xffc870, flashA * k);
    tmpC.setHex(0xfff2d0);
    pt.spawn({ x: p.x, y: p.h + 0.1, z: p.y, life: 130, tex: TEX.glow, size0: size * 0.75, size1: size * 1.2, alpha0: 0.9 * k * Math.min(1, flashA + 0.1), alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b }, true);
    const n = (a: number, b: number) => Math.round(a + size * b);
    // smoke first, so the fire draws over it
    pt.emit(
      { ...this.smoke, size: [0.32 * size + 0.18, 0.45 * size + 0.22], life: [1100 + size * 300, 1900 + size * 500], up: [0.4, 0.75 + size * 0.2], speed: [0.1, 0.25 + size * 0.2] },
      p.x, p.y, p.h + 0.15, n(1.5, 2.5)
    );
    // the fireball's body: opaque flame (reads on snow and sand alike), loosely clustered so it
    // billows rather than merging into one disc, that burns out fast into the smoke behind it
    pt.emit(
      {
        tex: TEX.fire, life: [280 + size * 40, 460 + size * 90], speed: [0.2 * size, 0.9 * size + 0.2], up: [0.3, 0.9], drag: 0.12,
        size: [0.3 * size + 0.1, 0.55 * size + 0.16], grow: [1.5, 2.3], easeOut: true, spin: 1.6, spread: 0.14 * size,
        alpha: [1, 0], fadeFast: true, tints: [0xffdc8a, 0xffc060, 0xffa848], end: 0xc4400e
      },
      p.x, p.y, p.h + 0.1, n(2, 3)
    );
    // its hot core, still glowing inside the smoke a moment after the flames are spent
    pt.emit(
      {
        tex: TEX.fire, additive: true, life: [300, 480 + size * 90], speed: [0.05 * size, 0.25 * size], up: [0.2, 0.5], drag: 0.2,
        size: [0.36 * size + 0.1, 0.5 * size + 0.12], grow: [1.2, 1.5], easeOut: true, spin: 1.6,
        alpha: [0.65 * k, 0], tints: [0xffa040, 0xffb347], end: 0xa82c08
      },
      p.x, p.y, p.h + 0.1, n(1, 2)
    );
    if (size >= 0.9) this.emit(EMBERS, p, n(-1, 3));
    // Belle Époque: thick coal smoke rolls up after the fire and hangs there
    if (BELLE_EPOQUE && size >= 0.8)
      pt.emit(
        { ...this.smoke, size: [0.36 * size + 0.2, 0.5 * size + 0.24], life: [2200 + size * 400, 3200 + size * 600], up: [0.3, 0.55 + size * 0.15], speed: [0.05, 0.2], fadeIn: 0.25 },
        p.x, p.y, p.h + 0.3, n(0.5, 1)
      );
    if (!air && size >= 0.5) {
      this.shock(p.x, p.y, size, 0xffd9a0, 0.32);
      if (size >= 0.6) this.kick(p.x, p.y, n(1, 3));
    }
    if (decal && !air) this.decal(p.x, p.y, size);
  }

  /** A blast front racing out along the ground. */
  shock(x: number, y: number, size: number, tint: number, alpha = 0.6, ms = 300): void {
    tmpC.setHex(tint);
    this.v.particles.spawn(
      {
        x, y: this.v.terrain.surfaceAt(x, y) + 0.06, z: y, life: ms, tex: TEX.shock, flat: true, easeOut: true,
        size0: 0.4 * size + 0.2, size1: 1.7 * size + 0.5, alpha0: alpha, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b
      },
      true
    );
  }

  /** A slow pillar of dark smoke over a big blast (buildings, orbital strikes). */
  plume(x: number, y: number, h: number, size: number, n: number): void {
    this.v.particles.emit(
      {
        ...SMOKE, life: [2400, 3600], up: [0.5, 1.0], speed: [0.05, 0.25], size: [0.5 * size, 0.7 * size], grow: [2.4, 3.2],
        alpha: [0.75, 0], tints: this.plumeTints, end: 0x8a857e, spread: 0.35 * size, fadeIn: 0.2
      },
      x, y, h, n
    );
  }

  explosion(ev: Extract<FxEvent, { type: "explosion" }>, at: P3): void {
    if (ev.kind === "building") {
      const size = ev.size;
      for (let i = 0; i < 3 + size * 2; i++) {
        const o = { x: at.x + (Math.random() - 0.5) * size * 0.8, y: at.y + (Math.random() - 0.5) * size * 0.8, h: at.h + Math.random() * 0.5 };
        this.v.tweens.after(i * 110, () => this.boom(o, 1.2 + Math.random() * 0.8, false, i === 0, 1.2, 0.75));
      }
      this.emit({ ...DEBRIS, speed: [1.2, 3.4], size: [0.14, 0.28] }, { ...at, h: at.h + 0.4 }, 16);
      this.shock(at.x, at.y, size * 0.9, 0xffe0b0, 0.6, 420);
      this.v.tweens.after(250, () => this.plume(at.x, at.y, at.h + 0.3, 0.8 + size * 0.25, 3 + Math.round(size * 2)));
      // camera shake is decided by render/juice-view.ts (on-screen deaths only)
      this.sound("bigExplosion", at.x, at.y);
    } else if (ev.kind === "unit" && !ev.air && this.squads?.diedAt(ev.x, ev.y)) {
      // a robot squad wiped out: its last robots topple in sparks (render/entities.ts), no fireball
      this.emit({ ...SPARKS, speed: [0.8, 2.6] }, { ...at, h: at.h + 0.1 }, 6);
      this.flash(at, 0.5, 0xffd27a, 0.6);
    } else if (ev.kind === "unit") {
      // small hulls pop smaller; Mastodons and Hornets keep their big fireball. A ground
      // unit's wreck appears where it died: the blast erupts out of it, not hidden inside it
      const c = ev.air ? at : { x: at.x, y: at.y, h: at.h + 0.22 };
      this.boom(c, ev.size >= 1 ? 0.8 + ev.size : 0.5 + ev.size * 0.85, ev.air, true, 0.9, 0.85);
      this.emit(DEBRIS, c, 7);
      this.emit(SPARKS, c, 5);
      this.sound("explosion", at.x, at.y, 0.9);
      // the wreck falls to the ground and burns out there (over water or lava it sinks: render/wrecks.ts splashes it)
      if (ev.air && !this.liquid(at.x, at.y))
        this.v.tweens.after(300, () => this.boom({ x: at.x, y: at.y, h: this.v.terrain.surfaceAt(at.x, at.y) + 0.3 }, 0.6, false, true));
    } else {
      this.boom(at, 0.5 + ev.size * 0.7, false, true, 1.1, 0.8);
      this.emit(DEBRIS, at, 3);
      this.sound("explosion", at.x, at.y, 0.7);
    }
  }

  private decal(x: number, y: number, size: number): void {
    if (this.liquid(x, y)) return; // (nothing scorches water or lava)
    const h = this.v.terrain.surfaceAt(x, y) + 0.03;
    tmpC.setHex(0x14100c);
    const s = 0.6 + size * 0.6;
    this.v.particles.spawn({ x, y: h, z: y, life: 38000, tex: TEX.scorch, size0: s, size1: s * 1.05, alpha0: 0.6, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b, flat: true, rot: Math.random() * 6.28 });
  }

  /** Rubble left where a building stood (+ scorch). */
  rubble(x: number, y: number, size: number): THREE.Object3D {
    const m = modelMesh(rubbleGeometry(size, Math.floor(Math.random() * 4)));
    m.position.set(x, this.v.terrain.heightAt(x, y), y);
    m.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);
    this.v.scene.add(m);
    this.rubbles.push(m);
    if (this.rubbles.length > 40) {
      const old = this.rubbles.shift();
      if (old) this.v.scene.remove(old);
    }
    this.decal(x, y, size * 1.4);
    return m;
  }

  // ------------------------------------------------------ ambient bits ---

  /**
   * Is tile point (x, y) open water or lava? (Not a bridge deck, which sits
   * above the waterline, nor the very edge of a ford.)
   */
  liquid(x: number, y: number): boolean {
    const t = this.v.terrain;
    return t.heightAt(x, y) < WATER_LEVEL - 0.03 && t.surfaceAt(x, y) <= WATER_LEVEL;
  }

  /** A puff of dust off the ground (mist off water). */
  dust(x: number, y: number, n = 1): void {
    const wet = !this.lava && this.liquid(x, y);
    this.v.particles.emit(wet ? SPRAY : this.dustCfg, x, y, this.v.terrain.surfaceAt(x, y) + 0.05, n);
  }

  /** Dirt thrown outward along the ground (a landing, a blast); spray or fire off water or lava. */
  kick(x: number, y: number, n: number): void {
    if (this.liquid(x, y)) this.splash(x, y, n);
    else this.v.particles.emit(this.kickCfg, x, y, this.v.terrain.surfaceAt(x, y) + 0.08, n);
  }

  /** Something hits the water (spray) or plunges into the lava (a gout of fire and sparks). */
  splash(x: number, y: number, n: number): void {
    const h = this.v.terrain.surfaceAt(x, y);
    if (this.lava) {
      this.v.particles.emit(LAVA_GOUT, x, y, h + 0.1, n);
      this.sparks({ x, y, h: h + 0.15 }, n, [0xffc257, 0xff7a1e]);
    } else this.v.particles.emit(SPLASH, x, y, h + 0.05, n);
  }

  /** Shards of metal or rock tossed up. */
  debris(p: P3, n: number): void {
    this.emit(DEBRIS, p, n);
  }

  /**
   * Damage smoke off `p`, a point on a building's roof; `burning` (badly
   * hurt) adds flames, licking up from the roof itself, and blacker smoke.
   * The smoke is born half a puff above the roof, so the roof doesn't clip
   * it as it fades in. Not under the fog: a remembered enemy building is
   * drawn from memory, and a plume would give away how hurt it is now.
   */
  buildingSmoke(p: P3, burning: boolean, always = false): void {
    // (`always`: smoke off something the enemy always sees, a Goliath's or a Gantry's)
    if (!always && fogged(p.x, p.y)) return;
    const pt = this.v.particles;
    const cfg = burning ? BURN_SMOKE : DAMAGE_SMOKE;
    pt.emit(cfg, p.x, p.y, p.h + cfg.size[1] / 2, 1);
    if (burning) {
      pt.emit(FIRE, p.x, p.y, p.h + 0.05, 2);
      // the fire lights the smoke around it
      tmpC.setHex(0xff7a1e);
      pt.spawn({ x: p.x, y: p.h + 0.3, z: p.y, life: 280, tex: TEX.glow, size0: 1.2, size1: 1.4, alpha0: 0.45, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b }, true);
      if (Math.random() < 0.35) this.emit(EMBERS, p, 1);
    }
  }

  /** An expanding ring on the ground. */
  pulse(x: number, y: number, tint: number, scale = 1.2, h?: number): void {
    tmpC.setHex(tint);
    this.v.particles.spawn(
      {
        x, y: (h ?? this.v.terrain.surfaceAt(x, y)) + 0.06, z: y, life: 500, tex: TEX.ring, flat: h === undefined,
        size0: 0.35 * scale, size1: 1.55 * scale, alpha0: 1, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b
      },
      true
    );
  }

  /**
   * A ring of light racing out along the ground from radius `r0` to `r1`
   * tiles over `ms` (a Goliath's build ring pulsing out as it anchors).
   */
  ring(x: number, y: number, tint: number, r0: number, r1: number, ms: number, alpha = 1): void {
    tmpC.setHex(tint);
    this.v.particles.spawn(
      {
        x, y: this.v.terrain.surfaceAt(x, y) + 0.08, z: y, life: ms, tex: TEX.ring, flat: true, easeOut: true,
        size0: r0 * 2.3, size1: r1 * 2.3, alpha0: alpha, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b
      },
      true
    );
  }

  /** A puff from a Belle Époque machine's smokestack: coal smoke, or steam off a flying machine. */
  stackPuff(p: P3, steam: boolean): void {
    this.v.particles.emit(steam ? BE.STACK_STEAM : BE.STACK_SMOKE, p.x, p.y, p.h, 1);
  }

  /** Steam venting at `p` (a Goliath's hydraulics). */
  steam(p: P3, n = 1): void {
    this.emit(STEAM, p, n);
  }

  /** Hearts bubbling up from `p` (Robot Love). */
  hearts(p: P3, n = 1): void {
    this.emit(HEARTS, p, n);
  }

  /**
   * The big moment of Robot Love at (x, y, h): one huge heart swelling up,
   * a ring of hearts flung out all round, a soft pink bloom and a ring of
   * light across the ground.
   */
  heartBurst(x: number, y: number, h: number): void {
    const pt = this.v.particles;
    tmpC.setHex(0xff4f8f);
    pt.spawn({ x, y: h, z: y, vy: 0.35, life: 2600, tex: TEX.heart, size0: 0.6, size1: 2.6, alpha0: 1, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b, easeOut: true }, false);
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const sp = 1.2 + Math.random() * 1.4;
      tmpC.setHex(HEARTS.tints[i % HEARTS.tints.length]!);
      pt.spawn(
        {
          x, y: h, z: y, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 0.6 + Math.random() * 1.2, drag: 0.6, life: 1600 + Math.random() * 900,
          tex: TEX.heart, size0: 0.26, size1: 0.42, alpha0: 1, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b, rot: (Math.random() - 0.5) * 0.8, spin: (Math.random() - 0.5) * 2
        },
        false
      );
    }
    this.flash({ x, y, h }, 2.2, 0xff8cc6, 0.7);
    this.pulse(x, y, 0xff5fa2, 2.6);
  }

  /** A welding arc at `p`: a white flicker and a spatter of sparks. */
  weld(p: P3, n = 4): void {
    this.flash(p, 0.32, 0xfff4e0, 0.9);
    this.emit(WELD, p, n);
  }

  /**
   * Something huge hits the ground at (x, y) — a toppled Goliath, one dropped
   * off its lift: a blast front, dirt thrown out all round, shards, a dust
   * cloud rolling out (spray on water), `size` tiles across.
   */
  slam(x: number, y: number, size: number): void {
    const h = this.v.terrain.surfaceAt(x, y);
    this.shock(x, y, size, 0xffe6c0, 0.55, 520);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + Math.random() * 0.4;
      const r = size * (0.25 + Math.random() * 0.25);
      this.kick(x + Math.cos(a) * r, y + Math.sin(a) * r, 1);
    }
    this.emit({ ...DEBRIS, speed: [1, 3], size: [0.12, 0.24] }, { x, y, h: h + 0.2 }, 12);
    for (let i = 0; i < 6; i++) this.dust(x + (Math.random() - 0.5) * size, y + (Math.random() - 0.5) * size, 2);
  }

  /**
   * A Goliath's death blast: its reactor going (a fireball no bigger than a
   * Mastodon's, sparks and shards out of its chest at `at`) — the fall is
   * the show, not the blast (render/goliath.ts topples it).
   */
  goliathBlast(at: P3): void {
    this.boom(at, 1.2, false, false, 1, 0.85);
    this.emit({ ...SPARKS, speed: [1, 3.4] }, at, 10);
    this.emit(DEBRIS, at, 8);
    this.sound("explosion", at.x, at.y, 0.9);
  }

  /** A command marker where the player tapped (move / attack). */
  marker(x: number, y: number, tint: number): void {
    tmpC.setHex(tint);
    this.v.particles.spawn({
      x, y: this.v.terrain.surfaceAt(x, y) + 0.06, z: y, life: 450, tex: TEX.select, flat: true,
      size0: 1.0, size1: 0.25, alpha0: 0.95, alpha1: 0.1, r: tmpC.r, g: tmpC.g, b: tmpC.b
    });
  }

  // ------------------------------------------------------------ per frame ---

  /**
   * Distance between trail puffs: TRAIL_STEP while the smoke pool has room,
   * up to four times that as it fills, so in a big air fight the contrails
   * thin out instead of evicting the battle and building smoke.
   */
  private trailStep(): number {
    return TRAIL_STEP * (1 + Math.max(0, this.v.particles.load - 0.5) * 6);
  }

  update(dtMs: number): void {
    this.arcs?.update(dtMs);
    let n = 0;
    const pos = tmpV;
    const pt = this.v.particles;
    const step = this.trailStep();
    for (const f of this.fliers) {
      f.t += dtMs;
      const k = Math.min(1, f.t / f.dur);
      let x: number;
      let y: number;
      let h: number;
      if (f.c) {
        const a = (1 - k) * (1 - k);
        const b = 2 * (1 - k) * k;
        const c = k * k;
        x = a * f.a.x + b * f.c.x + c * f.b.x;
        y = a * f.a.y + b * f.c.y + c * f.b.y;
        h = a * f.a.h + b * f.c.h + c * f.b.h;
      } else {
        x = f.a.x + (f.b.x - f.a.x) * k;
        y = f.a.y + (f.b.y - f.a.y) * k;
        h = f.a.h + (f.b.h - f.a.h) * k;
      }
      pos.set(x, h, y);
      const moved = pos.distanceTo(f.obj.position);
      if (moved > 1e-4) f.obj.lookAt(pos.x + (pos.x - f.obj.position.x), pos.y + (pos.y - f.obj.position.y), pos.z + (pos.z - f.obj.position.z));
      if (f.rocket && dtMs > 0) {
        // a Congreve rocket: powder smoke laid along its path, its tail sputtering sparks
        const ox = f.obj.position.x;
        const oy = f.obj.position.y;
        const oz = f.obj.position.z;
        f.acc += moved;
        while (f.acc >= step) {
          f.acc -= step;
          const s = moved > 0 ? 1 - f.acc / moved : 1;
          pt.emit(BE.ROCKET_SMOKE, ox + (pos.x - ox) * s, oz + (pos.z - oz) * s, oy + (pos.y - oy) * s, 1);
        }
        pt.emit(BE.ROCKET_FLAME, x, y, h, 1);
        if (Math.random() < Math.min(1, dtMs / 22)) pt.emit(BE.ROCKET_SPARKS, x, y, h, 1 + (Math.random() < 0.4 ? 1 : 0));
      } else if (f.trail && dtMs > 0) {
        // a puff per stretch flown, laid back along the path, so the trail is as dense at 30 fps as at 60
        const ox = f.obj.position.x;
        const oy = f.obj.position.y;
        const oz = f.obj.position.z;
        f.acc += moved;
        while (f.acc >= step) {
          f.acc -= step;
          const s = moved > 0 ? 1 - f.acc / moved : 1;
          pt.emit(TRAIL, ox + (pos.x - ox) * s, oz + (pos.z - oz) * s, oy + (pos.y - oy) * s, 1);
        }
        pt.emit(EXHAUST, x, y, h, 1);
      }
      f.obj.position.copy(pos);
      if (k >= 1) {
        this.v.scene.remove(f.obj);
        f.onHit?.();
      } else this.fliers[n++] = f;
    }
    this.fliers.length = n;
  }

  /** Draw the sim's slow projectiles (shells arc, bombs fall). */
  projectiles(list: Projectile[], alpha: number, prev: Map<number, { x: number; y: number }>): void {
    const t = this.v.terrain;
    const step = this.trailStep() * 1.4;
    for (const m of this.shells.values()) m.userData.seen = false;
    for (const p of list) {
      let m = this.shells.get(p.id);
      if (!m) {
        m = modelMesh(BELLE_EPOQUE ? BE.shellGeometry() : shell());
        m.userData.acc = 0;
        m.userData.fresh = true;
        // (a Goliath's mortar shell leaves its shoulder pod: high up and off to one side)
        const from = !p.fromAir ? this.shellFrom?.(p.sourceId) ?? null : null;
        m.userData.dx = from ? from.x - p.sx : 0;
        m.userData.dy = from ? from.y - p.sy : 0;
        m.userData.lift = from ? Math.max(0.55, from.h - t.surfaceAt(p.sx, p.sy)) : 0.55;
        this.v.scene.add(m);
        this.shells.set(p.id, m);
      }
      m.userData.seen = true;
      const pp = prev.get(p.id) ?? p;
      let x = pp.x + (p.x - pp.x) * alpha;
      let y = pp.y + (p.y - pp.y) * alpha;
      const total = Math.hypot(p.tx - p.sx, p.ty - p.sy) || 1;
      const k = Math.min(1, Math.hypot(x - p.sx, y - p.sy) / total);
      const g0 = t.surfaceAt(p.sx, p.sy);
      const g1 = t.surfaceAt(p.tx, p.ty);
      let h: number;
      if (p.fromAir) h = g0 + AIR_H * (1 - k) * (1 - k * 0.2) + (g1 - g0) * k;
      else h = g0 + (m.userData.lift as number) * (1 - k) + (g1 - g0) * k + 4 * k * (1 - k) * Math.min(2.2, total * 0.32);
      x += (m.userData.dx as number) * (1 - k);
      y += (m.userData.dy as number) * (1 - k);
      tmpV.copy(m.position);
      m.position.set(x, h, y);
      const fresh = m.userData.fresh as boolean;
      m.userData.fresh = false;
      const moved = fresh ? 0 : tmpV.distanceTo(m.position);
      if (moved > 1e-4) m.lookAt(2 * m.position.x - tmpV.x, 2 * m.position.y - tmpV.y, 2 * m.position.z - tmpV.z);
      if (!p.fromAir && moved > 0) {
        let acc = (m.userData.acc as number) + moved;
        while (acc >= step) {
          acc -= step;
          const s = 1 - acc / moved;
          this.v.particles.emit(BELLE_EPOQUE ? BE.SHELL_TRAIL : TRAIL, tmpV.x + (x - tmpV.x) * s, tmpV.z + (y - tmpV.z) * s, tmpV.y + (h - tmpV.y) * s, 1);
        }
        m.userData.acc = acc;
      }
    }
    for (const [id, m] of this.shells)
      if (!m.userData.seen) {
        this.v.scene.remove(m);
        this.shells.delete(id);
      }
  }

  destroy(): void {
    if (this.arcs) {
      this.v.scene.remove(this.arcs.mesh);
      this.arcs.dispose();
    }
    for (const f of this.fliers) this.v.scene.remove(f.obj);
    for (const m of this.shells.values()) this.v.scene.remove(m);
    for (const r of this.rubbles) this.v.scene.remove(r);
    this.fliers = [];
    this.shells.clear();
  }
}
