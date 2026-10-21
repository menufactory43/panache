/**
 * L'Instruction in the match: the scene's half of the guided first mission.
 * Every frame it observes the battle (TutObs), lets the lesson
 * (src/game/tutorial.ts) say what comes next, and puts that on screen through
 * the overlay (src/ui/tutorial.ts): the one bubble, the gloved hand on the
 * one control or spot, the pennant over the flag.
 *
 * It also stages the battlefield, which has no enemy commander: the patrol,
 * the convoy for the Feu roulant and the outpost come in only when their beat
 * begins, and `hold` freezes the clock (the scene stops stepping the sim)
 * while the lesson waits on the player's tap — the enemy in view, the
 * battlefield calm until the player is ready. A single-player lesson with no
 * replay, so it may touch the world between ticks.
 */
import { BUILDINGS, POWERS, UNITS } from "../sim/balance";
import { Vis, isVisible } from "../sim/fog";
import { TUTORIAL_SPOTS } from "../sim/ops";
import type { Command, Faction, PowerKind, Unit, UnitKind, World } from "../sim/types";
import { hqOf, inBounds, moveClassOf, passable, spawnBuilding, spawnUnit } from "../sim/world";
import { sfx } from "./audio";
import { PLAYER, type Controller } from "./controller";
import { TutorialRunner, setTutorialState, type TutControl, type TutEffect, type TutObs, type TutSpot, type TutTarget } from "./tutorial";
import type { GroundGfx } from "./three/ground-gfx";
import { mountTutorialOverlay, type Box, type TutOverlay } from "../ui/tutorial";

export interface TutorialViewHooks {
  world: World;
  ctrl: Controller;
  rig: {
    x: number;
    y: number;
    zoom: number;
    project(x: number, y: number, h?: number): { x: number; y: number; behind: boolean };
    onScreen(x: number, y: number, pad?: number): boolean;
  };
  hudRoot: HTMLElement;
  /** Belle Époque HUD (drawer, ⚔, ⚡ fan) or the original bar. */
  belle: boolean;
  glideTo(x: number, y: number): void;
  zoomTo(zoom: number): void;
  surfaceAt(x: number, y: number): number;
  /** Where an entity's body is drawn on screen (CSS px), or null. */
  screenOf(id: number): { x: number; y: number } | null;
  /** Middle of the visible battlefield on screen (CSS px). */
  playCentre(): { x: number; y: number };
  /** Is tile point (x, y) at least `margin` CSS px inside the visible battlefield (clear of the HUD)? */
  inPlay(x: number, y: number, margin: number): boolean;
  /** The calldown armed on the ⚡ panel. */
  targeting(): PowerKind | null;
  /** A pre-recorded announcer line. */
  say(text: string): void;
  pulse(x: number, y: number, col: number, size: number): void;
  /** Leave the lesson (Passer): back to the menu. */
  leave(): void;
}

/** CSS selectors for each control, Panache HUD first, the original bar second. */
const CONTROLS: Record<TutControl, [string, string]> = {
  build: [".bh-build", '.tabs .tab[data-tab="build"]'],
  "tab-build": ['.tabs .tab[data-tab="build"]', '.tabs .tab[data-tab="build"]'],
  "tab-ground": ['.tabs .tab[data-tab="ground"]', '.tabs .tab[data-tab="ground"]'],
  "tile-forges": ['.bb[data-key="b:fab-plant"]', '.bb[data-key="b:fab-plant"]'],
  "tile-panhard": ['.bb[data-key="u:stinger"]', '.bb[data-key="u:stinger"]'],
  army: [".bh-army", '.chip[data-id="army"]'],
  pill: [".bh-pill", "#res"],
  power: [".bh-pow", ".powers .pw-meter"],
  "power-barrage": ['.powers .pw[data-p="barrage"]', '.powers .pw[data-p="barrage"]'],
  place: ['.chip[data-id="place"]', '.chip[data-id="place"]'],
  deselect: ['.chip[data-id="clear"]', '.chip[data-id="clear"]']
};

/** Who the lesson brings in. */
const ENEMY: Faction = "red";
/** Where the enemies come from: the open ground north-east of the start. */
const FROM = { x: 34, y: 30 };
/** The patrol's Panhard are worn (a sure first win); the outpost's Hotchkiss a little too. */
const PATROL_HP = 40;
const TURRET_HP = 320;
const DEPOT_HP = 420;

export class TutorialView {
  /** The lesson waits on the player: the scene stops stepping the sim. */
  hold = false;
  private run = new TutorialRunner();
  private ui: TutOverlay;
  private touch: boolean;
  private patrol: number[] = [];
  private convoy: number[] = [];
  private outpost: number[] = [];
  private patrolSeen = false;
  private convoySeen = false;
  private patrolAttacked = false;
  private outpostOrdered = false;
  private firedOrders = 0;
  private filling = false;
  private base = { i: -1, x: 0, y: 0, zoom: 1 };
  private lastPhase = "";
  private glided = "";
  private glides = 0;
  private glideAt = 0;
  private ended = false;
  private hideAt = 0;
  private reinforced = 0;
  private restoreEnqueue: () => void;

  constructor(private h: TutorialViewHooks) {
    this.touch = navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;
    h.hudRoot.classList.add("tuto-on");
    this.ui = mountTutorialOverlay({
      host: h.hudRoot,
      skip: () => {
        setTutorialState("no");
        h.leave();
      }
    });
    // every order the player gives passes by here first (the lesson reads intent, not just results)
    const ctrl = h.ctrl;
    const orig = ctrl.enqueue;
    ctrl.enqueue = (c: Command) => {
      this.saw(c);
      orig.call(ctrl, c);
    };
    this.restoreEnqueue = () => (ctrl.enqueue = orig);
    this.base = { i: 0, x: h.rig.x, y: h.rig.y, zoom: h.rig.zoom };
  }

  /** Debugging and the headless check: where the lesson is. */
  get state(): { beat: string; index: number; hold: boolean; log: readonly string[] } {
    return { beat: this.run.beat.id, index: this.run.index, hold: this.hold, log: this.run.log };
  }

  // ------------------------------------------------------------ orders ---

  private saw(c: Command): void {
    if (c.faction !== PLAYER) return;
    const w = this.h.world;
    const near = (ids: number[], x: number, y: number, r: number) =>
      ids.some((id) => {
        const e = w.units.get(id) ?? w.buildings.get(id);
        if (!e) return false;
        const ex = "tx" in e ? e.tx + BUILDINGS[e.kind].size / 2 : e.x;
        const ey = "ty" in e ? e.ty + BUILDINGS[e.kind].size / 2 : e.y;
        return Math.hypot(ex - x, ey - y) <= r;
      });
    if (c.type === "attack") {
      if (this.patrol.includes(c.targetId)) this.patrolAttacked = true;
      if (this.outpost.includes(c.targetId)) this.outpostOrdered = true;
    } else if (c.type === "attackMove" || c.type === "move") {
      if (near(this.patrol, c.x, c.y, 3.5)) this.patrolAttacked = true;
      if (near(this.outpost, c.x, c.y, 5)) this.outpostOrdered = true;
    } else if (c.type === "calldown" && c.power === "barrage") this.firedOrders++;
  }

  // ------------------------------------------------------------ observe ---

  private alive(ids: number[]): Unit[] {
    const w = this.h.world;
    return ids.map((id) => w.units.get(id)).filter((u): u is Unit => !!u);
  }

  private starters(): Unit[] {
    return this.alive(this.h.world.ops?.tags.starters ?? []);
  }

  private observe(): TutObs {
    const { world: w, ctrl, rig, hudRoot } = this.h;
    const starters = this.starters();
    const flag = TUTORIAL_SPOTS.flag;
    const toFlag = (u: Unit) => {
      const o = u.order;
      return (o.type === "move" || o.type === "attackMove") && Math.hypot(o.x - flag.x, o.y - flag.y) <= 3;
    };
    const mine = (kind: string) => [...w.buildings.values()].filter((b) => b.faction === PLAYER && b.kind === kind);
    let queued = 0;
    for (const b of w.buildings.values()) if (b.faction === PLAYER) queued += b.queue.filter((q) => q.kind === "stinger").length;
    const army = ctrl.armyIds();
    const pending = ctrl.view().pending;
    const outpostAlive = this.outpost.filter((id) => w.buildings.has(id)).length;
    // (under fire, or one of the two already down: the assault is on — and stays on)
    if (!this.outpostOrdered && this.outpost.length > 0)
      this.outpostOrdered =
        outpostAlive < this.outpost.length ||
        this.outpost.some((id) => {
          const b = w.buildings.get(id);
          return !!b && b.hp < (b.kind === "turret" ? TURRET_HP : DEPOT_HP);
        });
    return {
      touch: this.touch,
      belle: this.h.belle,
      panned: Math.hypot(rig.x - this.base.x, rig.y - this.base.y),
      zoomRatio: rig.zoom / this.base.zoom,
      starters: starters.length,
      startersSelected: starters.filter((u) => ctrl.selectedUnits.has(u.id)).length,
      selected: ctrl.selectedUnits.size,
      headingToFlag: starters.some(toFlag),
      atFlag: starters.some((u) => Math.hypot(u.x - flag.x, u.y - flag.y) <= 2.6),
      patrolSpawned: this.patrol.length > 0,
      patrolSeen: this.patrolSeen,
      patrolAlive: this.alive(this.patrol).length,
      patrolAttacked: this.patrolAttacked || this.alive(this.patrol).some((u) => u.hp < PATROL_HP),
      busy: this.h.belle && hudRoot.dataset.bh === "busy",
      drawerOpen: !this.h.belle || hudRoot.classList.contains("bh-sheet-open"),
      tab: hudRoot.querySelector<HTMLElement>(".tabs .tab.on")?.dataset.tab ?? "build",
      pending: pending ? { kind: pending.kind, ready: pending.ready } : null,
      placing: ctrl.placing,
      forges: mine("fab-plant").length,
      panhards: [...w.units.values()].filter((u) => u.faction === PLAYER && u.kind === "stinger").length,
      panhardsQueued: queued,
      army: army.length,
      armySelected: army.length > 0 && army.every((id) => ctrl.selectedUnits.has(id)),
      harvested: w.factions[PLAYER].stats.scrapHarvested,
      barrageReady: ctrl.powerStatus("barrage").ready,
      fanOpen: !this.h.belle || hudRoot.classList.contains("bh-fan-open"),
      armed: this.h.targeting(),
      barrageFired: Math.max(this.firedOrders, w.powers.fired[PLAYER].barrage),
      convoySpawned: this.convoy.length > 0,
      convoySeen: this.convoySeen,
      convoyAlive: this.alive(this.convoy).length,
      outpostSpawned: this.outpost.length > 0,
      outpostAlive,
      outpostOrdered: this.outpostOrdered,
      armyIdle: army.every((id) => {
        const u = w.units.get(id);
        return !u || (u.order.type === "idle" && u.autoTargetId === null);
      }),
      t: 0
    };
  }

  // ------------------------------------------------------------- frame ---

  /** Every frame (real ms). */
  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    const w = this.h.world;
    if (this.ended) {
      if (this.hideAt && performance.now() > this.hideAt) {
        this.hideAt = 0;
        this.ui.hide();
      }
      return;
    }
    // ⚡ fills while the convoy is in view (the lesson's own charge: no losses needed)
    if (this.filling && this.convoySeen) {
      const m = w.powers.meter;
      const need = POWERS.barrage.cost;
      if (m[PLAYER] < need) m[PLAYER] = Math.min(need, m[PLAYER] + 28 * dt);
      else this.filling = false;
    }
    const f = this.run.update(this.observe(), dt);
    if (f.index !== this.base.i) this.base = { i: f.index, x: this.h.rig.x, y: this.h.rig.y, zoom: this.h.rig.zoom };
    for (const e of f.effects) this.effect(e);
    if (f.voice) this.h.say(f.voice);
    if (f.phase !== this.lastPhase && (f.phase === "praise" || f.phase === "end")) sfx.play(f.phase === "end" ? "rank" : "ready", 0.6);
    this.lastPhase = f.phase;

    // the pennant: from "select a Panhard" until they reach it
    const flagUp = f.beat.id === "select" || f.beat.id === "move";
    const fl = TUTORIAL_SPOTS.flag;
    const fs = flagUp ? this.h.rig.project(fl.x, fl.y, this.h.surfaceAt(fl.x, fl.y)) : null;
    this.ui.flag(fs && !fs.behind ? fs : null);

    if (f.phase === "end") {
      this.ended = true;
      this.h.hudRoot.classList.remove("tuto-on");
      this.hold = false;
      setTutorialState("done");
      this.ui.say(f.praise ?? "Tu es prêt, mon commandant !", { step: 10, tone: "end" });
      this.ui.point(null, false);
      this.ui.gesture(null);
      this.ui.flag(null);
      this.hideAt = performance.now() + 3800;
      return;
    }
    if (f.phase === "praise") {
      this.hold = false;
      this.ui.say(f.praise ?? "", { step: f.beat.step, tone: "praise" });
      this.ui.point(null, false);
      this.ui.gesture(null);
      return;
    }
    const g = f.guide;
    if (!g) return; // (a beat just ended without praise: the next one speaks next frame)
    this.hold = !!g.hold && !w.winner;
    this.ui.say(g.text, { step: f.beat.step, tone: "do" });
    this.show(f.beat.id, g.target, g.hand);
    this.reinforce(f.beat.id);
  }

  /** Point at the guide's target (and bring the camera to it when it's off screen). */
  private show(beat: string, t: TutTarget | null, hand: boolean): void {
    if (!t) {
      this.ui.point(null, false);
      this.ui.gesture(null);
      return;
    }
    if (t.kind === "gesture") {
      this.ui.point(null, false);
      this.ui.gesture(t.g, this.h.playCentre());
      return;
    }
    this.ui.gesture(null);
    if (t.kind === "dom") return this.ui.point(this.domBox(t.el), hand);
    const at = this.spot(t.what);
    if (!at) return this.ui.point(null, false);
    // off screen: glide there (again a moment later if it's still not in view, a few times per beat and spot)
    const key = `${beat}:${t.what}`;
    if (key !== this.glided) {
      this.glided = key;
      this.glides = 0;
      this.glideAt = 0;
    }
    const now = performance.now();
    if (!this.h.inPlay(at.x, at.y, 50) && this.glides < 4 && now - this.glideAt > 1800) {
      this.glides++;
      this.glideAt = now;
      // the flag: frame it with the Panhard going there
      const s0 = t.what === "flag" ? this.starters()[0] : null;
      this.h.glideTo(s0 ? (s0.x + at.x) / 2 : at.x, s0 ? (s0.y + at.y) / 2 : at.y);
    }
    const s = at.id !== undefined ? this.h.screenOf(at.id) : null;
    const p = s ?? this.h.rig.project(at.x, at.y, this.h.surfaceAt(at.x, at.y) + (at.lift ?? 0));
    if ("behind" in p && p.behind) return this.ui.point(null, false);
    const r = at.r ?? 18;
    this.ui.point({ x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 }, hand);
  }

  private domBox(c: TutControl): Box | null {
    const sel = CONTROLS[c][this.h.belle ? 0 : 1];
    const el = this.h.hudRoot.querySelector<HTMLElement>(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** A battlefield spot (tiles), with the entity to track on screen if there is one. */
  private spot(what: TutSpot): { x: number; y: number; id?: number; lift?: number; r?: number } | null {
    const w = this.h.world;
    const first = (ids: number[]) => this.alive(ids)[0] ?? null;
    switch (what) {
      case "starters": {
        // the one nearest the middle of the screen is the easiest to tap
        const c = this.h.playCentre();
        let best: Unit | null = null;
        let bd = Infinity;
        for (const u of this.starters()) {
          const s = this.h.screenOf(u.id);
          const d = s ? Math.hypot(s.x - c.x, s.y - c.y) : Infinity;
          if (d < bd || !best) {
            bd = d;
            best = u;
          }
        }
        return best ? { x: best.x, y: best.y, id: best.id } : null;
      }
      case "flag":
        return { x: TUTORIAL_SPOTS.flag.x, y: TUTORIAL_SPOTS.flag.y, r: 22 };
      case "patrol": {
        const u = first(this.patrol);
        return u ? { x: u.x, y: u.y, id: u.id } : null;
      }
      case "convoy": {
        const us = this.alive(this.convoy);
        if (us.length === 0) return null;
        const x = us.reduce((s, u) => s + u.x, 0) / us.length;
        const y = us.reduce((s, u) => s + u.y, 0) / us.length;
        return { x, y, lift: 0.3, r: 26 };
      }
      case "ghost": {
        const p = this.h.ctrl.placeAt;
        const k = this.h.ctrl.placing;
        if (!p || !k) return null;
        const s = BUILDINGS[k].size;
        return { x: p.tx + s / 2, y: p.ty + s / 2, lift: 0.6, r: 22 };
      }
      case "harvester": {
        const u = [...w.units.values()].find((v) => v.faction === PLAYER && v.kind === "harvester");
        return u ? { x: u.x, y: u.y, id: u.id } : null;
      }
      case "coal":
        return { x: 13.5, y: 37.5 };
      case "forges": {
        const b = [...w.buildings.values()].find((v) => v.faction === PLAYER && v.kind === "fab-plant");
        return b ? { x: b.tx + 1, y: b.ty + 1, id: b.id, r: 26 } : null;
      }
      case "outpost": {
        const b = this.outpost.map((id) => w.buildings.get(id)).find((v) => !!v);
        return b ? { x: b.tx + BUILDINGS[b.kind].size / 2, y: b.ty + BUILDINGS[b.kind].size / 2, id: b.id, r: 26 } : null;
      }
    }
  }

  // ----------------------------------------------------------- effects ---

  private effect(e: TutEffect): void {
    const { world: w, ctrl } = this.h;
    switch (e) {
      case "glide-starters": {
        // the Panhard and their flag in one frame
        const s = this.starters();
        const f = TUTORIAL_SPOTS.flag;
        if (s.length) this.h.glideTo((s[0]!.x + f.x) / 2, (s[0]!.y + f.y) / 2);
        this.h.zoomTo(40);
        break;
      }
      case "deselect":
        ctrl.clearSelection();
        break;
      case "spawn-patrol":
        this.patrol = this.bringIn("stinger", 2, 9, PATROL_HP);
        break;
      case "close-drawer":
        if (this.h.hudRoot.classList.contains("bh-sheet-open")) this.h.hudRoot.querySelector<HTMLElement>(".bh-handle")?.click();
        break;
      case "fund-forges":
        // (the lesson never stalls on coal spent elsewhere)
        if (!ctrl.view().pending && w.factions[PLAYER].scrap < BUILDINGS["fab-plant"].cost) w.factions[PLAYER].scrap = BUILDINGS["fab-plant"].cost;
        break;
      case "fund-panhard":
        if (w.factions[PLAYER].scrap < UNITS.stinger.cost) w.factions[PLAYER].scrap = UNITS.stinger.cost;
        break;
      case "glide-harvester": {
        const u = [...w.units.values()].find((v) => v.faction === PLAYER && v.kind === "harvester");
        if (u) this.h.glideTo(u.x, u.y);
        break;
      }
      case "spawn-convoy":
        // full-health Fardiers: the guns alone won't finish them before the shells land
        this.convoy = this.bringIn("harvester", 3, 10, UNITS.harvester.hp);
        break;
      case "fill-meter":
        this.filling = true;
        break;
      case "spawn-outpost":
        this.spawnOutpost();
        break;
    }
  }

  /** The middle of our army (else the flag). */
  private armyCentre(): { x: number; y: number } {
    const w = this.h.world;
    const us = this.h.ctrl.armyIds().map((id) => w.units.get(id)).filter((u): u is Unit => !!u);
    if (us.length === 0) return { ...TUTORIAL_SPOTS.flag };
    return { x: us.reduce((s, u) => s + u.x, 0) / us.length, y: us.reduce((s, u) => s + u.y, 0) / us.length };
  }

  /** `n` enemy `kind` appear `dist` tiles off toward the north-east and drive at our army (they stop once seen). */
  private bringIn(kind: UnitKind, n: number, dist: number, hp: number): number[] {
    const w = this.h.world;
    const c = this.armyCentre();
    const dx = FROM.x - c.x;
    const dy = FROM.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const clamp = (v: number) => Math.min(w.width - 3, Math.max(2, v));
    const sx = clamp(c.x + (dx / d) * dist);
    const sy = clamp(c.y + (dy / d) * dist);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = this.freeSpot(kind, sx + ((i % 2) - 0.5) * 1.1, sy + Math.floor(i / 2) * 1.1 + (i % 2) * 0.4);
      const u = spawnUnit(w, kind, ENEMY, p.x, p.y);
      u.hp = Math.min(UNITS[kind].hp, hp);
      u.order = { type: "move", x: c.x + (dx / d) * 1.5 + (i - n / 2) * 0.8, y: c.y + (dy / d) * 1.5 };
      ids.push(u.id);
    }
    return ids;
  }

  private freeSpot(kind: UnitKind, x: number, y: number): { x: number; y: number } {
    const w = this.h.world;
    const mc = moveClassOf(kind);
    for (let r = 0; r <= 4; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const tx = Math.floor(x) + dx;
          const ty = Math.floor(y) + dy;
          if (inBounds(w, tx, ty) && passable(w, tx, ty, mc) && w.occupancy[ty * w.width + tx] === 0) return { x: tx + 0.5, y: ty + 0.5 };
        }
    return { x, y };
  }

  private spawnOutpost(): void {
    const w = this.h.world;
    const t = spawnBuilding(w, "turret", ENEMY, TUTORIAL_SPOTS.turret.x, TUTORIAL_SPOTS.turret.y);
    t.hp = TURRET_HP;
    const d = spawnBuilding(w, "depot", ENEMY, TUTORIAL_SPOTS.depot.x, TUTORIAL_SPOTS.depot.y);
    d.hp = DEPOT_HP;
    this.outpost = [t.id, d.id];
    this.scout(t.tx + 1, t.ty, 5);
    // scouted already: drawn (and tappable) through the fog as remembered
    for (const b of [t, d]) w.fog[PLAYER].known.set(b.id, { id: b.id, kind: b.kind, faction: b.faction, tx: b.tx, ty: b.ty });
    this.h.glideTo(t.tx + 1.5, t.ty + 0.5);
    this.h.zoomTo(36);
  }

  /** No army left mid-lesson (it happens): two fresh Panhard at the GQG. */
  private reinforce(beat: string): void {
    if (!["army", "power", "power-wait", "outpost"].includes(beat) || this.reinforced >= 3) return;
    const w = this.h.world;
    if (this.h.ctrl.armyIds().length > 0) return;
    const hq = hqOf(w, PLAYER);
    if (!hq) return;
    this.reinforced++;
    for (let i = 0; i < 2; i++) {
      const p = this.freeSpot("stinger", hq.tx + 4 + i, hq.ty + 1);
      const u = spawnUnit(w, "stinger", PLAYER, p.x, p.y);
      this.h.pulse(u.x, u.y, 0x7ec1ff, 0.8);
    }
  }

  // ------------------------------------------------------------ ticks ---

  /** After every sim tick: an incoming enemy stops the moment it comes into view. */
  afterTick(): void {
    const w = this.h.world;
    const seen = (ids: number[]) => this.alive(ids).some((u) => isVisible(w, PLAYER, Math.floor(u.x), Math.floor(u.y)));
    const halt = (ids: number[]) => {
      for (const u of this.alive(ids)) {
        u.order = { type: "idle" };
        u.path = null;
        u.pathGoal = null;
        // spotted: the ground round them counts as scouted (a Feu roulant may land there)
        this.scout(u.x, u.y, 4);
      }
      const lead = this.alive(ids)[0];
      if (lead && !this.h.rig.onScreen(lead.x, lead.y, 60)) this.h.glideTo(lead.x, lead.y);
    };
    if (!this.patrolSeen && this.patrol.length && seen(this.patrol)) {
      this.patrolSeen = true;
      halt(this.patrol);
    }
    if (!this.convoySeen && this.convoy.length && seen(this.convoy)) {
      this.convoySeen = true;
      halt(this.convoy);
    }
  }

  /** Mark the ground within `r` tiles of (x, y) as scouted (explored, not in sight). */
  private scout(x: number, y: number, r: number): void {
    const w = this.h.world;
    const vis = w.fog[PLAYER].vis;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.floor(x) + dx;
        const ty = Math.floor(y) + dy;
        if (dx * dx + dy * dy <= r * r && inBounds(w, tx, ty) && vis[ty * w.width + tx] === Vis.Unexplored) vis[ty * w.width + tx] = Vis.Explored;
      }
  }

  /** Ground marks: a gold ring under the flag, a red one round the outpost. */
  drawWorld(g: GroundGfx): void {
    const beat = this.run.beat.id;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    if (!this.ended && (beat === "select" || beat === "move")) {
      const f = TUTORIAL_SPOTS.flag;
      g.lineStyle(2.5, 0xf6dc92, 0.6 + 0.4 * pulse).strokeCircle(f.x, f.y, 1.1 + 0.25 * pulse);
      g.fillStyle(0xf6dc92, 0.12).fillCircle(f.x, f.y, 1.1);
    }
    if (!this.ended && beat === "outpost") {
      const b = this.outpost.map((id) => this.h.world.buildings.get(id)).find((v) => !!v);
      if (b) g.lineStyle(2.5, 0xff6a4a, 0.5 + 0.4 * pulse).strokeCircle(b.tx + 1, b.ty + 0.5, 3.2 + 0.3 * pulse);
    }
  }

  destroy(): void {
    this.restoreEnqueue();
    this.ui.destroy();
    this.h.hudRoot.classList.remove("tuto-on");
  }
}
