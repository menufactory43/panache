/**
 * Command UX widgets mounted into the HUD (no template changes to hud.ts):
 *
 * - Squad chips 1–3 at the head of the chip row: hold to save the
 *   selection, tap to select, double-tap to fly there. Each shows the
 *   dominant unit's icon, a count and a health bar, and flashes red while
 *   a member is being hit.
 * - Build advisor badges: an amber ⚔ on build buttons that counter enemies
 *   you've seen (and on their tab), and an "idle" tag on the Vehicles /
 *   Infantry / Aircraft tab when a factory sits idle while you can afford
 *   its units.
 * - One-time hints that teach the squad gesture, infantry, the Condor, the
 *   Goliath's anchor and the two-Condor lift.
 *
 * Rules live in ../game/squads.ts and ../game/advisor.ts (tested).
 */
import { BUILDINGS, GOLIATH, UNITS } from "../sim/balance";
import { buildingBlocker, unitBlocker } from "../sim/economy";
import { canWalk } from "../sim/goliath";
import { isInfantry, isTransport } from "../sim/infantry";
import { canCarry } from "../sim/lift";
import type { BuildingKind, Faction, FxEvent, UnitKind, World } from "../sim/types";
import { sfx } from "../game/audio";
import { PLAYER, type Controller } from "../game/controller";
import { SQUAD } from "../game/squads";
import { ADVISOR, COUNTERS, EnemyIntel, FACTORY_TAB, IdleWatch, adviceNote, counterAdvice, type FactoryTab } from "../game/advisor";
import { HINTS, type HintOffer } from "../game/hints";

export interface CommandHooks {
  root: HTMLElement;
  world: World;
  ctrl: Controller;
  spectator: boolean;
  /** Glide the camera to a tile point. */
  glideTo(x: number, y: number): void;
  /** A 💡 tip in the ticker right now (feedback to a tap). */
  tip(msg: string, ms?: number): void;
  /** A one-time hint, paced through the HUD's hint queue. */
  offerHint(h: HintOffer): void;
}

const HINTS_KEY = "battledrones.cmdhints";
/** Build-button and tab badges refresh this often (ms). */
const BADGE_MS = 250;

/** A squad chip's portrait, in our side's paint (red's art when we play red). */
const icon = (kind: string) => `assets/icons/${PLAYER === "red" ? "red/" : ""}${kind}.webp`;

/**
 * Build-bar tab of each build option (for the tab's ⚔ dot): a unit sits on
 * its factory's tab, and the Goliath on Vehicles (the Gantry isn't one of
 * the factories the idle watch nags about, so it has no tab of its own).
 */
const TAB_OF = (key: string): "build" | FactoryTab => {
  if (key.startsWith("b:")) return "build";
  const kind = key.slice(2) as UnitKind;
  if (kind === "goliath") return "ground";
  return FACTORY_TAB[UNITS[kind].builtAt] ?? "ground";
};

/** Build-bar tabs, as the HUD names them (src/ui/hud.ts). */
const TABS: ("build" | FactoryTab)[] = ["build", "ground", "infantry", "air"];
/** Defences with a counter entry: the Base tab's ⚔ while another tab is open. */
const DEFENCES = (Object.keys(COUNTERS) as (UnitKind | BuildingKind)[]).filter((k): k is BuildingKind => k in BUILDINGS);

/** One-time tips offered when the selection calls for them (CommandUi.update). */
const SELECTION_HINTS: [string, string][] = [
  ["squads", "Escouades : maintiens 1, 2 ou 3 pour enregistrer la sélection. Touche pour la sélectionner, double-touche pour y aller."],
  ["infantry", "L'infanterie traverse les bois à pleine vitesse et y subit moitié moins de dégâts. Tiens-la loin des Creusot : ils l'écrasent."],
  ["condor", "Montgolfière : sélectionne des escouades, puis touche la Montgolfière pour les embarquer. Appui long sur la carte (ou touche une île) pour les y larguer, ou touche ⇣ Larguer."],
  ["goliath", `⚓ Ancre-le (G) pour prendre le charbon, former des escouades et construire à ${GOLIATH.buildRing} cases. Lève l'ancre pour bouger.`],
  ["lift", "Deux Montgolfières vides soulèvent un Gargantua : touche ton Gargantua pour l'accrocher, puis appui long là où le poser."]
];

interface SquadEl {
  btn: HTMLButtonElement;
  img: HTMLImageElement;
  count: HTMLElement;
  hp: HTMLElement;
  key: string;
}

export class CommandUi {
  readonly intel: EnemyIntel;
  readonly idleWatch: IdleWatch;
  idle: Record<FactoryTab, boolean> = { ground: false, infantry: false, air: false };
  private simT = 0;
  private row: HTMLElement | null = null;
  private squadsEl: HTMLElement | null = null;
  private chips: SquadEl[] = [];
  private lastTap: number[] = Array.from({ length: SQUAD.slots }, () => -Infinity);
  private badgeAt = -Infinity;
  /** When each build option's counter badge lit (wall ms), for the fresh pulse. */
  private litAt = new Map<string, number>();
  private tabNotes = new Map<string, { idle: HTMLElement; ctr: HTMLElement }>();
  private hints = new Set<string>();

  constructor(private h: CommandHooks) {
    const f: Faction = PLAYER;
    this.intel = new EnemyIntel(h.world, f);
    this.idleWatch = new IdleWatch(h.world, f);
    try {
      const raw = localStorage.getItem(HINTS_KEY);
      if (raw) for (const id of JSON.parse(raw) as string[]) this.hints.add(id);
    } catch {
      /* storage blocked: hints may repeat */
    }
    if (!h.spectator) this.mount();
  }

  // ------------------------------------------------------------ mounting --

  private mount(): void {
    const chipsEl = this.h.root.querySelector<HTMLElement>("#chips");
    if (!chipsEl?.parentElement) return;
    // the chip row becomes [squads][context chips], wrapping as one row
    const row = document.createElement("div");
    row.className = "chiprow";
    chipsEl.parentElement.insertBefore(row, chipsEl);
    const squads = document.createElement("div");
    squads.className = "squads";
    squads.dataset.edgeAvoid = "";
    row.append(squads, chipsEl);
    this.row = row;
    this.squadsEl = squads;
    for (let i = 0; i < SQUAD.slots; i++) this.chips.push(this.makeSquad(i, squads));

    for (const t of TABS) {
      const tab = this.h.root.querySelector<HTMLElement>(`.tab[data-tab="${t}"]`);
      if (!tab) continue;
      const notes = document.createElement("span");
      notes.className = "tnotes";
      notes.innerHTML = `<span class="tidle" hidden>inactif</span><span class="tctr" hidden>⚔</span>`;
      tab.appendChild(notes);
      this.tabNotes.set(t, { idle: notes.firstElementChild as HTMLElement, ctr: notes.lastElementChild as HTMLElement });
    }
  }

  private makeSquad(i: number, parent: HTMLElement): SquadEl {
    const btn = document.createElement("button");
    btn.className = "sq empty";
    btn.title = `Escouade ${i + 1} : maintiens pour enregistrer, touche pour sélectionner, double-touche pour y aller (touches ${i + 1} / Ctrl+${i + 1})`;
    btn.innerHTML = `<span class="sqn">${i + 1}</span><img class="sqi" alt="" draggable="false" hidden /><span class="sqc"></span><span class="sqhp"><i></i></span><span class="sqarm"></span>`;
    parent.appendChild(btn);
    let timer = 0;
    let fired = false;
    let down: { x: number; y: number; t: number } | null = null;
    const cancel = () => {
      window.clearTimeout(timer);
      btn.classList.remove("arming");
      down = null;
    };
    btn.addEventListener("pointerdown", (e) => {
      fired = false;
      if (e.button === 2) {
        // right-click saves on desktop
        fired = true;
        this.assign(i);
        return;
      }
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      btn.classList.add("arming");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        fired = true;
        btn.classList.remove("arming");
        this.assign(i);
      }, SQUAD.holdMs);
    });
    btn.addEventListener("pointermove", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) cancel();
    });
    btn.addEventListener("pointerup", () => {
      // a busy main thread can deliver the release before the hold timer
      // runs: a press that lasted the full hold time still counts as a hold
      const held = !!down && !fired && performance.now() - down.t >= SQUAD.holdMs;
      const tapped = !!down && !fired && !held;
      cancel();
      if (held) {
        fired = true;
        this.assign(i);
      } else if (tapped) this.tap(i);
    });
    btn.addEventListener("pointerleave", cancel);
    btn.addEventListener("pointercancel", cancel);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    return {
      btn,
      img: btn.querySelector<HTMLImageElement>(".sqi")!,
      count: btn.querySelector<HTMLElement>(".sqc")!,
      hp: btn.querySelector<HTMLElement>(".sqhp > i")!,
      key: ""
    };
  }

  // ------------------------------------------------------------- actions --

  /** Save the current selection as squad i (or clear it when nothing is selected). */
  assign(i: number): void {
    const ctrl = this.h.ctrl;
    if (this.h.spectator || ctrl.placing) return;
    if (ctrl.selectedUnits.size === 0) {
      if (ctrl.squads.ids(i, this.h.world).length > 0) {
        ctrl.squads.clear(i);
        sfx.play("sell", 0.4);
        this.h.tip(`Escouade ${i + 1} effacée`, 2200);
      } else this.h.tip(`Sélectionne d'abord des unités, puis maintiens ${i + 1} pour en faire une escouade.`, 3500);
      return;
    }
    const n = ctrl.assignSquad(i);
    if (n === 0) return;
    sfx.play("squad", 0.8);
    if (navigator.vibrate) navigator.vibrate(12);
    this.seen("squads");
    const el = this.chips[i]?.btn;
    if (el) {
      el.classList.remove("saved");
      void el.offsetWidth;
      el.classList.add("saved");
      window.setTimeout(() => el.classList.remove("saved"), 400); // frees `animation` for the hurt pulse
    }
  }

  /** Select squad i; a second tap (or key press) soon after flies the camera there. */
  tap(i: number): void {
    const ctrl = this.h.ctrl;
    if (this.h.spectator || ctrl.placing) return;
    const now = performance.now();
    const n = ctrl.selectSquad(i);
    if (n === 0) {
      this.lastTap[i] = -Infinity;
      this.h.tip(
        ctrl.selectedUnits.size > 0
          ? `Maintiens ${i + 1} pour enregistrer la sélection en escouade ${i + 1}.`
          : `Escouade ${i + 1} vide : sélectionne des unités, puis maintiens ${i + 1}.`,
        3500
      );
      return;
    }
    sfx.play("click", 0.5);
    if (now - this.lastTap[i]! < SQUAD.doubleTapMs) {
      const p = ctrl.squads.focus(i, this.h.world);
      if (p) this.h.glideTo(p.x, p.y);
      this.lastTap[i] = -Infinity;
    } else this.lastTap[i] = now;
  }

  /** Keys 1–3: select (twice quickly: fly there); with Ctrl/Cmd/Shift: save. */
  key(i: number, save: boolean): void {
    if (save) this.assign(i);
    else this.tap(i);
  }

  /** The advisor's line for an info card. */
  cardNote(kind: UnitKind | BuildingKind): string | null {
    if (this.h.spectator) return null;
    return adviceNote(counterAdvice(this.h.world, PLAYER, this.intel, kind, this.simT));
  }

  private seen(id: string): void {
    if (this.hints.has(id)) return;
    this.hints.add(id);
    try {
      localStorage.setItem(HINTS_KEY, JSON.stringify([...this.hints]));
    } catch {
      /* ignore */
    }
  }

  /**
   * Offer a once-per-device hint ("squads", "place", "infantry", "condor",
   * "goliath", "lift") to the HUD's hint queue; it counts as seen only once
   * it is shown, and only while it still applies (a group selected / a
   * building being placed / infantry, a Condor or a Goliath selected / two
   * empty Condors selected while a Goliath could be lifted). Safe to call
   * every frame.
   */
  hint(id: string, msg: string): void {
    if (this.h.spectator || this.hints.has(id)) return;
    // (the player may find the gesture on their own while the hint waits)
    const valid = () => !this.hints.has(id) && this.hintApplies(id);
    this.h.offerHint({
      id: `cmd-${id}`,
      msg,
      priority:
        id === "place"
          ? HINTS.priority.placement
          : id === "infantry" || id === "condor"
            ? HINTS.priority.transport
            : id === "goliath" || id === "lift" ? HINTS.priority.goliath : HINTS.priority.squads,
      ttlS: 20,
      valid,
      onShow: () => this.seen(id)
    });
  }

  /** Is hint `id`'s moment still here? (Offered when it arrives; checked again before it shows.) */
  private hintApplies(id: string): boolean {
    const ctrl = this.h.ctrl;
    const w = this.h.world;
    switch (id) {
      case "place":
        return ctrl.placing !== null;
      case "infantry":
        return this.selecting(isInfantry);
      case "condor":
        return this.condorMoment();
      case "goliath":
        return ctrl.goliathsSelected().length > 0;
      case "lift":
        return this.liftMoment();
      case "squads": {
        // a real group (two or more, harvesters aside)
        let army = 0;
        for (const uid of ctrl.selectedUnits) if (w.units.get(uid)?.kind !== "harvester") army++;
        return army >= 2;
      }
      default:
        return false;
    }
  }

  /** The lift tip's moment: two empty Condors selected while we have a Goliath walking (a lift on its way counts as begun). */
  private liftMoment(): boolean {
    const w = this.h.world;
    const ahead = this.h.ctrl.ahead();
    let empty = 0;
    for (const id of this.h.ctrl.selectedUnits) {
      const u = w.units.get(id);
      if (u && u.faction === PLAYER && canCarry(ahead.unit(u))) empty++;
    }
    if (empty < 2) return false;
    for (const u of w.units.values()) if (u.goliath && u.faction === PLAYER && canWalk(ahead.unit(u))) return true;
    return false;
  }

  /** Is a unit of a kind matching `pred` selected? */
  private selecting(pred: (k: UnitKind) => boolean): boolean {
    const w = this.h.world;
    for (const id of this.h.ctrl.selectedUnits) {
      const u = w.units.get(id);
      if (u && pred(u.kind)) return true;
    }
    return false;
  }

  /** The Condor tip's moment: a Condor selected, or squads selected while we own one. */
  private condorMoment(): boolean {
    if (this.selecting(isTransport)) return true;
    if (!this.selecting(isInfantry)) return false;
    for (const u of this.h.world.units.values()) if (u.faction === PLAYER && isTransport(u.kind)) return true;
    return false;
  }

  // -------------------------------------------------------------- update --

  /** This tick's sim events at sim time t. */
  events(fx: readonly FxEvent[], t: number): void {
    this.simT = t;
    if (this.h.spectator) return;
    this.h.ctrl.squads.events(fx, performance.now());
    this.intel.update(t);
    // a squad dropped from a Condor: the player has found the whole load-and-drop loop
    if (!this.hints.has("condor") && fx.some((e) => e.type === "disembark" && !e.bailout && e.faction === PLAYER)) this.seen("condor");
  }

  /** Every frame, after the HUD update. */
  update(): void {
    if (this.h.spectator || !this.row) return;
    const ctrl = this.h.ctrl;
    const w = this.h.world;
    const now = performance.now();
    // squads hide while placing (the ✓ Place chip needs the row)
    const show = !ctrl.placing;
    if (this.squadsEl!.hidden === show) this.squadsEl!.hidden = !show;
    if (show) {
      for (let i = 0; i < this.chips.length; i++) {
        const c = this.chips[i]!;
        const s = ctrl.squads.summary(i, w);
        const on = !!s && ctrl.squads.matches(i, ctrl.selectedUnits, w);
        const hurt = !!s && ctrl.squads.isHurt(i, now);
        const hp = s ? Math.round(s.hp * 20) / 20 : 0;
        const key = s ? `${s.kind}:${s.count}:${hp}:${on}:${hurt}` : `empty:${on}`;
        if (key === c.key) continue;
        c.key = key;
        c.btn.classList.toggle("empty", !s);
        c.btn.classList.toggle("on", on);
        c.btn.classList.toggle("hurt", hurt);
        c.img.hidden = !s;
        if (s) {
          const src = icon(s.kind);
          if (!c.img.src.endsWith(src)) c.img.src = src;
          c.count.textContent = s.count > 1 ? String(s.count) : "";
          c.hp.style.width = `${Math.round(s.hp * 100)}%`;
          c.hp.className = s.hp > 0.6 ? "" : s.hp > 0.3 ? "mid" : "low";
        } else c.count.textContent = "";
      }
      // one tip each, the first time it applies: the squad gesture (a real group selected),
      // robot infantry and the Condor (the first time the player picks them up)
      if (ctrl.selectedUnits.size > 0)
        for (const [id, msg] of SELECTION_HINTS)
          if (!this.hints.has(id) && (id !== "squads" || ctrl.squads.isEmpty()) && this.hintApplies(id)) this.hint(id, msg);
    }
    if (now - this.badgeAt >= BADGE_MS) {
      this.badgeAt = now;
      this.badges(now);
    }
  }

  /** Counter glows on build buttons, and idle / ⚔ notes on the tabs. */
  private badges(now: number): void {
    const w = this.h.world;
    this.idle = this.idleWatch.update(this.simT);
    const tabCtr: Record<"build" | FactoryTab, boolean> = { build: false, ground: false, infantry: false, air: false };
    for (const btn of this.h.root.querySelectorAll<HTMLElement>(".bb[data-key]")) {
      const key = btn.dataset.key!;
      const kind = key.slice(2) as UnitKind | BuildingKind;
      const a = counterAdvice(w, PLAYER, this.intel, kind, this.simT);
      const lit = a.active;
      if (lit && !this.litAt.has(key)) this.litAt.set(key, now);
      if (!lit) this.litAt.delete(key);
      btn.classList.toggle("counter", lit);
      btn.classList.toggle("fresh", lit && now - this.litAt.get(key)! < ADVISOR.freshMs);
      if (lit && !btn.classList.contains("locked")) tabCtr[TAB_OF(key)] = true;
    }
    // buttons on other tabs are detached from the DOM: judge their tabs from the rules directly
    for (const kind of Object.keys(UNITS) as UnitKind[]) {
      const tab = TAB_OF(`u:${kind}`);
      if (tabCtr[tab] || this.h.root.querySelector(`.bb[data-key="u:${kind}"]`)) continue;
      if (counterAdvice(w, PLAYER, this.intel, kind, this.simT).active && !unitBlocker(w, PLAYER, kind)) tabCtr[tab] = true;
    }
    if (
      !this.h.root.querySelector('.bb[data-key^="b:"]') &&
      DEFENCES.some((k) => counterAdvice(w, PLAYER, this.intel, k, this.simT).active && !buildingBlocker(w, PLAYER, k))
    )
      tabCtr.build = true;
    for (const [t, n] of this.tabNotes) {
      const tab = n.idle.closest<HTMLElement>(".tab");
      const current = !!tab?.classList.contains("on");
      const idle = !current && t !== "build" && this.idle[t as FactoryTab];
      const ctr = !current && tabCtr[t as "build" | FactoryTab];
      if (n.idle.hidden === idle) n.idle.hidden = !idle;
      if (n.ctr.hidden === ctr) n.ctr.hidden = !ctr;
    }
  }

  destroy(): void {
    this.row = null;
  }
}
