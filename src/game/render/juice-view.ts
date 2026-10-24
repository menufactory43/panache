import * as THREE from "three";
import { BUILDINGS, UNITS } from "../../sim/balance";
import type { Faction, FxEvent, World } from "../../sim/types";
import { sfx } from "../audio";
import { coinPitchIn } from "../score";
import {
  DepositPops,
  HpTrail,
  SpendWatch,
  barBlink,
  combatAge,
  deathCue,
  enemyBarColor,
  friendlyBarColor,
  ringStrength,
  shakeFor
} from "../juice";
import { TEX } from "../three/particles";
import { Ease } from "../three/tween";
import type { Label } from "../three/screen";
import type { View } from "../three/view";
import type { EntityRenderer } from "./entities";
import { AIR_H } from "../three/view";
import { buzz } from "../../native";

/** Team colours for ground rings and death pulses. */
const TEAM: Record<Faction, number> = { blue: 0x3d8bff, red: 0xff4a3a };
const TRAIL_COLOR = "#fff1c0";
const POP_CSS = 19;

export interface JuiceHost {
  world: World;
  entities: EntityRenderer;
  player: Faction;
  spectator: boolean;
  /** May the local player see this world point (tiles)? */
  sees(x: number, y: number): boolean;
  /** Volume for a sound at tile point (x, y): 0 far off-screen. */
  earshot(x: number, y: number): number;
}

/** CSS colour strings for the bar fills, made once each (the bars redraw every frame). */
const hexes = new Map<number, string>();
function hex(c: number): string {
  let s = hexes.get(c);
  if (!s) hexes.set(c, (s = `#${c.toString(16).padStart(6, "0")}`));
  return s;
}

/**
 * Combat and economy feedback layered over the battle: hit flashes, team
 * combat rings, damage-trail health bars, kill/loss cues, on-screen-only
 * camera shake and gold income pops. GameScene feeds it the sim's fx events
 * once per tick and calls update() every frame; the rules live in ../juice.ts.
 */
export class CombatJuice {
  private trail = new HpTrail();
  private pops = new DepositPops();
  private spend = new SpendWatch();
  private popLabels = new Map<number, Label>();
  private time = 0;
  private sweepT = 0;
  private shakeUntil = 0;
  private shakeLevel = 0;
  private lostAlertAt = -1e9;
  private resEl: HTMLElement | null = null;

  constructor(private v: View, private host: JuiceHost) {}

  // ------------------------------------------------------------- events ---

  /** Handle this tick's sim events (called after GameScene.handleFx). */
  events(list: readonly FxEvent[]): void {
    for (const ev of list) {
      if (ev.type === "hit") this.host.entities.hitFlash(ev.id);
      else if (ev.type === "death") this.death(ev);
      else if (ev.type === "deposit") this.deposit(ev);
    }
  }

  private death(ev: Extract<FxEvent, { type: "death" }>): void {
    const h = this.host;
    const ours = ev.faction === h.player;
    // (a building is seen where any tile of its footprint is: the sim's rule, and its blast's; a Goliath
    // or a Gantry the enemy always sees, so its death is seen wherever it falls)
    const always = ev.buildingKind ? !!BUILDINGS[ev.buildingKind].alwaysVisible : !!ev.unitKind && !!UNITS[ev.unitKind].alwaysVisible;
    const seen = ours || always || (ev.buildingKind ? this.footprintSeen(ev.x, ev.y, BUILDINGS[ev.buildingKind].size) : h.sees(ev.x, ev.y));
    const visible = seen && this.v.rig.onScreen(ev.x, ev.y);
    const cue = deathCue(ev, h.player, h.spectator, seen);
    if (cue.sound === "kill") sfx.play("kill", h.earshot(ev.x, ev.y));
    else if (cue.sound === "lost") {
      if (visible) sfx.play("lost", Math.max(0.6, h.earshot(ev.x, ev.y)));
      else if (this.time - this.lostAlertAt > 1200) {
        // off-screen losses are quieter and throttled, but never silent
        this.lostAlertAt = this.time;
        sfx.play("lost", 0.4);
      }
    }
    if (cue.vibrate) buzz(20);
    if (!visible) return; // never shake (or pulse) for fogged / off-screen deaths
    const s = shakeFor(ev);
    if (this.time >= this.shakeUntil || s.intensity > this.shakeLevel) {
      this.v.rig.shake(s.ms, s.intensity);
      this.shakeUntil = this.time + s.ms;
      this.shakeLevel = s.intensity;
    }
    // a crisp ring in the victim's colour says whose unit just popped
    if (ev.unitKind) {
      const r = UNITS[ev.unitKind].radius;
      const c = new THREE.Color(TEAM[ev.faction]);
      const ground = this.v.terrain.surfaceAt(ev.x, ev.y);
      this.v.particles.spawn({
        x: ev.x, y: (ev.air ? ground + AIR_H : ground) + 0.07, z: ev.y, life: 480, tex: TEX.select, flat: true,
        size0: Math.max(r * 2.6, 0.7), size1: Math.max(r * 2.6, 0.7) * 2.1, alpha0: 0.95, alpha1: 0, r: c.r, g: c.g, b: c.b
      });
    }
  }

  /** May the local player see any tile of the footprint of a building centred on (x, y)? */
  private footprintSeen(x: number, y: number, size: number): boolean {
    const x0 = x - size / 2 + 0.5;
    const y0 = y - size / 2 + 0.5;
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) if (this.host.sees(x0 + dx, y0 + dy)) return true;
    return false;
  }

  private deposit(ev: Extract<FxEvent, { type: "deposit" }>): void {
    const h = this.host;
    if (ev.faction !== h.player) return;
    const key = Math.round(ev.x * 2) * 4096 + Math.round(ev.y * 2);
    const r = this.pops.add(key, ev.amount, this.time);
    this.popText(key, ev.x, ev.y, r.amount, r.merged);
    if (h.spectator) return;
    sfx.play("coin", this.v.rig.onScreen(ev.x, ev.y) ? 0.9 : 0.3, coinPitchIn(h.world.biome, r.streak));
    this.pill("bump");
  }

  /** A gold "+100" that rises from the drop-off; merged deliveries bump the same label. */
  private popText(key: number, x: number, y: number, amount: number, merged: boolean): void {
    const text = `+${Math.round(amount)}`;
    const cur = this.popLabels.get(key);
    if (merged && cur && this.v.screen.has(cur)) {
      cur.text = text;
      this.v.tweens.add({ dur: 180, update: (k) => (cur.scale = 1.25 - 0.25 * k) });
      return;
    }
    const l = this.v.screen.label({
      x, y, h: this.v.terrain.surfaceAt(x, y) + 0.9, text, size: POP_CSS, color: "#ffd66e", stroke: "#3a2604", scale: 0.6
    });
    this.popLabels.set(key, l);
    this.v.tweens.add({ dur: 160, ease: Ease.backOut, update: (k) => (l.scale = 0.6 + 0.4 * k) });
    this.v.tweens.add({ dur: 1100, ease: Ease.quadOut, update: (k) => (l.dy = -38 * k) });
    this.v.tweens.add({
      dur: 450, delay: 650,
      update: (k) => (l.alpha = 1 - k),
      done: () => {
        if (this.popLabels.get(key) === l) this.popLabels.delete(key);
        this.v.screen.remove(l);
      }
    });
  }

  /** Restart a one-shot CSS animation on the scrap pill. */
  private pill(cls: "bump" | "spend"): void {
    this.resEl ??= document.getElementById("res");
    const el = this.resEl;
    if (!el) return;
    el.classList.remove("bump", "spend");
    void el.offsetWidth; // reflow so the animation restarts
    el.classList.add(cls);
  }

  // -------------------------------------------------------------- frame ---

  update(dtMs: number): void {
    this.time += dtMs;
    const h = this.host;
    const w = h.world;
    if (!h.spectator && h.world.winner === null && this.spend.update(w.factions[h.player].scrap) > 0) this.pill("spend");

    // health trails for everything on show (cheap: one map entry per entity)
    for (const u of w.units.values())
      if (h.entities.isShown(u.id)) this.trail.update(u.id, u.hp / UNITS[u.kind].hp, 1, this.time);
    // (a remembered building's trail waits at its last-seen health: seen again, the loss drains in view)
    for (const b of w.buildings.values()) {
      const r = h.entities.shownHp(b.id);
      if (r !== null) this.trail.update(b.id, r, 1, this.time);
    }
    this.sweepT += dtMs;
    if (this.sweepT > 2000) {
      this.sweepT = 0;
      this.trail.retain((id) => w.units.has(id) || w.buildings.has(id));
    }

    // team rings under every unit that fired or was hit in the last ~3 s
    const g = this.v.ground;
    for (const u of w.units.values()) {
      const k = ringStrength(combatAge(u, w.tick));
      if (k <= 0 || !h.entities.isShown(u.id)) continue;
      const p = h.entities.pos(u.id);
      if (!p) continue;
      const st = UNITS[u.kind];
      const flying = st.domain === "air";
      const col = TEAM[u.faction];
      const r = Math.max(st.radius * 1.4, 11 * g.px(p.x, p.y));
      const at = flying ? p.h - 0.08 : undefined;
      // (a lighter halo and fill than a selection's: combat ranks below it)
      g.fillStyle(col, 0.14 * k).fillEllipse(p.x, p.y, r * 2, r * 2, at);
      g.lineStyle(1.6, col, 0.75 * k, 0.6).strokeEllipse(p.x, p.y, r * 2, r * 2, at);
    }
  }

  // --------------------------------------------------------- health bars ---

  /**
   * A health bar with a damage trail (recently lost HP in pale gold that
   * drains away) and, for enemies near death, a 2 Hz blink — drawn in screen
   * space, crisp at every zoom. (x, y) is the bar's top-left in CSS px;
   * `hgt` its fill height (buildings take a taller one). `marks` notch
   * thresholds (shares of full health) taller than the segment ticks: a
   * Goliath's, where each weapon goes offline — pale while the weapon is
   * up, amber while it is down (`down`, per mark; without it, once the
   * health has fallen below the mark).
   */
  healthBar(
    ctx: CanvasRenderingContext2D, id: number, x: number, y: number, width: number, ratio: number, friendly: boolean, hgt = 4,
    marks?: readonly number[], down?: readonly boolean[]
  ): void {
    const minW = 22;
    if (width < minW) {
      x -= (minW - width) / 2;
      width = minW;
    }
    const r = Math.max(0, Math.min(1, ratio));
    const dpr = this.v.dpr;
    barFrame(ctx, dpr, x, y, width, hgt);
    const { x0, y0, w, h, px } = box;
    const trail = Math.max(r, Math.min(1, this.trail.value(id) ?? r));
    const filled = snap(w * r, dpr);
    if (trail > r) {
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = TRAIL_COLOR;
      ctx.fillRect(x0 + filled, y0, snap(w * trail, dpr) - filled, h);
    }
    ctx.globalAlpha = barBlink(r, friendly, this.time);
    ctx.fillStyle = hex(friendly ? friendlyBarColor(r) : enemyBarColor(r));
    ctx.fillRect(x0, y0, filled, h);
    ctx.fillStyle = HIGHLIGHT;
    ctx.fillRect(x0, y0, filled, px);
    // segment ticks make big health pools readable at a glance
    const segs = Math.min(10, Math.floor(w / 7));
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = RIM;
    if (segs >= 2 && !marks) for (let i = 1; i < segs; i++) ctx.fillRect(x0 + snap((w * i) / segs, dpr), y0, px, h);
    ctx.globalAlpha = 1;
    if (marks)
      marks.forEach((m, i) => {
        // a notch standing proud of the frame, rimmed dark so it reads over the fill
        const mx = x0 + snap(w * m, dpr);
        ctx.fillStyle = RIM;
        ctx.fillRect(mx - px, y0 - 3 * px, 3 * px, h + 6 * px);
        ctx.fillStyle = (down ? down[i] : r < m) ? "#ffb347" : "rgba(255,255,255,0.9)";
        ctx.fillRect(mx, y0 - 2 * px, px, h + 4 * px);
      });
  }

  /** A plain meter in the health bars' frame (production, harvester load): `k` of it filled in `color`. */
  meter(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, hgt: number, k: number, color: string): void {
    const dpr = this.v.dpr;
    barFrame(ctx, dpr, x, y, width, hgt);
    const { x0, y0, w, h, px } = box;
    const filled = snap(w * Math.max(0, Math.min(1, k)), dpr);
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, filled, h);
    ctx.fillStyle = HIGHLIGHT;
    ctx.fillRect(x0, y0, filled, px);
  }
}

// ------------------------------------------------------------ bar frame ---

const RIM = "rgba(0,0,0,0.85)";
const TROUGH = "rgba(20,25,34,0.88)";
const HIGHLIGHT = "rgba(255,255,255,0.18)";

/** Round a CSS-px length or coordinate to whole device pixels. */
function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/** The trough of the last frame drawn (CSS px on the device grid; `px` = one CSS px in whole device pixels): reused, no per-frame garbage. */
const box = { x0: 0, y0: 0, w: 0, h: 0, px: 1 };

/**
 * The frame every overlay bar shares: a dark trough inside a 1 px black rim
 * whose corners are cut, so it reads rounded, with every edge on the device
 * pixel grid so it stays crisp at any pixel ratio. Leaves the trough in `box`.
 */
function barFrame(ctx: CanvasRenderingContext2D, dpr: number, x: number, y: number, width: number, hgt: number): void {
  const px = Math.max(1, Math.round(dpr)) / dpr;
  const x0 = snap(x, dpr);
  const y0 = snap(y, dpr);
  const w = snap(width, dpr);
  const h = snap(hgt, dpr);
  ctx.fillStyle = RIM;
  ctx.fillRect(x0 - px, y0, w + 2 * px, h);
  ctx.fillRect(x0, y0 - px, w, h + 2 * px);
  ctx.fillStyle = TROUGH;
  ctx.fillRect(x0, y0, w, h);
  box.x0 = x0;
  box.y0 = y0;
  box.w = w;
  box.h = h;
  box.px = px;
}
