import { TICK_RATE } from "../sim/balance";
import { goalText, isAchieveGoal, objectiveLine, opById, opStatus, type OpDef } from "../sim/ops";
import type { World } from "../sim/types";
import { buildingCenter, hqOf } from "../sim/world";
import { announce, type Announcement } from "./announce";

/**
 * Ops presentation (no three.js): the opening briefing banner, countdown
 * call-outs, "star lost / secured" notices, and the result line the finale
 * shows. The sim decides everything (src/sim/ops.ts); this only narrates.
 *
 * Announce keys (for the voice and music lanes): op-start (info), op-timer
 * (info or bad), op-complete (epic), op-failed (bad).
 */

export interface OpsPresenterOpts {
  /** A small toast; tapping it jumps to (x, y). */
  notify(msg: string, tone: "good" | "bad" | "info", x: number, y: number): void;
}

const starName = (i: number) => (i === 0 ? "★★" : "★★★");

export class OpsPresenter {
  readonly op: OpDef;
  private starsLostSeen = 0;
  private starsMetSeen = 0;
  private said = new Set<string>();
  private tagAlive = new Map<string, number>();
  private kills = new Map<number, number>();

  constructor(private w: World, private o: OpsPresenterOpts) {
    this.op = opById(w.ops!.id)!;
    for (const [tag, ids] of Object.entries(w.ops!.tags)) this.tagAlive.set(tag, ids.length);
    // real-time timer like the rules banner: a render-clock timer can fire late headless
    window.setTimeout(() => {
      if (this.w.winner) return;
      const at = this.op.focus ?? this.home();
      announce({ key: "op-start", text: this.op.title, sub: objectiveLine(this.op), tone: "info", priority: 1, x: at.x, y: at.y });
    }, 1200);
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
    // star conditions broken / achieved
    const lost = st.starsLost & ~this.starsLostSeen;
    this.starsLostSeen |= st.starsLost;
    this.op.stars.forEach((g, i) => {
      const bit = 2 << i;
      if (lost & bit) this.o.notify(`${starName(i)} perdue : ${goalText(g, true).toLowerCase()}`, "bad", home.x, home.y);
      if (isAchieveGoal(g) && status.stars[i]!.eval.state === "done" && !(this.starsMetSeen & bit)) {
        this.starsMetSeen |= bit;
        this.o.notify(`${starName(i)} acquise : ${goalText(g, true).toLowerCase()}`, "good", home.x, home.y);
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
        this.o.notify(`⚠ ${g.short ?? "Objectif"} : ${alive} sur ${ids.length} restants — ${g.label.toLowerCase()}`, "bad", at.x, at.y);
      }
    }
    // countdowns and milestones
    for (const { goal: g, eval: e } of status.goals) {
      if (g.type === "survive" || g.type === "within") {
        const left = Math.round(g.secs - status.secs);
        const hold = g.type === "survive";
        if (left === 60 && g.secs > 90)
          this.once(`t60:${g.type}`, () =>
            announce({ key: "op-timer", text: hold ? "Tiens encore une minute" : "Plus qu'une minute", sub: this.op.title, tone: hold ? "info" : "bad", priority: 2 })
          );
        if (left === 15) this.once(`t15:${g.type}`, () => this.o.notify(hold ? "⏱ 15 secondes — tiens bon !" : "⏱ Plus que 15 secondes !", hold ? "good" : "bad", home.x, home.y));
      } else if (g.type === "deliver" && e.progress >= 0.5) {
        this.once("half", () => this.o.notify(`⚙ À mi-chemin : ${e.value} charbon`, "good", home.x, home.y));
      } else if (g.type === "destroy") {
        const n = st.killed[g.kind] ?? 0;
        const key = this.kills.get(this.op.goals.indexOf(g)) ?? 0;
        if (n > key && n < g.count) this.o.notify(`🎯 ${e.label} ${e.value}`, "good", home.x, home.y);
        this.kills.set(this.op.goals.indexOf(g), n);
      }
    }
  }

  /** The banner at the finale's flash. */
  endAnnouncement(): Announcement {
    const r = this.w.ops?.result;
    if (!r) return { key: "op-failed", text: "Op échouée", tone: "bad", priority: 0 };
    const stars = (r.stars & 1) + ((r.stars >> 1) & 1) + ((r.stars >> 2) & 1);
    return r.won
      ? { key: "op-complete", text: "Op réussie", sub: `${r.reason} · ${"★".repeat(stars)}${"☆".repeat(3 - stars)}`, tone: "epic", priority: 0, x: r.x, y: r.y }
      : { key: "op-failed", text: "Op échouée", sub: r.reason, tone: "bad", priority: 0, x: r.x, y: r.y };
  }
}
