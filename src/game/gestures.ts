/**
 * Pointer-event gesture recognizer implementing the DESIGN.md control spec.
 * Pure and engine-free: callers feed pointer events with timestamps and call
 * tick() each frame so the long-press timer can fire while a finger holds
 * still. Coordinates are whatever space the caller uses (screen pixels).
 */

export interface GesturePointer {
  id: number;
  x: number;
  y: number;
  pointerType: "touch" | "mouse" | "pen";
  /** Mouse button for down events: 0 left, 1 middle, 2 right. */
  button?: number;
}

export interface GestureCallbacks {
  onTap(x: number, y: number, pointerType: "touch" | "mouse" | "pen"): void;
  onDoubleTap(x: number, y: number): void;
  onBoxStart(x: number, y: number): void;
  onBoxMove(x: number, y: number): void;
  /**
   * The box ended at (x, y). `released`: the finger (or button) lifted; false
   * when the box was cut short — a second finger came down, or the pointer
   * was cancelled (an OS gesture, a call) — which is never a deliberate end.
   */
  onBoxEnd(x: number, y: number, released: boolean): void;
  /** Screen-space camera pan delta. */
  onPan(dx: number, dy: number): void;
  /** A pan gesture ended (finger/button lifted) — for momentum. */
  onPanEnd?(): void;
  /** Relative zoom factor since the previous pinch event, centred on (cx, cy). */
  onPinch(scale: number, cx: number, cy: number): void;
  onRightClick(x: number, y: number): void;
  onWheel(deltaY: number, x: number, y: number): void;
  /**
   * Does a one-finger drag that starts at (x, y) draw a route (on a selected
   * unit, say)? Asked for touch and pen only, as the drag leaves the slop
   * radius; while it says yes, holding still there never turns into a box.
   * Without it, drags never draw routes.
   */
  routeFrom?(x: number, y: number): boolean;
  /** Should the next one-finger drag be a box at once (the ▢ Cadre toggle), touch or not? */
  boxNow?(): boolean;
  /** A route drawn with one finger: starts at the down point, then follows the finger. */
  onRouteStart?(x: number, y: number): void;
  onRouteMove?(x: number, y: number): void;
  /** The route ended at (x, y); `released` as for onBoxEnd (false: cut short, no order). */
  onRouteEnd?(x: number, y: number, released: boolean): void;
}

export const TAP_SLOP_PX = 8;
export const HOLD_DELAY_MS = 250;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;
/** Finger distance must change this much before a pinch starts zooming —
 * otherwise two-finger pans wobble the zoom from natural finger jitter. */
export const PINCH_ACTIVATE_PX = 16;
/** A finger farther than this from where a pointer was last seen isn't that pointer's finger. */
export const STRAND_PX = 64;

/**
 * Which tracked touch pointers have no finger on the screen any more? iOS
 * Safari can end a touch with neither pointerup nor pointercancel (an edge
 * swipe it abandons: WebKit bug 239014), so a recognizer left alone would
 * count that finger as down for good. `touches` is every finger down now (a
 * touchstart's TouchEvent.touches); each vouches for the nearest unclaimed
 * pointer within STRAND_PX (client coordinates), and pointers no finger
 * vouches for are stranded. The finger that just landed is in `touches`
 * whether its pointerdown came before the touchstart or comes after.
 */
export function strandedPointers(
  pointers: ReadonlyMap<number, { x: number; y: number }>,
  touches: ArrayLike<{ clientX: number; clientY: number }>
): number[] {
  if (pointers.size === 0) return [];
  const pairs: { id: number; t: number; d: number }[] = [];
  for (const [id, p] of pointers)
    for (let t = 0; t < touches.length; t++) {
      const d = Math.hypot(touches[t]!.clientX - p.x, touches[t]!.clientY - p.y);
      if (d <= STRAND_PX) pairs.push({ id, t, d });
    }
  pairs.sort((a, b) => a.d - b.d);
  const held = new Set<number>();
  const claimed = new Set<number>();
  for (const { id, t } of pairs) {
    if (held.has(id) || claimed.has(t)) continue;
    held.add(id);
    claimed.add(t);
  }
  return [...pointers.keys()].filter((id) => !held.has(id));
}

/**
 * Was this box (start and end corners) really a long-press released without
 * dragging? The recognizer reports such a hold as a degenerate box
 * (onBoxStart + onBoxEnd at about the same point); callers give it its own
 * meaning — loaded Condors drop their squads there (GameScene) — but only
 * when onBoxEnd says it was `released`.
 */
export function isHoldRelease(x0: number, y0: number, x1: number, y1: number): boolean {
  return Math.hypot(x1 - x0, y1 - y0) <= TAP_SLOP_PX;
}

type Mode = "idle" | "pending" | "pan" | "box" | "route" | "multi" | "mousepan";

interface Tracked {
  id: number;
  x: number;
  y: number;
  type: GesturePointer["pointerType"];
}

export class GestureRecognizer {
  private mode: Mode = "idle";
  private pointers = new Map<number, Tracked>();
  private downX = 0;
  private downY = 0;
  private downTime = 0;
  private downType: "touch" | "mouse" | "pen" = "touch";
  private lastX = 0;
  private lastY = 0;
  private lastTapTime = -Infinity;
  private lastTapX = 0;
  private lastTapY = 0;
  private pinchDist = 0;
  private pinchStartDist = 0;
  private pinchActive = false;

  constructor(private cb: GestureCallbacks) {}

  down(p: GesturePointer, now: number): void {
    if (p.pointerType === "mouse" && p.button === 2) {
      this.cb.onRightClick(p.x, p.y);
      return;
    }
    this.pointers.set(p.id, { id: p.id, x: p.x, y: p.y, type: p.pointerType });

    if (this.pointers.size === 2) {
      this.enterMulti();
      return;
    }
    if (this.pointers.size > 2) return;

    if (p.pointerType === "mouse" && p.button === 1) {
      this.mode = "mousepan";
    } else {
      this.mode = "pending";
    }
    this.downX = p.x;
    this.downY = p.y;
    this.downTime = now;
    this.downType = p.pointerType;
    this.lastX = p.x;
    this.lastY = p.y;
  }

  move(p: GesturePointer, now: number): void {
    // (a pointer this never saw go down, or forgot, steers nothing)
    const t = this.pointers.get(p.id);
    if (!t) return;
    t.x = p.x;
    t.y = p.y;

    switch (this.mode) {
      case "pending": {
        const moved = Math.hypot(p.x - this.downX, p.y - this.downY) > TAP_SLOP_PX;
        if (!moved) break;
        if (this.cb.boxNow?.()) {
          this.mode = "box";
          this.cb.onBoxStart(this.downX, this.downY);
          this.cb.onBoxMove(p.x, p.y);
        } else if (this.routes()) {
          // a drag from a selected unit draws its route (GameScene says where one starts)
          this.mode = "route";
          this.cb.onRouteStart?.(this.downX, this.downY);
          this.cb.onRouteMove?.(p.x, p.y);
        } else if (now - this.downTime >= HOLD_DELAY_MS || this.downType === "mouse") {
          // mouse drags box-select immediately; touch only after the hold
          this.mode = "box";
          this.cb.onBoxStart(this.downX, this.downY);
          this.cb.onBoxMove(p.x, p.y);
        } else {
          this.mode = "pan";
          this.cb.onPan(p.x - this.downX, p.y - this.downY);
        }
        this.lastX = p.x;
        this.lastY = p.y;
        break;
      }
      case "pan":
      case "mousepan":
        this.cb.onPan(p.x - this.lastX, p.y - this.lastY);
        this.lastX = p.x;
        this.lastY = p.y;
        break;
      case "box":
        this.cb.onBoxMove(p.x, p.y);
        this.lastX = p.x;
        this.lastY = p.y;
        break;
      case "route":
        this.cb.onRouteMove?.(p.x, p.y);
        this.lastX = p.x;
        this.lastY = p.y;
        break;
      case "multi": {
        const [a, b] = [...this.pointers.values()];
        if (!a || !b) break;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        this.cb.onPan(cx - this.lastX, cy - this.lastY);
        if (!this.pinchActive && Math.abs(dist - this.pinchStartDist) > PINCH_ACTIVATE_PX)
          this.pinchActive = true;
        if (this.pinchActive && this.pinchDist > 0 && dist > 0)
          this.cb.onPinch(dist / this.pinchDist, cx, cy);
        this.lastX = cx;
        this.lastY = cy;
        this.pinchDist = dist;
        break;
      }
      case "idle":
        break;
    }
  }

  up(p: GesturePointer, now: number): void {
    if (p.pointerType === "mouse" && p.button === 2) return;
    if (!this.pointers.delete(p.id)) return;

    switch (this.mode) {
      case "pending": {
        // never promoted: tap if quick, degenerate box if it was a long hold
        if (now - this.downTime >= HOLD_DELAY_MS) {
          this.cb.onBoxStart(this.downX, this.downY);
          this.cb.onBoxEnd(p.x, p.y, true);
        } else if (
          now - this.lastTapTime <= DOUBLE_TAP_MS &&
          Math.hypot(p.x - this.lastTapX, p.y - this.lastTapY) <= DOUBLE_TAP_SLOP_PX
        ) {
          this.lastTapTime = -Infinity;
          this.cb.onDoubleTap(p.x, p.y);
        } else {
          this.lastTapTime = now;
          this.lastTapX = p.x;
          this.lastTapY = p.y;
          this.cb.onTap(p.x, p.y, this.downType);
        }
        this.mode = "idle";
        break;
      }
      case "box":
        this.cb.onBoxEnd(p.x, p.y, true);
        this.mode = "idle";
        break;
      case "route":
        this.cb.onRouteEnd?.(p.x, p.y, true);
        this.mode = "idle";
        break;
      case "pan":
      case "mousepan":
        this.cb.onPanEnd?.();
        this.mode = "idle";
        break;
      case "multi":
        if (this.pointers.size < 2) {
          this.cb.onPanEnd?.();
          this.mode = "idle";
        }
        break;
      case "idle":
        break;
    }
    if (this.pointers.size === 0 && this.mode !== "idle") this.mode = "idle";
  }

  cancel(p: GesturePointer): void {
    if (!this.pointers.delete(p.id)) return;
    this.cutShort();
    this.mode = this.pointers.size >= 2 ? "multi" : "idle";
  }

  /**
   * Forget pointers whose fingers left without a word (see strandedPointers):
   * one still counted as down would make every later touch the second finger
   * of a pinch (pan and zoom only; no tap, no box) for the rest of the match.
   * Nothing fires for them (a box they drew ends unreleased); the pointers
   * still down start afresh where they are, as if they had just landed.
   */
  forget(ids: Iterable<number>, now: number): void {
    let gone = false;
    for (const id of ids) gone = this.pointers.delete(id) || gone;
    if (!gone) return;
    this.cutShort();
    const rest = [...this.pointers.values()];
    this.pointers.clear();
    this.mode = "idle";
    for (const t of rest) this.down({ id: t.id, x: t.x, y: t.y, pointerType: t.type }, now);
  }

  /**
   * Let go of every pointer without firing anything (no tap, box or pan end):
   * something else just took the camera. Later moves and lifts of those
   * pointers are ignored; the next down starts afresh.
   */
  reset(): void {
    if (this.mode === "route") this.cb.onRouteEnd?.(this.lastX, this.lastY, false); // (the line goes; no order)
    this.pointers.clear();
    this.mode = "idle";
    this.pinchActive = false;
    this.pinchDist = 0;
    this.lastTapTime = -Infinity;
  }

  wheel(deltaY: number, x: number, y: number): void {
    this.cb.onWheel(deltaY, x, y);
  }

  /** Call every frame: fires the long-press box start while holding still. */
  tick(now: number): void {
    // (a finger resting on a selected unit is about to draw its route: no box under it)
    if (this.mode === "pending" && this.downType !== "mouse" && now - this.downTime >= HOLD_DELAY_MS && !this.routes()) {
      this.mode = "box";
      this.cb.onBoxStart(this.downX, this.downY);
      if (navigator.vibrate) navigator.vibrate(10);
    }
  }

  /** Does a drag from the down point draw a route? (touch and pen only: the mouse has its right button) */
  private routes(): boolean {
    return this.downType !== "mouse" && !!this.cb.routeFrom?.(this.downX, this.downY);
  }

  /** A box or route in progress ends unreleased: cut short, nothing selected or ordered. */
  private cutShort(): void {
    if (this.mode === "box") this.cb.onBoxEnd(this.lastX, this.lastY, false);
    if (this.mode === "route") this.cb.onRouteEnd?.(this.lastX, this.lastY, false);
  }

  private enterMulti(): void {
    this.cutShort();
    this.mode = "multi";
    const [a, b] = [...this.pointers.values()];
    if (a && b) {
      this.lastX = (a.x + b.x) / 2;
      this.lastY = (a.y + b.y) / 2;
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchStartDist = this.pinchDist;
      this.pinchActive = false;
    }
  }
}
