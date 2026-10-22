import type { ModelBuilder, Vec3 } from "../builder";
import { AMBER, BRASS, light, siteB, type ModelDef, type Team } from "../models";
import { STONE, STONE_D, rib, rod } from "./buildings";

/**
 * Campaign landmarks (PANACHE-CONCEPTION.md §1.11, §3.1): scenery and
 * objectives for the operations. The Eiffel Tower stands over the Paris finale:
 * a 3×3 footprint, about 6 tiles tall, four curving lattice legs joined by the
 * great arches under the first platform, a lattice shaft to the campanile, the
 * flag on top the only colour (`t`, the side holding it; neutral ivory when
 * nobody does). Centred on its footprint like a building.
 *
 * (models.ts imports this module through belle/index.ts: nothing is built at load.)
 */

/** Eiffel's own bronze-brown paint, and a lighter shade for the platforms. */
const EIFFEL = 0x6e4b33;
const EIFFEL_L = 0x93684a;
const NEUTRAL_FLAG = 0xeee5cf;

/** Half-spread of the legs' centres along each diagonal axis at height y (an exponential profile). */
const spread = (y: number) => 1.12 * Math.exp(-y / 1.75);
/** Half-width of a leg (or of the shaft above the second platform) at height y. */
const legW = (y: number) => 0.2 * Math.exp(-y / 2.2);

/** One leg from the ground to `y1`: four chords, braced on its two outer faces, `n` panels. */
function leg(b: ModelBuilder, sx: number, sz: number, y1: number, n: number): void {
  const at = (y: number, cx: number, cz: number): Vec3 => {
    const c = spread(y);
    const w = legW(y);
    return [sx * c + cx * w, y, sz * c + cz * w];
  };
  const corners: [number, number][] = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  for (let k = 0; k < n; k++) {
    const ya = (y1 * k) / n;
    const yb = (y1 * (k + 1)) / n;
    for (const [cx, cz] of corners) rod(b, at(ya, cx, cz), at(yb, cx, cz), 0.022, EIFFEL);
    // the outer faces (toward ±x and ±z of the leg's own corner)
    rod(b, at(ya, sx, -sz), at(yb, sx, sz), 0.01, EIFFEL);
    rod(b, at(ya, -sx, sz), at(yb, sx, sz), 0.01, EIFFEL);
  }
}

/** A square platform of half-side `h` at `y`: a deck, a lit gallery round it. */
function platform(b: ModelBuilder, h: number, y: number, d: number, lamps: boolean): void {
  b.block(h * 2 + 0.08, d, h * 2 + 0.08, [0, y, 0], EIFFEL_L, { bevel: 0.01 });
  b.block(h * 2 - 0.1, d * 0.8, h * 2 - 0.1, [0, y + d * 0.7, 0], EIFFEL, { bevel: 0.008 });
  if (lamps) for (const sx of [-1, 1]) for (const sz of [-1, 1]) light(b, [sx * h, y + d, sz * h], 0.04);
}

function eiffel(t?: Team): ModelDef {
  const b = siteB();
  // the Champ-de-Mars plinth and the legs' four stone piers
  b.block(2.9, 0.06, 2.9, [0, 0.03, 0], STONE_D, { taper: 0.01, bevel: 0.02 });
  const s0 = spread(0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.block(0.5, 0.1, 0.5, [sx * s0, 0.08, sz * s0], STONE, { bevel: 0.02 });
  // the legs, up to the second platform
  const y2 = 2.2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) leg(b, sx, sz, y2, 6);
  // the great arches between the legs under the first platform
  const y1 = 0.95;
  for (const [ry, ax, az] of [[0, 0, 1], [0, 0, -1], [Math.PI / 2, 1, 0], [Math.PI / 2, -1, 0]] as Vec3[])
    rib(b, spread(0.3) * 0.82, 0.03, [ax * spread(0.6), 0.25, az * spread(0.6)], EIFFEL, ry, 1.0);
  platform(b, spread(y1) + 0.08, y1, 0.1, true);
  platform(b, spread(y2) + 0.04, y2, 0.08, true);
  // the shaft: four chords converging to the third platform, braced storey by storey
  const y3 = 4.6;
  const n = 7;
  const r = (y: number) => spread(y2) * (1 - (y - y2) / (y3 - y2)) * 0.82 + 0.1 * ((y - y2) / (y3 - y2));
  for (let k = 0; k < n; k++) {
    const ya = y2 + ((y3 - y2) * k) / n;
    const yb = y2 + ((y3 - y2) * (k + 1)) / n;
    const [ra, rb] = [r(ya), r(yb)];
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, -1], [-1, 1]] as [number, number][]) {
      rod(b, [sx * ra, ya, sz * ra], [sx * rb, yb, sz * rb], 0.024, EIFFEL);
    }
    for (const [ax, az, cx, cz] of [[1, 1, 1, -1], [1, -1, -1, -1], [-1, -1, -1, 1], [-1, 1, 1, 1]] as [number, number, number, number][])
      rod(b, [ax * ra, ya, az * ra], [cx * rb, yb, cz * rb], 0.009, EIFFEL);
    if (k === 3) b.block(ra * 2 + 0.04, 0.03, ra * 2 + 0.04, [0, ya, 0], EIFFEL_L, { bevel: 0.006 });
  }
  // the third platform, the lantern and campanile, the mast, the flag
  b.block(0.36, 0.08, 0.36, [0, y3, 0], EIFFEL_L, { bevel: 0.01 });
  b.block(0.24, 0.16, 0.24, [0, y3 + 0.12, 0], EIFFEL, { bevel: 0.01 });
  b.box(0.2, 0.08, 0.2, [0, y3 + 0.13, 0], AMBER, { glow: 0.8 });
  b.cyl(0.08, 0.12, 0.22, 8, [0, y3 + 0.31, 0], EIFFEL);
  b.sphere(0.07, [0, y3 + 0.46, 0], BRASS, { w: 8, h: 5, phi: Math.PI / 2 });
  b.cyl(0.012, 0.02, 0.9, 5, [0, y3 + 0.95, 0], EIFFEL);
  b.sphere(0.035, [0, y3 + 1.42, 0], 0xff5a3a, { glow: 1, w: 6, h: 4 });
  b.box(0.42, 0.24, 0.02, [0.22, y3 + 1.22, 0], t?.main ?? NEUTRAL_FLAG);
  return { hull: b.build(), mount: [0, 0, 0], muzzle: [0, 3, 0], rotors: [], height: 6 };
}

export type LandmarkKind = "eiffel";

/** Campaign landmarks by kind: `t` the side holding it (the flag), or none. */
export const LANDMARKS: Record<LandmarkKind, (t?: Team) => ModelDef> = { eiffel };
