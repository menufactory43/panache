// Écrit la forme de chaque modèle procédural (unités et bâtiments) pour la cuisson Blender
// (art/models3d/auto.py) : art/models3d/out/src/<nom>.json, une entrée par pièce (coque, tourelle,
// hélices, chargement, rampe, pièces mobiles), en triangles, avec par sommet la couleur de base, la
// matière devinée de cette couleur, le masque de la couleur du camp et celui des lampes.
// Usage : npx vite-node tools/export-models.ts [nom…]   (u-<kind>, b-<kind>[-<nation>] ; rien : tous)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { ModelBuilder } from "../src/game/three/builder";

ModelBuilder.keepBase = true;
// (le style Belle Époque se lit dans l'adresse de la page : theme.ts)
(globalThis as { location?: unknown }).location ??= { search: "" };
const { buildingDef, buildingSkin, unitDef, TEAMS } = await import("../src/game/three/models");
const { NATION_TEAMS } = await import("../src/game/three/belle");
const BP = await import("../src/game/three/belle/buildings");
// la matière d'un bâtiment, lue de sa couleur de base : 1 pierre de taille, 2 brique, 3 toiture, 4 bois (auto.py en fait les appareils)
const KIND = new Map<number, number>([
  [BP.STONE, 1], [BP.STONE_D, 1], [BP.STONE_L, 1], [BP.BRICK, 2], [BP.BRICK_D, 2], [BP.SLATE, 3], [BP.ZINC, 3], [BP.WOOD, 4], [BP.WOOD_D, 4]
]);
const { BUILDINGS, UNITS } = await import("../src/sim/balance");
type ModelDef = ReturnType<typeof unitDef>;

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../art/models3d/out/src");
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
// (les escouades, le Gargantua et le Zénith ont leur squelette à eux ; le Creusot, le Panhard, le Fardier et le Canon de 75 sont modelés à la main : art/models3d/<nom>.py)
const SKIP = new Set(["trooper", "rocket-squad", "sniper", "sapeurs", "fusiliers", "carabiniers", "goliath", "zenith", "mastodon", "stinger", "harvester", "mortar", "lancer", "flak-crawler", "scout", "wasp", "raptor", "hornet", "mender", "condor", "fourgon", "jamais-contente", "de-dion", "branly", "estafette", "mortier-280", "atelier", "gyroptere", "epervier", "vulcain", "titan"]);
// (le portique Classique porte les 34 000 triangles du Gargantua en chantier : il reste procédural)
const SKIP_NAMES = new Set(["b-gantry"]);

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const c = new THREE.Color();

/** La matière d'une couleur de base (linéaire) : [métal, rugosité, usure de peinture, arête claire]. */
function matter(r: number, g: number, b: number): [number, number, number, number] {
  const hsl = { h: 0, s: 0, l: 0 };
  c.setRGB(r, g, b).getHSL(hsl, THREE.SRGBColorSpace);
  const hex = c.getHex(THREE.SRGBColorSpace);
  const v = Math.max(hex >> 16, (hex >> 8) & 255, hex & 255) / 255;
  const mn = Math.min(hex >> 16, (hex >> 8) & 255, hex & 255) / 255;
  const s = v ? (v - mn) / v : 0;
  const h = hsl.h * 360;
  if (v < 0.27) return [0.55, 0.55, 0, 0.5]; // fer, suie, chenilles
  if (s > 0.45 && v > 0.72 && h > 32 && h < 52) return [1, 0.3, 0, 0.5]; // laiton
  if (s > 0.5 && v > 0.6 && h > 12 && h < 30) return [1, 0.34, 0, 0.5]; // cuivre
  if (s < 0.14 && v < 0.75) return [0.8, 0.42, 0, 0.6]; // acier
  if (s < 0.3 && v > 0.75) return [0, 0.9, 0.15, 0]; // toile, plâtre
  return [0, 0.6, 1, 0]; // peinture
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
function triNormalY(p: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number): number {
  va.fromBufferAttribute(p, i);
  vb.fromBufferAttribute(p, i + 1).sub(va);
  vc.fromBufferAttribute(p, i + 2).sub(va);
  return vb.cross(vc).normalize().y;
}

function part(name: string, at: number[], blue: THREE.BufferGeometry, red: THREE.BufferGeometry, mainBlue: number) {
  const p = blue.attributes.position!;
  const bb = blue.attributes.base!;
  const rb = red.attributes.base!;
  const glow = blue.attributes.glow!;
  c.setHex(mainBlue);
  const lm = lum(c.r, c.g, c.b);
  const pos: number[] = [], col: number[] = [], prm: number[] = [], tg: number[] = [];
  if (rb.count !== bb.count) throw new Error(`${name}: les deux camps n'ont pas la même forme`);
  for (let i = 0; i < p.count; i++) {
    pos.push(r4(p.getX(i)), r4(p.getY(i)), r4(p.getZ(i)));
    const [r, g, b] = [bb.getX(i), bb.getY(i), bb.getZ(i)];
    const team = Math.abs(r - rb.getX(i)) + Math.abs(g - rb.getY(i)) + Math.abs(b - rb.getZ(i)) > 0.01;
    const gl = glow.getX(i);
    // (une couleur du camp sur une face tournée vers le ciel : c'est un toit)
    const tri = i - (i % 3);
    const up = p.count % 3 === 0 && !blue.index ? Math.abs(triNormalY(p, tri)) : 0;
    const kind = gl > 0 ? 0 : team ? (up > 0.15 ? 3 : 0) : KIND.get(c.setRGB(r, g, b).getHex()) ?? 0;
    if (team) {
      // la peinture du camp : cuite en blanc, plus ou moins claire selon la teinte (main, dark, light)
      const k = Math.min(1, Math.max(0.25, (lum(r, g, b) / lm) ** 0.45 * 0.78));
      col.push(r4(k), r4(k), r4(k));
      prm.push(0, 0.62, gl > 0 ? 0 : kind === 3 ? 0.35 : 1, 0);
    } else {
      col.push(r4(r), r4(g), r4(b));
      // (pierre, brique, ardoise, bois : rien dessous à mettre à nu)
      prm.push(...(gl > 0 ? [0, 0.5, 0, 0] : kind ? [0, kind === 3 ? 0.55 : 0.85, 0, 0] : matter(r, g, b)));
    }
    tg.push(team ? 1 : 0, r4(gl), kind / 8);
  }
  return { name, at, pos, col, prm, tg };
}

function write(name: string, blue: ModelDef, red: ModelDef, main: number, size: number): void {
  if (SKIP_NAMES.has(name) || (only.length && !only.includes(name))) return;
  const parts = [part("hull", [0, 0, 0], blue.hull, red.hull, main)];
  if (blue.turret) parts.push(part("turret", blue.mount, blue.turret, red.turret!, main));
  if (blue.cargo) parts.push(part("cargo", [0, 0, 0], blue.cargo, red.cargo!, main));
  if (blue.ramp) parts.push(part("ramp", blue.ramp.hinge, blue.ramp.geo, red.ramp!.geo, main));
  blue.rotors.forEach((r, i) => parts.push(part(`rotor${i}`, r.at, r.geo, red.rotors[i]!.geo, main)));
  const where = (k: string): number[] => {
    const p = blue.parts![k]!;
    const up = p.parent ? where(p.parent) : [0, 0, 0];
    return [p.at[0] + up[0]!, p.at[1] + up[1]!, p.at[2] + up[2]!];
  };
  for (const [k, p] of Object.entries(blue.parts ?? {})) parts.push(part(`part_${k}`, where(k), p.geo, red.parts![k]!.geo, main));
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ name, size, parts }));
  console.log(name, parts.length, "pièces", parts.reduce((n, p) => n + p.pos.length / 9, 0), "triangles");
}

/** La couleur principale du camp bleu d'un modèle : celle de sa nation, ou du camp en Classique (models.ts teamFor). */
const mainOf = (n: string | undefined): number => (n ? NATION_TEAMS[n as "empire"].blue.main : TEAMS.blue.main);

for (const kind of Object.keys(UNITS) as (keyof typeof UNITS)[]) {
  if (SKIP.has(kind)) continue;
  const [b, r] = [unitDef(kind, "blue"), unitDef(kind, "red")];
  write(`u-${kind}`, b, r, mainOf(UNITS[kind].nation), 512);
}
const done = new Set<string>();
for (const kind of Object.keys(BUILDINGS) as (keyof typeof BUILDINGS)[])
  for (const owner of [undefined, "republique", "empire"] as const) {
    const name = buildingSkin(kind, owner);
    if (done.has(name)) continue;
    done.add(name);
    const [b, r] = [buildingDef(kind, "blue", owner), buildingDef(kind, "red", owner)];
    // (les grands bâtiments, deux cases et plus, ont une texture plus fine)
    write(name, b, r, mainOf(BUILDINGS[kind].nation ?? owner), 512);
  }
