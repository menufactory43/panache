import type { Unit } from "../sim/types";
import { ROUTE_DRAW, planRoute, type Pt } from "./route-draw";
import type { GroundGfx } from "./three/ground-gfx";

/** The order colours (GameScene's order lines): green attack-moves, blue ⚑ Repli moves, and patrols in amber. */
const COL = { attack: 0x7ef29b, move: 0x7ec1ff, patrol: 0xffc54a } as const;

/**
 * The route a finger is drawing on the map (route-draw.ts): its trail on the
 * ground while it draws, then, once lifted, the waypoints it became, fading
 * out over ROUTE_DRAW.lingerMs. GameScene feeds it ground points from the
 * gesture recognizer's onRoute* callbacks and draws it with the world marks.
 */
export class RouteSketch {
  private trail: Pt[] = [];
  private drawing = false;
  /** The plan the last trail became, and when the finger lifted (ms), for the fade. */
  private done: { points: Pt[]; loop: boolean; from: Pt; at: number; move: boolean } | null = null;

  get active(): boolean {
    return this.drawing;
  }

  start(p: Pt): void {
    this.trail = [p];
    this.drawing = true;
    this.done = null;
  }

  /** The finger is over ground point p: a new trail point once it is far enough from the last. */
  move(p: Pt): void {
    if (!this.drawing) return;
    const last = this.trail[this.trail.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) >= ROUTE_DRAW.sampleTiles) this.trail.push(p);
  }

  /**
   * The finger lifted at p (`released`), or the route was cut short. Returns
   * the plan to send, or null (cut short, or too short to mean a route).
   */
  end(p: Pt | null, released: boolean, now: number, move: boolean): { points: Pt[]; loop: boolean } | null {
    if (!this.drawing) return null;
    this.drawing = false;
    if (p) this.trail.push(p);
    const plan = released ? planRoute(this.trail) : null;
    if (plan) this.done = { ...plan, from: this.trail[0]!, at: now, move };
    this.trail = [];
    return plan;
  }

  /** Forget it all (the match ended, the camera was taken). */
  clear(): void {
    this.trail = [];
    this.drawing = false;
    this.done = null;
  }

  /** On the ground: the trail being drawn (`move`: ⚑ Repli is on), or the waypoints it became, fading. */
  draw(g: GroundGfx, now: number, move: boolean): void {
    if (this.drawing && this.trail.length > 1) {
      const col = move ? COL.move : COL.attack;
      g.lineStyle(3, col, 0.9).strokePoints(this.trail);
      const head = this.trail[this.trail.length - 1]!;
      g.fillStyle(col, 0.95).fillCircle(head.x, head.y, 4 * g.px(head.x, head.y));
      return;
    }
    const d = this.done;
    if (!d) return;
    const k = 1 - (now - d.at) / ROUTE_DRAW.lingerMs;
    if (k <= 0) {
      this.done = null;
      return;
    }
    const col = d.loop ? COL.patrol : d.move ? COL.move : COL.attack;
    const pts = [d.from, ...d.points];
    g.lineStyle(2.5, col, 0.85 * k).strokePoints(pts, false);
    for (const p of d.points) {
      const px = g.px(p.x, p.y);
      g.lineStyle(1.5, col, k).strokeCircle(p.x, p.y, 7 * px);
      g.fillStyle(col, k).fillCircle(p.x, p.y, 2.5 * px);
    }
  }
}

/**
 * A selected unit's queued route (sim/route.ts) on the ground, after its
 * order line: a thin line of the order's colour from its current goal
 * through each waypoint, a patrol's closing leg back to the first included.
 * `seen` keeps a group sharing one route to one drawing.
 */
export function drawQueuedRoute(g: GroundGfx, u: Unit, col: number, seen: Set<string>): void {
  const r = u.route;
  const o = u.order;
  if (!r || (o.type !== "move" && o.type !== "attackMove")) return;
  const pts: Pt[] = [{ x: o.x, y: o.y }, ...r.pts];
  const key = pts.map((p) => `${p.x},${p.y}`).join(";");
  if (seen.has(key)) return;
  seen.add(key);
  if (r.loop) pts.push({ x: o.x, y: o.y });
  g.lineStyle(1.2, r.loop ? COL.patrol : col, 0.4, 0).strokePoints(pts, false);
  for (const p of r.pts) g.fillStyle(r.loop ? COL.patrol : col, 0.7).fillCircle(p.x, p.y, 2 * g.px(p.x, p.y));
}
