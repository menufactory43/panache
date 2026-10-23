import { TICK_RATE } from "../sim/balance";
import { goalText, isAchieveGoal, isCampaignOp, objectiveLine, opById, opIndex, opStatus, type OpDef } from "../sim/ops";
import type { World } from "../sim/types";
import { buildingCenter, hqOf } from "../sim/world";
import { playReel } from "../ui/cine";
import { announce, type Announcement } from "./announce";
import { callsigns } from "./heroes";
import { tr } from "../lang";

/**
 * Ops presentation (no three.js): the campaign's silent-film cards before and
 * after a mission (ui/cine.ts), the opening briefing banner, countdown
 * call-outs, "star lost / secured" notices, scripted events (« Ferrand l'a
 * fini ! ») and the result line the finale shows. The sim decides everything
 * (src/sim/ops.ts); this only narrates.
 *
 * Announce keys (for the voice and music lanes): op-start (info), op-timer
 * (info or bad), op-complete (epic), op-failed (bad).
 */

export interface OpsPresenterOpts {
  /** A small toast; tapping it jumps to (x, y). */
  notify(msg: string, tone: "good" | "bad" | "info", x: number, y: number): void;
  /** Hold the clock (the opening cards are up) or let it run. */
  hold?(on: boolean): void;
  /** Spectating (a replay, AI vs AI): no cards. */
  spectator?: boolean;
}

const starName = (i: number) => (i === 0 ? "★★" : "★★★");

export const ACT_NAMES: Record<1 | 2 | 3, string> = tr(
  { 1: "Acte I — L'Ultimatum", 2: "Acte II — La Guerre des cimes", 3: "Acte III — Paris !" },
  { 1: "Act I — The Ultimatum", 2: "Act II — The War of the Peaks", 3: "Act III — Paris!" }
);

/** « Acte I — L'Ultimatum · Mission 1 » / « Épreuve 3 ». */
export function opKicker(op: OpDef): string {
  return isCampaignOp(op) ? `${op.act ? `${ACT_NAMES[op.act]} · ` : ""}${tr("Mission", "Mission")} ${opIndex(op.id) + 1}` : `${tr("Épreuve", "Trial")} ${opIndex(op.id) + 1}`;
}

/** What a script's one-shot events say (OpsState.events). */
const EVENT_LINES: Record<string, { text: string; sub: string; tone: "good" | "bad" }> = {
  zenith: { text: tr("Ferrand l'a fini !", "Ferrand's done it!"), sub: tr("Le Zénith rejoint la bataille", "The Zénith joins the battle"), tone: "good" },
  march: { text: tr("Le Colosse se met en marche !", "The Colossus marches!"), sub: tr("Défends la Tour Eiffel", "Defend the Eiffel Tower"), tone: "bad" }
};

export class OpsPresenter {
  readonly op: OpDef;
  private starsLostSeen = 0;
  private starsMetSeen = 0;
  private said = new Set<string>();
  private tagAlive = new Map<string, number>();
  private kills = new Map<number, number>();
  private events = new Set<string>();

  constructor(private w: World, private o: OpsPresenterOpts) {
    this.op = opById(w.ops!.id)!;
    for (const [tag, ids] of Object.entries(w.ops!.tags)) this.tagAlive.set(tag, ids.length);
    // (the Instruction opens on its own lesson bubble: no briefing banner, no cards)
    if (this.op.tutorial) return;
    // the setup's heroes keep their names (« Valmont »)
    for (const [id, name] of Object.entries(w.ops!.names ?? {})) {
      const u = w.units.get(Number(id));
      if (u) callsigns(w).set(u.id, u.faction, name);
    }
    for (const k of Object.keys(w.ops!.events ?? {})) this.events.add(k);
    const brief = () =>
      // real-time timer like the rules banner: a render-clock timer can fire late headless
      window.setTimeout(() => {
        if (this.w.winner) return;
        const at = this.op.focus ?? this.home();
        announce({ key: "op-start", text: this.op.title, sub: objectiveLine(this.op), tone: "info", priority: 1, x: at.x, y: at.y });
      }, 900);
    const cards = this.op.cards;
    if (cards && !o.spectator && w.tick === 0) {
      o.hold?.(true);
      playReel({
        cards: cards.before,
        kicker: opKicker(this.op),
        art: this.op.art,
        onDone: () => {
          o.hold?.(false);
          brief();
        }
      });
    } else brief();
  }

  private home(): { x: number; y: number } {
    const hq = hqOf(this.w, this.w.ops!.player);
    return hq ? buildingCenter(hq) : { x: this.w.width / 2, y: this.w.height / 2 };
  }

  private once(key: string, fn: () => void): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    fn();
  }

  /** After every sim tick: narrate on whole seconds. */
  tick(): void {
    const w = this.w;
    const st = w.ops;
    if (!st || st.result || w.tick % TICK_RATE !== 1) return;
    const status = opStatus(w);
    if (!status) return;
    const home = this.home();
    // a script's events
    for (const k of Object.keys(st.events ?? {})) {
      if (this.events.has(k)) continue;
      this.events.add(k);
      const line = EVENT_LINES[k];
      if (line) announce({ key: "op-timer", text: line.text, sub: line.sub, tone: line.tone === "good" ? "info" : "bad", priority: 1 });
    }
    // star conditions broken / achieved
    const lost = st.starsLost & ~this.starsLostSeen;
    this.starsLostSeen |= st.starsLost;
    this.op.stars.forEach((g, i) => {
      const bit = 2 << i;
      if (lost & bit) this.o.notify(tr(`${starName(i)} perdue : ${goalText(g, true, this.op).toLowerCase()}`, `${starName(i)} lost: ${goalText(g, true, this.op).toLowerCase()}`), "bad", home.x, home.y);
      if (isAchieveGoal(g) && status.stars[i]!.eval.state === "done" && !(this.starsMetSeen & bit)) {
        this.starsMetSeen |= bit;
        this.o.notify(tr(`${starName(i)} acquise : ${goalText(g, true, this.op).toLowerCase()}`, `${starName(i)} earned: ${goalText(g, true, this.op).toLowerCase()}`), "good", home.x, home.y);
      }
    });
    // the protected group shrinking
    for (const g of this.op.goals) {
      if (g.type !== "protect" || !g.tag) continue;
      const ids = st.tags[g.tag] ?? [];
      const alive = ids.filter((id) => w.units.has(id) || w.buildings.has(id)).length;
      const before = this.tagAlive.get(g.tag) ?? alive;
      this.tagAlive.set(g.tag, alive);
      if (alive < before && alive >= g.min) {
        const at = st.lastTagDeath ?? home;
        this.o.notify(tr(`⚠ ${g.short ?? "Objectif"} : ${alive} sur ${ids.length} restants — ${g.label.toLowerCase()}`, `⚠ ${g.short ?? "Objective"}: ${alive} of ${ids.length} left — ${g.label.toLowerCase()}`), "bad", at.x, at.y);
      }
    }
    // countdowns and milestones
    for (const { goal: g, eval: e } of status.goals) {
      if (g.type === "survive" || g.type === "within") {
        const left = Math.round(g.secs - status.secs);
        const hold = g.type === "survive";
        if (left === 60 && g.secs > 90)
          this.once(`t60:${g.type}`, () =>
            announce({ key: "op-timer", text: hold ? tr("Tiens encore une minute", "Hold one more minute") : tr("Plus qu'une minute", "One minute left"), sub: this.op.title, tone: hold ? "info" : "bad", priority: 2 })
          );
        if (left === 15) this.once(`t15:${g.type}`, () => this.o.notify(hold ? tr("⏱ 15 secondes — tiens bon !", "⏱ 15 seconds — hold on!") : tr("⏱ Plus que 15 secondes !", "⏱ Only 15 seconds left!"), hold ? "good" : "bad", home.x, home.y));
      } else if (g.type === "deliver" && e.progress >= 0.5) {
        this.once("half", () => this.o.notify(tr(`⚙ À mi-chemin : ${e.value} charbon`, `⚙ Halfway: ${e.value} coal`), "good", home.x, home.y));
      } else if (g.type === "reach" && e.progress > 0 && e.progress < 1) {
        this.once(`reach:${e.value}`, () => this.o.notify(`🚩 ${e.label} ${e.value}`, "good", g.x, g.y));
      } else if (g.type === "destroy") {
        const n = g.tag ? (st.tagDeaths[g.tag] ?? 0) : (st.killed[g.kind] ?? 0);
        const key = this.kills.get(this.op.goals.indexOf(g)) ?? 0;
        if (n > key && n < g.count) this.o.notify(`🎯 ${e.label} ${e.value}`, "good", home.x, home.y);
        this.kills.set(this.op.goals.indexOf(g), n);
      }
    }
  }

  /** The banner at the finale's flash. */
  endAnnouncement(): Announcement {
    const r = this.w.ops?.result;
    const camp = isCampaignOp(this.op);
    // (the Trials keep « Op réussie / échouée », the campaign says « Mission »)
    const name = camp ? tr("Mission", "Mission") : tr("Op", "Op");
    if (!r) return { key: "op-failed", text: tr(`${name} échouée`, `${name} failed`), tone: "bad", priority: 0 };
    const stars = (r.stars & 1) + ((r.stars >> 1) & 1) + ((r.stars >> 2) & 1);
    if (r.won && this.op.tutorial) return { key: "op-complete", text: tr("Op réussie", "Op complete"), sub: tr("Instruction terminée · ★★★", "Training complete · ★★★"), tone: "epic", priority: 0, x: r.x, y: r.y };
    return r.won
      ? { key: "op-complete", text: tr(`${name} réussie`, `${name} complete`), sub: `${r.reason} · ${"★".repeat(stars)}${"☆".repeat(3 - stars)}`, tone: "epic", priority: 0, x: r.x, y: r.y }
      : { key: "op-failed", text: tr(`${name} échouée`, `${name} failed`), sub: r.reason, tone: "bad", priority: 0, x: r.x, y: r.y };
  }

  /** After the finale, before the end screen: the campaign's closing card (and « FIN » after the last mission). */
  outro(done: () => void): void {
    const r = this.w.ops?.result;
    const cards = this.op.cards;
    if (!cards || !r || this.o.spectator) return done();
    const end = r.won ? (cards.end ?? []) : [];
    playReel({ cards: [r.won ? cards.win : cards.lose, ...end], tone: r.won ? "win" : "lose", finale: end.length, onDone: done });
  }
}
