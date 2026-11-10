// Essai « modèles haute fidélité » : le modèle du jeu (à gauche) à côté de sa version cuite dans Blender
// (art/models3d, à droite), sous la lumière et la caméra du jeu. `npm run dev`, puis /tools/modeles-hd.html
// ?faction=red, ?zoom=px par case (46 : la taille en partie), ?turn=rad (la caisse), ?head=rad (la tourelle),
// Glisser pour tourner et incliner, molette pour zoomer, double clic : rotation automatique, T : les tourelles.
// ?variant=burnt|flash|ghostOk… (l'après), ?pitch=deg, ?only=avant|apres, ?gap=cases entre les deux, ?biome=, ?spin (tourne tout seul).
import * as THREE from "three";
import { Stage } from "../src/game/three/stage";
import { setVariant } from "../src/game/three/materials";
import { buildingDef, forgetModels, instance, unitDef, unitScale, type ModelInstance } from "../src/game/three/models";
import { UNITS } from "../src/sim/balance";
import type { BuildingKind, Nation, UnitKind } from "../src/sim/types";
import { loadSkins } from "../src/game/three/skins";

const q = new URLSearchParams(location.search);
const stage = new Stage(document.getElementById("game")!, Math.min(2, devicePixelRatio));
stage.setBiome((q.get("biome") as "temperate") ?? "temperate");
const plate = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ color: Number(q.get("sol") ?? 0x5b6b3a) }));
plate.rotation.x = -Math.PI / 2;
plate.receiveShadow = true;
stage.scene.add(plate);

const faction = (q.get("faction") ?? "blue") as "blue" | "red";
const turn = Number(q.get("turn") ?? 0);
const head = Number(q.get("head") ?? 0);
const only = q.get("only");
const gap = Number(q.get("gap") ?? 2);

function place(root: THREE.Object3D, x: number): void {
  root.position.set(x, root.position.y, 0);
  stage.scene.add(root);
}

// ?u=<unité> ou ?b=<bâtiment>[@nation] : le modèle comparé (le Creusot sans rien)
const unit = (q.get("u") ?? "mastodon") as UnitKind;
const [bKind, bNation] = (q.get("b") ?? "").split("@") as [BuildingKind | "", Nation | undefined];
const make = () => (bKind ? buildingDef(bKind, faction, bNation) : unitDef(unit, faction));
const pose = (m: ModelInstance, x: number) => {
  // (l'échelle du jeu, recalculée pour chacun : un modèle refait n'a pas les mesures de l'ancien)
  m.root.scale.setScalar(bKind ? 1 : unitScale(unit));
  if (!bKind && UNITS[unit].domain === "air") m.root.position.y = 0.5;
  if (m.cargo) m.cargo.visible = true;
  place(m.root, x);
};
// l'avant : le modèle procédural, construit avant que les fichiers cuits n'arrivent
const old = instance(make());
if (only !== "apres") pose(old, only ? 0 : -gap / 2);

// l'après : le même une fois ses fichiers cuits chargés (three/skins.ts), par le chemin du jeu
let hd: ModelInstance | null = null;
if (only !== "avant")
  void loadSkins("../").then(() => {
    forgetModels();
    const d = make();
    hd = instance(d);
    if (q.get("variant")) setVariant(hd.root, q.get("variant") as "burnt");
    pose(hd, only ? 0 : gap / 2);
    (window as unknown as { ready: boolean }).ready = true;
  });
else (window as unknown as { ready: boolean }).ready = true;

stage.rig.bounds = { x0: -100, y0: -100, x1: 100, y1: 100 };
const pitch = q.get("pitch");
stage.rig.zoom = Number(q.get("zoom") ?? 300);
stage.rig.centerOn(Number(q.get("x") ?? 0), Number(q.get("y") ?? -0.25));
// À la souris ou au doigt : glisser tourne les deux chars (et incline la caméra de haut en bas), la molette ou le
// pincement zoome, un double clic lance ou arrête la rotation automatique, T fait pivoter les tourelles.
let spin = q.get("spin") !== null;
let yaw = -turn;
let headYaw = -head;
let tilt = pitch !== null ? Number(pitch) : 42;
stage.rig.pitchFor = () => THREE.MathUtils.degToRad(tilt);
const el = stage.canvas;
el.style.touchAction = "none";
el.style.cursor = "grab";
const touches = new Map<number, { x: number; y: number }>();
let pinch = 0;
el.addEventListener("pointerdown", (e) => {
  el.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinch = 0;
});
el.addEventListener("pointermove", (e) => {
  const p = touches.get(e.pointerId);
  if (!p) return;
  if (touches.size === 1) {
    yaw += (e.clientX - p.x) * 0.008;
    tilt = Math.min(88, Math.max(4, tilt + (e.clientY - p.y) * 0.25));
  }
  p.x = e.clientX;
  p.y = e.clientY;
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    if (pinch) stage.rig.zoom = Math.min(1500, Math.max(30, (stage.rig.zoom * d) / pinch));
    pinch = d;
  }
});
const lift = (e: PointerEvent) => {
  touches.delete(e.pointerId);
  pinch = 0;
};
el.addEventListener("pointerup", lift);
el.addEventListener("pointercancel", lift);
el.addEventListener("wheel", (e) => {
  e.preventDefault();
  stage.rig.zoom = Math.min(1500, Math.max(30, stage.rig.zoom * Math.exp(-e.deltaY * 0.0015)));
}, { passive: false });
el.addEventListener("dblclick", () => (spin = !spin));
let headSpin = false;
addEventListener("keydown", (e) => e.key.toLowerCase() === "t" && (headSpin = !headSpin));
let last = performance.now();
const loop = () => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  if (spin && !touches.size) yaw += dt * 0.4;
  if (spin || headSpin) headYaw = Math.sin(now / 1500) * 0.8;
  for (const m of [old, hd]) {
    if (!m) continue;
    m.body.rotation.y = yaw;
    if (m.turret) m.turret.rotation.y = headYaw;
    for (const r of m.rotors) r.obj.rotation[r.axis] += dt * r.speed;
  }
  stage.rig.apply();
  stage.render();
  requestAnimationFrame(loop);
};
loop();
addEventListener("resize", () => stage.resize());
