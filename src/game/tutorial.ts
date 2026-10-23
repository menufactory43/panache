import { tr } from "../lang";
/**
 * L'Instruction (« Premier jour »): the guided first mission, one gesture at
 * a time. Engine-free and tested (tests/tutorial.test.ts): this module only
 * decides WHAT to say and WHERE to point, from an observation of the match
 * (TutObs) the scene fills in every frame (src/game/tutorial-view.ts). The
 * overlay (src/ui/tutorial.ts) draws the one bubble and the one pointer.
 *
 * The lesson is a list of beats. Each beat has a `guide()` that turns the
 * current state into exactly one instruction (and its target), re-pointing
 * gently when the player wanders off (no unit selected, the drawer closed,
 * the wrong tab…), and a `done()` that moves the lesson on. A beat already
 * done when it starts is skipped silently (the player ran ahead); one done
 * by the player gets a short word of praise before the next instruction.
 *
 * The ten steps the player sees (`step`, for the progress pips):
 *  1 camera (drag, then pinch / wheel) · 2 select · 3 move to the flag ·
 *  4 attack the patrol · 5 build Forges (start, wait, place) · 6 produce a
 *  Panhard · 7 ⚔ Armée · 8 coal · 9 ⚡ Feu roulant · 10 the outpost.
 */

/** What the pointer shows: a HUD control, a spot on the battlefield, or a gesture to mime. */
export type TutTarget =
  | { kind: "dom"; el: TutControl }
  | { kind: "world"; what: TutSpot }
  | { kind: "gesture"; g: "drag" | "pinch" | "wheel" | "keys" };

/** HUD controls the lesson points at (the view maps them to elements, mirrored for Gaucher by the layout itself). */
export type TutControl = "build" | "tab-build" | "tab-ground" | "tile-forges" | "tile-panhard" | "army" | "pill" | "power" | "power-barrage" | "place" | "deselect";

/** Battlefield spots the lesson points at. */
export type TutSpot = "starters" | "flag" | "patrol" | "ghost" | "harvester" | "coal" | "convoy" | "outpost" | "forges";

/** One instruction: short French text, where to point, and whether the gloved hand taps there (false: a ring only). */
export interface TutGuide {
  text: string;
  target: TutTarget | null;
  hand: boolean;
  /** The battlefield holds still until the player acts (a freeze-frame). */
  hold?: boolean;
}

/** Everything the lesson reads from the match, filled in by the scene every frame. */
export interface TutObs {
  /** A touch screen (pinch), or a mouse (wheel). */
  touch: boolean;
  /** Belle Époque HUD (drawer, ⚡ fan); the original HUD has the build bar always open. */
  belle: boolean;
  /** Camera travel (tiles) and zoom ratio since the beat began. */
  panned: number;
  zoomRatio: number;
  /** Our starting Panhard still alive, and how many of them are selected. */
  starters: number;
  startersSelected: number;
  /** Units selected (any). */
  selected: number;
  /** A starting Panhard has an order to (or near) the flag; one stands at the flag. */
  headingToFlag: boolean;
  atFlag: boolean;
  /** Enemy patrol: spawned, seen, alive, under our attack order. */
  patrolSpawned: boolean;
  patrolSeen: boolean;
  patrolAlive: number;
  patrolAttacked: boolean;
  /** A selection fills the bottom bar: Construire and ⚔ Armée step aside until it's closed (Panache HUD). */
  busy: boolean;
  /** Build drawer open, the tab showing ("build" | "ground" | …). */
  drawerOpen: boolean;
  tab: string;
  /** Building under construction (kind, finished?), placement in progress, our Forges standing. */
  pending: { kind: string; ready: boolean } | null;
  placing: string | null;
  forges: number;
  /** Panhard alive now, and Panhard queued in our factories. */
  panhards: number;
  panhardsQueued: number;
  /** Combat units we own, and whether all of them are selected. */
  army: number;
  armySelected: boolean;
  /** Coal delivered so far (stats). */
  harvested: number;
  /** ⚡: Feu roulant ready, the fan open, a power armed, Feu roulant fired (count). */
  barrageReady: boolean;
  fanOpen: boolean;
  armed: string | null;
  barrageFired: number;
  /** The convoy (⚡ target): spawned, seen, alive. */
  convoySpawned: boolean;
  convoySeen: boolean;
  convoyAlive: number;
  /** The outpost: spawned, buildings alive, the army ordered at it. */
  outpostSpawned: boolean;
  outpostAlive: number;
  outpostOrdered: boolean;
  /** Every combat unit stands idle (no order, nothing in its sights). */
  armyIdle: boolean;
  /** Seconds since the beat began. */
  t: number;
}

/** Side effects a beat asks of the scene when it begins. */
export type TutEffect = "deselect" | "glide-starters" | "spawn-patrol" | "close-drawer" | "fund-forges" | "fund-panhard" | "glide-harvester" | "spawn-convoy" | "fill-meter" | "spawn-outpost";

export interface TutBeat {
  id: string;
  /** The step 1–10 it belongs to (progress pips). */
  step: number;
  enter?: TutEffect[];
  guide(o: TutObs): TutGuide;
  done(o: TutObs): boolean;
  /** Praise once done (null: straight on). */
  praise: string | null;
  /** Announcer line (pre-recorded) when the beat begins. */
  voice?: string;
  /** It measures from its own start (the camera beats): never judged on the frame it begins. */
  fresh?: boolean;
}

export const TUT_STEPS = 10;

const dom = (el: TutControl): TutTarget => ({ kind: "dom", el });
const spot = (what: TutSpot): TutTarget => ({ kind: "world", what });
const tap = (text: string, target: TutTarget): TutGuide => ({ text, target, hand: true });
const look = (text: string, target: TutTarget | null): TutGuide => ({ text, target, hand: false });

/** Open the drawer on a tab first, else point at what's on it. */
function inDrawer(o: TutObs, tab: "build" | "ground", then: TutGuide): TutGuide {
  if (o.belle && !o.drawerOpen && o.busy) return tap(tr("Touche ✕ pour fermer la sélection", "Tap ✕ to close the selection"), dom("deselect"));
  if (o.belle && !o.drawerOpen) return tap(tr("Touche 🔨 Construire", "Tap 🔨 Build"), dom("build"));
  if (o.tab !== tab) return tap(tab === "build" ? tr("Ouvre l'onglet Base", "Open the Base tab") : tr("Ouvre l'onglet Véhicules", "Open the Vehicles tab"), dom(tab === "build" ? "tab-build" : "tab-ground"));
  return then;
}

/** Select the army first (⚔ Armée), else `then`. */
function withArmy(o: TutObs, then: TutGuide): TutGuide {
  if (o.selected === 0) return tap(o.belle ? tr("Touche ⚔ Armée d'abord", "Tap ⚔ Army first") : tr("Touche Toute l'armée d'abord", "Tap All army first"), dom("army"));
  return then;
}

export const TUT_BEATS: TutBeat[] = [
  {
    id: "pan",
    step: 1,
    guide: (o) =>
      o.touch
        ? { text: tr("Glisse un doigt pour regarder autour", "Drag a finger to look around"), target: { kind: "gesture", g: "drag" }, hand: true }
        : { text: tr("Flèches du clavier pour regarder autour", "Arrow keys to look around"), target: { kind: "gesture", g: "keys" }, hand: false },
    done: (o) => o.panned >= 3,
    praise: tr("Parfait !", "Perfect!"),
    fresh: true,
    voice: tr("Essai radio", "Radio check")
  },
  {
    id: "zoom",
    step: 1,
    guide: (o) =>
      o.touch
        ? { text: tr("Pince avec deux doigts pour zoomer", "Pinch with two fingers to zoom"), target: { kind: "gesture", g: "pinch" }, hand: true }
        : { text: tr("Molette de la souris pour zoomer", "Mouse wheel to zoom"), target: { kind: "gesture", g: "wheel" }, hand: false },
    done: (o) => o.zoomRatio >= 1.2 || o.zoomRatio <= 1 / 1.2,
    praise: tr("Très bien !", "Very good!"),
    fresh: true
  },
  {
    id: "select",
    step: 2,
    enter: ["glide-starters"],
    guide: () => tap(tr("Touche un de tes Panhard", "Tap one of your Panhards"), spot("starters")),
    done: (o) => o.startersSelected > 0,
    praise: tr("Panhard à tes ordres !", "Panhard at your command!")
  },
  {
    id: "move",
    step: 3,
    guide: (o) => {
      if (o.headingToFlag) return look(tr("En route vers le drapeau…", "On the way to the flag…"), spot("flag"));
      if (o.startersSelected === 0) return tap(tr("Touche d'abord un Panhard", "Tap a Panhard first"), spot("starters"));
      return tap(tr("Touche le drapeau pour y aller", "Tap the flag to go there"), spot("flag"));
    },
    done: (o) => o.atFlag,
    praise: tr("Bien arrivé !", "Well arrived!")
  },
  {
    id: "attack",
    step: 4,
    enter: ["spawn-patrol"],
    guide: (o) => {
      if (!o.patrolSeen) return look(tr("Une patrouille ennemie approche…", "An enemy patrol approaches…"), spot("patrol"));
      if (o.patrolAttacked) return look(tr("Feu à volonté !", "Fire at will!"), spot("patrol"));
      if (o.selected === 0) return { ...tap(tr("Touche d'abord un Panhard", "Tap a Panhard first"), spot("starters")), hold: true };
      return { ...tap(tr("Touche l'ennemi pour attaquer", "Tap the enemy to attack"), spot("patrol")), hold: true };
    },
    done: (o) => o.patrolSpawned && o.patrolAlive === 0,
    praise: tr("Victoire ! Patrouille détruite.", "Victory! Patrol destroyed."),
    voice: tr("Blindés ennemis en approche", "Enemy armour inbound")
  },
  {
    id: "forges",
    step: 5,
    enter: ["deselect", "fund-forges"],
    guide: (o) => inDrawer(o, "build", tap(tr("Touche Forges pour les bâtir", "Tap Forges to build them"), dom("tile-forges"))),
    done: (o) => o.pending?.kind === "fab-plant" || o.forges > 0,
    praise: tr("Chantier lancé !", "Construction started!")
  },
  {
    id: "forges-wait",
    step: 5,
    guide: (o) =>
      o.belle && !o.drawerOpen ? look(tr("Les Forges se construisent…", "The Forges are going up…"), dom("build")) : look(tr("Les Forges se construisent…", "The Forges are going up…"), dom("tile-forges")),
    done: (o) => !!o.pending?.ready || o.forges > 0 || !!o.placing,
    praise: null
  },
  {
    id: "place",
    step: 5,
    guide: (o) => {
      if (o.placing === "fab-plant") return tap(tr("Touche le fantôme pour bâtir ici", "Tap the ghost to build here"), spot("ghost"));
      return inDrawer(o, "build", tap(tr("Prêtes ! Touche Forges pour les placer", "Ready! Tap Forges to place them"), dom("tile-forges")));
    },
    done: (o) => o.forges > 0,
    praise: tr("Les Forges sont debout !", "The Forges stand!")
  },
  {
    id: "produce",
    step: 6,
    enter: ["fund-panhard"],
    guide: (o) => inDrawer(o, "ground", tap(tr("Touche Panhard pour en produire un", "Tap Panhard to produce one"), dom("tile-panhard"))),
    done: (o) => o.panhardsQueued > 0,
    praise: tr("En production !", "In production!")
  },
  {
    id: "produce-wait",
    step: 6,
    guide: () => look(tr("Ton Panhard sort des Forges…", "Your Panhard rolls out of the Forges…"), spot("forges")),
    // (one fewer queued than before means it rolled out; or the queue simply emptied)
    done: (o) => o.panhardsQueued === 0,
    praise: tr("Un Panhard de plus !", "One more Panhard!")
  },
  {
    id: "army",
    step: 7,
    enter: ["close-drawer", "deselect"],
    guide: (o) =>
      o.busy && !o.armySelected
        ? tap(tr("Touche ✕ pour fermer la sélection", "Tap ✕ to close the selection"), dom("deselect"))
        : tap(o.belle ? tr("Touche ⚔ Armée : toutes tes unités", "Tap ⚔ Army: all your units") : tr("Touche Toute l'armée", "Tap All army"), dom("army")),
    done: (o) => o.army > 0 && o.armySelected,
    praise: tr("Toute l'armée est prête !", "The whole army is ready!")
  },
  {
    id: "coal",
    step: 8,
    enter: ["glide-harvester"],
    guide: () => look(tr("Ton Fardier extrait le charbon seul", "Your Steam Wagon mines coal by itself"), spot("harvester")),
    done: (o) => o.t >= 4,
    praise: null
  },
  {
    id: "coal-pill",
    step: 8,
    guide: () => look(tr("Le charbon livré s'ajoute ici", "Delivered coal adds up here"), dom("pill")),
    done: (o) => o.t >= 4.5,
    praise: tr("Le charbon paie tout !", "Coal pays for everything!")
  },
  {
    id: "power",
    step: 9,
    enter: ["spawn-convoy", "fill-meter"],
    guide: (o) => {
      if (!o.convoySeen) return look(tr("Un convoi ennemi approche…", "An enemy convoy approaches…"), spot("convoy"));
      if (!o.barrageReady && o.barrageFired === 0) return { ...look(tr("La jauge ⚡ se remplit…", "The ⚡ gauge is filling…"), dom("power")), hold: true };
      if (o.armed === "barrage") return { ...tap(tr("Touche le convoi ennemi", "Tap the enemy convoy"), spot("convoy")), hold: true };
      if (o.belle && !o.fanOpen) return { ...tap(tr("Touche ⚡ : tes pouvoirs", "Tap ⚡: your powers"), dom("power")), hold: true };
      return { ...tap(tr("Choisis Feu roulant", "Choose Rolling Barrage"), dom("power-barrage")), hold: true };
    },
    done: (o) => o.barrageFired > 0,
    praise: tr("Feu roulant en route !", "Rolling Barrage on its way!")
  },
  {
    id: "power-wait",
    step: 9,
    guide: () => look(tr("Attention… les obus arrivent !", "Careful… shells incoming!"), spot("convoy")),
    done: (o) => o.convoyAlive === 0 || o.t >= 7,
    praise: tr("En plein dans le mille !", "Right on the mark!")
  },
  {
    id: "outpost",
    step: 10,
    enter: ["spawn-outpost"],
    guide: (o) => {
      // (one building down and the army stood idle: point at the last one)
      if (o.outpostOrdered && o.outpostAlive === 1 && o.armyIdle) return withArmy(o, tap(tr("Achève l'avant-poste !", "Finish off the outpost!"), spot("outpost")));
      if (o.outpostOrdered) return look(tr("À l'assaut de l'avant-poste !", "Storm the outpost!"), spot("outpost"));
      return withArmy(o, tap(tr("Touche l'avant-poste ennemi", "Tap the enemy outpost"), spot("outpost")));
    },
    done: (o) => o.outpostSpawned && o.outpostAlive === 0,
    praise: tr("Tu es prêt, mon commandant !", "You're ready, commander!")
  }
];

/** How long a word of praise stays up before the next instruction (s). */
export const PRAISE_S = 1.6;

export interface TutFrame {
  beat: TutBeat;
  index: number;
  /** "do": the instruction is up; "praise": the beat is done, praise shows; "end": the lesson is over. */
  phase: "do" | "praise" | "end";
  guide: TutGuide | null;
  praise: string | null;
  /** Effects to run now (the beat just began). */
  effects: TutEffect[];
  /** Voice line to say now (the beat just began). */
  voice: string | null;
}

/**
 * Walks the beats: feed it an observation every frame (`dt` in seconds) and
 * it says what to show. Beats already done on entry are skipped without
 * praise. `t` in the observation is overwritten with the beat's own clock.
 */
export class TutorialRunner {
  index = 0;
  private beatT = 0;
  private praiseT = -1;
  private entered = -1;
  /** Beats done, in order (debugging, tests). */
  readonly log: string[] = [];

  constructor(readonly beats: TutBeat[] = TUT_BEATS) {}

  get beat(): TutBeat {
    return this.beats[Math.min(this.index, this.beats.length - 1)]!;
  }

  get over(): boolean {
    return this.index >= this.beats.length;
  }

  /** Seconds since the current beat began. */
  get clock(): number {
    return this.beatT;
  }

  update(o: TutObs, dt: number): TutFrame {
    const effects: TutEffect[] = [];
    let voice: string | null = null;
    if (this.over) return { beat: this.beat, index: this.index, phase: "end", guide: null, praise: this.beat.praise, effects, voice };
    // praise up: let it run, then the next beat
    if (this.praiseT >= 0) {
      this.praiseT += dt;
      if (this.praiseT < PRAISE_S) return { beat: this.beat, index: this.index, phase: "praise", guide: null, praise: this.beat.praise, effects, voice };
      this.praiseT = -1;
      this.next();
      if (this.over) return { beat: this.beat, index: this.index, phase: "end", guide: null, praise: this.beat.praise, effects, voice };
    }
    // a beat begins: its effects (once) — and if it's already done, skip it quietly
    let fresh = false;
    for (let guard = 0; guard < this.beats.length; guard++) {
      if (this.entered !== this.index) {
        this.entered = this.index;
        this.beatT = 0;
        effects.push(...(this.beat.enter ?? []));
        if (this.beat.voice) voice = this.beat.voice;
        // (effects that spawn things haven't run yet: a spawning beat can't be done on entry;
        // a fresh beat's measures start now: the caller resets them once it sees the new index)
        fresh = !!this.beat.fresh;
        const spawns = (this.beat.enter ?? []).some((e) => e.startsWith("spawn"));
        if (!spawns && !fresh && this.beat.done({ ...o, t: 0 })) {
          this.log.push(`${this.beat.id}:skip`);
          this.next();
          if (this.over) return { beat: this.beat, index: this.index, phase: "end", guide: null, praise: null, effects, voice };
          continue;
        }
      }
      break;
    }
    this.beatT += dt;
    const obs = { ...o, t: this.beatT };
    if (!fresh && this.beat.done(obs)) {
      this.log.push(this.beat.id);
      if (this.beat.praise) {
        this.praiseT = 0;
        const last = this.index === this.beats.length - 1;
        return { beat: this.beat, index: this.index, phase: last ? "end" : "praise", guide: null, praise: this.beat.praise, effects, voice };
      }
      this.next();
      if (this.over) return { beat: this.beat, index: this.index, phase: "end", guide: null, praise: null, effects, voice };
      // (the next beat's effects and instruction come on the next frame)
      return { beat: this.beat, index: this.index, phase: "do", guide: null, praise: null, effects, voice };
    }
    return { beat: this.beat, index: this.index, phase: "do", guide: this.beat.guide(obs), praise: null, effects, voice };
  }

  private next(): void {
    this.index++;
    this.beatT = 0;
  }
}

// ------------------------------------------------------------- storage ---

const KEY = "battledrones.instruction";

/** Has the player done the Instruction ("done"), turned it down or left it ("no"), or never been asked (null)? */
export function tutorialState(): "done" | "no" | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "done" || v === "no" ? v : null;
  } catch {
    return "no"; // (storage blocked: never nag)
  }
}

export function setTutorialState(v: "done" | "no"): void {
  try {
    // (done stays done: leaving a replay doesn't undo it)
    if (v === "no" && localStorage.getItem(KEY) === "done") return;
    localStorage.setItem(KEY, v);
  } catch {
    /* ignore */
  }
}
