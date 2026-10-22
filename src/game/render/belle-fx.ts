import type * as THREE from "three";
import { ModelBuilder } from "../three/builder";
import { TEX, type EmitCfg } from "../three/particles";

/**
 * The Belle Époque look of the weapon and power effects (fx.ts, powers.ts,
 * wrecks.ts and entities.ts pick these when BELLE_EPOQUE is on): black
 * powder instead of clean propellant, brass shell streaks for tracers,
 * Congreve rockets sputtering sparks, crackling electric arcs for lasers,
 * black "Archie" flak bursts, coal smoke over every blast and wreck, and
 * steam off the boilers.
 */

/** Smoke leans gently downwind (as fx.ts's WIND), a little more for the light powder smoke. */
const WIND: [number, number] = [0.22, 0.1];

/** Black-powder gun smoke: a big white-grey cloud that lingers and drifts downwind. */
export const POWDER: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [1700, 2800], speed: [0.04, 0.2], up: [0.1, 0.26], size: [0.18, 0.25], grow: [2.6, 3.5],
  alpha: [0.78, 0], tints: [0xf4f0e8, 0xe6e1d8, 0xd9d3c9], end: 0xcfcac1, drag: 0.45, spin: 0.3, rot: 0.4, wind: WIND, fadeIn: 0.05, easeOut: true
};
/** A machine gun's or a rifle's small puff. */
export const POWDER_SMALL: EmitCfg = { ...POWDER, life: [800, 1300], size: [0.09, 0.13], grow: [2.2, 3], alpha: [0.6, 0] };
/** Brass casings flicked out of a machine gun's breech. */
export const CASINGS: EmitCfg = {
  tex: TEX.spark, additive: true, life: [260, 460], speed: [0.5, 1.1], up: [0.8, 1.5], size: [0.06, 0.09], grow: [0.7, 0.9],
  alpha: [1, 0.2], tints: [0xffd98a, 0xf0b850], end: 0xb07a2a, gravity: -9
};
/** "Archie": a black flak burst hanging in the sky. */
export const ARCHIE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [1700, 2600], speed: [0.04, 0.16], up: [0.0, 0.08], size: [0.22, 0.3], grow: [1.9, 2.5],
  alpha: [0.92, 0], tints: [0x1a1817, 0x221f1d, 0x2a2725], end: 0x55504b, drag: 0.4, rot: 0.6, wind: [0.12, 0.06], fadeIn: 0.03, easeOut: true
};
/** Grey-brown smoke streaming off a Congreve rocket. */
export const ROCKET_SMOKE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [650, 1150], speed: [0.02, 0.1], up: [0.04, 0.16], size: [0.1, 0.14], grow: [2.4, 3.3],
  alpha: [0.62, 0], tints: [0xcfc7ba, 0xbcb3a5], end: 0xa39b8f, drag: 0.6, rot: 0.4, wind: WIND, fadeIn: 0.08, easeOut: true
};
/** The sputtering spark trail of a powder rocket: gold and red, falling. */
export const ROCKET_SPARKS: EmitCfg = {
  tex: TEX.spark, additive: true, life: [160, 380], speed: [0.3, 1.2], up: [-0.4, 0.5], size: [0.07, 0.12], grow: [0.4, 0.7],
  alpha: [1, 0], tints: [0xfff0b0, 0xffc040, 0xff6a2a], end: 0xff3010, gravity: -5, drag: 0.6
};
/** The rocket's burning tail (a fresh, randomly sized one every frame: it sputters). */
export const ROCKET_FLAME: EmitCfg = {
  tex: TEX.fire, additive: true, life: [40, 90], size: [0.09, 0.17], grow: [0.5, 0.8], alpha: [0.95, 0], tints: [0xfff0b0, 0xffb347], end: 0xff4a1e
};
/** A few firework stars where a rocket bursts. */
export const FIREWORK: EmitCfg = {
  tex: TEX.glint, additive: true, life: [380, 720], speed: [1.1, 2.4], up: [0.5, 1.8], size: [0.13, 0.2], grow: [0.25, 0.45],
  alpha: [1, 0], tints: [0xffd54a, 0xff5040, 0xfff2c0, 0xffa030], end: 0xff7a2a, gravity: -3, drag: 0.4, spin: 4
};
/** Blue-white sparks spat where an electric arc strikes. */
export const ARC_SPARKS: EmitCfg = {
  tex: TEX.spark, additive: true, life: [140, 360], speed: [0.8, 3], up: [0.3, 1.8], size: [0.12, 0.18], grow: [0.2, 0.3],
  alpha: [1, 0], tints: [0xeef6ff, 0xc4dcff, 0xffffff], end: 0x6a7cff, gravity: -6
};
/** The Fée Électricité's violet sparkles. */
export const FEE_SPARKS: EmitCfg = {
  tex: TEX.glint, additive: true, life: [300, 700], speed: [0.4, 2], up: [0.3, 1.6], size: [0.14, 0.24], grow: [0.2, 0.4],
  alpha: [1, 0], tints: [0xd9c4ff, 0xb08cff, 0xffffff, 0x9fc8ff], end: 0x6a4aff, gravity: -1.2, drag: 0.5, spin: 3
};
/** The Réseau TSF (Unit.tsf): now and then a faint blue glint drifts up off a unit in range of a Tour TSF or a Zénith. */
export const TSF_GLINT: EmitCfg = {
  tex: TEX.glint, additive: true, life: [600, 1000], speed: [0.05, 0.25], up: [0.25, 0.5], size: [0.1, 0.16], grow: [0.4, 0.6],
  alpha: [0.75, 0], tints: [0x9fd8ff, 0xc4e6ff, 0x7fb8ff], end: 0x4a6aff, gravity: -0.3, drag: 0.6, spin: 2
};
/** Thick black coal smoke over a blast. */
export const COAL_SMOKE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [1500, 2500], speed: [0.06, 0.3], up: [0.35, 0.7], size: [0.42, 0.56], grow: [2.4, 3.2],
  alpha: [0.85, 0], tints: [0x24211f, 0x2c2826, 0x34302c], end: 0x75706a, drag: 0.6, spin: 0.5, rot: 0.4, wind: [0.16, 0.08], fadeIn: 0.08, easeOut: true
};
/** Black smoke off a burning building. */
export const COAL_BURN: EmitCfg = {
  ...COAL_SMOKE, life: [1900, 3000], up: [0.6, 1.0], size: [0.5, 0.65], grow: [2.8, 3.6], alpha: [0.88, 0],
  tints: [0x1f1c1a, 0x272422, 0x2f2b28], end: 0x6e6964, wind: [0.4, 0.2]
};
/** Oily black smoke smouldering off a wreck. */
export const WRECK_SMOKE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [1700, 2700], speed: [0.04, 0.14], up: [0.32, 0.6], size: [0.22, 0.29], grow: [3, 4.2],
  alpha: [0.72, 0], tints: [0x1d1b19, 0x262321, 0x2e2a27], end: 0x76716b, spin: 0.4, rot: 0.4, wind: [0.16, 0.08], fadeIn: 0.1, easeOut: true
};
/** Splinters and plates of a Belle Époque machine: soot-black iron, oak, brass. */
export const DEBRIS_TINTS = [0x3b342d, 0x5a4632, 0x7a5a3a, 0x8a6a3c, 0x2f2c29];
/** Coal smoke puffing out of a moving machine's smokestack. */
export const STACK_SMOKE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [900, 1500], speed: [0.02, 0.08], up: [0.35, 0.6], size: [0.07, 0.1], grow: [2.6, 3.4],
  alpha: [0.6, 0], tints: [0x3a3633, 0x45403b, 0x4f4a45], end: 0xa09b94, drag: 0.6, rot: 0.4, wind: [0.2, 0.1], fadeIn: 0.15, easeOut: true
};
/** White steam off a flying machine's little boiler. */
export const STACK_STEAM: EmitCfg = {
  ...STACK_SMOKE, life: [600, 1000], up: [0.1, 0.25], tints: [0xf2f2ee, 0xe4e6e6], end: 0xffffff, alpha: [0.55, 0]
};
/** Brass sparks of a Pasteur repair. */
export const BRASS_SPARKS: EmitCfg = {
  tex: TEX.spark, additive: true, life: [280, 560], speed: [0.4, 1.3], up: [0.4, 1.3], size: [0.1, 0.15], grow: [0.2, 0.35],
  alpha: [1, 0], tints: [0xffe8a8, 0xffc860, 0xffffff], end: 0xc88a2a, gravity: -5
};
/** Little steam puffs of a repair. */
export const REPAIR_STEAM: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [500, 850], speed: [0.1, 0.35], up: [0.3, 0.6], size: [0.09, 0.13], grow: [2.2, 3],
  alpha: [0.6, 0], tints: [0xf4f6f6, 0xe6eaea], end: 0xffffff, drag: 0.55, rot: 0.4, wind: [0.2, 0.1], fadeIn: 0.1, easeOut: true
};
/** Thin grey smoke behind a shell in flight. */
export const SHELL_TRAIL: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [550, 950], speed: [0, 0.05], up: [0.03, 0.1], size: [0.07, 0.1], grow: [2.4, 3.2],
  alpha: [0.5, 0], tints: [0xd8d3ca, 0xc8c2b8], end: 0xb0aaa0, wind: WIND, rot: 0.4, fadeIn: 0.08, easeOut: true
};
/** The thick smoke trail of a big shell falling from the sky (Feu roulant, Obus-capsule, Obus Méliès). */
export const SKY_TRAIL: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [900, 1500], speed: [0, 0.1], up: [0.02, 0.12], size: [0.24, 0.32], grow: [2.2, 3],
  alpha: [0.7, 0], tints: [0xd6d0c6, 0xc2bbb0, 0xb0a99e], end: 0x9a948a, drag: 0.6, rot: 0.4, wind: WIND, fadeIn: 0.06, easeOut: true
};

/** Arc colours: the Hydroglisseur's lance and the Gargantua's eye, and the Fée Électricité. */
export const ARC_BLUE = 0x5f8dff;
export const ARC_VIOLET = 0x9a62ff;

let rocketGeo: THREE.BufferGeometry | null = null;
let shellGeo: THREE.BufferGeometry | null = null;

/** A Congreve rocket (built pointing +Z): a red paper case, a brass cap and its long guide stick behind. */
export function congreveGeometry(): THREE.BufferGeometry {
  if (rocketGeo) return rocketGeo;
  const b = new ModelBuilder();
  b.tube(0.024, 0.14, 6, [0, 0, 0.02], 0xb4352a);
  b.cone(0.024, 0.06, 6, [0, 0, 0.12], 0xd8ae58, { rot: [Math.PI / 2, 0, 0] });
  b.box(0.008, 0.008, 0.26, [0.02, 0, -0.17], 0x8a6a42);
  b.sphere(0.022, [0, 0, -0.055], 0xffd27a, { glow: 1, w: 5, h: 3 });
  return (rocketGeo = b.build());
}

/** An artillery shell (built pointing +Z): a brass case and a steel ogive nose. */
export function shellGeometry(): THREE.BufferGeometry {
  if (shellGeo) return shellGeo;
  const b = new ModelBuilder();
  b.tube(0.04, 0.1, 8, [0, 0, -0.02], 0xd8ae58);
  b.cyl(0.043, 0.043, 0.012, 8, [0, 0, 0.025], 0xb0752e, { rot: [Math.PI / 2, 0, 0] });
  b.sphere(0.04, [0, 0, 0.03], 0x8c8780, { w: 8, h: 5, scale: [1, 1.9, 1], phi: Math.PI / 2, rot: [Math.PI / 2, 0, 0] });
  return (shellGeo = b.build());
}

/** A barrage shell's smoke trail, thicker than a mortar shell's. */
export const SHELL_TRAIL_THICK: EmitCfg = { ...SHELL_TRAIL, size: [0.13, 0.18], life: [700, 1100], alpha: [0.6, 0] };
/** The Obus Méliès' great smoke trail. */
export const MELIES_TRAIL: EmitCfg = { ...SKY_TRAIL, size: [0.5, 0.7], life: [1300, 2100], alpha: [0.8, 0] };
/** Flame licking off a big shell's base as it falls. */
export const SKY_FLAME: EmitCfg = {
  tex: TEX.fire, additive: true, life: [120, 260], speed: [0, 0.2], up: [0, 0.15], size: [0.25, 0.4], grow: [0.5, 0.8],
  alpha: [0.85, 0], tints: [0xffd27a, 0xffa040], end: 0xc2380e, spin: 3
};
