/**
 * Orders → Commands (AGENT-BATTLES.md "Orders"). An agent writes the sim's
 * own command vocabulary without the faction (and in its own frame), plus a
 * few shortcuts: unit selectors ("idle army", "all stinger", "army near
 * 30,25"), "build" with or without a spot, "produce" at whichever building
 * makes the unit. Each order comes back "ok" or with the reason it was
 * refused, in the HUD's words (buildingBlocker, unitBlocker,
 * placementBlocker, calldownBlocker).
 *
 * Orders are checked against a staged copy of the world — the state the
 * side saw this round with its own earlier orders already applied — so a
 * second "produce" sees the scrap the first one spent. The commands that
 * come out carry the side's faction and true map coordinates; the arena
 * applies them at the first tick of the next stretch of play.
 */
import { BUILDINGS, ECONOMY, GOLIATH, UNITS } from "../sim/balance";
import {
  applyEconomyCommand,
  buildingBlocker,
  canPlaceBuilding,
  nearestReachableResource,
  producerCap,
  producersOf,
  queuesOf,
  trainBlocker,
  unitBlocker,
  type Producer
} from "../sim/economy";
import { UNIT_IN_THE_WAY, anchorBlocker, anchoredGoliaths, applyGoliathCommand, goliathReachAt, orderedToMove, packUpBlocker, unitCost } from "../sim/goliath";
import { unitSeenBy, isInfantry, isTransport } from "../sim/infantry";
import { applyLiftCommand, liftBlocker, liftedBy, routeLiftCommand } from "../sim/lift";
import { OPENER_IDS, isOpenerId, openerBlocked, type OpenerId } from "../sim/openers";
import { PLURALS } from "../sim/lexicon";
import { placementBlocker } from "../sim/placement";
import { POWER_KINDS, applyCalldown, calldownBlocker } from "../sim/powers";
import { applyTransportCommand, freeSeats, isLoaded } from "../sim/transport";
import type { Building, BuildingKind, Command, Faction, PowerKind, Unit, UnitKind, World } from "../sim/types";
import { buildingCenter, distToBuilding, domainOf, hqOf, inBounds, isResource, tileIndex } from "../sim/world";
import { enemyOf, frameOf, type Frame } from "./frame";

export const UNIT_KINDS = Object.keys(UNITS) as UnitKind[];
export const BUILDING_KINDS = Object.keys(BUILDINGS) as BuildingKind[];

/** Units that fight (not harvesters, not the unarmed Condor and Scout). */
export const isArmy = (k: UnitKind): boolean => k !== "harvester" && k !== "condor" && k !== "scout";

/** A building the side wants placed when its construction is ready (world top-left, or a spot to pick). */
export interface BuildIntent {
  kind: BuildingKind;
  at: [number, number] | null;
}

export interface OrderBatch {
  commands: Command[];
  /** One line per order: "1. ok: …" or "1. refused: …". */
  results: string[];
  opener?: OpenerId;
  /** Set when a "build" started a building (or moved where a pending one goes). */
  build?: BuildIntent;
  /** Set when the building under construction was cancelled. */
  cancelBuild?: boolean;
}

class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why);
};

/** Accept "attack_move", "attackMove", "attack-move"… (and "Éole" as "eole", "d'artificiers" as "dartificiers"). */
const norm = (k: string) =>
  k
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-_\s'’.]/g, "");

const VERBS = ["opener", "attackmove", "move", "attack", "stop", "harvest", "produce", "cancel", "build", "sell", "rally", "calldown", "board", "unload", "anchor", "packup", "pack", "lift"] as const;
type Verb = (typeof VERBS)[number];

/**
 * Other names agents may use for a kind, besides its id and its name in
 * balance.ts: the Belle Époque short forms and plurals, the English names
 * of the original game, and the earlier French names (before the reskin).
 */
const UNIT_ALIASES: Partial<Record<UnitKind, string[]>> = {
  harvester: ["Fardiers", "Harvester", "Récolteur"],
  scout: ["Patries", "Scout", "Éclaireur", "dirigeable"],
  stinger: ["Stinger", "Dard"],
  "flak-crawler": ["Flak Crawler", "flak", "Arpenteur DCA", "Arpenteur", "DCA"],
  mortar: ["Canons de 75", "75", "Mortar", "Mortier"],
  mastodon: ["Mastodon", "Mastodonte"],
  lancer: ["Hydroglisseurs", "Hydro", "Lancer", "Lancier"],
  wasp: ["Wasp", "Guêpe"],
  raptor: ["Raptor", "Rapace"],
  hornet: ["Hornet", "Frelon"],
  mender: ["Mender", "Réparateur"],
  trooper: ["Pioupious", "Pioupiou", "Escouades de pioupious", "Trooper Squad", "Escouade de fantassins", "Fantassins"],
  "rocket-squad": ["Artificiers", "Artificier", "Escouades d'artificiers", "rocket", "Rocket Squad", "Escouade lance-roquettes", "Lance-roquettes"],
  sniper: ["Chasseurs alpins", "Chasseurs", "Sections de chasseurs alpins", "Sniper Team", "Équipe de snipers", "Snipers"],
  condor: ["Montgolfières", "Montgolfiere", "Condor"],
  goliath: ["Gargantuas", "Goliath"]
};
const BUILDING_ALIASES: Partial<Record<BuildingKind, string[]>> = {
  hq: ["Grand Quartier Général", "HQ", "QG"],
  "fab-plant": ["Forge", "fab", "factory", "Fab Plant", "Usine"],
  airpad: ["Chalais-Meudon", "Meudon", "Chalais", "Airpad", "Aérodrome"],
  "tech-lab": ["Polytechnique", "Tech Lab", "Labo tech", "Labo"],
  depot: ["Halles", "Depot", "Dépôt"],
  turret: ["Hotchkiss", "Turret", "Tourelle"],
  "sam-site": ["Ruggieri", "Batteries Ruggieri", "sam", "SAM Site", "Batterie SAM"],
  radar: ["Tour TSF", "TSF", "Radar"],
  "assembly-bay": ["Manufactures", "Assembly Bay", "Atelier d'assemblage", "Atelier"],
  gantry: ["Galerie", "Galerie des Machines", "Gantry", "Portique"]
};
const UNIT_WORDS = new Map<string, UnitKind>();
for (const k of UNIT_KINDS)
  for (const name of [k, UNITS[k].name, PLURALS[k], ...(UNIT_ALIASES[k] ?? [])]) {
    UNIT_WORDS.set(norm(name), k);
    UNIT_WORDS.set(norm(name) + "s", k);
  }
const BUILDING_WORDS = new Map<string, BuildingKind>();
for (const k of BUILDING_KINDS)
  for (const name of [k, BUILDINGS[k].name, PLURALS[k], ...(BUILDING_ALIASES[k] ?? [])]) {
    BUILDING_WORDS.set(norm(name), k);
    BUILDING_WORDS.set(norm(name) + "s", k);
  }

/** The kind named by a word ("stingers", "Flak Crawler", "flak", "Panhard", "Éole", "Faucheux"). */
export function unitKindOf(s: string): UnitKind | null {
  return UNIT_WORDS.get(norm(s)) ?? null;
}

/** The building named by a word ("fab-plant", "factory", "Forges", "Polytechnique", "Batterie Ruggieri"). */
export function buildingKindOf(s: string): BuildingKind | null {
  return BUILDING_WORDS.get(norm(s)) ?? null;
}

const an = (s: string) => `${/^[aeiou]/.test(s) ? "an" : "a"} ${s}`;
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

/** "stinger ×3, wasp" for a set of units. */
function describe(units: Unit[]): string {
  const m = new Map<UnitKind, number>();
  for (const u of units) m.set(u.kind, (m.get(u.kind) ?? 0) + 1);
  return [...m].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ");
}

/**
 * Parse and check a list of orders for `side` against `staged` (mutated: its
 * economy and unit orders advance as each order is accepted).
 */
export function parseOrders(staged: World, side: Faction, orders: unknown, phase: "opener" | "play"): OrderBatch {
  const fr = frameOf(staged, side);
  const out: OrderBatch = { commands: [], results: [] };
  let list: unknown[];
  if (typeof orders === "string") {
    try {
      list = JSON.parse(orders) as unknown[];
    } catch {
      out.results.push(`refused: orders must be a JSON list of order objects, got ${JSON.stringify(orders).slice(0, 80)}`);
      return out;
    }
  } else list = orders as unknown[];
  if (!Array.isArray(list)) list = [list];
  list.forEach((raw, i) => {
    const n = i + 1;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse(`expected an object like {"move": [12], "to": [30, 25]}`);
      const o = Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [norm(k), v]));
      const verb = VERBS.find((v) => v in o) as Verb | undefined;
      if (!verb) refuse(`unknown order ${JSON.stringify(raw).slice(0, 80)}: use one of move, attack_move, attack, stop, harvest, produce, cancel, build, sell, rally, calldown, board, unload, anchor, pack_up, lift`);
      if (phase === "opener" && verb !== "opener") {
        if (OPENER_IDS.every((id) => openerBlocked(staged, side, id))) refuse("the deployment round hasn't ended: call end_round to begin play (openers are disabled by these match rules)");
        refuse(`the battle hasn't started: pick an opener first with {"opener": "blitz" | "industry" | "airwing"}`);
      }
      const msg = one(staged, fr, side, verb!, o, out);
      out.results.push(`${n}. ok: ${msg}`);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      out.results.push(`${n}. refused: ${e.message}`);
    }
  });
  if (list.length === 0) out.results.push("(no orders given)");
  return out;
}

function one(w: World, fr: Frame, side: Faction, verb: Verb, o: Record<string, unknown>, out: OrderBatch): string {
  const faction = side;
  switch (verb) {
    case "opener": {
      if (out.opener) refuse(`you already picked ${out.opener}`);
      const id = String(o.opener).toLowerCase().replace(/[^a-z]/g, "");
      if (!isOpenerId(id)) refuse(`no opener "${o.opener}": pick one of ${OPENER_IDS.join(", ")}`);
      const why = openerBlocked(w, side, id as OpenerId);
      if (why) refuse(why);
      out.opener = id as OpenerId;
      return `opener ${id}`;
    }
    case "move":
    case "attackmove": {
      const units = selectUnits(w, fr, side, verb === "move" ? o.move : o.attackmove);
      const p = point(w, fr, side, o.to ?? o.at, "to");
      const type = verb === "move" ? "move" : "attackMove";
      const unitIds = units.map((u) => u.id);
      const command: Extract<Command, { type: "move" | "attackMove" }> = { type, faction, unitIds, x: p.x, y: p.y };
      out.commands.push(command);
      stageUnitCommand(w, command);
      return `${describe(units)} ${verb === "move" ? "move" : "attack-move"} to ${fr.tile(p.x, p.y).join(",")}`;
    }
    case "attack": {
      const units = selectUnits(w, fr, side, o.attack);
      const targetId = idOf(o.target ?? o.at);
      if (targetId === null) refuse(`attack needs a "target": an enemy id`);
      const target = enemyTarget(w, side, targetId!);
      const domain = target.domain;
      const able = units.filter((u) => canHit(u, domain));
      const skipped = units.filter((u) => !canHit(u, domain));
      if (able.length === 0 && units.some((u) => u.goliath?.lift)) refuse("carried Goliaths fire automatically: move or attack-move the lift, then unload to land before giving an attack order");
      if (able.length === 0) refuse(`none of ${describe(units)} can hit a ${domain === "air" ? "flying" : "ground"} target like ${target.label}`);
      const command: Command = { type: "attack", faction, unitIds: able.map((u) => u.id), targetId: targetId! };
      out.commands.push(command);
      stageUnitCommand(w, command);
      return `${describe(able)} attack ${target.label}${skipped.length ? ` (skipped ${describe(skipped)}: can't hit it)` : ""}`;
    }
    case "stop": {
      const units = selectUnits(w, fr, side, o.stop);
      const command: Command = { type: "stop", faction, unitIds: units.map((u) => u.id) };
      out.commands.push(command);
      stageUnitCommand(w, command);
      return `${describe(units)} stop`;
    }
    case "harvest": {
      const units = selectUnits(w, fr, side, o.harvest).filter((u) => u.kind === "harvester");
      if (units.length === 0) refuse("only harvesters harvest");
      let tile: [number, number];
      if (o.at !== undefined) {
        const p = point(w, fr, side, o.at, "at");
        tile = [Math.floor(p.x), Math.floor(p.y)];
        if (!isResource(w, tileIndex(w, tile[0], tile[1]))) refuse(`${fr.tile(p.x, p.y).join(",")} is not a scrap or crystal tile with anything left`);
      } else {
        const f = nearestReachableResource(w, units[0]!.x, units[0]!.y, side);
        if (!f) refuse("no field left that a harvester can reach");
        tile = [f!.x, f!.y];
      }
      out.commands.push({ type: "harvest", faction, unitIds: units.map((u) => u.id), x: tile[0] + 0.5, y: tile[1] + 0.5 });
      for (const u of units) u.order = { type: "harvest", fieldX: tile[0], fieldY: tile[1], phase: "toField" };
      return `${plural(units.length, "harvester")} harvest at ${fr.tile(tile[0] + 0.5, tile[1] + 0.5).join(",")}`;
    }
    case "produce": {
      const kind = unitKindOf(String(o.produce));
      if (!kind) refuse(`no unit "${o.produce}": one of ${UNIT_KINDS.join(", ")}`);
      const count = Math.max(1, Math.min(ECONOMY.maxQueue * 4, Math.floor(Number(o.count ?? 1)) || 1));
      const st = UNITS[kind!];
      let at: Producer[];
      if (o.at !== undefined) {
        const p = ownProducer(w, side, o.at);
        if (!p.goliath) {
          const b = w.buildings.get(p.id)!;
          if (b.kind !== st.builtAt) refuse(`${kind} is built at a ${st.builtAt}, not at ${b.kind} #${b.id}`);
        }
        const why = p.goliath ? trainBlocker(w, p.goliath, kind!) : unitBlocker(w, side, kind!);
        if (why) refuse(why);
        at = [p];
      } else {
        const why = unitBlocker(w, side, kind!);
        if (why) refuse(why);
        at = producersOf(w, side, kind!);
      }
      const queued: number[] = [];
      const before = w.factions[side].scrap;
      const cap = producerCap(kind!);
      let stop = "";
      for (let i = 0; i < count; i++) {
        const f = w.factions[side];
        const cost = unitCost(w, side, kind!);
        if (f.scrap < cost) {
          stop = `Not enough scrap (have ${Math.floor(f.scrap)}, need ${cost})`;
          break;
        }
        // The producer with the shortest queue (ties: the one listed first in your frame).
        const open = at.filter((p) => p.queue.length < cap).sort((a, b) => a.queue.length - b.queue.length || producerPos(w, fr, a) - producerPos(w, fr, b));
        const b = open[0];
        if (!b) {
          stop = `Queue full (${cap} per producer)`;
          break;
        }
        applyEconomyCommand(w, { type: "produce", faction, buildingId: b.id, unit: kind! });
        queued.push(b.id);
      }
      if (queued.length === 0) refuse(stop);
      const where = [...new Set(queued)].map((id) => producerLabel(w, id)).join(", ");
      for (const id of queued) out.commands.push({ type: "produce", faction, buildingId: id, unit: kind! });
      return `queued ${queued.length} ${kind} at ${where} (-${before - w.factions[side].scrap} scrap)${queued.length < count ? `; ${count - queued.length} not queued: ${stop}` : ""}`;
    }
    case "cancel": {
      const what = String(o.cancel);
      const f = w.factions[side];
      const bk = buildingKindOf(what);
      if (["building", "construction", "build"].includes(what.toLowerCase()) || (bk && o.at === undefined && f.pending?.kind === bk)) {
        if (!f.pending) refuse("nothing is under construction");
        const kind = f.pending!.kind;
        applyEconomyCommand(w, { type: "cancelBuilding", faction });
        out.commands.push({ type: "cancelBuilding", faction });
        out.cancelBuild = true;
        return `cancelled the ${kind} (+${BUILDINGS[kind].cost} scrap)`;
      }
      const kind = unitKindOf(what);
      if (!kind) refuse(`cancel what? a unit kind (with "at": building or Goliath id) or "building"`);
      const b = o.at !== undefined ? ownProducer(w, side, o.at) : queuesOf(w, side, kind!).filter((p) => p.queue.some((q) => q.kind === kind)).sort((a, c) => producerPos(w, fr, a) - producerPos(w, fr, c))[0];
      if (!b || !b.queue.some((q) => q.kind === kind)) refuse(`no ${kind} queued${b ? ` at ${producerLabel(w, b.id)}` : ""}`);
      const before = f.scrap;
      applyEconomyCommand(w, { type: "cancelProduce", faction, buildingId: b!.id, unit: kind! });
      out.commands.push({ type: "cancelProduce", faction, buildingId: b!.id, unit: kind! });
      return `cancelled ${an(kind!)} at ${producerLabel(w, b!.id)} (+${f.scrap - before} scrap)`;
    }
    case "build": {
      const kind = buildingKindOf(String(o.build));
      if (!kind) refuse(`no building "${o.build}": one of ${BUILDING_KINDS.filter((k) => k !== "hq").join(", ")}`);
      const f = w.factions[side];
      let at: [number, number] | null = null;
      if (o.at !== undefined) {
        const xy = coords(o.at);
        if (!xy) refuse(`"at" must be [x, y]: the building's top-left tile`);
        at = fr.worldTopLeft(kind!, xy![0], xy![1]);
        const why = placementBlocker(w, side, kind!, at[0], at[1]);
        // (a unit standing there may move off before it's ready: placing then decides)
        if (why && why !== UNIT_IN_THE_WAY) refuse(`can't put ${an(kind!)} at ${xy![0]},${xy![1]}: ${why}`);
      }
      if (f.pending) {
        if (f.pending.kind === kind && at) {
          out.build = { kind: kind!, at };
          return `the ${kind} under construction will go at ${fr.topLeft(kind!, at[0], at[1]).join(",")}`;
        }
        refuse(`already building ${an(f.pending.kind)} (${f.pending.ready ? "ready, being placed" : `${Math.ceil(f.pending.remaining / 10)}s left`}): one building at a time`);
      }
      const why = buildingBlocker(w, side, kind!);
      if (why) refuse(why);
      if (f.scrap < BUILDINGS[kind!].cost) refuse(`Not enough scrap (have ${Math.floor(f.scrap)}, need ${BUILDINGS[kind!].cost})`);
      applyEconomyCommand(w, { type: "startBuilding", faction, building: kind! });
      out.commands.push({ type: "startBuilding", faction, building: kind! });
      out.build = { kind: kind!, at };
      return `started building ${an(kind!)} (-${BUILDINGS[kind!].cost} scrap, ready in ${BUILDINGS[kind!].buildTime}s)${at ? `, to go at ${fr.topLeft(kind!, at[0], at[1]).join(",")}` : ", placed automatically when ready"}`;
    }
    case "sell": {
      const b = ownBuilding(w, side, o.sell);
      if (b.kind === "hq") refuse("you can't sell your HQ");
      const before = w.factions[side].scrap;
      applyEconomyCommand(w, { type: "sell", faction, buildingId: b.id });
      out.commands.push({ type: "sell", faction, buildingId: b.id });
      return `sold ${b.kind} #${b.id} (+${Math.round(w.factions[side].scrap - before)} scrap)`;
    }
    case "rally": {
      const b = ownProducer(w, side, o.rally);
      const p = point(w, fr, side, o.to ?? o.at, "to");
      applyEconomyCommand(w, { type: "rally", faction, buildingId: b.id, x: p.x, y: p.y });
      out.commands.push({ type: "rally", faction, buildingId: b.id, x: p.x, y: p.y });
      return `${producerLabel(w, b.id)} rallies to ${fr.tile(p.x, p.y).join(",")}`;
    }
    case "calldown": {
      const power = String(o.calldown).toLowerCase().replace(/[^a-z]/g, "").replace("skyhammer", "hammer") as PowerKind;
      if (!POWER_KINDS.includes(power)) refuse(`no calldown "${o.calldown}": one of ${POWER_KINDS.join(", ")}`);
      const p = point(w, fr, side, o.at ?? o.to, "at");
      const why = calldownBlocker(w, side, power, p.x, p.y);
      if (why) refuse(why);
      applyCalldown(w, { type: "calldown", faction, power, x: p.x, y: p.y });
      out.commands.push({ type: "calldown", faction, power, x: p.x, y: p.y });
      return `${power} called on ${fr.tile(p.x, p.y).join(",")}`;
    }
    case "board": {
      const squads = selectUnits(w, fr, side, o.board).filter((u) => isInfantry(u.kind));
      if (squads.length === 0) refuse("only infantry squads (trooper, rocket-squad, sniper) can board");
      const id = idOf(o.condor ?? o.into ?? o.carrier);
      const c = id === null ? undefined : w.units.get(id);
      if (!c || c.faction !== side || !isTransport(c.kind)) refuse(`board needs "condor": the id of one of your Condors`);
      if (liftedBy(w, c!)) refuse(`Condor #${c!.id} is lifting a Goliath: unload the Goliath before boarding infantry`);
      const seats = freeSeats(c!);
      if (seats <= 0) refuse(`Condor #${c!.id} is full: unload it first`);
      const going = squads.slice(0, seats);
      out.commands.push({ type: "board", faction, unitIds: going.map((u) => u.id), carrierId: c!.id });
      for (const u of going) u.order = { type: "board", carrierId: c!.id, ticks: 0 };
      return `${describe(going)} board Condor #${c!.id}${going.length < squads.length ? ` (only ${seats} seat${seats > 1 ? "s" : ""} free)` : ""}`;
    }
    case "unload": {
      const units = selectUnits(w, fr, side, o.unload);
      const loaded = units.filter((u) => isLoaded(u) || (u.goliath?.lift ?? liftedBy(w, u)?.goliath?.lift)?.phase === "carrying");
      if (loaded.length === 0) refuse(`${describe(units)} carrying nobody: unload a loaded Condor or an airborne Goliath (or one of its carriers)`);
      const p = o.at !== undefined || o.to !== undefined ? point(w, fr, side, o.at ?? o.to, "at") : null;
      const command: Command = p ? { type: "unload", faction, unitIds: loaded.map((u) => u.id), x: p.x, y: p.y } : { type: "unload", faction, unitIds: loaded.map((u) => u.id) };
      out.commands.push(command);
      stageUnitCommand(w, command);
      return `${describe(loaded)} unload ${p ? `at ${fr.tile(p.x, p.y).join(",")}` : "where they are"}`;
    }
    case "anchor":
    case "packup":
    case "pack": {
      const units = selectUnits(w, fr, side, o[verb]).filter((u) => u.goliath);
      if (units.length === 0) refuse("only Goliaths anchor or pack up");
      const type = verb === "anchor" ? "anchor" : "packUp";
      const accepted: Unit[] = [];
      const skipped: string[] = [];
      for (const u of units) {
        const why = type === "anchor" ? anchorBlocker(w, u) : packUpBlocker(u);
        if (why) skipped.push(`#${u.id}: ${why}`);
        else {
          applyGoliathCommand(w, { type, faction, unitIds: [u.id] });
          accepted.push(u);
        }
      }
      if (!accepted.length) refuse(skipped.join("; "));
      out.commands.push({ type, faction, unitIds: accepted.map((u) => u.id) });
      return `${describe(accepted)} ${type === "anchor" ? "anchoring" : "packing up"}${skipped.length ? ` (skipped ${skipped.join("; ")})` : ""}`;
    }
    case "lift": {
      const condors = selectUnits(w, fr, side, o.lift).filter((u) => isTransport(u.kind));
      const id = idOf(o.goliath ?? o.target ?? o.at);
      const g = id === null ? undefined : w.units.get(id);
      if (!g || g.faction !== side || !g.goliath) refuse(`lift needs "goliath": the id of one of your Goliaths`);
      const why = liftBlocker(condors, g!);
      if (why) refuse(why);
      const command: Command = { type: "lift", faction, unitIds: condors.map((u) => u.id), goliathId: g!.id };
      applyLiftCommand(w, command);
      out.commands.push(command);
      return `Condors ${g!.goliath!.lift!.carriers.map((id) => `#${id}`).join(", ")} hooking onto Goliath #${g!.id}`;
    }
  }
}

// ---------------------------------------------------------------- helpers ---

/** Stage unit orders with the same lift routing as the live sim; a carrier keeps its lift order while flying the group. */
function stageUnitCommand(w: World, c: Extract<Command, { type: "move" | "attackMove" | "attack" | "stop" | "unload" }>): void {
  const handled = routeLiftCommand(w, c);
  if (c.type === "unload") {
    applyTransportCommand(w, { ...c, unitIds: c.unitIds.filter((id) => !handled.has(id)) });
    return;
  }
  for (const id of c.unitIds) {
    const u = w.units.get(id);
    if (!u || u.faction !== c.faction || handled.has(id)) continue;
    u.path = null;
    if (c.type === "attack") u.order = { type: "attack", targetId: c.targetId };
    else {
      u.autoTargetId = null;
      if (c.type === "stop") u.order = { type: "idle" };
      else {
        u.order = { type: c.type, x: c.x, y: c.y };
        orderedToMove(w, u);
      }
    }
  }
}

const pos = (fr: Frame, b: Building) => {
  const [x, y] = fr.topLeft(b.kind, b.tx, b.ty);
  return y * 4096 + x;
};

function canHit(u: Unit, domain: "ground" | "air"): boolean {
  if (u.goliath) return !u.goliath.lift && goliathReachAt(u, domain) > 0;
  const t = UNITS[u.kind].targets;
  return UNITS[u.kind].dps > 0 && (t === "both" || t === domain);
}

function producerPos(w: World, fr: Frame, p: Producer): number {
  if (!p.goliath) return pos(fr, w.buildings.get(p.id)!);
  const [x, y] = fr.tile(p.goliath.x, p.goliath.y);
  return y * 4096 + x;
}

function producerLabel(w: World, id: number): string {
  return `${w.buildings.get(id)?.kind ?? "goliath"} #${id}`;
}

function ownProducer(w: World, side: Faction, v: unknown): Producer {
  const id = idOf(v);
  const b = id === null ? undefined : w.buildings.get(id);
  if (b?.faction === side) return { id: b.id, queue: b.queue, goliath: null };
  const g = id === null ? undefined : w.units.get(id);
  if (g?.faction === side && g.goliath) return { id: g.id, queue: g.goliath.queue, goliath: g };
  return refuse(`${JSON.stringify(v)} is not one of your buildings or Goliaths`);
}

/** An id from 23, "23" or "#23". */
function idOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^#?\d+$/.test(v.trim())) return Number(v.trim().replace("#", ""));
  return null;
}

/** [x, y] from [12, 34], "12,34", {x, y}. */
function coords(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2 && v.every((n) => typeof n === "number" || (typeof n === "string" && n.trim() !== "" && !isNaN(Number(n)))))
    return [Number(v[0]), Number(v[1])];
  if (typeof v === "string") {
    const m = /^\s*\[?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\]?\s*$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  if (v && typeof v === "object" && "x" in v && "y" in v) return [Number((v as { x: unknown }).x), Number((v as { y: unknown }).y)];
  return null;
}

/** A target point (world coordinates) from own-frame [x, y], "enemy-hq" or "#id". */
function point(w: World, fr: Frame, side: Faction, v: unknown, key: string): { x: number; y: number } {
  if (v === undefined) refuse(`needs "${key}": [x, y]`);
  if (typeof v === "string" && /enemy.?hq/i.test(v)) {
    // public knowledge: the enemy HQ is the mirror image of yours
    const hq = hqOf(w, side);
    if (!hq) refuse("you have no HQ to mirror");
    const c = buildingCenter(hq!);
    return { x: w.width - c.x, y: w.height - c.y };
  }
  const id = typeof v === "string" && v.trim().startsWith("#") ? idOf(v) : null;
  if (id !== null) {
    const u = w.units.get(id);
    if (u && (u.faction === side || unitSeenBy(w, side, u))) return { x: u.x, y: u.y };
    const b = w.buildings.get(id);
    if (b && b.faction === side) return buildingCenter(b);
    const kb = w.fog[side].known.get(id);
    if (kb) {
      const s = BUILDINGS[kb.kind].size;
      return { x: kb.tx + s / 2, y: kb.ty + s / 2 };
    }
    refuse(`#${id} is not a unit or building you can see`);
  }
  const xy = coords(v);
  if (!xy || !xy.every(Number.isFinite)) refuse(`"${key}" must be [x, y], got ${JSON.stringify(v)}`);
  const [x, y] = xy!;
  if (x < 0 || y < 0 || x >= w.width || y >= w.height) refuse(`${x},${y} is off the map (0-${w.width - 1}, 0-${w.height - 1})`);
  return fr.center(x, y);
}

function ownBuilding(w: World, side: Faction, v: unknown): Building {
  const id = idOf(v);
  const b = id === null ? undefined : w.buildings.get(id);
  if (!b || b.faction !== side) refuse(`${JSON.stringify(v)} is not one of your buildings`);
  return b!;
}

/** An enemy the side may target: a unit it sees now, or a building it remembers. */
function enemyTarget(w: World, side: Faction, id: number): { domain: "ground" | "air"; label: string } {
  const u = w.units.get(id);
  if (u && u.faction === enemyOf(side)) {
    if (!unitSeenBy(w, side, u)) refuse(`enemy #${id} is not in sight`);
    return { domain: domainOf(u), label: `${u.kind} #${id}` };
  }
  const kb = w.fog[side].known.get(id);
  if (kb) return { domain: "ground", label: `${kb.kind} #${id}` };
  if (u || w.buildings.get(id)?.faction === side) refuse(`#${id} is one of yours`);
  return refuse(`#${id} is not an enemy you can see or remember`);
}

/**
 * Units from a list of ids and selector strings: "army", "all", "idle army",
 * "stinger"/"all stingers", "idle wasp", "army near 30,25" (6 tiles) or
 * "stinger near 30,25 r4".
 */
export function selectUnits(w: World, fr: Frame, side: Faction, spec: unknown): Unit[] {
  if (spec === undefined || spec === null) refuse("which units? give ids or a selector like \"army\"");
  const items = Array.isArray(spec) ? spec : [spec];
  const picked = new Map<number, Unit>();
  for (const item of items) {
    const id = idOf(item);
    if (id !== null) {
      const u = w.units.get(id);
      if (!u || u.faction !== side) refuse(notAUnit(w, side, id, items));
      picked.set(id, u!);
      continue;
    }
    if (typeof item !== "string") refuse(`can't read unit ${JSON.stringify(item)}`);
    for (const u of selector(w, fr, side, item as string)) picked.set(u.id, u);
  }
  if (picked.size === 0) refuse(`no units match ${JSON.stringify(spec)}`);
  return [...picked.values()];
}

/** Why `id` in a unit list isn't one of the side's units, and what was probably meant. */
function notAUnit(w: World, side: Faction, id: number, items: unknown[]): string {
  const aboard = [...w.units.values()].find((c) => c.faction === side && c.passengers?.some((p) => p.id === id));
  if (aboard) return `#${id} is aboard Condor #${aboard.id}: unload it first`;
  if (w.buildings.get(id)?.faction === side) return `#${id} is one of your buildings, not a unit`;
  const u = w.units.get(id);
  if (u && unitSeenBy(w, side, u)) return `#${id} is an enemy ${u.kind}: give your own units, and the enemy as the "target" of an attack`;
  // [28, 38]: a tile where unit ids belong
  const looksLikeTile = items.length === 2 && items.every((v) => typeof v === "number" && v >= 0 && v < Math.max(w.width, w.height));
  if (looksLikeTile) return `#${id} is not one of your units: unit lists take unit ids ("#97") or selectors ("army"); a tile [x, y] goes in "to"`;
  return `#${id} is not one of your units (destroyed, or never yours): use the ids in this round's observation`;
}

function selector(w: World, fr: Frame, side: Faction, s: string): Unit[] {
  let text = s.trim().toLowerCase();
  let near: { x: number; y: number; r: number } | null = null;
  const m = /\s*(?:near|at|around)\s+(-?\d+)\s*[, ]\s*(-?\d+)(?:\s*(?:r|radius)\s*(\d+))?\s*$/.exec(text);
  if (m) {
    near = { x: Number(m[1]) + 0.5, y: Number(m[2]) + 0.5, r: m[3] ? Number(m[3]) : 6 };
    text = text.slice(0, m.index).trim();
  }
  const idle = /\bidle\b/.test(text);
  text = text.replace(/\bidle\b/, "").replace(/\ball\b/, "").replace(/\bmy\b/, "").replace(/\bunits?\b/, "").trim();
  let match: (k: UnitKind) => boolean;
  if (text === "" || text === "everything") match = () => true;
  else if (text === "army" || text === "combat") match = isArmy;
  else if (text === "infantry" || text === "squads") match = (k) => isInfantry(k);
  else if (text === "air" || text === "aircraft") match = (k) => UNITS[k].domain === "air" && isArmy(k);
  else if (text === "ground" || text === "tanks" || text === "vehicles") match = (k) => UNITS[k].domain === "ground" && isArmy(k) && !isInfantry(k);
  else {
    const k = unitKindOf(text);
    if (!k) refuse(`can't read selector "${s}": try "army", "all", "idle army", "stinger", "army near 30,25"`);
    match = (x) => x === k;
  }
  const out: Unit[] = [];
  for (const u of w.units.values()) {
    if (u.faction !== side || !match(u.kind)) continue;
    if (idle && u.order.type !== "idle") continue;
    if (near) {
      const p = fr.pt(u.x, u.y);
      if (Math.hypot(p.x - near.x, p.y - near.y) > near.r) continue;
    }
    out.push(u);
  }
  return out;
}

// -------------------------------------------------------------- placement ---

/** Would this footprint leave no free tile along any side (walling in)? (ai/commander.ts tooCramped) */
function tooCramped(w: World, tx: number, ty: number, size: number): boolean {
  let free = 0;
  for (let i = -1; i <= size; i++)
    for (const [x, y] of [
      [tx + i, ty - 1],
      [tx + i, ty + size],
      [tx - 1, ty + i],
      [tx + size, ty + i]
    ] as [number, number][]) {
      if (!inBounds(w, x, y)) continue;
      if (w.occupancy[y * w.width + x] === 0) free++;
    }
  return free < (size + 2) * 2;
}

/**
 * Where to put a building nobody chose a spot for (world top-left), the way
 * the built-in commander picks: production by the HQ, defences and radar
 * toward the enemy, a depot by the nearest field no drop-off serves. Found
 * in the side's own frame, so mirror-image bases get mirror-image spots.
 * `near` (world point) overrides the anchor.
 */
export function suggestSpot(w: World, side: Faction, kind: BuildingKind, near?: { x: number; y: number }): [number, number] | null {
  const fr = frameOf(w, side);
  const hq = hqOf(w, side);
  const size = BUILDINGS[kind].size;
  const own = [...w.buildings.values()].filter((b) => b.faction === side);
  const bases = own.filter((b) => !b.outpost);
  const framed = (p: { x: number; y: number }) => fr.pt(p.x, p.y);
  const goliaths = anchoredGoliaths(w, side).sort((a, b) => {
    const ap = framed(a);
    const bp = framed(b);
    return ap.y - bp.y || ap.x - bp.x || a.id - b.id;
  });
  if (bases.length === 0 && goliaths.length === 0) return null;
  const home = framed(hq || bases[0] ? buildingCenter(hq ?? bases[0]!) : goliaths[0]!);
  const toward = (d: number) => {
    const cx = w.width / 2;
    const cy = w.height / 2;
    const len = Math.max(1, Math.hypot(cx - home.x, cy - home.y));
    return { x: home.x + ((cx - home.x) / len) * d, y: home.y + ((cy - home.y) / len) * d };
  };
  let anchor = near ? fr.pt(near.x, near.y) : home;
  if (!near) {
    if (kind === "turret" || kind === "sam-site") anchor = toward(5);
    else if (kind === "radar") anchor = toward(4);
    else if (kind === "depot") {
      // the nearest field (own frame scan order) that no drop-off already serves
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      const drops = own.filter((b) => BUILDINGS[b.kind].dropOff);
      for (let fy = 0; fy < w.height; fy++)
        for (let fx = 0; fx < w.width; fx++) {
          const [tx, ty] = fr.worldTile(fx, fy);
          if (!isResource(w, ty * w.width + tx)) continue;
          if (drops.some((b) => distToBuilding(b, tx + 0.5, ty + 0.5) < 7)) continue;
          if (goliaths.some((g) => Math.hypot(g.x - tx - 0.5, g.y - ty - 0.5) < 7)) continue;
          const d = Math.hypot(fx + 0.5 - home.x, fy + 0.5 - home.y);
          if (d < bestD) [best, bestD] = [{ x: fx + 0.5, y: fy + 0.5 }, d];
        }
      if (best) anchor = best;
    }
  }
  let spot: [number, number] | null = null;
  let bestScore = Infinity;
  const r = Math.max(ECONOMY.buildRadius, goliaths.length ? GOLIATH.buildRing : 0) + size;
  for (const root of [...bases.map(buildingCenter), ...goliaths]) {
    const c = framed(root);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const fx = Math.round(c.x + dx - size / 2);
        const fy = Math.round(c.y + dy - size / 2);
        const score = Math.hypot(fx + size / 2 - anchor.x, fy + size / 2 - anchor.y);
        if (score >= bestScore) continue;
        const [tx, ty] = fr.worldTopLeft(kind, fx, fy);
        if (!canPlaceBuilding(w, side, kind, tx, ty)) continue;
        if (size > 1 && tooCramped(w, tx, ty, size)) continue;
        spot = [tx, ty];
        bestScore = score;
      }
  }
  return spot;
}
