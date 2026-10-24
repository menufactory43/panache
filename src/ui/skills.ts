/**
 * The skill buttons (sim/skills.ts) over the selection bar's chips: one per
 * kind of skill in the selection, with its unit's portrait. Ready, a tap
 * uses it for every selected unit that has it; running, a gold bar drains
 * with it; recharging, a dark veil draws back and the seconds left show; a
 * French 75 battery deployed stays pressed in (a tap packs it up); the snipe,
 * armed, pulses until an enemy is tapped (Controller.tapWorld).
 */
import { sfx } from "../game/audio";
import type { Controller } from "../game/controller";
import { TICK_RATE } from "../sim/balance";
import { SKILLS, SKILL_IDS, skillOf, skillReady } from "../sim/skills";
import type { SkillId, Unit, UnitKind, World } from "../sim/types";
import { tr } from "../lang";

/** Each skill's name and its one-line effect, as the button shows them. */
export const SKILL_UI: Record<SkillId, { name: string; sub: string }> = {
  bayonet: { name: tr("Baïonnette !", "Fix bayonets!"), sub: tr(`cadence +${Math.round((SKILLS.bayonet.rate - 1) * 100)} %`, `fire rate +${Math.round((SKILLS.bayonet.rate - 1) * 100)}%`) },
  throttle: { name: tr("Plein gaz", "Full throttle"), sub: tr(`vitesse +${Math.round((SKILLS.throttle.speed - 1) * 100)} %`, `speed +${Math.round((SKILLS.throttle.speed - 1) * 100)}%`) },
  battery: { name: tr("En batterie", "Dig in"), sub: tr(`portée +${SKILLS.battery.range}`, `range +${SKILLS.battery.range}`) },
  snipe: { name: tr("Tir de précision", "Precision shot"), sub: tr(`${SKILLS.snipe.damage} dégâts`, `${SKILLS.snipe.damage} damage`) },
  charge: { name: tr("Charge", "Charge"), sub: tr("bond sur l'ennemi", "leap at the enemy") },
  barrage: { name: tr("Barrage", "Barrage"), sub: tr("antiaérien ×2", "anti-air ×2") }
};

/** The names a crowded row (three buttons or more, on a phone) shows instead. */
const SHORT: Record<SkillId, string> = {
  bayonet: tr("Baïonnette", "Bayonets"),
  throttle: tr("Plein gaz", "Throttle"),
  battery: tr("Batterie", "Dig in"),
  snipe: tr("Tir précis", "Snipe"),
  charge: tr("Charge", "Charge"),
  barrage: tr("Barrage", "Barrage")
};

/** A button's state, read from the units that have its skill. */
interface SkillView {
  id: SkillId;
  kind: UnitKind;
  /** ready | running (with what's left of it) | recharging (with what's left) | on (battery) | shifting | armed */
  state: "ready" | "running" | "cd" | "on" | "shift" | "armed";
  /** 0–1: what's left of the effect, or of the recharge. */
  frac: number;
  /** Seconds left of the effect or the recharge. */
  secs: number;
}

const LAST: Partial<Record<SkillId, number>> = { bayonet: SKILLS.bayonet.lastS, throttle: SKILLS.throttle.lastS, charge: SKILLS.charge.lastS, barrage: SKILLS.barrage.lastS };
const COOL: Partial<Record<SkillId, number>> = { bayonet: SKILLS.bayonet.cooldownS, throttle: SKILLS.throttle.cooldownS, snipe: SKILLS.snipe.cooldownS, charge: SKILLS.charge.cooldownS, barrage: SKILLS.barrage.cooldownS };

function viewOf(w: World, id: SkillId, units: Unit[], aiming: SkillId | null): SkillView {
  const kind = units[0]!.kind;
  const t = w.tick;
  if (id === "battery") {
    const st = units.map((u) => u.skill?.battery ?? "off");
    if (st.some((b) => b === "deploying" || b === "packing")) return { id, kind, state: "shift", frac: 0, secs: 0 };
    return { id, kind, state: st.every((b) => b === "on") ? "on" : "ready", frac: 0, secs: 0 };
  }
  if (aiming === id) return { id, kind, state: "armed", frac: 0, secs: 0 };
  const running = units.filter((u) => u.skill && u.skill.until > t);
  if (running.length) {
    const left = Math.max(...running.map((u) => u.skill!.until - t)) / TICK_RATE;
    return { id, kind, state: "running", frac: left / (LAST[id] ?? 1), secs: Math.ceil(left) };
  }
  if (units.some((u) => skillReady(w, u))) return { id, kind, state: "ready", frac: 0, secs: 0 };
  const left = Math.min(...units.map((u) => (u.skill?.ready ?? 0) - t)) / TICK_RATE;
  return { id, kind, state: "cd", frac: left / (COOL[id] ?? 1), secs: Math.ceil(left) };
}

/**
 * Mount the row into `row` (the context bar's first line). `update` runs every
 * frame; it rebuilds the buttons only when what they show changes.
 */
export function mountSkillRow(row: HTMLElement, o: { world: World; ctrl: Controller; icon(kind: string): string }): { update(): void } {
  let shown = "";
  row.addEventListener("pointerdown", (e) => e.stopPropagation());
  row.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-skill]");
    if (!b) return;
    const id = b.dataset.skill as SkillId;
    sfx.play("click", 0.6);
    o.ctrl.useSkill(id);
  });
  return {
    update() {
      const { world: w, ctrl } = o;
      const by = new Map<SkillId, Unit[]>();
      if (!ctrl.spectator)
        for (const uid of ctrl.selectedUnits) {
          const u = w.units.get(uid);
          const id = u ? skillOf(u.kind) : null;
          if (!u || !id) continue;
          const list = by.get(id) ?? [];
          list.push(u);
          by.set(id, list);
        }
      const views = SKILL_IDS.filter((id) => by.has(id)).map((id) => viewOf(w, id, by.get(id)!, ctrl.aiming));
      // the buttons are rebuilt only when the skills in the selection change; otherwise updated in place
      // (a button replaced between a finger's down and up would lose the tap)
      const shape = views.map((v) => `${v.id}:${v.kind}`).join("|");
      if (shape !== shown) {
        shown = shape;
        row.hidden = views.length === 0;
        row.dataset.n = String(views.length);
        const crowded = views.length >= 3;
        row.innerHTML = views
          .map((v) => `<button class="skb" data-skill="${v.id}" aria-label="${SKILL_UI[v.id].name}"><img src="${o.icon(v.kind)}" alt="" draggable="false"/><span><b>${crowded ? SHORT[v.id] : SKILL_UI[v.id].name}</b><small></small></span><i class="skt"></i></button>`)
          .join("");
      }
      for (const v of views) {
        const b = row.querySelector<HTMLElement>(`[data-skill="${v.id}"]`);
        if (!b) continue;
        const ui = SKILL_UI[v.id];
        const sub =
          v.state === "running" ? tr(`encore ${v.secs} s`, `${v.secs} s left`)
          : v.state === "cd" ? tr("recharge", "recharging")
          : v.state === "on" ? tr("touche : repartir", "tap: move off")
          : v.state === "shift" ? "…"
          : v.state === "armed" ? tr("vise un ennemi…", "aim at an enemy…")
          : ui.sub;
        const cls = `skb ${v.state}`;
        if (b.className !== cls) b.className = cls;
        const small = b.querySelector("small")!;
        if (small.textContent !== sub) small.textContent = sub;
        const t = b.querySelector<HTMLElement>(".skt")!;
        const tt = v.state === "cd" ? `${v.secs} s` : "";
        if (t.textContent !== tt) t.textContent = tt;
        b.style.setProperty("--w", `${Math.round(v.frac * 100)}%`);
        b.style.setProperty("--p", `${Math.round(v.frac * 100)}%`);
      }
    }
  };
}
