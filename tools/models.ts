// Dev-only model gallery: every unit, building and objective model for both
// factions on a ground plate, lit like the game. `npm run dev`, then open
// /tools/models.html (?faction=red, ?zoom=80, ?x=7&y=4 to centre, ?only=units|buildings).
//
// Robot infantry has its own yard north of the vehicles (centre ?x=4&y=-3.8): each
// squad animated as on the map — ?anim=walk (default: marching east, cadence from
// its speed), idle, aim, fall (robots drop one by one, then stand back up),
// still (?face=rad turns them: 0 north, 3.14 toward the camera). A loaded Condor hovers beside them with its ramp down. ?t=ms freezes
// the animation at that time (for screenshots); window.gallery.at(ms) moves it.
//
// ?only=condor lines up the dropship per faction: loaded and hovering low with its ramp down, loaded in
// flight, empty — then a Mastodon, a Trooper Squad and a Hornet for scale (?cface=rad turns the Condors).
// ?only=condor-ring shows it loaded at six headings, its ramp up and down by turns.
// ?pitch=deg overrides the camera's pitch (8 for a side view).
//
// ?only=goliath lines up the Goliath per faction: walking (animated), standing, digging in, anchored, every
// weapon down (pods sagging, eye dark, cannons limp), rebooting (eye relit, tubes cycling), lifted between two
// Condors, toppled and burnt, in love (Robot Love) — then a Mastodon and an HQ for scale.
// ?only=gantry shows the Gantry's six stages per faction: empty, foundation, frame, armament, finishing, rollout.
// ?icon=<kind>: one blue model alone on a flat ?bg= colour (default black), for shooting HUD portraits
// (tools/model-portraits.mjs shoots every one on black and on white, the two give the alpha: ICONS.md).
// The Goliath stands, the Gantry shows its armament stage; any other unit, building or objective (uplink,
// supply-crate) points north and fills the view. ?turn=rad turns the model clockwise from that pose,
// ?head=rad a building's turret or head on its mount, ?faction=red paints it red, and ?solo with a
// squad kind shows one of its robots, weapon up. <kind>@<nation> (hq@empire, depot@republique) draws a
// nation's own model of a shared building; eiffel the Eiffel Tower landmark.
import * as THREE from "three";
import { Stage } from "../src/game/three/stage";
import { buildingDef, landmarkDef, crateDef, instance, pileDef, podDef, uplinkDef, unitDef, unitScale, chuteGeometry, modelMesh, rubbleGeometry, TRACK } from "../src/game/three/models";
import { GoliathRig, type GoliathPose } from "../src/game/three/goliath";
import { J, baySeats, SquadRig, type BotKind } from "../src/game/three/infantry";
import { setVariant } from "../src/game/three/materials";
import { ModelBuilder } from "../src/game/three/builder";
import { UNIT_KINDS, BUILDING_KINDS } from "../src/game/assets";
import { UNITS } from "../src/sim/balance";
import type { UnitKind } from "../src/sim/types";

const q = new URLSearchParams(location.search);
const stage = new Stage(document.getElementById("game")!, Math.min(2, devicePixelRatio));
stage.setBiome((q.get("biome") as "temperate") ?? "temperate");
const plate = new THREE.Mesh(new THREE.PlaneGeometry(40, 34), new THREE.MeshLambertMaterial({ color: 0x5b6b3a }));
plate.rotation.x = -Math.PI / 2;
plate.position.set(9, 0, 2);
plate.receiveShadow = true;
stage.scene.add(plate);

const [icon, iconNation] = (q.get("icon") ?? "").split("@") as [string, "republique" | "empire" | undefined];
/** ?turn=rad: a portrait's model turned clockwise (seen from above) from its resting pose. */
const turn = Number(q.get("turn") ?? 0);
/** ?head=rad: a turret or radar head turned clockwise on its mount (the Radar's dish faces the viewer so). */
const head = Number(q.get("head") ?? 0);
const facs = (q.get("icon") ? q.get("faction") ?? "blue" : q.get("faction") ?? "blue,red").split(",") as ("blue" | "red")[];
const only = q.get("icon") ? "icon" : q.get("only");
const anim = q.get("anim") ?? "walk";
const BOTS: BotKind[] = ["trooper", "rocket-squad", "sniper", "sapeurs", "fusiliers", "carabiniers"];
const AIR: string[] = ["scout", "wasp", "raptor", "hornet", "mender", "condor"];
// units at their in-game size (unitScale), each row spaced to fit its biggest hulls
const box = new THREE.Box3();
const yard: { rig: SquadRig; kind: BotKind; x: number; z: number }[] = [];
const riders: { rig: SquadRig; ready: number }[] = [];
const cface = -Number(q.get("cface") ?? 0.35);
/** A portrait's model: framed by frameIcon() once the camera is set up. */
let iconRoot: THREE.Object3D | null = null;

/** A Condor at (x, z), `y` up, riders aboard, its ramp `ramp` of the way open. */
function condor(f: "blue" | "red", x: number, y: number, z: number, load: BotKind[], ramp: number, face = cface): void {
  const c = instance(unitDef("condor", f));
  const s = unitScale("condor");
  c.root.scale.setScalar(s);
  c.root.position.set(x, y, z);
  c.body.rotation.y = face;
  c.ramp!.rotation.x = ramp * c.def.ramp!.open;
  const bay = new THREE.Group();
  bay.scale.setScalar(1 / s);
  c.body.add(bay);
  load.forEach((k, side) => {
    const r = new SquadRig(k, f, 30 + side + riders.length);
    r.seat(baySeats(k, side, s));
    bay.add(r.root);
    // (ramp down: on their feet, ready to drop)
    riders.push({ rig: r, ready: ramp });
  });
  stage.scene.add(c.root);
}

/** A Goliath rig at (x, z) facing `face` (rad, sim-style: clockwise from north), posed once. */
function goliath(f: "blue" | "red", x: number, z: number, face: number, pose: Partial<GoliathPose> = {}, y = 0): GoliathRig {
  const r = new GoliathRig(f);
  r.root.scale.setScalar(unitScale("goliath"));
  r.root.position.set(x, y, z);
  r.root.rotation.y = -face;
  r.update({ ...REST_POSE, ...pose });
  stage.scene.add(r.root);
  return r;
}
const REST_POSE: GoliathPose = { dt: 0, speed: 0, lower: 0, spikes: 0, unfold: 0, yaw: 0, pitch: 0, droop: 0, pods: 0, eye: 1, hang: 0, crane: 0, look: 0 };
/** Walking Goliaths, animated by at(). */
const walkers: { rig: GoliathRig; x: number }[] = [];
/** A dark lift cable from a to b (the gallery's own: the game's live in render/goliath.ts). */
function cableBetween(a: THREE.Vector3, b: THREE.Vector3): void {
  const g = new ModelBuilder();
  g.box(1, 1, 1, [0, 0.5, 0], TRACK);
  const m = modelMesh(g.build(), false);
  m.position.copy(a);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  m.scale.set(0.022, a.distanceTo(b), 0.022);
  stage.scene.add(m);
}

facs.forEach((f, fi) => {
  if (only === "icon") {
    if (icon === "gantry" && !iconNation) {
      const g = instance(buildingDef("gantry", f));
      for (let i = 0; i < 4; i++) g.parts[`stage${i}`]!.visible = i === 2;
      g.parts.lightsOff!.visible = false;
      g.parts.jib!.rotation.set(0, 2.11, 0, "YXZ");
      g.parts.plate!.visible = false;
      g.parts.hook!.position.set(0, -1.6, -1.5);
      g.parts.cable!.position.set(0, 0, -1.5);
      g.parts.cable!.scale.set(1, 1.6, 1);
      g.root.rotation.y = -turn;
      stage.scene.add(g.root);
      iconRoot = g.root;
    } else if (icon === "goliath") iconRoot = goliath(f, 0, 0, Math.PI + turn, { yaw: 0 }).root;
    else if (BOTS.includes(icon as BotKind) && q.get("solo") !== null) {
      // one robot of the squad, weapon up
      const r = new SquadRig(icon as BotKind, f, 3, 1);
      for (let i = 0; i < 40; i++) r.update({ dt: 16, speed: 0, aim: 1, pitch: 0, alive: 1 });
      // (the others are shrunk to points at their slots: gather them into this one, out of its framing)
      const up = r.bots.find((b) => !b.gone)!;
      for (const b of r.bots) if (b.gone) b.b[J.root]!.position.copy(up.b[J.root]!.position);
      r.root.rotation.y = -turn;
      stage.scene.add(r.root);
      iconRoot = r.root;
    } else if ((BUILDING_KINDS as string[]).includes(icon!) || ["uplink", "supply-crate", "arsonval", "flak-battery", "eiffel"].includes(icon)) {
      // a building or objective as the map shows it
      const d =
        icon === "uplink" ? uplinkDef() : icon === "supply-crate" ? crateDef() : icon === "eiffel" ? landmarkDef("eiffel", f) : buildingDef(icon as never, f, iconNation);
      const b = instance(d);
      b.root.rotation.y = -turn;
      if (b.turret) b.turret.rotation.y = -head;
      stage.scene.add(b.root);
      iconRoot = b.root;
    } else {
      // any other unit, nose north
      const u = instance(unitDef(icon as UnitKind, f));
      u.root.scale.setScalar(unitScale(icon as UnitKind));
      u.root.rotation.y = -turn;
      stage.scene.add(u.root);
      iconRoot = u.root;
    }
    plate.visible = false;
    stage.scene.background = new THREE.Color(q.get("bg") ?? "#000000");
    return;
  }
  if (only === "goliath") {
    const z = fi * 4.6;
    const face = fi ? 0 : Math.PI;
    // walking east along the row (animated), then the line-up
    const w = goliath(f, 0, z, Math.PI / 2);
    walkers.push({ rig: w, x: -3.2 });
    goliath(f, 3.4, z, face);
    goliath(f, 6.6, z, face, { lower: 0.55, spikes: 0.55, unfold: 0.15 });
    goliath(f, 9.8, z, face, { lower: 1, spikes: 1, unfold: 1, crane: 0.4 });
    goliath(f, 13.0, z, face, { droop: 1, pods: -0.45, eye: 0 });
    goliath(f, 16.2, z, face, { droop: 0.4, pods: 0.3, eye: 1, yaw: 0.6 });
    // lifted: hanging under two Condors on four cables
    const hx = 19.6;
    const lifted = goliath(f, hx, z, Math.PI / 2, { hang: 1 }, 0.55);
    lifted.root.updateMatrixWorld(true);
    const s = unitScale("condor");
    for (let side = 0; side < 2; side++) {
      const cz = z + (side ? 1.1 : -1.1);
      const c = instance(unitDef("condor", f));
      c.root.scale.setScalar(s);
      c.root.position.set(hx, 0.55 + 2.55 * unitScale("goliath") + 0.5, cz);
      c.body.rotation.y = -Math.PI / 2;
      stage.scene.add(c.root);
      for (const n of [-0.16, 0.16]) {
        const a = lifted.point(side ? "shoulderR" : "shoulderL", [side ? 0.1 : -0.1, 0.24, n], new THREE.Vector3());
        cableBetween(a, new THREE.Vector3(hx, c.root.position.y - 0.08, cz));
      }
    }
    // toppled forward over its toes, burnt
    const dead = goliath(f, 24.5, z, -Math.PI / 2, { droop: 1, pods: -0.45, eye: 0, lower: 0.5 });
    const body = dead.j.body;
    const pivot = new THREE.Vector3(0, 0, -0.5);
    body.rotation.set(-(Math.PI / 2 - 0.1), 0, 0);
    body.position.copy(pivot).sub(pivot.clone().applyEuler(body.rotation));
    setVariant(dead.root, "burnt");
    for (let i = 0; i < 4; i++) {
      const p = modelMesh(pileDef(f, i).hull);
      p.position.set(27 + (i % 2) * 1.1, 0, z - 1 + Math.floor(i / 2) * 1.6);
      stage.scene.add(p);
    }
    // in love
    goliath(f, 31, z, face, { love: 1, hug: 1, nod: -0.1 });
    // for scale
    const ti = instance(unitDef("mastodon", f));
    ti.root.scale.setScalar(unitScale("mastodon"));
    ti.body.rotation.y = -0.5;
    ti.root.position.set(34, 0, z);
    stage.scene.add(ti.root);
    const hq = instance(buildingDef("hq", f));
    hq.root.position.set(37, 0, z);
    stage.scene.add(hq.root);
    return;
  }
  if (only === "gantry") {
    const z = fi * 4.2;
    for (let i = 0; i < 6; i++) {
      const g = instance(buildingDef("gantry", f));
      const x = i * 3.6;
      g.root.position.set(x, 0, z);
      stage.scene.add(g.root);
      const P = g.parts;
      const building = i >= 1 && i <= 4;
      for (let k = 0; k < 4; k++) P[`stage${k}`]!.visible = k === i - 1;
      P.lightsOn!.visible = i >= 1;
      P.lightsOff!.visible = i < 1;
      P.blink!.visible = i === 4 || i === 5;
      const working = i >= 1 && i <= 3;
      P.jib!.rotation.set(working ? 0 : 0.03, working ? (i === 1 ? 0.72 : 2.11) : Math.PI, 0, "YXZ");
      P.cable!.visible = P.hook!.visible = P.plate!.visible = working;
      const r = i === 1 ? 0.53 : 1.51;
      const drop = i === 1 ? 2.6 : 1.1;
      P.cable!.position.set(0, 0, -r);
      P.cable!.scale.set(1, drop, 1);
      P.hook!.position.set(0, -drop, -r);
      if (i === 5) {
        // rollout: the arms swung clear, the finished Goliath stepping off the cradle
        P.armL!.rotation.y = P.armR!.rotation.y = 1.45;
        goliath(f, x, z + (f === "red" ? -1.2 : 1.2), f === "red" ? 0 : Math.PI, {}, 0.1);
      }
      if (building && i <= 3) {
        P.armL!.rotation.y = 0.1;
        P.armR!.rotation.y = -0.1;
      }
    }
    return;
  }
  if (only === "condor-ring") {
    // every heading, loaded, ramp up and down by turns
    for (let i = 0; i < 6; i++) condor(f, i * 2.1, 1.35, fi * 2.4, i % 3 ? ["trooper", "rocket-squad"] : ["sniper", "trooper"], i % 2, (-i * Math.PI) / 3);
    return;
  }
  if (only === "condor") {
    const z = fi * 2.6;
    condor(f, 0, 0.62, z, fi ? ["sniper", "trooper"] : ["trooper", "rocket-squad"], 1);
    condor(f, 2.4, 1.35, z, fi ? ["rocket-squad", "trooper"] : ["trooper", "sniper"], 0);
    condor(f, 4.8, 1.35, z, [], 0);
    const ti = instance(unitDef("mastodon", f));
    ti.root.scale.setScalar(unitScale("mastodon"));
    ti.body.rotation.y = cface;
    ti.root.position.set(7.1, 0, z);
    stage.scene.add(ti.root);
    const sq = new SquadRig("trooper", f, 3 + fi);
    sq.root.position.set(9.1, 0, z);
    sq.root.rotation.y = cface;
    stage.scene.add(sq.root);
    yard.push({ rig: sq, kind: "trooper", x: 9.1, z });
    const h = instance(unitDef("hornet", f));
    h.root.scale.setScalar(unitScale("hornet"));
    h.body.rotation.y = cface;
    h.root.position.set(11.1, 1.35, z);
    stage.scene.add(h.root);
    return;
  }
  if (only !== "buildings") {
    let x = 0;
    UNIT_KINDS.forEach((k) => {
      if ((BOTS as string[]).includes(k)) return;
      const inst = instance(unitDef(k, f));
      inst.root.scale.setScalar(unitScale(k));
      inst.body.rotation.y = -0.5;
      if (inst.turret) inst.turret.rotation.y = 0.6;
      if (inst.cargo) inst.cargo.visible = true;
      const w = box.setFromObject(inst.root).max.x - box.min.x;
      inst.root.position.set(x + w / 2, AIR.includes(k) ? 0.9 : 0, fi * 2.2 - 1.4);
      x += w + 0.35;
      stage.scene.add(inst.root);
    });
    // the infantry yard: a lane per squad
    BOTS.forEach((k, ki) => {
      const rig = new SquadRig(k, f, fi * 7 + ki + 1);
      const at = { rig, kind: k, x: ki * 3.2, z: fi * 1.3 - 4.4 };
      rig.root.position.set(at.x + 1.2, 0, at.z);
      rig.root.rotation.y = -Number(q.get("face") ?? 0.5);
      stage.scene.add(rig.root);
      yard.push(at);
    });
    // a loaded Condor, ramp down, hovering low beside them
    condor(f, 10.6, 0.75, fi * 1.9 - 4.4, fi ? ["sniper", "trooper"] : ["trooper", "rocket-squad"], 1);
  }
  if (only !== "units" && !only?.startsWith("condor"))
    BUILDING_KINDS.forEach((k, i) => {
      const inst = instance(buildingDef(k, f));
      inst.root.position.set(i * 3 - 1, 0, 4 + fi * 3.4);
      if (inst.turret) inst.turret.rotation.y = 0.5;
      stage.scene.add(inst.root);
    });
});
if (!only?.startsWith("condor") && only !== "goliath" && only !== "gantry" && only !== "icon") {
  const extras = [instance(uplinkDef()), instance(crateDef()), instance(podDef("blue")), instance(podDef("blue", true))];
  extras.forEach((e, i) => {
    e.root.position.set(-4, 0, -1 + i * 2.4);
    stage.scene.add(e.root);
  });
  const chute = modelMesh(chuteGeometry());
  chute.position.set(-6.5, 0.5, 2);
  stage.scene.add(chute);
  const rub = modelMesh(rubbleGeometry(2, 1));
  rub.position.set(-6.5, 0, 5.5);
  stage.scene.add(rub);
  const wreck = instance(unitDef("mastodon", "blue"));
  setVariant(wreck.root, "burnt");
  wreck.root.position.set(-6.5, 0, -1);
  stage.scene.add(wreck.root);
}

/** Advance every robot to animation time `t` (ms), in frame-sized steps from where it is. */
let now = 0;
function at(t: number): void {
  while (now < t) {
    const dt = Math.min(16, t - now);
    now += dt;
    for (const y of yard) {
      const n = UNITS[y.kind].squad ?? 1;
      const speed = anim === "walk" ? UNITS[y.kind].speed : 0;
      if (anim === "walk" && only !== "condor") {
        // march east along the lane, round and round
        y.rig.root.rotation.y = -Math.PI / 2;
        y.rig.root.position.x = y.x + ((now / 1000) * speed) % 2.6;
      }
      const cyc = (n + 2) * 1400;
      const alive = anim === "fall" ? Math.max(0, n - Math.floor((now % cyc) / 1400)) : n;
      y.rig.update({ dt, speed, aim: anim === "aim" ? 1 : 0, pitch: 0, alive });
    }
    for (const r of riders) r.rig.update({ dt, speed: 0, aim: 0, pitch: 0, alive: r.rig.spec.n, ready: r.ready });
    // Goliaths walking east along their row, round and round
    for (const g of walkers) {
      g.rig.root.position.x = g.x + ((now / 1000) * 1.0) % 3;
      g.rig.update({ ...REST_POSE, dt, speed: 1, ground: () => 0 });
    }
  }
}
const freeze = q.get("t");
if (freeze !== null) at(Number(freeze));

stage.rig.bounds = { x0: -100, y0: -100, x1: 100, y1: 100 };
const pitch = q.get("pitch");
if (pitch !== null) stage.rig.pitchFor = () => THREE.MathUtils.degToRad(Number(pitch));
stage.rig.zoom = Number(q.get("zoom") ?? 46);
// (the Goliath and Gantry line-ups open centred on themselves; an icon on the model)
const home = only === "goliath" ? [16, 2] : only === "gantry" ? [9, 1.5] : only === "icon" ? [0, 0] : [7, 4];
stage.rig.centerOn(Number(q.get("x") ?? home[0]), Number(q.get("y") ?? home[1]));
if (iconRoot && q.get("zoom") === null) frameIcon(iconRoot);

/**
 * Frame a portrait's model as the camera sees it: the middle of its bounds at
 * the centre of the view, and their projection filling 80% of it. Framing it
 * by its footprint on the ground let anything tall (the Radar's dish) rise off
 * the top.
 */
function frameIcon(o: THREE.Object3D): void {
  const rig = stage.rig;
  o.updateMatrixWorld(true);
  o.traverse((m) => (m as THREE.SkinnedMesh).isSkinnedMesh && (m as THREE.SkinnedMesh).computeBoundingBox());
  const b = new THREE.Box3().setFromObject(o, true);
  const c = b.getCenter(new THREE.Vector3());
  // (the ground point the camera looks at to put the middle at the centre, at this zoom's pitch)
  const look = () => rig.centerOn(c.x, c.z - c.y / Math.tan(rig.pitchFor(rig.zoom)));
  for (let i = 0; i < 4; i++) {
    look();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z]) {
          const p = rig.project(x, z, y);
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
          y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
    rig.zoom *= (0.8 * Math.min(innerWidth, innerHeight)) / Math.max(x1 - x0, y1 - y0);
  }
  look();
}
let last = performance.now();
const loop = () => {
  const t = performance.now();
  if (freeze === null && anim !== "still") at(now + Math.min(50, t - last));
  last = t;
  stage.render();
  requestAnimationFrame(loop);
};
loop();
addEventListener("resize", () => stage.resize());
(window as unknown as { ready: boolean; gallery: { at(ms: number): void } }).ready = true;
(window as unknown as { gallery: { at(ms: number): void } }).gallery = { at };
