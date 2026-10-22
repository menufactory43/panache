/**
 * A route drawn on the map with one finger, turned into a few waypoints.
 * Engine-free and tested (tests/route-draw.test.ts); GameScene feeds it the
 * ground points under the finger, the Controller sends the result
 * (Controller.routeSelected) as a move or attackMove and its waypoints
 * (sim/route.ts).
 *
 * The finger's trail is hundreds of jittery points: Ramer–Douglas–Peucker
 * keeps the corners, points closer together than a unit would notice merge,
 * and a long squiggle keeps only its sharpest turns, a few legs. A trail
 * that comes back to where it started is a patrol.
 */
import { ROUTE_PASS } from "../sim/route";

export interface Pt {
  x: number;
  y: number;
}

export const ROUTE_DRAW = {
  /** A new trail point once the finger has moved this far over the ground (tiles). */
  sampleTiles: 0.3,
  /** RDP tolerance (tiles): bends smaller than this are jitter. */
  epsilon: 1.2,
  /** Waypoints closer than this (tiles) merge: the sim sweeps past a corner within ROUTE_PASS anyway. */
  minGap: ROUTE_PASS * 1.5,
  /** At most this many waypoints (the start aside). */
  maxPoints: 7,
  /** A trail shorter than this (tiles) is no route at all. */
  minLength: 2,
  /** The end within this of the start (tiles) closes a loop… */
  loopClose: 3,
  /** …once the trail has gone at least this far from its start (tiles). */
  loopReach: 4.5,
  /** The drawn line stays on the ground this long after the finger lifts (ms). */
  lingerMs: 1400
} as const;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to the segment a–b. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker: the points of `pts` that keep it within `eps` (the first and last always). */
export function rdp(pts: readonly Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let farD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i]!, pts[a]!, pts[b]!);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return pts.filter((_, i) => keep[i]);
}

/** Drop points closer than `gap` to the one kept before them (the last point stays, replacing its too-close neighbour). */
function spaced(pts: readonly Pt[], gap: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = out[out.length - 1];
    if (!prev || dist(prev, p) >= gap) out.push(p);
    else if (i === pts.length - 1 && out.length > 1) out[out.length - 1] = p;
  }
  return out;
}

/** The trail's length (tiles). */
export function trailLength(pts: readonly Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += dist(pts[i - 1]!, pts[i]!);
  return n;
}

/**
 * The trail, start included, cut down to at most maxPoints + 1 well-spaced
 * corners: past that, the corner that bends the route least goes, one at a
 * time, so the sharpest turns are the ones kept.
 */
export function simplifyRoute(pts: readonly Pt[]): Pt[] {
  const out = spaced(rdp(pts, ROUTE_DRAW.epsilon), ROUTE_DRAW.minGap);
  while (out.length > ROUTE_DRAW.maxPoints + 1) {
    let least = 1;
    let leastD = Infinity;
    for (let i = 1; i < out.length - 1; i++) {
      const d = segDist(out[i]!, out[i - 1]!, out[i + 1]!);
      if (d < leastD) {
        leastD = d;
        least = i;
      }
    }
    out.splice(least, 1);
  }
  return out;
}

/** Does the trail come back to where it started, after going somewhere? */
export function closesLoop(pts: readonly Pt[]): boolean {
  if (pts.length < 3) return false;
  const start = pts[0]!;
  if (dist(pts[pts.length - 1]!, start) > ROUTE_DRAW.loopClose) return false;
  return pts.some((p) => dist(p, start) >= ROUTE_DRAW.loopReach);
}

/**
 * The orders a trail stands for: the waypoints after its start (where the
 * units already are), and whether they loop (a patrol: the last waypoint is
 * the start itself). Null when it is too short to mean a route.
 */
export function planRoute(trail: readonly Pt[]): { points: Pt[]; loop: boolean } | null {
  if (trail.length < 2 || trailLength(trail) < ROUTE_DRAW.minLength) return null;
  const loop = closesLoop(trail);
  const corners = simplifyRoute(trail);
  const points = corners.slice(1);
  if (loop) {
    // back to the very start (where the units were), unless the last corner already is
    const start = trail[0]!;
    if (points.length && dist(points[points.length - 1]!, start) < ROUTE_DRAW.minGap) points[points.length - 1] = start;
    else points.push(start);
    // a loop needs somewhere to go and come back from
    if (points.length < 2) {
      const out = points.filter((p) => p !== start);
      return out.length ? { points: out, loop: false } : null;
    }
  }
  return points.length ? { points, loop } : null;
}
