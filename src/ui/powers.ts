import { POWERS, TICK_RATE, UNITS } from "../sim/balance";
import { POWER_KINDS, POWER_NAMES, podCrew, targetBlocker } from "../sim/powers";
import { rulesOf } from "../sim/rules";
import type { PowerKind, UnitKind, World } from "../sim/types";
import { sfx } from "../game/audio";
import type { Controller } from "../game/controller";
import { PLAYER } from "../game/controller";
import type { TargetPreview } from "../game/render/powers";
import { HINTS, type HintOffer } from "../game/hints";
import { BELLE_EPOQUE } from "../game/three/theme";
import { tr } from "../lang";
import { buzz } from "../native";

/**
 * The commander's calldown buttons: a stack of four round buttons on the
 * right edge (a 2×2 block beside the sidebar on short landscape screens),
 * each with a conic charge / cooldown ring and its cost, and the Command
 * meter above them. Tapping a ready power arms it; the next map tap fires
 * it there (taps on invalid ground explain why). Long-press for details.
 */

export interface PowerPanelApi {
  world: World;
  ctrl: Controller;
  /** A short toast (why a power can't fire, …). */
  notify(msg: string, tone?: "bad" | "good"): void;
  /** A longer read (a power's long-press details): the ticker's roomier tip line, not a 2-line toast. */
  info?(msg: string): void;
  /** Camera centre in tiles: where the aim preview starts on touch screens. */
  viewCentre(): { x: number; y: number };
  /** A one-time 💡 hint, paced through the HUD's hint queue. */
  offerHint?(h: HintOffer): void;
}

const HINT_KEY = "panache.hint.calldowns";

export interface PowerPanel {
  /** The armed power while the player picks a target, else null. */
  readonly targeting: PowerKind | null;
  /** A map tap at (x, y) tiles: fires the armed power. True if the tap was used. */
  tapWorld(x: number, y: number): boolean;
  /** The pointer is over the map at (x, y) tiles (hover, or a finger down). */
  aim(x: number, y: number): void;
  /** What to draw under the pointer while armed. */
  preview(): TargetPreview | null;
  cancel(): void;
  /** The context chip while armed ("Tap map: Barrage" + cancel). */
  chip(): { label: string; cancel(): void } | null;
  update(): void;
  destroy(): void;
}

const COLOR: Record<PowerKind, string> = {
  barrage: "#ffc93c",
  emp: "#7fe3ff",
  droppod: "#6eb0ff",
  hammer: "#ff8a3c",
  // the nations' powers (PANACHE-CONCEPTION.md §1.7; their panel is WP6)
  sonde: "#e8e0c8",
  curie: "#9fffd0",
  gaz: "#b0b0a0",
  pression: "#ff9c4a"
};

const ABOUT: Record<PowerKind, string> = {
  barrage: tr(`${POWER_NAMES.barrage} : 3 salves tombent dans le cercle ${POWERS.barrage.telegraph} s après l'appel. Touche unités terrestres et bâtiments. Coût ${POWERS.barrage.cost}, recharge ${POWERS.barrage.cooldown} s.`, `${POWER_NAMES.barrage}: 3 salvoes land in the circle ${POWERS.barrage.telegraph} s after the call. Hits ground units and buildings. Cost ${POWERS.barrage.cost}, cooldown ${POWERS.barrage.cooldown} s.`),
  emp: tr(`${POWER_NAMES.emp} : unités et bâtiments ennemis du cercle gelés ${POWERS.emp.stun} s (ni mouvement, ni tir, ni production). Coût ${POWERS.emp.cost}, recharge ${POWERS.emp.cooldown} s.`, `${POWER_NAMES.emp}: enemy units and buildings in the circle frozen for ${POWERS.emp.stun} s (no movement, no fire, no production). Cost ${POWERS.emp.cost}, cooldown ${POWERS.emp.cooldown} s.`),
  droppod: tr(`${POWER_NAMES.droppod} : 2 Panhard + un Faucheux atterrissent là où tu as la vue (2 Hydroglisseurs + Faucheux avec Polytechnique). Coût ${POWERS.droppod.cost}, recharge ${POWERS.droppod.cooldown} s.`, `${POWER_NAMES.droppod}: 2 Panhards + a Daddy-Longlegs land wherever you can see (2 Hydrogliders + Daddy-Longlegs with Polytechnique). Cost ${POWERS.droppod.cost}, cooldown ${POWERS.droppod.cooldown} s.`),
  hammer: tr(`${POWER_NAMES.hammer} : l'obus tombe de la Lune après ${POWERS.hammer.telegraph} s d'alerte. Détruit les unités ; les bâtiments perdent ${POWERS.hammer.buildingDamage} PV. Dispo à ${POWERS.hammer.unlock / 60}:00, puis toutes les ${POWERS.hammer.cooldown / 60} min.`, `${POWER_NAMES.hammer}: the shell falls from the Moon after ${POWERS.hammer.telegraph} s of warning. Destroys units; buildings lose ${POWERS.hammer.buildingDamage} HP. Available at ${POWERS.hammer.unlock / 60}:00, then every ${POWERS.hammer.cooldown / 60} min.`),
  sonde: tr(`${POWER_NAMES.sonde} : révèle la zone ${POWERS.sonde.duration} s, tireurs dissimulés compris. Coût ${POWERS.sonde.cost}, recharge ${POWERS.sonde.cooldown} s.`, `${POWER_NAMES.sonde}: reveals the area for ${POWERS.sonde.duration} s, hidden shooters included. Cost ${POWERS.sonde.cost}, cooldown ${POWERS.sonde.cooldown} s.`),
  curie: tr(`${POWER_NAMES.curie} : frappe tardive ; les bâtiments perdent ${POWERS.curie.buildingDamage} PV. Dispo à ${POWERS.curie.unlock / 60}:00, puis toutes les ${POWERS.curie.cooldown / 60} min.`, `${POWER_NAMES.curie}: a late strike; buildings lose ${POWERS.curie.buildingDamage} HP. Available at ${POWERS.curie.unlock / 60}:00, then every ${POWERS.curie.cooldown / 60} min.`),
  gaz: tr(`${POWER_NAMES.gaz} : un nuage de ${POWERS.gaz.duration} s où l'ennemi ne voit rien. Coût ${POWERS.gaz.cost}, recharge ${POWERS.gaz.cooldown} s.`, `${POWER_NAMES.gaz}: a ${POWERS.gaz.duration} s cloud in which the enemy sees nothing. Cost ${POWERS.gaz.cost}, cooldown ${POWERS.gaz.cooldown} s.`),
  pression: tr(`${POWER_NAMES.pression} : véhicules impériaux plus rapides et plus cadencés ${POWERS.pression.duration} s, puis surchauffe ${POWERS.pression.overheat} s. Coût ${POWERS.pression.cost}, recharge ${POWERS.pression.cooldown} s.`, `${POWER_NAMES.pression}: Imperial vehicles faster and quicker-firing for ${POWERS.pression.duration} s, then overheat for ${POWERS.pression.overheat} s. Cost ${POWERS.pression.cost}, cooldown ${POWERS.pression.cooldown} s.`)
};

/** Inline icons (24×24, currentColor): crisp at any DPR, no emoji fonts needed. */
const ICON: Record<PowerKind, string> = {
  barrage: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="15" r="6.5"/><path d="M12 11.5v7M8.5 15h7"/></g><g fill="currentColor"><path d="M5.2 1.5l2.6 0.3-1 5.2-1.4-0.2z"/><path d="M11 0.5h2.4l-0.4 5.6h-1.6z"/><path d="M16.6 1.8l2.6-0.3-0.3 5.3-1.5 0.2z"/></g></svg>`,
  emp: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.2"/><path fill="currentColor" d="M13.6 2.8 6.4 13.2h4.4l-1.6 8 7.4-10.6h-4.5z"/></svg>`,
  droppod: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 17.5c-3 0-4.6-2.6-4.6-6.2L8 4.5h8l.6 6.8c0 3.6-1.6 6.2-4.6 6.2z"/><path fill="currentColor" d="M7.4 3h9.2v2H7.4z" opacity=".7"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 21.5h18M5 18.5l-1.5 2M19 18.5l1.5 2"/></svg>`,
  hammer: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.3 0h3.4l-.6 13.5h-2.2z" opacity=".85"/><path fill="currentColor" d="M12 12.2l1.7 3.4 3.8-1.2-2.2 3.3 3.3 2.1-4-.1-.6 3.9-2-3.4-2 3.4-.6-3.9-4 .1 3.3-2.1-2.2-3.3 3.8 1.2z"/></svg>`,
  // (the nations' powers borrow the icon of the Classique power in their slot until WP6)
  get sonde() { return ICON.emp; },
  get curie() { return ICON.hammer; },
  get gaz() { return ICON.barrage; },
  get pression() { return ICON.droppod; }
};

/** "2× Éole + Blériot" */
function crewLabel(crew: UnitKind[]): string {
  const n = new Map<UnitKind, number>();
  for (const k of crew) n.set(k, (n.get(k) ?? 0) + 1);
  return [...n]
    .map(([k, c]) => (c === 1 ? UNITS[k].name : `${c}× ${UNITS[k].name}`))
    .join(" + ");
}

const clock = (ticks: number) => {
  const s = Math.ceil(ticks / TICK_RATE);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
};

export function createPowerPanel(api: PowerPanelApi): PowerPanel {
  const root = document.getElementById("hud")!;
  const el = document.createElement("div");
  el.className = "powers";
  el.innerHTML = `
    <div class="pw-meter" title="${tr("Jauge de commandement : se remplit avec le temps, tes pertes (et tes victimes)", "Command gauge: fills with time, your losses (and your victims)")}"><i>⚡</i><b>0</b></div>
    <div class="pw-grid">
      ${POWER_KINDS.map(
        (p) => `<button class="pw" data-p="${p}" aria-label="${POWER_NAMES[p]}" title="${POWER_NAMES[p]}" style="--c:${COLOR[p]}">
          <span class="pw-ring"></span><span class="pw-face">${ICON[p]}</span><span class="pw-tag"></span>
        </button>`
      ).join("")}
    </div>`;
  // edge arrows slide past the stack (src/ui/awareness.ts)
  el.dataset.edgeAvoid = "";
  root.appendChild(el);
  el.addEventListener("pointerdown", (e) => e.stopPropagation());

  const w = api.world;
  const meterEl = el.querySelector<HTMLElement>(".pw-meter b")!;
  const btns = new Map<PowerKind, { b: HTMLButtonElement; tag: HTMLElement; key: string }>();
  let targeting: PowerKind | null = null;
  let aimAt: { x: number; y: number } | null = null;
  let hinted = true;
  try {
    hinted = api.ctrl.spectator || localStorage.getItem(HINT_KEY) === "1";
  } catch {
    /* storage blocked: skip the tip */
  }

  /** Long-press text; the Drop Pod names its real crew (match rules swap banned kinds, e.g. Air War: Wasps). */
  const about = (p: PowerKind): string => {
    if (p !== "droppod") return ABOUT[p];
    const crew = podCrew(w, PLAYER);
    if (crew.join() === POWERS.droppod.units.join() || crew.join() === POWERS.droppod.techUnits.join()) return ABOUT[p];
    return tr(`${POWER_NAMES.droppod} : ${crewLabel(crew)} atterrissent là où tu as la vue. Coût ${POWERS.droppod.cost}, recharge ${POWERS.droppod.cooldown} s.`, `${POWER_NAMES.droppod}: ${crewLabel(crew)} land wherever you can see. Cost ${POWERS.droppod.cost}, cooldown ${POWERS.droppod.cooldown} s.`);
  };

  const arm = (p: PowerKind | null) => {
    targeting = p;
    aimAt = null;
    if (p) {
      api.ctrl.placing = null;
      el.classList.add("arming");
    } else el.classList.remove("arming");
    for (const [k, v] of btns) v.b.classList.toggle("armed", k === p);
  };

  for (const btn of el.querySelectorAll<HTMLButtonElement>(".pw")) {
    const p = btn.dataset.p as PowerKind;
    btns.set(p, { b: btn, tag: btn.querySelector<HTMLElement>(".pw-tag")!, key: "" });
    let timer = 0;
    let long = false;
    btn.addEventListener("pointerdown", (e) => {
      long = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        long = true;
        buzz(8);
        (api.info ?? api.notify)(about(p));
      }, 420);
      if (e.button === 2) {
        window.clearTimeout(timer);
        long = true;
        (api.info ?? api.notify)(about(p));
      }
    });
    const clear = () => window.clearTimeout(timer);
    btn.addEventListener("pointerup", clear);
    btn.addEventListener("pointerleave", clear);
    btn.addEventListener("pointercancel", clear);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      if (long) return;
      if (targeting === p) {
        arm(null);
        sfx.play("click", 0.5);
        return;
      }
      const why = api.ctrl.powerBlocker(p);
      if (why) {
        api.notify(why, "bad");
        btn.classList.remove("nope");
        void btn.offsetWidth;
        btn.classList.add("nope");
        return;
      }
      arm(p);
      sfx.play("click");
    });
  }

  function update(): void {
    if (el.hidden) return;
    // a match whose rules ban every Drop Pod crew (e.g. an op with no production) has no pod button
    const pod = btns.get("droppod")!.b;
    const podOff = podCrew(w, PLAYER).length === 0;
    if (pod.hidden !== podOff) pod.hidden = podOff;
    // (a duel: the calldowns on their way count as fired, Controller.powerStatus)
    const m = Math.floor(api.ctrl.powerMeter());
    if (meterEl.textContent !== String(m)) meterEl.textContent = String(m);
    for (const [p, v] of btns) {
      const st = api.ctrl.powerStatus(p);
      let k: number;
      let tag: string;
      let state: string;
      if (st.locked > 0) {
        k = 1 - st.locked / (POWERS.hammer.unlock * TICK_RATE);
        tag = clock(st.locked);
        state = "locked";
      } else if (st.cooldown > 0) {
        k = 1 - st.cooldown / st.cooldownTotal;
        tag = clock(st.cooldown);
        state = "cool";
      } else {
        k = st.charge;
        tag = p === "hammer" ? tr("PRÊT", "READY") : String(st.cost);
        state = st.ready ? "ready" : "charging";
      }
      const key = `${state}|${tag}|${Math.round(k * 60)}`;
      if (key === v.key) continue;
      v.key = key;
      v.b.style.setProperty("--k", k.toFixed(3));
      v.tag.textContent = tag;
      for (const s of ["locked", "cool", "ready", "charging"]) v.b.classList.toggle(s, s === state);
    }
    // a power is ready: point at the buttons (once per device, when the hint queue gets to it)
    const anyReady = () => POWER_KINDS.some((p) => p !== "hammer" && !btns.get(p)!.b.hidden && api.ctrl.powerStatus(p).ready);
    if (!hinted && anyReady())
      api.offerHint?.({
        id: "calldowns",
        msg: BELLE_EPOQUE
          ? tr("Ta jauge ⚡ peut payer un appui. Touche ⚡ en bas, un pouvoir lumineux, puis la carte.", "Your ⚡ gauge can pay for a strike. Tap ⚡ at the bottom, a lit-up power, then the map.")
          : tr("Ta jauge ⚡ peut payer un appui. Touche un bouton lumineux à droite, puis la carte.", "Your ⚡ gauge can pay for a strike. Tap a lit-up button on the right, then the map."),
        priority: HINTS.priority.calldowns,
        valid: anyReady,
        onShow: () => {
          hinted = true;
          try {
            localStorage.setItem(HINT_KEY, "1");
          } catch {
            /* ignore */
          }
        }
      });
    // an armed power that stopped being usable disarms itself
    if (targeting && api.ctrl.powerBlocker(targeting)) arm(null);
    // building placement takes over the next tap
    if (targeting && api.ctrl.placing) arm(null);
  }

  // spectators don't call strikes, and some ops play without them (rules.ts noCalldowns)
  if (api.ctrl.spectator || rulesOf(w).noCalldowns) el.hidden = true;

  return {
    get targeting() {
      return targeting;
    },
    tapWorld(x, y) {
      if (!targeting) return false;
      const p = targeting;
      const why = api.ctrl.powerBlocker(p) ?? targetBlocker(w, PLAYER, p, x, y);
      if (why) {
        api.notify(why, "bad");
        aimAt = { x, y };
        return true;
      }
      api.ctrl.enqueue({ type: "calldown", faction: PLAYER, power: p, x, y });
      arm(null);
      return true;
    },
    aim(x, y) {
      if (targeting) aimAt = { x, y };
    },
    preview() {
      if (!targeting) return null;
      const at = aimAt ?? api.viewCentre();
      return { power: targeting, x: at.x, y: at.y, ok: targetBlocker(w, PLAYER, targeting, at.x, at.y) === null };
    },
    cancel() {
      if (targeting) arm(null);
    },
    chip() {
      return targeting ? { label: tr(`Touche la carte : ${POWER_NAMES[targeting]}`, `Tap the map: ${POWER_NAMES[targeting]}`), cancel: () => arm(null) } : null;
    },
    update,
    destroy() {
      el.remove();
    }
  };
}
