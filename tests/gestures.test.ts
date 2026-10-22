import { beforeEach, describe, expect, it, vi } from "vitest";
import { GestureRecognizer, STRAND_PX, TAP_SLOP_PX, isHoldRelease, strandedPointers } from "../src/game/gestures";

function makeCallbacks() {
  return {
    onTap: vi.fn(),
    onDoubleTap: vi.fn(),
    onBoxStart: vi.fn(),
    onBoxMove: vi.fn(),
    onBoxEnd: vi.fn(),
    onPan: vi.fn(),
    onPinch: vi.fn(),
    onRightClick: vi.fn(),
    onWheel: vi.fn()
  };
}

const touch = (id: number, x: number, y: number) => ({ id, x, y, pointerType: "touch" as const });
const mouse = (x: number, y: number, button = 0) => ({ id: 1, x, y, pointerType: "mouse" as const, button });

describe("touch gestures", () => {
  let cb: ReturnType<typeof makeCallbacks>;
  let g: GestureRecognizer;
  beforeEach(() => {
    cb = makeCallbacks();
    g = new GestureRecognizer(cb);
  });

  it("recognizes a tap: short press with little movement", () => {
    g.down(touch(1, 100, 100), 0);
    g.up(touch(1, 103, 102), 120);
    expect(cb.onTap).toHaveBeenCalledWith(103, 102, "touch");
    expect(cb.onPan).not.toHaveBeenCalled();
    expect(cb.onBoxStart).not.toHaveBeenCalled();
  });

  it("recognizes a double tap: two taps close in time and space", () => {
    g.down(touch(1, 100, 100), 0);
    g.up(touch(1, 100, 100), 100);
    g.down(touch(1, 105, 103), 250);
    g.up(touch(1, 105, 103), 340);
    expect(cb.onDoubleTap).toHaveBeenCalledTimes(1);
    expect(cb.onTap).toHaveBeenCalledTimes(1); // first tap fired; second became double
  });

  it("movement past the slop radius before the hold delay becomes a pan", () => {
    g.down(touch(1, 100, 100), 0);
    g.move(touch(1, 130, 100), 100);
    g.move(touch(1, 160, 100), 150);
    g.up(touch(1, 160, 100), 200);
    expect(cb.onPan).toHaveBeenCalled();
    // first pan delta covers the distance from the down point
    expect(cb.onPan.mock.calls[0]).toEqual([30, 0]);
    expect(cb.onPan.mock.calls[1]).toEqual([30, 0]);
    expect(cb.onTap).not.toHaveBeenCalled();
    expect(cb.onBoxStart).not.toHaveBeenCalled();
  });

  it("holding still past the delay starts a box selection", () => {
    g.down(touch(1, 100, 100), 0);
    g.tick(300); // long-press timer fires
    expect(cb.onBoxStart).toHaveBeenCalledWith(100, 100);
    g.move(touch(1, 180, 160), 350);
    expect(cb.onBoxMove).toHaveBeenCalledWith(180, 160);
    g.up(touch(1, 180, 160), 400);
    expect(cb.onBoxEnd).toHaveBeenCalledWith(180, 160, true);
    expect(cb.onTap).not.toHaveBeenCalled();
    expect(cb.onPan).not.toHaveBeenCalled();
  });

  it("a long motionless press-and-release emits a degenerate box, not a tap", () => {
    g.down(touch(1, 100, 100), 0);
    g.tick(300);
    g.up(touch(1, 100, 100), 500);
    expect(cb.onBoxEnd).toHaveBeenCalledWith(100, 100, true);
    expect(cb.onTap).not.toHaveBeenCalled();
  });

  it("tells a hold released in place (a Condor drop) from a box drag", () => {
    const box = () => {
      const [x0, y0] = cb.onBoxStart.mock.calls.at(-1)!;
      const [x1, y1] = cb.onBoxEnd.mock.calls.at(-1)!;
      return isHoldRelease(x0, y0, x1, y1);
    };
    // held still (a finger's jitter included), with or without the tick firing first
    g.down(touch(1, 100, 100), 0);
    g.tick(300);
    g.move(touch(1, 104, 103), 350);
    g.up(touch(1, 104, 103), 400);
    expect(box()).toBe(true);
    g.down(touch(1, 200, 200), 1000);
    g.up(touch(1, 202, 199), 1400);
    expect(box()).toBe(true);
    // a real box drag
    g.down(touch(1, 100, 100), 2000);
    g.tick(2300);
    g.move(touch(1, 100 + TAP_SLOP_PX + 6, 140), 2350);
    g.up(touch(1, 100 + TAP_SLOP_PX + 6, 140), 2400);
    expect(box()).toBe(false);
    expect(cb.onTap).not.toHaveBeenCalled();
    // the line is the tap slop
    expect(isHoldRelease(100, 100, 100 + TAP_SLOP_PX * 0.7, 100 + TAP_SLOP_PX * 0.7)).toBe(true);
    expect(isHoldRelease(100, 100, 100 + TAP_SLOP_PX + 1, 100)).toBe(false);
  });

  it("a box cut short by a second finger or a cancel is not released (never a Condor drop)", () => {
    const ended = () => cb.onBoxEnd.mock.calls.at(-1)!;
    // a still hold, then a second finger comes down to pinch
    g.down(touch(1, 100, 100), 0);
    g.tick(300);
    g.down(touch(2, 200, 100), 400);
    expect(ended()).toEqual([100, 100, false]);
    g.move(touch(2, 260, 100), 450);
    g.up(touch(2, 260, 100), 500);
    g.up(touch(1, 100, 100), 510);
    expect(cb.onBoxEnd).toHaveBeenCalledTimes(1);
    expect(cb.onPinch).toHaveBeenCalled();
    // a still hold, then the OS takes the pointer
    g.down(touch(1, 100, 100), 1000);
    g.tick(1300);
    g.cancel(touch(1, 100, 100));
    expect(ended()).toEqual([100, 100, false]);
    // a dragged box cut short ends where it was dragged to, not where it began
    g.down(touch(1, 100, 100), 2000);
    g.tick(2300);
    g.move(touch(1, 160, 170), 2350);
    g.down(touch(2, 300, 300), 2400);
    expect(ended()).toEqual([160, 170, false]);
    expect(cb.onTap).not.toHaveBeenCalled();
  });

  it("a second finger switches to pinch/two-finger pan and cancels other gestures", () => {
    g.down(touch(1, 100, 100), 0);
    g.down(touch(2, 200, 100), 50);
    // spread: 100 -> 150 while centroid shifts +25
    g.move(touch(1, 75, 100), 100);
    expect(cb.onPinch).toHaveBeenCalled();
    const [scale] = cb.onPinch.mock.calls.at(-1)!;
    expect(scale).toBeCloseTo(1.25, 2);
    g.up(touch(1, 75, 100), 200);
    g.up(touch(2, 200, 100), 250);
    expect(cb.onTap).not.toHaveBeenCalled();
    expect(cb.onBoxStart).not.toHaveBeenCalled();
  });

  it("two-finger drag pans without pinching", () => {
    g.down(touch(1, 100, 100), 0);
    g.down(touch(2, 200, 100), 20);
    g.move(touch(1, 100, 140), 60);
    g.move(touch(2, 200, 140), 61);
    const totalDy = cb.onPan.mock.calls.reduce((s: number, c: number[]) => s + c[1]!, 0);
    expect(totalDy).toBeCloseTo(40, 0);
  });

  it("no tap fires when the hold delay passed even if released at the down point", () => {
    g.down(touch(1, 50, 50), 0);
    g.up(touch(1, 50, 50), 400); // up without tick() having run
    expect(cb.onTap).not.toHaveBeenCalled();
    expect(cb.onBoxEnd).toHaveBeenCalled(); // treated as an instant box
  });

  it("ignores moves and lifts of pointers it never saw go down", () => {
    g.down(touch(1, 100, 100), 0);
    g.move(touch(9, 300, 300), 20); // (a finger that landed on the HUD)
    g.up(touch(9, 300, 300), 40);
    expect(cb.onTap).not.toHaveBeenCalled();
    expect(cb.onPan).not.toHaveBeenCalled();
    g.up(touch(1, 101, 100), 80);
    expect(cb.onTap).toHaveBeenCalledWith(101, 100, "touch");
  });

  it("a finger whose end never came is forgotten: the next tap is a tap again", () => {
    // an edge swipe iOS abandoned: pointerdown, then never pointerup or pointercancel
    g.down(touch(1, 4, 200), 0);
    g.move(touch(1, 40, 200), 50);
    // stuck: every later touch is the second finger of a pinch
    g.down(touch(2, 300, 150), 1000);
    g.up(touch(2, 300, 150), 1080);
    expect(cb.onTap).not.toHaveBeenCalled();
    // the next touchstart shows no finger near (40, 200)
    g.down(touch(3, 300, 150), 2000);
    g.forget([1], 2000);
    g.up(touch(3, 301, 151), 2080);
    expect(cb.onTap).toHaveBeenCalledWith(301, 151, "touch");
    // and nothing is left behind
    g.down(touch(4, 500, 100), 3000);
    g.tick(3300);
    expect(cb.onBoxStart).toHaveBeenCalledWith(500, 100);
  });

  it("forgetting a finger keeps the others going, fires nothing for it, and ends its box unreleased", () => {
    g.down(touch(1, 4, 200), 0); // the lost one
    g.down(touch(2, 100, 100), 1000);
    g.down(touch(3, 200, 100), 1010);
    g.forget([1], 1020);
    g.move(touch(2, 75, 100), 1050); // a real pinch between 2 and 3: spread 100 -> 125
    const [scale] = cb.onPinch.mock.calls.at(-1)!;
    expect(scale).toBeCloseTo(1.25, 2);
    expect(cb.onTap).not.toHaveBeenCalled();
    // a lost finger drawing a box: the box goes, selecting nothing
    g = new GestureRecognizer((cb = makeCallbacks()));
    g.down(touch(1, 100, 100), 0);
    g.tick(300);
    g.move(touch(1, 160, 170), 350);
    g.forget([1], 5000);
    expect(cb.onBoxEnd).toHaveBeenCalledWith(160, 170, false);
    g.up(touch(1, 160, 170), 5100); // (a late lift changes nothing)
    expect(cb.onBoxEnd).toHaveBeenCalledTimes(1);
    expect(cb.onTap).not.toHaveBeenCalled();
    // forgetting pointers it doesn't track is a no-op
    g.down(touch(2, 50, 50), 6000);
    g.forget([7], 6010);
    g.up(touch(2, 50, 50), 6050);
    expect(cb.onTap).toHaveBeenCalledWith(50, 50, "touch");
  });
});

describe("strandedPointers", () => {
  const at = (x: number, y: number) => ({ clientX: x, clientY: y });
  const tracked = (...ps: [number, number, number][]) => new Map(ps.map(([id, x, y]) => [id, { x, y }]));

  it("keeps pointers with a finger under them and strands the rest", () => {
    expect(strandedPointers(tracked(), [at(10, 10)])).toEqual([]);
    expect(strandedPointers(tracked([1, 100, 100], [2, 300, 300]), [at(102, 99), at(300, 300)])).toEqual([]);
    expect(strandedPointers(tracked([1, 4, 200], [2, 300, 150]), [at(300, 150)])).toEqual([1]);
    expect(strandedPointers(tracked([1, 4, 200]), [])).toEqual([1]);
    expect(strandedPointers(tracked([1, 100, 100]), [at(100 + STRAND_PX + 1, 100)])).toEqual([1]);
  });

  it("one finger vouches for one pointer: a lost pointer can't hide under a new finger", () => {
    // the new finger (2) landed 20 px from the lost one (1): pointerdown came first, so 2 is tracked too
    expect(strandedPointers(tracked([1, 280, 150], [2, 300, 150]), [at(300, 150)])).toEqual([1]);
    // two real fingers close together both stay
    expect(strandedPointers(tracked([1, 280, 150], [2, 300, 150]), [at(281, 150), at(300, 151)])).toEqual([]);
  });
});

describe("mouse gestures", () => {
  let cb: ReturnType<typeof makeCallbacks>;
  let g: GestureRecognizer;
  beforeEach(() => {
    cb = makeCallbacks();
    g = new GestureRecognizer(cb);
  });

  it("left click is a tap", () => {
    g.down(mouse(60, 60), 0);
    g.up(mouse(62, 60), 90);
    expect(cb.onTap).toHaveBeenCalledWith(62, 60, "mouse");
  });

  it("left drag box-selects immediately, no hold needed", () => {
    g.down(mouse(60, 60), 0);
    g.move(mouse(120, 130), 40);
    expect(cb.onBoxStart).toHaveBeenCalledWith(60, 60);
    expect(cb.onBoxMove).toHaveBeenCalledWith(120, 130);
    g.up(mouse(120, 130), 100);
    expect(cb.onBoxEnd).toHaveBeenCalledWith(120, 130, true);
    expect(cb.onPan).not.toHaveBeenCalled();
  });

  it("right click commands, does not tap", () => {
    g.down(mouse(80, 90, 2), 0);
    g.up(mouse(80, 90, 2), 60);
    expect(cb.onRightClick).toHaveBeenCalledWith(80, 90);
    expect(cb.onTap).not.toHaveBeenCalled();
  });

  it("middle drag pans", () => {
    g.down(mouse(80, 90, 1), 0);
    g.move({ ...mouse(120, 90, 1) }, 50);
    expect(cb.onPan).toHaveBeenCalledWith(40, 0);
  });

  it("wheel zooms", () => {
    g.wheel(-120, 300, 200);
    expect(cb.onWheel).toHaveBeenCalledWith(-120, 300, 200);
  });
});

describe("routes and the ▢ Cadre toggle", () => {
  /** A selected unit sits within 30 px of (100, 100). */
  const onUnit = (x: number, y: number) => Math.hypot(x - 100, y - 100) <= 30;
  let cb: ReturnType<typeof makeCallbacks> & {
    routeFrom: ReturnType<typeof vi.fn>;
    boxNow: ReturnType<typeof vi.fn>;
    onRouteStart: ReturnType<typeof vi.fn>;
    onRouteMove: ReturnType<typeof vi.fn>;
    onRouteEnd: ReturnType<typeof vi.fn>;
    onPanEnd: ReturnType<typeof vi.fn>;
  };
  let g: GestureRecognizer;
  beforeEach(() => {
    cb = {
      ...makeCallbacks(),
      routeFrom: vi.fn(onUnit),
      boxNow: vi.fn(() => false),
      onRouteStart: vi.fn(),
      onRouteMove: vi.fn(),
      onRouteEnd: vi.fn(),
      onPanEnd: vi.fn()
    };
    g = new GestureRecognizer(cb);
  });

  it("a drag that starts on a selected unit draws a route, not a pan", () => {
    g.down(touch(1, 100, 100), 0);
    g.move(touch(1, 130, 110), 60);
    g.move(touch(1, 200, 160), 120);
    g.up(touch(1, 210, 170), 200);
    expect(cb.onRouteStart).toHaveBeenCalledWith(100, 100);
    expect(cb.onRouteMove.mock.calls).toEqual([[130, 110], [200, 160]]);
    expect(cb.onRouteEnd).toHaveBeenCalledWith(210, 170, true);
    expect(cb.onPan).not.toHaveBeenCalled();
    expect(cb.onBoxStart).not.toHaveBeenCalled();
  });

  it("a drag elsewhere still pans", () => {
    g.down(touch(1, 300, 300), 0);
    g.move(touch(1, 340, 300), 60);
    g.up(touch(1, 340, 300), 100);
    expect(cb.onPan).toHaveBeenCalledWith(40, 0);
    expect(cb.onRouteStart).not.toHaveBeenCalled();
  });

  it("a finger resting on a selected unit never becomes a box, and still draws once it moves", () => {
    g.down(touch(1, 100, 100), 0);
    g.tick(400);
    expect(cb.onBoxStart).not.toHaveBeenCalled();
    g.move(touch(1, 160, 100), 450);
    expect(cb.onRouteStart).toHaveBeenCalledWith(100, 100);
  });

  it("a long press on a selected unit released in place is still the hold release (a drop, an aimed calldown)", () => {
    g.down(touch(1, 100, 100), 0);
    g.tick(400);
    g.up(touch(1, 101, 100), 500);
    expect(cb.onBoxStart).toHaveBeenCalledWith(100, 100);
    expect(cb.onBoxEnd).toHaveBeenCalledWith(101, 100, true);
    expect(isHoldRelease(100, 100, 101, 100)).toBe(true);
  });

  it("a tap on a selected unit is still a tap", () => {
    g.down(touch(1, 100, 100), 0);
    g.up(touch(1, 102, 101), 90);
    expect(cb.onTap).toHaveBeenCalledWith(102, 101, "touch");
    expect(cb.onRouteStart).not.toHaveBeenCalled();
  });

  it("a second finger cuts the route short (no order) and pinches", () => {
    g.down(touch(1, 100, 100), 0);
    g.move(touch(1, 150, 100), 50);
    g.down(touch(2, 300, 300), 80);
    expect(cb.onRouteEnd).toHaveBeenCalledWith(150, 100, false);
    g.move(touch(2, 340, 340), 120);
    expect(cb.onPan).toHaveBeenCalled();
  });

  it("a cancelled pointer and reset() end a route unreleased", () => {
    g.down(touch(1, 100, 100), 0);
    g.move(touch(1, 150, 100), 50);
    g.cancel(touch(1, 150, 100));
    expect(cb.onRouteEnd).toHaveBeenLastCalledWith(150, 100, false);
    g.down(touch(1, 100, 100), 200);
    g.move(touch(1, 170, 100), 250);
    g.reset();
    expect(cb.onRouteEnd).toHaveBeenLastCalledWith(170, 100, false);
    expect(cb.onRouteEnd).toHaveBeenCalledTimes(2);
  });

  it("the mouse never draws routes: its left drag stays a box", () => {
    g.down(mouse(100, 100), 0);
    g.move(mouse(160, 140), 30);
    expect(cb.onBoxStart).toHaveBeenCalledWith(100, 100);
    expect(cb.routeFrom).not.toHaveBeenCalled();
  });

  it("▢ Cadre armed: the next drag is a box at once, even from a selected unit", () => {
    cb.boxNow.mockReturnValue(true);
    g.down(touch(1, 100, 100), 0);
    g.move(touch(1, 180, 160), 40);
    expect(cb.onBoxStart).toHaveBeenCalledWith(100, 100);
    expect(cb.onBoxMove).toHaveBeenCalledWith(180, 160);
    g.up(touch(1, 180, 160), 90);
    expect(cb.onBoxEnd).toHaveBeenCalledWith(180, 160, true);
    expect(cb.onRouteStart).not.toHaveBeenCalled();
    expect(cb.onPan).not.toHaveBeenCalled();
  });
});
