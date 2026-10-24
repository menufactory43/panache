import { BUILDINGS, ECONOMY, GOLIATH, INFANTRY as INF, LIFELINE, OBJECTIVES, POWERS, TICK_RATE, UNITS } from "../sim/balance";
import { nationMatchups } from "../unit-info";
import { nationRuleNote } from "./nations-ui";
import { buildingCostFor, buildingMaxHp, buildingMaxHpOf, nationKind } from "../sim/nations";
import { agree, isFeminine, pluralName } from "../sim/lexicon";
import { buildingBlocker, queuesOf, unitBlocker } from "../sim/economy";
import { Vis } from "../sim/fog";
import { anchorBlocker, modeProgress, unitCost, weaponReady } from "../sim/goliath";
import { isTransport, squadAlive, squadSize, unitSeenBy } from "../sim/infantry";
import { liftedBy } from "../sim/lift";
import { goliathBase, inRoster, nationOf } from "../sim/rules";
import { displayName } from "../sim/lexicon";
import { portraitKind } from "../game/three/belle/placeholders";
import type { BuildingKind, Faction, GoliathWeapon, Nation, NationOrClassic, QueueItem, Unit, UnitKind, World } from "../sim/types";
import { hasBuilding } from "../sim/world";
import { sfx } from "../game/audio";
import { mapThumbUrl } from "../game/assets";
import type { Controller } from "../game/controller";
import { PLAYER, isArmyUnit, isProducer, isRooted, pickProducer } from "../game/controller";
import { onAnnounce, type Announcement } from "../game/announce";
import { radioCue } from "../game/announcer";
import { mountAudioToggles } from "./audio-panel";
import { createSurvivalHud } from "./survival";
import { NAMED_RANK, heroLine, killsLabel, stars } from "../game/heroes";
import { addReportSection, showReport } from "./report";
import { markBanned, pauseRulesHtml } from "./career";
import { rematchToken } from "../game/mode";
import { createOpsHud } from "./ops";
import { opById } from "../sim/ops";
import { mountHudLayout } from "./layout";
import { HINTS, HintQueue, type HintOffer } from "../game/hints";
import { fullscreen } from "./fullscreen";
import { mapById } from "../sim/maps";
import { BELLE_EPOQUE } from "../game/three/theme";
import { mountBelleHud, mountHudSettings, type BelleHud } from "./belle-hud";
import { watchMatchFocus } from "./match-focus";
import { abandonMatch } from "../game/resume";
import { tr } from "../lang";
import { DIFFICULTY, type Difficulty } from "../sim/ai/commander";

/** `?debug`: the pause menu's fog switch (not for players: it reveals the map). */
const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("debug");

export interface HudApi {
  world: World;
  ctrl: Controller;
  /** The ground the camera sees (tiles; a trapezoid under the tilted view), outlined on the minimap. */
  viewQuad(): { x: number; y: number }[];
  centerCamera(wx: number, wy: number): void;
  zoomBy(factor: number): void;
  matchSeconds(): number;
  /** Spectator mode: the two AI strategy names, else null. */
  strategies: { blue: string; red: string } | null;
  enemy: { strategy: string; difficulty: string };
  /** Extra info-card line for a build option (the counter advisor). */
  cardNote?(kind: UnitKind | BuildingKind): string | null;
  /** Battlefield wrecks the player knows about (tiles), drawn as gold minimap dots. */
  wrecks?: () => { x: number; y: number }[];
  /** While a calldown is armed: the "Tap map: …" chip and its cancel (powers). */
  targetChip?: () => { label: string; cancel(): void } | null;
  /** Calldown reticles in flight (tiles), drawn as rings on the minimap. */
  calldowns?: () => { x: number; y: number; r: number; enemy: boolean }[];
  /** A big moment owns the screen (opener cards, the finale): no new hints, the hint clock stops. */
  busy?: () => boolean;
  /** Extra minimap marks (map objectives), drawn over the unit blips; k = minimap px per tile. */
  minimapOverlay?: (ctx: CanvasRenderingContext2D, k: number) => void;
  /**
   * Uncharted (mode.ts unchartedMatch, read once at the start): the map is played blind. The minimap
   * shows only what's been scouted, the pause menu has no map reveal, and the end screen reveals it.
   */
  uncharted?: boolean;
  /** A sound duel (an interactive feed): its pause menu and report buttons. Absent in single player and replays. */
  duel?: DuelHud;
}

/**
 * A sound duel's parts of the HUD (SOUND-DUEL.md "MatchFeed and GameScene"),
 * from its feed (src/versus/feed.ts): the pause menu's line and its ways out
 * in place of "Quit to menu", and the report's buttons.
 */
export interface DuelHud {
  /** Who the other phone is: "your friend". */
  opponent: string;
  /** The input delay in ms (the pause line: "vs your friend · 🔊 400 ms"). */
  delayMs(): number;
  /** Resign, confirmed in the pause menu. `leave` ("Resign and leave"): no finale, straight to the report once it lands. */
  resign(leave: boolean): void;
  /** "Leave (no result)", confirmed: the match ends here for both phones. */
  leave(): void;
  /** The pause menu's ways out besides Resign: "Resign and leave" while the friend's packets arrive, "Leave (no result)" once the link is lost. */
  exits(): { resignAndLeave: boolean; leave: boolean };
  /** A resign is on its way: the pause menu offers none. */
  resigning(): boolean;
  /** The report's Rematch and Main menu: each leaves the duel first (its end frames go out), then reloads. */
  rematch(): void;
  menu(): void;
  /** The report's buttons between Rematch and the menu (Save battle). */
  actions(): { id: string; label: string; cls?: string; on(): void }[];
  /** A practice link (no sound): no record kept, and the report says so. */
  practice: boolean;
  /** An online duel (over the internet, not sound): the pause line and the report say so. */
  online?: boolean;
}

/** What a duel's end screen adds: a head instead of VICTORY / DEFEAT (no result), and more buttons (Copy debug info). */
export interface EndOpts {
  head?: { title: string; cls: "win" | "lose"; sub: string };
  actions?: { id: string; label: string; cls?: string; on(): void }[];
}

export interface Hud {
  /** Every frame; `dtMs` is the frame's real time (drives hint pacing). */
  update(dtMs?: number): void;
  /** The end screen: who won, or "draw" (Robot Love), which never reads as a defeat; null: a duel with no result (`opts.head` says why). */
  showEnd(winner: Faction | "draw" | null, opts?: EndOpts): void;
  alert(msg: string, x: number, y: number): void;
  /** A small radio caption for an announcer line (tap jumps to x, y). */
  radio(msg: string, tone: string, x?: number, y?: number): void;
  /** A minimap ping; "inbound" is a bigger amber pulse for an approaching raid. */
  ping(x: number, y: number, kind?: "hit" | "inbound"): void;
  /** A 💡 tip in the ticker right now (feedback to a tap), shown for `ms`; tapping it jumps to (x, y). */
  hint(msg: string, ms?: number, x?: number, y?: number): void;
  /**
   * A one-time onboarding hint, paced through the hint queue (src/game/hints.ts):
   * at most one every 12 s, most important first, never over a banner or the
   * opener cards. Re-offering a waiting id is a no-op.
   */
  offerHint(h: HintOffer): void;
  /** Is a banner whose key starts with `prefix` showing or waiting? */
  bannerUp(prefix: string): boolean;
  /** A small toast (veteran promoted / lost…); tapping it jumps to (x, y). */
  notice(msg: string, tone: "good" | "bad" | "info", x: number, y: number): void;
  /** A plain short toast (e.g. why a calldown can't fire). */
  notify(msg: string, tone?: "bad" | "good"): void;
  togglePause(): void;
  destroy(): void;
}

type Tab = "build" | "ground" | "infantry" | "air";
/** The duel exit a pause menu is asking about. */
type DuelAsk = "resign" | "resign-leave" | "leave";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "build", label: "Base", icon: "🏗" },
  { id: "ground", label: tr("Véhicules", "Vehicles"), icon: "⛓" },
  { id: "infantry", label: tr("Infanterie", "Infantry"), icon: "🤖" },
  { id: "air", label: tr("Aviation", "Aircraft"), icon: "✈" }
];

// Every kind in its drawer place, the nations' among Classique's; a match shows
// its side's roster (inRoster: Classique, exactly the 16 units and 9 buildings as before)
const EVERY_BUILDABLE: BuildingKind[] = ["fab-plant", "airpad", "assembly-bay", "tech-lab", "depot", "turret", "arsonval", "sam-site", "flak-battery", "radar", "gantry"];
const GROUND: UnitKind[] = [
  "harvester", "fourgon", "estafette", "stinger", "jamais-contente", "flak-crawler", "de-dion", "mortar", "branly", "mortier-280",
  "mastodon", "lancer", "atelier", "goliath", "zenith"
];
const INFANTRY: UnitKind[] = ["trooper", "fusiliers", "rocket-squad", "sapeurs", "sniper", "carabiniers"];
const AIR: UnitKind[] = ["scout", "wasp", "gyroptere", "raptor", "epervier", "hornet", "vulcain", "mender", "condor", "titan"];
const UNIT_TABS: { tab: Tab; kinds: UnitKind[] }[] = [
  { tab: "ground", kinds: GROUND },
  { tab: "infantry", kinds: INFANTRY },
  { tab: "air", kinds: AIR }
];
const EVERY_UNIT = UNIT_TABS.flatMap((t) => t.kinds);
/** The build-bar tab a unit's button sits on. */
const tabOf = (kind: UnitKind): Tab => UNIT_TABS.find((t) => t.kinds.includes(kind))?.tab ?? "ground";

/** Counter hints for the info card, distilled from the duel matrix (tools/balance.ts). */
const MATCHUPS: Partial<Record<UnitKind | BuildingKind, { strong: string; weak: string }>> = {
  harvester: { strong: "—", weak: tr("Tout. Protège-le.", "Everything. Protect it.") },
  scout: { strong: tr("Repérer à travers le brouillard", "Spotting through the fog"), weak: tr("Faucheux, Blériot, Ruggieri", "Daddy-Longlegs, Blériots, Ruggieri") },
  stinger: { strong: tr("Faucheux, Canons de 75, Hydroglisseurs, Fardiers", "Daddy-Longlegs, French 75s, Hydrogliders, Steam Wagons"), weak: tr("Éole, Creusot, Albatros", "Éoles, Creusots, Albatros") },
  "flak-crawler": { strong: tr("Tous les aéronefs", "All aircraft"), weak: tr("Toute unité au sol", "Any ground unit") },
  mortar: { strong: tr("Bâtiments, armées groupées", "Buildings, massed armies"), weak: tr("Panhard au contact, aéronefs", "Panhards up close, aircraft") },
  mastodon: { strong: tr("Panhard, Faucheux, Canons de 75", "Panhards, Daddy-Longlegs, French 75s"), weak: tr("Artificiers, Hydroglisseurs, Éole", "Rocketeers, Hydrogliders, Éoles") },
  lancer: { strong: tr("Creusot, Gargantuas, Faucheux, Blériot ; traverse l'eau", "Creusots, Gargantuas, Daddy-Longlegs, Blériots; crosses water"), weak: tr("Essaims de Panhard, Albatros", "Panhard swarms, Albatros") },
  goliath: { strong: tr("Armées au sol et bases ; une base qui marche", "Ground armies and bases; a walking base"), weak: tr("Artificiers, Éole, Hydroglisseurs, Albatros", "Rocketeers, Éoles, Hydrogliders, Albatros") },
  wasp: { strong: tr("Panhard, Creusot, Gargantuas, Canons de 75", "Panhards, Creusots, Gargantuas, French 75s"), weak: tr("Faucheux, Blériot, Hydroglisseurs", "Daddy-Longlegs, Blériots, Hydrogliders") },
  raptor: { strong: tr("Éole, Albatros, Patries", "Éoles, Albatros, Patries"), weak: tr("Faucheux, Hydroglisseurs, Ruggieri", "Daddy-Longlegs, Hydrogliders, Ruggieri") },
  hornet: { strong: tr("Bases, Creusot, Gargantuas, groupes", "Bases, Creusots, Gargantuas, groups"), weak: tr("Faucheux, Blériot, Ruggieri", "Daddy-Longlegs, Blériots, Ruggieri") },
  mender: { strong: tr("Garde ton armée en vie ; seul à réparer un Gargantua", "Keeps your army alive; the only one that repairs a Gargantua"), weak: tr("Tout ce qui tire en l'air", "Anything that shoots air") },
  trooper: { strong: tr("Artificiers, raids légers ; tire aussi en l'air", "Rocketeers, light raids; also fires at air"), weak: tr("Chasseurs alpins, Canons de 75, Albatros, Hotchkiss", "Alpine Chasseurs, French 75s, Albatros, Hotchkiss") },
  "rocket-squad": { strong: tr("Creusot, Gargantuas, Albatros, blindés lourds", "Creusots, Gargantuas, Albatros, heavy armour"), weak: tr("Pioupious, Chasseurs alpins, Canons de 75", "Poilus, Alpine Chasseurs, French 75s") },
  sniper: { strong: tr("Infanterie à longue portée ; se cache en forêt", "Long-range infantry; hides in woods"), weak: tr("Panhard, Éole, tout blindé", "Panhards, Éoles, any armour") },
  condor: { strong: tr("Largue 2 escouades partout, sur l'eau et la roche", "Drops 2 squads anywhere, over water and rock"), weak: tr("Faucheux, Blériot, Ruggieri", "Daddy-Longlegs, Blériots, Ruggieri") },
  turret: { strong: tr("Raids au sol ou aériens, infanterie", "Ground or air raids, infantry"), weak: tr("Canons de 75, Albatros", "French 75s, Albatros") },
  "sam-site": { strong: tr("Aéronefs à longue portée", "Aircraft at long range"), weak: tr("Toute unité au sol", "Any ground unit") },
  "assembly-bay": { strong: tr("Escouades bon marché qui tiennent forêts et Relais", "Cheap squads that hold woods and Relays"), weak: tr("Dégâts de zone : Canons de 75, Albatros", "Area damage: French 75s, Albatros") },
  gantry: { strong: tr("Construit les Gargantuas, la base qui marche", "Builds Gargantuas, the walking base"), weak: tr("Toujours visible par l'ennemi ; Canons de 75, Albatros", "Always visible to the enemy; French 75s, Albatros") }
};

/** A Goliath's weapon systems in the order damage takes them, with short labels for the selection panel. */
const GOLIATH_STRIP: { k: GoliathWeapon; short: string }[] = [
  { k: "mortars", short: tr("Mortiers", "Mortars") },
  { k: "laser", short: tr("Arc", "Arc") },
  { k: "cannons", short: tr("Canons", "Cannons") },
  { k: "mg", short: tr("Mitr.", "MG") }
];

/** A Goliath's state for the selection panel: walking, anchoring (with progress), anchored, packing up, or on a lift. */
function goliathMode(u: Unit): string {
  const g = u.goliath!;
  if (g.lift) return g.lift.phase === "hooking" ? tr("Montgolfières en accroche…", "Montgolfier Balloons hooking on…") : tr("⇡ Aéroporté", "⇡ Airborne");
  const pct = `${Math.floor(modeProgress(u) * 20) * 5}%`;
  const air = flies(u);
  if (g.mode === "anchoring") return `⚓ ${air ? tr("Amarrage", "Mooring") : tr("Ancrage", "Anchoring")} ${pct}`;
  if (g.mode === "packing") return `⇡ ${air ? tr("Largage", "Casting off") : tr("Levée", "Weighing anchor")} ${pct}`;
  return g.mode === "anchored" ? (air ? tr("⚓ Amarré", "⚓ Moored") : tr("⚓ Ancré", "⚓ Anchored")) : air ? tr("En vol", "In flight") : tr("En marche", "Walking");
}

/** A super-unit that flies (the Zénith): it moors (amarrer) rather than anchors (ancrer). */
const flies = (u: Unit): boolean => UNITS[u.kind].domain === "air";

/** One weapon system's state: firing, held (grounded to its machine guns on a lift), rebooting or offline. */
function weaponState(u: Unit, k: GoliathWeapon): "on" | "held" | "boot" | "off" {
  const ws = u.goliath!.weapons[k];
  if (ws.online) return weaponReady(u, k) ? "on" : "held";
  return ws.reboot >= 0 ? "boot" : "off";
}

const ARMOR_FR: Record<string, string> = tr(
  { light: "léger", medium: "moyen", heavy: "lourd", structure: "structure", infantry: "infanterie" },
  { light: "light", medium: "medium", heavy: "heavy", structure: "structure", infantry: "infantry" }
);

/** Compact labels for the narrow build buttons. */
const SHORT: Partial<Record<UnitKind | BuildingKind, string>> = {
  "fab-plant": "Forges", airpad: "Meudon", "tech-lab": "Poly", "sam-site": "Rugg.", radar: tr("TSF", "Wireless"), turret: "Hotch.",
  "assembly-bay": tr("Manuf.", "Manuf."), gantry: tr("Galerie", "Galerie"), mortar: tr("Canon 75", "French 75"), lancer: tr("Hydro", "Hydro"), condor: tr("Montgolfière", "Balloon"),
  trooper: tr("Pioupious", "Poilus"), "rocket-squad": tr("Artificiers", "Rocketeers"), sniper: tr("Chasseurs", "Chasseurs")
};

/**
 * Compact labels in a nations match: the nations' new kinds, and the shared
 * buildings a nation renames (the Classique SHORT would name the wrong one).
 */
const NATION_SHORT: Record<Nation, Partial<Record<UnitKind | BuildingKind, string>>> = {
  republique: {
    fourgon: tr("Fourgon", "Van"), "jamais-contente": "Jamais-C.", "de-dion": "De Dion", branly: "Branly", sapeurs: tr("Sapeurs", "Sappers"),
    arsonval: tr("Bobine", "Coil"), "fab-plant": "Garage", depot: tr("Station", "Station"), gantry: tr("Hangar", "Hangar")
  },
  empire: {
    estafette: tr("Estafette", "Rider"), "mortier-280": tr("Mortier 280", "Mortar 280"), atelier: tr("Atelier", "Workshop"), fusiliers: tr("Fusiliers", "Fusiliers"), carabiniers: tr("Carabiniers", "Carabiniers"),
    "flak-battery": tr("Batt. 47", "47 mm"), airpad: tr("Aérodrome", "Aerodrome"), "tech-lab": tr("Ht-fourneau", "Furnace"), radar: tr("Ballon", "Balloon"), "assembly-bay": tr("Caserne", "Barracks")
  }
};

const MINIMAP_PX = 256;
/** Under Uncharted, unscouted ground on the minimap: solid (the usual shroud's colour, opaque). */
const MINIMAP_SHROUD = "rgb(5,7,12)";
/**
 * Minimap marks in side colours, not friend and foe: blue is blue on both
 * phones of a sound duel. Unit blips come in two tints of each side's colour,
 * the brighter one for our own army so it still stands out. Blue's own tint
 * and red's foe tint are the two the minimap always used, so blue's player
 * sees it exactly as before; a red player sees red lifted a step and blue
 * dimmed by about the same step (7 L*), still clear of blue's building fill.
 */
const MINIMAP_SIDE: Record<Faction, { building: string; own: string; foe: string; ring: string; goliath: string; goliathRim: string }> = {
  blue: { building: "#3d8bff", own: "#9fd0ff", foe: "#78bcff", ring: "rgba(159,208,255,0.6)", goliath: "#cfe8ff", goliathRim: "#1d4f8f" },
  red: { building: "#ff4a3a", own: "#ffccc2", foe: "#ffb0a0", ring: "rgba(255,140,120,0.6)", goliath: "#ff7a66", goliathRim: "#5a0f08" }
};

/**
 * The minimap blip of one of side `f`'s units, as `pov`'s player sees it. A
 * spectator (null) has no army of its own and sees what blue's player sees,
 * which is what spectators have always seen.
 */
export function minimapDot(f: Faction, pov: Faction | null): string {
  const side = MINIMAP_SIDE[f];
  return f === (pov ?? "blue") ? side.own : side.foe;
}

/**
 * Under Uncharted, the minimap's unexplored tiles as solid rects (x, y, w, h, … in px of an S-px
 * minimap): a run per row, on whole pixels, covering every pixel an unexplored tile touches —
 * translucent tiles meeting mid-pixel would let the map's thumbnail through at their seams.
 */
export function shroudRects(vis: ArrayLike<number>, W: number, H: number, S: number): number[] {
  const k = S / W;
  const out: number[] = [];
  for (let ty = 0; ty < H; ty++) {
    const y0 = Math.floor(ty * k);
    const y1 = Math.ceil((ty + 1) * k);
    for (let tx = 0; tx < W; ) {
      if (vis[ty * W + tx] !== Vis.Unexplored) {
        tx++;
        continue;
      }
      const run = tx;
      while (tx < W && vis[ty * W + tx] === Vis.Unexplored) tx++;
      const x0 = Math.floor(run * k);
      out.push(x0, y0, Math.ceil(tx * k) - x0, y1 - y0);
    }
  }
  return out;
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** Uncharted's end-screen reveal: the map played blind, its name, share code and whole thumbnail. */
export function revealHtml(mapId: string): string {
  const def = mapById(mapId);
  const code = def.random ? ` <small style="opacity:0.7">#${escHtml(def.random.code)}</small>` : "";
  return `<div class="aar-tip reveal" style="flex-direction:row;align-items:center;gap:12px;text-align:left">
    <img src="${mapThumbUrl(mapId)}" alt="" draggable="false" width="76" height="76" style="flex:none;border-radius:8px"/>
    <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
      <b>${tr("Carte révélée", "Map revealed")}</b><span>${escHtml(def.name)}${code}</span>
      <small style="color:#c3cde0">${tr("Rejoue-la depuis la carte 🎲", "Replay it from the map 🎲")}</small>
    </div></div>`;
}

/** Each side's nation in the match on screen (createHud sets it): a nation's own buildings show its own portraits. */
let portraitNations: Partial<Record<Faction, NationOrClassic>> = {};
/** A portrait in a side's paint (ours unless told otherwise): red's units and buildings show red, whoever is looking. */
const icon = (kind: string, f: Faction = PLAYER) => `assets/icons/${f === "red" ? "red/" : ""}${portraitKind(kind, portraitNations[f])}.webp`;

export function createHud(api: HudApi): Hud {
  const root = document.getElementById("hud")!;
  root.innerHTML = `
    <div class="topbar">
      <div class="res" id="res"><span class="gear">⚙</span><span id="scrap">0</span><span class="rate" id="rate"></span></div>
      <div class="clock" id="clock">0:00</div>
      <div id="versus" class="versus" hidden></div>
      <div class="wavepill" id="wavepill" hidden></div>
      <div class="opspill" id="opspill" hidden></div>
    </div>
    <div class="tl">
      <button id="btn-menu" class="round" title="Pause (P)">❚❚</button>
      <button id="btn-mute" class="round" title="${tr("Couper le son (réglages audio dans le menu pause)", "Mute the sound (audio settings in the pause menu)")}">🔊</button>
    </div>
    <div id="toasts" class="toasts"></div>
    <div id="banner" class="banner" hidden></div>
    <div class="minimap-wrap"><canvas id="minimap"></canvas></div>
    <div class="zoombtns">
      <button id="zoom-in" class="zb" title="${tr("Zoom avant (+)", "Zoom in (+)")}">＋</button>
      <button id="zoom-out" class="zb" title="${tr("Zoom arrière (−)", "Zoom out (−)")}">−</button>
    </div>
    <div class="dock">
      <div class="ctx">
        <div class="selpanel" id="selpanel" hidden></div>
        <div class="chips" id="chips"></div>
      </div>
      <div class="buildbar">
        <div class="tabs" id="tabs"></div>
        <div class="grid" id="grid"></div>
      </div>
    </div>
    <div id="card" class="card" hidden></div>
    <div id="pause" class="screen" hidden></div>
    <div id="endscreen" class="screen" hidden></div>
  `;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const scrapEl = $("#scrap");
  const rateEl = $("#rate");
  const clockEl = $("#clock");
  const chipsEl = $("#chips");
  const selEl = $("#selpanel");
  const tabsEl = $("#tabs");
  const gridEl = $("#grid");
  const cardEl = $("#card");
  const pauseEl = $("#pause");
  const endEl = $("#endscreen");
  const toastsEl = $("#toasts");
  const bannerEl = $("#banner");
  const minimap = $<HTMLCanvasElement>("#minimap");
  minimap.width = MINIMAP_PX;
  minimap.height = MINIMAP_PX;
  const mctx = minimap.getContext("2d")!;
  const uncharted = !!api.uncharted;
  // (under Uncharted it only ever shows through scouted tiles: drawMinimap)
  const thumb = new Image();
  thumb.src = mapThumbUrl(api.world.mapId);
  // the ticker and banner sit under whatever the top band really occupies (src/ui/layout.ts)
  const layout = mountHudLayout(root);

  // keep HUD touches from reaching the game canvas
  const shield = (el: HTMLElement) => el.addEventListener("pointerdown", (e) => e.stopPropagation());
  [root.querySelector(".dock"), root.querySelector(".tl"), root.querySelector(".zoombtns"), cardEl, toastsEl, bannerEl]
    .forEach((el) => el && shield(el as HTMLElement));

  const w = api.world;
  const f = () => w.factions[PLAYER];
  // the drawer holds the player's roster: Classique's, or their nation's (PANACHE-CONCEPTION.md §1.4, §1.6)
  const nation = nationOf(w, PLAYER);
  portraitNations = { blue: nationOf(w, "blue"), red: nationOf(w, "red") };
  const BUILDABLE = EVERY_BUILDABLE.filter((k) => inRoster(nation, k));
  const ALL_UNITS = EVERY_UNIT.filter((k) => inRoster(nation, k));
  const tabKinds = (t: Tab) => UNIT_TABS.find((u) => u.tab === t)!.kinds.filter((k) => inRoster(nation, k));
  /** A button's label: the nation's name for a building it renames, else the compact one. */
  const label = (k: UnitKind | BuildingKind) =>
    (nation !== "classique" && (NATION_SHORT[nation][k] ?? (displayName(k, nation) !== displayName(k) ? displayName(k, nation) : undefined))) ||
    SHORT[k] ||
    displayName(k, nation);
  // Last Stand: wave pill, call-wave chip, minimap arrow, end screen
  const surv = w.survival
    ? createSurvivalHud($("#wavepill"), w, { ctrl: api.ctrl, spectator: api.ctrl.spectator, centerCamera: api.centerCamera })
    : null;
  /** Reload straight into another match ("1", "spectate", "daily", "op:<id>"). */
  const relaunch = (token: string) => {
    try {
      sessionStorage.setItem("battledrones.rematch", token);
    } catch {
      /* ignore */
    }
    fullscreen.reload();
  };
  // Ops: goal pill under the clock, objectives card, end-screen stars (ui/ops.ts)
  const ops = w.ops ? createOpsHud($("#opspill"), root, w, { rematch: relaunch }) : null;
  const tutorialMatch = !!(w.ops && opById(w.ops.id)?.tutorial);

  // ---------------------------------------------------------- build bar ---
  let tab: Tab = "build";
  const buttons = new Map<string, HTMLButtonElement>();
  /** Cached child elements of each build button (no per-frame DOM queries), and the price its label shows. */
  const parts = new Map<string, { prog: HTMLElement; lock: HTMLElement; badge: HTMLElement; cost: HTMLElement; price: number }>();

  for (const t of TABS) {
    const b = document.createElement("button");
    b.className = "tab";
    b.dataset.tab = t.id;
    b.innerHTML = `<span class="ti">${t.icon}</span><span class="tl2">${t.label}</span><span class="tbadge" hidden></span>`;
    b.addEventListener("click", () => {
      sfx.play("click", 0.5);
      tab = t.id;
      renderGrid();
    });
    tabsEl.appendChild(b);
  }

  const makeButton = (key: string, kind: string, cost: number, name: string, onTap: () => void, onInfo: () => void) => {
    const b = document.createElement("button");
    b.className = "bb";
    b.dataset.key = key;
    b.innerHTML = `
      <img class="ic" src="${icon(kind)}" alt="" draggable="false" />
      <span class="nm${name.length >= 6 ? " tight" : ""}">${name}</span>
      <span class="cost">${cost}</span>
      <span class="badge" hidden></span>
      <span class="prog" hidden></span>
      <span class="lock" hidden>🔒</span>
      <span class="loopmark" hidden>↻</span>`;
    // long-press (touch) or right-click (mouse) opens the info card
    let timer = 0;
    let longFired = false;
    b.addEventListener("pointerdown", (e) => {
      longFired = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        longFired = true;
        if (navigator.vibrate) navigator.vibrate(8);
        onInfo();
      }, 420);
      if (e.button === 2) {
        window.clearTimeout(timer);
        onInfo();
        longFired = true;
      }
    });
    const clear = () => window.clearTimeout(timer);
    b.addEventListener("pointerup", clear);
    b.addEventListener("pointerleave", clear);
    b.addEventListener("pointercancel", clear);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      if (longFired) return;
      onTap();
    });
    buttons.set(key, b);
    parts.set(key, {
      prog: b.querySelector<HTMLElement>(".prog")!,
      lock: b.querySelector<HTMLElement>(".lock")!,
      badge: b.querySelector<HTMLElement>(".badge")!,
      cost: b.querySelector<HTMLElement>(".cost")!,
      price: cost
    });
    return b;
  };

  for (const kind of BUILDABLE)
    makeButton(`b:${kind}`, kind, BUILDINGS[kind].cost, label(kind), () => {
      // (a sound duel: orders still on their way count as applied, controller.ts BuildView)
      const view = api.ctrl.view();
      const p = view.pending;
      if (p?.kind === kind && p.ready) {
        api.ctrl.placing = kind;
        api.ctrl.clearSelection();
        sfx.play("click");
        return;
      }
      if (p) {
        toast(p.kind === kind ? tr("En construction…", "Under construction…") : tr("Un bâtiment est déjà en construction", "A building is already under construction"));
        return;
      }
      const why = buildingBlocker(w, PLAYER, kind);
      if (why) return toast(why);
      if (view.scrap < BUILDINGS[kind].cost) {
        radioCue("no-scrap");
        return toast(tr("Pas assez de charbon", "Not enough coal"));
      }
      api.ctrl.enqueue({ type: "startBuilding", faction: PLAYER, building: kind });
      sfx.play("click");
    }, () => showCard(kind));

  for (const kind of ALL_UNITS)
    makeButton(`u:${kind}`, kind, unitCost(w, PLAYER, kind), label(kind), () => {
      const why = unitBlocker(w, PLAYER, kind);
      if (why) return toast(why);
      const view = api.ctrl.view();
      if (view.scrap < unitCost(w, PLAYER, kind)) {
        radioCue("no-scrap");
        return toast(tr("Pas assez de charbon", "Not enough coal"));
      }
      // (infantry: a selected anchored Goliath first, else the shortest queue, Bays and Goliaths alike)
      const at = pickProducer(w, kind, api.ctrl.selectedUnits, view);
      if (!at) return toast(kind === "goliath" ? tr("Galerie des Machines occupée", "Galerie des Machines busy") : tr("File de production pleine", "Production queue full"));
      api.ctrl.enqueue({ type: "produce", faction: PLAYER, buildingId: at.id, unit: kind });
      sfx.play("click");
    }, () => showCard(kind));

  function renderGrid(): void {
    gridEl.innerHTML = "";
    const keys =
      tab === "build" ? BUILDABLE.map((k) => `b:${k}`) : tabKinds(tab).map((k) => `u:${k}`);
    for (const k of keys) gridEl.appendChild(buttons.get(k)!);
    for (const el of tabsEl.children) (el as HTMLElement).classList.toggle("on", (el as HTMLElement).dataset.tab === tab);
    cardEl.hidden = true;
  }
  renderGrid();

  // ------------------------------------------------------------ info card ---
  function showCard(kind: UnitKind | BuildingKind): void {
    const isUnit = kind in UNITS;
    const s = isUnit ? UNITS[kind as UnitKind] : BUILDINGS[kind as BuildingKind];
    // a nation's matchups are against the other nation's army (unit-info.ts NATION_COUNTERS)
    const nm = nation !== "classique" ? nationMatchups(kind, nation) : null;
    const m = nm
      ? nm.strong.length || nm.weak.length
        ? { strong: nm.strong.length ? `${tr("Bat", "Beats")} ${nm.strong.join(", ")}` : "—", weak: nm.weak.length ? `${tr("Craint", "Weak to")} ${nm.weak.join(", ")}` : "—" }
        : undefined
      : MATCHUPS[kind];
    const rule = nationRuleNote(kind, nation);
    const rows: string[] = [];
    // (a Goliath's price climbs with every one you have: the card shows today's)
    // (a nation's buildings: its multipliers, Préfabriqué or Vapeur)
    const cost = isUnit ? unitCost(w, PLAYER, kind as UnitKind) : buildingCostFor(w, PLAYER, kind as BuildingKind);
    const hp = isUnit ? s.hp : buildingMaxHpOf(w, PLAYER, kind as BuildingKind);
    rows.push(tr(`<tr><td>Coût</td><td>${cost}</td><td>PV</td><td>${hp}</td></tr>`, `<tr><td>Cost</td><td>${cost}</td><td>HP</td><td>${hp}</td></tr>`));
    /** A Goliath's four weapon systems, in a table of their own after the cost. */
    let weapons = "";
    if (kind === "goliath") {
      rows.push(tr(`<tr><td>Prix</td><td colspan="3">+${Math.round(GOLIATH.costStep * 100)} % par Gargantua possédé</td></tr>`, `<tr><td>Price</td><td colspan="3">+${Math.round(GOLIATH.costStep * 100)}% per Gargantua owned</td></tr>`));
      // four weapon systems instead of one: the longest reach goes first as it is hurt
      weapons = `<table class="gwt"><tr class="gw-head"><td>${tr("Arme", "Weapon")}</td><td>${tr("Portée", "Range")}</td><td></td></tr>${GOLIATH_STRIP.map(({ k }) => {
        const ws = GOLIATH.weapons[k];
        const off = ws.lostBelow > 0 ? tr(`hors service sous ${Math.round(ws.lostBelow * 100)} %`, `out of action below ${Math.round(ws.lostBelow * 100)}%`) : tr("toujours actif", "always active");
        return `<tr><td>${ws.name}</td><td>${ws.range}</td><td>${off}${ws.targets === "both" ? tr(" · air aussi", " · air too") : ""}</td></tr>`;
      }).join("")}</table>`;
    } else if (s.dps > 0) {
      const tgt = s.targets === "both" ? tr("Air + Sol", "Air + Ground") : s.targets === "air" ? tr("Air", "Air") : tr("Sol", "Ground");
      rows.push(tr(`<tr><td>DPS</td><td>${s.dps}</td><td>Portée</td><td>${s.range}</td></tr>`, `<tr><td>DPS</td><td>${s.dps}</td><td>Range</td><td>${s.range}</td></tr>`));
      rows.push(tr(`<tr><td>Cibles</td><td colspan="3">${tgt}${s.splash ? " · zone" : ""}${s.minRange ? ` · portée min ${s.minRange}` : ""}</td></tr>`, `<tr><td>Targets</td><td colspan="3">${tgt}${s.splash ? " · area" : ""}${s.minRange ? ` · min range ${s.minRange}` : ""}</td></tr>`));
    }
    if (isUnit) {
      const u = UNITS[kind as UnitKind];
      rows.push(tr(`<tr><td>Vitesse</td><td>${u.speed}</td><td>Blindage</td><td>${ARMOR_FR[u.armor] ?? u.armor}</td></tr>`, `<tr><td>Speed</td><td>${u.speed}</td><td>Armour</td><td>${ARMOR_FR[u.armor] ?? u.armor}</td></tr>`));
      if (u.heal) rows.push(tr(`<tr><td>Réparation</td><td colspan="3">${u.heal} PV/s</td></tr>`, `<tr><td>Repair</td><td colspan="3">${u.heal} HP/s</td></tr>`));
      // a squad is one unit drawn as several robots; the Condor is a flying bus
      if (u.squad) rows.push(tr(`<tr><td>Escouade</td><td colspan="3">${u.squad} automates · puissance de feu réduite à chaque perte</td></tr>`, `<tr><td>Squad</td><td colspan="3">${u.squad} automata · firepower drops with every loss</td></tr>`));
      if (u.capacity) rows.push(tr(`<tr><td>Soute</td><td colspan="3">Transporte ${u.capacity} escouades · ${agree(kind as UnitKind, "non armé")}</td></tr>`, `<tr><td>Hold</td><td colspan="3">Carries ${u.capacity} squads · unarmed</td></tr>`));
      if (kind === "goliath") rows.push(tr(`<tr><td>Réparation</td><td colspan="3">Pasteur uniquement</td></tr>`, `<tr><td>Repair</td><td colspan="3">Pasteur only</td></tr>`));
      rows.push(tr(`<tr><td>Produit à</td><td colspan="3">${displayName(u.builtAt, nation)}${u.requires ? ` + ${displayName(u.requires, nation)}` : ""}</td></tr>`, `<tr><td>Built at</td><td colspan="3">${displayName(u.builtAt, nation)}${u.requires ? ` + ${displayName(u.requires, nation)}` : ""}</td></tr>`));
    } else {
      const b = BUILDINGS[kind as BuildingKind];
      // every prerequisite, ticked off as it stands (the Gantry needs all four)
      if (b.requiresAll)
        rows.push(`<tr><td>${tr("Requiert", "Requires")}</td><td colspan="3" class="needs">${b.requiresAll
          .map((k) => (hasBuilding(w, PLAYER, k) ? `<span class="have">✓ ${displayName(k, nation)}</span>` : `<span>${displayName(k, nation)}</span>`))
          .join(" ")}</td></tr>`);
      if (b.unique) rows.push(tr(`<tr><td>Limite</td><td colspan="3">${isFeminine(kind as BuildingKind) ? "Une" : "Un"} par camp</td></tr>`, `<tr><td>Limit</td><td colspan="3">One per side</td></tr>`));
    }
    const note = api.cardNote?.(kind) ?? null;
    const view = api.ctrl.view();
    const queuedHere = isUnit
      ? queuesOf(w, PLAYER, kind as UnitKind).reduce((n, p) => n + p.queue.filter((q) => q.kind === kind).length + view.extra(p.id, kind as UnitKind), 0)
      : 0;
    cardEl.innerHTML = `
      <div class="ch"><img src="${icon(kind)}" alt="" /><div><b>${displayName(kind, nation)}</b><p>${s.role}</p></div>
      <button class="x" id="card-x">✕</button></div>
      ${weapons ? `<table>${rows.slice(0, 2).join("")}</table>${weapons}<table>${rows.slice(2).join("")}</table>` : `<table>${rows.join("")}</table>`}
      ${m ? `<p class="good">▲ ${m.strong}</p><p class="bad">▼ ${m.weak}</p>` : ""}
      ${rule ? `<p class="ctr nat-rule">${nation === "republique" ? "⚡" : "♨"} ${rule}</p>` : ""}
      ${note ? `<p class="ctr">⚔ ${note}</p>` : ""}
      ${isUnit ? `<button class="cta small${api.ctrl.loops.has(kind as UnitKind) ? " warn" : ""}" id="card-loop">${
        api.ctrl.loops.has(kind as UnitKind) ? tr("↻ Arrêter la production en boucle", "↻ Stop looping production") : tr("↻ Produire en boucle", "↻ Produce in a loop")
      }</button>` : ""}
      ${queuedHere > 0 ? `<button class="cta small" id="card-cancel">${tr(`En annuler un (${queuedHere} en file)`, `Cancel one (${queuedHere} queued)`)}</button>` : ""}
      ${!isUnit && view.pending?.kind === kind ? `<button class="cta small warn" id="card-cancel-b">${tr("Annuler la construction", "Cancel construction")}</button>` : ""}`;
    cardEl.hidden = false;
    layout.refresh(true); // (portrait: kept under the band at its real height)
    cardEl.querySelector("#card-x")!.addEventListener("click", () => (cardEl.hidden = true));
    // ↻ production in a loop (Controller.loopProduction): each idle producer of it starts the next one
    cardEl.querySelector("#card-loop")?.addEventListener("click", () => {
      const k = kind as UnitKind;
      const on = !api.ctrl.loops.has(k);
      if (on) api.ctrl.loops.add(k);
      else api.ctrl.loops.delete(k);
      const b = buttons.get(`u:${k}`);
      b?.classList.toggle("looping", on);
      b?.querySelector<HTMLElement>(".loopmark")?.toggleAttribute("hidden", !on);
      sfx.play("click");
      toast(
        on
          ? tr(`↻ ${displayName(k, nation)} en boucle`, `↻ ${displayName(k, nation)} looping`)
          : tr(`${displayName(k, nation)} : production en boucle arrêtée`, `${displayName(k, nation)}: looping production stopped`)
      );
      cardEl.hidden = true;
    });
    cardEl.querySelector("#card-cancel")?.addEventListener("click", () => {
      const now = api.ctrl.view();
      const p = queuesOf(w, PLAYER, kind as UnitKind).find((p) => p.queue.some((q) => q.kind === kind) || now.extra(p.id, kind as UnitKind) > 0);
      if (p) api.ctrl.enqueue({ type: "cancelProduce", faction: PLAYER, buildingId: p.id, unit: kind as UnitKind });
      cardEl.hidden = true;
    });
    cardEl.querySelector("#card-cancel-b")?.addEventListener("click", () => {
      api.ctrl.enqueue({ type: "cancelBuilding", faction: PLAYER });
      api.ctrl.placing = null;
      cardEl.hidden = true;
    });
  }

  // --------------------------------------------------------------- chips ---
  type Chip = { id: string; label: string; cls?: string; on: () => void; active?: boolean };
  let lastChipKey = "";
  let lastChipShape = "";
  /** The class each chip was last given (so a refused tap's "nope" shake survives a label tick). */
  let chipCls: string[] = [];
  const chipClass = (c: Chip) => `chip ${c.cls ?? ""} ${c.active ? "active" : ""}`;
  /** The chips as last rendered: a tap runs the current chip's action (one updated in place may now do something else). */
  let chipList: Chip[] = [];
  function renderChips(list: Chip[]): void {
    chipList = list;
    const key = list.map((c) => c.id + (c.active ? "*" : "") + (c.cls ?? "") + c.label).join("|");
    if (key === lastChipKey) return;
    lastChipKey = key;
    // same chips, only a label or style ticked (the call-wave bonus, ✓ Place
    // turning ⚠ Blocked): update in place so a tap in progress isn't lost to a rebuilt button
    const shape = list.map((c) => c.id + (c.active ? "*" : "")).join("|");
    if (shape === lastChipShape && chipsEl.children.length === list.length) {
      list.forEach((c, i) => {
        const el = chipsEl.children[i] as HTMLElement;
        if (el.textContent !== c.label) el.textContent = c.label;
        const cls = chipClass(c);
        if (chipCls[i] !== cls) el.className = chipCls[i] = cls;
      });
      return;
    }
    lastChipShape = shape;
    chipCls = list.map(chipClass);
    chipsEl.innerHTML = "";
    list.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = chipClass(c);
      b.dataset.id = c.id;
      b.textContent = c.label;
      b.addEventListener("click", () => {
        sfx.play("click", 0.5);
        chipList[i]?.on();
      });
      chipsEl.appendChild(b);
    });
  }

  /** Shake chip `id` with a buzz: that tap was refused. */
  function nope(id: string): void {
    sfx.play("deny", 0.6);
    const el = chipsEl.querySelector<HTMLElement>(`.chip[data-id="${id}"]`);
    if (!el) return;
    el.classList.remove("nope");
    void el.offsetWidth;
    el.classList.add("nope");
  }

  /**
   * The selected Goliaths' chip, one id through every state so it updates in
   * place: ⚓ Anchor (or ⚠ why it can't here, which says so and shakes), ⇡ Pack
   * up once anchored, and a progress readout while digging in or packing up
   * (the G key does the same). On a narrow phone the progress is short ("⚓
   * 40%": the panel above says it in full) and a reason wraps onto two lines,
   * so the row stays one row. Null with no Goliath on the ground selected.
   */
  function goliathChip(gs: Unit[], narrow: boolean): Chip | null {
    if (gs.length === 0) return null;
    const ctrl = api.ctrl;
    const walking = gs.filter((g) => g.goliath!.mode === "walking");
    if (walking.length > 0) {
      // (any one that can dig in makes it ⚓ Anchor: those that can, do)
      const why = walking.every((g) => anchorBlocker(w, g)) ? anchorBlocker(w, walking[0]!) : null;
      if (why)
        return { id: "anchor", label: `⚠ ${why}`, cls: "anchor bad", on: () => (ctrl.toggleAnchor(), nope("anchor")) };
      return { id: "anchor", label: walking.every(flies) ? tr("⚓ Amarrer", "⚓ Moor") : tr("⚓ Ancrer", "⚓ Anchor"), cls: "anchor go", on: () => ctrl.toggleAnchor() };
    }
    if (gs.some((g) => g.goliath!.mode === "anchored"))
      return { id: "anchor", label: gs.every(flies) ? tr("⇡ Larguer les amarres", "⇡ Cast off") : tr("⇡ Lever l'ancre", "⇡ Weigh anchor"), cls: "anchor", on: () => ctrl.toggleAnchor() };
    // digging in or packing up: progress only (the one furthest from done)
    const slow = gs.reduce((a, b) => (modeProgress(b) < modeProgress(a) ? b : a));
    const short = `${slow.goliath!.mode === "packing" ? "⇡" : "⚓"} ${Math.floor(modeProgress(slow) * 20) * 5}%`;
    return { id: "anchor", label: narrow ? short : goliathMode(slow), cls: "info", on: () => {} };
  }

  // ------------------------------------------------------ selection panel ---
  let lastSelKey = "";
  /**
   * What ticks between rebuilds, updated in place: a building's or a
   * Goliath's HP, its head queue item's progress bar, a Goliath digging in
   * or packing up.
   */
  let selHpEl: HTMLElement | null = null;
  let selHeadEl: HTMLElement | null = null;
  let selModeEl: HTMLElement | null = null;
  type Live = { hp: string; head: string; mode?: string };

  /** A producer's queue as cancel buttons (`p`: the building's or anchored Goliath's id, on side `f`). */
  const queueHtml = (p: number, q: readonly QueueItem[], f: Faction) =>
    `<div class="queue">${q
      .map((it) => `<button class="qi" data-p="${p}" data-kind="${it.kind}"><img src="${icon(it.kind, f)}" alt=""/><span class="qp" style="height:0%"></span></button>`)
      .join("")}</div>`;
  /** How far the head of a queue is (a CSS height). */
  const headShare = (q: readonly QueueItem[]) => {
    const head = q[0];
    return `${Math.round((head ? 1 - head.remaining / (UNITS[head.kind].buildTime * TICK_RATE) : 0) * 100)}%`;
  };

  /**
   * One Goliath's panel: its mode (and progress), its weapon systems (firing,
   * held on a lift, rebooting or offline), HP and, ours and anchored, its
   * training queue with cancel buttons. Rebuilt only when that structure
   * changes (HP and progress tick in place), so a tap on the queue isn't lost.
   * The enemy's, or any to a spectator: information only.
   */
  function goliathPanel(u: Unit): { key: string; html: string; live: Live } {
    const g = u.goliath!;
    const st = UNITS[u.kind];
    const own = u.faction === PLAYER && !api.ctrl.spectator;
    const states = GOLIATH_STRIP.map(({ k }) => weaponState(u, k));
    const mode = g.lift ? g.lift.phase : g.mode;
    const key = `g${u.id}:${mode}:${states.join(",")}:${g.queue.map((q) => q.kind).join(",")}:${u.rank}:${u.kills}:${own}`;
    const title = `${st.name}${u.rank ? ` <span class="rank">${stars(u.rank)}</span>` : ""}${u.kills ? ` · ${killsLabel(u.kills)}` : ""}`;
    const said = tr(
      { on: "en tir", held: "bloqué en vol", boot: "redémarrage", off: "hors service" },
      { on: "firing", held: "held in flight", boot: "rebooting", off: "out of action" }
    );
    const strip = GOLIATH_STRIP.map(
      ({ k, short }, i) => `<span class="gw ${states[i]}" title="${GOLIATH.weapons[k].name}: ${said[states[i]!]}">${short}</span>`
    ).join("");
    // ours, anchored: it trains squads, and under Nomads or Goliath Armada Harvesters too (a queue that
    // stopped when it packed up stays cancellable)
    const train = !own
      ? ""
      : g.queue.length > 0
        ? queueHtml(u.id, g.queue, u.faction)
        : g.mode === "anchored" && !g.lift
          ? `<span class="hint">${tr(flies(u) ? "Produit des aéronefs" : goliathBase(w) ? `Forme ${pluralName(nationKind(w, u.faction, "harvester"), nationOf(w, u.faction))} et escouades` : "Forme des escouades", flies(u) ? "Produces aircraft" : goliathBase(w) ? `Trains ${pluralName(nationKind(w, u.faction, "harvester"), nationOf(w, u.faction))} and squads` : "Trains squads")}${tr(" · touche la carte pour rallier", " · tap the map to rally")}</span>`
          : "";
    const live: Live = { hp: `${Math.ceil(u.hp)} / ${st.hp}`, head: headShare(g.queue), mode: goliathMode(u) };
    // (short landscape screens put the name and the HP line side by side: style.css)
    const html = `<img class="pi" src="${icon(u.kind, u.faction)}" alt=""/><div class="pt"><div class="ghead"><b>${title}</b>
      <span class="gline"><span class="hp">${live.hp}</span><span class="gmode">${live.mode}</span></span></div>
      <span class="gweap">${strip}</span>${train}</div>`;
    return { key, html, live };
  }

  function renderSelection(): void {
    const ctrl = api.ctrl;
    let html = "";
    let key = "";
    let live: Live | null = null;
    if (ctrl.selectedBuilding !== null) {
      const b = w.buildings.get(ctrl.selectedBuilding);
      if (b) {
        const st = BUILDINGS[b.kind];
        // rebuilt only when the queue itself changes: HP and progress tick in
        // place below, so a tap on a queue button (cancel) isn't lost to a rebuild
        key = `b${b.id}:${b.queue.map((x) => x.kind).join(",")}`;
        live = { hp: `${Math.ceil(b.hp)} / ${buildingMaxHp(w, b)}`, head: headShare(b.queue) };
        // producers say how to set a rally point here (it used to be a chip; the row needs the room);
        // an outpost (built in a Goliath's ring) that it doesn't count as base
        const rally = isProducer(b.kind);
        const note = b.unpowered
          ? tr("Hors du réseau électrique : production et tirs suspendus. Pose une Tour TSF près de lui.", "Outside the power grid: production and fire suspended. Build a Wireless Tower next to it.")
          : b.outpost
          ? tr("Avant-poste : n'étend pas la zone de construction", "Outpost: doesn't extend the build area")
          : rally && !ctrl.spectator ? tr("Touche la carte pour fixer un point de ralliement", "Tap the map to set a rally point") : st.role;
        html = `<img class="pi" src="${icon(b.kind, b.faction)}" alt=""/><div class="pt"><b>${displayName(b.kind, nationOf(w, b.faction))}${b.outpost ? ` <span class="outpost">· ${tr("Avant-poste", "Outpost")}</span>` : ""}</b>
          <span class="hp">${Math.ceil(b.hp)} / ${buildingMaxHp(w, b)}</span>
          ${b.queue.length ? queueHtml(b.id, b.queue, b.faction) : `<span class="hint">${note}</span>`}</div>`;
      }
    } else if (ctrl.selectedUnits.size > 0) {
      const counts = new Map<UnitKind, number>();
      /** Squads riding in the selected Condors, by kind. */
      const aboard = new Map<UnitKind, number>();
      /** Whose they are (a selection is one side's). */
      let side: Faction = PLAYER;
      for (const id of ctrl.selectedUnits) {
        const u = w.units.get(id);
        if (!u) continue;
        side = u.faction;
        counts.set(u.kind, (counts.get(u.kind) ?? 0) + 1);
        for (const p of u.passengers ?? []) aboard.set(p.kind, (aboard.get(p.kind) ?? 0) + 1);
      }
      key = `u:${side}:${[...counts].map(([k, n]) => k + n).join(",")}|${[...aboard].map(([k, n]) => k + n).join(",")}`;
      if (ctrl.selectedUnits.size === 1) {
        const u = w.units.get([...ctrl.selectedUnits][0]!);
        if (u?.goliath) ({ key, html, live } = goliathPanel(u));
        else if (u) {
          // a Condor on a lift shows the Goliath it carries
          const lifting = liftedBy(w, u);
          key += `:${Math.round(u.hp)}:${u.rank}:${u.kills}:${(u.passengers ?? []).map((p) => `${p.id}/${squadAlive(p)}`).join(",")}:${lifting?.goliath!.lift!.phase ?? ""}`;
          const st = UNITS[u.kind];
          // veterans earn a callsign: "★★ Viper · Lancer · 9 kills"
          const title =
            u.rank >= NAMED_RANK
              ? heroLine(w, u).replace(/^(★+)/, '<span class="rank">$1</span>')
              : `${st.name}${u.rank ? ` <span class="rank">${stars(u.rank)}</span>` : ""}${u.kills ? ` · ${killsLabel(u.kills)}` : ""}`;
          // a squad counts its robots still standing ("4/5 robots")
          const n = squadSize(u.kind);
          const robots = n > 1 ? `<span class="robots"> · ${squadAlive(u)}/${n} ${tr("automates", "automata")}</span>` : "";
          // a Condor shows who is aboard, seat by seat, instead of its role line (or the Goliath it lifts)
          const transport = isTransport(u.kind);
          const empty =
            mine("gantry") || [...w.units.values()].some((o) => o.goliath && o.faction === PLAYER)
              ? `<span class="hint">${tr("Vide : touche une escouade pour l'embarquer", "Empty: tap a squad to board it")}</span><span class="hint">${tr("Sélectionnes-en deux et touche un Gargantua pour le soulever", "Select two and tap a Gargantua to lift it")}</span>`
              : `<span class="hint">${tr("Vide : touche une escouade pour l'embarquer", "Empty: tap a squad to board it")}</span>`;
          const how = u.faction === PLAYER && !ctrl.spectator;
          const hint = lifting
            ? lifting.goliath!.lift!.phase === "hooking"
              ? `<span class="hint">${tr("Accroche d'un Gargantua", "Hooking on to a Gargantua")}</span>`
              : `<span class="hint">${tr("Transporte un Gargantua", "Carrying a Gargantua")}</span>${how ? `<span class="hint">${tr("Appui long sur la carte pour le déposer", "Long-press the map to drop it")}</span>` : ""}`
            : transport
              ? (u.passengers?.length ?? 0) > 0 || ctrl.spectator ? "" : empty
              : `<span class="hint">${st.role}</span>`;
          const hold = lifting
            ? `<div class="cargo"><span class="seat lift" title="Gargantua"><img src="${icon("goliath", u.faction)}" alt=""/></span></div>`
            : transport ? cargoHtml(u) : "";
          html = `<img class="pi" src="${icon(u.kind, u.faction)}" alt=""/><div class="pt"><b class="${u.rank >= NAMED_RANK ? "hero" : ""}">${title}</b>
            <span class="hp">${Math.ceil(u.hp)} / ${st.hp}${robots}</span>${hint}</div>${hold}`;
        }
      } else {
        html = `<div class="group">${[...counts]
          .map(([k, n]) => `<span class="gi" role="button" data-kind="${k}" title="${tr("Ne garder que ce type", "Keep only this type")}"><img src="${icon(k, side)}" alt=""/><b>${n}</b></span>`)
          .join("")}${[...aboard]
          .map(([k, n]) => `<span class="gi aboard" title="${tr("À bord d'une Montgolfière", "Aboard a Montgolfier Balloon")}"><img src="${icon(k, side)}" alt=""/><b>${n}</b></span>`)
          .join("")}</div>`;
      }
    }
    if (key !== lastSelKey) {
      lastSelKey = key;
      selEl.hidden = html === "";
      selEl.innerHTML = html;
      selHpEl = live ? selEl.querySelector<HTMLElement>(".hp") : null;
      selHeadEl = live ? selEl.querySelector<HTMLElement>(".qi .qp") : null;
      selModeEl = live?.mode !== undefined ? selEl.querySelector<HTMLElement>(".gmode") : null;
      // (each button names its producer: a building, or an anchored Goliath)
      selEl.querySelectorAll<HTMLButtonElement>(".qi").forEach((el) =>
        el.addEventListener("click", () => {
          if (ctrl.spectator) return;
          ctrl.enqueue({
            type: "cancelProduce", faction: PLAYER, buildingId: Number(el.dataset.p), unit: el.dataset.kind as UnitKind
          });
          sfx.play("sell", 0.5);
        })
      );
    }
    if (live) {
      if (selHpEl && selHpEl.textContent !== live.hp) selHpEl.textContent = live.hp;
      if (selHeadEl && selHeadEl.style.height !== live.head) selHeadEl.style.height = live.head;
      if (selModeEl && live.mode !== undefined && selModeEl.textContent !== live.mode) selModeEl.textContent = live.mode;
    }
  }
  shield(selEl);
  // a portrait in a group's selection: keep only that kind (aboard a Condor: not selectable, no data-kind)
  selEl.addEventListener("click", (e) => {
    const kind = (e.target as HTMLElement).closest<HTMLElement>(".gi[data-kind]")?.dataset.kind;
    if (!kind) return;
    const ids = [...api.ctrl.selectedUnits].filter((id) => w.units.get(id)?.kind === kind);
    if (ids.length === 0 || ids.length === api.ctrl.selectedUnits.size) return;
    sfx.play("click", 0.5);
    api.ctrl.selectUnits(ids);
  });

  // ------------------------------------------------------------- toasts ---
  function toast(msg: string, onTap?: () => void, cls = "", ms = 2200): void {
    const t = document.createElement("div");
    t.className = `toast ${cls}`;
    const tx = document.createElement("span");
    tx.className = "tx";
    tx.textContent = msg;
    t.appendChild(tx);
    if (onTap) t.addEventListener("click", onTap);
    // nothing to tap: let touches fall through to the battlefield underneath
    else t.classList.add("passive");
    toastsEl.appendChild(t);
    // the ticker keeps two lines at most: the newest pushes the oldest out (a
    // waiting reader's 💡 hint outlives a burst of alerts)
    while (toastsEl.children.length > 2) {
      const kids = [...toastsEl.children].filter((c) => c !== t);
      const old = kids.find((c) => c.classList.contains("out")) ?? kids.find((c) => !c.classList.contains("hint")) ?? kids[0];
      old?.remove();
    }
    setTimeout(() => t.classList.add("out"), ms);
    setTimeout(() => t.remove(), ms + 500);
  }

  // ------------------------------------------------------------ banners ---
  // Big centre-top callouts for announce(): one at a time, the more
  // important line pre-empts, others wait in a short queue.
  let bannerCur: Announcement | null = null;
  let bannerTimer = 0;
  const bannerQueue: Announcement[] = [];
  const prio = (a: Announcement) => a.priority ?? 2;
  function showBanner(a: Announcement): void {
    bannerCur = a;
    bannerEl.className = `banner ${a.tone ?? "info"}`;
    bannerEl.innerHTML = `<b></b>${a.sub ? "<span></span>" : ""}`;
    bannerEl.querySelector("b")!.textContent = a.text;
    if (a.sub) bannerEl.querySelector("span")!.textContent = a.sub;
    bannerEl.hidden = false;
    layout.refresh(true); // centre it under the band at its real width
    // restart the entrance animation
    void bannerEl.offsetWidth;
    bannerEl.classList.add("in");
    layout.refresh(true); // (landscape: the ticker steps under it)
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => {
      bannerEl.classList.remove("in");
      bannerEl.classList.add("out");
      bannerTimer = window.setTimeout(() => {
        bannerEl.hidden = true;
        bannerCur = null;
        const next = bannerQueue.shift();
        if (next) showBanner(next);
        else layout.refresh(true);
      }, 260);
    }, prio(a) <= 1 ? 3000 : 2200);
  }
  bannerEl.addEventListener("click", () => {
    if (bannerCur?.x !== undefined && bannerCur.y !== undefined) api.centerCamera(bannerCur.x, bannerCur.y);
  });
  const offAnnounce = onAnnounce((a) => {
    if (bannerCur?.key === a.key || bannerQueue.some((q) => q.key === a.key)) return; // no stutter
    if (!bannerCur) return showBanner(a);
    if (prio(a) < prio(bannerCur)) return showBanner(a);
    bannerQueue.push(a);
    bannerQueue.sort((p, q) => prio(p) - prio(q));
    if (bannerQueue.length > 3) bannerQueue.pop();
  });

  // ---------------------------------------------------- first-run hints ---
  const TUTORIAL_KEY = "battledrones.tutorial";
  let hintStage = 99;
  try {
    hintStage = localStorage.getItem(TUTORIAL_KEY) === "done" ? 99 : 0;
  } catch {
    /* storage blocked: skip the hints */
  }
  if (api.ctrl.spectator || w.ops) hintStage = 99; // ops brief the player themselves
  // every one-time hint is paced through one queue (src/game/hints.ts)
  const hints = new HintQueue();
  const mine = (k: string) => [...w.buildings.values()].some((b) => b.faction === PLAYER && b.kind === k);
  const hasFactory = () => mine("fab-plant") || mine("airpad");
  const armySize = () => [...w.units.values()].filter(isArmyUnit).length;
  /** The player's workers by name: Fardiers, or the République's Fourgons. */
  const workers = () => pluralName(nationKind(w, PLAYER, "harvester"), nationOf(w, PLAYER));
  /** Move the tutorial on to stage `next`; at 99 it's done for good. */
  function advance(next: number): void {
    hintStage = next;
    if (next < 99) return;
    try {
      localStorage.setItem(TUTORIAL_KEY, "done");
    } catch {
      /* ignore */
    }
  }
  /** The tutorial's next stage, offered to the queue once its moment comes; the stage moves on when it is shown. */
  function tutorial(): void {
    if (hintStage >= 99 || hints.has(`tut-${hintStage}`)) return;
    const stage = hintStage;
    const secs = api.matchSeconds();
    let msg: string | null = null;
    let next = stage;
    let still = () => true;
    if (stage === 0 && secs > 4) {
      // quick-start openers hand out a factory (and maybe an army) up front
      const factory = hasFactory();
      const army = armySize() > 0;
      still = () => hasFactory() === factory && armySize() > 0 === army;
      if (factory) {
        msg = army
          ? tr(`Tes ${workers()} minent seuls. Touche une unité (ou ⚔ Toute l'armée), puis la carte pour l'y envoyer.`, `Your ${workers()} are mining by themselves. Tap a unit (or ⚔ All army), then the map to send it there.`)
          : tr(`Tes ${workers()} minent seuls. Produis des chars dans Véhicules, puis touche une unité et la carte pour l'y envoyer.`, `Your ${workers()} are mining by themselves. Produce tanks in Vehicles, then tap a unit and the map to send it there.`);
        next = 2;
      } else {
        msg = BELLE_EPOQUE
          ? tr("Ton Fardier extrait le charbon seul. Touche 🔨 Construire, puis Forges pour bâtir des forges.", "Your Steam Wagon mines coal by itself. Tap 🔨 Build, then Forges to build forges.")
          : tr("Ton Fardier extrait le charbon seul. Ouvre Base et touche Forges pour bâtir des forges.", "Your Steam Wagon mines coal by itself. Open Base and tap Forges to build forges.");
        next = 1;
      }
    } else if (stage === 1 && mine("fab-plant")) {
      msg = tr("Produis des chars dans Véhicules. Touche une unité, puis la carte pour l'y envoyer.", "Produce tanks in Vehicles. Tap a unit, then the map to send it there.");
      next = 2;
    } else if (stage === 2 && armySize() >= 3 && secs > 30) {
      msg = tr("Appui long sur un bouton de production pour voir ce qu'il contre, ou le produire en boucle ↻. ⚔ Toute l'armée sélectionne tout le monde.", "Long-press a production button to see what it counters, or produce it in a loop ↻. ⚔ All army selects everyone.");
      next = 3;
    } else if (stage === 3 && secs > 150) {
      // (one already stands: nothing left to teach)
      if (mine("tech-lab")) return advance(99);
      msg = tr("Bâtis Polytechnique pour débloquer Creusot, Hydroglisseurs, Canons de 75, Albatros et Chasseurs alpins.", "Build Polytechnique to unlock Creusot, Hydrogliders, French 75s, Albatros and Alpine Chasseurs.");
      still = () => !mine("tech-lab");
      next = 99;
    }
    if (!msg) return;
    hints.offer({
      id: `tut-${stage}`,
      msg,
      priority: HINTS.priority.tutorial,
      ttlS: 600,
      valid: () => hintStage === stage && still(),
      onShow: () => advance(next)
    });
  }

  const pings: { x: number; y: number; t: number; kind?: "hit" | "inbound" }[] = [];
  let lastReady: BuildingKind | null = null;
  /** The anchored Goliaths selected last frame (ids), to open the Infantry tab when one turns up. */
  let lastTrainers = "";

  // --------------------------------------------------------- top buttons ---
  const muteBtn = $<HTMLButtonElement>("#btn-mute");
  const syncMute = () => (muteBtn.textContent = sfx.muted ? "🔇" : "🔊");
  syncMute();
  // one-tap master mute; the per-bus switches live in the pause menu
  const offMute = sfx.onChange(syncMute);
  let offToggles: (() => void) | null = null;
  muteBtn.addEventListener("click", () => sfx.setMuted(!sfx.muted));
  $("#btn-menu").addEventListener("click", () => togglePause());

  for (const [id, factor] of [
    ["zoom-in", 1.45],
    ["zoom-out", 1 / 1.45]
  ] as const)
    $(`#${id}`).addEventListener("click", () => api.zoomBy(factor));

  if (api.ctrl.spectator) {
    root.classList.add("spectator");
    const versus = $("#versus");
    versus.hidden = false;
    versus.innerHTML = `<span class="vs-blue"></span><span class="vs-red"></span>`;
    versus.querySelector(".vs-blue")!.textContent = api.strategies?.blue ?? tr("Bleu", "Blue");
    versus.querySelector(".vs-red")!.textContent = api.strategies?.red ?? tr("Rouge", "Red");
    versus.title = `${api.strategies?.blue} vs ${api.strategies?.red}`;
  }

  /** The match is over: the end screen is up (or a duel ended with no result). Nothing pauses any more. */
  let over = false;

  // the screen stays on; the app going to the background pauses the match (not a duel: the friend plays on)
  const offFocus = watchMatchFocus(() => {
    if (!api.duel && !api.ctrl.paused) togglePause();
  });

  function togglePause(): void {
    if (over || !endEl.hidden || w.winner) return; // over (the finale is playing): nothing to pause
    api.ctrl.paused = !api.ctrl.paused;
    pauseEl.hidden = !api.ctrl.paused;
    offToggles?.();
    offToggles = null;
    duelShown = null;
    if (!api.ctrl.paused) return;
    const duel = api.duel;
    const line = duel
      ? `vs ${duel.opponent} · ${duel.online ? "🌐" : "🔊"} ${duel.delayMs()} ms`
      : ops ? ops.pauseLine() : surv ? surv.pauseLine() : api.strategies ? tr("IA contre IA", "AI against AI") : `${tr("vs IA", "vs AI")} ${api.enemy.strategy} · ${DIFFICULTY[api.enemy.difficulty as Difficulty]?.label ?? api.enemy.difficulty}`;
    pauseEl.innerHTML = `
      <div class="panel">
        <h1>${tr("PAUSE", "PAUSED")}</h1>
        <p class="time">${line}</p>
        ${ops ? ops.pauseHtml() : ""}
        ${pauseRulesHtml(w)}
        <button class="cta" id="p-resume">▶ ${tr("Reprendre", "Resume")}</button>
        <div id="p-sound"></div>
        ${BELLE_EPOQUE ? `<div id="p-hud"></div>` : ""}
        <button class="cta alt" id="p-help">${tr("Comment jouer", "How to play")}</button>
        ${uncharted || duel || !DEBUG ? "" : `<button class="cta alt" id="p-fog">${api.ctrl.showFog ? tr("Révéler la carte (debug)", "Reveal the map (debug)") : tr("Rétablir le brouillard", "Restore the fog")}</button>`}
        ${duel ? `<div id="p-duel" class="p-duel"></div>` : `<button class="cta alt" id="p-quit">${tr("Quitter vers le menu", "Quit to menu")}</button>`}
        <div id="p-helptext" class="help" hidden>${HELP_HTML}</div>
      </div>`;
    shield(pauseEl);
    const offSound = mountAudioToggles(pauseEl.querySelector<HTMLElement>("#p-sound")!);
    // Panache: the interface toggles (zoom buttons, left-handed) beside the sound ones
    const hudBox = pauseEl.querySelector<HTMLElement>("#p-hud");
    const offHud = hudBox ? mountHudSettings(hudBox) : null;
    offToggles = () => {
      offSound();
      offHud?.();
    };
    belle?.closeAll();
    pauseEl.querySelector("#p-resume")!.addEventListener("click", togglePause);
    pauseEl.querySelector("#p-help")!.addEventListener("click", () => {
      const h = pauseEl.querySelector<HTMLElement>("#p-helptext")!;
      h.hidden = !h.hidden;
    });
    pauseEl.querySelector("#p-fog")?.addEventListener("click", () => {
      api.ctrl.showFog = !api.ctrl.showFog;
      togglePause();
    });
    pauseEl.querySelector("#p-quit")?.addEventListener("click", () => {
      abandonMatch(); // (left on purpose: the menu won't offer to pick it up)
      fullscreen.reload();
    });
    if (duel) renderDuelExits(duel, null);
  }

  /** The duel buttons as last rendered (null: the pause menu is closed), so update() redraws them only when they change. */
  let duelShown: { ask: DuelAsk | null; key: string } | null = null;
  const exitsKey = (duel: DuelHud) => {
    const ex = duel.exits();
    return `${ex.resignAndLeave}|${ex.leave}|${duel.resigning()}`;
  };
  /**
   * A duel's ways out, in place of "Quit to menu": Resign, "Resign and leave"
   * while the friend's packets arrive, "Leave (no result)" once the link is
   * lost; each asks first (`ask`: the one being confirmed).
   */
  function renderDuelExits(duel: DuelHud, ask: DuelAsk | null): void {
    const box = pauseEl.querySelector<HTMLElement>("#p-duel");
    if (!box) return;
    const ex = duel.exits();
    const resigning = duel.resigning();
    duelShown = { ask, key: exitsKey(duel) };
    if (ask) {
      const q =
        ask === "leave"
          ? tr(`Partir sans résultat ? La partie s'arrête aussi pour ${duel.opponent}.`, `Leave with no result? The match stops for ${duel.opponent} too.`)
          : tr(`Abandonner${ask === "resign-leave" ? " et partir" : ""} ? Victoire pour ${duel.opponent}.`, `${ask === "resign-leave" ? "Resign and leave" : "Resign"}? Victory for ${duel.opponent}.`);
      box.innerHTML = `<p class="p-ask">${q}</p>
        <button class="cta alt warn" id="p-yes">${ask === "leave" ? tr("Partir", "Leave") : ask === "resign" ? tr("🏳 Abandonner", "🏳 Resign") : tr("Abandonner et partir", "Resign and leave")}</button>
        <button class="cta alt" id="p-no">${tr("Annuler", "Cancel")}</button>`;
      box.querySelector("#p-no")!.addEventListener("click", () => renderDuelExits(duel, null));
      box.querySelector("#p-yes")!.addEventListener("click", () => {
        // (the pause menu closes and the game runs on: the resign lands D ticks later, both phones step it)
        if (api.ctrl.paused) togglePause();
        if (ask === "leave") duel.leave();
        else duel.resign(ask === "resign-leave");
      });
      return;
    }
    box.innerHTML = `${resigning ? "" : `<button class="cta alt" id="p-resign">${tr("🏳 Abandonner", "🏳 Resign")}</button>`}
      ${ex.resignAndLeave && !resigning ? `<button class="cta alt" id="p-resign-leave">${tr("Abandonner et partir", "Resign and leave")}</button>` : ""}
      ${ex.leave ? `<button class="cta alt warn" id="p-leave">${tr("Partir (sans résultat)", "Leave (no result)")}</button>` : ""}`;
    box.querySelector("#p-resign")?.addEventListener("click", () => renderDuelExits(duel, "resign"));
    box.querySelector("#p-resign-leave")?.addEventListener("click", () => renderDuelExits(duel, "resign-leave"));
    box.querySelector("#p-leave")?.addEventListener("click", () => renderDuelExits(duel, "leave"));
  }

  // ------------------------------------------------------------- minimap ---
  const miniMove = (e: PointerEvent) => {
    const r = minimap.getBoundingClientRect();
    api.centerCamera(((e.clientX - r.left) / r.width) * w.width, ((e.clientY - r.top) / r.height) * w.height);
  };
  let miniDown = false;
  minimap.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    miniDown = true;
    minimap.setPointerCapture(e.pointerId);
    miniMove(e);
  });
  minimap.addEventListener("pointermove", (e) => miniDown && miniMove(e));
  minimap.addEventListener("pointerup", () => (miniDown = false));

  let lastMinimapAt = 0;
  let lastScrap = -1;
  let lastClock = "";
  const incomeWindow: { t: number; v: number }[] = [];

  let lastFrame = performance.now();
  function update(dtMs?: number): void {
    const nowMs = performance.now();
    const dt = dtMs ?? Math.min(250, nowMs - lastFrame);
    lastFrame = nowMs;
    layout.refresh();
    // one-time hints: one at a time, never over a banner or the opener cards, paused time doesn't count
    const busy = api.busy?.() ?? false;
    const quiet = busy || api.ctrl.paused || !!w.winner || bannerCur !== null || bannerQueue.length > 0;
    const shown = hints.update(busy || api.ctrl.paused ? 0 : dt / 1000, quiet);
    if (shown) {
      const { x, y } = shown;
      toast(`💡 ${shown.msg}`, x !== undefined && y !== undefined ? () => api.centerCamera(x, y) : undefined, "hint", shown.ms ?? HINTS.showMs);
    }
    // (a duel's pause menu: Leave appears once the link is lost, "Resign and leave" while packets arrive)
    if (api.duel && api.ctrl.paused && duelShown && !duelShown.ask && duelShown.key !== exitsKey(api.duel)) renderDuelExits(api.duel, null);
    const fs = f();
    // (a sound duel: orders still on their way count as applied, controller.ts BuildView)
    const view = api.ctrl.view();
    const scrap = Math.floor(view.scrap);
    if (scrap !== lastScrap) {
      lastScrap = scrap;
      scrapEl.textContent = String(scrap);
    }
    const secs = api.matchSeconds();
    const clock = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
    if (clock !== lastClock) {
      lastClock = clock;
      clockEl.textContent = clock;
      // income over the last 60 s of harvesting and salvage
      const os = w.objectives.stats[PLAYER];
      const earned = fs.stats.scrapHarvested + fs.stats.scrapSalvaged + os.uplinkScrap + os.crateScrap;
      incomeWindow.push({ t: secs, v: earned });
      while (incomeWindow.length > 1 && secs - incomeWindow[0]!.t > 60) incomeWindow.shift();
      const first = incomeWindow[0]!;
      const span = Math.max(10, secs - first.t);
      const rate = ((earned - first.v) / span) * 60;
      rateEl.textContent = secs > 10 ? `+${Math.round(rate)}/m` : "";
    }
    surv?.update();
    ops?.update();

    const ctrl = api.ctrl;
    tutorial();
    // chips
    const chips: Chip[] = [];
    // phones narrower than this get short chip labels so the squad chips fit on one row
    const narrow = window.innerWidth < 400;
    const armed = api.targetChip?.();
    if (armed) {
      // a calldown is armed: tap the map to fire it (src/ui/powers.ts)
      chips.push({ id: "target", label: armed.label, cls: "info", on: () => {} });
      chips.push({ id: "untarget", label: "✕", cls: "warn", on: () => armed.cancel() });
    } else if (ctrl.placing) {
      // the ghost's spot: build it here, or why not (src/game/placement-view.ts)
      const why = ctrl.placementProblem();
      chips.push({
        id: "place", label: why ? `⚠ ${why}` : tr(`✓ Placer ${displayName(ctrl.placing, nation)}`, `✓ Place ${displayName(ctrl.placing, nation)}`),
        cls: why ? "place bad" : "place go", on: () => ctrl.commitPlacement()
      });
      chips.push({ id: "cancel", label: "✕", cls: "warn", on: () => (ctrl.placing = null) });
    } else if (ctrl.selectedUnits.size > 0 && !ctrl.spectator) {
      // loaded Condors: drop the squads where they are (a long-press on the map drops them there);
      // a lift in the air: set its Goliath down where it hovers
      const aboard = ctrl.aboardSelected();
      const lifts = ctrl.liftsSelected();
      const setDown = lifts.some((g) => g.goliath!.lift!.phase === "carrying");
      const anchor = goliathChip(ctrl.goliathsSelected(), narrow);
      const unload = aboard > 0 || setDown;
      chips.push({ id: "stop", label: narrow && (unload || anchor) ? "■" : "■ Stop", on: () => ctrl.stopSelected() });
      if (unload)
        chips.push({ id: "unload", label: aboard > 0 ? tr(`⇣ Larguer ${aboard}`, `⇣ Drop ${aboard}`) : tr("⇣ Déposer", "⇣ Set down"), cls: "unload", on: () => ctrl.unloadSelected() });
      if (anchor) chips.push(anchor);
      // (unarmed Condors, lifts and anchored Goliaths have no fights to skip: Move only would
      // change nothing; on a phone the Unload or anchor chip takes its place in a mixed
      // selection, so the row stays one row. A sound duel: as the orders on their way leave them)
      const lifting = ctrl.liftMembers();
      const ahead = ctrl.ahead();
      const marchers = [...ctrl.selectedUnits].some((id) => {
        const u = w.units.get(id);
        return !!u && !isTransport(u.kind) && !lifting.has(id) && !isRooted(ahead.unit(u));
      });
      if (marchers && (!narrow || (!unload && !anchor) || ctrl.forceMove))
        chips.push({
          id: "move", label: tr("⚑ Repli", "⚑ Fall back"), active: ctrl.forceMove,
          on: () => (ctrl.forceMove = !ctrl.forceMove)
        });
      chips.push({ id: "clear", label: "✕", on: () => ctrl.clearSelection() });
    } else if (ctrl.selectedBuilding !== null && !ctrl.spectator) {
      const b = w.buildings.get(ctrl.selectedBuilding);
      if (b && b.kind !== "hq") {
        const refund = Math.floor(buildingCostFor(w, b.faction, b.kind) * ECONOMY.sellRefund * (b.hp / buildingMaxHp(w, b)));
        chips.push({ id: "sell", label: tr(`$ Vendre +${refund}`, `$ Sell +${refund}`), cls: "warn", on: () => ctrl.sellSelected() });
      }
      chips.push({ id: "clear", label: "✕", on: () => ctrl.clearSelection() });
    } else if (!ctrl.spectator) {
      // (anchored Goliaths stay put: they're neither the army ⚔ grabs nor idle)
      const army = ctrl.armyIds().length;
      // units with no orders, when that's not simply everyone
      const idle = army > 0 ? ctrl.idleArmy() : [];
      const showIdle = idle.length > 0 && idle.length < army;
      // Last Stand: bring the next wave in early
      const call = surv?.chip();
      if (army)
        chips.push({ id: "army", label: narrow && (showIdle || call) ? tr("⚔ Armée", "⚔ Army") : tr("⚔ Toute l'armée", "⚔ All army"), on: () => ctrl.selectArmy() });
      if (showIdle)
        chips.push({ id: "idle", label: tr(`💤 Inactifs ${idle.length}`, `💤 Idle ${idle.length}`), cls: "idle", on: () => ctrl.selectUnits(ctrl.idleArmy()) });
      if (call) chips.push(call);
    }
    renderChips(chips);
    renderSelection();
    // an anchored Goliath selected (or one selected finishing digging in): the
    // squads it trains are on the Infantry tab
    const trainers = ctrl.spectator ? "" : ctrl.goliathsSelected().filter((g) => g.goliath!.mode === "anchored").map((g) => g.id).join(",");
    if (trainers !== lastTrainers) {
      if (trainers && !lastTrainers && tab !== "infantry") {
        tab = "infantry";
        renderGrid();
      }
      lastTrainers = trainers;
    }

    // building buttons
    const p = view.pending;
    if (p?.ready && lastReady !== p.kind && !ctrl.spectator) {
      lastReady = p.kind;
      sfx.play("ready");
      // (the Instruction's bubble says it already: one instruction at a time)
      if (!tutorialMatch)
        toast(tr(`${displayName(p.kind, nation)} ${agree(p.kind, "prêt", nation)} : touche ici pour placer`, `${displayName(p.kind, nation)} ready: tap here to place`), () => {
          // (not once it has been placed: in a sound duel the placement may still be on its way)
          if (ctrl.view().pending?.ready) ctrl.placing = p.kind;
        }, "good");
      if (tab !== "build") {
        tab = "build";
        renderGrid();
      }
    }
    if (!p) lastReady = null;
    for (const kind of BUILDABLE) {
      const el = buttons.get(`b:${kind}`)!;
      const { prog, lock } = parts.get(`b:${kind}`)!;
      const pendingThis = p?.kind === kind;
      const blocked = buildingBlocker(w, PLAYER, kind);
      el.classList.toggle("locked", !!blocked);
      el.classList.toggle("poor", !pendingThis && view.scrap < BUILDINGS[kind].cost);
      el.classList.toggle("busy", !!p && !pendingThis);
      el.classList.toggle("ready", !!(pendingThis && p.ready));
      el.classList.toggle("placing", ctrl.placing === kind);
      lock.hidden = !blocked;
      markBanned(lock, w, kind); // mutators: ⛔ instead of 🔒
      if (pendingThis && !p.ready) {
        prog.hidden = false;
        const total = BUILDINGS[kind].buildTime * TICK_RATE;
        prog.style.height = `${(1 - p.remaining / total) * 100}%`;
      } else prog.hidden = true;
    }
    // unit buttons
    const tabQ: Record<Tab, number> = { build: 0, ground: 0, infantry: 0, air: 0 };
    for (const kind of ALL_UNITS) {
      const el = buttons.get(`u:${kind}`)!;
      const pt = parts.get(`u:${kind}`)!;
      const { prog, lock, badge } = pt;
      // (Goliaths' training queues count with the Assembly Bays', paused ones too)
      let queued = 0;
      let headProg = -1;
      for (const p of queuesOf(w, PLAYER, kind)) {
        p.queue.forEach((q, i) => {
          if (q.kind !== kind) return;
          queued++;
          if (i === 0) headProg = Math.max(headProg, 1 - q.remaining / (UNITS[kind].buildTime * TICK_RATE));
        });
        queued += view.extra(p.id, kind);
      }
      queued = Math.max(0, queued);
      tabQ[tabOf(kind)] += queued;
      const blocked = unitBlocker(w, PLAYER, kind);
      // the live price (a Goliath's climbs with each one you have)
      const cost = unitCost(w, PLAYER, kind);
      if (pt.price !== cost) pt.cost.textContent = String((pt.price = cost));
      el.classList.toggle("locked", !!blocked);
      el.classList.toggle("poor", view.scrap < cost);
      lock.hidden = !blocked;
      markBanned(lock, w, kind); // mutators: ⛔ instead of 🔒
      badge.hidden = queued === 0;
      if (badge.textContent !== String(queued)) badge.textContent = String(queued);
      prog.hidden = headProg < 0;
      if (headProg >= 0) prog.style.height = `${headProg * 100}%`;
    }
    belle?.update({ queued: tabQ.build + tabQ.ground + tabQ.infantry + tabQ.air + (p && !p.ready ? 1 : 0), ready: !!p?.ready && !ctrl.spectator });
    for (const el of tabsEl.children) {
      const t = (el as HTMLElement).dataset.tab as Tab;
      const n = t === "build" ? (p ? 1 : 0) : tabQ[t];
      const badge = el.querySelector<HTMLElement>(".tbadge")!;
      badge.hidden = n === 0 || t === tab;
      badge.textContent = t === "build" ? (p?.ready ? "!" : "•") : String(n);
      badge.classList.toggle("hot", t === "build" && !!p?.ready);
    }

    const now = performance.now();
    if (now - lastMinimapAt > 250) {
      lastMinimapAt = now;
      drawMinimap();
    }
  }

  function drawMinimap(): void {
    const S = MINIMAP_PX;
    const k = S / w.width;
    const fogOn = api.ctrl.showFog;
    const vis = w.fog[PLAYER].vis;
    mctx.clearRect(0, 0, S, S);
    if (thumb.complete && thumb.naturalWidth > 0) mctx.drawImage(thumb, 0, 0, S, S);
    else {
      mctx.fillStyle = "#26301f";
      mctx.fillRect(0, 0, S, S);
    }
    if (fogOn) {
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++) {
          const v = vis[ty * w.width + tx];
          if (v === Vis.Visible || (uncharted && v === Vis.Unexplored)) continue;
          mctx.fillStyle = v === Vis.Unexplored ? "rgba(5,7,12,0.96)" : "rgba(5,7,12,0.5)";
          mctx.fillRect(tx * k, ty * k, k + 0.5, k + 0.5);
        }
      if (uncharted) {
        mctx.fillStyle = MINIMAP_SHROUD;
        const r = shroudRects(vis, w.width, w.height, S);
        for (let i = 0; i < r.length; i += 4) mctx.fillRect(r[i]!, r[i + 1]!, r[i + 2]!, r[i + 3]!);
      }
    }
    // resource fields that still hold anything
    mctx.fillStyle = "rgba(255,214,110,0.55)";
    for (let i = 0; i < w.terrain.length; i++) {
      if (w.scrap[i]! <= 0) continue;
      const tx = i % w.width;
      const ty = (i - tx) / w.width;
      if (fogOn && vis[i] === Vis.Unexplored) continue;
      mctx.fillRect(tx * k + k * 0.25, ty * k + k * 0.25, k * 0.5, k * 0.5);
    }
    // wrecks worth salvaging (fog-respecting: the renderer only lists ones we've seen)
    mctx.fillStyle = "#ffd66e";
    for (const r of api.wrecks?.() ?? []) mctx.fillRect(r.x * k - 2, r.y * k - 2, 4, 4);
    const enemyBuildings = fogOn
      ? [...w.fog[PLAYER].known.values()]
      : [...w.buildings.values()].filter((b) => b.faction !== PLAYER);
    for (const kb of enemyBuildings) {
      const size = BUILDINGS[kb.kind].size;
      mctx.fillStyle = MINIMAP_SIDE[kb.faction].building;
      mctx.fillRect(kb.tx * k, kb.ty * k, size * k, size * k);
    }
    for (const b of w.buildings.values()) {
      if (b.faction !== PLAYER) continue;
      const size = BUILDINGS[b.kind].size;
      mctx.fillStyle = MINIMAP_SIDE[b.faction].building;
      mctx.fillRect(b.tx * k, b.ty * k, size * k, size * k);
    }
    const goliaths: Unit[] = [];
    for (const u of w.units.values()) {
      // (in sight, and not a Sniper Team hidden in the woods; an enemy Goliath can't hide)
      if (u.faction !== PLAYER && fogOn && !unitSeenBy(w, PLAYER, u)) continue;
      mctx.fillStyle = minimapDot(u.faction, api.ctrl.spectator ? null : PLAYER);
      if (u.goliath) goliaths.push(u);
      else mctx.fillRect(u.x * k - 2, u.y * k - 2, 4, 4);
    }
    // Goliaths on top: a big outlined diamond (anchored ones ringed with their build ring)
    for (const u of goliaths) {
      const side = MINIMAP_SIDE[u.faction];
      const x = u.x * k;
      const y = u.y * k;
      if (isRooted(u)) {
        mctx.strokeStyle = side.ring;
        mctx.lineWidth = 1;
        mctx.beginPath();
        mctx.arc(x, y, Math.max(7, (GOLIATH.buildRing + GOLIATH.footprint / 2) * k), 0, Math.PI * 2);
        mctx.stroke();
      }
      // (the minimap shows at under half its canvas size on a phone: a unit blip is ~2 px there, this ~8)
      const r = 9;
      mctx.beginPath();
      mctx.moveTo(x, y - r);
      mctx.lineTo(x + r, y);
      mctx.lineTo(x, y + r);
      mctx.lineTo(x - r, y);
      mctx.closePath();
      mctx.fillStyle = side.goliath;
      mctx.fill();
      mctx.strokeStyle = side.goliathRim;
      mctx.lineWidth = 2.5;
      mctx.stroke();
    }
    api.minimapOverlay?.(mctx, k); // Uplinks and supply crates (render/objectives.ts)
    // calldown reticles in flight (public: shown through the fog)
    for (const c of api.calldowns?.() ?? []) {
      mctx.strokeStyle = c.enemy ? "#ff3b30" : "#ffd23f";
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.arc(c.x * k, c.y * k, Math.max(4, c.r * k), 0, Math.PI * 2);
      mctx.stroke();
    }
    // alert pings
    const now = api.matchSeconds();
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i]!;
      const age = now - p.t;
      if (age > 3) {
        pings.splice(i, 1);
        continue;
      }
      if (p.kind === "inbound") {
        // a raid on its way: two amber rings, bigger and slower
        for (const off of [0, 0.6]) {
          const a = Math.max(0, age - off);
          mctx.strokeStyle = `rgba(255,190,70,${Math.max(0, 1 - a / 3)})`;
          mctx.lineWidth = 3;
          mctx.beginPath();
          mctx.arc(p.x * k, p.y * k, 6 + a * 14, 0, Math.PI * 2);
          mctx.stroke();
        }
        continue;
      }
      mctx.strokeStyle = `rgba(255,80,60,${1 - age / 3})`;
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.arc(p.x * k, p.y * k, 4 + age * 8, 0, Math.PI * 2);
      mctx.stroke();
    }
    surv?.drawMinimap(mctx, k, performance.now());
    const quad = api.viewQuad();
    mctx.strokeStyle = "rgba(255,255,255,0.85)";
    mctx.lineWidth = 1.5;
    mctx.beginPath();
    quad.forEach((p, i) => (i === 0 ? mctx.moveTo(p.x * k, p.y * k) : mctx.lineTo(p.x * k, p.y * k)));
    mctx.closePath();
    mctx.stroke();
  }

  function showEnd(winner: Faction | "draw" | null, opts?: EndOpts): void {
    over = true;
    // (a duel can end while its pause menu is up: the friend left, or the worlds drifted apart)
    if (api.ctrl.paused) {
      api.ctrl.paused = false;
      pauseEl.hidden = true;
      offToggles?.();
      offToggles = null;
      duelShown = null;
    }
    const rematch = () => relaunch(rematchToken());
    const duel = api.duel;
    // (Last Stand only ends one way; a draw anywhere goes to the report, titled DRAW)
    if (surv && !ops && winner !== "draw" && winner !== null) {
      surv.showEnd(endEl, winner, Math.round(api.matchSeconds()), rematch, () => fullscreen.reload());
      if (uncharted) endEl.querySelector(".panel > .time")?.insertAdjacentHTML("afterend", revealHtml(w.mapId));
      shield(endEl);
      return;
    }
    // Uncharted: the map it was played blind on, revealed under the career block (this report only)
    const offReveal = uncharted ? addReportSection({ id: "reveal", order: 6, col: "left", render: () => revealHtml(w.mapId) }) : null;
    // the after-action report (src/ui/report.ts)
    try {
      showReport(endEl, {
        world: w,
        winner,
        pov: PLAYER,
        spectator: api.ctrl.spectator,
        secs: Math.round(api.matchSeconds()),
        strategies: api.strategies,
        enemy: api.enemy,
        onRematch: rematch,
        onMenu: () => fullscreen.reload(),
        ...(ops?.reportOpts() ?? {}),
        // a sound duel: You and Friend, its own buttons (each leaves the duel before it reloads)
        ...(duel
          ? {
              opponent: duel.opponent,
              via: duel.practice ? tr("lien d'entraînement (sans son)", "practice link (no sound)") : duel.online ? tr("en ligne", "online") : tr("par le son", "by sound"),
              onRematch: () => duel.rematch(),
              onMenu: () => duel.menu(),
              after: [...duel.actions(), ...(opts?.actions ?? [])]
            }
          : {}),
        ...(opts?.head ? { head: opts.head } : {})
      });
    } finally {
      offReveal?.();
    }
    shield(endEl);
  }

  // Panache: the same widgets regrouped for phones (src/ui/belle-hud.ts); ?style=original keeps this layout
  const belle: BelleHud | null = BELLE_EPOQUE
    ? mountBelleHud({ root, ctrl: api.ctrl, spectator: api.ctrl.spectator, nation, togglePause, tip: (msg) => toast(`💡 ${msg}`, undefined, "hint", 3000) })
    : null;

  return {
    update,
    showEnd,
    alert(msg, x, y) {
      toast(`⚠ ${msg}`, () => api.centerCamera(x, y), "bad");
    },
    radio(msg, tone, x, y) {
      const jump = x !== undefined && y !== undefined ? () => api.centerCamera(x, y) : undefined;
      toast(`${msg}${jump ? " ›" : ""}`, jump, `radio ${tone}`, 2400);
    },
    ping(x, y, kind) {
      if (pings.length < 12 || kind === "inbound") pings.push({ x, y, t: api.matchSeconds(), kind });
    },
    hint(msg, ms = 7000, x, y) {
      toast(`💡 ${msg}`, x !== undefined && y !== undefined ? () => api.centerCamera(x, y) : undefined, "hint", ms);
    },
    offerHint(h) {
      // (the Instruction's lesson is the only tip on screen: the one-time hints keep for later matches)
      if (!api.ctrl.spectator && !tutorialMatch) hints.offer(h);
    },
    bannerUp(prefix) {
      return !!bannerCur?.key.startsWith(prefix) || bannerQueue.some((a) => a.key.startsWith(prefix));
    },
    notice(msg, tone, x, y) {
      toast(msg, () => api.centerCamera(x, y), tone === "info" ? "" : tone, 3600);
    },
    notify(msg, tone) {
      toast(msg, undefined, tone ?? "", tone === "bad" ? 2200 : 4200);
    },
    togglePause,
    destroy() {
      offFocus();
      offAnnounce();
      offMute();
      belle?.destroy();
      layout.destroy();
      offToggles?.();
      window.clearTimeout(bannerTimer);
      root.innerHTML = "";
    }
  };
}

/** A Condor's seats for the selection panel: a portrait (and robots standing) per squad aboard, dashed empty seats. */
function cargoHtml(c: Unit): string {
  const seats = (c.passengers ?? []).map(
    (p) => `<span class="seat" title="${UNITS[p.kind].name}"><img src="${icon(p.kind, c.faction)}" alt=""/><b>${squadAlive(p)}</b></span>`
  );
  for (let i = seats.length; i < (UNITS[c.kind].capacity ?? 0); i++) seats.push(`<span class="seat empty"></span>`);
  return `<div class="cargo">${seats.join("")}</div>`;
}

export const HELP_HTML = tr(
`
  <h3>But</h3><p>Détruis le GQG ennemi et tous ses Gargantuas. Protège les tiens : tant qu'un Gargantua tient debout, tu n'es pas battu, même sans GQG.</p>
  <h3>Ouvertures</h3><p>Chaque escarmouche commence par un choix : <b>Blitz</b> (Forges + 3 Panhard), <b>Industrie</b> (Forges, un troisième Fardier, +200 charbon) ou <b>Escadrille</b> (Chalais-Meudon + 3 Éole). L'ennemi choisit aussi.</p>
  <h3>Pouvoirs du commandant</h3><p>La jauge ⚡ à droite se remplit lentement, et plus vite quand tu perds des unités. Dépense-la en <b>Feu roulant</b> (3 salves), <b>Fée Électricité</b> (gèle les ennemis 4 s) ou <b>Obus-capsule</b> (3 unités atterrissent là où tu vois) : touche le bouton, puis la carte. À 6:00, l'<b>Obus Méliès</b> s'active pour les deux camps, un obus tombé de la Lune toutes les ${POWERS.hammer.cooldown / 60} minutes. Chaque frappe affiche d'abord un cercle d'alerte : les rouges sont ennemis, alors dégage !</p>
  <h3>Objectifs</h3><p>Des 📡 <b>Relais TSF</b> occupent le centre disputé de chaque carte : gare des unités dans l'anneau pour remplir sa barre (les aéronefs comptent pour moitié, les Fardiers pas du tout ; avec les deux camps dedans, elle se fige). En tenir un rapporte ${OBJECTIVES.uplink.income} charbon/s, dévoile le brouillard autour et charge ta jauge ⚡. Les 📦 <b>Caisses de ravitaillement</b> tombent par deux dès 1:30, toutes les 75 s, annoncées 10 s à l'avance aux deux camps : la première unité à atteindre une caisse la prend (charbon, Vétérans, Réparation de terrain, charge ⚡, ou un rare Hydroglisseur gratuit). Les caisses non réclamées brûlent au bout de 45 s.</p>
  <h3>Archipel</h3><p>Chaque 📡 Relais se trouve sur une île que seule une <b>Montgolfière</b> peut atteindre, et seule l'infanterie y compte : aéronefs, Montgolfière et véhicules ne les prennent ni ne les contestent. Un Relais d'île ne rapporte que tant que tes troupes s'y tiennent (un point creux : tenu mais vide). Touche ta Montgolfière, puis une île pour y larguer les escouades à bord. Tu commences avec une Montgolfière et une escouade à bord ; perds ta dernière Montgolfière et une gratuite arrive ${LIFELINE.delay} s plus tard depuis le bord de carte près de ton GQG, ou de ton Gargantua si le GQG est tombé (avec une escouade gratuite si tu manques d'infanterie). La pleine mer arrête tout sauf les aéronefs — hydroglisseurs compris — donc les deux ponts sont les seuls passages terrestres.</p>
  <h3>Survie</h3><p>Pas de base ennemie : tiens face à des vagues sans fin. La barre du haut montre le thème de la prochaine vague (quatre parmi Raid aérien, Colonne blindée, Artillerie, Assaut mixte et Essaim d'automates, puis un Boss toutes les 5) et la flèche de la minicarte, son point d'entrée. Vaincre une vague rapporte du charbon ; terrain dégagé, <b>Appeler la vague</b> amène la suivante plus tôt contre un bonus.</p>
  <h3>Opérations</h3><p>Une courte campagne de missions faites main, chacune avec sa particularité — tenir un pont, livrer du charbon sous les raids aériens, décapiter une base avec un groupe d'assaut, combattre sans revenu. Chacune a un objectif sous l'horloge (touche-le pour les détails) et trois étoiles : la réussir, plus deux conditions plus dures. Les trois premières sont ouvertes ; chaque opération réussie ouvre la suivante.</p>
  <h3>Carrière, Op du jour et mutateurs</h3><p>Victoires, vagues de Survie et médailles rapportent de l'XP vers dix grades ; chaque carte et difficulté a trois étoiles (gagner, gagner en moins de 8:00 — 12:00 sur l'Archipel — et gagner sans perdre de bâtiment). L'<b>Op du jour</b> est une partie générée par jour, la même pour tous, avec une série de victoires. Les <b>mutateurs</b> modifient les règles d'une escarmouche pour les deux camps (sans étoiles). Touche ton grade au menu pour les médailles et records.</p>
  <h3>Économie</h3><p>Les Fardiers extraient le charbon et le radium luisant (plus rentable) et les ramènent au GQG, aux Halles ou à un Gargantua ancré. Plus de Fardiers, plus de charbon. Les unités détruites laissent des <b>épaves</b> scintillantes valant 30 % de leur coût (5 % seulement pour une vague de Survie) pendant une minute : passe dessus avec une unité au sol pour les récupérer.</p>
  <h3>Construction</h3><p>Ouvre <b>Base</b> et touche un bâtiment pour le construire. Une fois prêt, touche-le encore : un fantôme apparaît sur un emplacement libre près de ta base. Touche la carte (ou fais glisser le fantôme) pour le déplacer, puis touche le fantôme ou <b>✓ Placer</b> pour bâtir. À la souris, clique simplement l'emplacement. Les boutons marqués ⚔ contrent des ennemis repérés ; un onglet marqué <b>inactif</b> a un atelier qui ne fait rien.</p>
  <h3>Armée</h3><p>Touche une unité pour la sélectionner, touche ▢ Cadre puis glisse (ou, sans sélection, maintiens et glisse) pour une sélection en cadre, touche deux fois pour prendre toutes celles du même type à l'écran. <b>Infanterie</b>, <b>Blindés</b> et <b>Aviation</b>, à côté des escouades, prennent toute l'armée de ce type. <b>Route</b> : pose le doigt sur tes unités sélectionnées et trace leur chemin ; reviens à ton point de départ pour qu'elles patrouillent (elles combattent ce qu'elles croisent, puis reprennent leur ronde). <b>Marche en ordre</b> : appui long sur la destination, puis glisse pour tracer le front ; l'armée y va ensemble, au pas du plus lent, blindés et escouades devant, antiaérien au milieu, artillerie et tireurs derrière. Un trait court, ou tracé dans le sens de la marche, donne une colonne (pour un pont ou un col). À la souris, Maj+clic ajoute ou retire une unité de la sélection. Touche le sol pour un déplacement offensif, un ennemi pour l'attaquer. <b>⚑ Repli</b> : touche-le puis le sol, et les unités s'y rendent sans s'arrêter pour combattre (pour battre en retraite ou forcer un passage). <b>💤 Inactifs</b> prend les unités sans ordres.</p>
  <h3>Production en boucle</h3><p>Appui long sur une unité dans la barre de production, puis <b>↻ Produire en boucle</b> : chaque atelier libre qui la fabrique en relance une dès que le charbon le permet (deux unités en boucle dans le même atelier alternent). Ce que tu commandes à la main passe toujours avant. Le bouton porte un ↻ doré tant que la boucle tourne.</p>
  <h3>Groupes</h3><p>Maintiens un bouton de groupe (<b>1</b>, <b>2</b>, <b>3</b>) pour y enregistrer les unités sélectionnées. Touche-le pour les resélectionner, deux fois pour y envoyer la caméra. Il clignote en rouge quand un membre est touché. Touches : 1–3 sélectionne, Ctrl+1–3 (ou Maj+1–3) enregistre.</p>
  <h3>Infanterie</h3><p>Chaque bataille commence avec une <b>Escouade de pioupious</b> près de ton GQG. La <b>Manufacture</b> en forme d'autres : <b>Pioupious</b> (fusils bon marché qui touchent aussi l'air), <b>Artificiers</b> (tuent Creusot et Albatros) et, avec Polytechnique, <b>Chasseurs alpins</b> (éliminent l'infanterie, et restent cachées en forêt sauf si elles tirent ou si tu approches à ${INF.concealRadius} cases). Une escouade est une unité de plusieurs automates : ils tombent sous les dégâts, et elle tire moins fort à chaque perte. Les escouades traversent forêts et terrain accidenté à pleine vitesse, subissent moitié moins de dégâts en forêt et capturent les Relais deux fois plus vite, mais les Creusot les écrasent.</p>
  <h3>Montgolfière</h3><p>Le ballon de transport du Parc de Chalais-Meudon emporte deux escouades par-dessus l'eau, la roche et tout le reste. Sélectionne des escouades et touche la Montgolfière (ou sélectionne la Montgolfière et touche une escouade) pour les embarquer ; puis <b>appui long</b> sur la carte pour y voler et les larguer, ou touche <b>⇣ Larguer</b> (touche U) pour les déposer sur place. Abattue au-dessus de la terre, ses escouades s'éjectent blessées ; au-dessus de l'eau ou de la roche, elles sombrent avec elle.</p>
  <h3>Galerie des Machines et Gargantua</h3><p>Avec les Forges, un Parc de Chalais-Meudon, Polytechnique et une Manufacture debout, tu peux bâtir la <b>Galerie des Machines</b> (une par camp, et toujours visible par l'ennemi). Elle construit le <b>Gargantua</b> : une machine géante, une base sur pattes. Chacun coûte ${Math.round(GOLIATH.costStep * 100)} % de plus par Gargantua déjà possédé. Sélectionne-le et touche <b>⚓ Ancrer</b> (touche G) pour l'enterrer sur place (${GOLIATH.anchorTime} s) : ancré, les Fardiers y déchargent, il forme des escouades (onglet Infanterie, sans Manufacture ; touche la carte pour fixer leur point de ralliement) et tu peux construire à ${GOLIATH.buildRing} cases de lui, même loin de ta base. Ces <b>avant-postes</b> fonctionnent après son départ, mais n'étendent jamais ta zone de construction. <b>⇡ Lever l'ancre</b> (G encore, ${GOLIATH.packTime} s) avant de marcher. Il tire au mortier, à l'arc électrique oculaire, aux canons de bras et à la mitrailleuse, et les perd sous les dégâts : mortiers sous ${Math.round(GOLIATH.weapons.mortars.lostBelow * 100)} %, arc sous ${Math.round(GOLIATH.weapons.laser.lostBelow * 100)} %, canons sous ${Math.round(GOLIATH.weapons.cannons.lostBelow * 100)} % (les mitrailleuses jamais). Seuls les <b>Pasteur</b> le réparent, et ses armes redémarrent une fois remontées. L'ennemi le voit toujours.</p>
  <h3>Transport aérien</h3><p>Deux Montgolfières vides peuvent porter un Gargantua en marche : sélectionne-les et touche-le pour l'accrocher, puis <b>appui long</b> là où le déposer (un simple toucher l'y amène en vol stationnaire ; <b>⇣ Déposer</b> ou U le pose sur place). En vol, il ne tire qu'à la mitrailleuse, et si une Montgolfière est abattue il tombe : blessé sur terre, perdu sur l'eau, la mer, la lave ou la roche.</p>
  <h3>Contres</h3><p>Panhard battent Faucheux · Faucheux battent aéronefs · Éole battent chars · Blériot chassent les aéronefs · Creusot écrasent les armées au sol · Canons de 75 et Albatros rasent bases et escouades · Artificiers battent Creusot · Chasseurs alpins battent l'infanterie · Artificiers, Éole, Hydroglisseurs et Albatros abattent les Gargantuas. Appui long sur un bouton de production pour les détails.</p>
  <h3>Terrain</h3><p>Les routes sont rapides, boue et forêts lentes, les forêts offrent un couvert. L'eau bloque les chars — les Hydroglisseurs la survolent, les aéronefs passent partout ; la pleine mer autour des îles de l'Archipel arrête aussi les Hydroglisseurs. L'infanterie traverse forêts et boue à pleine vitesse mais ne franchit ni eau ni roche.</p>
  <h3>Caméra</h3><p>Glisse pour te déplacer, pince pour zoomer, touche la minicarte pour sauter. Des flèches pulsantes au bord de l'écran indiquent les combats hors champ (rouge : tu es attaqué) — touches-en une pour y voler, ou touche ⚡ pour les parcourir. En IA contre IA, la caméra cinéma 🎥 (touche C) suit l'action seule ; déplace ou zoome et elle te rend la main, puis la reprend quelques secondes plus tard.</p>
  <h3>Vitesse</h3><p>Touche le bouton <b>1×</b> près de l'horloge pour 1,5× ou 2× ; maintiens l'horloge pour accélérer à 3×.</p>`,
`
  <h3>Goal</h3><p>Destroy the enemy GHQ and all its Gargantuas. Protect yours: as long as a Gargantua stands, you are not beaten, even without a GHQ.</p>
  <h3>Openings</h3><p>Every skirmish begins with a choice: <b>Blitz</b> (Forges + 3 Panhards), <b>Industry</b> (Forges, a third Steam Wagon, +200 coal) or <b>Air Wing</b> (Chalais-Meudon + 3 Éoles). The enemy picks one too.</p>
  <h3>Commander powers</h3><p>The ⚡ gauge on the right fills slowly, and faster when you lose units. Spend it on a <b>Rolling Barrage</b> (3 salvoes), the <b>Electricity Fairy</b> (freezes enemies for 4 s) or a <b>Capsule Shell</b> (3 units land wherever you can see): tap the button, then the map. At 6:00 the <b>Méliès Shell</b> comes online for both sides, a shell fallen from the Moon every ${POWERS.hammer.cooldown / 60} minutes. Every strike shows a warning circle first: red ones are the enemy's, so get out!</p>
  <h3>Objectives</h3><p>📡 <b>Wireless Relays</b> sit in the contested centre of every map: park units in the ring to fill its bar (aircraft count for half, Steam Wagons not at all; with both sides inside, it freezes). Holding one earns ${OBJECTIVES.uplink.income} coal/s, lifts the fog around it and charges your ⚡ gauge. 📦 <b>Supply crates</b> drop in pairs from 1:30, every 75 s, announced 10 s ahead to both sides: the first unit to reach a crate takes it (coal, Veterans, Field repairs, ⚡ charge, or a rare free Hydroglider). Unclaimed crates burn after 45 s.</p>
  <h3>Archipelago</h3><p>Every 📡 Relay sits on an island only a <b>Montgolfier Balloon</b> can reach, and only infantry count there: aircraft, Montgolfier Balloons and vehicles neither take nor contest them. An island Relay only pays while your troops stand on it (a hollow dot: held but empty). Tap your Montgolfier Balloon, then an island, to drop the squads aboard. You start with a Montgolfier Balloon and a squad aboard; lose your last Montgolfier Balloon and a free one arrives ${LIFELINE.delay} s later from the map edge near your GHQ, or your Gargantua if the GHQ has fallen (with a free squad if you're short of infantry). Open sea stops everything except aircraft, Hydrogliders included, so the two bridges are the only ways across by land.</p>
  <h3>Last Stand</h3><p>No enemy base: hold out against endless waves. The bar at the top shows the next wave's theme (four from Air Raid, Armoured Column, Artillery, Combined Assault and Automaton Swarm, then a Boss every 5) and the minimap arrow, its entry point. Beating a wave earns coal; with the ground clear, <b>Call the wave</b> brings the next one early for a bonus.</p>
  <h3>Operations</h3><p>A short campaign of hand-made missions, each with its own twist: holding a bridge, delivering coal under air raids, decapitating a base with a strike group, fighting without income. Each has an objective under the clock (tap it for details) and three stars: completing it, plus two harder conditions. The first three are open; every operation completed opens the next.</p>
  <h3>Career, Daily Op and mutators</h3><p>Victories, Last Stand waves and medals earn XP towards ten ranks; every map and difficulty has three stars (win, win in under 8:00 — 12:00 on the Archipelago — and win without losing a building). The <b>Daily Op</b> is one generated match a day, the same for everyone, with a winning streak. <b>Mutators</b> change a skirmish's rules for both sides (no stars). Tap your rank in the menu for medals and records.</p>
  <h3>Economy</h3><p>Steam Wagons mine coal and glowing radium (more profitable) and bring them back to the GHQ, the Market Halls or an anchored Gargantua. No more Steam Wagons, no more coal. Destroyed units leave glittering <b>wrecks</b> worth 30% of their cost (just 5% for a Last Stand wave) for a minute: drive over them with a ground unit to salvage them.</p>
  <h3>Building</h3><p>Open <b>Base</b> and tap a building to build it. Once it's ready, tap it again: a ghost appears on a free spot near your base. Tap the map (or drag the ghost) to move it, then tap the ghost or <b>✓ Place</b> to build. With a mouse, just click the spot. Buttons marked ⚔ counter enemies you've spotted; a tab marked <b>idle</b> has a workshop doing nothing.</p>
  <h3>Army</h3><p>Tap a unit to select it, tap ▢ Frame then drag (or, with nothing selected, hold and drag) for a frame selection, tap twice to take every unit of the same type on screen. <b>Infantry</b>, <b>Armour</b> and <b>Air</b>, beside the squads, take the whole army of that type. <b>Route</b>: put your finger on your selected units and trace their path; return to your starting point to make them patrol (they fight whatever they meet, then resume their round). <b>March in order</b>: long-press the destination, then drag to draw the front; the army goes there together, at the pace of the slowest, armour and squads in front, anti-aircraft in the middle, artillery and marksmen behind. A short line, or one drawn along the way, makes a column (for a bridge or a pass). With a mouse, Shift+click adds or removes a unit from the selection. Tap the ground for an attack-move, an enemy to attack it. <b>⚑ Fall back</b>: tap it then the ground, and the units go there without stopping to fight (to retreat or force a passage). <b>💤 Idle</b> takes the units with no orders.</p>
  <h3>Looping production</h3><p>Long-press a unit in the production bar, then <b>↻ Produce in a loop</b>: each idle workshop that makes it starts another as soon as coal allows (two looped units at the same workshop alternate). What you order by hand always comes first. The button wears a gold ↻ while the loop runs.</p>
  <h3>Groups</h3><p>Hold a group button (<b>1</b>, <b>2</b>, <b>3</b>) to save the selected units to it. Tap it to reselect them, twice to send the camera there. It flashes red when a member is hit. Keys: 1–3 selects, Ctrl+1–3 (or Shift+1–3) saves.</p>
  <h3>Infantry</h3><p>Every battle begins with a <b>Poilu Squad</b> near your GHQ. The <b>Manufactory</b> trains more: <b>Poilus</b> (cheap rifles that also hit air), <b>Rocketeers</b> (kill Creusots and Albatros) and, with Polytechnique, <b>Alpine Chasseurs</b> (wipe out infantry, and stay hidden in woods unless they fire or you come within ${INF.concealRadius} tiles). A squad is one unit of several automata: they fall to damage, and it fires weaker with each loss. Squads cross woods and rough ground at full speed, take half damage in woods and capture Relays twice as fast, but Creusots crush them.</p>
  <h3>Montgolfier Balloon</h3><p>The transport balloon from the Chalais-Meudon Airpark carries two squads over water, rock and everything else. Select squads and tap the Montgolfier Balloon (or select the Montgolfier Balloon and tap a squad) to board them; then <b>long-press</b> the map to fly there and drop them, or tap <b>⇣ Drop</b> (U key) to set them down on the spot. Shot down over land, its squads bail out wounded; over water or rock, they go down with it.</p>
  <h3>Galerie des Machines and Gargantua</h3><p>With Forges, a Chalais-Meudon Airpark, Polytechnique and a Manufactory standing, you can build the <b>Galerie des Machines</b> (one per side, and always visible to the enemy). It builds the <b>Gargantua</b>: a giant machine, a base on legs. Each costs ${Math.round(GOLIATH.costStep * 100)}% more for every Gargantua you already own. Select it and tap <b>⚓ Anchor</b> (G key) to bury it on the spot (${GOLIATH.anchorTime} s): anchored, Steam Wagons unload at it, it trains squads (Infantry tab, no Manufactory needed; tap the map to set their rally point) and you can build within ${GOLIATH.buildRing} tiles of it, even far from your base. These <b>outposts</b> keep working after it leaves, but never extend your build area. <b>⇡ Weigh anchor</b> (G again, ${GOLIATH.packTime} s) before walking. It fires mortars, an electric eye arc, arm cannons and a machine gun, and loses them as it takes damage: mortars below ${Math.round(GOLIATH.weapons.mortars.lostBelow * 100)}%, arc below ${Math.round(GOLIATH.weapons.laser.lostBelow * 100)}%, cannons below ${Math.round(GOLIATH.weapons.cannons.lostBelow * 100)}% (the machine guns never). Only <b>Pasteurs</b> repair it, and its weapons restart once mended. The enemy always sees it.</p>
  <h3>Air transport</h3><p>Two empty Montgolfier Balloons can carry a walking Gargantua: select them and tap it to hook on, then <b>long-press</b> where to drop it (a simple tap brings it there hovering; <b>⇣ Set down</b> or U lands it on the spot). In flight it fires only its machine gun, and if a Montgolfier Balloon is shot down it falls: wounded on land, lost on water, sea, lava or rock.</p>
  <h3>Counters</h3><p>Panhards beat Daddy-Longlegs · Daddy-Longlegs beat aircraft · Éoles beat tanks · Blériots hunt aircraft · Creusots crush ground armies · French 75s and Albatros raze bases and squads · Rocketeers beat Creusots · Alpine Chasseurs beat infantry · Rocketeers, Éoles, Hydrogliders and Albatros bring down Gargantuas. Long-press a production button for details.</p>
  <h3>Terrain</h3><p>Roads are fast, mud and woods slow, and woods offer cover. Water blocks tanks — Hydrogliders skim over it, aircraft pass everywhere; the open sea around the Archipelago's islands stops Hydrogliders too. Infantry cross woods and mud at full speed but can't cross water or rock.</p>
  <h3>Camera</h3><p>Drag to move, pinch to zoom, tap the minimap to jump. Pulsing arrows at the screen edge point to fights off screen (red: you're under attack) — tap one to fly there, or tap ⚡ to cycle through them. In AI against AI, the cinema camera 🎥 (C key) follows the action on its own; move or zoom and it hands control back, then takes over again a few seconds later.</p>
  <h3>Speed</h3><p>Tap the <b>1×</b> button next to the clock for 1.5× or 2×; hold the clock to speed up to 3×.</p>`
);
