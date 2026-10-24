import { describe, expect, it } from "vitest";
import { PRAISE_S, TUT2_BEATS, TUT2_STEPS, TUT_BEATS, TUT_STEPS, TutorialRunner, type TutObs } from "../src/game/tutorial";
import { TUTORIAL2_OP, TUTORIAL_OP, TUTORIAL_SPOTS, OPS, opById, setupOp, tickOps } from "../src/sim/ops";
import { createMapWorld } from "../src/sim/maps";
import { step } from "../src/sim/sim";
import { passable } from "../src/sim/world";

/** A fresh match as the lesson first sees it: nothing done yet. */
function obs(over: Partial<TutObs> = {}): TutObs {
  return {
    touch: true, belle: true, panned: 0, zoomRatio: 1,
    starters: 2, startersSelected: 0, selected: 0, headingToFlag: false, atFlag: false,
    patrolSpawned: false, patrolSeen: false, patrolAlive: 0, patrolAttacked: false,
    busy: false, drawerOpen: false, tab: "build", pending: null, placing: null, forges: 0,
    panhards: 2, panhardsQueued: 0, army: 2, armySelected: false, harvested: 0,
    barrageReady: false, fanOpen: false, armed: null, barrageFired: 0,
    convoySpawned: false, convoySeen: false, convoyAlive: 0,
    outpostSpawned: false, outpostAlive: 0, outpostOrdered: false, armyIdle: true, cardOpen: false,
    panhardsSelected: 0, troopsSelected: 0, frameArmed: false, squad1: 0, squad1Selected: false,
    routed: 0, marched: 0, skilled: 0, retreated: 0, retreatArmed: false, troopsIdle: false, idlePicked: false,
    t: 0,
    ...over
  };
}

/** Feed the same observation for `secs` (0.1 s frames); the last frame. */
function hold(r: TutorialRunner, o: TutObs, secs = 0.1) {
  let f = r.update(o, 0.1);
  for (let i = 1; i < Math.round(secs * 10); i++) f = r.update(o, 0.1);
  return f;
}

/** Run until the runner reaches beat `id` (praise included), feeding `o`. */
function until(r: TutorialRunner, id: string, o: TutObs) {
  for (let i = 0; i < 200 && r.beat.id !== id; i++) r.update(o, 0.1);
  expect(r.beat.id).toBe(id);
}

describe("l'Instruction: the lesson", () => {
  it("covers the ten steps in order, at most ~10 words per instruction", () => {
    const steps = TUT_BEATS.map((b) => b.step);
    expect(steps[0]).toBe(1);
    expect(steps.at(-1)).toBe(TUT_STEPS);
    for (let i = 1; i < steps.length; i++) expect(steps[i]! - steps[i - 1]!).toBeGreaterThanOrEqual(0);
    expect(new Set(steps).size).toBe(TUT_STEPS);
    // every instruction any beat can give, in every state worth trying
    const states = [obs(), obs({ touch: false }), obs({ drawerOpen: true }), obs({ drawerOpen: true, tab: "ground" }), obs({ selected: 1, startersSelected: 1 }),
      obs({ patrolSeen: true }), obs({ patrolSeen: true, selected: 1 }), obs({ convoySeen: true, barrageReady: true }), obs({ convoySeen: true, barrageReady: true, fanOpen: true }),
      obs({ convoySeen: true, armed: "barrage" }), obs({ placing: "fab-plant" }), obs({ outpostOrdered: true })];
    for (const b of TUT_BEATS)
      for (const s of states) {
        const g = b.guide(s);
        expect(g.text.split(/\s+/).length, `${b.id}: ${g.text}`).toBeLessThanOrEqual(10);
      }
  });

  it("waits for the player, then praises and moves on", () => {
    const r = new TutorialRunner();
    let f = hold(r, obs(), 3);
    expect(f.beat.id).toBe("pan");
    expect(f.phase).toBe("do");
    expect(f.guide?.target).toEqual({ kind: "gesture", g: "drag" });
    // a drag of 4 tiles does it
    f = r.update(obs({ panned: 4 }), 0.1);
    expect(f.phase).toBe("praise");
    expect(f.praise).toBe("Parfait !");
    // praise holds for PRAISE_S, then the next instruction
    f = hold(r, obs({ panned: 0 }), PRAISE_S - 0.3);
    expect(f.phase).toBe("praise");
    f = hold(r, obs(), 0.5);
    expect(f.beat.id).toBe("zoom");
    expect(f.guide?.text).toMatch(/Pince/);
  });

  it("judges the camera beats from their own start", () => {
    const r = new TutorialRunner();
    // a camera already far from where the lesson began is not a drag yet
    const f = r.update(obs({ panned: 9, zoomRatio: 2 }), 0.1);
    expect(f.beat.id).toBe("pan");
    expect(f.phase).toBe("do");
    expect(r.update(obs({ panned: 4 }), 0.1).phase).toBe("praise");
  });

  it("asks for the mouse wheel and the arrow keys on a desktop", () => {
    const r = new TutorialRunner();
    expect(hold(r, obs({ touch: false })).guide?.target).toEqual({ kind: "gesture", g: "keys" });
    r.update(obs({ touch: false, panned: 5 }), 0.1);
    until(r, "zoom", obs({ touch: false }));
    expect(hold(r, obs({ touch: false })).guide?.target).toEqual({ kind: "gesture", g: "wheel" });
    r.update(obs({ touch: false, zoomRatio: 0.7 }), 0.1);
    until(r, "select", obs({ touch: false }));
  });

  it("re-points gently when the player does something else", () => {
    const r = new TutorialRunner();
    r.index = TUT_BEATS.findIndex((b) => b.id === "move");
    // nothing selected: select first
    let f = hold(r, obs());
    expect(f.guide?.text).toBe("Touche d'abord un Panhard");
    expect(f.guide?.target).toEqual({ kind: "world", what: "starters" });
    // selected: the flag
    f = hold(r, obs({ selected: 1, startersSelected: 1 }));
    expect(f.guide?.target).toEqual({ kind: "world", what: "flag" });
    expect(f.guide?.hand).toBe(true);
    // on the way: no hand, just the flag
    f = hold(r, obs({ selected: 1, startersSelected: 1, headingToFlag: true }));
    expect(f.guide?.hand).toBe(false);
    // went elsewhere and deselected: back to "select first"
    f = hold(r, obs());
    expect(f.guide?.text).toBe("Touche d'abord un Panhard");
  });

  it("walks the build drawer one control at a time", () => {
    const r = new TutorialRunner();
    r.index = TUT_BEATS.findIndex((b) => b.id === "forges");
    expect(hold(r, obs()).guide?.target).toEqual({ kind: "dom", el: "build" });
    expect(hold(r, obs({ drawerOpen: true, tab: "air" })).guide?.target).toEqual({ kind: "dom", el: "tab-build" });
    expect(hold(r, obs({ drawerOpen: true })).guide?.target).toEqual({ kind: "dom", el: "tile-forges" });
    // the original HUD has no drawer
    expect(hold(r, obs({ belle: false })).guide?.target).toEqual({ kind: "dom", el: "tile-forges" });
    let f = r.update(obs({ drawerOpen: true, pending: { kind: "fab-plant", ready: false } }), 0.1);
    expect(f.phase).toBe("praise");
    until(r, "forges-wait", obs({ drawerOpen: true, pending: { kind: "fab-plant", ready: false } }));
    f = hold(r, obs({ drawerOpen: true, pending: { kind: "fab-plant", ready: false } }));
    expect(f.guide?.hand).toBe(false);
    // ready: (no praise for waiting) straight on to placing it
    r.update(obs({ drawerOpen: true, pending: { kind: "fab-plant", ready: true } }), 0.1);
    f = hold(r, obs({ drawerOpen: true, pending: { kind: "fab-plant", ready: true } }));
    expect(f.beat.id).toBe("place");
    expect(f.guide?.target).toEqual({ kind: "dom", el: "tile-forges" });
    f = hold(r, obs({ placing: "fab-plant", pending: { kind: "fab-plant", ready: true } }));
    expect(f.guide?.target).toEqual({ kind: "world", what: "ghost" });
    f = r.update(obs({ forges: 1 }), 0.1);
    expect(f.praise).toBe("Les Forges sont debout !");
  });

  it("skips beats the player already did, without praise", () => {
    const r = new TutorialRunner();
    r.index = TUT_BEATS.findIndex((b) => b.id === "forges");
    // Forges already standing (built ahead of the lesson): forges, forges-wait and place all pass
    const f = hold(r, obs({ forges: 1 }));
    expect(f.beat.id).toBe("produce");
    expect(r.log).toEqual(["forges:skip", "forges-wait:skip", "place:skip"]);
  });

  it("freezes the battle while the enemy waits on the player's tap", () => {
    const r = new TutorialRunner();
    r.index = TUT_BEATS.findIndex((b) => b.id === "attack");
    expect(r.update(obs(), 0.1).effects).toEqual(["spawn-patrol"]);
    let f = hold(r, obs({ patrolSpawned: true, patrolAlive: 2 }));
    expect(f.effects).toEqual([]);
    expect(f.guide?.hold).toBeFalsy(); // (the patrol is still driving in)
    f = hold(r, obs({ patrolSpawned: true, patrolAlive: 2, patrolSeen: true }));
    expect(f.guide?.hold).toBe(true);
    expect(f.guide?.text).toBe("Touche d'abord un Panhard");
    f = hold(r, obs({ patrolSpawned: true, patrolAlive: 2, patrolSeen: true, selected: 2 }));
    expect(f.guide?.target).toEqual({ kind: "world", what: "patrol" });
    expect(f.guide?.hold).toBe(true);
    f = hold(r, obs({ patrolSpawned: true, patrolAlive: 2, patrolSeen: true, selected: 2, patrolAttacked: true }));
    expect(f.guide?.hold).toBeFalsy();
    f = r.update(obs({ patrolSpawned: true, patrolAlive: 0, patrolSeen: true }), 0.1);
    expect(f.praise).toMatch(/Victoire/);
  });

  it("runs the spawn effects and the voice once, on entry", () => {
    const r = new TutorialRunner();
    const first = r.update(obs(), 0.1);
    expect(first.voice).toBe("Essai radio");
    expect(r.update(obs(), 0.1).voice).toBeNull();
    r.index = TUT_BEATS.findIndex((b) => b.id === "power");
    const f = r.update(obs(), 0.1);
    expect(f.effects).toEqual(["spawn-convoy", "fill-meter"]);
    expect(r.update(obs(), 0.1).effects).toEqual([]);
    // (a spawning beat is never skipped on entry, even if its "done" looks true before the spawn)
    r.index = TUT_BEATS.findIndex((b) => b.id === "outpost");
    const g = r.update(obs({ outpostAlive: 0 }), 0.1);
    expect(g.effects).toEqual(["spawn-outpost"]);
    expect(g.phase).toBe("do");
  });

  it("plays the whole lesson through to the end", () => {
    const r = new TutorialRunner();
    const o = obs();
    const say = (patch: Partial<TutObs>, secs = 0.3) => {
      Object.assign(o, patch);
      return hold(r, o, secs);
    };
    say({}, 1);
    say({ panned: 5 }, 2);
    say({ zoomRatio: 1.5 }, 2);
    say({ startersSelected: 1, selected: 1 }, 2);
    say({ headingToFlag: true, atFlag: true }, 2);
    say({ patrolSpawned: true, patrolAlive: 2, patrolSeen: true, patrolAttacked: true }, 0.5);
    say({ patrolAlive: 0 }, 2);
    say({ drawerOpen: true, pending: { kind: "fab-plant", ready: false } }, 2);
    say({ pending: { kind: "fab-plant", ready: true } }, 0.5);
    say({ pending: null, forges: 1 }, 2);
    say({ tab: "ground", panhardsQueued: 1 }, 2);
    expect(r.beat.id).toBe("info");
    say({ cardOpen: true }, 2);
    say({ cardOpen: false, panhardsQueued: 0, panhards: 3, army: 3 }, 2);
    say({ drawerOpen: false, selected: 3, armySelected: true }, 2);
    say({}, 12); // the coal beats run on their own clock
    expect(r.beat.id).toBe("power");
    say({ convoySpawned: true, convoyAlive: 3, convoySeen: true, barrageReady: true, fanOpen: true, armed: "barrage" }, 0.5);
    say({ barrageFired: 1, armed: null }, 2);
    say({ convoyAlive: 0 }, 2);
    expect(r.beat.id).toBe("outpost");
    say({ outpostSpawned: true, outpostAlive: 2, outpostOrdered: true }, 1);
    const end = say({ outpostAlive: 0 }, 0.1);
    expect(end.phase).toBe("end");
    expect(end.praise).toBe("Tu es prêt, mon commandant !");
    expect(r.over || r.index === TUT_BEATS.length - 1).toBe(true);
    expect(r.log.filter((id) => !id.endsWith(":skip"))).toEqual(TUT_BEATS.map((b) => b.id));
  });
});

describe("l'Instruction: the op", () => {
  it("is found by id but is not a campaign op", () => {
    expect(opById("instruction")).toBe(TUTORIAL_OP);
    expect(OPS.includes(TUTORIAL_OP)).toBe(false);
  });

  it("opens on a quiet field: two Panhard, a Fardier, no enemy units", () => {
    const w = createMapWorld(TUTORIAL_OP.map, { seed: 7, op: TUTORIAL_OP.id });
    const mine = [...w.units.values()].filter((u) => u.faction === "blue").map((u) => u.kind).sort();
    expect(mine).toEqual(["harvester", "stinger", "stinger"]);
    expect([...w.units.values()].filter((u) => u.faction === "red")).toEqual([]);
    expect(w.ops?.tags.starters?.length).toBe(2);
    // the flag and the outpost stand on open ground
    for (const p of [TUTORIAL_SPOTS.flag, TUTORIAL_SPOTS.turret, TUTORIAL_SPOTS.depot]) expect(passable(w, Math.floor(p.x), Math.floor(p.y), "ground")).toBe(true);
    // a minute of nothing happening decides nothing
    for (let i = 0; i < 600; i++) step(w, []);
    expect(w.winner).toBeNull();
    expect(w.ops?.result).toBeNull();
  });

  it("is won with every star once the outpost falls", () => {
    const w = createMapWorld(TUTORIAL_OP.map, { seed: 7, op: TUTORIAL_OP.id });
    w.ops!.killed.turret = 1;
    w.ops!.killed.depot = 1;
    while (w.tick % 10 !== 0) w.tick++;
    tickOps(w);
    expect(w.ops?.result?.won).toBe(true);
    expect(w.ops?.result?.stars).toBe(7);
    expect(w.winner).toBe("blue");
  });

  it("setupOp ignores unknown ids", () => {
    const w = createMapWorld(TUTORIAL_OP.map, { seed: 7 });
    setupOp(w, "nope");
    expect(w.ops).toBeUndefined();
  });
});

describe("« Deuxième jour »: the lesson", () => {
  it("covers its eight steps in order, at most ~10 words per instruction", () => {
    const steps = TUT2_BEATS.map((b) => b.step);
    expect(steps[0]).toBe(1);
    expect(steps.at(-1)).toBe(TUT2_STEPS);
    for (let i = 1; i < steps.length; i++) expect(steps[i]! - steps[i - 1]!).toBeGreaterThanOrEqual(0);
    expect(new Set(steps).size).toBe(TUT2_STEPS);
    const states = [obs(), obs({ touch: false }), obs({ belle: false }), obs({ selected: 4, panhardsSelected: 4 }), obs({ frameArmed: true }), obs({ squad1: 6 }),
      obs({ selected: 6, retreatArmed: true }), obs({ troopsIdle: true }), obs({ troopsIdle: true, busy: true }), obs({ outpostOrdered: true })];
    for (const b of TUT2_BEATS)
      for (const st of states) {
        const g = b.guide(st);
        expect(g.text.split(/\s+/).length, `${b.id}: ${g.text}`).toBeLessThanOrEqual(10);
      }
  });

  it("points at ▢ Cadre first, then the troop", () => {
    const r = new TutorialRunner(TUT2_BEATS);
    r.index = TUT2_BEATS.findIndex((b) => b.id === "frame");
    expect(hold(r, obs()).guide?.target).toEqual({ kind: "dom", el: "frame" });
    expect(hold(r, obs({ frameArmed: true })).guide?.target).toEqual({ kind: "world", what: "troop" });
    // the original bar has no ▢ Cadre: hold and drag
    expect(hold(r, obs({ belle: false })).guide?.text).toMatch(/Maintiens/);
  });

  it("skips the drawn gestures with a mouse", () => {
    const r = new TutorialRunner(TUT2_BEATS);
    r.index = TUT2_BEATS.findIndex((b) => b.id === "route");
    const f = hold(r, obs({ touch: false, selected: 6 }));
    expect(f.beat.id).toBe("retreat");
    expect(r.log).toEqual(["route:skip", "march:skip"]);
  });

  it("plays the whole lesson through to the end", () => {
    const r = new TutorialRunner(TUT2_BEATS);
    const o = obs();
    const say = (patch: Partial<TutObs>, secs = 0.3) => {
      Object.assign(o, patch);
      return hold(r, o, secs);
    };
    expect(say({}, 1).effects).toEqual([]);
    say({ selected: 4, panhardsSelected: 4 }, 2);
    expect(r.beat.id).toBe("frame");
    say({ selected: 0, panhardsSelected: 0 }, 0.3);
    say({ selected: 6, panhardsSelected: 4, troopsSelected: 2 }, 2);
    say({ squad1: 6 }, 2);
    expect(r.beat.id).toBe("recall");
    say({ squad1Selected: true }, 2);
    say({ routed: 2 }, 2);
    say({ marched: 1 }, 2);
    expect(r.beat.id).toBe("retreat");
    say({ retreatArmed: true }, 0.3);
    say({ retreatArmed: false, retreated: 1 }, 2);
    expect(r.beat.id).toBe("idle");
    say({ selected: 0, troopsIdle: true, panhardsSelected: 0, troopsSelected: 0 }, 0.3);
    say({ selected: 2, troopsSelected: 2, idlePicked: true }, 2);
    expect(r.beat.id).toBe("skill");
    say({ selected: 4, panhardsSelected: 4, troopsSelected: 0, outpostSpawned: true, outpostAlive: 2 }, 0.3);
    say({ skilled: 1 }, 2);
    say({ outpostOrdered: true }, 1);
    const end = say({ outpostAlive: 0 }, 0.1);
    expect(end.phase).toBe("end");
    expect(end.praise).toMatch(/Deuxième jour/);
    expect(r.log.filter((id) => !id.endsWith(":skip"))).toEqual(TUT2_BEATS.map((b) => b.id));
  });
});

describe("« Deuxième jour »: the op", () => {
  it("is found by id, outside the books, on the same ground", () => {
    expect(opById("instruction-2")).toBe(TUTORIAL2_OP);
    expect(OPS.includes(TUTORIAL2_OP)).toBe(false);
    expect(TUTORIAL2_OP.tutorial).toBe(true);
    expect(TUTORIAL2_OP.map).toBe(TUTORIAL_OP.map);
  });

  it("opens with four Panhard and two squads, nobody on the enemy side", () => {
    const w = createMapWorld(TUTORIAL2_OP.map, { seed: 7, op: TUTORIAL2_OP.id });
    const mine = [...w.units.values()].filter((u) => u.faction === "blue").map((u) => u.kind).sort();
    expect(mine).toEqual(["harvester", "stinger", "stinger", "stinger", "stinger", "trooper", "trooper"]);
    expect([...w.units.values()].filter((u) => u.faction === "red")).toEqual([]);
    expect(w.ops?.tags.panhards?.length).toBe(4);
    expect(w.ops?.tags.troops?.length).toBe(2);
    for (const p of [TUTORIAL_SPOTS.home, TUTORIAL_SPOTS.scout]) expect(passable(w, Math.floor(p.x), Math.floor(p.y), "ground")).toBe(true);
    for (let i = 0; i < 600; i++) step(w, []);
    expect(w.winner).toBeNull();
  });
});
