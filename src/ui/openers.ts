import { BUILDINGS, UNITS } from "../sim/balance";
import { OPENERS, OPENER_IDS, type OpenerId } from "../sim/openers";
import type { Faction, UnitKind } from "../sim/types";
import { sfx } from "../game/audio";
import { PLAYER } from "../game/controller";
import { fullscreen } from "./fullscreen";

/**
 * The pre-match opener choice: three big cards over the (frozen) battlefield.
 * The sim does not tick until a card is picked, so the clock starts with
 * the decision. Tap a card, or press 1 / 2 / 3.
 */
export interface OpenerPickerOptions {
  /** Small context line under the title, e.g. "Riverlands · vs Rush AI (Normal)". */
  context: string;
  onPick(id: OpenerId): void;
  /** Why an opener is unavailable this match (e.g. a mutator bans its factory), or null. */
  blocked?(id: OpenerId): string | null;
  /** Why an opener suits this map especially (a badge on its card), or null. */
  recommended?(id: OpenerId): string | null;
  /** Whose paint the cards' art is in (default: the side we play, PLAYER). */
  side?: Faction;
}

const ICON = (kind: string, side: Faction) => `assets/icons/${side === "red" ? "red/" : ""}${kind}.webp`;

/** What each card promises, as icon pills. */
function pills(id: OpenerId, side: Faction): string {
  const o = OPENERS[id];
  const items: { icon?: string; label: string; cls?: string }[] = [{ icon: o.building, label: BUILDINGS[o.building].name }];
  const counts = new Map<UnitKind, number>();
  for (const k of o.units) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [k, n] of counts) items.push({ icon: k, label: `${n}× ${UNITS[k].name}` });
  items.push({ icon: "harvester", label: `${o.harvesters}× ${UNITS.harvester.name}` });
  if (o.scrap > 0) items.push({ label: `+${o.scrap} charbon` });
  if (o.scrap < 0) items.push({ label: `−${-o.scrap} charbon`, cls: "neg" });
  return items
    .map(
      (it) =>
        `<span class="op-pill ${it.cls ?? ""}">${it.icon ? `<img src="${ICON(it.icon, side)}" alt="" draggable="false"/>` : `<i>⚙</i>`}${it.label}</span>`
    )
    .join("");
}

/** The hero image cluster: the building with its units stacked in front. */
function art(id: OpenerId, side: Faction): string {
  const o = OPENERS[id];
  const unit = o.units[0] ?? "harvester";
  const n = o.units.length || o.harvesters;
  return `<div class="op-art">
      <img class="op-b" src="${ICON(o.building, side)}" alt="" draggable="false"/>
      <img class="op-u" src="${ICON(unit, side)}" alt="" draggable="false"/>
      <span class="op-n">×${n}</span>
    </div>`;
}

export function showOpenerPicker(opts: OpenerPickerOptions): { destroy(): void } {
  const root = document.getElementById("hud")!;
  const side = opts.side ?? PLAYER;
  const el = document.createElement("div");
  el.className = "openers";
  el.innerHTML = `
    <button class="op-back" title="Retour au menu">‹ Menu</button>
    <div class="op-head">
      <h2>Choisis ton ouverture</h2>
      <p class="op-ctx"></p>
    </div>
    <div class="op-cards">
      ${OPENER_IDS.map(
        (id, i) => `
        <button class="op-card op-${id}" data-id="${id}">
          ${art(id, side)}
          <div class="op-text">
            <b class="op-name">${OPENERS[id].name}</b>
            <span class="op-tag">${OPENERS[id].tagline}</span>
            <div class="op-pills">${pills(id, side)}</div>
          </div>
          <span class="op-key">${i + 1}</span>
        </button>`
      ).join("")}
    </div>
    <p class="op-foot">Le chrono démarre dès ton choix. L'ennemi choisit aussi.</p>`;
  el.querySelector(".op-ctx")!.textContent = opts.context;
  // keep touches on the overlay away from the game canvas underneath
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  root.appendChild(el);

  let picked = false;
  let timer = 0;
  const pick = (id: OpenerId) => {
    if (picked) return;
    picked = true;
    sfx.unlock();
    sfx.play("ready");
    el.classList.add("chosen");
    el.querySelectorAll<HTMLElement>(".op-card").forEach((c) => c.classList.toggle("picked", c.dataset.id === id));
    // let the pick register visually, then start the match as the cards fade
    timer = window.setTimeout(() => {
      opts.onPick(id);
      el.classList.add("out");
      timer = window.setTimeout(destroy, 320);
    }, 380);
  };
  el.querySelector(".op-back")!.addEventListener("click", () => fullscreen.reload());
  el.querySelectorAll<HTMLButtonElement>(".op-card").forEach((b) => {
    const why = opts.blocked?.(b.dataset.id as OpenerId);
    const good = why ? null : opts.recommended?.(b.dataset.id as OpenerId);
    if (good) {
      const badge = document.createElement("span");
      badge.className = "op-rec";
      badge.textContent = `★ ${good}`;
      b.querySelector(".op-text")!.appendChild(badge);
    }
    if (why) {
      b.disabled = true;
      b.classList.add("blocked");
      b.querySelector(".op-tag")!.textContent = why;
      return;
    }
    b.addEventListener("click", () => pick(b.dataset.id as OpenerId));
  });
  // 1–3 belong to the cards while they're up: captured before the scene's
  // keyboard sees them (there they'd also be the squad hotkeys)
  const onKey = (e: KeyboardEvent) => {
    const i = Number(e.key) - 1;
    if (!(i >= 0 && i < OPENER_IDS.length)) return;
    e.stopImmediatePropagation();
    if (!opts.blocked?.(OPENER_IDS[i]!)) pick(OPENER_IDS[i]!);
  };
  window.addEventListener("keydown", onKey, true);

  function destroy(): void {
    window.clearTimeout(timer);
    window.removeEventListener("keydown", onKey, true);
    el.remove();
  }
  return { destroy };
}
