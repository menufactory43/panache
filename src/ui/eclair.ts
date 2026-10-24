/**
 * Éclair's pill (sim/modes/eclair.ts), in the top bar like the Ops goal
 * pill: the time left and both sides' victory points, the last minute in
 * red ("coal ×2"), then "Sudden death". The match's three moments are
 * announced as they come: the rules at the start, the last minute, sudden
 * death. Tapping the pill says how points are scored.
 */
import { sfx } from "../game/audio";
import { announce } from "../game/announce";
import { ECLAIR, eclairLeftS } from "../sim/modes/eclair";
import { TICK_RATE } from "../sim/balance";
import type { Faction, World } from "../sim/types";
import { tr } from "../lang";
import { addReportSection, type ReportContext } from "./report";

export interface EclairHud {
  update(): void;
}

const fmtPts = (n: number) => Math.round(n).toLocaleString(tr("fr-FR", "en-US"));
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The rules in one line (the start's announcement, the pill's tap). */
export const ECLAIR_RULES = tr(
  `Des points pour chaque ennemi détruit et chaque relais tenu. Charbon ×2 la dernière minute. À ${ECLAIR.lengthS / 60}:00, le plus de points gagne, et si c'est serré : mort subite.`,
  `Points for every enemy destroyed and every relay held. Coal ×2 in the last minute. At ${ECLAIR.lengthS / 60}:00 the most points wins, and if it's close: sudden death.`
);

/**
 * `side`: whose points come first (the player's; blue for a spectator), and
 * the two sides' names ("You" and "Enemy", or "Friend" in a duel).
 */
export function createEclairHud(pill: HTMLElement, w: World, o: { side: Faction; names: Record<Faction, string>; toast(msg: string): void }): EclairHud {
  pill.hidden = false;
  pill.innerHTML = `<b class="el">⏱ ${tr("Éclair", "Lightning")}</b><span class="et"></span><span class="es"><i class="ed ${o.side}"></i><span class="em"></span><span class="ex">–</span><span class="eo"></span><i class="ed ${o.side === "blue" ? "red" : "blue"}"></i></span>`;
  const time = pill.querySelector<HTMLElement>(".et")!;
  const mine = pill.querySelector<HTMLElement>(".em")!;
  const theirs = pill.querySelector<HTMLElement>(".eo")!;
  const other: Faction = o.side === "blue" ? "red" : "blue";
  pill.title = ECLAIR_RULES;
  pill.addEventListener("pointerdown", (e) => e.stopPropagation());
  pill.addEventListener("click", () => {
    sfx.play("click", 0.5);
    o.toast(ECLAIR_RULES);
  });
  let phase: string | null = null;
  let started = false;
  let lastBeep = -1;
  let shown = "";
  return {
    update() {
      const e = w.eclair;
      if (!e) return;
      // the rules, once the match is under way (after the openers' own line)
      if (!started && w.tick >= 3 * TICK_RATE) {
        started = true;
        announce({ key: "eclair-start", text: tr(`Éclair · ${ECLAIR.lengthS / 60} minutes`, `Lightning · ${ECLAIR.lengthS / 60} minutes`), sub: tr("Des points pour chaque destruction et chaque relais tenu", "Points for every kill and every relay held"), tone: "info", priority: 2 });
      }
      if (e.phase !== phase) {
        if (phase !== null && e.phase === "rush")
          announce({ key: "eclair-rush", text: tr("Dernière minute !", "Last minute!"), sub: tr("Le charbon rapporte double", "Coal pays double"), tone: "bad", priority: 1 });
        if (phase !== null && e.phase === "overtime")
          announce({ key: "eclair-overtime", text: tr("Mort subite !", "Sudden death!"), sub: tr("Le prochain ennemi détruit décide", "The next enemy destroyed decides"), tone: "epic", priority: 0 });
        phase = e.phase;
        pill.classList.toggle("rush", e.phase === "rush");
        pill.classList.toggle("overtime", e.phase === "overtime");
      }
      const left = eclairLeftS(w);
      // (the last five seconds tick)
      const sec = Math.ceil(left);
      if (e.phase === "rush" && sec <= 5 && sec > 0 && sec !== lastBeep) {
        lastBeep = sec;
        sfx.play("click", 0.6);
      }
      const t = e.phase === "overtime" ? tr("Mort subite", "Sudden death") : e.phase === "rush" ? `${clock(Math.ceil(left))} · ×2` : e.phase === "over" ? "" : clock(Math.ceil(left));
      const key = `${t}|${e.points[o.side]}|${e.points[other]}`;
      if (key === shown) return;
      shown = key;
      time.textContent = t;
      mine.textContent = `${o.names[o.side]} ${fmtPts(e.points[o.side])}`;
      theirs.textContent = `${fmtPts(e.points[other])} ${o.names[other]}`;
    }
  };
}

/** The report's Éclair block: the points, what the relays brought, and how it was decided. */
function reportHtml(ctx: ReportContext): string | null {
  const e = ctx.world.eclair;
  if (!e) return null;
  const me: Faction = ctx.spectator ? "blue" : ctx.pov;
  const them: Faction = me === "blue" ? "red" : "blue";
  const name = (f: Faction) => (ctx.spectator ? (f === "blue" ? tr("Bleu", "Blue") : tr("Rouge", "Red")) : f === me ? tr("Toi", "You") : ctx.opponent ? tr("Ami", "Friend") : tr("Ennemi", "Enemy"));
  const how =
    e.decided === "points"
      ? tr(`Décidé aux points à ${ECLAIR.lengthS / 60}:00`, `Decided on points at ${ECLAIR.lengthS / 60}:00`)
      : e.decided === "sudden"
        ? tr("Décidé en mort subite", "Decided in sudden death")
        : e.decided === "time"
          ? tr("Mort subite sans destruction : décidé aux points", "Sudden death with nothing destroyed: decided on points")
          : ctx.winner
            ? tr("Décidé avant la fin du temps", "Decided before time ran out")
            : "";
  const row = (f: Faction) =>
    `<tr><td><i class="ed ${f}"></i> ${name(f)}</td><td><b>${fmtPts(e.points[f])}</b></td><td>${tr(`dont ${fmtPts(e.relays[f])} des relais`, `${fmtPts(e.relays[f])} from relays`)}</td></tr>`;
  return `<h3>⏱ ${tr("Éclair", "Lightning")}</h3>
    <table class="eclair-rep">${row(me)}${row(them)}</table>
    ${how ? `<p class="eclair-how">${how}</p>` : ""}`;
}

addReportSection({ id: "eclair", order: 4, col: "left", render: reportHtml });
