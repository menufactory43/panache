/**
 * Panache's in-game HUD (Belle Époque only, theme.ts BELLE_EPOQUE): the
 * same widgets as the original HUD, regrouped so a phone shows five things
 * at rest instead of twenty:
 *
 * - top left, one pill "⚙ 512 +88/m · 0:06": tap it for a small panel with
 *   what left the screen (Relays and supply crates, the battle meter, game
 *   speed with its hold-the-clock fast-forward, sound, pause);
 *   under it, a mode's own pill (Last Stand's wave, an op's goal) and one
 *   alert line (the announcements, once big centre banners) over the ticker;
 * - top right, a smaller minimap with the pause button on its corner;
 * - bottom right, 🔨 Construire (badge: items in production) opening the
 *   build bar as a drawer (a bottom sheet in portrait, a side panel in
 *   landscape), and ⚡ above it (a ring for the Command meter) fanning out
 *   the four calldowns;
 * - bottom left, ⚔ Armée (badge: idle units): tap selects the army,
 *   long-press the idle ones, swipe up shows the squad chips 1–3 and the
 *   role chips Infanterie / Blindés / Aviation (shown anyway while units are
 *   selected or once a squad is saved); beside it ▢ Cadre: the next drag on
 *   the map draws a selection box, no long-press needed;
 * - with a selection, placement or an armed calldown: the selection panel
 *   and its chips as one command bar along the bottom.
 *
 * Nothing is rebuilt: the existing elements (hud.ts, awareness.ts,
 * command.ts, powers.ts, objectives.ts) are moved into place and restyled
 * (belle-hud.css), so every rule, id and handler keeps working.
 * `?style=original` never mounts this.
 */
import { crestImg, nationShort } from "./nations-ui";
import type { NationOrClassic } from "../sim/types";
import { sfx } from "../game/audio";
import type { Controller } from "../game/controller";
import { tr } from "../lang";
import { buzz } from "../native";

// --------------------------------------------------------------- prefs ---

const PREFS_KEY = "panache.hud";

export interface HudPrefs {
  /** Show the ＋/− zoom buttons (pinch zooms either way). */
  zoom: boolean;
  /** Left-handed: Construire and ⚡ on the left, Armée on the right, the drawer on the left. */
  lefty: boolean;
}

const prefListeners = new Set<() => void>();

export function hudPrefs(): HudPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<HudPrefs>;
    return { zoom: raw.zoom === true, lefty: raw.lefty === true };
  } catch {
    return { zoom: false, lefty: false };
  }
}

function setHudPref<K extends keyof HudPrefs>(k: K, v: HudPrefs[K]): void {
  const p = { ...hudPrefs(), [k]: v };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: this match only */
  }
  for (const l of [...prefListeners]) l();
}

const SETTINGS: { k: keyof HudPrefs; icon: string; label: string; title: string }[] = [
  { k: "zoom", icon: "🔍", label: tr("Boutons de zoom", "Zoom buttons"), title: tr("Affiche les boutons ＋ et − (le pincement zoome toujours)", "Shows the ＋ and − buttons (pinching always zooms)") },
  { k: "lefty", icon: "✋", label: tr("Gaucher", "Lefty"), title: tr("Construire et ⚡ à gauche, Armée à droite", "Build and ⚡ on the left, Army on the right") }
];

/** The pause menu's interface toggles (Boutons de zoom, Gaucher); returns a cleanup function. */
export function mountHudSettings(host: HTMLElement): () => void {
  host.classList.add("sound-row", "hud-row");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", tr("Interface", "Interface"));
  host.innerHTML = SETTINGS.map(
    (s) => `<button class="snd" data-k="${s.k}" title="${s.title}" aria-pressed="false"><span class="si">${s.icon}</span><span class="sl">${s.label}</span></button>`
  ).join("");
  const sync = () => {
    const p = hudPrefs();
    host.querySelectorAll<HTMLButtonElement>(".snd").forEach((b) => {
      const on = p[b.dataset.k as keyof HudPrefs];
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  };
  host.querySelectorAll<HTMLButtonElement>(".snd").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.k as keyof HudPrefs;
      setHudPref(k, !hudPrefs()[k]);
      sfx.play("click", 0.5);
    })
  );
  sync();
  prefListeners.add(sync);
  return () => prefListeners.delete(sync);
}

// ----------------------------------------------------------------- HUD ---

export interface BelleHudHooks {
  root: HTMLElement;
  ctrl: Controller;
  spectator: boolean;
  /** The player's nation: its crest leads the pill (Classique: none). */
  nation?: NationOrClassic;
  togglePause(): void;
  /** A 💡 line in the ticker (feedback to a tap that did nothing). */
  tip(msg: string): void;
}

/** What hud.ts knows about production each frame. */
export interface BelleBuildState {
  /** Units queued everywhere, plus the building under construction. */
  queued: number;
  /** A finished building waits to be placed. */
  ready: boolean;
}

export interface BelleHud {
  /** Every frame, after hud.ts has updated its chips and build bar. */
  update(s: BelleBuildState): void;
  /** Close the drawer, the ⚡ fan and the pill panel. */
  closeAll(): void;
  destroy(): void;
}

/** Hold time for ⚔ Armée's "idle units" (ms) and the swipe that shows the squads (CSS px). */
const ARMY = { holdMs: 450, swipe: 26 } as const;
/** Swipe-down distance that closes the drawer (CSS px). */
const SHEET_SWIPE = 40;

export function mountBelleHud(h: BelleHudHooks): BelleHud {
  const root = h.root;
  const ctrl = h.ctrl;
  root.classList.add("bh");
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const shield = (el: HTMLElement) => el.addEventListener("pointerdown", (e) => e.stopPropagation());
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = "") => {
    const el = document.createElement(tag);
    el.className = cls;
    if (html) el.innerHTML = html;
    return el;
  };

  // ------------------------------------------------ the top-left column ---
  // pill (+ its panel), a mode's pills, the alert line, the ticker: one column, in flow
  const col = make("div", "bh-col");
  root.insertBefore(col, root.firstChild);
  const tl = q(".tl")!;
  const topbar = q(".topbar")!;
  const banner = q("#banner")!;
  const toasts = q("#toasts")!;
  col.append(tl, topbar, banner, toasts);

  const pill = make("button", "bh-pill");
  pill.title = tr("Charbon, revenu et horloge : touche pour les détails", "Coal, income and clock: tap for details");
  if (h.nation && h.nation !== "classique") {
    pill.insertAdjacentHTML("afterbegin", crestImg(h.nation, "bh-crest"));
    pill.classList.add(`nat-${h.nation}`);
    pill.title = `${nationShort(h.nation)} · ${pill.title}`;
  }
  const res = q("#res");
  if (res) pill.appendChild(res);
  const clockEl = make("span", "bh-clock", "0:00");
  const speedEl = make("span", "bh-speed");
  pill.append(clockEl, speedEl, make("span", "bh-caret", "▾"));
  tl.prepend(pill);

  const drop = make(
    "div",
    "bh-drop",
    `<div class="bh-row bh-r-obj" hidden><span class="bh-lb">${tr("Relais · ravitaillement", "Relays · supply")}</span></div>
     <div class="bh-row bh-r-meter"><span class="bh-lb">${tr("Rapport de force", "Balance of power")}</span><span class="bh-nometer">${tr("Aucun combat en vue", "No fight in sight")}</span></div>
     <div class="bh-row bh-r-tempo"><span class="bh-lb">${tr("Vitesse", "Speed")}</span><small class="bh-note">${tr("Maintiens l'heure pour 3×", "Hold the clock for 3×")}</small></div>
     <div class="bh-row bh-r-btns"></div>`
  );
  drop.hidden = true;
  tl.appendChild(drop);
  const rowObj = drop.querySelector<HTMLElement>(".bh-r-obj")!;
  const rowMeter = drop.querySelector<HTMLElement>(".bh-r-meter")!;
  const rowTempo = drop.querySelector<HTMLElement>(".bh-r-tempo")!;
  const rowBtns = drop.querySelector<HTMLElement>(".bh-r-btns")!;
  const mute = q("#btn-mute");
  if (mute) rowBtns.appendChild(mute);
  const dpause = make("button", "round bh-dpause", "❚❚");
  dpause.title = tr("Pause et réglages", "Pause and settings");
  rowBtns.appendChild(dpause);
  dpause.addEventListener("click", () => {
    closeDrop();
    h.togglePause();
  });
  const openDrop = () => {
    drop.hidden = false;
    pill.classList.add("open");
  };
  const closeDrop = () => {
    drop.hidden = true;
    pill.classList.remove("open");
  };
  pill.addEventListener("click", () => {
    sfx.play("click", 0.4);
    if (drop.hidden) {
      closeFan();
      openDrop();
    } else closeDrop();
  });

  // ---------------------------------------------------------- minimap ---
  const mini = q(".minimap-wrap");
  const menuBtn = q("#btn-menu");
  if (mini && menuBtn) {
    menuBtn.classList.add("bh-pause");
    mini.appendChild(menuBtn);
    shield(menuBtn);
  }

  // ------------------------------------------- the bottom-corner buttons ---
  const army = make("button", "bh-fab bh-army", tr(`<span class="bh-ic">⚔</span><span class="bh-cap">Armée</span><span class="bh-badge" hidden></span>`, `<span class="bh-ic">⚔</span><span class="bh-cap">Army</span><span class="bh-badge" hidden></span>`));
  army.title = tr("Touche : toute l'armée · appui long : les inactifs · glisse vers le haut : escouades et rôles", "Tap: whole army · long-press: idle units · swipe up: squads and roles");
  const build = make("button", "bh-fab bh-build", tr(`<span class="bh-ic">🔨</span><span class="bh-cap">Construire</span><span class="bh-badge" hidden></span>`, `<span class="bh-ic">🔨</span><span class="bh-cap">Build</span><span class="bh-badge" hidden></span>`));
  build.title = tr("Construire et produire", "Build and produce");
  const pow = make("button", "bh-pow", `<span class="bh-ring"></span><span class="bh-face"><span class="bh-ic">⚡</span></span><span class="bh-n">0</span>`);
  pow.title = tr("Pouvoirs du commandant", "Commander powers");
  const squadsBox = make("div", "bh-squads");
  // (a dashed frame: the box it draws)
  const frame = make(
    "button",
    "bh-frame",
    `<svg class="bh-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="4 2.6"/></svg>`
  );
  frame.title = tr("Cadre : la prochaine glissade sur la carte encadre les unités à sélectionner", "Frame: the next drag on the map frames the units to select");
  frame.setAttribute("aria-label", tr("Sélection en cadre", "Frame selection"));
  const armyBadge = army.querySelector<HTMLElement>(".bh-badge")!;
  const buildBadge = build.querySelector<HTMLElement>(".bh-badge")!;
  const powN = pow.querySelector<HTMLElement>(".bh-n")!;
  for (const el of [army, frame, build, pow, squadsBox]) {
    el.dataset.edgeAvoid = "";
    shield(el);
  }
  if (!h.spectator) root.append(squadsBox, army, frame, pow, build);

  // ------------------------------------------------------------ drawer ---
  const sheet = make("div", "bh-sheet", tr(`<button class="bh-handle" aria-label="Fermer"><i></i></button>`, `<button class="bh-handle" aria-label="Close"><i></i></button>`));
  sheet.dataset.edgeAvoid = "";
  shield(sheet);
  const bar = q(".buildbar");
  if (bar && !h.spectator) {
    sheet.appendChild(bar);
    root.appendChild(sheet);
  }
  const card = q("#card");
  let sheetOpen = false;
  const openSheet = () => {
    sheetOpen = true;
    root.classList.add("bh-sheet-open");
    closeFan();
    closeDrop();
  };
  const closeSheet = () => {
    if (!sheetOpen) return;
    sheetOpen = false;
    root.classList.remove("bh-sheet-open");
    if (card) card.hidden = true;
  };
  build.addEventListener("click", () => {
    sfx.play("click", 0.5);
    if (sheetOpen) closeSheet();
    else openSheet();
  });
  // the handle: tap or swipe it away (down in portrait; toward the edge in landscape)
  const handle = sheet.querySelector<HTMLElement>(".bh-handle")!;
  handle.addEventListener("click", closeSheet);
  let sheetDown: { x: number; y: number } | null = null;
  sheet.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    // (a swipe that starts on a tile is a tile press: only the handle and the tab row drag)
    sheetDown = t.closest(".bh-handle, .tabs") ? { x: e.clientX, y: e.clientY } : null;
  });
  sheet.addEventListener("pointerup", (e) => {
    if (!sheetDown) return;
    const dx = e.clientX - sheetDown.x;
    const dy = e.clientY - sheetDown.y;
    sheetDown = null;
    const landscape = window.innerWidth > window.innerHeight;
    const lefty = root.classList.contains("bh-lefty");
    if (!landscape ? dy > SHEET_SWIPE : lefty ? dx < -SHEET_SWIPE : dx > SHEET_SWIPE) closeSheet();
  });

  // ---------------------------------------------------------- ⚡ powers ---
  let powers: HTMLElement | null = null;
  let fanOpen = false;
  const openFan = () => {
    if (!powers) return;
    fanOpen = true;
    closeDrop();
    placeFan();
    root.classList.add("bh-fan-open");
  };
  const closeFan = () => {
    fanOpen = false;
    root.classList.remove("bh-fan-open");
  };
  /** The fan opens around ⚡: its centre in CSS px, and which way is "inward". */
  const placeFan = () => {
    if (!powers) return;
    const r = pow.getBoundingClientRect();
    powers.style.setProperty("--fx", `${Math.round(r.left + r.width / 2)}px`);
    powers.style.setProperty("--fy", `${Math.round(r.top + r.height / 2)}px`);
  };
  pow.addEventListener("click", () => {
    sfx.play("click", 0.5);
    if (fanOpen) closeFan();
    else openFan();
  });

  // ----------------------------------------------------------- ⚔ Armée ---
  let squadPeek = false;
  let peekAt = 0;
  {
    let timer = 0;
    let fired = false;
    let down: { y: number } | null = null;
    army.addEventListener("pointerdown", (e) => {
      fired = false;
      down = { y: e.clientY };
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        fired = true;
        buzz(8);
        selectIdle();
      }, ARMY.holdMs);
    });
    army.addEventListener("pointermove", (e) => {
      if (!down || fired) return;
      if (down.y - e.clientY > ARMY.swipe) {
        fired = true;
        window.clearTimeout(timer);
        squadPeek = !squadPeek;
        peekAt = performance.now();
        sfx.play("click", 0.4);
      }
    });
    const end = () => {
      window.clearTimeout(timer);
      down = null;
    };
    army.addEventListener("pointerup", end);
    army.addEventListener("pointercancel", end);
    army.addEventListener("contextmenu", (e) => e.preventDefault());
    army.addEventListener("click", () => {
      if (fired) return;
      if (ctrl.armyIds().length === 0) return h.tip(tr("Pas encore d'armée : produis des unités avec 🔨 Construire.", "No army yet: produce units with 🔨 Build."));
      sfx.play("click", 0.5);
      ctrl.selectArmy();
    });
  }
  // ▢ Cadre: arm (or disarm) a box for the next drag on the map (GameScene's boxNow)
  frame.addEventListener("click", () => {
    sfx.play("click", 0.4);
    ctrl.boxNext = !ctrl.boxNext;
    if (ctrl.boxNext) h.tip(tr("Glisse sur la carte pour encadrer les unités à sélectionner.", "Drag across the map to frame the units to select."));
  });
  function selectIdle(): void {
    const idle = ctrl.idleArmy();
    if (idle.length === 0) return h.tip(tr("Aucune unité inactive.", "No idle units."));
    sfx.play("click", 0.5);
    ctrl.selectUnits(idle);
  }

  // ------------------------------------------------- taps elsewhere ---
  const onDocDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (!drop.hidden && !tl.contains(t)) closeDrop();
    if (fanOpen && !pow.contains(t) && !powers?.contains(t)) closeFan();
    // the battlefield (not the minimap): the drawer and a peeked squad row go away
    const field = t.tagName === "CANVAS" && t.id !== "minimap";
    if (field) {
      closeSheet();
      squadPeek = false;
    }
  };
  document.addEventListener("pointerdown", onDocDown, true);

  // ------------------------------------------------------------- prefs ---
  const applyPrefs = () => {
    const p = hudPrefs();
    root.classList.toggle("bh-zoom", p.zoom);
    root.classList.toggle("bh-lefty", p.lefty);
  };
  applyPrefs();
  prefListeners.add(applyPrefs);

  // ------------------------------------------------------------ update ---
  /** Widgets mounted after the HUD (awareness, command, powers, objectives), moved in on the first frames. */
  let adoptTries = 0;
  let adopted = false;
  const count = make("span", "bh-count");
  function adopt(): void {
    adoptTries++;
    const tempo = q(".tempo");
    if (tempo && tempo.parentElement !== rowTempo) rowTempo.insertBefore(tempo, rowTempo.querySelector(".bh-note"));
    const meter = q(".bmeter");
    if (meter && meter.parentElement !== rowMeter) rowMeter.insertBefore(meter, rowMeter.querySelector(".bh-nometer"));
    const obj = q(".objpill");
    if (obj && obj.parentElement !== rowObj) {
      rowObj.appendChild(obj);
      rowObj.hidden = false;
    }
    const squads = q(".squads");
    if (squads && squads.parentElement !== squadsBox) squadsBox.appendChild(squads);
    const roles = q(".roles");
    if (roles && roles.parentElement !== squadsBox) squadsBox.appendChild(roles);
    const ctx = q(".ctx");
    if (ctx && count.parentElement !== ctx) ctx.insertBefore(count, ctx.querySelector(".chiprow") ?? q("#chips"));
    const pw = q(".powers");
    if (pw && pw !== powers) {
      powers = pw;
      powers.classList.add("bh-fan");
    }
    if (!tempo) rowTempo.hidden = adoptTries > 3;
    adopted = (!!tempo || adoptTries > 3) && !!meter && !!pw && (h.spectator || !!squads) || adoptTries > 30;
  }

  const chipsEl = q("#chips");
  const dock = q(".dock");
  const srcClock = () => q("#clock");
  const srcSpeed = () => q("#speed");
  let lastPlacing: string | null = null;
  let lastArmed = false;
  let lastMode = "";
  let lastClock = "";
  let lastSpeed = "";
  let lastBuild = "";
  let lastArmy = "";
  let lastPow = "";
  let lastSq = "";
  let lastFrame = false;
  let lastDock = "";
  let lastCount = "";
  let varsAt = -Infinity;

  function update(s: BelleBuildState): void {
    if (!adopted) adopt();
    // the pill mirrors the clock (and the speed, when it isn't 1×)
    const c = srcClock()?.textContent ?? "";
    if (c !== lastClock) clockEl.textContent = lastClock = c;
    const sp = srcSpeed();
    const spd = sp && sp.isConnected && sp.textContent !== "1×" ? sp.textContent ?? "" : "";
    if (spd !== lastSpeed) {
      speedEl.textContent = lastSpeed = spd;
      speedEl.hidden = spd === "";
    }

    // placement or an armed calldown closes the drawer and the fan (once, as it starts)
    const placing = ctrl.placing;
    if (placing && placing !== lastPlacing) {
      closeSheet();
      closeFan();
    }
    lastPlacing = placing;
    const armed = !!powers?.classList.contains("arming");
    if (armed && !lastArmed) {
      closeFan();
      closeSheet();
    }
    lastArmed = armed;

    // the command bar: a selection, a placement, an armed calldown (or a mode's own chip, e.g. Call wave)
    const selUnits = ctrl.selectedUnits.size;
    const busy = selUnits > 0 || ctrl.selectedBuilding !== null || !!placing || armed;
    let extra = false;
    if (chipsEl) for (const ch of chipsEl.children) if (!["army", "idle"].includes((ch as HTMLElement).dataset.id ?? "")) extra = true;
    const mode = busy ? "busy" : extra ? "chips" : "rest";
    if (mode !== lastMode) {
      root.dataset.bh = lastMode = mode;
      varsAt = -Infinity;
    }
    const cnt = selUnits > 1 ? `×${selUnits}` : "";
    if (cnt !== lastCount) {
      count.textContent = lastCount = cnt;
      count.hidden = cnt === "";
    }

    if (h.spectator) return layoutVars();

    // 🔨 badge: everything in production; ✓ when a building waits to be placed
    const bk = `${s.queued}|${s.ready}`;
    if (bk !== lastBuild) {
      lastBuild = bk;
      buildBadge.hidden = s.queued === 0 && !s.ready;
      buildBadge.textContent = s.ready ? "!" : String(s.queued);
      build.classList.toggle("ready", s.ready);
    }
    // ⚔ badge: idle units (anchored Goliaths aside)
    const armyN = ctrl.armyIds().length;
    const idle = armyN > 0 ? ctrl.idleArmy().length : 0;
    const ak = `${armyN > 0}|${idle}`;
    if (ak !== lastArmy) {
      lastArmy = ak;
      armyBadge.hidden = idle === 0;
      armyBadge.textContent = String(idle);
      army.classList.toggle("empty", armyN === 0);
    }
    // ⚡: the Command meter as a ring, glowing when a calldown is ready (hidden with no calldowns)
    const noPowers = !powers || powers.hidden;
    const meter = Math.max(0, Math.floor(ctrl.powerMeter()));
    const ready = !noPowers && !!powers!.querySelector(".pw.ready:not([hidden])");
    const pk = `${noPowers}|${meter}|${ready}|${armed}`;
    if (pk !== lastPow) {
      lastPow = pk;
      pow.hidden = noPowers;
      pow.style.setProperty("--k", String(Math.min(1, meter / 100)));
      powN.textContent = String(meter);
      pow.classList.toggle("ready", ready);
      pow.classList.toggle("armed", armed);
    }
    if (fanOpen) placeFan();
    // ▢ Cadre lit while armed (a placement or an armed calldown has the map: it disarms)
    if (ctrl.boxNext && (placing || armed)) ctrl.boxNext = false;
    if (ctrl.boxNext !== lastFrame) {
      lastFrame = ctrl.boxNext;
      frame.classList.toggle("on", lastFrame);
      frame.setAttribute("aria-pressed", String(lastFrame));
    }
    // squads 1–3: with a selection, once one is saved, or swiped up (a peek lasts 6 s)
    if (squadPeek && selUnits === 0 && performance.now() - peekAt > 6000) squadPeek = false;
    const showSq = !placing && (selUnits > 0 || squadPeek || !ctrl.squads.isEmpty());
    const sk = String(showSq);
    if (sk !== lastSq) {
      lastSq = sk;
      squadsBox.classList.toggle("on", showSq);
    }
    layoutVars();
  }

  /** Measured offsets the stylesheet needs: the command bar's height, the info card's spot over the drawer. */
  function layoutVars(): void {
    const now = performance.now();
    if (now - varsAt < 120) return;
    varsAt = now;
    const H = window.innerHeight;
    const W = window.innerWidth;
    let dockH = 0;
    if (dock) {
      const r = dock.getBoundingClientRect();
      if (r.height > 0 && r.top < H) dockH = Math.round(H - r.top);
    }
    let cardB = "";
    let cardS = "";
    if (sheetOpen) {
      const r = sheet.getBoundingClientRect();
      if (W > H) cardS = `${Math.round(root.classList.contains("bh-lefty") ? r.right + 10 : W - r.left + 10)}px`;
      else cardB = `${Math.round(H - r.top + 8)}px`;
    }
    const key = `${dockH}|${cardB}|${cardS}`;
    if (key === lastDock) return;
    lastDock = key;
    root.style.setProperty("--bh-dock-h", `${dockH}px`);
    if (cardB) root.style.setProperty("--bh-card-b", cardB);
    else root.style.removeProperty("--bh-card-b");
    if (cardS) root.style.setProperty("--bh-card-s", cardS);
    else root.style.removeProperty("--bh-card-s");
  }

  return {
    update,
    closeAll() {
      closeSheet();
      closeFan();
      closeDrop();
    },
    destroy() {
      document.removeEventListener("pointerdown", onDocDown, true);
      prefListeners.delete(applyPrefs);
      root.classList.remove("bh", "bh-sheet-open", "bh-fan-open", "bh-zoom", "bh-lefty");
    }
  };
}
