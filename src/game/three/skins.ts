import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SkinLook } from "./materials";
import { SKIN_NAMES } from "./skins-list";

/**
 * Baked models (art/models3d): a unit modelled in Blender, its detail (rivets,
 * track links, plates, worn paint, grime) baked into three textures over a
 * light mesh. public/assets/models/<name>/ holds `<name>.glb` (one mesh per
 * part: hull, turret…, no material) and color / normal / orm .webp.
 *
 * They load before the battlefield is built (loadSkins), since models are
 * built on the spot: a model whose files didn't come keeps its procedural
 * look (belle/ground.ts asks skinPart and falls back). `?hd=0` turns them off.
 */
/**
 * Two kinds: `creusot`, modelled by hand in Blender (creusot.py; belle/ground.ts builds its def), and the
 * procedural models baked as they are (`u-<kind>`, `b-<kind>[-<nation>]`: tools/export-models.ts writes
 * their shapes, auto.py bakes them, models.ts reskin swaps their parts in). skins-list.ts names them all.
 */
const NAMES: readonly string[] = SKIN_NAMES;

interface Skin {
  parts: Record<string, THREE.BufferGeometry>;
  color: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
}

const skins = new Map<string, Skin>();
let loading: Promise<void> | null = null;
const OFF = typeof location !== "undefined" && new URLSearchParams(location.search).get("hd") === "0";

async function load(name: string, base: string): Promise<void> {
  const dir = `${base}assets/models/${name}`;
  const tex = async (file: string, srgb = false) => {
    const t = await new THREE.TextureLoader().loadAsync(`${dir}/${file}`);
    // (glTF's UV origin is the top left)
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const [gltf, color, normal, orm] = await Promise.all([
    new GLTFLoader().loadAsync(`${dir}/${name}.glb`), tex("color.webp", true), tex("normal.webp"), tex("orm.webp")
  ]);
  const parts: Record<string, THREE.BufferGeometry> = {};
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.computeBoundingBox();
    m.geometry.computeBoundingSphere();
    parts[o.name] = m.geometry;
  });
  skins.set(name, { parts, color, normal, orm });
}

/** Fetch every baked model (once). Never rejects: what fails to load is drawn the old way. `base`: the site root. */
export function loadSkins(base = "./"): Promise<void> {
  if (OFF) return Promise.resolve();
  return (loading ??= Promise.all(NAMES.map((n) => load(n, base).catch((e) => console.warn("baked model failed:", n, e)))).then(() => undefined));
}

/**
 * A baked model's part in `team`'s paint, or undefined when it isn't loaded:
 * the shared geometry under a new BufferGeometry tagged with its textures and
 * team colour (models.ts modelMesh picks its material from that tag).
 */
export function skinPart(name: string, part: string, team: number): THREE.BufferGeometry | undefined {
  const s = skins.get(name);
  const src = s?.parts[part];
  if (!s || !src) return undefined;
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(src.attributes)) g.setAttribute(k, a);
  g.setIndex(src.index);
  g.boundingBox = src.boundingBox!.clone();
  g.boundingSphere = src.boundingSphere!.clone();
  const look: SkinLook = { key: name, color: s.color, normal: s.normal, orm: s.orm, team };
  g.userData.skin = look;
  return g;
}
