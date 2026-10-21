import * as THREE from "three";
import { discTexture } from "./textures";

/**
 * Shared materials and the shader patches every lit object gets:
 *
 * - **Fog of war**: one (w+2)×(h+2) texture, a texel per tile, sampled by
 *   world position in every fogged material (terrain, models, trees, decals).
 *   Explored ground fades to a dimmed, greyed memory of itself; unexplored
 *   ground disappears under an opaque, biome-tinted shroud with slow drifting
 *   wisps, whose edge billows outward (never inward) — so it hides at least
 *   everything the old flat black did.
 * - **Cloud shadows**: a tiling noise texture drifting over the world, the
 *   shade a little bluer than the sunlit ground.
 * - **Model shading**: vertex-coloured, flat-shaded models with a per-vertex
 *   glow attribute (lights, engines, crystals), walls darkening toward the
 *   ground they stand on, and uniform variants for the hit flash, burnt
 *   wrecks, damaged buildings, elite shimmer and placement ghosts — variants
 *   share one shader program, so swapping is cheap.
 */

export const FOW_COLOR = 0x0b1219;

/**
 * Fog colours are display-space (the fog mixes in after tone mapping), so
 * they're stored as given: `setHex(hex, LinearSRGBColorSpace)` skips the
 * sRGB → linear conversion.
 */
const raw = (hex: number) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

export const fowUniforms = {
  uFowMap: { value: null as THREE.Texture | null },
  uFowSize: { value: new THREE.Vector2(1, 1) },
  uFowOn: { value: 1 },
  uFowColor: { value: raw(FOW_COLOR) },
  uFowWisp: { value: raw(0x1c2a35) },
  uFowMemory: { value: new THREE.Color(0.86, 0.96, 1.12) },
  uCloudMap: { value: null as THREE.Texture | null },
  uCloudOffset: { value: new THREE.Vector2() },
  uCloudK: { value: 0.3 },
  uCloudTint: { value: new THREE.Color(1, 0.92, 0.8) },
  uTime: { value: 0 }
};

/** A biome's fog of war and cloud shade (display-space). */
export interface FogLook {
  /** The unexplored shroud and its drifting wisps. */
  shroud: number;
  wisp: number;
  /** Tint of explored-but-unseen ground (multiplies its greyed brightness; keep its luminance ≤ 1). */
  memory: [number, number, number];
  /** How much of each channel a cloud's shade takes (less blue: a cooler shade). */
  cloud: [number, number, number];
}

export function setFogLook(l: FogLook): void {
  fowUniforms.uFowColor.value.setHex(l.shroud, THREE.LinearSRGBColorSpace);
  fowUniforms.uFowWisp.value.setHex(l.wisp, THREE.LinearSRGBColorSpace);
  fowUniforms.uFowMemory.value.setRGB(...l.memory, THREE.LinearSRGBColorSpace);
  fowUniforms.uCloudTint.value.setRGB(...l.cloud, THREE.LinearSRGBColorSpace);
}

const VERT_DECL = /* glsl */ `
varying vec3 vFowW;
`;
const VERT_CODE = /* glsl */ `
  {
    vec4 fowW = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      fowW = instanceMatrix * fowW;
    #endif
    vFowW = ( modelMatrix * fowW ).xyz;
  }
`;
const FRAG_DECL = /* glsl */ `
varying vec3 vFowW;
uniform sampler2D uFowMap;
uniform vec2 uFowSize;
uniform float uFowOn;
uniform vec3 uFowColor;
uniform vec3 uFowWisp;
uniform vec3 uFowMemory;
uniform sampler2D uCloudMap;
uniform vec2 uCloudOffset;
uniform float uCloudK;
uniform vec3 uCloudTint;
uniform float uTime;
float fowAt( vec2 p ) { return texture2D( uFowMap, ( p + 1.0 ) / uFowSize ).r; }
`;
// fog texels: 0 visible, 0.5 explored, 0.94 unexplored, 1 under Uncharted (blurred between; terrain.ts FOG_TARGET)
const fragCode = (clouds: boolean) => /* glsl */ `
  {
    vec2 fp = vFowW.xz;
    ${clouds ? "float cl = texture2D( uCloudMap, fp * 0.032 + uCloudOffset ).r; gl_FragColor.rgb *= 1.0 - cl * uCloudK * uCloudTint;" : ""}
    float fw = 0.0;
    if ( uFowOn > 0.5 ) fw = fowAt( fp );
    // visible ground (most of the screen in play) skips the rest
    if ( fw > 0.002 ) {
      // the wisps only touch the shroud (fw > 0.5): elsewhere they'd change nothing, so skip the lookup.
      // They're looked up where this pixel's view ray meets the ground, so a tree or rock in the
      // shroud is exactly the shroud behind it: no silhouettes. (Explicit LOD: this branch isn't uniform.)
      float mist = 0.0;
      if ( fw > 0.5 ) {
        vec2 gp = cameraPosition.xz + ( vFowW.xz - cameraPosition.xz ) * ( cameraPosition.y / max( 0.01, cameraPosition.y - vFowW.y ) );
        mist = textureLod( uCloudMap, gp * 0.09 + vec2( uTime * 0.005, uTime * -0.0035 ), 0.0 ).r;
        // the shroud's edge billows outward, never in
        fw = min( 1.0, fw + mist * 0.45 * smoothstep( 0.5, 0.6, fw ) * ( 1.0 - smoothstep( 0.86, 0.94, fw ) ) );
      }
      fw = fw * fw * ( 3.0 - 2.0 * fw );
      // at every fog level the ground shows through no more than under the old flat darkening:
      // explored ground is greyed to the same half brightness, and the shroud then covers it
      // at least as fast as the darkening did
      vec3 col = gl_FragColor.rgb;
      vec3 memory = mix( col, dot( col, vec3( 0.3, 0.59, 0.11 ) ) * uFowMemory, 0.5 ) * 0.5;
      float shroud = clamp( fw * 2.2 - 1.1, 0.0, 1.0 );
      col = mix( col, memory, min( 1.0, fw * 2.0 ) );
      col = mix( col, mix( uFowColor, uFowWisp, mist ), shroud );
      // a faint mist bank where the shroud meets the known map
      gl_FragColor.rgb = col + uFowWisp * ( shroud * ( 1.0 - shroud ) * 0.5 );
    }
  }
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

/** Patch a material so the fog of war (and optionally cloud shadows) darken it. */
export function fogged<T extends THREE.Material>(
  m: T,
  o: { clouds?: boolean; key?: string; also?: (s: Shader) => void } = {}
): T {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fowUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_DECL}`)
      .replace("#include <fog_vertex>", `#include <fog_vertex>\n${VERT_CODE}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_DECL}`)
      .replace("#include <fog_fragment>", `#include <fog_fragment>\n${fragCode(o.clouds ?? true)}`);
    o.also?.(shader);
  };
  m.customProgramCacheKey = () => `fow:${o.clouds ?? true}:${o.key ?? ""}`;
  return m;
}

// ---------------------------------------------------------------- models --

export type Variant = "normal" | "flash" | "warm" | "burnt" | "damaged" | "elite" | "ghostOk" | "ghostBad" | "unpowered";

interface VariantSpec {
  tint: number;
  /** Light added on top of the shaded model (so it keeps its form). */
  flash: number;
  flashColor: number;
  glow: number;
  /** How far the flash also bleaches the diffuse colour. */
  bleach?: number;
  /** Flash light thrown on the paint (scales with it, so the hue survives: a fire's glow, not a coat of orange). */
  flashLit?: number;
  /** Greys the paint first (0 keeps it, 1 is all grey). */
  desat?: number;
  /** Elite gold, ghost scan: an edge light plus a glint sweeping across the hull. */
  sheen?: number;
  sheenColor?: number;
  roughness?: number;
  metalness?: number;
  ghost?: boolean;
}

const VARIANTS: Record<Variant, VariantSpec> = {
  normal: { tint: 0xffffff, flash: 0, flashColor: 0xffffff, glow: 1 },
  flash: { tint: 0xffffff, flash: 0.42, flashColor: 0xfff4e4, glow: 1, bleach: 0.3 },
  warm: { tint: 0xffffff, flash: 0.03, flashColor: 0xffa860, glow: 1, bleach: 0, flashLit: 0.55 },
  burnt: { tint: 0x9a9088, flash: 0, flashColor: 0x000000, glow: 0, desat: 1, roughness: 0.92, metalness: 0.1 },
  damaged: { tint: 0xa8a098, flash: 0, flashColor: 0x000000, glow: 0.6, desat: 0.35 },
  // a République building off the power network (WP1 Building.unpowered): dimmed, its lamps out
  unpowered: { tint: 0x7a7e8c, flash: 0, flashColor: 0x000000, glow: 0, desat: 0.5 },
  elite: { tint: 0xffffff, flash: 0, flashColor: 0x000000, glow: 1.2, sheenColor: 0xffb428 },
  ghostOk: { tint: 0xb8ffc8, flash: 0.35, flashColor: 0x37d67a, glow: 1, sheen: 0.5, sheenColor: 0x9affc0, ghost: true },
  ghostBad: { tint: 0xff9090, flash: 0.45, flashColor: 0xe25555, glow: 1, sheen: 0.5, sheenColor: 0xff9a8a, ghost: true }
};

// trees: a per-instance `canopy` (0–1) dissolves the tree above a stump of its trunk (tree space, see canopyMat)
const CANOPY_VERT_DECL = `\nattribute float canopy;\nvarying float vCanopy;\nvarying float vTreeY;`;
const CANOPY_VERT = `\nvCanopy = canopy;\nvTreeY = position.y;`;
const CANOPY_FRAG_DECL = `\nvarying float vCanopy;\nvarying float vTreeY;`;
const CANOPY_FRAG = `
          diffuseColor.a *= 1.0 - vCanopy * smoothstep( 0.12, 0.2, vTreeY );
          if ( diffuseColor.a < 0.02 ) discard;`;

/** The elite shimmer's strength (animated by the entity renderer, 0.04–0.16). */
export const eliteUniform = { value: 0.12 };
/** …scaled up into the elite sheen's colour. */
const ELITE_SHEEN = 6;

function modelMaterial(v: VariantSpec, elite: boolean, canopy = false, clear = false): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: v.roughness ?? 0.58,
    metalness: v.metalness ?? 0.35,
    side: THREE.DoubleSide,
    transparent: !!v.ghost,
    opacity: v.ghost ? 0.6 : 1,
    depthWrite: !v.ghost
  });
  // (alpha to coverage: with MSAA the canopy fades in steps with no sorting; without, it's cut at half)
  m.alphaToCoverage = canopy;
  const uniforms = {
    uTint: { value: new THREE.Color(v.tint) },
    uFlash: { value: v.flash },
    uFlashColor: { value: new THREE.Color(v.flashColor) },
    uGlowK: { value: v.glow },
    uBleach: { value: v.bleach ?? 0.5 },
    uFlashLit: { value: v.flashLit ?? 0 },
    uDesat: { value: v.desat ?? 0 },
    uSheen: elite ? eliteUniform : { value: v.sheen ?? 0 },
    uSheenColor: { value: new THREE.Color(v.sheenColor ?? 0xffffff).multiplyScalar(elite ? ELITE_SHEEN : 1) }
  };
  return fogged(m, {
    key: `model${v.ghost ? "g" : ""}${canopy ? "c" : ""}`,
    also: (s) => {
      Object.assign(s.uniforms, uniforms);
      // a fog-free twin: the same program, its own switch held off (see clearMat)
      if (clear) s.uniforms.uFowOn = CLEAR_FOW;
      s.vertexShader = s.vertexShader
        .replace("#include <common>", `#include <common>\nattribute float glow;\nvarying float vGlow;${canopy ? CANOPY_VERT_DECL : ""}`)
        .replace("#include <color_vertex>", `#include <color_vertex>\nvGlow = glow;${canopy ? CANOPY_VERT : ""}`);
      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying float vGlow;${canopy ? CANOPY_FRAG_DECL : ""}
          uniform vec3 uTint; uniform float uFlash; uniform vec3 uFlashColor; uniform float uGlowK; uniform float uBleach;
          uniform float uFlashLit; uniform float uDesat; uniform float uSheen; uniform vec3 uSheenColor;`
        )
        // lamps light themselves: less lit diffuse, more emission, so they stay saturated under tone mapping
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>${canopy ? CANOPY_FRAG : ""}
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) ), uDesat ) * uTint;
          vec3 glowBase = diffuseColor.rgb;
          diffuseColor.rgb *= 1.0 - min( 1.0, vGlow * uGlowK ) * 0.8;`
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
          // contact shade: walls darken toward the ground they stand on (roofs and lamps don't)
          float wall = 1.0 - max( 0.0, dot( normal, viewMatrix[ 1 ].xyz ) );
          diffuseColor.rgb *= 1.0 - 0.38 * wall * ( 1.0 - smoothstep( -0.02, 0.32, vFowW.y ) ) * ( 1.0 - min( 1.0, vGlow ) );
          totalEmissiveRadiance += glowBase * vGlow * uGlowK * 1.05 + uFlashColor * ( uFlash + glowBase * uFlashLit );
          diffuseColor.rgb = mix( diffuseColor.rgb, uFlashColor, uFlash * uBleach );
          if ( uSheen > 0.0 ) {
            float edge = 1.0 - abs( dot( normal, normalize( vViewPosition ) ) );
            float band = fract( ( vFowW.x - vFowW.z ) * 0.35 - uTime * 0.45 );
            float glint = smoothstep( 0.0, 0.04, band ) - smoothstep( 0.04, 0.13, band );
            totalEmissiveRadiance += uSheenColor * ( uSheen * ( edge * edge + glint * 1.6 ) );
          }`
        );
    }
  });
}

let modelMats: Record<Variant, THREE.MeshStandardMaterial> | null = null;
let clearMats: Record<Variant, THREE.MeshStandardMaterial> | null = null;
/** The fog switch every fog-free twin reads: always off. */
const CLEAR_FOW = { value: 0 };

/** The shared model material for a variant. */
export function modelMat(v: Variant = "normal"): THREE.MeshStandardMaterial {
  if (!modelMats) {
    const out = {} as Record<Variant, THREE.MeshStandardMaterial>;
    for (const k of Object.keys(VARIANTS) as Variant[]) out[k] = modelMaterial(VARIANTS[k], k === "elite");
    modelMats = out;
  }
  return modelMats[v];
}

/**
 * The fog-free twin of a variant's model material, for what the enemy always
 * sees (a Goliath, a Gantry and the mech taking shape on it): drawn live and
 * in full colour through explored ground and the shroud alike, where the
 * plain material would grey it to memory or hide it under the shroud. It
 * compiles to the same program as the plain one (only its fog switch, a
 * uniform, differs), so it costs no shader and no stall the first time a
 * Goliath walks on.
 */
export function clearMat(v: Variant = "normal"): THREE.MeshStandardMaterial {
  if (!clearMats) {
    const out = {} as Record<Variant, THREE.MeshStandardMaterial>;
    for (const k of Object.keys(VARIANTS) as Variant[]) out[k] = modelMaterial(VARIANTS[k], k === "elite", false, true);
    clearMats = out;
  }
  return clearMats[v];
}

/**
 * Draw every model mesh under `root` clear of the fog from now on (its
 * variant swaps keep to the fog-free twins): see clearMat.
 */
export function clearOfFog(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh || !o.userData.model) return;
    const m = o as THREE.Mesh;
    o.userData.clear = true;
    const v = (Object.keys(VARIANTS) as Variant[]).find((k) => modelMats?.[k] === m.material) ?? "normal";
    m.material = clearMat(v);
  });
}

let canopyMat_: THREE.MeshStandardMaterial | null = null;

/**
 * The trees' material: the plain model material, plus an instanced `canopy`
 * attribute (0–1) that thins the tree away above a stump of its trunk — so
 * robots in the woods aren't lost under it (terrain.ts thins the trees
 * around squads on show).
 */
export function canopyMat(): THREE.MeshStandardMaterial {
  return (canopyMat_ ??= modelMaterial(VARIANTS.normal, false, true));
}

/** Swap every swappable mesh under `root` to a material variant (fog-free meshes to its fog-free twin). */
export function setVariant(root: THREE.Object3D, v: Variant): void {
  const mat = modelMat(v);
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.model) (o as THREE.Mesh).material = o.userData.clear ? clearMat(v) : mat;
  });
}

// ------------------------------------------------------------- unlit fx --

/** An additive, unlit, fog-free material (beams, glows, tracers). */
export function glowMat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false
  });
}

/** An additive soft disc (light pools, loot glow, beacons): use on a flat quad. */
export function discMat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  const m = glowMat(color, opacity);
  m.map = discTexture();
  return m;
}
