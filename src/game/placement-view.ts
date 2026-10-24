/**
 * Touch-friendly building placement, wired into the scene.
 *
 * Entering placement drops the ghost on a suggested valid spot near the
 * middle of the view (sim/placement.ts suggestPlacement), gliding there if
 * it's off screen. On touch a tap MOVES the ghost (snapping a tile onto a
 * valid spot if that's all it takes), dragging the ghost slides it, and
 * tapping the ghost — or the "✓ Place" chip — builds. A mouse keeps
 * one-click placement with the ghost under the cursor. A refused spot says
 * why above the ghost ("Too far from base"), and a refused build shakes it
 * with a buzz.
 */
import { BUILDINGS } from "../sim/balance";
import { anchoredGoliaths, inGoliathRing } from "../sim/goliath";
import { inBuildRange, suggestPlacement } from "../sim/placement";
import { needsPower, onGrid, powerSources } from "../sim/nations";
import { nationOf } from "../sim/rules";
import type { BuildingKind, Faction, World } from "../sim/types";
import { sfx } from "./audio";
import { setVariant } from "./three/materials";
import { buildingDef, instance, type ModelInstance } from "./three/models";
import type { Label, ScreenRect } from "./three/screen";
import type { View } from "./three/view";
import { radioCue } from "./announcer";
import { PLAYER, type Controller } from "./controller";
import type { GesturePointer } from "./gestures";
import { tr } from "../lang";
import { buzz } from "../native";

type Pt = { x: number; y: number };

export interface PlacementHooks {
  view: View;
  world: World;
  ctrl: Controller;
  /** Middle of the visible battlefield (tiles), clear of the HUD. */
  viewCentre(): { x: number; y: number };
  /** Is this tile point inside the visible battlefield? */
  inView(x: number, y: number): boolean;
  glideTo(x: number, y: number): void;
  /** A one-time hint (shown once per device). */
  hint(id: string, msg: string): void;
  /** Hand a finger back to the gesture recognizer (a pinch that began on the ghost). */
  handoff(p: GesturePointer): void;
}

/** Ghost shake on a refused build (ms) and its amplitude (CSS px). */
const SHAKE_MS = 220;
const SHAKE_PX = 4;
/** The build zone's tint, an anchored Goliath's build ring (team blue), and the footprint where the ghost may / may not stand (its ghost tints). */
const ZONE = 0x7ef29b;
const RING = 0x5aa8ff;
const GOOD = 0x37d67a;
const BAD = 0xe25555;
/** The Réseau électrique's tint (an electric blue-white). */
const POWER = 0x8fd3ff;
/** Finger slop around the ghost that still counts as touching it (CSS px). */
const GHOST_SLOP_PX = 14;
/** A press on the ghost that moves less than this is a tap (CSS px). */
const TAP_SLOP_PX = 8;
/** The HUD rails the reason plate slides off (the calldown stack, zoom buttons, minimap), re-measured this often (ms). */
const RAILS = "[data-edge-avoid], .zoombtns, .minimap-wrap";
const RAILS_MS = 300;

export class PlacementView {
  /** The ghost: a translucent model of the building, green where it may stand, red where not. */
  private ghost: ModelInstance | null = null;
  private ghostKind: BuildingKind | null = null;
  private ghostOk: boolean | null = null;
  private label: Label;
  private kind: BuildingKind | null = null;
  private lastType: GesturePointer["pointerType"] = "touch";
  private drag: {
    id: number; sx: number; sy: number; x: number; y: number; tx0: number; ty0: number; moved: boolean;
  } | null = null;
  /** Other fingers that landed during a ghost drag (ignored until lifted). */
  private swallow = new Set<number>();
  private shake = Infinity;
  private pulse = 0;
  private zone: { key: string; runs: number[]; ring: number[]; loops: Pt[][] } | null = null;
  /** Scratch points for a footprint corner bracket. */
  private bracket: Pt[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  private rails: ScreenRect[] = [];
  private railsAt = -Infinity;

  constructor(private h: PlacementHooks) {
    this.label = h.view.screen.label({
      x: 0, y: 0, text: "", size: 14, color: "#ffc2b6", bg: "rgba(12, 15, 22, 0.92)", border: "rgba(255, 106, 88, 0.7)",
      tail: true, pin: 10, visible: false
    });
  }

  /** Placing, the building is ready, and the ghost has a spot. */
  private get active(): boolean {
    const c = this.h.ctrl;
    return !!c.placing && !!c.placeAt && !!this.h.world.factions[PLAYER].pending?.ready;
  }

  private worldAt(sx: number, sy: number): { x: number; y: number } {
    return this.h.view.rig.ground(sx, sy);
  }

  /** Top-left tile for a footprint centred under world point p. */
  private tileUnder(p: { x: number; y: number }): { tx: number; ty: number } {
    const size = BUILDINGS[this.h.ctrl.placing!].size;
    return { tx: Math.round(p.x - size / 2), ty: Math.round(p.y - size / 2) };
  }

  /** Is screen point (sx, sy) on the ghost (with a finger's worth of slop)? */
  private onGhost(sx: number, sy: number): boolean {
    const at = this.h.ctrl.placeAt;
    if (!at || !this.h.ctrl.placing) return false;
    const size = BUILDINGS[this.h.ctrl.placing].size;
    const p = this.worldAt(sx, sy);
    const slop = Math.max(0.3, GHOST_SLOP_PX * this.h.view.rig.worldPerPx(p.x, p.y));
    return p.x >= at.tx - slop && p.x <= at.tx + size + slop && p.y >= at.ty - slop && p.y <= at.ty + size + slop;
  }

  private enter(kind: BuildingKind): void {
    const c = this.h.viewCentre();
    const size = BUILDINGS[kind].size;
    const s = suggestPlacement(this.h.world, PLAYER, kind, c);
    this.h.ctrl.placeAt = s ?? { tx: Math.round(c.x - size / 2), ty: Math.round(c.y - size / 2) };
    if (s && !this.h.inView(s.tx + size / 2, s.ty + size / 2)) this.h.glideTo(s.tx + size / 2, s.ty + size / 2);
    this.pulse = 0;
    if (onGrid(this.h.world, PLAYER) && needsPower(kind))
      this.h.hint("power", tr("Réseau électrique : un bâtiment de la République doit toucher le cercle d'un GQG ou d'une Tour TSF. Hors réseau, il s'arrête.", "Power grid: a Republic building must touch the circle of a GHQ or a Wireless Tower. Off the grid, it stops."));
    else if (this.lastType !== "mouse")
      this.h.hint("place", tr("Touche la carte (ou glisse) pour déplacer le fantôme, puis touche-le ou ✓ Placer pour bâtir.", "Tap the map (or drag) to move the ghost, then tap it or ✓ Place to build."));
  }

  /** Every frame, before drawing. */
  update(delta: number): void {
    const ready = !!this.h.world.factions[PLAYER].pending?.ready;
    const kind = ready ? this.h.ctrl.placing : null;
    if (kind !== this.kind) {
      this.kind = kind;
      this.drag = null;
      if (kind) this.enter(kind);
    } else if (kind && !this.h.ctrl.placeAt) this.enter(kind);
    const d = this.h.ctrl.denied;
    if (d) {
      this.h.ctrl.denied = null;
      this.refused();
    }
    this.shake += delta;
    this.pulse += delta;
  }

  /** A build was refused: shake the ghost, buzz, and say so on the radio. */
  private refused(): void {
    this.shake = 0;
    sfx.play("deny", 0.7);
    buzz([18, 40, 18]);
    radioCue("cant-build");
    const chip = document.querySelector<HTMLElement>('#chips .chip[data-id="place"]');
    if (chip) {
      chip.classList.remove("nope");
      void chip.offsetWidth;
      chip.classList.add("nope");
    }
  }

  // --------------------------------------------------------------- input --

  /** Pointer down on the canvas; true = handled here (don't pass to gestures). */
  down(p: GesturePointer): boolean {
    this.lastType = p.pointerType;
    if (this.drag) {
      if (this.drag.moved) {
        this.swallow.add(p.id); // already sliding the ghost: ignore other fingers
        return true;
      }
      // a second finger before the ghost moved: it's a pinch, give both to the gestures
      const d = this.drag;
      this.drag = null;
      this.h.handoff({ id: d.id, x: d.x, y: d.y, pointerType: "touch" });
      return false;
    }
    if (!this.active || p.pointerType === "mouse" || !this.onGhost(p.x, p.y)) return false;
    const at = this.h.ctrl.placeAt!;
    this.drag = { id: p.id, sx: p.x, sy: p.y, x: p.x, y: p.y, tx0: at.tx, ty0: at.ty, moved: false };
    return true;
  }

  move(p: GesturePointer): boolean {
    if (!this.drag) {
      // a mouse carries the ghost under the cursor
      if (p.pointerType === "mouse" && this.active) this.h.ctrl.placeAt = this.tileUnder(this.worldAt(p.x, p.y));
      return this.swallow.has(p.id);
    }
    if (p.id !== this.drag.id) return true;
    const d = this.drag;
    d.x = p.x;
    d.y = p.y;
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > TAP_SLOP_PX) d.moved = true;
    if (d.moved && this.active) {
      const a = this.worldAt(d.sx, d.sy);
      const b = this.worldAt(p.x, p.y);
      this.h.ctrl.placeAt = { tx: d.tx0 + Math.round(b.x - a.x), ty: d.ty0 + Math.round(b.y - a.y) };
    }
    return true;
  }

  up(p: GesturePointer): boolean {
    if (this.swallow.delete(p.id)) return true;
    if (!this.drag || p.id !== this.drag.id) return false;
    const d = this.drag;
    this.drag = null;
    if (!d.moved) this.h.ctrl.commitPlacement(); // a tap on the ghost builds it
    return true;
  }

  /** A finger that left without a pointerup (gestures.ts strandedPointers): let go of it, building nothing. */
  forget(id: number): void {
    this.swallow.delete(id);
    if (this.drag?.id === id) this.drag = null;
  }

  /** A tap (or the 2nd tap of a double-tap) while placing; true = handled. */
  tap(sx: number, sy: number, type?: GesturePointer["pointerType"]): boolean {
    if (!this.active) return false;
    const t = type ?? this.lastType;
    const at = this.tileUnder(this.worldAt(sx, sy));
    if (t === "mouse") {
      this.h.ctrl.placeAt = at;
      this.h.ctrl.commitPlacement();
    } else if (this.onGhost(sx, sy)) this.h.ctrl.commitPlacement();
    else {
      this.h.ctrl.movePlacement(at.tx, at.ty);
      this.pulse = 0;
      sfx.play("click", 0.35);
    }
    return true;
  }

  // -------------------------------------------------------------- render --

  /** Draw the build zone, the footprint and the ghost (every frame). */
  draw(): void {
    const kind = this.h.ctrl.placing;
    const at = this.h.ctrl.placeAt;
    const v = this.h.view;
    if (!kind || !at || !this.active) {
      if (this.ghost) this.ghost.root.visible = false;
      this.label.visible = false;
      return;
    }
    const w = this.h.world;
    // where you may build: the build-range zone, tinted (an anchored Goliath's ring in team
    // blue: outposts), with a soft glow under a crisp rounded outline
    const g = v.over;
    const size = BUILDINGS[kind].size;
    // the République's Réseau électrique replaces the base range (PANACHE-CONCEPTION.md §1.2): its
    // sources' radii, the footprint must reach one (a GQG and a Tour TSF go up by the base range)
    const grid = onGrid(w, PLAYER) && needsPower(kind);
    if (grid) this.drawPower(w, at.tx, at.ty, size);
    else {
      const z = this.buildZone(w, kind);
      g.fillStyle(ZONE, 0.08);
      for (let i = 0; i < z.runs.length; i += 3) g.fillRect(z.runs[i]!, z.runs[i + 1]!, z.runs[i + 2]!, 1);
      g.fillStyle(RING, 0.14);
      for (let i = 0; i < z.ring.length; i += 3) g.fillRect(z.ring[i]!, z.ring[i + 1]!, z.ring[i + 2]!, 1);
      g.lineStyle(7, ZONE, 0.12, 0);
      for (const loop of z.loops) g.strokePoints(loop, true);
      g.lineStyle(2, ZONE, 0.8);
      for (const loop of z.loops) g.strokePoints(loop, true);
    }
    const why = this.h.ctrl.placementProblem();
    const ok = why === null;
    const k = this.shake < SHAKE_MS ? 1 - this.shake / SHAKE_MS : 0;
    const cx = at.tx + size / 2;
    const cy = at.ty + size / 2;
    const off = k > 0 ? Math.sin((this.shake / SHAKE_MS) * Math.PI * 6) * SHAKE_PX * v.rig.worldPerPx(cx, cy) * k : 0;
    const x = at.tx + off;
    const y = at.ty;
    if (!this.ghost || this.ghostKind !== kind) {
      if (this.ghost) v.scene.remove(this.ghost.root);
      this.ghost = instance(buildingDef(kind, PLAYER, nationOf(this.h.world, PLAYER)), false);
      this.ghost.root.renderOrder = 21;
      this.ghost.root.traverse((o) => (o.renderOrder = 21));
      this.ghostKind = kind;
      this.ghostOk = null;
      v.scene.add(this.ghost.root);
    }
    if (this.ghostOk !== ok) {
      this.ghostOk = ok;
      setVariant(this.ghost.root, ok ? "ghostOk" : "ghostBad");
    }
    const ground = Math.max(v.terrain.heightAt(cx, cy), v.terrain.surfaceAt(cx, cy));
    this.ghost.root.visible = true;
    this.ghost.root.position.set(x + size / 2, ground, y + size / 2);
    // a valid ghost breathes, inviting the tap that builds it
    const breathe = ok ? 0.7 + 0.3 * Math.sin(this.pulse / 260) : 0.95;
    this.ghost.root.scale.set(1, ok ? 0.96 + 0.04 * breathe : 1, 1);
    // the footprint: a tinted pad with its tile grid, a crisp rim and corner brackets that breathe
    const t = v.top;
    const col = ok ? GOOD : BAD;
    t.fillStyle(col, ok ? 0.2 : 0.26).fillRect(x, y, size, size);
    t.lineStyle(1, col, 0.4, 0);
    for (let i = 1; i < size; i++) t.lineBetween(x + i, y, x + i, y + size).lineBetween(x, y + i, x + size, y + i);
    t.lineStyle(2, col, 0.55 + 0.4 * breathe).strokeRect(x, y, size, size);
    const px = v.rig.worldPerPx(cx, cy);
    const gap = px * (ok ? 3 + 3 * breathe : 3);
    const arm = Math.min(size * 0.32, px * 16);
    t.lineStyle(3, col, 0.95);
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1;
      const sy = i & 2 ? 1 : -1;
      const ex = x + size / 2 + sx * (size / 2 + gap);
      const ey = y + size / 2 + sy * (size / 2 + gap);
      const b = this.bracket;
      b[0]!.x = ex - sx * arm;
      b[0]!.y = ey;
      b[1]!.x = ex;
      b[1]!.y = ey;
      b[2]!.x = ex;
      b[2]!.y = ey - sy * arm;
      t.strokePoints(b);
    }
    if (why) {
      this.label.text = why;
      this.label.visible = true;
      this.label.x = x + size / 2;
      this.label.y = y + size / 2;
      this.label.h = ground + (this.ghost.def.height ?? 1) + 0.2;
      this.label.dy = -6;
      this.label.avoid = this.hudRails();
    } else this.label.visible = false;
  }

  /** Where the HUD's side rails cover the battlefield (CSS px), measured a few times a second while a reason shows. */
  private hudRails(): ScreenRect[] {
    const now = performance.now();
    if (now - this.railsAt < RAILS_MS) return this.rails;
    this.railsAt = now;
    this.rails.length = 0;
    document.querySelectorAll(RAILS).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) this.rails.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
    });
    return this.rails;
  }

  /**
   * The Réseau électrique while placing a République building: each source's
   * radius (GQG hqRadius, Tour TSF and moored Zénith towerRadius) as a soft
   * electric disc with a crisp rim and a pylon dot, and, when the ghost is
   * fed, a spark line from the nearest feeding source to it.
   */
  private drawPower(w: World, tx: number, ty: number, size: number): void {
    const g = this.h.view.over;
    const sources = powerSources(w, PLAYER);
    const breathe = 0.5 + 0.5 * Math.sin(this.pulse / 320);
    for (const s of sources) {
      g.fillStyle(POWER, 0.07).fillCircle(s.x, s.y, s.radius);
      g.lineStyle(7, POWER, 0.12, 0).strokeCircle(s.x, s.y, s.radius);
      g.lineStyle(2, POWER, 0.6 + 0.3 * breathe).strokeCircle(s.x, s.y, s.radius);
      g.fillStyle(POWER, 0.9).fillCircle(s.x, s.y, 0.22);
    }
    // the feed: a zigzag to the nearest source the footprint reaches
    const cx = tx + size / 2;
    const cy = ty + size / 2;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const s of sources) {
      const dx = Math.max(tx - s.x, 0, s.x - (tx + size));
      const dy = Math.max(ty - s.y, 0, s.y - (ty + size));
      if (Math.hypot(dx, dy) > s.radius) continue;
      const d = Math.hypot(cx - s.x, cy - s.y);
      if (d < bestD) (bestD = d), (best = s);
    }
    if (!best || bestD < 0.5) return;
    const n = Math.max(3, Math.round(bestD / 1.2));
    const nx = -(cy - best.y) / bestD;
    const ny = (cx - best.x) / bestD;
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const j = i === 0 || i === n ? 0 : (i % 2 ? 1 : -1) * 0.22 * (0.6 + 0.4 * breathe);
      pts.push({ x: best.x + (cx - best.x) * k + nx * j, y: best.y + (cy - best.y) * k + ny * j });
    }
    g.lineStyle(5, POWER, 0.18, 0).strokePoints(pts);
    g.lineStyle(1.6, 0xfff3c4, 0.9).strokePoints(pts);
  }

  /**
   * The build zone (zoneAt): base tiles and ring-only tiles as horizontal
   * runs [x, y, length, …] (tiles), and the whole zone's outline as closed
   * loops with their tile-step corners rounded off. Recomputed only when
   * the buildings or the anchored Goliaths (which stand still) change.
   */
  private buildZone(w: World, kind: BuildingKind): { runs: number[]; ring: number[]; loops: Pt[][] } {
    const goliaths = kind === "hq" ? [] : anchoredGoliaths(w, PLAYER);
    let key = "";
    for (const b of w.buildings.values()) if (b.faction === PLAYER) key += `${b.id}${b.outpost ? "o" : ""},`;
    for (const g of goliaths) key += `g${g.id}:${g.goliath!.mode}@${g.x},${g.y},`;
    if (this.zone?.key === key) return this.zone;
    const W = w.width;
    const inZone = new Uint8Array(W * w.height);
    // (with no Goliath anchored there is no ring to test: base range alone)
    const test: BuildingKind = goliaths.length > 0 ? kind : "hq";
    for (let ty = 0; ty < w.height; ty++) for (let tx = 0; tx < W; tx++) inZone[ty * W + tx] = zoneAt(w, PLAYER, test, tx, ty);
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < w.height && inZone[y * W + x]! > 0;
    const runs: number[] = [];
    const ring: number[] = [];
    // (ring-only tiles in runs of their own, for the team tint)
    for (let ty = 0; ty < w.height; ty++) {
      let start = -1;
      for (let tx = 0; tx <= W; tx++) {
        const on = tx < W && inZone[ty * W + tx] === 2;
        if (on && start < 0) start = tx;
        if (!on && start >= 0) {
          ring.push(start, ty, tx - start);
          start = -1;
        }
      }
    }
    // boundary edges between grid corners, directed with the zone on their right
    const corner = (x: number, y: number) => y * (W + 1) + x;
    const out = new Map<number, number[]>();
    const edge = (x0: number, y0: number, x1: number, y1: number) => {
      const k = corner(x0, y0);
      const list = out.get(k);
      if (list) list.push(corner(x1, y1));
      else out.set(k, [corner(x1, y1)]);
    };
    for (let ty = 0; ty < w.height; ty++) {
      let start = -1;
      for (let tx = 0; tx <= W; tx++) {
        const on = at(tx, ty);
        if (on && start < 0) start = tx;
        if (!on && start >= 0) {
          runs.push(start, ty, tx - start);
          start = -1;
        }
        if (!on) continue;
        if (!at(tx, ty - 1)) edge(tx, ty, tx + 1, ty);
        if (!at(tx + 1, ty)) edge(tx + 1, ty, tx + 1, ty + 1);
        if (!at(tx, ty + 1)) edge(tx + 1, ty + 1, tx, ty + 1);
        if (!at(tx - 1, ty)) edge(tx, ty + 1, tx, ty);
      }
    }
    // walk the edges into loops (where two zone tiles touch only at a corner, turn right: separate loops)
    const loops: Pt[][] = [];
    for (const [s, ends] of out) {
      while (ends.length > 0) {
        const pts: Pt[] = [];
        let cur = s;
        let dx = 0;
        let dy = 0;
        for (let guard = 0; guard < 100000; guard++) {
          const cx = cur % (W + 1);
          const cy = (cur - cx) / (W + 1);
          const list = out.get(cur);
          if (!list || list.length === 0) break;
          let pick = 0;
          if (list.length > 1)
            for (let i = 0; i < list.length; i++) {
              const nx = (list[i]! % (W + 1)) - cx;
              const ny = (list[i]! - (list[i]! % (W + 1))) / (W + 1) - cy;
              if (nx === -dy && ny === dx) pick = i; // the right turn
            }
          const next = list.splice(pick, 1)[0]!;
          const nx = next % (W + 1);
          const ny = (next - nx) / (W + 1);
          const ndx = nx - cx;
          const ndy = ny - cy;
          if (ndx !== dx || ndy !== dy) pts.push({ x: cx, y: cy }); // keep the corners only
          dx = ndx;
          dy = ndy;
          cur = next;
          if (cur === s) break;
        }
        if (pts.length >= 3) loops.push(smoothLoop(smoothLoop(pts, 0.42), 0.2));
      }
    }
    this.zone = { key, runs, ring, loops };
    return this.zone;
  }

  destroy(): void {
    if (this.ghost) this.h.view.scene.remove(this.ghost.root);
    this.h.view.screen.remove(this.label);
  }
}

/**
 * Whether tile (tx, ty) is in `faction`'s build zone for `kind`, by the
 * sim's own rule (economy.ts canPlaceBuilding): 1 when its centre is in base
 * range (sim/placement.ts inBuildRange; outposts never count), 2 when it is
 * only in the build ring of an anchored Goliath (inGoliathRing; anything but
 * an HQ goes up there, as an outpost), else 0.
 */
export function zoneAt(w: World, faction: Faction, kind: BuildingKind, tx: number, ty: number): 0 | 1 | 2 {
  if (inBuildRange(w, faction, tx + 0.5, ty + 0.5)) return 1;
  return kind !== "hq" && inGoliathRing(w, faction, tx, ty, 1) ? 2 : 0;
}

/** One round of corner cutting on a closed loop: each corner is cut back by at most `cap` tiles (and a quarter edge) along both sides. */
function smoothLoop(pts: Pt[], cap: number): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const k = Math.min(0.25, cap / len);
    out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, { x: b.x - (b.x - a.x) * k, y: b.y - (b.y - a.y) * k });
  }
  return out;
}
