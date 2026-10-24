import { cleanupDeaths, strikeDamage, tickCombat } from "./combat";
import {
  applyEconomyCommand,
  tickConstruction,
  tickHarvest,
  tickProduction,
  tickTrickle
} from "./economy";
import { FOG } from "./balance";
import { tickFog } from "./fog";
import { applyGoliathCommand, orderedToMove, tickGoliaths, tickLove } from "./goliath";
import { applyLiftCommand, routeLiftCommand, tickLift, type HeldLiftOrders } from "./lift";
import { tickLifeline } from "./lifeline";
import { callWaveEarly, tickSurvival } from "./modes/survival";
import { tickEclair } from "./modes/eclair";
import { tickMovement, vehicleSpots } from "./movement";
import { behaves, holdOf, tickNations } from "./nations";
import { tickOps } from "./ops";
import { tickObjectives } from "./objectives";
import { applyCalldown, chargePowers, tickPowers } from "./powers";
import { tickSalvage } from "./salvage";
import { applyMarchCommand, dropMarches } from "./march";
import { applySkillCommand, tickSkills } from "./skills";
import { applyRouteCommand, dropRoutes } from "./route";
import { applyTransportCommand, tickTransport } from "./transport";
import type { Command, World } from "./types";
import { isResource, tileIndex } from "./world";

/** Advance the world exactly one tick, applying this tick's commands first. */
export function step(w: World, commands: Command[]): void {
  w.fx = []; // (first: a decided world must not hand the deciding tick's events out again)
  if (w.winner) return;
  // orders a hooking Goliath ignored, kept for this tick's commands only (lift.ts HeldLiftOrders; one command can't need it)
  const held: HeldLiftOrders | undefined = commands.length > 1 ? { ignored: new Map(), freed: [] } : undefined;
  for (const c of commands) applyCommand(w, c, held);
  const spots = vehicleSpots(w); // (before anything drives: squads step aside only for a vehicle on the move)
  tickNations(w); // nations only: power networks, trenches, power zones and boosts (nations.ts)
  tickConstruction(w);
  tickProduction(w);
  tickHarvest(w);
  tickTrickle(w);
  tickPowers(w); // calldowns land, stuns wear off (powers.ts)
  // skills (skills.ts): batteries settle, a snipe in reach fires
  for (const shot of tickSkills(w)) strikeDamage(w, [{ id: shot.targetId, damage: shot.damage }], shot.attackerId);
  const engaged = tickCombat(w);
  tickTransport(w); // squads board Condors, Condors fly drops (transport.ts)
  tickLift(w); // Condor pairs hook onto and carry Goliaths (lift.ts)
  tickMovement(w, engaged, spots); // (then separation, and Mastodons crushing squads)
  cleanupDeaths(w);
  tickGoliaths(w); // anchoring and packing up, weapon systems going offline and rebooting (goliath.ts)
  tickLove(w); // Robot Love: enemy Goliaths that meet fall in love, a draw (goliath.ts)
  if (w.lifeline) tickLifeline(w); // a side left with no Condor gets a free one (lifeline.ts)
  tickSalvage(w);
  tickObjectives(w); // Uplink capture bars and income, supply drops (objectives.ts)
  chargePowers(w); // Command meters fill from this tick's losses
  if (w.eclair) tickEclair(w); // Éclair's points, its last minute and its end (modes/eclair.ts)
  if (w.survival) tickSurvival(w);
  if (w.ops) tickOps(w);
  if (w.tick % FOG.intervalTicks === 0) tickFog(w);
  w.tick++;
}

function applyCommand(w: World, c: Command, held?: HeldLiftOrders): void {
  // a Goliath's lift (and its Condors) take their own orders (lift.ts)
  const lifting = routeLiftCommand(w, c, held);
  // a Goliath whose lift this command called off takes the order it ignored earlier this tick, as it would have
  // had that order named its Condors too; then this command applies as usual (lift.ts HeldLiftOrders)
  if (held) for (const [id, order] of held.freed.splice(0)) applyCommand(w, { ...order, unitIds: [id] });
  dropRoutes(w, c); // a new order replaces a route drawn or a patrol (route.ts)
  dropMarches(w, c); // or a march in order (march.ts)
  switch (c.type) {
    case "move":
    case "attackMove":
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction || lifting.has(id)) continue;
        u.order = { type: c.type, x: c.x, y: c.y };
        u.path = null;
        u.autoTargetId = null;
        orderedToMove(w, u); // an anchored Goliath packs up first
      }
      break;
    case "attack":
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction || lifting.has(id)) continue;
        u.order = { type: "attack", targetId: c.targetId };
        u.path = null;
      }
      break;
    case "harvest": {
      const tx = Math.floor(c.x);
      const ty = Math.floor(c.y);
      if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) break;
      if (!isResource(w, tileIndex(w, tx, ty))) break;
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction || !behaves(u.kind, "harvester") || lifting.has(id)) continue;
        // a full hold goes home to unload first, not out to the field and back
        const full = u.cargo >= holdOf(u.kind) - 1e-6;
        u.order = { type: "harvest", fieldX: tx, fieldY: ty, phase: full ? "toBase" : "toField" };
        u.path = null;
      }
      break;
    }
    case "stop":
      // (also how a Condor's drop is called off: its unload order goes)
      for (const id of c.unitIds) {
        const u = w.units.get(id);
        if (!u || u.faction !== c.faction || lifting.has(id)) continue;
        u.order = { type: "idle" };
        u.path = null;
        u.autoTargetId = null;
      }
      break;
    case "board":
      applyTransportCommand(w, c);
      break;
    case "unload":
      // (Condors on a lift set their Goliath down instead: routeLiftCommand)
      applyTransportCommand(w, { ...c, unitIds: c.unitIds.filter((id) => !lifting.has(id)) });
      break;
    case "anchor":
    case "packUp":
      applyGoliathCommand(w, c);
      break;
    case "lift":
      applyLiftCommand(w, c);
      break;
    case "waypoint":
    case "patrol":
      applyRouteCommand(w, c, lifting);
      break;
    case "march":
      applyMarchCommand(w, c, lifting);
      break;
    case "skill":
      applySkillCommand(w, c, lifting);
      break;
    case "callWave":
      callWaveEarly(w, c.faction);
      break;
    case "calldown":
      applyCalldown(w, c);
      break;
    case "resign":
      // the other side wins this tick; both resigning in the same tick is a draw
      // (step() returns before any command once a winner is set, so only a
      // resign earlier in this same batch can have decided it)
      if (!w.winner) {
        w.winner = c.faction === "blue" ? "red" : "blue";
        w.resigned = c.faction;
      } else if (w.winner === c.faction) {
        w.winner = "draw";
        w.resigned = null;
      }
      w.fx.push({ type: "resign", faction: c.faction });
      break;
    default:
      applyEconomyCommand(w, c);
  }
}
