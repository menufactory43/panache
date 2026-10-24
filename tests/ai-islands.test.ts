import { describe, expect, it } from "vitest";
import { AIRLIFT, airliftActive, islandRelays } from "../src/sim/ai/airlift";
import { STRATEGIES, createAiState, tickAi, type AiState, type Difficulty, type StrategyName } from "../src/sim/ai/commander";
import { dropsCondors } from "../src/sim/ai/condor";
import { veteranRetreats } from "../src/sim/ai/veterans";
import { OBJECTIVES, TICK_RATE, UNITS } from "../src/sim/balance";
import { engageable } from "../src/sim/combat";
import { isInfantry } from "../src/sim/infantry";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { Terrain, type Command, type Faction, type FxEvent, type Unit, type Uplink, type World } from "../src/sim/types";
import { buildingCenter, canGetWithin, hqOf, isResource, moveClassOf, regionAt, setTerrain, spawnUnit } from "../src/sim/world";
import { playMatch } from "../tools/pacing-match";

/**
 * The commander on the island map (Archipelago: every Uplink on an island
 * only robot infantry can take, flown in by Condor). ai/airlift.ts flies the
 * squads out and keeps the relays crewed; the rest of the commander never
 * sends a unit where it can't go.
 */

const world = () => createMapWorld("archipelago", { objectives: true });
const relays = (w: World) => islandRelays(w);
const footRegion = (w: World, p: { x: number; y: number }) => regionAt(w, Math.floor(p.x), Math.floor(p.y), "foot");
const onIsland = (w: World, u: Unit, l: Uplink) => footRegion(w, u) === footRegion(w, l);
const inZone = (u: { x: number; y: number }, l: Uplink) => Math.hypot(u.x - l.x, u.y - l.y) <= OBJECTIVES.uplink.radius;
const ours = (w: World, f: Faction) => [...w.units.values()].filter((u) => u.faction === f);

/** Red's AI alone (blue sits still) for `secs`; returns every command it gave. */
function runRed(w: World, secs: number, s: AiState): Command[] {
  const out: Command[] = [];
  for (let i = 0; i < secs * TICK_RATE && !w.winner; i++) {
    const cmds = tickAi(w, "red", s);
    out.push(...cmds);
    step(w, cmds);
  }
  return out;
}

/** Hand `f` a relay with a squad standing on it (bar full). */
function hold(w: World, f: Faction, l: Uplink, kind: Unit["kind"] = "trooper"): Unit {
  l.owner = f;
  l.progress = f === "blue" ? 100 : -100;
  return spawnUnit(w, kind, f, l.x, l.y);
}

describe("AI airlift (island relays)", () => {
  it("runs on the island map for every personality and difficulty, and the harvester raids step aside", () => {
    const w = world();
    for (const d of ["easy", "normal", "hard"] as Difficulty[])
      for (const name of Object.keys(STRATEGIES) as StrategyName[]) {
        const s = createAiState(name, d, 1);
        expect(airliftActive(w, "red", s)).toBe(true);
        expect(dropsCondors(w, "red", s)).toBe(false);
      }
    // no island relays: no airlift (the other maps play as before)
    expect(airliftActive(createMapWorld("riverlands", { objectives: true }), "red")).toBe(false);
    expect(airliftActive(createMapWorld("archipelago"), "red")).toBe(false); // (objectives off: no relays at all)
  });

  for (const name of Object.keys(STRATEGIES) as StrategyName[])
    it(`${name} flies its starting squad to an island relay and takes it inside the first minute and a half`, () => {
      const w = world();
      const cmds = runRed(w, 90, createAiState(name, "normal", 3));
      const held = relays(w).filter((l) => l.owner === "red");
      expect(held.length).toBeGreaterThanOrEqual(1);
      expect(held.some((l) => l.crewed)).toBe(true);
      // by Condor: an unload order onto the relay's own island
      const drops = cmds.filter((c): c is Extract<Command, { type: "unload" }> => c.type === "unload" && c.x !== undefined);
      expect(drops.some((c) => relays(w).some((l) => footRegion(w, { x: c.x!, y: c.y! }) === footRegion(w, l)))).toBe(true);
    });

  it("on Easy it airlifts too, a little later, to neutral relays only", () => {
    const w = world();
    // the enemy holds the centre (crewed): Easy leaves it alone
    const centre = relays(w).find((l) => l.x === 54 && l.y === 54)!;
    hold(w, "blue", centre);
    const s = createAiState("balanced", "easy", 3);
    const cmds = runRed(w, 150, s);
    const unloads = cmds.filter((c): c is Extract<Command, { type: "unload" }> => c.type === "unload" && c.x !== undefined);
    expect(unloads.length).toBeGreaterThan(0);
    for (const c of unloads) expect(footRegion(w, { x: c.x!, y: c.y! })).not.toBe(footRegion(w, centre));
    expect(relays(w).some((l) => l.owner === "red")).toBe(true);
    expect(centre.owner).toBe("blue");
  });

  it("keeps a held relay crewed: a lost garrison is replaced by air, a wandering one walks back", () => {
    const w = world();
    const all = relays(w);
    // red holds every relay, crewed — but one garrison is wiped out
    const squads = all.map((l) => hold(w, "red", l));
    const bare = all.find((l) => l.x === 101.5 && l.y === 73)!; // red's own home isle
    w.units.delete(squads[all.indexOf(bare)]!.id);
    // and another squad has wandered to its island's edge
    const far = all.find((l) => l.x === 54 && l.y === 54)!;
    const stray = squads[all.indexOf(far)]!;
    stray.x = far.x + 3.6;
    stray.y = far.y;
    expect(onIsland(w, stray, far)).toBe(true);
    spawnUnit(w, "trooper", "red", hqOf(w, "red")!.tx - 2, hqOf(w, "red")!.ty + 2);
    const s = createAiState("boom", "normal", 5);
    runRed(w, 60, s);
    expect(inZone(stray, far)).toBe(true);
    expect(bare.owner).toBe("red");
    expect(bare.crewed).toBe(true);
  });

  it("with nobody free at home, flies a secured island's spare squads on to a relay that needs them", () => {
    const w = world();
    const all = relays(w);
    // red holds every relay but one, crewed; its own home isle has three squads on it
    const spareIsle = all.find((l) => l.x === 101.5 && l.y === 73)!;
    const open = all.find((l) => l.x === 73 && l.y === 99.5)!; // blue's home isle, left neutral
    for (const l of all) if (l !== open) hold(w, "red", l);
    const spares = [hold(w, "red", spareIsle), hold(w, "red", spareIsle)];
    // its Condor is empty, and no squad waits at home
    const condor = ours(w, "red").find((u) => u.kind === "condor")!;
    condor.passengers = [];
    for (const u of ours(w, "red")) if (isInfantry(u.kind) && !relays(w).some((l) => onIsland(w, u, l))) w.units.delete(u.id);
    const s = createAiState("balanced", "normal", 4);
    const drops: { x: number; y: number; ids: number[] }[] = [];
    for (let i = 0; i < 90 * TICK_RATE; i++) {
      step(w, tickAi(w, "red", s));
      for (const ev of w.fx as FxEvent[]) if (ev.type === "disembark" && ev.faction === "red") drops.push({ x: ev.x, y: ev.y, ids: ev.unitIds });
    }
    const moved = drops.find((d) => d.ids.some((id) => spares.some((u) => u.id === id)));
    expect(moved).toBeDefined();
    expect(footRegion(w, moved!)).not.toBe(footRegion(w, spareIsle));
    expect(relays(w).filter((l) => l.owner === "red").length).toBeGreaterThanOrEqual(all.length - 1);
    expect(spareIsle.crewed).toBe(true);
  });

  it("intercepts an enemy Condor near its relays with Raptors (the threat response ignores unarmed dropships)", () => {
    const w = world();
    const l = relays(w).find((r) => r.x === 101.5 && r.y === 73)!;
    hold(w, "red", l);
    const hq = buildingCenter(hqOf(w, "red")!);
    const raptors = [0, 1].map((i) => spawnUnit(w, "raptor", "red", hq.x - 2 - i, hq.y + 3));
    const condor = spawnUnit(w, "condor", "blue", l.x - 4, l.y + 1); // in the relay's sight
    condor.order = { type: "move", x: l.x - 4, y: l.y + 1 };
    const s = createAiState("ironclad", "normal", 2);
    let attacked = false;
    for (let i = 0; i < 6 * TICK_RATE && !attacked; i++) {
      const cmds = tickAi(w, "red", s);
      attacked = cmds.some((c) => c.type === "attack" && c.targetId === condor.id && c.unitIds.some((id) => raptors.some((r) => r.id === id)));
      step(w, cmds);
    }
    expect(attacked).toBe(true);
  });

  it("strikes an enemy island garrison with its Wasps", () => {
    const w = world();
    const l = relays(w).find((r) => r.x === 18 && r.y === 18.5)!;
    const enemy = hold(w, "blue", l);
    const hq = buildingCenter(hqOf(w, "red")!);
    const wasps = [0, 1, 2].map((i) => spawnUnit(w, "wasp", "red", hq.x - 2 - i, hq.y + 3));
    const s = createAiState("skyforce", "normal", 2);
    const cmds = runRed(w, 4, s);
    const strike = cmds.find((c) => c.type === "attackMove" && Math.hypot(c.x - l.x, c.y - l.y) < 1 && c.unitIds.some((id) => wasps.some((u) => u.id === id)));
    expect(strike).toBeDefined();
    runRed(w, 40, s);
    expect(w.units.has(enemy.id)).toBe(false);
  });

  it("island squads don't count toward a wave they can't walk to", () => {
    const w = world();
    // 2,000 scrap of squads, all on islands: well over Balanced's assault bar, none of it at home
    const all = relays(w);
    for (let i = 0; i < 20; i++) {
      const l = all[i % all.length]!;
      hold(w, "red", l);
    }
    const s = createAiState("balanced", "normal", 1);
    runRed(w, 6, s);
    expect(s.mode).not.toBe("assault");
  });

  it("keeps its harvesters on its own side of the bridges, and builds none once its fields are dry", () => {
    const w = world();
    const hq = buildingCenter(hqOf(w, "red")!);
    const blueHq = buildingCenter(hqOf(w, "blue")!);
    // red's fields are mined out; blue's are untouched
    for (let ty = 0; ty < w.height; ty++)
      for (let tx = 0; tx < w.width; tx++)
        if (isResource(w, ty * w.width + tx) && Math.hypot(tx + 0.5 - hq.x, ty + 0.5 - hq.y) < Math.hypot(tx + 0.5 - blueHq.x, ty + 0.5 - blueHq.y))
          setTerrain(w, tx, ty, Terrain.Ground);
    w.factions.red.scrap = 2000;
    const before = ours(w, "red").filter((u) => u.kind === "harvester").length;
    const s = createAiState("rush", "normal", 1);
    const cmds = runRed(w, 60, s);
    expect(cmds.some((c) => c.type === "produce" && c.unit === "harvester")).toBe(false);
    for (const h of ours(w, "red").filter((u) => u.kind === "harvester"))
      expect(Math.hypot(h.x - hq.x, h.y - hq.y)).toBeLessThan(Math.hypot(h.x - blueHq.x, h.y - blueHq.y));
    expect(ours(w, "red").filter((u) => u.kind === "harvester").length).toBe(before);
  });

  it("a wounded veteran falls back to a Mender it can walk to, never one over the sea; one on an island holds", () => {
    const w = world();
    const hq = buildingCenter(hqOf(w, "red")!);
    // a red veteran deep in blue's land (over a bridge from home)
    const vet = spawnUnit(w, "trooper", "red", 46.5, 68.5);
    vet.rank = 2;
    vet.hp = UNITS.trooper.hp * 0.2;
    expect(regionAt(w, 46, 68, "foot")).toBe(regionAt(w, Math.floor(hq.x), Math.floor(hq.y) + 3, "foot"));
    // a Mender nearer home, but hovering over the lagoon
    const mender = spawnUnit(w, "mender", "red", 64.5, 56.5);
    expect(regionAt(w, 64, 56, "foot")).toBe(0);
    const islander = hold(w, "red", relays(w).find((l) => l.x === 101.5 && l.y === 73)!);
    islander.rank = 2;
    islander.hp = UNITS.trooper.hp * 0.2;
    const used = new Set<number>();
    const cmds = veteranRetreats("red", [vet, mender, islander], hq, used, w);
    const order = cmds.find((c) => c.type === "move" && c.unitIds.includes(vet.id)) as Extract<Command, { type: "move" }>;
    expect(order).toBeDefined();
    expect(canGetWithin(w, "foot", vet.x, vet.y, order.x, order.y, 1)).toBe(true);
    expect(Math.hypot(order.x - mender.x, order.y - mender.y)).toBeGreaterThan(3);
    expect(cmds.some((c) => "unitIds" in c && c.unitIds.includes(islander.id))).toBe(false);
    expect(used.has(islander.id)).toBe(true);
  });

  it("AI vs AI: no unit is ever sent where it can't go (no tank, Wasp crew or Condor-less squad at an island relay)", () => {
    const w = world();
    const ai = { blue: createAiState("ironclad", "normal", 7), red: createAiState("airswarm", "normal", 8) };
    const bad: string[] = [];
    const held = new Set<Faction>();
    for (let i = 0; i < 7 * 60 * TICK_RATE && !w.winner; i++) {
      const cmds = [...tickAi(w, "blue", ai.blue), ...tickAi(w, "red", ai.red)];
      for (const c of cmds) {
        if (c.type !== "move" && c.type !== "attackMove" && c.type !== "attack" && c.type !== "harvest") continue;
        for (const id of c.unitIds) {
          const u = w.units.get(id);
          if (!u || UNITS[u.kind].domain === "air") continue;
          const ok =
            c.type === "attack" ? engageable(w, u, c.targetId) : canGetWithin(w, moveClassOf(u.kind), u.x, u.y, c.x, c.y, 2.5);
          if (!ok) bad.push(`${(w.tick / TICK_RATE).toFixed(0)}s ${u.faction} ${u.kind} ${c.type}`);
          // only squads standing on a relay's island are ever ordered onto it
          if (c.type !== "attack")
            for (const l of relays(w))
              if (Math.hypot(c.x - l.x, c.y - l.y) <= 3) expect(isInfantry(u.kind) && onIsland(w, u, l)).toBe(true);
        }
      }
      step(w, cmds);
      for (const l of relays(w)) if (l.owner) held.add(l.owner);
    }
    expect(bad).toEqual([]);
    // and both sides were out on the islands
    expect([...held].sort()).toEqual(["blue", "red"]);
  }, 60000);

  it("AI vs AI on Archipelago: both sides take islands inside 2 minutes, relays change hands, and the match is decided", () => {
    // (no Goliaths: this is about the airlift and the relays. With them, about 1 match in 5 of this
    // pairing is still level at 25:00, a Goliath dug in behind its defences: AI-GOLIATH-NOTES.md.
    // No unit skills either, for the same reason: this seed plays to a draw with them, tests/skills.test.ts has those)
    const m = playMatch("archipelago", "balanced", "ironclad", 7013, 13, { noGoliath: true, noSkills: true });
    expect(m.firstIsland.blue).not.toBeNull();
    expect(m.firstIsland.red).not.toBeNull();
    expect(m.firstIsland.blue!).toBeLessThanOrEqual(120);
    expect(m.firstIsland.red!).toBeLessThanOrEqual(120);
    expect(m.islandRetakes.blue + m.islandRetakes.red).toBeGreaterThanOrEqual(1);
    expect(m.unloads.relay).toBeGreaterThan(m.unloads.elsewhere);
    expect(m.winner).not.toBe("draw");
  }, 90000);

  it("the airlift's numbers hang together", () => {
    expect(AIRLIFT.condors.easy).toBeLessThanOrEqual(AIRLIFT.condors.normal);
    expect(AIRLIFT.from.easy).toBeGreaterThan(AIRLIFT.from.normal);
    expect(AIRLIFT.landShort).toBeLessThan(OBJECTIVES.uplink.radius - 0.5);
  });
});
