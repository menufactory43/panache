import * as THREE from "three";
import { OBJECTIVES, TICK_RATE } from "../../sim/balance";
import { CRATE_NAMES, uplinkPay } from "../../sim/objectives";
import type { Crate, CrateReward, Faction, FxEvent, Unit, Uplink, World } from "../../sim/types";
import { buildingCenter, hqOf } from "../../sim/world";
import { announce } from "../announce";
import { sfx, type SfxName } from "../audio";
import { discMat, glowMat } from "../three/materials";
import { chuteGeometry, crateDef, instance, modelMesh, uplinkDef, type ModelInstance } from "../three/models";
import { Ease } from "../three/tween";
import type { View } from "../three/view";
import type { Fx } from "./fx";
import { tr } from "../../lang";

/**
 * How the map objectives look and sound: the Uplink relays (a neutral
 * platform whose dish turns for whoever holds it, a team-coloured capture
 * ring and bar that read through the fog), supply crates (a gold light
 * pillar the moment one is announced, a striped parachute bringing it down
 * out of the sky, a glinting crate with a burn-out timer) and the claim pop.
 * Also the announcer lines, warnings and the minimap marks for both.
 */

export interface ObjectiveRendererOpts {
  player: Faction;
  spectator: boolean;
  /** Is the tile position visible to the local player (or fog off)? */
  visibleAt(x: number, y: number): boolean;
  /** May the local player see this unit (its tile in sight, and not a Sniper Team hidden in the woods)? */
  seesUnit(u: Unit): boolean;
  /** Volume for a sound at tile point (x, y). */
  earshot(x: number, y: number): number;
  /** Tap-to-jump warning toast, a plain toast, a minimap ping, a one-time tip. */
  alert(msg: string, x: number, y: number): void;
  notify(msg: string, tone?: "good" | "bad"): void;
  ping(x: number, y: number): void;
  hint(msg: string, x?: number, y?: number): void;
  /** Does the player have a loaded Condor selected (island relays then show where a tap drops its troops)? */
  dropReady?(): boolean;
  /** Has the local player scouted this tile? (Uncharted only: an unscouted Uplink stays off the minimap.) */
  charted?(x: number, y: number): boolean;
}

const TEAM: Record<Faction, number> = { blue: 0x4fa3ff, red: 0xff5a4a };
const TEAM_CSS: Record<Faction, string> = { blue: "#7ec1ff", red: "#ff8a7a" };
const NEUTRAL = 0xe8c66a;
const GOLD = 0xffd66e;
/** The dark track under the capture bar and a crate's burn-out ring. */
const TRACK = 0x0b0f16;
/** Sim ticks of visible parachute descent before a crate lands. */
const FALL = 26;
/** How high a crate starts its descent (world units). */
const FALL_H = 7;
const HINT_KEY = "battledrones.hint.uplinks";
const ISLAND_HINT_KEY = "battledrones.hint.islands";

const discGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/**
 * The supply-drop light pillar (unit size): one upright quad facing the
 * camera (the rig never turns), painted with a soft beam — a pale-gold core
 * in a gold glow that fades out across its width and up into the sky. It
 * uses the glow discs' textured additive program, so the first drop
 * compiles no new shader mid-battle. One mesh, one draw.
 */
const pillarGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
let beam: THREE.DataTexture | null = null;
function beamTexture(): THREE.DataTexture {
  if (beam) return beam;
  const W = 32;
  const H = 128;
  const px = new Uint8Array(W * H * 4);
  // (sRGB bytes, like the hex colours)
  const gold = [(GOLD >> 16) / 255, ((GOLD >> 8) & 255) / 255, (GOLD & 255) / 255];
  for (let j = 0; j < H; j++) {
    // row 0 is the foot: it melts into the ground over the first ~0.4 tiles, then fades up into the sky
    const t = j / (H - 1);
    const up = Math.pow(1 - t, 2) * Math.min(1, t / 0.03);
    for (let i = 0; i < W; i++) {
      const d = Math.abs((i + 0.5) / W - 0.5) * 2;
      const core = Math.exp(-((d / 0.2) ** 2));
      const glow = 0.6 * Math.exp(-((d / 0.55) ** 2)) * (1 - d);
      // pale gold at the core, deep gold in the glow
      const w = (0.6 * core) / (core + glow + 1e-6);
      const o = (j * W + i) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = 255 * (gold[c]! + (1 - gold[c]!) * w);
      px[o + 3] = 255 * Math.min(1, core + glow) * up;
    }
  }
  beam = new THREE.DataTexture(px, W, H);
  beam.colorSpace = THREE.SRGBColorSpace;
  beam.magFilter = THREE.LinearFilter;
  beam.minFilter = THREE.LinearMipmapLinearFilter;
  beam.generateMipmaps = true;
  beam.needsUpdate = true;
  return beam;
}

interface UplinkView {
  l: Uplink;
  m: ModelInstance;
  glow: THREE.Mesh;
  glowMat: THREE.MeshBasicMaterial;
  h: number;
  spin: number;
  /** Seconds left of the capture flash. */
  flash: number;
  lastAlert: number;
  /** Island relay: was it crewed last frame (to warn when its garrison is gone)? */
  crewed: boolean;
}

interface CrateView {
  c: Crate;
  crate: ModelInstance;
  chute: THREE.Mesh;
  glow: THREE.Mesh;
  glowMat: THREE.MeshBasicMaterial;
  pillar: THREE.Mesh;
  pillarMat: THREE.MeshBasicMaterial;
  h: number;
  landed: boolean;
}

export class ObjectiveRenderer {
  private uplinks: UplinkView[] = [];
  private crates = new Map<number, CrateView>();
  private announced = new Set<number>();
  private group = new THREE.Group();
  private time = 0;
  private hinted = false;
  /** Scratch points for a landing chevron and the fogged crate's diamond. */
  private chev = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  private diamond = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

  constructor(
    private v: View,
    private world: World,
    private fx: Fx,
    private opts: ObjectiveRendererOpts
  ) {
    v.scene.add(this.group);
    for (const l of world.objectives.uplinks) this.uplinks.push(this.makeUplink(l));
  }

  private makeUplink(l: Uplink): UplinkView {
    // (on the surface: a relay on a bridge stands on the deck, not the riverbed under it)
    const h = this.v.terrain.surfaceAt(l.x, l.y);
    const m = instance(uplinkDef());
    m.root.position.set(l.x, h, l.y);
    const glowMat_ = discMat(NEUTRAL, 0);
    const glow = new THREE.Mesh(discGeo, glowMat_);
    glow.position.set(l.x, h + 0.2, l.y);
    glow.scale.setScalar(3.2);
    glow.renderOrder = 3;
    this.group.add(m.root, glow);
    return { l, m, glow, glowMat: glowMat_, h, spin: (l.id * 1.7) % (Math.PI * 2), flash: 0, lastAlert: -1e9, crewed: false };
  }

  private friendly(f: Faction): boolean {
    return f === this.opts.player;
  }

  private px(x: number, y: number, css: number): number {
    return css * this.v.rig.worldPerPx(x, y);
  }

  private onScreen(x: number, y: number): boolean {
    return this.v.rig.onScreen(x, y);
  }

  private sound(name: SfxName, x: number, y: number, vol = 1, floor = 0): void {
    sfx.play(name, Math.max(floor, vol * this.opts.earshot(x, y)));
  }

  /** The player's HQ (or the map centre): which of a drop's two crates is "ours". */
  private home(): { x: number; y: number } {
    const hq = hqOf(this.world, this.opts.player);
    return hq ? buildingCenter(hq) : { x: this.world.width / 2, y: this.world.height / 2 };
  }

  // ------------------------------------------------------------- events ---

  onFx(ev: FxEvent): void {
    switch (ev.type) {
      case "uplinkFlip":
        this.flipped(ev);
        break;
      case "uplinkContest": {
        // the enemy started pushing one of ours back: warn (once per push, throttled)
        if (this.opts.spectator || ev.owner !== this.opts.player || ev.faction === this.opts.player) break;
        const v = this.uplinks.find((u) => u.l.id === ev.id);
        if (!v || this.time - v.lastAlert < 20000) break;
        v.lastAlert = this.time;
        this.opts.ping(ev.x, ev.y);
        if (!this.onScreen(ev.x, ev.y)) {
          sfx.play("alert", 0.7);
          this.opts.alert(tr("Relais attaqué !", "Relay under attack!"), ev.x, ev.y);
        }
        break;
      }
      case "crateIncoming":
        this.incoming(ev);
        break;
      case "crateLanded": {
        const v = this.crates.get(ev.id);
        if (v) this.land(v);
        break;
      }
      case "crateClaimed":
        this.claimed(ev);
        break;
      case "crateExpired": {
        const v = this.crates.get(ev.id);
        if (!v) break;
        this.crates.delete(ev.id);
        this.fx.dust(ev.x, ev.y, 2);
        this.group.remove(v.pillar, v.chute);
        const root = v.crate.root;
        const y0 = root.position.y;
        const g0 = v.glowMat.opacity;
        this.v.tweens.add({
          dur: 700,
          update: (k) => {
            root.position.y = y0 - k * 0.5;
            v.glowMat.opacity = g0 * (1 - k);
          },
          done: () => this.destroyCrate(v)
        });
        break;
      }
    }
  }

  private flipped(ev: Extract<FxEvent, { type: "uplinkFlip" }>): void {
    const v = this.uplinks.find((u) => u.l.id === ev.id);
    const { x, y } = ev;
    if (v) v.flash = 1;
    const col = ev.owner ? TEAM[ev.owner] : NEUTRAL;
    this.fx.pulse(x, y, col, 2.6);
    this.fx.pulse(x, y, 0xffffff, 1.4);
    const me = this.opts.player;
    if (this.opts.spectator) {
      if (ev.owner) {
        this.sound("capture", x, y, 0.8);
        announce({
          key: "uplink-spectate", text: tr(`${ev.owner === "blue" ? "Bleu" : "Rouge"} prend un Relais`, `${ev.owner === "blue" ? "Blue" : "Red"} takes a Relay`),
          sub: tr("Charbon, vision et charge ⚡ tant qu'il le tient", "Coal, vision and ⚡ charge while it holds it"), tone: "info", priority: 3, x: ev.x, y: ev.y
        });
      }
      return;
    }
    if (ev.owner === me) {
      this.sound("capture", x, y, 1, 0.55);
      const l = v?.l;
      announce({
        key: "uplink-captured", text: tr("Relais capturé", "Relay captured"),
        sub: l?.infantryOnly
          ? tr(`+${uplinkPay(l)} charbon/s tant que tes troupes le tiennent · vision · ⚡`, `+${uplinkPay(l)} coal/s while your troops hold it · vision · ⚡`)
          : tr(`+${l ? uplinkPay(l) : OBJECTIVES.uplink.income} charbon/s · vision · charge ⚡`, `+${l ? uplinkPay(l) : OBJECTIVES.uplink.income} coal/s · vision · ⚡ charge`),
        tone: "good", priority: 2, x: ev.x, y: ev.y
      });
    } else if (ev.prev === me) {
      this.sound("uplinkLost", x, y, 1, 0.55);
      this.opts.ping(ev.x, ev.y);
      announce({
        key: "uplink-lost", text: tr("Relais perdu", "Relay lost"),
        sub: v?.l.infantryOnly ? tr("Ramène des troupes en Montgolfière pour le reprendre", "Bring troops by Montgolfier Balloon to retake it") : tr("Renvoie des unités dessus avant qu'ils le prennent", "Send units back onto it before they take it"),
        tone: "bad", priority: 1, x: ev.x, y: ev.y
      });
    } else if (ev.owner) {
      this.sound("uplinkLost", x, y, 0.6, 0.2);
      this.opts.ping(ev.x, ev.y);
      this.opts.notify(tr("📡 L'ennemi a pris un Relais", "📡 The enemy took a Relay"), "bad");
    }
  }

  private incoming(ev: Extract<FxEvent, { type: "crateIncoming" }>): void {
    const c = this.world.objectives.crates.find((k) => k.id === ev.id);
    if (!c) return;
    const h = this.v.terrain.surfaceAt(ev.x, ev.y);
    const crate = instance(crateDef());
    crate.root.visible = false;
    const chute = modelMesh(chuteGeometry(), false);
    chute.visible = false;
    const gm = discMat(GOLD, 0);
    const glow = new THREE.Mesh(discGeo, gm);
    glow.position.set(ev.x, h + 0.08, ev.y);
    glow.scale.setScalar(1.6);
    glow.renderOrder = 3;
    const pm = glowMat(0xffffff, 0.3);
    pm.map = beamTexture();
    const pillar = new THREE.Mesh(pillarGeo, pm);
    pillar.position.set(ev.x, h, ev.y);
    pillar.scale.set(0.9, 14, 1);
    pillar.renderOrder = 8;
    this.group.add(crate.root, chute, glow, pillar);
    this.crates.set(ev.id, { c, crate, chute, glow, glowMat: gm, pillar, pillarMat: pm, h, landed: false });
    if (this.announced.has(ev.drop)) return;
    this.announced.add(ev.drop);
    // one banner per drop, pointing at the crate on our side
    const home = this.home();
    const pair = this.world.objectives.crates.filter((k) => k.drop === ev.drop);
    pair.sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y));
    const at = pair[0] ?? c;
    sfx.play("drop", 0.75);
    announce({
      key: "supply-drop",
      text: ev.reward === "unit" ? tr("Largage rare !", "Rare drop!") : tr("Largage de ravitaillement en approche", "Supply drop inbound"),
      // the first drop spells out the rule; later ones just say what's in it
      sub: ev.drop === 0 ? tr(`${CRATE_NAMES[ev.reward]} · à la première unité sur une caisse`, `${CRATE_NAMES[ev.reward]} · to the first unit on a crate`) : tr(`${CRATE_NAMES[ev.reward]} · arrive dans ${Math.round(OBJECTIVES.drops.warning)} s`, `${CRATE_NAMES[ev.reward]} · arrives in ${Math.round(OBJECTIVES.drops.warning)} s`),
      tone: "epic",
      priority: 1,
      x: at.x,
      y: at.y
    });
    this.opts.ping(at.x, at.y);
  }

  private land(v: CrateView): void {
    if (v.landed) return;
    v.landed = true;
    const { x, y } = v.c;
    v.crate.root.visible = true;
    v.crate.root.position.set(x, v.h, y);
    v.crate.root.rotation.set(0, v.c.id * 0.7, 0);
    this.group.remove(v.pillar);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.fx.dust(x + Math.cos(a) * 0.47, y + Math.sin(a) * 0.34);
    }
    this.fx.pulse(x, y, GOLD, 1.3);
    this.sound("pod", x, y, 0.45);
    // the canopy collapses and slides off on the breeze
    const chute = v.chute;
    chute.visible = true;
    const from = new THREE.Vector3(x, v.h + 0.45, y);
    this.v.tweens.add({
      dur: 900, ease: Ease.quadIn,
      update: (k) => {
        chute.position.set(from.x + k * 0.9, from.y - k * 0.35, from.z - k * 0.2);
        chute.scale.set(1 - 0.3 * k, Math.max(0.05, 1 - k), 1 - 0.3 * k);
        chute.rotation.set(0, 0, k * 1.1);
      },
      done: () => (chute.visible = false)
    });
  }

  private claimed(ev: Extract<FxEvent, { type: "crateClaimed" }>): void {
    const v = this.crates.get(ev.id);
    const { x, y } = ev;
    if (v) {
      this.crates.delete(ev.id);
      this.group.remove(v.pillar, v.chute);
      const root = v.crate.root;
      root.visible = true;
      const g0 = v.glowMat.opacity;
      this.v.tweens.add({
        dur: 320, ease: Ease.quadOut,
        update: (k) => {
          root.scale.setScalar(1 + 0.6 * k);
          root.position.y = v.h + k * 0.6;
          v.glowMat.opacity = g0 * (1 - k);
          v.glow.scale.setScalar(1.6 + 2.4 * k);
        },
        done: () => this.destroyCrate(v)
      });
    }
    const mine = this.friendly(ev.faction) && !this.opts.spectator;
    this.fx.pulse(x, y, mine || this.opts.spectator ? GOLD : 0xff8a7a, 1.8);
    this.sound("crate", x, y, mine ? 1 : 0.6, mine ? 0.35 : 0);
    const label = rewardLabel(ev.reward, ev.amount, ev.scrap);
    const color = this.opts.spectator ? TEAM_CSS[ev.faction] : mine ? "#ffd66e" : "#ff9a8a";
    if (this.opts.visibleAt(ev.x, ev.y)) this.floatLabel(x, y, label, color, mine || this.opts.spectator ? 20 : 15);
    for (const id of ev.unitIds) {
      const u = this.world.units.get(id);
      if (u && this.opts.seesUnit(u)) this.fx.pulse(u.x, u.y, ev.reward === "repair" ? 0x7ef29b : GOLD, 0.9);
    }
    if (this.opts.spectator) return;
    const what = ev.scrap > 0 && ev.reward !== "scrap" ? tr(`${CRATE_NAMES[ev.reward]} (+${Math.round(ev.scrap)} charbon)`, `${CRATE_NAMES[ev.reward]} (+${Math.round(ev.scrap)} coal)`) : CRATE_NAMES[ev.reward];
    if (mine) {
      if (!this.onScreen(x, y)) this.opts.notify(tr(`📦 Caisse récupérée : ${what}`, `📦 Crate recovered: ${what}`), "good");
    } else this.opts.notify(tr(`📦 L'ennemi a pris une caisse : ${CRATE_NAMES[ev.reward]}`, `📦 The enemy took a crate: ${CRATE_NAMES[ev.reward]}`), "bad");
  }

  private destroyCrate(v: CrateView): void {
    this.group.remove(v.crate.root, v.glow, v.chute, v.pillar);
    v.glowMat.dispose();
    v.pillarMat.dispose();
  }

  /** Reward pop: a bold label that bounces up from the crate and drifts away. */
  private floatLabel(x: number, y: number, text: string, color: string, cssPx: number): void {
    const l = this.v.screen.label({ x, y, h: this.v.terrain.surfaceAt(x, y) + 0.7, text, size: cssPx, color, stroke: "#1b1306", scale: 0.6 });
    this.v.tweens.add({ dur: 200, ease: Ease.backOut, update: (k) => (l.scale = 0.6 + 0.4 * k) });
    this.v.tweens.add({
      dur: 1000, delay: 1100, ease: Ease.quadIn,
      update: (k) => {
        l.dy = -cssPx * 1.8 * k;
        l.alpha = 1 - k;
      },
      done: () => this.v.screen.remove(l)
    });
  }

  // ---------------------------------------------------------- per frame ---

  sync(dtMs: number, alpha: number): void {
    this.time += dtMs;
    const dt = dtMs / 1000;
    for (const v of this.uplinks) this.drawUplink(v, dt);
    const now = this.world.tick - 1 + alpha;
    for (const v of this.crates.values()) this.drawCrate(v, now);
    this.firstHint();
  }

  private drawUplink(v: UplinkView, dt: number): void {
    const l = v.l;
    const { x, y } = l;
    const owner = l.owner;
    const col = owner ? TEAM[owner] : NEUTRAL;
    // an island relay with no troops on it is held but silent: dimmed, its dish barely turning
    // (the enemy's only while we can see it)
    // Uncharted: an Uplink nobody has scouted isn't on the map yet (tower, glow and rings would show through the shroud)
    const charted = !this.opts.charted || this.opts.charted(x, y);
    v.m.root.visible = v.glow.visible = charted;
    if (!charted) return;
    const seen = this.opts.visibleAt(l.x, l.y);
    const idle = !!(l.infantryOnly && owner && !l.crewed) && (this.opts.spectator || owner === this.opts.player || seen);
    this.watchCrew(v);
    // the dish: idles on a slow scan, turns for its owner, spins up while being captured
    const rate = l.pushing ? 2.6 : owner ? (idle ? 0.15 : 0.7) : 0;
    v.spin = rate > 0 ? v.spin + rate * dt : Math.sin(this.time * 0.0004 + l.id) * 0.9;
    if (v.m.turret) v.m.turret.rotation.y = -v.spin;
    v.flash = Math.max(0, v.flash - dt * 1.2);
    const breathe = 0.5 + 0.5 * Math.sin(this.time * 0.003 + l.id);
    v.glowMat.color.setHex(col);
    v.glowMat.opacity = owner && !idle ? 0.28 + 0.14 * breathe + 0.5 * v.flash : 0.08 + 0.4 * v.flash;
    v.glow.scale.setScalar(3.2 + v.flash * 2);

    const g = this.v.over;
    const k = seen ? 1 : 0.7;
    const R = OBJECTIVES.uplink.radius;
    // the capture zone: a dashed ring in the owner's colour, turning while contested
    // (an island relay, infantry only: long dashes with a dotted inner ring)
    const dashes = l.infantryOnly ? 12 : 28;
    const turn = l.pushing || l.contested ? this.time * 0.0009 : 0;
    g.lineStyle(owner ? 2.2 : 1.6, col, (owner ? (idle ? 0.45 : 0.75) : 0.55) * k);
    for (let i = 0; i < dashes; i += 2) {
      const a0 = (i / dashes) * Math.PI * 2 + turn;
      g.arc(x, y, R, a0, a0 + (Math.PI * 2) / dashes);
    }
    if (l.infantryOnly) {
      g.fillStyle(col, (owner ? 0.7 : 0.5) * k);
      const dot = this.px(x, y, 1.6);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2 - turn;
        g.fillCircle(x + Math.cos(a) * (R - 0.3), y + Math.sin(a) * (R - 0.3), dot);
      }
    }
    if (owner && seen && !idle) g.fillStyle(col, 0.05 + 0.03 * breathe).fillCircle(x, y, R);
    // a loaded Condor selected: gold chevrons close in on every island relay its troops could take
    if (l.infantryOnly && !(owner === this.opts.player && l.crewed) && this.opts.dropReady?.()) this.dropMarks(x, y, R);
    // the capture bar: a ring around the platform, filled toward whoever is winning it,
    // on a dark track notched into quarters like the health bars' segments
    const ar = 1.38;
    const p = l.progress / 100;
    const bh = v.h + 0.2;
    g.lineStyle(8, TRACK, 0.62 * k, 0).strokeCircle(x, y, ar, bh);
    const a0 = -Math.PI / 2;
    const a1 = a0 + Math.PI * 2 * Math.abs(p);
    if (Math.abs(p) > 0.001) g.lineStyle(5, p > 0 ? TEAM.blue : TEAM.red, 0.95 * k, 0).arc(x, y, ar, a0, a1, bh + 0.005);
    const notch = this.px(x, y, 4.5);
    g.lineStyle(1.5, TRACK, 0.8 * k, 0);
    for (let i = 0; i < 4; i++) {
      const a = a0 + (i * Math.PI) / 2;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      g.lineBetween(x + cx * (ar - notch), y + cy * (ar - notch), x + cx * (ar + notch), y + cy * (ar + notch), bh + 0.01);
    }
    if (Math.abs(p) > 0.001 && Math.abs(p) < 0.999) {
      // a bright tip on the leading edge, pulsing while it moves
      const tip = l.pushing ? 4.5 + 1.5 * Math.sin(this.time * 0.02) : 3.5;
      g.fillStyle(0xffffff, (l.pushing ? 0.95 : 0.7) * k).fillCircle(x + Math.cos(a1) * ar, y + Math.sin(a1) * ar, this.px(x, y, tip), bh + 0.015);
    }
    if (l.contested) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.012);
      g.lineStyle(3, 0xffa040, (0.4 + 0.5 * pulse) * k).strokeCircle(x, y, ar + this.px(x, y, 8), bh);
    }
    if (v.flash > 0) g.lineStyle(5, 0xffffff, v.flash * 0.8, 0.5).strokeCircle(x, y, R * (1.15 - 0.15 * v.flash));
  }

  /** Pulsing gold chevrons round an island relay: "tap here to drop your troops". */
  private dropMarks(x: number, y: number, R: number): void {
    const g = this.v.over;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.008);
    g.lineStyle(3, GOLD, 0.6 + 0.35 * pulse);
    const ch = this.chev;
    const px = (css: number) => this.px(x, y, css);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const d0 = R + px(3 + 4 * pulse);
      const d1 = d0 + px(9);
      const s = px(8);
      ch[0]!.x = x + ux * d1 - uy * s;
      ch[0]!.y = y + uy * d1 + ux * s;
      ch[1]!.x = x + ux * d0;
      ch[1]!.y = y + uy * d0;
      ch[2]!.x = x + ux * d1 + uy * s;
      ch[2]!.y = y + uy * d1 - ux * s;
      g.strokePoints(ch);
    }
  }

  /** Our island relay just lost its last trooper: it stops paying, so say so (throttled). */
  private watchCrew(v: UplinkView): void {
    const l = v.l;
    if (!l.infantryOnly) return;
    const crewed = !!l.crewed && l.owner === this.opts.player;
    if (v.crewed && !crewed && l.owner === this.opts.player && !this.opts.spectator && this.time - v.lastAlert > 20000) {
      v.lastAlert = this.time;
      this.opts.ping(l.x, l.y);
      this.opts.alert(tr("📡 Relais sans troupes : rien ne rentre tant qu'elles n'ont pas atterri", "📡 Relay without troops: nothing comes in until they've landed"), l.x, l.y);
    }
    v.crewed = crewed;
  }

  private drawCrate(v: CrateView, now: number): void {
    const c = v.c;
    const { x, y } = c;
    const g = this.v.over;
    const left = c.landTick - now;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.008);
    const px = (css: number) => this.px(x, y, css);
    if (!v.landed && left <= 0) this.land(v);
    if (!v.landed) {
      // announced: a gold landing marker and a light pillar, both through the fog
      const k = Math.min(1, Math.max(0, 1 - left / (c.landTick - c.announcedTick)));
      const r = 0.95 - 0.25 * k;
      g.fillStyle(GOLD, 0.08 + 0.08 * pulse).fillCircle(x, y, r);
      g.lineStyle(2.5, GOLD, 0.65 + 0.3 * pulse).strokeCircle(x, y, r);
      g.lineStyle(1.5, GOLD, 0.5).strokeCircle(x, y, r * (1.55 - 0.3 * pulse));
      // four chevrons closing in on the landing spot
      g.lineStyle(3, GOLD, 0.95);
      const ch = this.chev;
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        const d0 = r + px(5 + 3 * pulse);
        const d1 = d0 + px(8);
        const s = px(7);
        ch[0]!.x = x + ux * d1 - uy * s;
        ch[0]!.y = y + uy * d1 + ux * s;
        ch[1]!.x = x + ux * d0;
        ch[1]!.y = y + uy * d0;
        ch[2]!.x = x + ux * d1 + uy * s;
        ch[2]!.y = y + uy * d1 - ux * s;
        g.strokePoints(ch);
      }
      v.pillarMat.opacity = 0.6 + 0.25 * pulse;
      // the last couple of seconds: it comes down under a striped canopy
      if (left <= FALL) {
        const e = Math.min(1, Math.max(0, 1 - left / FALL));
        const hgt = (1 - e) * (1 - e * 0.35);
        const sway = Math.sin(this.time * 0.004 + c.id) * 0.2 * hgt;
        const ch = v.h + FALL_H * hgt;
        // ground shadow tightens as it nears
        g.fillStyle(0x000000, 0.12 + 0.3 * e).fillEllipse(x + 0.1, y + 0.1, 0.5 + 0.8 * hgt, 0.5 + 0.8 * hgt);
        const root = v.crate.root;
        root.visible = true;
        root.position.set(x + sway * 0.4, ch, y);
        root.rotation.set(sway * 0.4, c.id * 0.7, sway * 0.3);
        v.chute.visible = true;
        v.chute.position.set(x + sway * 0.4, ch + 0.42, y);
        v.chute.rotation.set(sway * 0.3, 0, sway * 0.5);
        v.chute.scale.setScalar(1);
      }
      return;
    }
    // landed: a warm glow, a blinking beacon and a burn-out ring
    const ttl = Math.min(1, Math.max(0, (c.expireTick - now) / (c.expireTick - c.landTick)));
    const hurry = ttl < 10 / OBJECTIVES.drops.ttl;
    const blink = hurry ? 0.5 + 0.5 * Math.sin(this.time * 0.02) : pulse;
    v.glowMat.opacity = 0.32 + 0.25 * blink;
    v.glow.scale.setScalar(1.5 + 0.3 * blink);
    const seen = this.opts.visibleAt(c.x, c.y);
    const rr = 0.78;
    g.lineStyle(6, TRACK, 0.6, 0).strokeCircle(x, y, rr);
    g.lineStyle(3.5, hurry ? 0xff7a4a : GOLD, 0.95, 0).arc(x, y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ttl);
    if (!seen) {
      // out of sight: a gold diamond marks it through the fog
      const d = px(8 + 2 * blink);
      const pts = this.diamond;
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        pts[i]!.x = x + Math.sin(a) * d;
        pts[i]!.y = y - Math.cos(a) * d;
      }
      g.fillStyle(GOLD, 0.85).fillPoints(pts, v.h + 0.6);
      g.lineStyle(1.5, 0x1b1306, 0.9, 0).strokePoints(pts, true, v.h + 0.6);
    }
  }

  /** One-time tip the first time a match has Uplinks (and the first time it has island ones). */
  private firstHint(): void {
    const islands = this.uplinks.some((u) => u.l.infantryOnly);
    // at 0:45: after the opening's own tips, before the first relay usually falls and the first drop
    // (on an island map at 0:04: taking them is the whole opening)
    if (this.hinted || this.opts.spectator || this.uplinks.length === 0 || this.world.tick < (islands ? 4 : 45) * TICK_RATE) return;
    this.hinted = true;
    try {
      const key = islands ? ISLAND_HINT_KEY : HINT_KEY;
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return;
    }
    if (islands) {
      const c = [...this.world.units.values()].find((u) => u.faction === this.opts.player && u.kind === "condor");
      this.opts.hint(
        tr("📡 Relais insulaires : seules les troupes les prennent, et ils rapportent tant qu'elles les tiennent. Touche ta Montgolfière, puis une île.", "📡 Island Relays: only troops can take them, and they pay as long as troops hold them. Tap your Montgolfier Balloon, then an island."),
        c?.x, c?.y
      );
      return;
    }
    const home = this.home();
    const near = [...this.uplinks].sort(
      (a, b) => Math.hypot(a.l.x - home.x, a.l.y - home.y) - Math.hypot(b.l.x - home.x, b.l.y - home.y)
    )[0]!;
    // (Uncharted: no pointing at one nobody has scouted)
    if (this.opts.charted && !this.opts.charted(near.l.x, near.l.y))
      return this.opts.hint(tr("Gare des unités sur un 📡 Relais pour le prendre : charbon, vision, charge ⚡. Explore pour les trouver.", "Park units on a 📡 Relay to take it: coal, vision, ⚡ charge. Explore to find them."));
    this.opts.hint(tr("Gare des unités sur un 📡 Relais pour le prendre : charbon, vision, charge ⚡. Touche pour voir.", "Park units on a 📡 Relay to take it: coal, vision, ⚡ charge. Tap to look."), near.l.x, near.l.y);
  }

  // ------------------------------------------------------------ minimap ---

  /** Uplink diamonds and blinking crate marks, drawn on the HUD minimap (k = px per tile). */
  minimap(ctx: CanvasRenderingContext2D, k: number): void {
    const t = this.time;
    for (const l of this.world.objectives.uplinks) {
      if (this.opts.charted && !this.opts.charted(l.x, l.y)) continue;
      const x = l.x * k;
      const y = l.y * k;
      const d = 7;
      ctx.beginPath();
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
      ctx.fillStyle = l.owner === "blue" ? "#4fa3ff" : l.owner === "red" ? "#ff5a4a" : "#6b6450";
      // held, but no troops on it (the enemy's only while we can see it)
      if (l.infantryOnly && l.owner && !l.crewed && (this.opts.spectator || l.owner === this.opts.player || this.opts.visibleAt(l.x, l.y)))
        ctx.globalAlpha = 0.4;
      ctx.fill();
      ctx.globalAlpha = 1;
      const busy = l.pushing || l.contested;
      ctx.lineWidth = busy ? 2.5 : 1.6;
      ctx.strokeStyle = busy && Math.sin(t * 0.012) > 0 ? "#ffa040" : "#f4ecd8";
      ctx.stroke();
    }
    const blink = Math.sin(t * 0.01) > -0.2;
    for (const c of this.world.objectives.crates) {
      const x = c.x * k;
      const y = c.y * k;
      if (this.world.tick < c.landTick) {
        ctx.strokeStyle = blink ? "#ffd66e" : "rgba(255,214,110,0.4)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.stroke();
      } else if (blink) {
        ctx.fillStyle = "#ffd66e";
        ctx.strokeStyle = "#1b1306";
        ctx.lineWidth = 1.5;
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.strokeRect(x - 4, y - 4, 8, 8);
      }
    }
  }

  destroy(): void {
    for (const v of this.crates.values()) this.destroyCrate(v);
    this.crates.clear();
    this.v.scene.remove(this.group);
  }
}

/** The pop text for a claimed crate. */
export function rewardLabel(reward: CrateReward, amount: number, scrap: number): string {
  const extra = scrap > 0 && reward !== "scrap" ? `  +${Math.round(scrap)}` : "";
  switch (reward) {
    case "scrap":
      return `+${Math.round(scrap)}`;
    case "veterans":
      return amount > 0 ? tr(`VÉTÉRANS ×${amount}`, `VETERANS ×${amount}`) : `+${Math.round(scrap)}`;
    case "repair":
      return amount > 0 ? tr("RÉPARÉ", "REPAIRED") : `+${Math.round(scrap)}`;
    case "charge":
      return amount > 0 ? `+${amount} ⚡${extra}` : `+${Math.round(scrap)}`;
    case "unit":
      return tr("HYDROGLISSEUR OFFERT !", "HYDROGLIDER FREE!");
  }
}
