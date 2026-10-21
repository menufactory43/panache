import * as THREE from "three";
import { BUILDINGS, POWERS } from "../../sim/balance";
import { POWER_NAMES } from "../../sim/powers";
import type { Calldown, Faction, FxEvent, PowerKind, World } from "../../sim/types";
import { announce } from "../announce";
import { calldownThreatens } from "../awareness";
import { sfx, type SfxName } from "../audio";
import { glowMat } from "../three/materials";
import { BELLE_EPOQUE } from "../three/theme";
import * as BE from "./belle-fx";
import { TEX, type EmitCfg } from "../three/particles";
import { instance, modelMesh, podDef, type ModelInstance } from "../three/models";
import { Ease } from "../three/tween";
import type { View } from "../three/view";
import type { Fx } from "./fx";

/**
 * Everything the commander calldowns look and sound like: public reticles
 * (red for the enemy's, gold/cyan/blue for yours) that shrink to the moment
 * of impact, Barrage shells streaking in from the sky, the EMP shockwave and
 * the crackle on whatever it froze, Drop Pods falling with a flare and dust,
 * and the Sky Hammer's lance from orbit. Also the targeting preview, the
 * warnings, and the announcer lines for the big moments.
 */

export interface PowerRendererOpts {
  player: Faction;
  spectator: boolean;
  /** Is the tile position visible to the local player (or fog off)? */
  visibleAt(x: number, y: number): boolean;
  /** Volume for a sound at tile point (x, y). */
  earshot(x: number, y: number): number;
  /** Rendered body position of an entity (tiles + height), and whether it is drawn. */
  pos(id: number): { x: number; y: number; h: number } | null;
  isShown(id: number): boolean;
  /** Tap-to-jump warning toast and a minimap ping. */
  alert(msg: string, x: number, y: number): void;
  ping(x: number, y: number): void;
}

/** What the player is aiming while a calldown button is armed. */
export interface TargetPreview {
  power: PowerKind;
  /** Aim point in tiles. */
  x: number;
  y: number;
  ok: boolean;
}

const ENEMY = 0xff3b30;
const OWN: Record<PowerKind, number> = { barrage: 0xffc93c, emp: 0x7fe3ff, droppod: 0x6eb0ff, hammer: 0xffd86e };
const EMP_BLUE = 0xbfeaff;
/** Barrage shells appear this many sim ticks before they land, falling from this offset (tiles, height). */
const SHELL_LEAD = 3.2;
const STREAK = { dx: -2.2, dy: -1.2, h: 11 };
/** A pod's visible descent (ticks) and where it falls from. */
const POD_FALL = 7;
const POD_FROM = { dx: 3.2, dy: -2, h: 12 };

const SPARKS: EmitCfg = {
  tex: TEX.spark, additive: true, life: [120, 380], speed: [0.5, 2.4], up: [0.2, 1.5], size: [0.2, 0.28], grow: [0.1, 0.2],
  alpha: [1, 0], tints: [0xbfeaff, 0x7fd4ff, 0xffffff], end: 0x4aa8ff, gravity: -3
};
/** Re-entry flame streaming off a falling pod or shell: hot yellow cooling to red. */
const TRAIL: EmitCfg = {
  tex: TEX.fire, additive: true, life: [220, 420], speed: [0, 0.3], up: [0, 0.2], size: [0.42, 0.6], grow: [0.55, 0.85],
  alpha: [0.85, 0], tints: [0xffc257, 0xff9a2e, 0xffe39a], end: 0xc2380e, spin: 3
};
/** Belle Époque: a lick of flame at a falling capsule-shell's tail. */
const TRAIL_BELLE: EmitCfg = { ...BE.SKY_FLAME, size: [0.3, 0.42] };
const SMOKE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [700, 1200], speed: [0, 0.1], up: [0.05, 0.2], size: [0.25, 0.35], grow: [2, 2.6],
  alpha: [0.45, 0], tints: [0x8a847c, 0x77716a], end: 0xb8b2aa, rot: 0.4, fadeIn: 0.15, easeOut: true
};
/** The Sky Hammer column: a white-hot core in a soft cyan sheath (radius, opacity, colour). */
const LANCE_LAYERS: [number, number, number][] = [[0.3, 1, 0xffffff], [0.72, 0.45, 0xcdeeff], [1.5, 0.16, 0x8fd2ff]];
/** Falling pods leave a puff of flame every this many tiles (and smoke every other one)… */
const STREAK_STEP = 0.3;
/** …and Barrage shells, which leave no smoke, closer together, so the shrinking puffs still join up. */
const SHELL_STEP = 0.18;

/** Belle Époque: where the Obus Méliès falls from (offset in tiles, height), how big it is drawn, and when in the countdown it shows. */
const MELIES_FROM = { dx: -4.2, dy: 1.6, h: 8 };
const MELIES_SCALE = 8;
const MELIES_SHOW = 0.35;
/** The Fée Électricité's arcs: violet-blue. */
const FEE_RING = 0x7a4dff;
/** Feu roulant: each shell's burst rolls on with this many lighter bursts (cosmetic: the damage is the sim's). */
const ROLL_ON = 2;

/** The EMP crackle's scratch arc (5 points), refilled per arc: no per-frame garbage. */
const ARC = Array.from({ length: 5 }, () => ({ x: 0, y: 0 }));

const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0);
const streakGeo = new THREE.BoxGeometry(0.06, 0.06, 1);
const tmpC = new THREE.Color();

export class PowerRenderer {
  private pods = new Map<number, ModelInstance>();
  private landed: ModelInstance[] = [];
  private lances = new Map<number, { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }>();
  /** Belle Époque: the Obus Méliès on its way down, by calldown id, and the distance since its last trail puff. */
  private melies = new Map<number, { mesh: THREE.Mesh; acc: number }>();
  private incoming = new Set<string>();
  /** Barrage shells in the air, positioned from sim time (pauses and speeds with the game). */
  private streaks: { mesh: THREE.Mesh; x: number; y: number; h: number; tick: number; lead: number; acc: number }[] = [];
  /** Distance each falling pod has dropped since its last flame puff (tiles). */
  private podTrail = new Map<number, number>();
  private streakMat = glowMat(0xffe0a0, 1);
  private group = new THREE.Group();
  private time = 0;
  private hammerAnnounced = false;

  constructor(
    private v: View,
    private world: World,
    private fx: Fx,
    private opts: PowerRendererOpts
  ) {
    v.scene.add(this.group);
  }

  private friendly(f: Faction): boolean {
    return f === this.opts.player;
  }

  /**
   * Is the entity drawn as it is now? An enemy building we only remember (its
   * footprint out of sight, or fallen in the fog and still standing) is drawn
   * as last seen (render/entities.ts): a crackle on it would show it stunned,
   * and one that cut off as it died would give that away.
   */
  private seenNow(id: number): boolean {
    if (!this.opts.isShown(id)) return false;
    if (this.world.units.has(id)) return true;
    const b = this.world.buildings.get(id);
    if (!b) return false;
    if (this.friendly(b.faction)) return true;
    const n = BUILDINGS[b.kind].size;
    for (let dy = 0; dy < n; dy++)
      for (let dx = 0; dx < n; dx++) if (this.opts.visibleAt(b.tx + dx + 0.5, b.ty + dy + 0.5)) return true;
    return false;
  }

  /** World units spanning `css` CSS px around a point. */
  private px(x: number, y: number, css: number): number {
    return css * this.v.rig.worldPerPx(x, y);
  }

  private onScreen(x: number, y: number, padTiles = 2): boolean {
    return this.v.rig.onScreen(x, y, padTiles * 40);
  }

  private sound(name: SfxName, x: number, y: number, vol = 1, floor = 0): void {
    sfx.play(name, Math.max(floor, vol * this.opts.earshot(x, y)));
  }

  private shake(x: number, y: number, ms: number, k: number): void {
    if (this.onScreen(x, y, 1)) this.v.rig.shake(ms, k);
  }

  private ground(x: number, y: number): number {
    return this.v.terrain.surfaceAt(x, y);
  }

  // ------------------------------------------------------------- events ---

  onFx(ev: FxEvent): void {
    switch (ev.type) {
      case "calldown":
        this.started(ev);
        break;
      case "calldownImpact":
        this.landed_(ev);
        break;
      case "stun":
        for (const id of ev.ids) {
          const p = this.seenNow(id) ? this.opts.pos(id) : null;
          if (p) this.v.particles.emit(BELLE_EPOQUE ? BE.FEE_SPARKS : SPARKS, p.x, p.y, p.h + 0.2, 6);
        }
        break;
      case "powerOnline":
        if (ev.power !== "hammer") break;
        if (!this.hammerAnnounced && (this.friendly(ev.faction) || this.opts.spectator)) {
          this.hammerAnnounced = true;
          announce({
            key: "sky-hammer-online",
            text: "Obus Méliès opérationnel",
            sub: !this.opts.spectator
              ? "Obus Méliès prêt. Touche son bouton, puis la carte"
              : this.world.survival
                ? "Le défenseur peut tirer l'Obus Méliès" // (the waves have no commander)
                : "Les deux commandants peuvent tirer l'Obus Méliès",
            tone: "epic",
            priority: 1
          });
          sfx.play("ready");
        }
        break;
    }
  }

  private started(ev: Extract<FxEvent, { type: "calldown" }>): void {
    const { x, y } = ev;
    const name = POWER_NAMES[ev.power];
    const ours = this.friendly(ev.faction) && !this.opts.spectator;
    // does it threaten anything of the player's? (then the siren carries off-screen too;
    // the same rule drops a fast game back to 1×, src/game/awareness.ts)
    const threatened = !ours && !this.opts.spectator && calldownThreatens(this.world, this.opts.player, ev.x, ev.y, ev.radius);
    if (ours) sfx.play("uplink", 0.8);
    else this.sound("siren", x, y, 0.9, threatened || ev.power === "hammer" ? 0.5 : 0);
    if (ev.power === "hammer") this.sound("charge", x, y, 0.8, this.opts.spectator ? 0 : 0.3);
    if (ev.power === "droppod") {
      const pod = instance(podDef(ev.faction));
      pod.root.visible = false;
      this.group.add(pod.root);
      this.pods.set(ev.id, pod);
    }
    // (what our strikes destroy is cheered by the callouts: a kill streak named for it, "Direct hit!")
    if (this.friendly(ev.faction)) return;
    if (this.opts.spectator) {
      if (ev.power === "hammer")
        announce({ key: "sky-hammer-inbound", text: "Obus Méliès en approche !", sub: `${ev.faction === "blue" ? "Bleu" : "Rouge"} tire un obus depuis la Lune`, tone: "info", priority: 1, x: ev.x, y: ev.y });
      return;
    }
    // the enemy's: warn, loudly if it threatens anything of ours
    if (ev.power === "hammer") {
      announce({
        key: "enemy-sky-hammer",
        text: "Obus Méliès ennemi en approche !",
        sub: "Sors du cercle rouge",
        tone: "bad",
        priority: 0,
        x: ev.x,
        y: ev.y
      });
      this.opts.ping(ev.x, ev.y);
      return;
    }
    if (!threatened) return;
    this.opts.ping(ev.x, ev.y);
    if (!this.onScreen(x, y, 0)) this.opts.alert(`Frappe ennemie en approche : ${name} !`, ev.x, ev.y);
  }

  /** An expanding ring of light on the ground (`additive` false: a painted ring that keeps a saturated colour on bright ground). */
  private ring(x: number, y: number, tint: number, r0: number, r1: number, ms: number, delay = 0, additive = true): void {
    const go = () => {
      tmpC.setHex(tint);
      this.v.particles.spawn(
        { x, y: this.ground(x, y) + 0.1, z: y, life: ms, tex: TEX.ring, flat: true, easeOut: true, size0: r0 * 2.3, size1: r1 * 2.3, alpha0: 1, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b },
        additive
      );
    };
    if (delay > 0) this.v.tweens.after(delay, go);
    else go();
  }

  private glow(x: number, y: number, h: number, tint: number, s0: number, s1: number, ms: number, alpha = 1, flat = false): void {
    tmpC.setHex(tint);
    this.v.particles.spawn({ x, y: h, z: y, life: ms, tex: TEX.glow, size0: s0, size1: s1, alpha0: alpha, alpha1: 0, r: tmpC.r, g: tmpC.g, b: tmpC.b, flat }, true);
  }

  private landed_(ev: Extract<FxEvent, { type: "calldownImpact" }>): void {
    const { x, y } = ev;
    const g = this.ground(x, y);
    switch (ev.power) {
      case "barrage": {
        if (BELLE_EPOQUE) {
          this.feuRoulant(x, y, g);
          break;
        }
        this.fx.explosion({ type: "explosion", x, y, size: 1.5, air: false, kind: "impact" }, { x, y, h: g + 0.1 });
        this.fx.pulse(x, y, 0xffb35a, 2.2);
        this.fx.sparks({ x, y, h: g + 0.2 }, 6);
        this.sound("shell", x, y, 0.9);
        this.shake(x, y, 150, 0.004);
        break;
      }
      case "emp": {
        if (BELLE_EPOQUE) {
          this.feeElectricite(x, y, g);
          break;
        }
        const R = POWERS.emp.radius;
        // electric blue whatever the ground: a painted ring under a ring of light
        this.ring(x, y, 0x2f8fff, 0.2, R, 420, 0, false);
        this.ring(x, y, EMP_BLUE, 0.2, R * 0.97, 420);
        this.ring(x, y, 0x2f8fff, 0.2, R * 0.75, 420, 90, false);
        this.fx.shock(x, y, R * 0.8, 0x7fd4ff, 0.7, 380);
        this.glow(x, y, g + 0.4, EMP_BLUE, 3, 5, 380, 0.85);
        this.glow(x, y, g + 0.08, 0x4aa8ff, R * 1.2, R * 1.7, 520, 0.5, true);
        this.v.particles.emit({ ...SPARKS, speed: [1, 4], spread: R * 0.6 }, x, y, g + 0.4, 24);
        this.sound("emp", x, y, 1, 0.15);
        this.shake(x, y, 120, 0.003);
        break;
      }
      case "droppod": {
        const pod = this.pods.get(ev.id);
        if (pod) this.group.remove(pod.root);
        this.pods.delete(ev.id);
        this.podTrail.delete(ev.id);
        const open = instance(podDef(ev.faction, true));
        open.root.position.set(x, g, y);
        open.root.rotation.y = Math.random() * Math.PI * 2;
        this.group.add(open.root);
        this.landed.push(open);
        this.v.tweens.add({
          dur: 3000, delay: 9000,
          update: (k) => (open.root.position.y = g - k * 0.3),
          done: () => this.group.remove(open.root)
        });
        if (this.landed.length > 12) {
          const old = this.landed.shift();
          if (old) this.group.remove(old.root);
        }
        // a hard landing: a flash, a ring of thrown dirt, a dust skirt and a little smoke off the hot shell
        this.glow(x, y, g + 0.4, 0xffb35a, 3, 4.5, 380, 0.8);
        this.fx.pulse(x, y, 0xe8d8b0, 2);
        this.fx.shock(x, y, 1, 0xffe2b0, 0.5);
        this.fx.kick(x, y, 9);
        this.fx.debris({ x, y, h: g + 0.2 }, 8);
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          this.fx.dust(x + Math.cos(a) * 0.53, y + Math.sin(a) * 0.4);
        }
        this.v.particles.emit(SMOKE, x, y, g + 0.6, 3);
        if (BELLE_EPOQUE) this.v.particles.emit(BE.COAL_SMOKE, x, y, g + 0.4, 2);
        for (const id of ev.unitIds) {
          const u = this.world.units.get(id);
          if (u && this.friendly(u.faction)) this.fx.pulse(u.x, u.y, 0x7ec1ff, 0.8);
        }
        this.sound("pod", x, y, 1);
        this.shake(x, y, 140, 0.003);
        break;
      }
      case "hammer": {
        if (BELLE_EPOQUE) {
          this.obusMelies(ev.id, x, y, g);
          break;
        }
        const R = POWERS.hammer.radius;
        // the strike itself: a blinding column from orbit (a white-hot core in a soft cyan
        // sheath) that narrows away, over molten ground
        const layers = LANCE_LAYERS.map(([r, o, col]) => {
          const mat = glowMat(col, o);
          const mesh = new THREE.Mesh(beamGeo, mat);
          mesh.position.set(x, g - 0.2, y);
          mesh.scale.set(r, 40, r);
          mesh.renderOrder = 8;
          this.group.add(mesh);
          return { mesh, mat, r, o };
        });
        this.v.tweens.add({
          dur: 650, ease: Ease.quadIn,
          update: (k) => {
            for (const l of layers) {
              l.mat.opacity = l.o * (1 - k);
              l.mesh.scale.x = l.mesh.scale.z = l.r * (1 - k * 0.8);
            }
          },
          done: () => {
            for (const l of layers) {
              this.group.remove(l.mesh);
              l.mat.dispose();
            }
          }
        });
        this.glow(x, y, g + 0.6, 0xffffff, 6, 9, 480, 0.9);
        this.glow(x, y, g + 0.06, 0xffc070, R * 1.3, R * 1.8, 1100, 0.7, true);
        this.fx.shock(x, y, R * 0.9, 0xeaf8ff, 0.9, 520);
        for (const [delay, k, tint] of [[0, 1.15, 0xffffff], [120, 0.85, 0xffd27a], [260, 1.4, 0xffa040]] as const)
          this.ring(x, y, tint, 0.3, R * k, 600, delay);
        this.v.tweens.after(350, () => this.fx.plume(x, y, g + 0.4, 1.7, 8));
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.random();
          const d = i === 0 ? 0 : R * (0.35 + Math.random() * 0.4);
          const px = x + Math.cos(a) * d;
          const py = y + Math.sin(a) * d;
          this.v.tweens.after(i * 70, () =>
            this.fx.explosion({ type: "explosion", x, y, size: i === 0 ? 2.2 : 1, air: false, kind: "unit" }, { x: px, y: py, h: this.ground(px, py) + 0.1 })
          );
        }
        this.sound("hammer", x, y, 1, 0.45);
        if (this.onScreen(x, y, 4)) this.v.rig.shake(520, 0.012);
        break;
      }
    }
  }

  // -------------------------------------------------- Belle Époque powers ---

  /**
   * Feu roulant (Barrage), Belle Époque: each shell bursts in fire, earth and
   * coal smoke, and the burst rolls on away from the guns in lighter bursts.
   */
  private feuRoulant(x: number, y: number, g: number): void {
    const at = (px: number, py: number, size: number) =>
      this.fx.explosion({ type: "explosion", x: px, y: py, size, air: false, kind: "impact" }, { x: px, y: py, h: this.ground(px, py) + 0.1 });
    at(x, y, 1.5);
    this.fx.kick(x, y, 5);
    this.fx.debris({ x, y, h: g + 0.2 }, 5);
    this.fx.sparks({ x, y, h: g + 0.2 }, 6);
    const len = Math.hypot(STREAK.dx, STREAK.dy);
    for (let j = 1; j <= ROLL_ON; j++) {
      const d = 0.5 * j + Math.random() * 0.2;
      const px = x - (STREAK.dx / len) * d + (Math.random() - 0.5) * 0.3;
      const py = y - (STREAK.dy / len) * d + (Math.random() - 0.5) * 0.3;
      this.v.tweens.after(j * 140, () => at(px, py, 0.9 - j * 0.15));
    }
    this.sound("shell", x, y, 0.9);
    this.shake(x, y, 150, 0.004);
  }

  /**
   * La Fée Électricité (EMP), Belle Époque: a dome of violet-blue lightning
   * over the circle (bolts from a crackling ball overhead down to its rim,
   * and arcs leaping round the rim), sparkles everywhere and a violet ring.
   */
  private feeElectricite(x: number, y: number, g: number): void {
    const R = POWERS.emp.radius;
    const top = { x, y, h: g + R * 0.7 };
    this.ring(x, y, FEE_RING, 0.2, R, 520, 0, false);
    this.ring(x, y, 0xd9c4ff, 0.2, R * 0.97, 520);
    this.glow(x, y, top.h, 0xd9c4ff, 2.2, 3.6, 480, 0.9);
    this.glow(x, y, g + 0.08, 0x7a4dff, R * 1.2, R * 1.7, 620, 0.45, true);
    const N = 12;
    const rim: { x: number; y: number; h: number }[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const r = R * (0.88 + Math.random() * 0.12);
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      rim.push({ x: px, y: py, h: this.ground(px, py) + 0.06 });
    }
    rim.forEach((p, i) => {
      this.v.tweens.after(Math.random() * 240, () =>
        this.fx.bolt(top, p, { life: 380 + Math.random() * 220, width: 0.12, minPx: 4.5, tint: BE.ARC_VIOLET, jag: 0.08, reroll: 50, fork: 0.5 })
      );
      const q = rim[(i + 1) % N]!;
      this.v.tweens.after(80 + Math.random() * 300, () =>
        this.fx.bolt({ ...p, h: p.h + 0.05 }, { ...q, h: q.h + 0.05 }, { life: 300 + Math.random() * 200, width: 0.08, minPx: 3.2, tint: 0x8fb0ff, jag: 0.12, reroll: 40, fork: 0.2 })
      );
    });
    this.v.particles.emit({ ...BE.FEE_SPARKS, spread: R * 0.3 }, x, y, top.h, 14);
    this.v.particles.emit({ ...BE.FEE_SPARKS, spread: R * 0.9, up: [0.6, 1.8] }, x, y, g + 0.15, 18);
    this.sound("emp", x, y, 1, 0.15);
    this.shake(x, y, 120, 0.003);
  }

  /** The Obus Méliès on its way (Belle Époque): a huge brass shell streaking down out of the sky, trailing smoke. */
  private drawMelies(c: Calldown, k: number): void {
    let m = this.melies.get(c.id);
    if (k < MELIES_SHOW) {
      if (m) m.mesh.visible = false;
      return;
    }
    const g = this.ground(c.x, c.y);
    const d = 1 - (k - MELIES_SHOW) / (1 - MELIES_SHOW); // 1 → 0 as it comes down
    const px = c.x + MELIES_FROM.dx * d;
    const py = c.y + MELIES_FROM.dy * d;
    const ph = g + 0.4 + MELIES_FROM.h * d;
    if (!m) {
      const mesh = modelMesh(BE.shellGeometry(), false);
      mesh.scale.setScalar(MELIES_SCALE);
      mesh.position.set(px, ph, py);
      this.group.add(mesh);
      m = { mesh, acc: 0 };
      this.melies.set(c.id, m);
    }
    const was = m.mesh.position;
    const moved = Math.hypot(px - was.x, ph - was.y, py - was.z);
    m.mesh.visible = true;
    m.mesh.position.set(px, ph, py);
    m.mesh.lookAt(c.x, g, c.y);
    // thick smoke laid back along its path, a flame at its base
    const len = Math.hypot(MELIES_FROM.dx, MELIES_FROM.dy, MELIES_FROM.h);
    const back = 0.09 * MELIES_SCALE; // (the shell's base, behind its centre)
    m.acc += moved;
    const n = Math.floor(m.acc / 0.4);
    m.acc -= n * 0.4;
    for (let i = 0; i < Math.min(n, 12); i++) {
      const s = back + moved * ((i + 1) / (n + 1));
      this.v.particles.emit(BE.MELIES_TRAIL, px + (MELIES_FROM.dx / len) * s, py + (MELIES_FROM.dy / len) * s, ph + (MELIES_FROM.h / len) * s, 1);
    }
    if (moved > 0) this.v.particles.emit(BE.SKY_FLAME, px + (MELIES_FROM.dx / len) * back, py + (MELIES_FROM.dy / len) * back, ph + (MELIES_FROM.h / len) * back, 1);
  }

  /** The Obus Méliès lands (Belle Époque): a blinding flash, a ring of fire, a storm of blasts, earth thrown out and a black column of smoke. */
  private obusMelies(id: number, x: number, y: number, g: number): void {
    const R = POWERS.hammer.radius;
    const m = this.melies.get(id);
    if (m) {
      this.group.remove(m.mesh);
      this.melies.delete(id);
    }
    this.glow(x, y, g + 0.8, 0xfff4d8, 6.5, 9.5, 520, 0.95);
    this.glow(x, y, g + 0.06, 0xffa040, R * 1.3, R * 1.9, 1300, 0.75, true);
    this.fx.shock(x, y, R * 0.95, 0xffe2b0, 0.9, 560);
    for (const [delay, k, tint] of [[0, 1.15, 0xffe6b0], [120, 0.85, 0xffc060], [260, 1.4, 0xff9a3a]] as const)
      this.ring(x, y, tint, 0.3, R * k, 650, delay);
    this.v.tweens.after(300, () => this.fx.plume(x, y, g + 0.4, 2, 10));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.random();
      const d = i === 0 ? 0 : R * (0.3 + Math.random() * 0.5);
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      this.v.tweens.after(i * 65, () =>
        this.fx.explosion({ type: "explosion", x, y, size: i === 0 ? 2.4 : 1, air: false, kind: "unit" }, { x: px, y: py, h: this.ground(px, py) + 0.1 })
      );
    }
    this.fx.kick(x, y, 10);
    this.fx.debris({ x, y, h: g + 0.3 }, 14);
    // (and, for Méliès, a shower of stars)
    this.v.particles.emit({ ...BE.FIREWORK, speed: [1.5, 3.5], up: [2, 4], life: [700, 1200] }, x, y, g + 0.8, 14);
    this.sound("hammer", x, y, 1, 0.45);
    if (this.onScreen(x, y, 4)) this.v.rig.shake(560, 0.013);
  }

  // ---------------------------------------------------------- per frame ---

  /** Draw reticles, falling pods and shells, stun crackle and the aim preview. */
  sync(dtMs: number, alpha: number, preview: TargetPreview | null): void {
    this.time += dtMs;
    const w = this.world;
    const now = w.tick - 1 + alpha; // fractional sim tick on screen
    const live = new Set<number>();
    for (const c of w.powers.active) {
      live.add(c.id);
      this.drawCalldown(c, now);
    }
    for (const [id, l] of this.lances)
      if (!live.has(id)) {
        this.group.remove(l.mesh);
        l.mat.dispose();
        this.lances.delete(id);
      }
    for (const [id, m] of this.melies)
      if (!live.has(id)) {
        this.group.remove(m.mesh);
        this.melies.delete(id);
      }
    this.flyStreaks(now);
    this.drawStuns(dtMs);
    if (preview) this.drawPreview(preview);
  }

  private drawCalldown(c: Calldown, now: number): void {
    const g = this.v.top;
    const friendly = this.friendly(c.faction);
    const col = friendly ? OWN[c.power] : ENEMY;
    const { x, y } = c;
    const R = c.radius;
    const span = Math.max(1, c.landTick - c.startTick);
    const k = Math.min(1, Math.max(0, (now - c.startTick) / span));
    const blink = 0.5 + 0.5 * Math.sin(this.time * (0.01 + k * 0.02));
    const px = (css: number) => this.px(x, y, css);
    // danger disc, brightening as it closes in
    g.fillStyle(col, 0.07 + 0.1 * k + 0.05 * blink).fillCircle(x, y, R);
    g.lineStyle(2.5, col, 0.95).strokeCircle(x, y, R);
    if (k < 1 && R * (1 - k) > px(3)) g.lineStyle(2, col, 0.75 + 0.25 * blink).strokeCircle(x, y, R * (1 - k));
    // four outward brackets
    const spin = c.power === "hammer" ? this.time * 0.0016 : 0;
    for (let i = 0; i < 4; i++) {
      const a = spin + (i * Math.PI) / 2;
      const r0 = R + px(4);
      const r1 = R + px(14);
      g.lineStyle(3, col, 0.95).lineBetween(x + Math.sin(a) * r0, y - Math.cos(a) * r0, x + Math.sin(a) * r1, y - Math.cos(a) * r1);
    }
    // centre cross
    const cc = Math.min(R * 0.22, px(10));
    g.lineStyle(1.5, col, 0.9).lineBetween(x - cc, y, x + cc, y).lineBetween(x, y - cc, x, y + cc);

    if (c.power === "hammer" && BELLE_EPOQUE) {
      this.drawMelies(c, k);
      g.fillStyle(0xffe2a0, 0.15 + 0.5 * k * blink).fillCircle(x, y, px(4 + 10 * k));
    } else if (c.power === "hammer") {
      // a targeting lance from orbit, thickening as the strike charges
      let l = this.lances.get(c.id);
      if (!l) {
        const mat = glowMat(friendly ? 0xfff2c0 : 0xffb0a0, 0.3);
        const mesh = new THREE.Mesh(beamGeo, mat);
        mesh.renderOrder = 8;
        this.group.add(mesh);
        l = { mesh, mat };
        this.lances.set(c.id, l);
      }
      const r = px(0.6 + 2.8 * k * k);
      l.mesh.position.set(x, this.ground(x, y), y);
      l.mesh.scale.set(r, 40, r);
      l.mat.opacity = 0.25 + 0.55 * k;
      g.fillStyle(0xffffff, 0.15 + 0.5 * k * blink).fillCircle(x, y, px(4 + 10 * k));
    } else if (c.power === "droppod") {
      this.drawPod(c, now, x, y);
    } else if (c.power === "barrage") {
      c.shells.forEach((s, i) => {
        const key = `${c.id}:${i}`;
        const lead = s.tick - now;
        if (lead > 0 && lead <= SHELL_LEAD && !this.incoming.has(key)) {
          this.incoming.add(key);
          this.shellStreak(s.x, s.y, s.tick);
        }
      });
    }
  }

  private drawPod(c: Calldown, now: number, x: number, y: number): void {
    const pod = this.pods.get(c.id);
    if (!pod) return;
    const t = c.landTick - now;
    // the shadow tightens as the pod comes down
    const k = Math.min(1, Math.max(0, 1 - t / (c.landTick - c.startTick)));
    this.v.over.fillStyle(0x000000, 0.12 + 0.3 * k).fillEllipse(x, y, 0.4 + 0.6 * (1 - k), 0.4 + 0.6 * (1 - k));
    if (t > POD_FALL || t < 0) {
      pod.root.visible = false;
      return;
    }
    const e = 1 - t / POD_FALL; // 0 → 1 as it lands
    const ease = e * e;
    const g = this.ground(x, y);
    const px = x + POD_FROM.dx * (1 - ease);
    const py = y + POD_FROM.dy * (1 - ease);
    const ph = g + POD_FROM.h * (1 - ease);
    const was = pod.root.visible ? pod.root.position : null;
    const moved = was ? Math.hypot(px - was.x, ph - was.y, py - was.z) : 0;
    pod.root.visible = true;
    pod.root.position.set(px, ph, py);
    // nose down along its line of flight
    pod.root.lookAt(px - POD_FROM.dx, ph - POD_FROM.h, py - POD_FROM.dy);
    pod.root.rotateX(-Math.PI / 2);
    // re-entry flame and smoke streaming off its tail, a puff per stretch fallen
    let acc = (this.podTrail.get(c.id) ?? 0) + moved;
    const n = Math.floor(acc / STREAK_STEP);
    acc -= n * STREAK_STEP;
    this.podTrail.set(c.id, acc);
    const len = Math.hypot(POD_FROM.dx, POD_FROM.dy, POD_FROM.h);
    for (let i = 0; i < n; i++) {
      const d = (moved * (i + 1)) / (n + 1) / len;
      const tx = px + POD_FROM.dx * (0.05 + d);
      const ty = py + POD_FROM.dy * (0.05 + d);
      if (BELLE_EPOQUE) {
        // the capsule-shell leaves a thick smoke trail, a lick of flame at its tail
        this.v.particles.emit(BE.SKY_TRAIL, tx, ty, ph + 0.9 + POD_FROM.h * d, 1);
        if (i % 3 === 0) this.v.particles.emit(TRAIL_BELLE, tx, ty, ph + 0.8 + POD_FROM.h * d, 1);
        continue;
      }
      this.v.particles.emit(TRAIL, tx, ty, ph + 0.8 + POD_FROM.h * d, 1);
      if (i % 2 === 0) this.v.particles.emit(SMOKE, tx, ty, ph + 0.9 + POD_FROM.h * d, 1);
    }
  }

  /** An incoming barrage shell: a bright streak that drops onto (x, y) at sim tick `tick`. */
  private shellStreak(x: number, y: number, tick: number): void {
    // (Belle Époque: a brass shell you can see, not a streak of light)
    const mesh = BELLE_EPOQUE ? modelMesh(BE.shellGeometry(), false) : new THREE.Mesh(streakGeo, this.streakMat);
    if (BELLE_EPOQUE) mesh.scale.setScalar(2.6);
    else mesh.scale.set(1, 1, 0.9);
    mesh.renderOrder = 8;
    this.group.add(mesh);
    this.streaks.push({ mesh, x, y, h: this.ground(x, y), tick, lead: SHELL_LEAD, acc: 0 });
  }

  private flyStreaks(now: number): void {
    if (this.streaks.length === 0) return;
    this.streaks = this.streaks.filter((s) => {
      const left = s.tick - now;
      if (left <= 0) {
        this.group.remove(s.mesh);
        return false;
      }
      const k = Math.min(1, left / s.lead); // 1 → 0 as it comes down
      const e = k * k;
      const px = s.x + STREAK.dx * e;
      const py = s.y + STREAK.dy * e;
      const ph = s.h + STREAK.h * e;
      const fresh = s.acc === 0 && s.mesh.position.lengthSq() === 0;
      const moved = fresh ? 0 : Math.hypot(px - s.mesh.position.x, ph - s.mesh.position.y, py - s.mesh.position.z);
      s.mesh.position.set(px, ph, py);
      s.mesh.lookAt(s.x, s.h, s.y);
      // a hot head, and a flame trail laid along the path flown since last frame
      tmpC.setHex(BELLE_EPOQUE ? 0xffb050 : 0xfff0c8);
      this.v.particles.spawn({ x: px, y: ph, z: py, life: 45, tex: TEX.glow, size0: BELLE_EPOQUE ? 0.35 : 0.55, size1: BELLE_EPOQUE ? 0.3 : 0.5, alpha0: 0.9, alpha1: 0.6, r: tmpC.r, g: tmpC.g, b: tmpC.b }, true);
      s.acc += moved;
      const n = Math.floor(s.acc / SHELL_STEP);
      s.acc -= n * SHELL_STEP;
      const len = Math.hypot(STREAK.dx, STREAK.dy, STREAK.h);
      for (let i = 0; i < n; i++) {
        const d = moved * ((i + 1) / (n + 1));
        this.v.particles.emit(BELLE_EPOQUE ? BE.SHELL_TRAIL_THICK : TRAIL, px + (STREAK.dx / len) * d, py + (STREAK.dy / len) * d, ph + (STREAK.h / len) * d, 1);
      }
      return true;
    });
    if (this.incoming.size > 200) this.incoming.clear();
  }

  /** Blue crackle on everything an EMP froze (only what the player can see). */
  private drawStuns(dtMs: number): void {
    const st = this.world.powers.stunned;
    if (st.size === 0) return;
    const a = this.v.top;
    for (const [id, until] of st) {
      if (until <= this.world.tick || !this.seenNow(id)) continue;
      const p = this.opts.pos(id);
      if (!p) continue;
      const b = this.world.buildings.get(id);
      // (a Goliath crackles all over: it's twice an HQ's height)
      const giant = !b && !!this.world.units.get(id)?.goliath;
      const r = b ? 0.42 : giant ? 0.85 : 0.26;
      const h = p.h + (b ? 0.3 : giant ? 1.3 : 0.12);
      // a flickering blue haze says "frozen" at a glance
      a.fillStyle(BELLE_EPOQUE ? 0xa98bff : 0x7fd4ff, 0.12 + 0.12 * Math.random()).fillCircle(p.x, p.y, r * 1.35, h);
      if (Math.random() < dtMs / 90) this.v.particles.emit(BELLE_EPOQUE ? BE.FEE_SPARKS : SPARKS, p.x + (Math.random() - 0.5) * r, p.y + (Math.random() - 0.5) * r, h, 1);
      // a jagged arc or two, redrawn every frame: unhaloed, so they glow rather than read as outlined lines
      for (let n = 0; n < 2; n++) {
        if (Math.random() < 0.35) continue;
        let ang = Math.random() * Math.PI * 2;
        for (let i = 0; i < ARC.length; i++) {
          if (i > 0) ang += 0.45 + Math.random() * 0.4;
          const rr = i === 0 ? r : r * (0.55 + Math.random() * 0.6);
          ARC[i]!.x = p.x + Math.cos(ang) * rr;
          ARC[i]!.y = p.y + Math.sin(ang) * rr;
        }
        const tint = BELLE_EPOQUE ? (Math.random() < 0.5 ? 0xe2d4ff : 0xa98bff) : Math.random() < 0.5 ? 0xbfeaff : 0x7fd4ff;
        a.lineStyle(1.6, tint, 0.9, 0).strokePoints(ARC, false, h + (Math.random() - 0.5) * 0.1);
      }
    }
  }

  private drawPreview(p: TargetPreview): void {
    const g = this.v.top;
    const { x, y } = p;
    const R = POWERS[p.power].radius;
    const col = p.ok ? OWN[p.power] : 0x9aa3b0;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.008);
    const px = (css: number) => this.px(x, y, css);
    g.fillStyle(col, p.ok ? 0.12 + 0.06 * pulse : 0.08).fillCircle(x, y, R);
    // dashed rim
    const dashes = 28;
    g.lineStyle(2.5, col, 0.95);
    for (let i = 0; i < dashes; i += 2) {
      const a0 = (i / dashes) * Math.PI * 2 + this.time * 0.0006;
      const a1 = ((i + 1) / dashes) * Math.PI * 2 + this.time * 0.0006;
      g.arc(x, y, R, a0, a1);
    }
    const cc = px(12);
    g.lineStyle(2, col, 1).lineBetween(x - cc, y, x + cc, y).lineBetween(x, y - cc, x, y + cc);
    if (!p.ok) {
      const d = px(9);
      g.lineStyle(3, 0xff5a4a, 1).lineBetween(x - d, y - d, x + d, y + d).lineBetween(x - d, y + d, x + d, y - d);
    }
  }

  /** Reticles for the minimap: tiles, radius, and whose. */
  rings(): { x: number; y: number; r: number; enemy: boolean }[] {
    return this.world.powers.active.map((c) => ({ x: c.x, y: c.y, r: c.radius, enemy: !this.friendly(c.faction) }));
  }

  destroy(): void {
    this.v.scene.remove(this.group);
    this.melies.clear();
    this.pods.clear();
    this.lances.clear();
  }
}
