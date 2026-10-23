import { UNITS } from "../sim/balance";
import type { Faction, FxEvent, PowerKind, Unit, World } from "../sim/types";
import { announce } from "./announce";
import type { Label } from "./three/screen";
import { Ease } from "./three/tween";
import type { View } from "./three/view";
import { CalldownCredit, powerName } from "./calldown-credit";
import { NAMED_RANK, RANK_TITLES, callsignOf, heroShort, killsLabel, stars } from "./heroes";
import { BELLE_EPOQUE } from "./three/theme";
import { tr } from "../lang";

/**
 * Veteran-hero presentation: floating promotion titles over the unit, and
 * the toasts / announcements that make named units matter — "★★ Viper is
 * now Hardened", "Viper (Lancer, 9 kills) destroyed". GameScene feeds it
 * every FxEvent and calls flush() once per tick so simultaneous losses in a
 * big fight become one toast instead of a stack.
 */

export type NoticeTone = "good" | "bad" | "info";

export interface HeroPresenterOpts {
  player: Faction;
  spectator: boolean;
  /** May the local player see this tile position? */
  seesPoint(x: number, y: number): boolean;
  /** May the local player see this unit (its tile in sight, and not a Sniper Team hidden in the woods)? */
  seesUnit(u: Unit): boolean;
  /** Rendered position of a unit (tiles) and the height of its top, if drawn. */
  unitPos(id: number): { x: number; y: number; top: number } | null;
  /** Show a small HUD notice; tapping it jumps the camera to (x, y). */
  notify(msg: string, tone: NoticeTone, x: number, y: number): void;
}

interface Fallen {
  name: string;
  line: string;
  kills: number;
  x: number;
  y: number;
  /** Killed by a commander calldown (whose, and which power). */
  strike: { by: Faction; power: PowerKind } | null;
}

const TITLE_STYLE: Record<number, { color: string; size: number }> = {
  1: { color: "#ffe7a6", size: 15 },
  2: { color: "#ffd66e", size: 17 },
  3: { color: "#ffc23a", size: 21 }
};

export class HeroPresenter {
  private lost: Fallen[] = [];
  private aces: Fallen[] = [];
  /** Live promotion titles, one per unit (a new one replaces the old). */
  private titles = new Map<number, Label>();
  /** Names the Barrage / Sky Hammer that got a hero (calldown-credit.ts). */
  private credit: CalldownCredit;

  constructor(
    private v: View | null,
    private w: World,
    private opts: HeroPresenterOpts
  ) {
    this.credit = new CalldownCredit(w);
  }

  handleFx(ev: FxEvent): void {
    const by = this.credit.see(ev);
    if (ev.type === "rankUp") this.promoted(ev.id);
    else if (ev.type === "death" && ev.unitKind && ev.rank >= NAMED_RANK) {
      const rec: Fallen = {
        name: callsignOf(this.w, { id: ev.id, faction: ev.faction }),
        line: heroShort(this.w, { id: ev.id, faction: ev.faction, kind: ev.unitKind, kills: ev.kills }),
        kills: ev.kills,
        x: ev.x,
        y: ev.y,
        strike: by ? { by: by.faction, power: by.power } : null
      };
      if (this.opts.spectator) {
        // both sides' real heroes, not every rank-2 grunt
        if (ev.rank >= 3 || ev.kills >= 6) this.lost.push({ ...rec, line: tr(`${ev.faction === "blue" ? "Bleu" : "Rouge"} : ${rec.line}`, `${ev.faction === "blue" ? "Blue" : "Red"}: ${rec.line}`) });
      } else if (ev.faction === this.opts.player) this.lost.push(rec);
      // an enemy veteran that actually hurt you, seen going down (a Goliath is seen anywhere: it can't hide)
      else if ((ev.rank >= 3 || ev.kills >= 3) && (UNITS[ev.unitKind].alwaysVisible || this.opts.seesPoint(ev.x, ev.y))) this.aces.push(rec);
    }
  }

  /** "by the enemy Sky Hammer" / "to your Barrage" when one strike got them all, else "". */
  private strikeNote(list: Fallen[], prep: "by" | "to"): string {
    const s = list[0]!.strike;
    if (!s || list.some((x) => x.strike?.power !== s.power || x.strike.by !== s.by)) return "";
    void prep; // (French says "par" for both)
    const name = powerName(s.power);
    return this.opts.spectator
      ? tr(` par une frappe ${name} de ${s.by === "blue" ? "Bleu" : "Rouge"}`, ` by ${s.by === "blue" ? "Blue" : "Red"}'s ${name} strike`)
      : s.by === this.opts.player
        ? tr(` par ta frappe ${name}`, ` by your ${name} strike`)
        : s.power === "hammer"
          ? tr(` par la frappe ${name} ennemie`, ` by the enemy ${name} strike`)
          : tr(` par une frappe ${name} ennemie`, ` by an enemy ${name} strike`);
  }

  /** Emit this tick's batched notices. */
  flush(): void {
    if (this.lost.length > 0) {
      const l = this.lost;
      const by = this.strikeNote(l, "by");
      const msg =
        l.length === 1
          ? tr(`${l[0]!.line} détruit${by}`, `${l[0]!.line} destroyed${by}`)
          : tr(
              `${listNames(l.map((x) => x.name))} détruits${by} (${killsLabel(l.reduce((s, x) => s + x.kills, 0))} à eux tous)`,
              `${listNames(l.map((x) => x.name))} destroyed${by} (${killsLabel(l.reduce((s, x) => s + x.kills, 0))} between them)`
            );
      this.opts.notify(`✝ ${msg}`, this.opts.spectator ? "info" : "bad", l[0]!.x, l[0]!.y);
    }
    if (this.aces.length > 0) {
      const a = this.aces;
      const to = this.strikeNote(a, "to");
      const msg =
        a.length === 1
          ? tr(`As ennemi ${a[0]!.line} abattu${to}`, `Enemy ace ${a[0]!.line} shot down${to}`)
          : tr(`As ennemis ${listNames(a.map((x) => x.name))} abattus${to}`, `Enemy aces ${listNames(a.map((x) => x.name))} shot down${to}`);
      this.opts.notify(`🎯 ${msg}`, "good", a[0]!.x, a[0]!.y);
    }
    this.lost = [];
    this.aces = [];
  }

  private promoted(id: number): void {
    const u = this.w.units.get(id);
    if (!u) return;
    const mine = u.faction === this.opts.player || this.opts.spectator;
    // titles over your own units; an enemy's only once it's dangerous
    const p = this.opts.unitPos(id) ?? { x: u.x, y: u.y, top: UNITS[u.kind].radius };
    const onScreen = this.v?.rig.onScreen(p.x, p.y) ?? false;
    // (Panache: no floating title, the rank pips over the health bar pop instead)
    if (!BELLE_EPOQUE && onScreen && this.opts.seesUnit(u) && (mine || u.rank >= NAMED_RANK))
      this.floatTitle(id, p.x, p.y, p.top + 0.15, u.rank, mine);
    if (u.rank < NAMED_RANK || this.opts.spectator || u.faction !== this.opts.player) return;
    const name = callsignOf(this.w, u);
    const kind = UNITS[u.kind].name;
    if (u.rank >= 3)
      announce({
        key: "unit-elite",
        text: tr(`${name} passe Élite`, `${name} reaches Elite`),
        // (elites patch themselves up; a Goliath doesn't: only Menders repair it, GOLIATH.md)
        sub: `${stars(3)} ${kind} · ${killsLabel(u.kills)}${u.goliath ? "" : tr(" · auto-réparation", " · self-repair")}`,
        tone: "epic",
        x: u.x,
        y: u.y,
        priority: 3
      });
    else this.opts.notify(tr(`${stars(u.rank)} ${kind} : indicatif ${name} obtenu`, `${stars(u.rank)} ${kind}: callsign ${name} earned`), "good", u.x, u.y);
  }

  /** "VETERAN" / "HARDENED" / "ELITE" rising over the unit. */
  private floatTitle(id: number, x: number, y: number, h: number, rank: number, friendly: boolean): void {
    const v = this.v;
    if (!v) return;
    const prev = this.titles.get(id);
    if (prev) {
      v.tweens.kill(prev);
      v.screen.remove(prev);
      this.titles.delete(id);
    }
    if (this.titles.size >= 8) return; // a huge brawl: the chevrons will do
    const st = TITLE_STYLE[Math.min(3, Math.max(1, rank))]!;
    const t = v.screen.label({
      x, y, h, text: RANK_TITLES[Math.min(3, rank)] ?? "", size: st.size, color: friendly ? st.color : "#ff9a8a",
      stroke: "#1a1205", shadow: true, scale: 1.5, alpha: 0
    });
    v.tweens.add({ dur: 260, ease: Ease.backOut, owner: t, update: (k) => {
      t.scale = 1.5 - 0.5 * k;
      t.alpha = k;
    } });
    v.tweens.add({ dur: 1200, ease: Ease.sineOut, owner: t, update: (k) => (t.dy = -30 * k) });
    this.titles.set(id, t);
    v.tweens.add({
      dur: 350, delay: 850, owner: t,
      update: (k) => (t.alpha = 1 - k),
      done: () => {
        v.screen.remove(t);
        if (this.titles.get(id) === t) this.titles.delete(id);
      }
    });
  }
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  if (extra > 0) return `${shown.join(", ")} +${extra}`;
  return `${shown.slice(0, -1).join(", ")}${tr(" et ", " and ")}${shown[shown.length - 1]}`;
}
