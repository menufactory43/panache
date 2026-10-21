import * as THREE from "three";
import type { CameraRig } from "./camera";

/**
 * Electric arcs (Belle Époque look): jagged, flickering bolts of lightning
 * between two points, re-randomised every few frames, with now and then a
 * fork. Every bolt is a chain of camera-facing ribbon quads in one dynamic
 * mesh (one draw call whatever the count); bolt records and their offset
 * buffers are recycled, so a long fight allocates nothing per frame.
 */

export interface BoltOpts {
  /** Lifetime, ms. */
  life: number;
  /** Ribbon width (world units)… */
  width: number;
  /** …but at least this many CSS px, so it still reads zoomed out. */
  minPx?: number;
  /** Halo colour (the core is white). */
  tint: number;
  /** Peak alpha. */
  alpha?: number;
  /** Largest sideways kink, as a share of the bolt's length. */
  jag?: number;
  /** ms between re-randomisations (the flicker). */
  reroll?: number;
  /** Chance of a fork at each re-roll. */
  fork?: number;
}

/** Segments per bolt (a power of two: midpoint displacement) and per fork. */
const SEGS = 16;
const FORK = 4;
const QUADS_PER = SEGS + FORK;
const MAX_QUADS = 1600;

interface Bolt {
  a: THREE.Vector3;
  b: THREE.Vector3;
  t: number;
  life: number;
  width: number;
  minPx: number;
  r: number;
  g: number;
  b_: number;
  alpha: number;
  jag: number;
  reroll: number;
  /** ms to the next re-roll. */
  rt: number;
  /** This roll's brightness (0.55–1). */
  flick: number;
  /** Sideways offsets (u, v) of the SEGS + 1 points. */
  off: Float32Array;
  /** The fork's FORK + 1 world points (x, y, z), or none. */
  forkPts: Float32Array;
  forked: boolean;
  /** Chance of a fork at each re-roll. */
  fork: number;
}

const VERT = /* glsl */ `
attribute vec4 color;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = color;
  gl_Position = projectionMatrix * viewMatrix * vec4( position, 1.0 );
}
`;
// a white-hot core in a soft halo of the bolt's colour
const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float d = abs( vUv.y * 2.0 - 1.0 );
  float core = 1.0 - smoothstep( 0.06, 0.2, d );
  float halo = pow( 1.0 - d, 1.6 );
  vec3 c = mix( vColor.rgb, vec3( 1.0 ), core );
  float a = vColor.a * min( 1.0, core + halo * 0.95 );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( c, a );
  #include <colorspace_fragment>
}
`;

const col = new THREE.Color();
const dir = new THREE.Vector3();
const U = new THREE.Vector3();
const V = new THREE.Vector3();
const P = new THREE.Vector3();
const Q = new THREE.Vector3();
const M = new THREE.Vector3();
const E = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

function blank(): Bolt {
  return {
    a: new THREE.Vector3(), b: new THREE.Vector3(), t: 0, life: 1, width: 0.05, minPx: 1.5, r: 1, g: 1, b_: 1, alpha: 1,
    jag: 0.12, reroll: 55, rt: 0, flick: 1, off: new Float32Array((SEGS + 1) * 2), forkPts: new Float32Array((FORK + 1) * 3), forked: false, fork: 0
  };
}

export class Arcs {
  readonly mesh: THREE.Mesh;
  private bolts: Bolt[] = [];
  private free: Bolt[] = [];
  private pos = new Float32Array(MAX_QUADS * 4 * 3);
  private color = new Float32Array(MAX_QUADS * 4 * 4);
  private geo = new THREE.BufferGeometry();
  private aPos: THREE.BufferAttribute;
  private aColor: THREE.BufferAttribute;

  constructor(private rig: CameraRig) {
    const uv = new Float32Array(MAX_QUADS * 4 * 2);
    const index = new Uint16Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      uv.set([0, 0, 0, 1, 1, 0, 1, 1], q * 8);
      const v = q * 4;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], q * 6);
    }
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.aPos);
    this.geo.setAttribute("color", this.aColor);
    this.geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7.2;
  }

  get count(): number {
    return this.bolts.length;
  }

  /** A bolt from world point (ax, ay, az) to (bx, by, bz) (three.js axes: y up). */
  bolt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, o: BoltOpts): void {
    if (this.bolts.length * QUADS_PER >= MAX_QUADS) return; // (a huge brawl: the oldest keep crackling)
    const b = this.free.pop() ?? blank();
    b.a.set(ax, ay, az);
    b.b.set(bx, by, bz);
    b.t = 0;
    b.life = o.life;
    b.width = o.width;
    b.minPx = o.minPx ?? 1.5;
    col.setHex(o.tint);
    b.r = col.r;
    b.g = col.g;
    b.b_ = col.b;
    b.alpha = o.alpha ?? 1;
    b.jag = o.jag ?? 0.12;
    b.reroll = o.reroll ?? 55;
    b.fork = o.fork ?? 0.35;
    this.roll(b);
    this.bolts.push(b);
  }

  /** New random kinks (midpoint displacement, so it is jagged at every scale) and maybe a fork. */
  private roll(b: Bolt): void {
    b.rt = b.reroll * (0.7 + Math.random() * 0.6);
    b.flick = 0.55 + Math.random() * 0.45;
    const off = b.off;
    off.fill(0);
    let scale = b.jag;
    for (let step = SEGS / 2; step >= 1; step >>= 1) {
      for (let i = step; i < SEGS; i += step * 2) {
        off[i * 2] = (off[(i - step) * 2]! + off[(i + step) * 2]!) / 2 + (Math.random() - 0.5) * 2 * scale;
        off[i * 2 + 1] = (off[(i - step) * 2 + 1]! + off[(i + step) * 2 + 1]!) / 2 + (Math.random() - 0.5) * 2 * scale;
      }
      scale *= 0.55;
    }
    b.forked = Math.random() < b.fork;
    if (!b.forked) return;
    // a fork off a point along the bolt, wandering away for a third of its length
    this.frame(b);
    const len = b.a.distanceTo(b.b);
    const i0 = 3 + Math.floor(Math.random() * (SEGS - 7));
    this.point(b, i0, len, P);
    const fp = b.forkPts;
    fp[0] = P.x;
    fp[1] = P.y;
    fp[2] = P.z;
    const su = (Math.random() - 0.5) * 2;
    const sv = (Math.random() - 0.5) * 2;
    const reach = len * (0.18 + Math.random() * 0.15);
    for (let k = 1; k <= FORK; k++) {
      const s = (k / FORK) * reach;
      fp[k * 3] = fp[(k - 1) * 3]! + (dir.x * 0.6 + U.x * su + V.x * sv) * (reach / FORK) + (Math.random() - 0.5) * s * 0.3;
      fp[k * 3 + 1] = fp[(k - 1) * 3 + 1]! + (dir.y * 0.6 + U.y * su + V.y * sv) * (reach / FORK) + (Math.random() - 0.5) * s * 0.3;
      fp[k * 3 + 2] = fp[(k - 1) * 3 + 2]! + (dir.z * 0.6 + U.z * su + V.z * sv) * (reach / FORK) + (Math.random() - 0.5) * s * 0.3;
    }
  }

  /** The bolt's unit direction and two axes across it (into dir, U, V). */
  private frame(b: Bolt): void {
    dir.subVectors(b.b, b.a).normalize();
    U.crossVectors(dir, Math.abs(dir.y) > 0.95 ? X : UP).normalize();
    V.crossVectors(dir, U).normalize();
  }

  /** Point i of the bolt (frame() first), into `out`. */
  private point(b: Bolt, i: number, len: number, out: THREE.Vector3): THREE.Vector3 {
    const k = i / SEGS;
    const ou = b.off[i * 2]! * len;
    const ov = b.off[i * 2 + 1]! * len;
    return out.lerpVectors(b.a, b.b, k).addScaledVector(U, ou).addScaledVector(V, ov);
  }

  private quad(q: number, p: THREE.Vector3, s: THREE.Vector3, half: number, r: number, g: number, bl: number, a0: number, a1: number): void {
    const cam = this.rig.camera.position;
    M.addVectors(p, s).multiplyScalar(0.5);
    E.subVectors(s, p).cross(M.sub(cam).negate()).normalize().multiplyScalar(half);
    const o = q * 12;
    const pos = this.pos;
    pos[o] = p.x - E.x;
    pos[o + 1] = p.y - E.y;
    pos[o + 2] = p.z - E.z;
    pos[o + 3] = p.x + E.x;
    pos[o + 4] = p.y + E.y;
    pos[o + 5] = p.z + E.z;
    pos[o + 6] = s.x - E.x;
    pos[o + 7] = s.y - E.y;
    pos[o + 8] = s.z - E.z;
    pos[o + 9] = s.x + E.x;
    pos[o + 10] = s.y + E.y;
    pos[o + 11] = s.z + E.z;
    const c = this.color;
    const co = q * 16;
    for (let v = 0; v < 4; v++) {
      c[co + v * 4] = r;
      c[co + v * 4 + 1] = g;
      c[co + v * 4 + 2] = bl;
      c[co + v * 4 + 3] = v < 2 ? a0 : a1;
    }
  }

  update(dtMs: number): void {
    let n = 0;
    let q = 0;
    for (const b of this.bolts) {
      b.t += dtMs;
      if (b.t >= b.life) {
        this.free.push(b);
        continue;
      }
      this.bolts[n++] = b;
      b.rt -= dtMs;
      if (b.rt <= 0) this.roll(b);
      const k = b.t / b.life;
      const a = b.alpha * b.flick * (1 - k * k);
      const len = b.a.distanceTo(b.b);
      if (len < 0.01) continue;
      this.frame(b);
      const half = Math.max(b.width, b.minPx * this.rig.worldPerPx(b.a.x, b.a.z, b.a.y)) / 2;
      this.point(b, 0, len, P);
      for (let i = 1; i <= SEGS; i++) {
        this.point(b, i, len, Q);
        this.quad(q++, P, Q, half, b.r, b.g, b.b_, a, a);
        P.copy(Q);
      }
      if (b.forked) {
        const fp = b.forkPts;
        for (let i = 0; i < FORK; i++) {
          P.set(fp[i * 3]!, fp[i * 3 + 1]!, fp[i * 3 + 2]!);
          Q.set(fp[i * 3 + 3]!, fp[i * 3 + 4]!, fp[i * 3 + 5]!);
          this.quad(q++, P, Q, half * (0.75 - i * 0.12), b.r, b.g, b.b_, a * (1 - i / FORK) * 0.9, a * (1 - (i + 1) / FORK) * 0.9);
        }
      }
    }
    this.bolts.length = n;
    this.geo.setDrawRange(0, q * 6);
    if (q > 0) {
      for (const at of [this.aPos, this.aColor]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, q * 4 * at.itemSize);
        at.needsUpdate = true;
      }
    }
  }

  clear(): void {
    for (const b of this.bolts) this.free.push(b);
    this.bolts.length = 0;
    this.geo.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
