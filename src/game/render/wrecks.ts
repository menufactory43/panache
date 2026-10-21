import * as THREE from "three";
import { SALVAGE, TICK_RATE, UNITS } from "../../sim/balance";
import { isInfantry } from "../../sim/infantry";
import { incomeOf } from "../../sim/rules";
import type { Faction, FxEvent, UnitKind, World, Wreck } from "../../sim/types";
import { announce } from "../announce";
import { sfx } from "../audio";
import { discMat, setVariant } from "../three/materials";
import { instance, pileDef, unitDef, unitScale, type ModelInstance } from "../three/models";
import { TEX, type EmitCfg } from "../three/particles";
import type { Label } from "../three/screen";
import { Ease } from "../three/tween";
import { BELLE_EPOQUE } from "../three/theme";
import type { View } from "../three/view";
import { WRECK_SMOKE } from "./belle-fx";
import type { Fx } from "./fx";
import { TOPPLE_SLAM_MS } from "./goliath";

/**
 * Battlefield wrecks (sim: salvage.ts). A destroyed combat unit's own model
 * stays on the field as a charred hull with its turret blown off,
 * smoulders while it is too hot to touch, then glints gold: loot. Aircraft
 * tumble out of the sky first. Picking one up pops a gold "+52" (and a coin
 * blip for your own). Wrecks show only where you have vision; a wreck you
 * saw is remembered (like a building) until you see that it's gone or it
 * would have burnt out anyway.
 *
 * A Goliath leaves no hull: its salvage lies in scrap piles (Wreck.pile)
 * flung out around it as it slams down (render/goliath.ts topples it), and
 * a Gantry destroyed mid-build strews piles of its half-built mech. Both
 * are always seen, so their piles are seen landing even in the fog.
 */

/** Last rendered pose of a unit (EntityRenderer.pose): ground point, body height, hull and turret angles. */
export interface UnitPose {
  gx: number;
  gy: number;
  bh: number;
  face: number;
  aim: number;
  visible: boolean;
}

export interface WreckRendererOpts {
  /** Is tile position (x, y) visible to the local player (always true with fog off)? */
  visibleAt(x: number, y: number): boolean;
  /** Last rendered pose of a (just-killed) unit, if it still has a view. */
  pose(id: number): UnitPose | null;
  player: Faction;
  spectator: boolean;
  /**
   * One-time "what are these?" hint (paced by the HUD's hint queue; tapping it
   * jumps to x, y). `shown` runs once it is actually on screen.
   */
  hint(msg: string, x: number, y: number, shown: () => void): void;
}

interface WreckView {
  id: number;
  kind: UnitKind;
  /** Resting spot (tiles) and ground height there. */
  x: number;
  y: number;
  ground: number;
  m: ModelInstance;
  aura: THREE.Mesh;
  auraMat: THREE.MeshBasicMaterial;
  /** The player has seen it (remembered after that). */
  seen: boolean;
  /** Removed from the sim (kept as a remembered ghost until seen gone). */
  gone: boolean;
  /** Sim tick it burns out (known to everyone: wrecks last SALVAGE.ttl). */
  expireTick: number;
  /** Sim tick it cools enough to salvage. */
  coolTick: number;
  /** Still tumbling out of the sky / sliding to rest. */
  landing: boolean;
  smokeT: number;
  glintT: number;
  phase: number;
}

const GOLD = 0xffd66e;
/** Remembered wrecks beyond the sim cap (ghosts) — keep the scene light. */
const MAX_VIEWS = SALVAGE.maxWrecks + 15;
/** Own salvage within this window (ms) adds up to a "haul". */
const HAUL_WINDOW = 9000;
const HAUL_AT = 400;
const HINT_KEY = "battledrones.hint.salvage";

/** Oily black smoke off a burning hull, greying as it climbs and leaning downwind (Belle Époque: coal-black, and thicker). */
const SMOKE: EmitCfg = BELLE_EPOQUE ? WRECK_SMOKE : {
  tex: TEX.puff, tex2: TEX.puff2, life: [1300, 2100], speed: [0.04, 0.14], up: [0.3, 0.55], size: [0.2, 0.27], grow: [3, 4],
  alpha: [0.62, 0], tints: [0x3a3633, 0x45403b, 0x2f2c2a], end: 0x8a857e, spin: 0.4, rot: 0.4, wind: [0.16, 0.08], fadeIn: 0.12, easeOut: true
};
/** Low flames licking the hull while it's too hot to touch. */
const FLAMES: EmitCfg = {
  tex: TEX.fire, additive: true, life: [220, 480], speed: [0.03, 0.15], up: [0.25, 0.6], size: [0.24, 0.32], grow: [0.4, 0.65],
  alpha: [0.9, 0], tints: [0xffc257, 0xff9a2e, 0xffe39a], end: 0xc2380e, spin: 2.5
};
const EMBERS: EmitCfg = {
  tex: TEX.glow, additive: true, life: [500, 900], speed: [0.1, 0.4], up: [0.6, 1.3], size: [0.06, 0.09], grow: [0.4, 0.6],
  alpha: [1, 0], tints: [0xffd27a], end: 0xff4a10, gravity: -0.8, drag: 0.6
};

const auraGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/** Small deterministic hash → [0, 1) so a wreck looks the same every time it's drawn. */
const rnd = (id: number, k: number) => {
  const x = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export class WreckRenderer {
  private views = new Map<number, WreckView>();
  /** Poses of units that died this frame, consumed when their wreck appears. */
  private deaths = new Map<number, { pose: UnitPose | null; ev: Extract<FxEvent, { type: "death" }> }>();
  /** Goliaths and Gantries that fell this frame (their scrap piles fly out of them), and when (ms after). */
  private scatters: { x: number; y: number; delay: number }[] = [];
  private collected = new Set<number>();
  private haul: { t: number; v: number }[] = [];
  private lastHaul = -1e9;
  private hinted = false;
  private time = 0;
  /** Live "+52" pops: pickups landing together merge into one running total. */
  private floats: { label: Label; x: number; y: number; amount: number; color: string; born: number }[] = [];
  private group = new THREE.Group();

  constructor(
    private v: View,
    private world: World,
    private fx: Fx,
    private opts: WreckRendererOpts
  ) {
    v.scene.add(this.group);
    try {
      // (no tip on a frozen economy — an op's: wrecks pay its side nothing)
      this.hinted = opts.spectator || incomeOf(world, opts.player) <= 0 || localStorage.getItem(HINT_KEY) === "1";
    } catch {
      this.hinted = true;
    }
  }

  // ------------------------------------------------------------ events ---

  /** Feed every sim fx event through here (before the entity views sync). */
  onFx(ev: FxEvent): void {
    // (robot infantry leaves no wreck: its robots topple and sink away, render/entities.ts)
    if (ev.type === "death" && ev.unitKind === "goliath") {
      // (no hull: its piles are thrown out as it slams down)
      const p = this.opts.pose(ev.id);
      this.scatters.push({ x: p?.gx ?? ev.x, y: p?.gy ?? ev.y, delay: TOPPLE_SLAM_MS });
    } else if (ev.type === "death" && ev.buildingKind === "gantry") {
      this.scatters.push({ x: ev.x, y: ev.y, delay: 250 });
    } else if (ev.type === "death" && ev.unitKind && ev.unitKind !== "harvester" && !isInfantry(ev.unitKind)) {
      this.deaths.set(ev.id, { pose: this.opts.pose(ev.id), ev });
    } else if (ev.type === "salvage") {
      this.collected.add(ev.wreckId);
      this.pickedUp(ev);
    }
  }

  private pickedUp(ev: Extract<FxEvent, { type: "salvage" }>): void {
    const mine = ev.faction === this.opts.player && !this.opts.spectator;
    if (!mine && !this.opts.visibleAt(ev.x, ev.y)) return;
    const amount = Math.round(ev.value);
    if (mine) {
      sfx.play("coin", 0.8);
      this.floatText(ev.x, ev.y, amount, "#ffd66e", 19);
      this.trackHaul(amount, ev.x, ev.y);
    } else {
      // spectating: each side's haul in its team colour; playing: the enemy's in muted red
      this.floatText(ev.x, ev.y, amount, this.opts.spectator && ev.faction === "blue" ? "#9fd0ff" : "#ff9a8a", 13);
    }
  }

  /** A burst of own salvage (sweeping a wreck field) is a moment worth calling out. */
  private trackHaul(amount: number, x: number, y: number): void {
    const now = performance.now();
    this.haul.push({ t: now, v: amount });
    while (this.haul.length && now - this.haul[0]!.t > HAUL_WINDOW) this.haul.shift();
    const sum = this.haul.reduce((s, h) => s + h.v, 0);
    if (sum >= HAUL_AT && now - this.lastHaul > 30000) {
      this.lastHaul = now;
      this.haul = [];
      announce({ key: "salvage-haul", text: "BUTIN DE RÉCUPÉRATION", sub: `+${sum} charbon tiré des épaves`, tone: "good", priority: 3, x, y });
    }
  }

  // -------------------------------------------------------------- sync ---

  /** Per frame, after the sim ticks and the unit views sync. */
  sync(dtMs: number): void {
    const w = this.world;
    this.time += dtMs;
    const live = new Set<number>();
    for (const r of w.wrecks) {
      live.add(r.id);
      let v = this.views.get(r.id);
      if (!v) v = this.create(r);
      this.update(v, dtMs);
    }
    // aircraft lost where no tank could ever reach (water, lava, rock): fall and sink
    for (const [id, d] of this.deaths)
      if (!live.has(id) && d.ev.air && d.pose?.visible) this.sink(d.ev.unitKind!, d.ev.faction, d.pose);
    this.deaths.clear();
    this.scatters.length = 0;

    for (const [id, v] of this.views) {
      if (live.has(id)) continue;
      const visibleNow = this.opts.visibleAt(v.x, v.y);
      if (!v.gone) {
        v.gone = true;
        if (!v.seen) {
          this.destroy(v);
          continue;
        }
        if (this.collected.has(id) && visibleNow) {
          this.popAway(v);
          continue;
        }
        if (visibleNow) {
          this.fadeAway(v, 350);
          continue;
        }
        // seen once, out of sight now: remembered as a ghost until re-seen
      } else if (visibleNow || w.tick >= v.expireTick) {
        this.fadeAway(v, 350);
        continue;
      }
      this.update(v, dtMs);
    }
    this.collected.clear();
    // ghosts first, then the oldest, if the field gets too busy
    if (this.views.size > MAX_VIEWS)
      for (const [, v] of this.views) {
        if (this.views.size <= MAX_VIEWS) break;
        if (v.gone) this.destroy(v);
      }
  }

  /** Wrecks the player currently knows about (tile coords), for minimap dots. */
  dots(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (const v of this.views.values()) if (v.seen && !v.landing) out.push({ x: v.x, y: v.y });
    return out;
  }

  // ------------------------------------------------------------ views ---

  private create(r: Wreck): WreckView {
    if (r.pile) return this.createPile(r);
    const air = UNITS[r.kind].domain === "air";
    const m = instance(unitDef(r.kind, r.faction));
    setVariant(m.root, "burnt");
    const ground = this.v.terrain.surfaceAt(r.x, r.y);
    // a slight twist: it slewed as it died; aircraft come down nose-first and broken
    const face = r.facing + (rnd(r.id, 1) - 0.5) * 0.5;
    m.body.rotation.order = "YXZ";
    m.body.rotation.set(air ? -0.25 : (rnd(r.id, 9) - 0.5) * 0.12, -face, air ? (rnd(r.id, 10) - 0.5) * 0.7 : (rnd(r.id, 11) - 0.5) * 0.15);
    m.root.scale.setScalar(unitScale(r.kind) * 0.95);
    m.root.position.set(r.x, ground - (air ? 0.06 : 0.02), r.y);
    for (const ro of m.rotors) ro.obj.visible = rnd(r.id, 12) < 0.5;
    if (m.turret) {
      // turret blown off its ring: tossed a little way, knocked askew
      const a = rnd(r.id, 4) * Math.PI * 2;
      const d = 0.1 + rnd(r.id, 5) * 0.08;
      m.turret.position.x += Math.sin(a) * d;
      m.turret.position.z += Math.cos(a) * d;
      m.turret.position.y -= 0.03;
      m.turret.rotation.set((rnd(r.id, 7) - 0.5) * 0.7, (rnd(r.id, 6) - 0.5) * 2.4, (rnd(r.id, 8) - 0.5) * 0.7);
    }
    const auraMat = discMat(0xffb53d, 0);
    const aura = new THREE.Mesh(auraGeo, auraMat);
    aura.scale.setScalar(1.2);
    aura.position.set(r.x, ground + 0.05, r.y);
    aura.renderOrder = 3;
    this.group.add(m.root, aura);
    const v: WreckView = {
      id: r.id, kind: r.kind, x: r.x, y: r.y, ground, m, aura, auraMat,
      seen: false, gone: false,
      expireTick: this.world.tick + r.ttl, coolTick: this.world.tick + r.hot,
      landing: false, smokeT: 0, glintT: 600 + rnd(r.id, 2) * 1800, phase: rnd(r.id, 3) * Math.PI * 2
    };
    this.views.set(r.id, v);

    // fresh off a death this frame: start from where the unit was drawn
    const death = this.deaths.get(r.id);
    if (death?.pose?.visible) {
      const p = death.pose;
      v.seen = true;
      if (air) this.fall(v, p);
      else if (Math.hypot(p.gx - r.x, p.gy - r.y) > 0.03) this.slide(v, p.gx, p.gy);
    }
    return v;
  }

  /**
   * A scrap pile: its own heap of metal and scrap lumps (not a burnt hull),
   * turned and sized a little differently each. Fresh from a Goliath that
   * fell or a Gantry that blew up this frame, it is flung out of it in an
   * arc and lands in a puff of dust.
   */
  private createPile(r: Wreck): WreckView {
    const m = instance(pileDef(r.faction, r.id));
    const ground = this.v.terrain.surfaceAt(r.x, r.y);
    m.body.rotation.y = rnd(r.id, 1) * Math.PI * 2;
    m.root.scale.setScalar(0.85 + rnd(r.id, 2) * 0.3);
    m.root.position.set(r.x, ground - 0.02, r.y);
    const auraMat = discMat(0xffb53d, 0);
    const aura = new THREE.Mesh(auraGeo, auraMat);
    aura.scale.setScalar(1.4);
    aura.position.set(r.x, ground + 0.05, r.y);
    aura.renderOrder = 3;
    this.group.add(m.root, aura);
    const v: WreckView = {
      id: r.id, kind: r.kind, x: r.x, y: r.y, ground, m, aura, auraMat,
      seen: false, gone: false,
      expireTick: this.world.tick + r.ttl, coolTick: this.world.tick + r.hot,
      landing: false, smokeT: 0, glintT: 600 + rnd(r.id, 3) * 1800, phase: rnd(r.id, 4) * Math.PI * 2
    };
    this.views.set(r.id, v);
    let from: { x: number; y: number; delay: number } | null = null;
    for (const s of this.scatters) if (Math.hypot(s.x - r.x, s.y - r.y) < 5) from = s;
    if (from) {
      // (a Goliath and a Gantry are always seen: so is their scrap flying)
      v.seen = true;
      this.toss(v, from.x, from.y, from.delay + rnd(r.id, 5) * 160);
    }
    return v;
  }

  /** Flung out of a falling Goliath (or a Gantry going up) at (x, y), after `delay` ms: an arc, then a thump of dust. */
  private toss(v: WreckView, x: number, y: number, delay: number): void {
    v.landing = true;
    const root = v.m.root;
    const to = root.position.clone();
    const from = new THREE.Vector3(x, this.v.terrain.surfaceAt(x, y) + 0.9, y);
    const s = root.scale.x;
    root.scale.setScalar(1e-4);
    const spin = (rnd(v.id, 6) - 0.5) * 6;
    const ry = v.m.body.rotation.y;
    this.v.tweens.add({
      dur: 520, delay, owner: v,
      update: (k) => {
        root.scale.setScalar(s * Math.min(1, 0.4 + k * 1.5));
        root.position.lerpVectors(from, to, k);
        root.position.y += Math.sin(k * Math.PI) * 0.9;
        v.m.body.rotation.y = ry + spin * (1 - k);
      },
      done: () => {
        v.landing = false;
        this.fx.dust(v.x, v.y, 2);
        this.fx.kick(v.x, v.y, 1);
      }
    });
  }

  /** An aircraft drops from flying height, tumbling, onto its resting spot. */
  private fall(v: WreckView, p: UnitPose): void {
    v.landing = true;
    const root = v.m.root;
    const spin = (rnd(v.id, 7) < 0.5 ? -1 : 1) * (0.7 + rnd(v.id, 8) * 0.5);
    const from = new THREE.Vector3(p.gx, p.bh, p.gy);
    const to = root.position.clone();
    const ry = v.m.body.rotation.y;
    setVariant(root, "damaged");
    this.v.tweens.add({
      dur: 320, ease: Ease.quadIn, owner: v,
      update: (k) => {
        root.position.lerpVectors(from, to, k);
        v.m.body.rotation.y = ry + spin * (1 - k);
      },
      done: () => {
        v.landing = false;
        setVariant(root, "burnt");
        for (let i = 0; i < 4; i++) this.fx.dust(v.x + (rnd(v.id, 20 + i) - 0.5) * 0.5, v.y + (rnd(v.id, 30 + i) - 0.5) * 0.3);
      }
    });
    root.position.copy(from);
  }

  /** Slid off a building / out of the water onto the nearest ground. */
  private slide(v: WreckView, fromX: number, fromY: number): void {
    v.landing = true;
    const root = v.m.root;
    const to = root.position.clone();
    const from = new THREE.Vector3(fromX, this.v.terrain.surfaceAt(fromX, fromY), fromY);
    root.position.copy(from);
    this.v.tweens.add({
      dur: 260, ease: Ease.quadOut, owner: v,
      update: (k) => root.position.lerpVectors(from, to, k),
      done: () => (v.landing = false)
    });
  }

  /** An aircraft lost over water or lava: it drops and is swallowed. */
  private sink(kind: UnitKind, faction: Faction, p: UnitPose): void {
    const m = instance(unitDef(kind, faction));
    setVariant(m.root, "damaged");
    m.root.scale.setScalar(unitScale(kind));
    m.body.rotation.y = -p.face;
    this.group.add(m.root);
    const from = new THREE.Vector3(p.gx, p.bh, p.gy);
    const to = new THREE.Vector3(p.gx, this.v.terrain.heightAt(p.gx, p.gy) - 0.3, p.gy);
    this.v.tweens.add({
      dur: 520, ease: Ease.quadIn,
      update: (k) => {
        m.root.position.lerpVectors(from, to, k);
        m.body.rotation.x = -k * 0.9;
        m.body.rotation.z = k * 1.1;
      },
      done: () => {
        this.group.remove(m.root);
        const g = this.v.terrain.surfaceAt(p.gx, p.gy);
        // (deep water and lava sit well below the ground; rock and roofs just take the dust)
        if (this.v.terrain.heightAt(p.gx, p.gy) < -0.3) {
          // swallowed by the lava (a gout of fire) or the water (a splash)
          if (this.world.biome === "volcanic") this.fx.flash({ x: p.gx, y: p.gy, h: g + 0.2 }, 1.1, 0xff9a2e, 0.8);
          this.fx.splash(p.gx, p.gy, 7);
        }
        this.fx.dust(p.gx, p.gy, 3);
      }
    });
  }

  private update(v: WreckView, dtMs: number): void {
    const w = this.world;
    const visibleNow = this.opts.visibleAt(v.x, v.y);
    if (visibleNow) v.seen = true;
    const shown = v.seen;
    v.m.root.visible = shown;
    v.aura.visible = shown;
    if (!shown) return;
    if (!this.hinted && visibleNow && !v.gone && w.tick >= v.coolTick)
      this.opts.hint("Les épaves scintillantes contiennent du charbon : passe dessus avec une unité terrestre.", v.x, v.y, () => {
        this.hinted = true;
        try {
          localStorage.setItem(HINT_KEY, "1");
        } catch {
          /* ignore */
        }
      });

    // burns out over its last 10 s: it settles into the ground
    const left = (v.expireTick - w.tick) / TICK_RATE;
    const fade = Math.min(1, Math.max(0, left / 10));
    if (!v.landing) v.m.root.position.y = v.ground - 0.02 - (1 - fade) * 0.4;
    const hot = w.tick < v.coolTick;
    // loot glow: a slow warm breath once it's cool enough to salvage
    v.auraMat.opacity = hot || v.landing ? 0 : (0.22 + 0.1 * Math.sin(this.time / 520 + v.phase)) * fade;
    if (!visibleNow || dtMs <= 0) return;

    // smoulder: fire and thick smoke while hot, a thin wisp for a few seconds after
    const age = (w.tick - (v.coolTick - Math.round(SALVAGE.hot * TICK_RATE))) / TICK_RATE;
    const h = v.ground + 0.36; // (above the hull, or it hides the base of each puff)
    // (Belle Époque: the coal keeps smouldering a while longer)
    if (age < (BELLE_EPOQUE ? 11 : 7)) {
      v.smokeT -= dtMs;
      if (v.smokeT <= 0) {
        v.smokeT = hot ? 200 + rnd(v.id, w.tick) * 120 : 600 + age * 110;
        const sx = v.x + (rnd(v.id, w.tick + 1) - 0.5) * 0.28;
        const sy = v.y + (rnd(v.id, w.tick + 2) - 0.5) * 0.22;
        this.v.particles.emit(SMOKE, sx, sy, h, 1);
        if (hot) {
          this.v.particles.emit(FLAMES, sx, sy, h - 0.08, 1 + Math.round(rnd(v.id, w.tick + 3)));
          if (rnd(v.id, w.tick + 4) < 0.35) this.v.particles.emit(EMBERS, sx, sy, h, 1);
        }
      }
    }
    // the glint that says "loot"
    if (!hot && !v.landing && !v.gone) {
      v.glintT -= dtMs;
      if (v.glintT <= 0) {
        v.glintT = 1700 + rnd(v.id, Math.floor(this.time / 1000)) * 1200;
        const c = new THREE.Color(0xffe9a8);
        this.v.particles.spawn(
          {
            x: v.x + (rnd(v.id, Math.floor(this.time)) - 0.5) * 0.4, y: h + 0.05, z: v.y + (rnd(v.id, Math.floor(this.time) + 9) - 0.5) * 0.35,
            life: 420, tex: TEX.glint, size0: 0.7 * fade, size1: 0.05, alpha0: fade, alpha1: 0.2, spin: 2.4, r: c.r, g: c.g, b: c.b
          },
          true
        );
      }
    }
  }

  /** Scooped up: the hull shrinks into a gold sparkle. */
  private popAway(v: WreckView): void {
    this.views.delete(v.id);
    this.v.tweens.kill(v);
    const g = new THREE.Color(GOLD);
    const h = v.ground + 0.2;
    this.v.particles.spawn({ x: v.x, y: v.ground + 0.08, z: v.y, life: 380, tex: TEX.ring, flat: true, size0: 0.4, size1: 1.4, alpha0: 1, alpha1: 0, r: g.r, g: g.g, b: g.b }, true);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rnd(v.id, 40);
      this.v.particles.spawn(
        { x: v.x, y: h, z: v.y, vx: Math.sin(a) * 1.2, vz: -Math.cos(a) * 1.0, vy: 1.2, life: 420, tex: TEX.glint, size0: 0.45, size1: 0, alpha0: 1, alpha1: 0.4, spin: 3, r: g.r, g: g.g, b: g.b },
        true
      );
    }
    this.group.remove(v.aura);
    v.auraMat.dispose();
    const root = v.m.root;
    const s0 = root.scale.x;
    this.v.tweens.add({
      dur: 220, ease: Ease.quadIn,
      update: (k) => root.scale.setScalar(s0 * (1 - 0.6 * k)),
      done: () => this.group.remove(root)
    });
  }

  private fadeAway(v: WreckView, ms: number): void {
    this.views.delete(v.id);
    this.v.tweens.kill(v);
    const root = v.m.root;
    const y0 = root.position.y;
    const o0 = v.auraMat.opacity;
    this.v.tweens.add({
      dur: ms,
      update: (k) => {
        root.position.y = y0 - k * 0.4;
        v.auraMat.opacity = o0 * (1 - k);
      },
      done: () => this.destroy(v)
    });
  }

  private destroy(v: WreckView): void {
    this.views.delete(v.id);
    this.v.tweens.kill(v);
    this.group.remove(v.m.root, v.aura);
    v.auraMat.dispose();
  }

  /**
   * A gold "+52" that pops up from the wreck and drifts away. Pickups that
   * land together (a tank rolling through a wreck field) add up in one pop.
   */
  private floatText(x: number, y: number, amount: number, color: string, cssPx: number): void {
    const now = performance.now();
    this.floats = this.floats.filter((f) => this.v.screen.has(f.label));
    const near = this.floats.find((f) => f.color === color && now - f.born < 600 && Math.abs(f.x - x) < 1.7 && Math.abs(f.y - y) < 1.4);
    if (near) {
      near.amount += amount;
      near.born = now;
      this.launch(near.label, `+${near.amount}`);
      return;
    }
    const label = this.v.screen.label({ x, y, h: this.v.terrain.surfaceAt(x, y) + 0.5, text: "", size: cssPx, color, stroke: "#1b1306" });
    this.floats.push({ label, x, y, amount, color, born: now });
    this.launch(label, `+${amount}`);
  }

  private launch(l: Label, text: string): void {
    this.v.tweens.kill(l);
    l.text = text;
    l.dy = 0;
    l.alpha = 1;
    l.scale = 0.7;
    this.v.tweens.add({ dur: 170, ease: Ease.backOut, owner: l, update: (k) => (l.scale = 0.7 + 0.3 * k) });
    this.v.tweens.add({
      dur: 900, delay: 520, ease: Ease.quadIn, owner: l,
      update: (k) => {
        l.dy = -l.size * 1.6 * k;
        l.alpha = 1 - k;
      },
      done: () => this.v.screen.remove(l)
    });
  }

  destroyAll(): void {
    this.v.scene.remove(this.group);
  }
}
