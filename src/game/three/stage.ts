import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Biome } from "../../sim/types";
import { CameraRig } from "./camera";
import { GroundGfx } from "./ground-gfx";
import { SquadRig } from "./infantry";
import { discMat, glowMat, modelMat, setFogLook, type FogLook } from "./materials";
import { ScreenLayer } from "./screen";
import { BELLE_EPOQUE } from "./theme";

/**
 * The WebGL stage: renderer, scene, sun and sky light per biome, the camera
 * rig, the 2D overlay and a full-screen flash. The sun's shadow frustum
 * follows the camera so shadows stay sharp wherever you look.
 *
 * Light is mostly the sun, so models read with lit tops and shaded flanks
 * and their shadows ground them; a hemisphere light (sky above, the biome's
 * sunlit ground bouncing back up at the flanks) and a little studio
 * environment (reflections on metal and water) fill in.
 */

interface Look {
  /** The void the skirt past the map's edge fades into: a deep shade of the biome's ground, so the land recedes rather than ends in night. */
  bg: number;
  sky: number;
  ground: number;
  hemi: number;
  sun: number;
  sunI: number;
  exposure: number;
  fog: FogLook;
}

const LOOKS: Record<Biome, Look> = {
  temperate: {
    bg: 0x0b100c, sky: 0xc6d8ff, ground: 0x8a8a6a, hemi: 1.45, sun: 0xfff0d8, sunI: 3.7, exposure: 1.0,
    fog: { shroud: 0x0b1219, wisp: 0x1c2a35, memory: [0.86, 0.96, 1.12], cloud: [1, 0.92, 0.8] }
  },
  desert: {
    bg: 0x15110b, sky: 0xdde8ff, ground: 0xb09060, hemi: 1.4, sun: 0xffe6bf, sunI: 3.8, exposure: 0.98,
    fog: { shroud: 0x16130f, wisp: 0x342e27, memory: [1.06, 0.97, 0.84], cloud: [1, 0.9, 0.78] }
  },
  arctic: {
    bg: 0x10161e, sky: 0xd8e8ff, ground: 0xa8b4c4, hemi: 1.35, sun: 0xeef4ff, sunI: 3.25, exposure: 0.95,
    fog: { shroud: 0x0c1420, wisp: 0x21334a, memory: [0.88, 0.97, 1.14], cloud: [1, 0.9, 0.72] }
  },
  volcanic: {
    bg: 0x120b0a, sky: 0xb0a0a8, ground: 0x6a3a24, hemi: 1.5, sun: 0xffd2b0, sunI: 3.7, exposure: 1.05,
    fog: { shroud: 0x141012, wisp: 0x302727, memory: [1.1, 0.94, 0.86], cloud: [1, 1, 1] }
  },
  // high noon over the reef: a white-gold sun, cool sea-glass bounce light, a night-ocean shroud
  tropical: {
    bg: 0x05202b, sky: 0xc4ecff, ground: 0x9cc4b0, hemi: 1.5, sun: 0xfff6e2, sunI: 3.9, exposure: 0.95,
    fog: { shroud: 0x061a20, wisp: 0x15363c, memory: [0.84, 1.0, 1.1], cloud: [1, 0.93, 0.8] }
  }
};

/**
 * One of each look that may first turn up mid-battle, for precompile: a squad
 * of robots (a skinned mesh, and its shadow), tracers and beams (additive and
 * blended glow), a light pool (glow disc), a placement ghost, and marks on
 * the ground of each kind (selection and combat rings, calldown reticles) —
 * at (x, y), far under the map, drawn even there (no culling, the marks all
 * but clear) but hidden by the ground. Drawn, not just compiled: a driver
 * may set up the rest of what a draw needs the first time it's made.
 */
function standIns(rig: CameraRig, x: number, y: number): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const robots = new SquadRig("trooper", "blue");
  robots.root.position.set(x, -20, y);
  const quad = new THREE.PlaneGeometry(0.5, 0.5);
  if (!standMats) {
    const blended = glowMat(0xffffff);
    blended.blending = THREE.NormalBlending;
    standMats = [glowMat(0xffffff), blended, discMat(0xffffff), modelMat("ghostOk")];
  }
  group.add(robots.root);
  for (const m of standMats) {
    const mesh = new THREE.Mesh(quad, m);
    mesh.position.set(x, -20, y);
    group.add(mesh);
  }
  const marks = [{ fog: true }, {}, { onTop: true }].map((o) => new GroundGfx(rig, () => -20, o));
  for (const g of marks) {
    g.lineStyle(2, 0xffffff, 0.004).strokeCircle(x, y, 0.3);
    g.fillStyle(0xffffff, 0.004).fillCircle(x, y, 0.1);
    g.flush();
    group.add(g.mesh);
  }
  group.traverse((o) => (o.frustumCulled = false));
  return {
    group,
    dispose: () => {
      robots.dispose();
      quad.dispose();
      for (const g of marks) g.dispose();
    }
  };
}
/**
 * The stand-ins' materials, kept: a shader program goes when the last material
 * using it does, and the effects make and drop theirs (a beam's, say) as they go.
 */
let standMats: THREE.Material[] | null = null;

/** Is this WebGL context rasterising on the CPU (SwiftShader, llvmpipe…)? */
function isSoftwareGl(r: THREE.WebGLRenderer): boolean {
  try {
    const gl = r.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch {
    return false;
  }
}

/**
 * Direction the sunlight comes FROM: north-west (the painted art's upper-left
 * light), ~48° up — low enough that units cast a shadow you can see at phone size.
 */
export const SUN_DIR = new THREE.Vector3(-0.62, 0.92, -0.55).normalize();

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig = new CameraRig();
  readonly screen: ScreenLayer;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private flashEl: HTMLDivElement;
  private shadowHalf = 0;
  /** Adaptive resolution: the 3D view's current pixel ratio and the controller's state. */
  private ratio: number;
  private ema = 16;
  private slowFor = 0;
  private slowFrames = 0;
  private fastFor = 0;
  private settle = 0;
  /** No GPU (Chrome's software fallback): start at the cheapest look. */
  readonly software: boolean;

  constructor(private parent: HTMLElement, public dpr: number) {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", alpha: false });
    this.ratio = dpr;
    r.setPixelRatio(dpr);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.domElement.className = "view3d";
    // Belle Époque: an old-photograph warmth over the whole battlefield
    if (BELLE_EPOQUE) r.domElement.style.filter = "sepia(0.32) saturate(0.92) contrast(1.04)";
    parent.appendChild(r.domElement);
    this.renderer = r;
    this.screen = new ScreenLayer(parent, this.rig);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.4);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.castShadow = true;
    // phones get a lighter shadow map; desktops a crisper one
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const size = coarse ? 1024 : 2048;
    sun.shadow.mapSize.set(size, size);
    // soft edges for free: the same 5 PCF taps, spread over ~2 texels of the 1024 map (2.5 of the
    // 2048: spread wider, five taps show as a crawling dither at 1x DPR)
    sun.shadow.radius = size > 1024 ? 2.5 : 2;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    pmrem.dispose();

    this.software = isSoftwareGl(r);
    if (this.software) {
      this.ratio = Math.min(1, dpr);
      r.setPixelRatio(this.ratio);
      r.shadowMap.enabled = false;
      sun.castShadow = false;
    }

    this.flashEl = document.createElement("div");
    this.flashEl.className = "screenflash";
    Object.assign(this.flashEl.style, {
      position: "absolute", inset: "0", pointerEvents: "none", opacity: "0", background: "#fff"
    });
    parent.appendChild(this.flashEl);
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setBiome(b: Biome): void {
    const l = LOOKS[b];
    this.scene.background = new THREE.Color(l.bg);
    this.hemi.color.setHex(l.sky);
    this.hemi.groundColor.setHex(l.ground);
    this.hemi.intensity = l.hemi;
    this.sun.color.setHex(l.sun);
    this.sun.intensity = l.sunI;
    this.renderer.toneMappingExposure = l.exposure;
    setFogLook(l.fog);
  }

  resize(): void {
    const w = this.parent.clientWidth || window.innerWidth;
    const h = this.parent.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h);
    this.screen.resize(w, h, this.dpr);
  }

  /**
   * Compile every shader the battle will need now (during loading), not
   * mid-battle: the scene as it is, plus stand-ins for the looks that only
   * turn up later (standIns), drawn once out of sight under the map so their
   * shadow passes compile too. Then every program is put to use: a driver
   * may only finish linking one when it is first used, and a mark drawn on
   * the ground for the first time (say) would stall the frame it appears.
   */
  precompile(): void {
    const stand = standIns(this.rig, this.rig.x, this.rig.y);
    this.scene.add(stand.group);
    this.renderer.compile(this.scene, this.rig.camera);
    this.render();
    this.scene.remove(stand.group);
    stand.dispose();
    for (const p of this.renderer.info.programs ?? []) p.getUniforms();
  }

  /**
   * Adaptive resolution. Fed every frame's real interval: when the view runs
   * slow for a while, the 3D canvas renders fewer pixels (fill cost scales
   * with the pixel ratio squared, so one proportional step usually lands
   * near 30 fps); as a last resort, shadows go. When there's headroom again
   * the resolution creeps back up. The HUD and overlay stay crisp.
   */
  adapt(frameMs: number): void {
    const ms = Math.min(1500, Math.max(1, frameMs));
    this.ema += (ms - this.ema) * 0.2;
    this.settle = Math.max(0, this.settle - ms);
    if (this.settle > 0) return;
    const slow = this.ema > 42;
    this.slowFor = slow ? this.slowFor + ms : 0;
    this.slowFrames = slow ? this.slowFrames + 1 : 0;
    this.fastFor = this.ema < 22 ? this.fastFor + ms : 0;
    // (a crawl acts within a few frames; a mild slump only once it has lasted)
    if (this.slowFor > 1200 || (this.ema > 150 && this.slowFrames >= 3)) {
      this.slowFor = 0;
      this.slowFrames = 0;
      this.degrade();
      this.settle = Math.min(1500, this.ema * 2);
    } else if (this.fastFor > 6000 && this.ratio < this.dpr) {
      this.fastFor = 0;
      this.setRatio(Math.min(this.dpr, this.ratio * 1.2));
      this.settle = 3000;
    }
  }

  /** One step cheaper, in order of what costs most for the least loss: pixels above 1×, the shadow map, shadows, then pixels again. */
  private degrade(): void {
    const k = Math.min(0.85, Math.sqrt(30 / this.ema));
    const shadow = this.sun.shadow;
    if (this.ratio > 1.01) this.setRatio(Math.max(1, this.ratio * k));
    else if (this.renderer.shadowMap.enabled && shadow.mapSize.x > 1024) {
      shadow.mapSize.set(1024, 1024);
      shadow.radius = 2;
      shadow.map?.dispose();
      shadow.map = null;
      this.shadowHalf = 0;
    } else if (this.renderer.shadowMap.enabled) this.setShadows(false);
    else if (this.ratio > 0.5) this.setRatio(Math.max(0.5, this.ratio * k));
  }

  private setRatio(r: number): void {
    this.ratio = r;
    this.renderer.setPixelRatio(r);
    this.resize();
    this.ema = 30;
  }

  private setShadows(on: boolean): void {
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
  }

  /** Current 3D pixel ratio (adaptive). */
  get pixelRatio(): number {
    return this.ratio;
  }

  /** Keep the sun's shadow box over what the camera sees. */
  private fitShadow(): void {
    const v = this.rig.viewRect();
    const cx = (v.x0 + v.x1) / 2;
    const cz = (v.y0 + v.y1) / 2;
    const half = Math.min(60, Math.max(v.x1 - v.x0, v.y1 - v.y0) / 2 + 3);
    // resize in steps (a new projection every frame would shimmer)
    if (Math.abs(half - this.shadowHalf) > this.shadowHalf * 0.12 || this.shadowHalf === 0) {
      this.shadowHalf = Math.ceil(half);
      const cam = this.sun.shadow.camera;
      cam.left = cam.bottom = -this.shadowHalf;
      cam.right = cam.top = this.shadowHalf;
      cam.updateProjectionMatrix();
    }
    // snap to whole shadow texels so edges don't crawl while panning
    const texel = (this.shadowHalf * 2) / this.sun.shadow.mapSize.x;
    const sx = Math.round(cx / texel) * texel;
    const sz = Math.round(cz / texel) * texel;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + SUN_DIR.x * 60, SUN_DIR.y * 60, sz + SUN_DIR.z * 60);
    this.sun.target.updateMatrixWorld();
  }

  render(): void {
    this.fitShadow();
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** A full-screen flash that fades over `ms`. */
  flash(ms: number, r: number, g: number, b: number): void {
    const el = this.flashEl;
    el.style.transition = "none";
    el.style.background = `rgb(${r},${g},${b})`;
    el.style.opacity = "1";
    void el.offsetWidth;
    el.style.transition = `opacity ${ms}ms ease-out`;
    el.style.opacity = "0";
  }

  destroy(): void {
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.screen.destroy();
    this.flashEl.remove();
  }
}
